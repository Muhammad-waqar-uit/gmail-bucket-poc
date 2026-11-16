#!/usr/bin/env node
import { loadEnv } from './env.js';
loadEnv();

const { login, credFile, tokenFile } = await import('./auth.js');

async function main() {
  console.log(`credentials: ${credFile()}`);
  console.log(`token:       ${tokenFile()}`);
  await login();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
