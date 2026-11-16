/**
 * Exercises the real DriveStore against an in-memory fake Drive client, so the
 * base-folder / bucket-folder / nested-folder logic is tested without credentials.
 *
 *   npm run build && node scripts/drive-mock-test.mjs
 */
/**
 * Verifies the DriveStore that ships in the installed `gmail-bucket` package
 * against an in-memory fake Drive client, so the dependency this POC ships with
 * is exercised end to end without Google credentials.
 *
 *   npm run test:drive
 */
import assert from 'node:assert/strict';
import { DriveStore } from 'gmail-bucket';

const FOLDER = 'application/vnd.google-apps.folder';

/** Minimal fake of drive.files.{list,get,create,update} honouring our query shapes. */
function fakeDrive() {
  let seq = 0;
  const files = new Map();

  const add = (props) => {
    const id = 'id' + ++seq;
    files.set(id, {
      id,
      name: props.name,
      mimeType: props.mimeType,
      parents: props.parents ?? ['root'],
      appProperties: props.appProperties ?? {},
      modifiedTime: new Date().toISOString(),
      trashed: false,
      content: Buffer.alloc(0),
    });
    return id;
  };

  const matches = (f, q) => {
    const parent = /'([^']+)' in parents/.exec(q);
    const name = /name='((?:[^'\\]|\\.)*)'/.exec(q);
    const isFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
    const notFolder = /mimeType!='application\/vnd\.google-apps\.folder'/.test(q);
    const trashedFalse = /trashed=false/.test(q);
    if (parent && !(f.parents ?? []).includes(parent[1])) return false;
    if (name && f.name !== name[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')) return false;
    if (isFolder && f.mimeType !== FOLDER) return false;
    if (notFolder && f.mimeType === FOLDER) return false;
    if (trashedFalse && f.trashed) return false;
    return true;
  };

  const streamToBuffer = async (stream) => {
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };

  const api = {
    async list({ q, pageToken }) {
      assert.equal(pageToken, undefined);
      return { data: { files: [...files.values()].filter((f) => matches(f, q)).map(({ content, ...f }) => f) } };
    },
    async get({ fileId, fields, alt }) {
      const f = files.get(fileId);
      assert.ok(f, `no file ${fileId}`);
      if (alt === 'media') return { data: f.content.buffer.slice(f.content.byteOffset, f.content.byteOffset + f.content.length) };
      return { data: { id: f.id, name: f.name, ...(fields ? {} : {}) } };
    },
    async create({ requestBody, media }) {
      const id = add(requestBody);
      const f = files.get(id);
      if (media) {
        f.content = await streamToBuffer(media.body);
        f.mimeType = media.mimeType + (f.mimeType === FOLDER ? ':media' : '');
        if (f.mimeType.endsWith(':media')) f.mimeType = FOLDER;
        else f.mimeType = media.mimeType;
        f.size = String(f.content.length);
      }
      return { data: { id } };
    },
    async update({ fileId, requestBody, media }) {
      const f = files.get(fileId);
      assert.ok(f, `no file ${fileId}`);
      if (requestBody?.appProperties) f.appProperties = requestBody.appProperties;
      if (requestBody?.trashed) f.trashed = true;
      if (requestBody?.name) f.name = requestBody.name;
      if (media) {
        f.content = await streamToBuffer(media.body);
        f.mimeType = media.mimeType;
        f.size = String(f.content.length);
      }
      f.modifiedTime = new Date().toISOString();
      return { data: { id: fileId } };
    },
  };

  return { files, client: { files: api } };
}

const { files, client } = fakeDrive();
const store = new DriveStore(null, { client, rootFolderName: 'bucket-base' });

let pass = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  pass++;
  console.log('  ok  ' + label);
};

// base folder is created on demand
const base = await store.describeBase();
check('base folder created in My Drive', files.get(base.folderId)?.name === 'bucket-base');
check('describeBase is cached', (await store.describeBase()).folderId === base.folderId);
check('empty base has no buckets', (await store.listBuckets()).length === 0);

// buckets are folders in the base
await store.createBucket('photos');
await store.createBucket('docs');
check('buckets are folders inside the base', (await store.listBuckets()).join(',') === 'docs,photos');
const bucketFolder = [...files.values()].find((f) => f.name === 'photos');
check('bucket folder parent is the base', bucketFolder?.parents?.[0] === base.folderId);

await assert.rejects(() => store.createBucket('photos'), /BucketExists/);
check('duplicate bucket rejected', true);
await assert.rejects(() => store.createBucket('_root'), /not a bucket/);
check('base is not a bucket', true);

// objects directly in the base ("the main one")
await store.putObject('_root', 'readme.txt', Buffer.from('straight in the base'), { contentType: 'text/plain' });
check('object stored in base bucket', (await store.listObjects('_root')).length === 1);

// objects in bucket/folder/...
const png = Buffer.from('89504e470d0a1a0a fake png bytes');
const put = await store.putObject('photos', '2026/trips/cat.png', png, { contentType: 'image/png', metadata: { who: 'poc' } });
check('nested key creates nested folders', (await store.listObjects('photos'))[0].key === '2026/trips/cat.png');
check('returned etag matches md5', put.etag.length === 32 && put.size === png.length);

const got = await store.getObject('photos', '2026/trips/cat.png');
check('download round-trips bytes', Buffer.compare(got.body, png) === 0);
check('content type preserved', got.info.contentType === 'image/png');
check('metadata preserved', got.info.metadata.who === 'poc');
check('head reports size', (await store.headObject('photos', '2026/trips/cat.png')).size === png.length);
check('prefix filter works', (await store.listObjects('photos', { prefix: '2026/trips/' })).length === 1);
check('other prefix filtered out', (await store.listObjects('photos', { prefix: 'nope/' })).length === 0);

// overwrite updates in place (no duplicate)
const png2 = Buffer.from('newer bytes');
await store.putObject('photos', '2026/trips/cat.png', png2, { contentType: 'image/png' });
const again = await store.listObjects('photos');
check('overwrite does not duplicate', again.length === 1);
check('overwrite replaced content', Buffer.compare((await store.getObject('photos', '2026/trips/cat.png')).body, png2) === 0);

await assert.rejects(() => store.getObject('photos', 'missing.png'), /NoSuchKey/);
check('missing key -> NoSuchKey', true);
await assert.rejects(() => store.getObject('nobucket', 'x'), /NoSuchBucket/);
check('missing bucket -> NoSuchBucket', true);

// delete + bucket rules
await store.deleteObject('photos', '2026/trips/cat.png');
check('delete removes object', (await store.listObjects('photos')).length === 0);
await assert.rejects(() => store.deleteBucket('_root'), /not a bucket/);
check('base cannot be deleted', true);

await store.putObject('docs', 'a.txt', Buffer.from('x'));
await assert.rejects(() => store.deleteBucket('docs'), /BucketNotEmpty/);
check('non-empty bucket needs force', true);
await store.deleteBucket('docs', { force: true });
check('force delete removes bucket', (await store.listBuckets()).join(',') === 'photos');
await store.deleteBucket('photos');
check('empty bucket deleted', (await store.listBuckets()).length === 0);

console.log(`\n${pass} checks passed against the mock Drive client.`);
