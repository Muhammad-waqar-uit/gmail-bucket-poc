import { test, expect } from '@playwright/test';

/**
 * REST contract tests. They hit the same HTTP API the React app uses, so a
 * regression in routing, status codes or the storage backends fails here first.
 */

const bucketName = (label: string) =>
  `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test.describe('REST API', () => {
  test('reports the active backend, base and limits', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.status()).toBe(200);

    const status = await res.json();
    expect(status.mode).toBe('memory');
    expect(status.baseBucket).toBe('_root');
    expect(status.base).toContain('memory');
    expect(status.maxUploadBytes).toBe(100 * 1024 * 1024);
  });

  test('runs a full object lifecycle inside a bucket', async ({ request }) => {
    const bucket = bucketName('lifecycle');

    expect((await request.put(`/api/buckets/${bucket}`)).status()).toBe(200);
    expect(await (await request.get('/api/buckets')).json()).toMatchObject({
      buckets: expect.arrayContaining([bucket]),
    });

    // nested key => nested folders
    const key = '2026/trips/notes.txt';
    const put = await request.put(`/api/buckets/${bucket}/objects/${key}`, {
      headers: { 'content-type': 'text/plain', 'x-meta-owner': 'e2e' },
      data: 'hello from playwright',
    });
    expect(put.status()).toBe(200);
    const putBody = await put.json();
    expect(putBody.size).toBe(Buffer.byteLength('hello from playwright'));
    expect(putBody.etag).toHaveLength(32);

    const list = await (await request.get(`/api/buckets/${bucket}`)).json();
    expect(list.objects).toHaveLength(1);
    expect(list.objects[0]).toMatchObject({
      key,
      contentType: 'text/plain',
      metadata: { owner: 'e2e' },
    });

    const filtered = await (await request.get(`/api/buckets/${bucket}?prefix=2026/trips/`)).json();
    expect(filtered.objects.map((o: { key: string }) => o.key)).toEqual([key]);
    const empty = await (await request.get(`/api/buckets/${bucket}?prefix=nope/`)).json();
    expect(empty.objects).toEqual([]);

    const head = await request.head(`/api/buckets/${bucket}/objects/${key}`);
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toBe('text/plain');
    expect(head.headers().etag).toBe(`"${putBody.etag}"`);

    const download = await request.get(`/api/buckets/${bucket}/objects/${key}`);
    expect(download.status()).toBe(200);
    expect((await download.body()).toString()).toBe('hello from playwright');

    const attachment = await request.get(`/api/buckets/${bucket}/objects/${key}?download=1`);
    expect(attachment.headers()['content-disposition']).toContain('attachment');

    // overwrite replaces in place
    await request.put(`/api/buckets/${bucket}/objects/${key}`, {
      headers: { 'content-type': 'text/plain' },
      data: 'v2',
    });
    const after = await (await request.get(`/api/buckets/${bucket}`)).json();
    expect(after.objects).toHaveLength(1);
    expect(await (await request.get(`/api/buckets/${bucket}/objects/${key}`)).text()).toBe('v2');

    expect((await request.delete(`/api/buckets/${bucket}/objects/${key}`)).status()).toBe(200);
    expect((await (await request.get(`/api/buckets/${bucket}`)).json()).objects).toEqual([]);
    expect((await request.delete(`/api/buckets/${bucket}`)).status()).toBe(200);
    expect((await (await request.get('/api/buckets')).json()).buckets).not.toContain(bucket);
  });

  test('stores objects directly in the base folder', async ({ request }) => {
    const key = `base-${Date.now()}.txt`;

    const put = await request.put(`/api/buckets/_root/objects/${key}`, {
      headers: { 'content-type': 'text/plain' },
      data: 'in the base',
    });
    expect(put.status()).toBe(200);

    const list = await (await request.get('/api/buckets/_root')).json();
    expect(list.bucket).toBe('_root');
    expect(list.objects.map((o: { key: string }) => o.key)).toContain(key);

    // the base is never listed as a bucket
    expect((await (await request.get('/api/buckets')).json()).buckets).not.toContain('_root');

    expect((await request.delete(`/api/buckets/_root/objects/${key}`)).status()).toBe(200);
  });

  test('maps failures to useful status codes', async ({ request }) => {
    const bucket = bucketName('errors');
    await request.put(`/api/buckets/${bucket}`);

    expect((await request.get(`/api/buckets/${bucket}/objects/missing.txt`)).status()).toBe(404);
    expect((await request.get('/api/buckets/does-not-exist')).status()).toBe(404);
    expect((await request.put(`/api/buckets/${bucket}`)).status()).toBe(409);
    expect((await request.put('/api/buckets/_root')).status()).toBe(400);
    expect((await request.delete('/api/buckets/_root')).status()).toBe(400);
    expect((await request.put('/api/buckets/Bad%20Name')).status()).toBe(400);
    expect((await request.put(`/api/buckets/${bucket}/objects/oops/`)).status()).toBe(400);

    await request.put(`/api/buckets/${bucket}/objects/keep.txt`, { data: 'x' });
    expect((await request.delete(`/api/buckets/${bucket}`)).status()).toBe(409);
    expect((await request.delete(`/api/buckets/${bucket}?force=1`)).status()).toBe(200);

    expect((await request.get('/api/unknown-route')).status()).toBe(404);
  });

  test('serves the built React app with an SPA fallback', async ({ request }) => {
    const html = await request.get('/');
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    expect(await html.text()).toContain('<div id="root">');

    const deep = await request.get('/some/client/route');
    expect(deep.status()).toBe(200);
    expect(await deep.text()).toContain('<div id="root">');
  });
});
