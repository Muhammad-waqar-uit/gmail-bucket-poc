/**
 * Example App Router route — copy to app/api/files/[...key]/route.ts.
 *
 * Note what is *not* here: no provider SDK, no Gmail/Drive types, no bucket layout.
 * Everything goes through lib/object-store.ts, so switching backends never touches
 * this file or the components that call it.
 *
 *   PUT    /api/files/photos/2026/cat.png     body = raw file bytes
 *   GET    /api/files/photos/2026/cat.png     ?download=1 forces an attachment
 *   HEAD   /api/files/photos/2026/cat.png     metadata only
 *   DELETE /api/files/photos/2026/cat.png
 */
import { getObjectStore } from '../../../../lib/object-store';

// gmail-bucket uses Node APIs (googleapis, fs), so this route cannot run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = process.env.OBJECT_STORE_BUCKET ?? 'next-app';

// Next 15 passes params as a promise; on Next 14 it is a plain object — `await`
// handles both, so the same file works on either.
type RouteContext = { params: Promise<{ key: string[] }> };

/** Bucket keys are slash-separated; `_root` is reserved for the base folder. */
function keyOf(path: string[]): string {
  return path.join('/');
}

function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /NoSuchKey|NoSuchBucket/.test(message)
    ? 404
    : /Invalid key|Invalid move|Bucket names/.test(message)
      ? 400
      : 500;
  // In production, log `message` server-side and return a generic 500 body.
  return Response.json({ error: message }, { status });
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const key = keyOf((await context.params).key);
    const store = await getObjectStore();
    await store.ensureBucket(BUCKET);

    const object = await store.put(BUCKET, key, new Uint8Array(await request.arrayBuffer()), {
      contentType: request.headers.get('content-type') ?? 'application/octet-stream',
      metadata: { uploadedBy: 'next-app' },
    });
    return Response.json(object, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const key = keyOf((await context.params).key);
    const store = await getObjectStore();
    const { body, object } = await store.get(BUCKET, key);

    const headers: Record<string, string> = {
      'content-type': object.contentType || 'application/octet-stream',
      'content-length': String(object.size),
      etag: `"${object.etag}"`,
      'last-modified': object.lastModified.toUTCString(),
    };
    if (new URL(request.url).searchParams.has('download')) {
      headers['content-disposition'] = `attachment; filename="${object.key.split('/').pop()}"`;
    }

    // DOM's BodyInit wants a view over a plain ArrayBuffer; Buffer-backed views are
    // typed as ArrayBufferLike, so copy once into a fresh buffer.
    return new Response(new Uint8Array(body), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function HEAD(_request: Request, context: RouteContext) {
  try {
    const key = keyOf((await context.params).key);
    const object = await (await getObjectStore()).head(BUCKET, key);
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': object.contentType,
        'content-length': String(object.size),
        etag: `"${object.etag}"`,
        'last-modified': object.lastModified.toUTCString(),
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const key = keyOf((await context.params).key);
    await (await getObjectStore()).delete(BUCKET, key);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
