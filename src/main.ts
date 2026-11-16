import { loadEnv } from './env.js';
loadEnv();

import type { StoreInfo } from './store.js';

let info: StoreInfo;
try {
  const { createStore } = await import('./store.js');
  info = await createStore();
} catch (e: any) {
  console.error(`\nCannot start: ${e?.message ?? e}\n\nCheck .env (see .env.example).\n`);
  process.exit(1);
}

const { serve } = await import('./server.js');

const server = serve(info);

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
