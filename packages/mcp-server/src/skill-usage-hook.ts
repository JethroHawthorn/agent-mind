#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { collectClaudeUsage, openUsageDatabase } from '@agentmind/core';
import { readConfig } from './config.js';

async function main() {
  process.umask(0o077);
  const { values: v } = parseArgs({
    options: {
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      'installation-id': { type: 'string' },
      'disable-telemetry': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (v['disable-telemetry']) {
    process.stdin.destroy();
    return;
  }
  const args: string[] = [];
  for (const k of ['project-root', 'project-key', 'db'] as const)
    if (v[k]) args.push(`--${k}`, v[k]);
  const config = readConfig(args);
  const parts: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => {
    console.error('[agentmind] USAGE_HOOK_NOT_STORED: input timeout');
    process.exit(0);
  }, 500);
  try {
    for await (const chunk of process.stdin) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > 65536) throw new Error('oversized');
      parts.push(b);
    }
  } finally {
    clearTimeout(timer);
  }
  const payload: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
  const db = openUsageDatabase(config.dbPath);
  try {
    const r = collectClaudeUsage(db, config.project, v['installation-id'], payload);
    console.error(r.stored ? '[agentmind] USAGE_HOOK_STORED' : '[agentmind] USAGE_HOOK_SKIPPED');
  } finally {
    db.close();
  }
}
// Hooks are informational: no stdout, no blocking/permission decisions, no retries/daemon/buffer files.
main().catch(() => {
  console.error(
    '[agentmind] USAGE_HOOK_NOT_STORED: check configuration, payload limits and local storage',
  );
  process.exitCode = 0;
});
