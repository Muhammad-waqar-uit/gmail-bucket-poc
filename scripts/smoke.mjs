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

/**
 * One numbered check. `fn` does the work and throws on failure; `describe` turns
 * its result into the detail printed after "ok". Both assertions and provider
 * calls live in the same step, so the log reads like the checklist it is.
 */
async function run(name, fn, describe) {
  const n = ++step;
  try {
    const value = await fn();
    const detail = describe?.(value);
    console.log(`  ${GREEN}ok${RESET}   ${n}. ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
    return value;
  } catch (error) {
    console.log(`  ${RED}fail${RESET} ${n}. ${name}`);
    throw error;
  }
}

async function main() {
  const info = await run('active backend answers', () => createStore());

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
    await run(
      'create bucket',
      async () => {
        await info.store.createBucket(bucket);
        created = true;
        const buckets = await info.store.listBuckets();
        if (!buckets.includes(bucket)) throw new Error(`missing from ${JSON.stringify(buckets)}`);
      },
      () => '(visible in listBuckets)'
    );

    const put = await run(
      'upload object',
      async () => {
        const result = await info.store.putObject(bucket, key, payload, {
          contentType: 'application/octet-stream',
          metadata: { source: 'smoke' },
        });
        if (result.size !== payload.length) throw new Error(`size ${result.size} != ${payload.length}`);
        return result;
      },
      (result) => `(${result.size} bytes, etag ${result.etag.slice(0, 12)}…)`
    );

    await run(
      'list the object',
      async () => {
        const listed = await info.store.listObjects(bucket);
        if (!listed.some((o) => o.key === key)) throw new Error(`keys: ${listed.map((o) => o.key)}`);
        return listed;
      },
      (listed) => `(${listed.length} object(s))`
    );

    await run(
      'metadata matches the upload',
      async () => {
        const head = await info.store.headObject(bucket, key);
        if (head.size !== payload.length) throw new Error(`size ${head.size} != ${payload.length}`);
        if (head.etag && put.etag && head.etag !== put.etag) throw new Error(`etag ${head.etag} != ${put.etag}`);
        return head;
      },
      (head) => `(etag + size + ${head.contentType})`
    );

    await run(
      'downloaded checksum matches',
      async () => {
        const got = await info.store.getObject(bucket, key);
        if (got.body.length !== payload.length) throw new Error(`${got.body.length} != ${payload.length}`);
        if (sha256(got.body) !== payloadHash) throw new Error('sha256 differs');
        if (got.info.contentType !== 'application/octet-stream') {
          throw new Error(`content type ${got.info.contentType}`);
        }
        return got;
      },
      () => `(sha256 ${payloadHash.slice(0, 12)}…, content type kept)`
    );

    await run('deleted object is gone', async () => {
      await info.store.deleteObject(bucket, key);
      let missing = false;
      try {
        await info.store.getObject(bucket, key);
      } catch (error) {
        missing = /NoSuchKey/.test(String(error?.message ?? error));
      }
      if (!missing) throw new Error('the object was still readable after delete');
      if ((await info.store.listObjects(bucket)).length) throw new Error('bucket is not empty after delete');
      return '(404 on read, empty listing)';
    });
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
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${GREEN}${BOLD}PASS${RESET} — ${bucket} round-tripped and cleaned up in ${elapsed}s\n`);
} catch (error) {
  console.log(`\n${RED}${BOLD}FAIL${RESET} — ${String(error?.message ?? error)}\n`);
  process.exit(1);
}
