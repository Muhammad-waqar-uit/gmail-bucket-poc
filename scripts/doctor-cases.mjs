/**
 * Contract test for `npm run doctor`: exit codes and the next-step list.
 *
 *   npm run test:doctor
 *
 * Every case runs the built CLI in a throwaway directory with GMAIL_BUCKET_DIR
 * pointing at a temp folder, so it never reads or writes real auth files. It
 * asserts the exit code, how many next steps are printed (one root cause -> one
 * command) and that the run left the auth directory untouched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const doctorPath = path.join(root, 'dist', 'doctor.js');
if (!fs.existsSync(doctorPath)) {
  console.error(`${doctorPath} is missing — run npm run build:api first`);
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-doctor-work-'));
const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-doctor-auth-'));

/** Doctor must decide from an empty environment, not whatever this shell has. */
const baseEnv = { ...process.env };
for (const key of [
  'STORAGE',
  'GMAIL_BUCKET_DIR',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GMAIL_BUCKET_TOKEN',
]) {
  delete baseEnv[key];
}

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function runDoctor(storage) {
  const res = spawnSync(process.execPath, [doctorPath], {
    cwd: workDir,
    env: { ...baseEnv, STORAGE: storage, GMAIL_BUCKET_DIR: authDir },
    encoding: 'utf8',
  });
  const text = strip(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  const steps = [...text.matchAll(/^\s*→ (.*)$/gm)].map((match) => match[1].trim());
  return { status: res.status, text, steps };
}

let cases = 0;
let failures = 0;

/**
 * One case: run the CLI, then assert exit code, next-step count, an expected
 * step and that nothing in the auth directory changed.
 */
function check(name, storage, expect, assert) {
  const before = fs.readdirSync(authDir).sort().join(',');
  const result = runDoctor(storage);
  const after = fs.readdirSync(authDir).sort().join(',');
  cases += 1;

  try {
    if (result.status !== expect.status) {
      throw new Error(`exit ${result.status}, expected ${expect.status}`);
    }
    if (result.steps.length !== expect.steps) {
      throw new Error(
        `${result.steps.length} next step(s), expected ${expect.steps}: ${JSON.stringify(result.steps)}`
      );
    }
    if (expect.step && !result.steps.some((line) => line.includes(expect.step))) {
      throw new Error(`no next step matching "${expect.step}": ${JSON.stringify(result.steps)}`);
    }
    if (before !== after) throw new Error(`doctor modified ${authDir}`);
    assert?.(result);
    console.log(`  ok    ${cases}. ${name} — exit ${result.status}, ${result.steps.length} next step(s)`);
  } catch (error) {
    failures += 1;
    console.log(`  fail  ${cases}. ${name} — ${error.message}`);
    for (const line of result.text.split('\n').filter((l) => l.trim())) console.log(`          ${line}`);
  }
}

try {
  check('memory mode passes with no advice', 'memory', { status: 0, steps: 0 }, (result) => {
    if (!/PASS/.test(result.text)) throw new Error('expected PASS');
    if (!/not needed for STORAGE=memory/.test(result.text)) throw new Error('expected the memory note');
  });

  check(
    'auto falls back to memory and still passes',
    'auto',
    { status: 0, steps: 1, step: 'save the OAuth client JSON' },
    (result) => {
      if (!/warn\s+credentials/.test(result.text)) {
        throw new Error('credentials should be a warning in auto mode');
      }
      if (!/ok\s+backend\s+memory/.test(result.text)) throw new Error('expected the memory fallback');
    }
  );

  check(
    'drive with no credentials fails and offers only the credentials step',
    'drive',
    { status: 1, steps: 1, step: 'save the OAuth client JSON' },
    (result) => {
      if (!/fail\s+credentials/.test(result.text)) throw new Error('credentials should fail in drive mode');
      if (result.steps.some((line) => line.includes('npm run auth'))) {
        throw new Error('npm run auth cannot work without credentials but was still suggested');
      }
      if (!/blocked/.test(result.text)) throw new Error('token row should say it is blocked');
    }
  );

  // Both kinds of step fire here (the credentials are unusable and the token is missing), so this is
  // the case that proves only the reachable one is printed.
  fs.writeFileSync(path.join(authDir, 'credentials.json'), 'not-json');

  check(
    'corrupt credentials with no token print one step, not two',
    'drive',
    { status: 1, steps: 1, step: 're-download the OAuth client JSON' },
    (result) => {
      if (!/fail\s+credentials/.test(result.text)) throw new Error('credentials should fail');
      if (result.steps.some((line) => line.includes('npm run auth'))) {
        throw new Error('auth was suggested even though these credentials cannot log in');
      }
    }
  );

  fs.writeFileSync(
    path.join(authDir, 'credentials.json'),
    JSON.stringify({ installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'test' } })
  );

  check('credentials without a token ask for auth', 'drive', { status: 1, steps: 1, step: 'npm run auth' }, (result) => {
    if (!/ok\s+credentials/.test(result.text)) throw new Error('credentials should be accepted');
  });

  fs.writeFileSync(path.join(authDir, 'token.json'), 'not-json');

  check(
    'a corrupt token fails once and asks for auth',
    'drive',
    { status: 1, steps: 1, step: 'npm run auth' },
    (result) => {
      if (!/fail\s+token/.test(result.text)) throw new Error('token should fail');
    }
  );

  fs.rmSync(path.join(authDir, 'credentials.json'));
  fs.rmSync(path.join(authDir, 'token.json'));

  check('an unknown STORAGE value fails on the backend', 's3', { status: 1, steps: 1 }, (result) => {
    if (!/fail\s+backend/.test(result.text)) throw new Error('backend should fail for STORAGE=s3');
  });
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(authDir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`FAIL — ${failures} of ${cases} doctor cases`);
  process.exitCode = 1;
} else {
  console.log(`PASS — ${cases} doctor cases (exit codes + next-step dedupe)`);
}
