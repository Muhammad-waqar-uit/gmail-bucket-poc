import { loadEnv } from './env.js';
loadEnv();

import { fileURLToPath } from 'node:url';
import { createStore, serve } from 'gmail-bucket';

// The built React app sits next to dist/ and is served by the API process.
const staticDir = fileURLToPath(new URL('../web/dist', import.meta.url));
const port = Number(process.env.PORT) || 4570;
const host = process.env.HOST || '127.0.0.1';

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
