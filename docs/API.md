# REST API reference

Base URL: `http://127.0.0.1:4570/api` (override with `PORT`).

All responses are JSON unless noted. Errors look like `{ "error": "message" }` with a matching status code.
CORS is open (`*`) and responses are `cache-control: no-store` — this is a local POC.

## Concepts

| Term | Meaning |
| --- | --- |
| **base** | The root everything lives under (Drive folder, Gmail root label, memory). |
| **bucket** | A folder created inside the base. Names: `^[a-z0-9][a-z0-9._-]{0,62}$`. |
| **`_root`** | Reserved bucket id for the base itself. Never listed, cannot be created or deleted. |
| **key** | Object path inside a bucket. Any `/` becomes nested folders (Drive) or a prefix (Gmail/memory). 1–1024 chars, no control characters, must not end with `/`. |

---

## `GET /api/status`

Current backend and limits. Used by the UI header.

```json
{
  "mode": "drive",
  "reason": "Google Drive — buckets are folders inside \"bucket-base\"",
  "base": "Drive folder \"bucket-base\" (1AbCdEf...)",
  "baseUrl": "https://drive.google.com/drive/folders/1AbCdEf...",
  "baseBucket": "_root",
  "rootLabel": "gmail-bucket",
  "maxUploadBytes": 104857600,
  "chunkBytes": 12582912
}
```

`mode` is `drive`, `gmail` or `memory`. `baseUrl` is present only when the backend can link to the base
in its own UI (Drive today) — it is the folder the buckets live in.

---

## Buckets

### `GET /api/buckets`

```json
{ "buckets": ["docs", "photos"] }
```

Buckets only — the base never appears here. Sorted.

### `PUT /api/buckets/:bucket`

Creates a bucket (Drive folder / Gmail label / memory bucket).

```
200 { "ok": true, "bucket": "photos" }
409 BucketExists      already exists
400 bad name          "Bucket names: lowercase letters, numbers, dot, dash, underscore (max 63 chars)"
400 "_root"           "The base folder is not a bucket"
```

### `DELETE /api/buckets/:bucket[?force=1]`

Deletes a bucket. Without `force`, an empty bucket only.

```
200 { "ok": true, "bucket": "photos" }
404 NoSuchBucket
409 BucketNotEmpty (pass force: true to delete anyway)
400 "_root"       "The base folder is not a bucket"
```

With `force=1` every object (and, on Drive, nested folder) is trashed first.

### `GET /api/buckets/:bucket[?prefix=]`

Lists objects in a bucket. `prefix` filters by key prefix (a folder filter in the UI).

```json
{
  "bucket": "photos",
  "objects": [
    {
      "key": "2026/trips/cat.png",
      "size": 182734,
      "contentType": "image/png",
      "etag": "aa46a9fcb0c8e783ebbd6ac026b8fb9e",
      "lastModified": "2026-11-15T23:59:17.190Z",
      "metadata": { "owner": "poc" },
      "url": "https://drive.google.com/file/d/1XyZ.../view"
    }
  ]
}
```

`url` is the object's link in the provider's UI — the Drive backend returns the file's `webViewLink`;
Gmail and memory omit the field. It is also returned by `HEAD`/`GET` object metadata consumers via
`headObject`/`getObject` in the library API.

`GET /api/buckets/_root?...` lists objects stored directly in the base.

---

## Objects

### `PUT /api/buckets/:bucket/objects/:key`

Uploads (or overwrites) an object. The raw request body is the object content.

| Header | Effect |
| --- | --- |
| `Content-Type` | Stored as the object's content type (default `application/octet-stream`). |
| `x-meta-<name>: <value>` | Becomes `metadata.<name>`. |

```
200 { "etag": "aa46a9fcb0c8e783ebbd6ac026b8fb9e", "size": 182734 }
ETag: "aa46a9fcb0c8e783ebbd6ac026b8fb9e"
400 Invalid key
404 NoSuchBucket    (memory/Gmail require the bucket to exist)
413 / 400 Body too large (max 100MB)
```

Overwrites are atomic in effect: the new copy is written first, then older copies are removed
(Drive updates the file in place).

### `GET /api/buckets/:bucket/objects/:key[?download=1]`

Returns the raw bytes.

```
Content-Type: <stored content type>
Content-Length: <size>
ETag: "<md5>"
Last-Modified: <date>
Content-Disposition: attachment; filename="..."   (only with ?download=1)
```

```
404 NoSuchKey
500 Checksum mismatch, object is corrupt   (stored etag != md5 of the bytes)
```

### `HEAD /api/buckets/:bucket/objects/:key`

Same headers as `GET`, no body. Useful for cheap existence/size checks.

### `DELETE /api/buckets/:bucket/objects/:key`

Moves the object to Trash (Drive/Gmail) or removes it (memory). On Drive, folders left empty by the
delete are removed too.

```
200 { "ok": true }
404 NoSuchKey
```

---

## Non-API routes

| Route | Behaviour |
| --- | --- |
| `GET /` | Built React app (`web/dist/index.html`). |
| `GET /assets/*` | Hashed static assets, immutable cache. |
| `GET /<anything else>` | SPA fallback: returns `index.html` so client routing works. |
| `GET /favicon.ico` | Falls through to the SPA (no icon shipped). |

If `web/dist` is missing the server answers `503` with "Frontend not built. Run `npm run build`".

---

## Status code summary

| Code | When |
| --- | --- |
| `200` | Success (including idempotent creates and deletes). |
| `400` | Invalid bucket name, invalid key, base misused as a bucket, oversized body. |
| `404` | `NoSuchBucket`, `NoSuchKey`, unknown API route. |
| `409` | `BucketExists`, `BucketNotEmpty`. |
| `500` | Backend failure (Google API error, checksum mismatch). |
| `503` | Frontend not built. |

---

## SDK-style example

```ts
const API = 'http://127.0.0.1:4570/api';

export async function upload(bucket: string, key: string, body: Buffer, contentType: string) {
  const res = await fetch(`${API}/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json() as Promise<{ etag: string; size: number }>;
}

export async function download(bucket: string, key: string): Promise<Buffer> {
  const res = await fetch(`${API}/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return Buffer.from(await res.arrayBuffer());
}
```

Swap these two functions for an S3 client later: same signature, same semantics.
