/**
 * End-to-end smoke test for the active backend — run it right after `npm run auth`.
 *
 *   npm run smoke
 *
 * It creates a real bucket, uploads a file, downloads it back, compares SHA-256
 * checksums and sizes, then deletes the object and the bucket. It talks to the
 * store directly (no HTTP server, no UI), so it proves the provider path itself.
 *
 * Environment:
 *   STORAGE=gmail|drive|memory   which backend to use (default: auto)
 *   SMOKE_BYTES=262144           payload size in bytes
 *   SMOKE_ALLOW_MEMORY=1         don't fail when the backend fell back to memory
 */
import crypto from 'node:crypto';
import { loadEnv } from '../dist/env.js';

loadEnv();

const { createStore } = await import('gmail-bucket');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const bytes = Number(process.env.SMOKE_BYTES) || 256 * 1024;
const bucket = `smoke-${Date.now().toString(36)}`;
const key = 'probe/payload.bin';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let step = 0;
function pass(name, detail = '') {
  step += 1;
  console.log(`  ${GREEN}ok${RESET}   ${step}. ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(name, error) {
  step += 1;
  console.log(`  ${RED}fail${RESET} ${step}. ${name}`);
  throw error;
}

async function withStep(name, fn) {
  try {
    return await fn();
  } catch (error) {
    fail(name, error);
  }
}

async function main() {
  const info = await withStep('active backend answers', () => createStore());

  console.log(`\n${BOLD}gmail-bucket smoke test${RESET}`);
  console.log(`  backend  ${info.mode} ${DIM}(${info.reason})${RESET}`);
  console.log(`  base     ${info.base}`);
  console.log(`  bucket   ${bucket}`);
  console.log(`  key      ${key}`);
  console.log(`  payload  ${bytes.toLocaleString()} bytes\n`);

  if (info.mode === 'memory' && process.env.SMOKE_ALLOW_MEMORY !== '1') {
    console.log(
      `${RED}The active backend is memory, so nothing real was tested.${RESET}\n` +
        `Run ${BOLD}npm run auth${RESET} first (or set ${BOLD}STORAGE=gmail${RESET}), then run this again.\n` +
        `Set ${BOLD}SMOKE_ALLOW_MEMORY=1${RESET} if you only want to exercise the store API.\n`
    );
    process.exit(1);
  }

  const payload = crypto.randomBytes(bytes);
  const payloadHash = sha256(payload);

  let created = false;
  try {
    await withStep('create bucket', () => info.store.createBucket(bucket));
    created = true;
    const buckets = await withStep('list buckets', () => info.store.listBuckets());
    if (!buckets.includes(bucket)) fail('bucket appears in the bucket list', new Error(`got ${JSON.stringify(buckets)}`));
    pass('bucket appears in the bucket list');

    const put = await withStep('upload object', () =>
      info.store.putObject(bucket, key, payload, {
        contentType: 'application/octet-stream',
        metadata: { source: 'smoke' },
      })
    );
    if (put.size !== payload.length) fail('upload reports the right size', new Error(`size ${put.size} != ${payload.length}`));
    pass('upload reports the right size', `(${put.size} bytes, etag ${put.etag.slice(0, 12)}…)`);

    const listed = await withStep('list the object', () => info.store.listObjects(bucket));
    if (!listed.some((o) => o.key === key)) fail('object is listed under the bucket', new Error(`keys: ${listed.map((o) => o.key)}`));
    pass('object is listed under the bucket', `(${listed.length} object(s))`);

    const head = await withStep('read object metadata', () => info.store.headObject(bucket, key));
    if (head.size !== payload.length) fail('metadata size matches', new Error(`size ${head.size}`));
    if (head.etag && put.etag && head.etag !== put.etag) {
      fail('metadata etag matches the upload', new Error(`etag ${head.etag} != ${put.etag}`));
    }
    pass('metadata matches the upload', `(etag + size + ${head.contentType})`);

    const got = await withStep('download object', () => info.store.getObject(bucket, key));
    const gotHash = sha256(got.body);
    if (got.body.length !== payload.length) fail('downloaded size matches', new Error(`${got.body.length} != ${payload.length}`));
    if (gotHash !== payloadHash) fail('downloaded checksum matches', new Error(`${gotHash} != ${payloadHash}`));
    pass('downloaded checksum matches', `(sha256 ${gotHash.slice(0, 12)}…)`);
    if (got.info.contentType !== 'application/octet-stream') {
      fail('content type survives the round trip', new Error(`got ${got.info.contentType}`));
    }
    pass('content type survives the round trip');

    await withStep('delete object', () => info.store.deleteObject(bucket, key));
    let missing = false;
    try {
      await info.store.getObject(bucket, key);
    } catch (error) {
      missing = /NoSuchKey/.test(String(error?.message ?? error));
    }
    if (!missing) fail('deleted object is gone', new Error('the object was still readable after delete'));
    const afterDelete = await info.store.listObjects(bucket);
    if (afterDelete.length) fail('bucket is empty after delete', new Error(`still ${afterDelete.length} object(s)`));
    pass('deleted object is gone', '(404 on read, empty listing)');
  } finally {
    if (created) {
      try {
        await info.store.deleteBucket(bucket, { force: true });
        console.log(`  ${GREEN}ok${RESET}   ${++step}. bucket removed ${DIM}(cleanup)${RESET}`);
      } catch (error) {
        console.log(`  ${RED}fail${RESET} ${++step}. bucket cleanup: ${error?.message ?? error}`);
        process.exitCode = 1;
      }
    }
  }
}

const started = Date.now();
try {
  await main();
  if (process.exitCode) throw new Error('see the failed steps above');
  console.log(
    `\n${GREEN}${BOLD}PASS${RESET} — ${bucket} round-tripped and cleaned up in ${((Date.now() - started) / 1000).toFixed(1)}s\n`
  );
} catch (error) {
  console.log(`\n${RED}${BOLD}FAIL${RESET} — ${String(error?.message ?? error)}\n`);
  process.exit(1);
}
