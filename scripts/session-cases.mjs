/**
 * Contract test for the sign-in layer in front of the API.
 *
 *   npm run test:session
 *
 * Starts the real session server on an ephemeral port with a token and a MemoryStore,
 * then drives it over HTTP: wrong token, right token, cookie access to /api, sign-out and
 * the 401 path. No Google account and no network.
 */
import { MemoryStore } from 'gmail-bucket';
import { serveWithSession } from '../dist/session.js';

const TOKEN = 'test-token-6f3a9c';

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

function expectMatch(value, pattern, what) {
  if (!pattern.test(value ?? '')) throw new Error(`${what}: ${JSON.stringify(value)} does not match ${pattern}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (error) {
    fail(name, error);
  }
}

const store = new MemoryStore();
const info = { mode: 'memory', base: 'in-process memory', reason: 'test', store, rootLabel: 'test' };

const server = serveWithSession(info, { port: 0, host: '127.0.0.1', token: TOKEN });
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const base = `http://127.0.0.1:${server.address().port}`;

/** The cookie header value only: `bucket_session=<id>`. */
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).join('; ').split(';')[0].trim();

const session = (headers = {}) => fetch(`${base}/api/session`, { headers });
const status = (headers = {}) =>
  fetch(`${base}/api/status`, { headers, redirect: 'manual' });
const login = (body, contentType = 'application/json') =>
  fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

let cookie = '';

await check('an anonymous visitor is told a sign-in is required', async () => {
  const res = await session();
  expectEqual(res.status, 200, 'status');
  const body = await res.json();
  expectEqual(body.required, true, 'required');
  expectEqual(body.authenticated, false, 'authenticated');
  return 'required, not authenticated';
});

await check('the API answers 401 without a token or cookie', async () => {
  const res = await status();
  expectEqual(res.status, 401, 'status');
  expectEqual((await res.json()).error, 'Unauthorized', 'error');
  return '401 Unauthorized';
});

await check('a wrong token is rejected and sets no cookie', async () => {
  const res = await login({ token: 'not-the-token' });
  expectEqual(res.status, 401, 'status');
  expectEqual((await res.json()).error, 'Wrong token', 'error');
  expectMatch((res.headers.getSetCookie?.() ?? []).join(';'), /^$/, 'set-cookie');
  return '401, no cookie';
});

await check('a non-JSON sign-in is refused', async () => {
  const res = await login(JSON.stringify({ token: TOKEN }), 'text/plain');
  expectEqual(res.status, 415, 'status');
  return '415';
});

await check('the right token returns a hardened session cookie', async () => {
  const res = await login({ token: TOKEN });
  expectEqual(res.status, 200, 'status');
  const setCookie = (res.headers.getSetCookie?.() ?? []).join('; ');
  expectMatch(setCookie, /bucket_session=[A-Za-z0-9_-]{20,}/, 'session id');
  expectMatch(setCookie, /HttpOnly/, 'HttpOnly');
  expectMatch(setCookie, /Path=\//, 'Path');
  expectMatch(setCookie, /SameSite=Strict/, 'SameSite');
  expectMatch(setCookie, /Max-Age=43200/, 'Max-Age');
  cookie = cookieOf(res);
  return 'HttpOnly, SameSite=Strict, 12h';
});

await check('the cookie authenticates API calls', async () => {
  const res = await status({ cookie });
  expectEqual(res.status, 200, 'status');
  const body = await res.json();
  expectEqual(body.mode, 'memory', 'mode');

  const whoami = await fetch(`${base}/api/session`, { headers: { cookie } });
  expectEqual((await whoami.json()).authenticated, true, 'authenticated');
  return '/api/status 200, session authenticated';
});

await check('a bearer header still works for scripts', async () => {
  const res = await status({ authorization: `Bearer ${TOKEN}` });
  expectEqual(res.status, 200, 'status');
  return '200 without a cookie';
});

await check('sign-out clears the cookie and the API goes back to 401', async () => {
  const out = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { cookie } });
  expectEqual(out.status, 200, 'sign-out status');
  expectMatch((out.headers.getSetCookie?.() ?? []).join('; '), /bucket_session=;.*Max-Age=0/, 'clearing cookie');

  const after = await status({ cookie });
  expectEqual(after.status, 401, 'status with the old cookie');
  return 'cookie dropped server-side';
});

server.close();
server.closeAllConnections?.();

if (failures) {
  console.log(`\nFAIL — ${failures} of ${cases} session cases failed\n`);
  process.exit(1);
}
console.log(`\nPASS — ${cases} session cases (sign-in, cookie access, sign-out, 401)\n`);
