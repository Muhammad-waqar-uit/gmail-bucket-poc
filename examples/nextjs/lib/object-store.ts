/**
 * The one file in your Next.js app that knows where objects live.
 *
 * Route handlers, server actions and RSC code only ever import `getObjectStore()`
 * from here, so replacing memory/Gmail/Drive with real S3 later is an edit to this
 * file (plus one env var) — never a change to a call site.
 *
 * Copy to: lib/object-store.ts
 */
import { createStore } from 'gmail-bucket';
import type { ObjectInfo, ObjectStore, StoreInfo } from 'gmail-bucket';

/** What call sites see — deliberately close to S3's vocabulary. */
export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: Date;
  metadata: Record<string, string>;
  /** Provider link (Drive's webViewLink), when the backend has one. */
  url?: string;
}

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

/** The port every backend adapter implements. Nothing else is provider-specific. */
export interface ObjectStorePort {
  /** Idempotent: creates the bucket/container if it does not exist yet. */
  ensureBucket(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Uint8Array, opts?: PutOptions): Promise<StoredObject>;
  get(bucket: string, key: string): Promise<{ body: Uint8Array; object: StoredObject }>;
  head(bucket: string, key: string): Promise<StoredObject>;
  delete(bucket: string, key: string): Promise<void>;
  list(bucket: string, opts?: { prefix?: string; limit?: number }): Promise<StoredObject[]>;
  move(from: { bucket: string; key: string }, to: { bucket: string; key: string }): Promise<StoredObject>;
}

function toStored(info: ObjectInfo): StoredObject {
  return {
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    etag: info.etag,
    lastModified: info.lastModified,
    metadata: info.metadata ?? {},
    ...(info.url ? { url: info.url } : {}),
  };
}

/**
 * Adapter for the gmail-bucket library (Drive, Gmail or in-process memory — chosen
 * by the library's own `STORAGE=auto|drive|gmail|memory`).
 */
export function gmailBucketStore(info: Pick<StoreInfo, 'store'>): ObjectStorePort {
  const store: ObjectStore = info.store;

  return {
    async ensureBucket(bucket) {
      try {
        await store.createBucket(bucket);
      } catch (error) {
        // Already there is the success case for an idempotent ensure.
        if (!/BucketExists/.test(String((error as Error)?.message))) throw error;
      }
    },

    async put(bucket, key, body, opts) {
      await store.putObject(bucket, key, Buffer.from(body), opts);
      // Re-read so the caller gets the stored truth (size, etag, contentType, url).
      return toStored(await store.headObject(bucket, key));
    },

    async get(bucket, key) {
      const { body, info } = await store.getObject(bucket, key);
      return { body: new Uint8Array(body), object: toStored(info) };
    },

    head: async (bucket, key) => toStored(await store.headObject(bucket, key)),

    delete: (bucket, key) => store.deleteObject(bucket, key),

    list: async (bucket, opts) => (await store.listObjects(bucket, opts)).map(toStored),

    move: async (from, to) => toStored(await store.moveObject(from, to)),
  };
}

/**
 * Real S3 later. Implement the six methods with @aws-sdk/client-s3; the port above
 * is already shaped like the S3 API, so the route does not change:
 *
 *   ensureBucket -> HeadBucketCommand / CreateBucketCommand
 *   put          -> PutObjectCommand     { Body, ContentType, Metadata } -> ETag
 *   get          -> GetObjectCommand     Body stream -> Uint8Array, ContentType, ETag
 *   head         -> HeadObjectCommand    ContentLength, ContentType, ETag, LastModified, Metadata
 *   delete       -> DeleteObjectCommand
 *   list         -> ListObjectsV2Command { Prefix, MaxKeys }
 *   move         -> CopyObjectCommand + DeleteObjectCommand
 */
function s3Store(): ObjectStorePort {
  throw new Error(
    'STORAGE_DRIVER=s3: implement s3Store() in lib/object-store.ts — see the command mapping above ' +
      'and examples/nextjs/README.md. Route handlers need no changes.'
  );
}

/**
 * One adapter per process (and per dev-server module instance — the globalThis cache
 * keeps hot reload from creating a new store on every edit).
 */
export function getObjectStore(): Promise<ObjectStorePort> {
  const cache = globalThis as typeof globalThis & { __objectStore?: Promise<ObjectStorePort> };
  cache.__objectStore ??= createAdapter();
  return cache.__objectStore;
}

async function createAdapter(): Promise<ObjectStorePort> {
  if ((process.env.STORAGE_DRIVER ?? 'gmail-bucket') === 's3') return s3Store();

  // Missing credentials fall back to memory, which is fine for local development.
  const info = await createStore();
  console.log(`[object-store] ${info.mode} — ${info.base}`);
  return gmailBucketStore(info);
}
