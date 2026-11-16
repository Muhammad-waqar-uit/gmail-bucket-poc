import crypto from 'node:crypto';
import { GmailBucket } from './bucket.js';
import type { ObjectInfo, PutOptions } from './bucket.js';
import { DriveStore } from './drive.js';
import { BASE_BUCKET, assertBucketName } from './layout.js';
import { getAuthedClient, hasCredentials, hasToken, credFile, tokenFile } from './auth.js';

export type { ObjectInfo, PutOptions };
export { BASE_BUCKET };

export interface ObjectStore {
  createBucket(bucket: string): Promise<void>;
  listBuckets(): Promise<string[]>;
  deleteBucket(bucket: string, opts?: { force?: boolean }): Promise<void>;
  putObject(
    bucket: string,
    key: string,
    body: Buffer,
    opts?: PutOptions
  ): Promise<{ etag: string; size: number }>;
  getObject(bucket: string, key: string): Promise<{ body: Buffer; info: ObjectInfo }>;
  headObject(bucket: string, key: string): Promise<ObjectInfo>;
  deleteObject(bucket: string, key: string): Promise<void>;
  listObjects(bucket: string, opts?: { prefix?: string; limit?: number }): Promise<ObjectInfo[]>;
}

interface MemObject {
  body: Buffer;
  info: ObjectInfo;
}

/**
 * Drop-in replacement for the cloud backends that keeps everything in process
 * memory. Used so the POC runs (and can be tested) without a Google account.
 */
export class MemoryStore implements ObjectStore {
  private data = new Map<string, Map<string, MemObject>>();

  constructor() {
    this.data.set(BASE_BUCKET, new Map());
  }

  private require(bucket: string): Map<string, MemObject> {
    const b = this.data.get(bucket);
    if (!b) throw new Error(`NoSuchBucket: ${bucket}`);
    return b;
  }

  async createBucket(bucket: string): Promise<void> {
    assertBucketName(bucket);
    if (this.data.has(bucket)) throw new Error(`BucketExists: ${bucket}`);
    this.data.set(bucket, new Map());
  }

  async listBuckets(): Promise<string[]> {
    return [...this.data.keys()].filter((b) => b !== BASE_BUCKET).sort();
  }

  async deleteBucket(bucket: string, opts: { force?: boolean } = {}): Promise<void> {
    assertBucketName(bucket);
    const b = this.require(bucket);
    if (b.size && !opts.force) throw new Error('BucketNotEmpty (pass force: true to delete anyway)');
    this.data.delete(bucket);
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    opts: PutOptions = {}
  ): Promise<{ etag: string; size: number }> {
    const b = this.require(bucket);
    const etag = crypto.createHash('md5').update(body).digest('hex');
    b.set(key, {
      body,
      info: {
        key,
        size: body.length,
        contentType: opts.contentType ?? 'application/octet-stream',
        etag,
        lastModified: new Date(),
        metadata: opts.metadata ?? {},
      },
    });
    return { etag, size: body.length };
  }

  async getObject(bucket: string, key: string): Promise<{ body: Buffer; info: ObjectInfo }> {
    const o = this.require(bucket).get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return { body: o.body, info: o.info };
  }

  async headObject(bucket: string, key: string): Promise<ObjectInfo> {
    const o = this.require(bucket).get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return o.info;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const b = this.require(bucket);
    if (!b.delete(key)) throw new Error(`NoSuchKey: ${key}`);
  }

  async listObjects(bucket: string, opts: { prefix?: string; limit?: number } = {}): Promise<ObjectInfo[]> {
    const out = [...this.require(bucket).values()]
      .map((o) => o.info)
      .filter((o) => !opts.prefix || o.key.startsWith(opts.prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }
}

export type StoreMode = 'drive' | 'gmail' | 'memory';

export interface StoreInfo {
  store: ObjectStore;
  mode: StoreMode;
  /** Human readable description of where the base lives. */
  base: string;
  reason: string;
  rootLabel: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

function memoryInfo(reason: string): StoreInfo {
  return {
    store: new MemoryStore(),
    mode: 'memory',
    base: 'in-process memory',
    reason,
    rootLabel: env('GMAIL_BUCKET_ROOT_LABEL') ?? 'gmail-bucket',
  };
}

async function openDrive(): Promise<StoreInfo> {
  const store = new DriveStore(getAuthedClient(), {
    rootFolderId: env('DRIVE_ROOT_FOLDER_ID'),
    rootFolderName: env('DRIVE_ROOT_FOLDER_NAME'),
    createRoot: env('DRIVE_CREATE_ROOT') !== '0',
  });
  // Round trip once so scope/permission problems surface at startup.
  await store.listBuckets();
  const base = await store.describeBase();
  return {
    store,
    mode: 'drive',
    base: `Drive folder "${base.name}" (${base.folderId})`,
    reason: `Google Drive — buckets are folders inside "${base.name}"`,
    rootLabel: env('GMAIL_BUCKET_ROOT_LABEL') ?? 'gmail-bucket',
  };
}

async function openGmail(): Promise<StoreInfo> {
  const rootLabel = env('GMAIL_BUCKET_ROOT_LABEL') ?? 'gmail-bucket';
  const store = new GmailBucket(getAuthedClient(), { rootLabel });
  await store.listBuckets();
  return {
    store,
    mode: 'gmail',
    base: `Gmail label "${rootLabel}"`,
    reason: `Gmail — buckets are labels "${rootLabel}/<bucket>"`,
    rootLabel,
  };
}

/**
 * STORAGE=auto (default) | drive | gmail | memory
 *
 * auto tries Drive, then Gmail, then memory, using the first one that answers.
 */
export async function createStore(): Promise<StoreInfo> {
  const want = (env('STORAGE') ?? 'auto').toLowerCase();
  const hints: string[] = [];

  if (want === 'memory') return memoryInfo('In-memory store (STORAGE=memory)');

  if (!hasCredentials()) {
    if (want !== 'auto') {
      throw new Error(
        `STORAGE=${want} but no Google credentials. Save an OAuth Desktop-app JSON to ${credFile()} ` +
          `or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.`
      );
    }
    return memoryInfo(`In-memory store: no Google credentials at ${credFile()}`);
  }

  if (!hasToken()) {
    if (want !== 'auto') {
      throw new Error(`STORAGE=${want} but not logged in. Run "npm run auth" (token: ${tokenFile()}).`);
    }
    return memoryInfo(`In-memory store: no token yet at ${tokenFile()} (run "npm run auth")`);
  }

  const order: StoreMode[] = want === 'auto' ? ['drive', 'gmail'] : [want as StoreMode];
  for (const mode of order) {
    try {
      if (mode === 'drive') return await openDrive();
      if (mode === 'gmail') return await openGmail();
      throw new Error(`STORAGE=${want} is not a known backend (use drive, gmail or memory)`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/insufficient|scope|permission/i.test(msg)) {
        hints.push(`${mode}: ${msg} — re-run "npm run auth" to grant both Gmail and Drive scopes`);
      } else {
        hints.push(`${mode}: ${msg}`);
      }
      if (want !== 'auto') throw new Error(`${mode} backend failed: ${msg}`);
    }
  }

  return memoryInfo(`In-memory store: no cloud backend available (${hints.join(' | ')})`);
}
