import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer, type StoreInfo } from 'gmail-bucket';

const COOKIE = 'bucket_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_BODY = 8 * 1024;

// Sessions live in this process only, so a restart drops every cookie and the UI asks
// for the token again. That is the safe default: nothing persists where a backup or a
// log could pick it up.
const sessions = new Map<string, number>();

function digestsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest()
  );
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function cookieAttributes(req: IncomingMessage, maxAgeSeconds: number): string {
  const secure =
    (req.socket as { encrypted?: boolean }).encrypted === true ||
    req.headers['x-forwarded-proto'] === 'https';
  return `HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ token?: unknown } | undefined> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_LOGIN_BODY) return undefined;
  }
  try {
    return JSON.parse(body) as { token?: unknown };
  } catch {
    return undefined;
  }
}

export interface SessionOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  token?: string;
}

/**
 * `createServer()` plus a sign-in route and cookie sessions.
 *
 * Everything the library already does stays in charge of the API itself; this only turns
 * a session cookie into the `Authorization: Bearer` header its handler expects, because a
 * browser cannot attach headers to a download link and must never hold the token itself.
 */
export function serveWithSession(info: StoreInfo, opts: SessionOptions = {}): Server {
  const token = opts.token?.trim() || undefined;
  const port = opts.port ?? 4570;
  const host = opts.host ?? '127.0.0.1';

  // The library server is used purely as the request handler; this process owns listen().
  const inner = createServer(info, { staticDir: opts.staticDir, token });
  const handle = inner.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;

  const signedIn = (req: IncomingMessage): boolean => {
    if (!token) return false;
    const id = cookieValue(req.headers.cookie, COOKIE);
    if (!id) return false;
    const expires = sessions.get(id);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      sessions.delete(id);
      return false;
    }
    sessions.set(id, Date.now() + SESSION_MS);
    return true;
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/session') {
      if (req.method === 'GET') {
        return json(res, 200, { required: Boolean(token), authenticated: !token || signedIn(req) });
      }

      if (req.method === 'DELETE') {
        const id = cookieValue(req.headers.cookie, COOKIE);
        if (id) sessions.delete(id);
        return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; ${cookieAttributes(req, 0)}` });
      }

      if (req.method === 'POST') {
        if (!token) return json(res, 400, { error: 'GMAIL_BUCKET_TOKEN is not set on this server' });
        // JSON-only keeps a cross-site form post from driving the sign-in route.
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return json(res, 415, { error: 'Send application/json' });
        }
        const body = await readJson(req);
        const supplied = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!supplied || !digestsMatch(supplied, token)) return json(res, 401, { error: 'Wrong token' });
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, Date.now() + SESSION_MS);
        return json(
          res,
          200,
          { ok: true },
          { 'set-cookie': `${COOKIE}=${id}; ${cookieAttributes(req, SESSION_MS / 1000)}` }
        );
      }

      return json(res, 405, { error: 'Method not allowed' });
    }

    if (token && req.headers.authorization === undefined && signedIn(req)) {
      req.headers.authorization = `Bearer ${token}`;
    }
    handle(req, res);
  });

  server.listen(port, host, () => {
    console.log(`gmail-bucket  →  http://${host}:${port}`);
    console.log(`storage mode  →  ${info.mode}  (${info.reason})`);
    console.log(`base          →  ${info.base}`);
    console.log(
      `auth          →  ${
        token ? 'sign in at / (cookie session) or send Authorization: Bearer' : 'none — loopback only'
      }`
    );
  });

  return server;
}
