# Using gmail-bucket from a Next.js app

Three files, one seam. Your routes, server actions and components only see a small
`ObjectStorePort` interface, so the storage backend is swappable without touching call sites.

```
lib/object-store.ts                     ← the only file that knows about gmail-bucket
app/api/files/[...key]/route.ts         ← PUT / GET / HEAD / DELETE, provider-agnostic
README.md                               ← this file
```

## 1. Install the library

```bash
npm install gmail-bucket
# while the library is unpublished, either:
#   npm install github:Muhammad-waqar-uit/gmail-bucket#v2.2.0
#   npm install ../../gmail-bucket-poc/node_modules/gmail-bucket   (already built)
```

## 2. Copy the two files

```
lib/object-store.ts                ← from this folder
app/api/files/[...key]/route.ts    ← from this folder
```

## 3. Authorise once

The Google token lives in `~/.gmail-bucket/`, not in your app, so the Next.js process picks it up
automatically. Run this in the POC repo:

```bash
npm run auth          # drive + gmail.modify in one token
npm run smoke         # optional: proves the real backend works before you touch Next
```

## 4. Configure

```bash
# .env.local
STORAGE=memory            # dev with no Google account (everything lives in process memory)
# STORAGE=gmail           # or: auto | drive | gmail | memory
OBJECT_STORE_BUCKET=next-app
# STORAGE_DRIVER=gmail-bucket   # default; 's3' switches to the S3 adapter
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE` | `auto` | Library backend: `auto` (Drive → Gmail → memory), `drive`, `gmail`, `memory` |
| `STORAGE_DRIVER` | `gmail-bucket` | Which adapter `getObjectStore()` builds: `gmail-bucket` or `s3` |
| `OBJECT_STORE_BUCKET` | `next-app` | Bucket (folder / Gmail label) the example route writes to |
| `GMAIL_BUCKET_ROOT_LABEL` | `gmail-bucket` | Root label for the Gmail backend |
| `GMAIL_BUCKET_DIR` | `~/.gmail-bucket` | Where `credentials.json` / `token.json` live |

## 5. Use it

```bash
# upload
curl -X PUT localhost:3000/api/files/photos/2026/cat.png \
     -H "Content-Type: image/png" --data-binary @cat.png

# download (headers: content-type, content-length, etag, last-modified)
curl -OJ localhost:3000/api/files/photos/2026/cat.png

# metadata, then delete
curl -I localhost:3000/api/files/photos/2026/cat.png
curl -X DELETE localhost:3000/api/files/photos/2026/cat.png
```

From a server action or RSC, the call site is the same interface:

```ts
import { getObjectStore } from '@/lib/object-store';

const store = await getObjectStore();
const { body, object } = await store.get('next-app', 'reports/q4.pdf');

const objects = await store.list('next-app', { prefix: 'reports/' });
await store.move(
  { bucket: 'next-app', key: 'inbox/q4.pdf' },
  { bucket: 'next-app', key: 'reports/q4.pdf' }
);
```

## Swapping to real S3

Change **one file** and **one env var** — the route and every call site stay as they are:

1. `npm install @aws-sdk/client-s3`
2. Implement `s3Store()` in `lib/object-store.ts` (the port's methods map 1:1 to S3 commands; the
   mapping is written out in the function's comment and in the table below).
3. `STORAGE_DRIVER=s3` plus your `AWS_REGION` / credentials.

| Port method | S3 command |
| --- | --- |
| `ensureBucket` | `HeadBucketCommand`, then `CreateBucketCommand` |
| `put` | `PutObjectCommand` (`Body`, `ContentType`, `Metadata`) |
| `get` | `GetObjectCommand` (stream → `Uint8Array`) |
| `head` | `HeadObjectCommand` |
| `delete` | `DeleteObjectCommand` |
| `list` | `ListObjectsV2Command` (`Prefix`, `MaxKeys`) |
| `move` | `CopyObjectCommand` + `DeleteObjectCommand` |

The same seam works the other way: keep the Gmail backend in dev (`STORAGE=memory` even) and point
production at S3, without branching inside your features.

## Notes and limits

- **Node runtime only.** `googleapis` and `fs` mean `runtime = 'nodejs'`; do not move these routes to
  `edge`, and do not import `lib/object-store.ts` from client components — it is server-only.
  If you want a hard guarantee, add `import 'server-only';` at the top of it.
- **Objects are buffered in memory** on both sides (`arrayBuffer()` in, `Uint8Array` out); the library
  caps uploads at 100 MB and splits Gmail payloads into 12 MB chunks. Stream large media through S3
  presigned URLs instead of through a route handler.
- **Size limits:** route handlers have no 4 MB body cap (unlike server actions, which default to 1 MB) —
  but check your proxy/hosting limit anyway.
- **No auth in the example.** Add your own session check before `getObjectStore()` and derive the bucket
  or key prefix from the user; never let the client choose arbitrary buckets.
- **One store per process.** `getObjectStore()` caches a promise on `globalThis`, so hot reload does not
  re-authenticate; the cache also means a failed init stays failed until the process restarts.
