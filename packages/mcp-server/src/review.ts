#!/usr/bin/env node
// Trusted local operator entrypoint. Never exposed as an MCP tool or invoked from retrieved data.
import { parseArgs } from 'node:util';
import { AgentMindError, ExperienceService, openDatabase, safeError } from '@agentmind/core';
import { readConfig } from './config.js';

function main(): void {
  process.umask(0o077);
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        'project-root': { type: 'string' },
        'project-key': { type: 'string' },
        db: { type: 'string' },
        inspect: { type: 'string' },
        id: { type: 'string' },
        decision: { type: 'string' },
        'expected-updated-at': { type: 'string' },
        reviewer: { type: 'string' },
        reason: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Use --project-root and --inspect ID, or --id ID --decision approved|rejected --expected-updated-at TIMESTAMP --reviewer NAME --reason SUMMARY.',
    );
  }
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db'] as const) {
    const value = values[key];
    if (value !== undefined) args.push(`--${key}`, value);
  }
  if (
    values.inspect &&
    (values.id ||
      values.decision ||
      values['expected-updated-at'] ||
      values.reviewer ||
      values.reason)
  ) {
    throw new AgentMindError('INVALID_CONFIG', 'Inspect and review are separate local actions.');
  }
  const config = readConfig(args);
  const db = openDatabase(config.dbPath);
  try {
    const service = new ExperienceService(db, config.project);
    const result = values.inspect
      ? service.inspect(values.inspect)
      : service.review({
          id: values.id,
          decision: values.decision,
          expected_updated_at: values['expected-updated-at'],
          reviewer: values.reviewer,
          reason: values.reason,
        });
    process.stdout.write(`${JSON.stringify({ experience: result, untrusted_data: true })}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
