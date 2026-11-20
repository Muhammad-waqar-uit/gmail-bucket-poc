/**
 * Dump every bucket to a directory: one file per object, plus manifest.json.
 *
 *   npm run export                 # writes ./export
 *   npm run export -- ./backup     # or an explicit directory
 *   EXPORT_ALLOW_MEMORY=1 npm run export   # memory backend: tests the walk, saves nothing durable
 *
 * This is the backup path for the Gmail backend, where objects are messages that a filter or a
 * cleanup can delete silently. The manifest records key -> file, size, etag and content type, so a
 * restore (or a migration off Gmail) has something authoritative to check against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../dist/env.js';

loadEnv();

const { createStore } = await import('gmail-bucket');

/**
 * Walk every bucket and write it under `dir`. Exported so a test can drive it against a seeded
 * MemoryStore without a Google account.
 */
export async function exportStore(info, dir) {
  const root = path.resolve(dir);
  const manifest = {
    exportedAt: new Date().toISOString(),
    mode: info.mode,
    base: info.base,
    buckets: [],
  };

  let files = 0;
  let bytes = 0;

  for (const bucket of await info.store.listBuckets()) {
    const objects = await info.store.listObjects(bucket);
    const entry = { bucket, objects: [] };

    // Create even an empty bucket, so a restore knows it existed.
    fs.mkdirSync(path.join(root, ...segments(bucket)), { recursive: true });

    for (const listed of objects) {
      const { body, info: meta } = await info.store.getObject(bucket, listed.key);
      const file = path.join(root, ...segments(bucket), ...segments(listed.key));
      if (file !== root && !file.startsWith(root + path.sep)) {
        throw new Error(`refusing to write outside ${root}: ${listed.key}`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      files += 1;
      bytes += body.length;
      entry.objects.push({
        key: listed.key,
        size: body.length,
        etag: meta.etag,
        contentType: meta.contentType,
        lastModified: meta.lastModified.toISOString(),
        file: path.relative(root, file).split(path.sep).join('/'),
      });
    }

    manifest.buckets.push(entry);
    console.log(`  ${bucket}: ${entry.objects.length} object(s)`);
  }

  fs.mkdirSync(root, { recursive: true });
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  manifest: ${manifestPath}`);

  return { files, bytes, buckets: manifest.buckets.length, manifest };
}

/** Path segments of a bucket or key, with `.`/`..` dropped so a key cannot escape `dir`. */
// Control characters are stripped by code point, so no regex escape can be mangled in transit.
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g');

function segments(value) {
  return value
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(CONTROL, '_'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dir = process.argv[2] ?? process.env.EXPORT_DIR ?? 'export';

  try {
    const info = await createStore();
    if (info.mode === 'memory' && process.env.EXPORT_ALLOW_MEMORY !== '1') {
      console.error(
        '\nThe active backend is memory, so there is nothing durable to export.\n' +
          'Set EXPORT_ALLOW_MEMORY=1 if you only want to exercise the export walk.\n'
      );
      process.exit(1);
    }

    console.log(`\ngmail-bucket export\n  backend  ${info.mode} (${info.base})\n  target   ${path.resolve(dir)}\n`);
    const result = await exportStore(info, dir);
    console.log(
      `\nPASS — ${result.files} object(s), ${result.bytes} bytes, ${result.buckets} bucket(s)\n`
    );
  } catch (error) {
    console.error(`\nFAIL — ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
