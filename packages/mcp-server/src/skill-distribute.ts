#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  confirmOperatorReview,
  openDatabase,
  openDatabaseReadOnly,
  SkillDistributionService,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';
import { diagnosticText } from './installer/files.js';

async function main() {
  process.umask(0o077);
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        'project-root': { type: 'string' },
        'project-key': { type: 'string' },
        db: { type: 'string' },
        'home-root': { type: 'string' },
        'skill-id': { type: 'string' },
        target: { type: 'string' },
        scope: { type: 'string' },
        plan: { type: 'boolean' },
        status: { type: 'boolean' },
        verify: { type: 'boolean' },
        sync: { type: 'boolean' },
        remove: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Select --plan|--status|--verify|--sync|--remove, --skill-id UUID, --target codex|claude|all, --scope project|user. No force or yes flags exist.',
    );
  }
  const actions = ['plan', 'status', 'verify', 'sync', 'remove'].filter(
    (key) => values[key] !== undefined,
  );
  if (actions.length !== 1 || (values['dry-run'] !== undefined && !values.sync && !values.remove))
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Select exactly one distribution action; dry-run is only for sync/remove.',
    );
  const mutation = Boolean((values.sync || values.remove) && !values['dry-run']);
  if (mutation && (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY))
    throw new AgentMindError(
      'INTERACTIVE_OPERATOR_REQUIRED',
      'Distribution changes require the existing interactive operator confirmation workflow.',
    );
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db'])
    if (typeof values[key] === 'string') args.push(`--${key}`, values[key] as string);
  const config = readConfig(args);
  const db =
    mutation || values.verify ? openDatabase(config.dbPath) : openDatabaseReadOnly(config.dbPath);
  try {
    const service = new SkillDistributionService(
      db,
      config.project,
      typeof values['home-root'] === 'string' ? values['home-root'] : undefined,
    );
    const input = {
      skill_id: values['skill-id'],
      target: values.target,
      scope: values.scope,
      operation: values.remove ? 'remove' : 'sync',
    };
    const result = mutation
      ? service.commit(input, await confirmOperatorReview(service.plan(input)))
      : values.verify
        ? service.verify(input)
        : service.plan(input);
    process.stdout.write(`${diagnosticText(result)}\n`);
  } finally {
    db.close();
  }
}
main().catch((error) => {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
