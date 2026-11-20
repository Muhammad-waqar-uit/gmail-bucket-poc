/**
 * Contract test for `npm run export`: what lands on disk and what the manifest says.
 *
 *   npm run test:export
 *
 * Seeds a MemoryStore with a nested key, a traversal-style key and an empty bucket,
 * runs the real export walk into a temp directory, then checks the file layout and
 * every manifest field. No Google account and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MemoryStore } from 'gmail-bucket';
import { exportStore } from './export.mjs';

const md5 = (body) => crypto.createHash('md5').update(body).digest('hex');

let cases = 0;
let failures = 0;

function ok(name, detail) {
  cases += 1;
  console.log(`  ok    ${cases}. ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, error) {
  cases += 1;
  failures += 1;
  console.log(`  FAIL  ${cases}. ${name} — ${error?.message ?? error}`);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function check(name, fn) {
  try {
    const detail = fn();
    ok(name, detail);
  } catch (error) {
    fail(name, error);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-export-'));
const outDir = path.join(workDir, 'backup');

const nested = Buffer.from('nested object body');
const escapes = Buffer.from('inside the root, please');

const store = new MemoryStore();
await store.createBucket('photos');
await store.createBucket('empty');
await store.putObject('photos', '2026/cat.png', nested, { contentType: 'image/png' });
// A key the Drive/Gmail backends would never produce, but that a corrupted or hostile
// index could hold; the walk must keep it inside the target directory.
await store.putObject('photos', '../../escape.txt', escapes, { contentType: 'text/plain' });

const info = { mode: 'memory', base: 'in-process memory', reason: 'test', store, rootLabel: 'test' };

const result = await exportStore(info, outDir);
const manifestPath = path.join(outDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const photos = manifest.buckets.find((b) => b.bucket === 'photos');
const empty = manifest.buckets.find((b) => b.bucket === 'empty');
const cat = photos?.objects.find((o) => o.key === '2026/cat.png');
const escape = photos?.objects.find((o) => o.key === '../../escape.txt');

check('writes one file per object and reports totals', () => {
  expectEqual(result.files, 2, 'files');
  expectEqual(result.bytes, nested.length + escapes.length, 'bytes');
  expectEqual(result.buckets, 2, 'buckets');
  return '2 objects, 2 buckets';
});

check('nested keys keep their folder layout', () => {
  const file = path.join(outDir, 'photos', '2026', 'cat.png');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  expectEqual(fs.readFileSync(file).toString(), nested.toString(), 'bytes on disk');
  expectEqual(cat?.file, 'photos/2026/cat.png', 'manifest file');
  expectEqual(cat?.contentType, 'image/png', 'manifest contentType');
  expectEqual(cat?.etag, md5(nested), 'manifest etag');
  expectEqual(cat?.size, nested.length, 'manifest size');
  if (!cat?.lastModified || Number.isNaN(Date.parse(cat.lastModified))) {
    throw new Error(`manifest lastModified is not an ISO date: ${cat?.lastModified}`);
  }
  return 'photos/2026/cat.png';
});

check('a traversal-style key cannot leave the target directory', () => {
  const contained = path.join(outDir, 'photos', 'escape.txt');
  if (!fs.existsSync(contained)) throw new Error(`expected ${contained}`);
  expectEqual(fs.readFileSync(contained).toString(), escapes.toString(), 'bytes on disk');
  expectEqual(escape?.file, 'photos/escape.txt', 'manifest file');

  // Nothing may appear next to or above the export root.
  const strays = [
    path.join(outDir, 'escape.txt'),
    path.join(workDir, 'escape.txt'),
    path.join(outDir, '..', 'escape.txt'),
  ].filter((p) => fs.existsSync(p));
  if (strays.length) throw new Error(`wrote outside the root: ${strays.join(', ')}`);

  const walked = fs.readdirSync(outDir);
  expectEqual(walked.sort().join(','), 'empty,manifest.json,photos', 'entries at the root');
  return 'contained under photos/';
});

check('empty buckets are created and recorded', () => {
  const dir = path.join(outDir, 'empty');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`missing ${dir}`);
  expectEqual(empty?.objects.length, 0, 'empty bucket objects');
  return 'empty/ exists with 0 objects';
});

check('the manifest describes the export and does not list itself', () => {
  expectEqual(manifest.mode, 'memory', 'mode');
  expectEqual(manifest.base, 'in-process memory', 'base');
  if (Number.isNaN(Date.parse(manifest.exportedAt))) throw new Error(`exportedAt: ${manifest.exportedAt}`);
  expectEqual(manifest.buckets.map((b) => b.bucket).join(','), 'empty,photos', 'bucket order');
  const keys = manifest.buckets.flatMap((b) => b.objects.map((o) => `${b.bucket}/${o.key}`)).sort();
  expectEqual(keys.join(','), 'photos/../../escape.txt,photos/2026/cat.png', 'keys');
  if (keys.some((k) => k.includes('manifest.json'))) throw new Error('manifest lists itself');
  return `${manifest.buckets.length} buckets`;
});

fs.rmSync(workDir, { recursive: true, force: true });

if (failures) {
  console.log(`\nFAIL — ${failures} of ${cases} export cases failed\n`);
  process.exit(1);
}
console.log(`\nPASS — ${cases} export cases (layout + manifest)\n`);
