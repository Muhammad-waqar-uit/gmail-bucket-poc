import { google } from 'googleapis';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  // Needed for the Drive backend: it must see a base folder you created by hand.
  'https://www.googleapis.com/auth/drive',
];

export function dataDir(): string {
  return process.env.GMAIL_BUCKET_DIR || path.join(os.homedir(), '.gmail-bucket');
}
export function credFile(): string {
  return path.join(dataDir(), 'credentials.json');
}
export function tokenFile(): string {
  return path.join(dataDir(), 'token.json');
}

function envCredentials(): { client_id: string; client_secret: string } | undefined {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { client_id: id, client_secret: secret } : undefined;
}

function makeClient() {
  const env = envCredentials();
  if (env) return new google.auth.OAuth2(env.client_id, env.client_secret, REDIRECT);

  const file = credFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No Google credentials. Save your OAuth "Desktop app" JSON to ${file}, ` +
        `or set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = raw.installed ?? raw.web;
  if (!c) throw new Error('credentials.json has no "installed" or "web" section');
  return new google.auth.OAuth2(c.client_id, c.client_secret, REDIRECT);
}

/** Credentials file present (or set through env)? Does not prove a token exists. */
export function hasCredentials(): boolean {
  return Boolean(envCredentials()) || fs.existsSync(credFile());
}

export function hasToken(): boolean {
  return Boolean(process.env.GOOGLE_REFRESH_TOKEN) || fs.existsSync(tokenFile());
}

export function getAuthedClient() {
  const client = makeClient();

  // Headless / hosted mode: a refresh token supplied through the environment.
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (refresh) {
    client.setCredentials({ refresh_token: refresh, access_token: process.env.GOOGLE_ACCESS_TOKEN });
    return client;
  }

  const file = tokenFile();
  if (!fs.existsSync(file)) throw new Error('Not logged in yet. Run: npm run auth');
  client.setCredentials(JSON.parse(fs.readFileSync(file, 'utf8')));
  client.on('tokens', (t) => {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...prev, ...t }, null, 2), { mode: 0o600 });
  });
  return client;
}

export async function login(): Promise<void> {
  const client = makeClient();
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('\nOpen this URL in your browser and approve access:\n\n' + url + '\n');

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.setHeader('content-type', 'text/plain');
      if (c) {
        res.end('Done. You can close this tab and go back to the terminal.');
        server.close();
        resolve(c);
      } else {
        res.end('Waiting for authorization...');
        if (err) {
          server.close();
          reject(new Error(err));
        }
      }
    });
    server.listen(PORT);
  });

  const { tokens } = await client.getToken(code);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Saved token to ${tokenFile()}`);
  if (!tokens.refresh_token) {
    console.log(
      'Note: Google did not return a refresh token. If it expires in 7 days, run "npm run auth" again ' +
        'or set GOOGLE_REFRESH_TOKEN in .env.'
    );
  }
}
