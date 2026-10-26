#!/usr/bin/env node
import { safeError } from '@agentmind/core';
import { readConfig } from './config.js';
import { startServer } from './runtime.js';

async function main() {
  await startServer(readConfig());
}
main().catch((error: unknown) => {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
