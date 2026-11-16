import { google, gmail_v1 } from 'googleapis';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { BASE_BUCKET, assertBucketName } from './layout.js';

type Auth = InstanceType<typeof google.auth.OAuth2>;

// Gmail caps attachments at 25 MB. Base64 adds ~33%, so keep raw chunks well under that.
const CHUNK_BYTES = 12 * 1024 * 1024;

const H = {
  key: 'X-GB-Key',
  part: 'X-GB-Part',
  total: 'X-GB-Total',
  upload: 'X-GB-Upload',
  size: 'X-GB-Size',
  etag: 'X-GB-Etag',
  type: 'X-GB-Content-Type',
  meta: 'X-GB-Meta',
} as const;

export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: Date;
  metadata: Record<string, string>;
}

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GmailBucketOptions {
  /** Parent label that holds all buckets. Default "gmail-bucket". */
  rootLabel?: string;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const objId = (key: string) => 'gb' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);

async function retry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const code = e?.code ?? e?.response?.status;
      const retriable =
        code === 429 ||
        (code === 403 && /rate|quota/i.test(String(e?.message))) ||
        (typeof code === 'number' && code >= 500);
      if (i >= tries - 1 || !retriable) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function pmap<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

interface PartMeta {
  id: string;
  headers: Record<string, string>;
  internalDate: number;
}

function buildMime(headers: Record<string, string>, data: Buffer): string {
  const boundary = 'gb_' + crypto.randomBytes(12).toString('hex');
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const body = data.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    ...head,
    'From: gmail-bucket <gmail-bucket@localhost>',
    'To: gmail-bucket <gmail-bucket@localhost>',
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Object stored by gmail-bucket. Do not edit or delete manually.',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="data.bin"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="data.bin"',
    '',
    body,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function findAttachment(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePartBody | undefined {
  if (!part) return undefined;
  if (part.filename && part.body && (part.body.attachmentId || part.body.data)) return part.body;
  for (const p of part.parts ?? []) {
    const f = findAttachment(p);
    if (f) return f;
  }
  return undefined;
}

export class GmailBucket {
  private gmail: gmail_v1.Gmail;
  private root: string;
  private labels?: Map<string, string>;

  constructor(auth: Auth, opts: GmailBucketOptions = {}) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.root = opts.rootLabel ?? 'gmail-bucket';
  }

  // ---------- buckets ----------

  private labelName(bucket: string) {
    // The base "folder" is the root label itself; everything else is a child label.
    if (bucket === BASE_BUCKET) return this.root;
    assertBucketName(bucket);
    return `${this.root}/${bucket}`;
  }

  private async loadLabels(force = false) {
    if (!this.labels || force) {
      const r = await retry(() => this.gmail.users.labels.list({ userId: 'me' }));
      this.labels = new Map((r.data.labels ?? []).map((l) => [l.name!, l.id!]));
    }
    return this.labels;
  }

  private async labelId(bucket: string, create: boolean): Promise<string | undefined> {
    const name = this.labelName(bucket);
    const map = await this.loadLabels();
    let id = map.get(name);
    if (!id && create) {
      const r = await retry(() =>
        this.gmail.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        })
      );
      id = r.data.id!;
      map.set(name, id);
    }
    return id;
  }

  private async requireLabel(bucket: string): Promise<string> {
    const id = await this.labelId(bucket, false);
    if (!id) throw new Error(`NoSuchBucket: ${bucket}`);
    return id;
  }

  async createBucket(bucket: string): Promise<void> {
    await this.labelId(bucket, true);
  }

  async listBuckets(): Promise<string[]> {
    const map = await this.loadLabels(true);
    const prefix = this.root + '/';
    return [...map.keys()].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)).sort();
  }

  async deleteBucket(bucket: string, opts: { force?: boolean } = {}): Promise<void> {
    assertBucketName(bucket);
    const id = await this.requireLabel(bucket);
    const ids = await this.listIds(id);
    if (ids.length && !opts.force) throw new Error('BucketNotEmpty (pass force: true to delete anyway)');
    await this.trash(ids);
    await retry(() => this.gmail.users.labels.delete({ userId: 'me', id }));
    this.labels?.delete(this.labelName(bucket));
  }

  // ---------- objects ----------

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array | string,
    opts: PutOptions = {}
  ): Promise<{ etag: string; size: number }> {
    const labelId = (await this.labelId(bucket, true))!;
    const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    const etag = crypto.createHash('md5').update(data).digest('hex');
    const id = objId(key);
    const upload = crypto.randomBytes(8).toString('hex');
    const total = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));

    // remember older copies so we can drop them only after the new one is fully written
    const old = (await this.findAll(labelId, key)).map((m) => m.id);

    const inserted: string[] = [];
    try {
      for (let i = 0; i < total; i++) {
        const chunk = data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        const raw = buildMime(
          {
            Subject: `${id} p${i}`,
            [H.key]: b64(key),
            [H.part]: String(i),
            [H.total]: String(total),
            [H.upload]: upload,
            [H.size]: String(data.length),
            [H.etag]: etag,
            [H.type]: opts.contentType ?? 'application/octet-stream',
            [H.meta]: b64(JSON.stringify(opts.metadata ?? {})),
          },
          chunk
        );
        const r = await retry(() =>
          this.gmail.users.messages.insert({
            userId: 'me',
            requestBody: { labelIds: [labelId] },
            media: { mimeType: 'message/rfc822', body: Readable.from([Buffer.from(raw, 'utf8')]) },
          })
        );
        inserted.push(r.data.id!);
      }
    } catch (e) {
      await this.trash(inserted).catch(() => {});
      throw e;
    }
    await this.trash(old);
    return { etag, size: data.length };
  }

  async getObject(bucket: string, key: string): Promise<{ body: Buffer; info: ObjectInfo }> {
    const labelId = await this.requireLabel(bucket);
    const parts = await this.findLatestUpload(labelId, key);
    const chunks = await pmap(parts, 4, async (p) => {
      const msg = await retry(() => this.gmail.users.messages.get({ userId: 'me', id: p.id, format: 'full' }));
      const att = findAttachment(msg.data.payload ?? undefined);
      if (!att) throw new Error(`Corrupt object part ${p.id}: no attachment`);
      if (att.data) return Buffer.from(att.data, 'base64url');
      const a = await retry(() =>
        this.gmail.users.messages.attachments.get({ userId: 'me', messageId: p.id, id: att.attachmentId! })
      );
      return Buffer.from(a.data.data!, 'base64url');
    });
    const body = Buffer.concat(chunks);
    const info = this.toInfo(parts[0]);
    const etag = crypto.createHash('md5').update(body).digest('hex');
    if (etag !== info.etag) throw new Error('Checksum mismatch, object is corrupt');
    return { body, info };
  }

  async headObject(bucket: string, key: string): Promise<ObjectInfo> {
    const labelId = await this.requireLabel(bucket);
    const parts = await this.findLatestUpload(labelId, key);
    return this.toInfo(parts[0]);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const labelId = await this.requireLabel(bucket);
    const all = await this.findAll(labelId, key);
    await this.trash(all.map((m) => m.id));
  }

  async listObjects(bucket: string, opts: { prefix?: string; limit?: number } = {}): Promise<ObjectInfo[]> {
    const labelId = await this.requireLabel(bucket);
    const ids = await this.listIds(labelId);
    const metas = await pmap(ids, 8, (id) => this.meta(id));
    const seen = new Map<string, ObjectInfo>();
    for (const m of metas) {
      if (m.headers[H.part.toLowerCase()] !== '0') continue;
      const info = this.toInfo(m);
      if (opts.prefix && !info.key.startsWith(opts.prefix)) continue;
      const prev = seen.get(info.key);
      if (!prev || prev.lastModified < info.lastModified) seen.set(info.key, info);
    }
    const out = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  // ---------- internals ----------

  private toInfo(m: PartMeta): ObjectInfo {
    const h = m.headers;
    return {
      key: unb64(h[H.key.toLowerCase()]),
      size: Number(h[H.size.toLowerCase()]),
      contentType: h[H.type.toLowerCase()] ?? 'application/octet-stream',
      etag: h[H.etag.toLowerCase()],
      lastModified: new Date(m.internalDate),
      metadata: JSON.parse(unb64(h[H.meta.toLowerCase()] ?? b64('{}'))),
    };
  }

  private async listIds(labelId: string, q?: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const res: { data: gmail_v1.Schema$ListMessagesResponse } = await retry(() =>
        this.gmail.users.messages.list({ userId: 'me', labelIds: [labelId], q, maxResults: 500, pageToken })
      );
      ids.push(...(res.data.messages ?? []).map((m) => m.id!));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  private async meta(id: string): Promise<PartMeta> {
    const r = await retry(() =>
      this.gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: Object.values(H),
      })
    );
    const headers: Record<string, string> = {};
    for (const h of r.data.payload?.headers ?? []) headers[h.name!.toLowerCase()] = h.value ?? '';
    return { id, headers, internalDate: Number(r.data.internalDate ?? 0) };
  }

  private async findAll(labelId: string, key: string): Promise<PartMeta[]> {
    const ids = await this.listIds(labelId, `subject:${objId(key)}`);
    const metas = await pmap(ids, 8, (i) => this.meta(i));
    return metas.filter((m) => {
      const k = m.headers[H.key.toLowerCase()];
      return k && unb64(k) === key;
    });
  }

  private async findLatestUpload(labelId: string, key: string): Promise<PartMeta[]> {
    const all = await this.findAll(labelId, key);
    if (!all.length) throw new Error(`NoSuchKey: ${key}`);
    const latest = [...all].sort((a, b) => b.internalDate - a.internalDate)[0].headers[H.upload.toLowerCase()];
    const parts = all
      .filter((m) => m.headers[H.upload.toLowerCase()] === latest)
      .sort((a, b) => Number(a.headers[H.part.toLowerCase()]) - Number(b.headers[H.part.toLowerCase()]));
    const total = Number(parts[0].headers[H.total.toLowerCase()]);
    if (parts.length !== total) throw new Error(`Incomplete object: found ${parts.length} of ${total} parts`);
    return parts;
  }

  private async trash(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      await retry(() =>
        this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: { ids: batch, addLabelIds: ['TRASH'] },
        })
      );
    }
  }
}
