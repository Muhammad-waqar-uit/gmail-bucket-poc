import { google, drive_v3 } from 'googleapis';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { BASE_BUCKET, assertBucketName } from './layout.js';
import type { ObjectInfo, ObjectStore, PutOptions } from './store.js';

type Auth = InstanceType<typeof google.auth.OAuth2>;

const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,parents,appProperties,trashed';
const MAX_DEPTH = 12;

/** Drive appProperties values are capped at ~124 bytes, so keep metadata compact. */
const META_MAX_BYTES = 120;

const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export interface DriveStoreOptions {
  /** Use this folder as the base instead of looking one up by name. */
  rootFolderId?: string;
  /** Base folder name under "My Drive" (default "bucket-base"). */
  rootFolderName?: string;
  /** Create the base folder when it does not exist (default true). */
  createRoot?: boolean;
  /** Test seam: inject a Drive client instead of building one from auth. */
  client?: drive_v3.Drive;
}

export interface BaseFolder {
  folderId: string;
  name: string;
}

/**
 * Google Drive object store.
 *
 *   base folder ("bucket-base" in My Drive)
 *     <bucket>/            every bucket is a folder inside the base
 *       a/b/file.bin       keys with slashes become nested folders
 *
 * The base folder itself is bucket `_root`, so objects can be stored directly in
 * the "main" folder. Overwrites update the existing file in place; deletes go to
 * Drive Trash. Reads verify the MD5 checksum.
 */
export class DriveStore implements ObjectStore {
  private drive: drive_v3.Drive;
  private opts: DriveStoreOptions;
  private rootId?: string;
  private rootName?: string;
  private folderCache = new Map<string, string>();

  constructor(auth: Auth, opts: DriveStoreOptions = {}) {
    this.opts = opts;
    this.drive = opts.client ?? google.drive({ version: 'v3', auth });
  }

  // ---------- base ----------

  /** Resolve (and on first use, create) the base folder. */
  async describeBase(): Promise<BaseFolder> {
    if (this.rootId && this.rootName) return { folderId: this.rootId, name: this.rootName };

    if (this.opts.rootFolderId) {
      const r = await this.drive.files.get({ fileId: this.opts.rootFolderId, fields: 'id,name', supportsAllDrives: true });
      if (!r.data.id) throw new Error(`DRIVE_ROOT_FOLDER_ID ${this.opts.rootFolderId} not found`);
      this.rootId = r.data.id;
      this.rootName = r.data.name ?? this.opts.rootFolderId;
      return { folderId: this.rootId, name: this.rootName };
    }

    const name = this.opts.rootFolderName || 'bucket-base';
    const found = await this.list(
      `mimeType='${FOLDER}' and name='${esc(name)}' and 'root' in parents and trashed=false`
    );
    if (found.length) {
      this.rootId = found[0].id!;
      this.rootName = found[0].name ?? name;
      return { folderId: this.rootId, name: this.rootName };
    }
    if (this.opts.createRoot === false) {
      throw new Error(`Base folder "${name}" not found in My Drive (set DRIVE_ROOT_FOLDER_ID, or allow creation).`);
    }
    const created = await this.drive.files.create({
      requestBody: { name, mimeType: FOLDER, parents: ['root'] },
      fields: 'id,name',
    });
    this.rootId = created.data.id!;
    this.rootName = created.data.name ?? name;
    return { folderId: this.rootId, name: this.rootName };
  }

  // ---------- buckets ----------

  async createBucket(bucket: string): Promise<void> {
    assertBucketName(bucket);
    const { folderId: root } = await this.describeBase();
    if (await this.findFolder(root, bucket)) throw new Error(`BucketExists: ${bucket}`);
    await this.createFolder(root, bucket);
  }

  async listBuckets(): Promise<string[]> {
    const { folderId: root } = await this.describeBase();
    const files = await this.list(`'${root}' in parents and mimeType='${FOLDER}' and trashed=false`);
    return files
      .map((f) => f.name ?? '')
      .filter((n) => n && n !== BASE_BUCKET)
      .sort();
  }

  async deleteBucket(bucket: string, opts: { force?: boolean } = {}): Promise<void> {
    assertBucketName(bucket);
    const id = await this.bucketFolder(bucket, false);
    const children = await this.list(`'${id}' in parents and trashed=false`);
    if (children.length && !opts.force) {
      throw new Error('BucketNotEmpty (pass force: true to delete anyway)');
    }
    for (const f of children) await this.trashTree(f);
    await this.drive.files.update({ fileId: id, requestBody: { trashed: true } });
    this.folderCache.clear();
  }

  // ---------- objects ----------

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    opts: PutOptions = {}
  ): Promise<{ etag: string; size: number }> {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const folder = await this.bucketFolder(bucket, true);
    const segs = key.split('/');
    const name = segs.pop() ?? '';
    if (!name) throw new Error('Invalid key');
    const parent = await this.ensureFolders(folder, segs);

    const etag = md5(data);
    const metaJson = JSON.stringify(opts.metadata ?? {});
    const appProperties: Record<string, string> = {
      gbEtag: etag,
      gbMeta: Buffer.byteLength(metaJson) <= META_MAX_BYTES ? metaJson : JSON.stringify({ truncated: true }),
    };
    const media = { mimeType: opts.contentType ?? 'application/octet-stream', body: Readable.from([data]) };

    const existing = await this.findFile(parent, name);
    if (existing) {
      await this.drive.files.update({
        fileId: existing.id!,
        requestBody: { appProperties },
        media,
        fields: FILE_FIELDS,
      });
    } else {
      await this.drive.files.create({
        requestBody: { name, parents: [parent], appProperties },
        media,
        fields: FILE_FIELDS,
      });
    }
    return { etag, size: data.length };
  }

  async getObject(bucket: string, key: string): Promise<{ body: Buffer; info: ObjectInfo }> {
    const { file, key: k } = await this.findObject(bucket, key);
    const res = await this.drive.files.get({ fileId: file.id!, alt: 'media' }, { responseType: 'arraybuffer' });
    const body = Buffer.from(res.data as ArrayBuffer);
    const info = this.toInfo(file, k);
    if (info.etag && md5(body) !== info.etag) throw new Error('Checksum mismatch, object is corrupt');
    return { body, info };
  }

  async headObject(bucket: string, key: string): Promise<ObjectInfo> {
    const { file, key: k } = await this.findObject(bucket, key);
    return this.toInfo(file, k);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const folder = await this.bucketFolder(bucket, false);
    const segs = key.split('/');
    const name = segs.pop() ?? '';
    if (!name) throw new Error('Invalid key');

    // Remember the folder chain so empty folders can be pruned afterwards.
    const chain: { parentId: string; id: string }[] = [];
    let parent = folder;
    for (const seg of segs) {
      const id = await this.findFolder(parent, seg);
      if (!id) throw new Error(`NoSuchKey: ${key}`);
      chain.push({ parentId: parent, id });
      parent = id;
    }
    const file = await this.findFile(parent, name);
    if (!file) throw new Error(`NoSuchKey: ${key}`);
    await this.drive.files.update({ fileId: file.id!, requestBody: { trashed: true } });

    // Drive keeps folders, so drop any that are now empty (never the bucket itself).
    for (const entry of chain.reverse()) {
      const children = await this.list(`'${entry.id}' in parents and trashed=false`);
      if (children.length) break;
      await this.drive.files.update({ fileId: entry.id, requestBody: { trashed: true } });
      this.folderCache.clear();
    }
  }

  async listObjects(bucket: string, opts: { prefix?: string; limit?: number } = {}): Promise<ObjectInfo[]> {
    const folder = await this.bucketFolder(bucket, false);
    const out: ObjectInfo[] = [];
    await this.walk(folder, '', out, 0);
    const filtered = out
      .filter((o) => !opts.prefix || o.key.startsWith(opts.prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    return opts.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  /** Folder id for a bucket; `_root` is the base folder itself. */
  private async bucketFolder(bucket: string, create: boolean): Promise<string> {
    const { folderId: root } = await this.describeBase();
    if (bucket === BASE_BUCKET) return root;
    assertBucketName(bucket);
    const found = await this.findFolder(root, bucket);
    if (found) return found;
    if (!create) throw new Error(`NoSuchBucket: ${bucket}`);
    return this.createFolder(root, bucket);
  }

  private async findObject(bucket: string, key: string): Promise<{ file: drive_v3.Schema$File; key: string }> {
    const folder = await this.bucketFolder(bucket, false);
    const segs = key.split('/');
    const name = segs.pop() ?? '';
    if (!name) throw new Error('Invalid key');

    let parent = folder;
    for (const seg of segs) {
      const next = await this.findFolder(parent, seg);
      if (!next) throw new Error(`NoSuchKey: ${key}`);
      parent = next;
    }
    const file = await this.findFile(parent, name);
    if (!file) throw new Error(`NoSuchKey: ${key}`);
    return { file, key };
  }

  private toInfo(file: drive_v3.Schema$File, key: string): ObjectInfo {
    let metadata: Record<string, string> = {};
    const raw = file.appProperties?.gbMeta;
    if (raw) {
      try {
        metadata = JSON.parse(raw);
      } catch {
        metadata = {};
      }
    }
    return {
      key,
      size: Number(file.size ?? 0),
      contentType: file.mimeType ?? 'application/octet-stream',
      etag: file.md5Checksum ?? file.appProperties?.gbEtag ?? '',
      lastModified: new Date(file.modifiedTime ?? Date.now()),
      metadata,
    };
  }

  // ---------- Drive helpers ----------

  private async list(q: string): Promise<drive_v3.Schema$File[]> {
    const out: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 1000,
        pageToken,
      });
      out.push(...(res.data.files ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  private async findFolder(parentId: string, name: string): Promise<string | undefined> {
    const cacheKey = `${parentId}/${name}`;
    const hit = this.folderCache.get(cacheKey);
    if (hit) return hit;
    const found = await this.list(
      `'${parentId}' in parents and name='${esc(name)}' and mimeType='${FOLDER}' and trashed=false`
    );
    if (!found.length) return undefined;
    this.folderCache.set(cacheKey, found[0].id!);
    return found[0].id!;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const r = await this.drive.files.create({
      requestBody: { name, mimeType: FOLDER, parents: [parentId] },
      fields: 'id',
    });
    const id = r.data.id!;
    this.folderCache.set(`${parentId}/${name}`, id);
    return id;
  }

  /** Create every missing folder in `segs` under `parentId`. */
  private async ensureFolders(parentId: string, segs: string[]): Promise<string> {
    let parent = parentId;
    for (const seg of segs) {
      if (!seg) continue;
      parent = (await this.findFolder(parent, seg)) ?? (await this.createFolder(parent, seg));
    }
    return parent;
  }

  private async findFile(parentId: string, name: string): Promise<drive_v3.Schema$File | undefined> {
    const found = await this.list(
      `'${parentId}' in parents and name='${esc(name)}' and trashed=false and mimeType!='${FOLDER}'`
    );
    return found[0];
  }

  private async walk(folderId: string, base: string, out: ObjectInfo[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Folder nesting too deep (max ${MAX_DEPTH})`);
    const children = await this.list(`'${folderId}' in parents and trashed=false`);
    for (const c of children) {
      if (!c.name) continue;
      if (c.mimeType === FOLDER) {
        await this.walk(c.id!, `${base}${c.name}/`, out, depth + 1);
      } else {
        out.push(this.toInfo(c, `${base}${c.name}`));
      }
    }
  }

  private async trashTree(file: drive_v3.Schema$File): Promise<void> {
    if (file.mimeType === FOLDER) {
      const children = await this.list(`'${file.id}' in parents and trashed=false`);
      for (const c of children) await this.trashTree(c);
    }
    await this.drive.files.update({ fileId: file.id!, requestBody: { trashed: true } });
  }
}
