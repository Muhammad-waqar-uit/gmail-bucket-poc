#!/usr/bin/env node
import { loadEnv } from './env.js';

loadEnv();

const { login, credFile, tokenFile, SCOPES } = await import('gmail-bucket');

async function main() {
  console.log(`credentials: ${credFile()}`);
  console.log(`token:       ${tokenFile()}`);
  // Derived from the library so the line cannot drift from what login() requests.
  // v2.2.0 shares one token across both backends; 2.3.0 adds --drive/--gmail/--all.
  console.log(`scopes:      ${SCOPES.join(' + ')}`);
  await login();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
