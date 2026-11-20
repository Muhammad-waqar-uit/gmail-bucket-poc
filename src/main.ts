import { loadEnv } from './env.js';
loadEnv();

import { fileURLToPath } from 'node:url';
import { createStore, serve } from 'gmail-bucket';

// The built React app sits next to dist/ and is served by the API process.
const staticDir = fileURLToPath(new URL('../web/dist', import.meta.url));
const port = Number(process.env.PORT) || 4570;
const host = process.env.HOST || '127.0.0.1';
const token = process.env.GMAIL_BUCKET_TOKEN?.trim();

// Loopback is the only place this API is safe without a password: it can read and write every bucket
// in the linked Google account, and `serve()` answers cross-origin requests from any site.
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
if (!loopback && !token) {
  console.error(
    `\nRefusing to listen on ${host} without GMAIL_BUCKET_TOKEN.\n\n` +
      '  The API can read and write every bucket in the linked Google account, and it accepts\n' +
      '  cross-origin requests from any website. Either keep HOST=127.0.0.1 (the default), or set\n' +
      '  GMAIL_BUCKET_TOKEN to a long random string and send it as "Authorization: Bearer <token>".\n\n' +
      '  The bundled UI does not send the token yet, so a non-loopback bind is API-only for now.\n'
  );
  process.exit(1);
}

let info;
try {
  info = await createStore();
} catch (e: any) {
  console.error(`\nCannot start: ${e?.message ?? e}\n\nCheck .env (see .env.example).\n`);
  process.exit(1);
}

const server = serve(info, { port, host, staticDir });

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
