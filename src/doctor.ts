import fs from 'node:fs';
import { loadEnv } from './env.js';

loadEnv();

const { SCOPES, credFile, tokenFile, hasCredentials, hasToken, createStore } = await import(
  'gmail-bucket'
);

const C = {
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  fail: '\x1b[31m',
  note: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

type Level = 'ok' | 'warn' | 'fail' | 'note';

const TAG: Record<Level, string> = {
  ok: `${C.ok}ok${C.reset}  `,
  warn: `${C.warn}warn${C.reset}`,
  fail: `${C.fail}fail${C.reset}`,
  note: `${C.note}--${C.reset}  `,
};

interface TokenFile {
  access_token?: string;
  refresh_token?: string;
  scope?: string | string[];
  expiry_date?: number;
}

/** Next steps are keyed, so overlapping problems collapse into one line instead of repeating a command. */
type Step = 'runtime' | 'credentials' | 'config' | 'auth';
const STEP_ORDER: Step[] = ['runtime', 'credentials', 'config', 'auth'];
const steps = new Map<Step, string>();

let failures = 0;
let warnings = 0;

function report(level: Level, label: string, detail = ''): void {
  if (level === 'fail') failures++;
  if (level === 'warn') warnings++;
  console.log(`  ${TAG[level]} ${label.padEnd(16)} ${detail}`.trimEnd());
}

/** Record the first suggestion for a step; later ones are consequences of the same problem. */
function step(kind: Step, text: string): void {
  if (!steps.has(kind)) steps.set(kind, text);
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function fileStat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function age(then: number): string {
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function scopesOf(token: TokenFile): string[] {
  const raw = token.scope;
  return (Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')).split(/\s+/).filter(Boolean);
}

// Empty means unset, same as the library: `STORAGE=` in .env is auto.
const requested = (process.env.STORAGE ?? '').trim().toLowerCase() || 'auto';
const explicit = requested !== 'auto';
const memory = requested === 'memory';

console.log(`\n${C.bold}gmail-bucket doctor${C.reset}`);
console.log(`${C.note}  what this app would use right now — no writes, no uploads${C.reset}\n`);

const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) {
  report('ok', 'node', `${process.versions.node} (${process.platform} ${process.arch})`);
} else {
  report('fail', 'node', `${process.versions.node} is older than the required >=18`);
  step('runtime', 'install Node 18 or newer');
}

report('note', '.env', fs.existsSync('.env') ? 'present' : 'absent — defaults apply, see .env.example');
report('note', 'STORAGE', explicit ? requested : 'auto (drive → gmail → memory)');

// ---------- credentials ----------
const cred = credFile();
const credStat = fileStat(cred);
if (!hasCredentials()) {
  if (memory) {
    report('note', 'credentials', 'not needed for STORAGE=memory');
  } else {
    report(explicit ? 'fail' : 'warn', 'credentials', `missing at ${cred}`);
    step('credentials', `save the OAuth client JSON to ${cred}`);
  }
} else if (!credStat) {
  report('ok', 'credentials', 'from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
} else {
  const doc = readJson<Record<string, unknown>>(cred);
  const client = (doc?.installed ?? doc?.web) as Record<string, unknown> | undefined;
  if (!doc) {
    report('fail', 'credentials', `${cred} is not valid JSON`);
    step('credentials', `re-download the OAuth client JSON to ${cred}`);
  } else if (!client?.client_id || !client?.client_secret) {
    report('fail', 'credentials', `${cred} has no client_id/client_secret`);
    step('credentials', `re-download the OAuth client JSON (type "Desktop app") to ${cred}`);
  } else {
    report('ok', 'credentials', cred);
  }
}

// ---------- token ----------
const tokenPath = tokenFile();
const tokenStat = fileStat(tokenPath);
const envRefresh = Boolean(process.env.GOOGLE_REFRESH_TOKEN);
let tokenOk = false;

if (hasToken() && tokenStat) {
  const token = readJson<TokenFile>(tokenPath);
  if (!token) {
    report('fail', 'token', `${tokenPath} is not valid JSON`);
    step('auth', 'npm run auth   # mint a fresh token');
  } else {
    tokenOk = true;
    report('ok', 'token', tokenPath);

    const granted = scopesOf(token);
    report('note', 'scopes', granted.length ? [...granted].sort().join(' ') : 'none recorded');
    const missing = SCOPES.filter((scope) => !granted.includes(scope));
    if (granted.length && missing.length) {
      report('warn', 'scope gap', `token lacks ${missing.join(', ')}`);
      step('auth', `npm run auth   # grant ${missing.join(' + ')}`);
    }

    const expiry = typeof token.expiry_date === 'number' ? token.expiry_date : 0;
    if (!expiry) report('note', 'access token', 'no expiry recorded — the refresh token decides');
    else if (expiry < Date.now()) report('note', 'access token', `expired ${age(expiry)} — refreshed on use`);
    else report('note', 'access token', `valid for ${Math.max(1, Math.round((expiry - Date.now()) / 60000))}m`);

    if (!token.refresh_token && !envRefresh) {
      report('fail', 'refresh token', 'absent — a one-off access token cannot survive a restart');
      step('auth', 'npm run auth   # store a refresh token');
    }
  }
} else if (envRefresh) {
  tokenOk = true;
  report('ok', 'token', 'GOOGLE_REFRESH_TOKEN from the environment');
} else if (memory) {
  report('note', 'token', 'not needed for STORAGE=memory');
} else if (!hasCredentials()) {
  // Without credentials there is nothing to log in to; the credentials row is the problem.
  report('note', 'token', 'blocked — no credentials to log in with');
} else {
  report(explicit ? 'fail' : 'warn', 'token', `missing at ${tokenPath}`);
  step('auth', 'npm run auth');
}

// ---------- live backend ----------
console.log('');

type Resolved = Awaited<ReturnType<typeof createStore>>;
let resolved: Resolved | undefined;
try {
  resolved = await createStore();
} catch (error) {
  report('fail', 'backend', message(error));
  // With credentials or a token missing, those steps already say what to do — don't pile on.
  if (hasCredentials() && (tokenOk || envRefresh)) step('config', 'check .env against .env.example');
}

if (resolved) {
  const consistent = !explicit || resolved.mode === requested;
  report(
    consistent ? 'ok' : 'fail',
    'backend',
    `${resolved.mode} — ${resolved.reason}${consistent ? '' : ` (asked for ${requested})`}`
  );
  if (!consistent) step('config', `make ${requested} usable, or set STORAGE=${resolved.mode}`);

  report('note', 'base', resolved.baseUrl ? `${resolved.base} (${resolved.baseUrl})` : resolved.base);

  const started = Date.now();
  try {
    const buckets = await resolved.store.listBuckets();
    report('ok', 'read', `${buckets.length} bucket(s) in ${Date.now() - started}ms`);
  } catch (error) {
    report('fail', 'read', message(error));
    step('auth', 'npm run auth   # a dead or under-scoped token fails here');
  }

  if (resolved.mode === 'memory' && !memory) {
    report('warn', 'persistence', 'memory backend — objects disappear when the process stops');
  }
}

// A `npm run auth` hint without credentials is unreachable, so the credentials step stands alone.
const next = STEP_ORDER.filter(
  (kind) => steps.has(kind) && !(kind === 'auth' && steps.has('credentials'))
).map((kind) => steps.get(kind) as string);

console.log('');
if (next.length) {
  console.log(`${C.bold}next${C.reset}`);
  for (const line of next) console.log(`  ${C.note}→${C.reset} ${line}`);
  console.log('');
}

if (failures) {
  const also = warnings ? `, ${warnings} warning(s)` : '';
  console.log(`${C.fail}${C.bold}FAIL${C.reset} — ${failures} problem(s)${also}\n`);
  process.exitCode = 1;
} else {
  const also = warnings ? ` (${warnings} warning(s))` : '';
  console.log(`${C.ok}${C.bold}PASS${C.reset} — configuration is usable${also}\n`);
}
