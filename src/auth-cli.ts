#!/usr/bin/env node
import { loadEnv } from './env.js';

loadEnv();

const { login, credFile, tokenFile } = await import('gmail-bucket');

async function main() {
  console.log(`credentials: ${credFile()}`);
  console.log(`token:       ${tokenFile()}`);
  console.log('scopes:      gmail.modify + drive (both backends share one token)');
  await login();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
