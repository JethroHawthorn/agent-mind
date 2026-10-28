#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  confirmOperatorReview,
  openDatabase,
  SkillOperatorService,
  SkillReviewService,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';

async function main() {
  process.umask(0o077);
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        'project-root': { type: 'string' },
        'project-key': { type: 'string' },
        db: { type: 'string' },
        pending: { type: 'boolean' },
        show: { type: 'string' },
        diff: { type: 'string' },
        evaluation: { type: 'string' },
        approve: { type: 'string' },
        reject: { type: 'string' },
        promote: { type: 'string' },
        rollback: { type: 'string' },
        deactivate: { type: 'string' },
        reason: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Choose --pending, --show/--diff/--evaluation UUID, or --approve/--reject/--promote/--rollback/--deactivate UUID. No yes, force, actor or noninteractive approval flags exist.',
    );
  }
  const actions = [
    'pending',
    'show',
    'diff',
    'evaluation',
    'approve',
    'reject',
    'promote',
    'rollback',
    'deactivate',
  ].filter((k) => values[k] !== undefined);
  if (actions.length !== 1)
    throw new AgentMindError('INVALID_CONFIG', 'Choose exactly one operator action.');
  const action = actions[0] ?? '';
  const mutation = ['approve', 'reject', 'promote', 'rollback', 'deactivate'].includes(action);
  if (
    (!mutation && values.reason !== undefined) ||
    (action !== 'pending' && (values.limit !== undefined || values.offset !== undefined))
  )
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Reason is for confirmed actions; pagination is only for pending.',
    );
  if (mutation && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new AgentMindError(
      'INTERACTIVE_OPERATOR_REQUIRED',
      'Privileged actions require interactive terminal confirmation. Same-user PTYs are not a human-authentication boundary.',
    );
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db'])
    if (typeof values[key] === 'string') args.push(`--${key}`, values[key] as string);
  const config = readConfig(args);
  const db = openDatabase(config.dbPath, { supervisedOnly: true });
  try {
    const read = new SkillReviewService(db, config.project);
    let result: unknown;
    if (mutation) {
      const service = new SkillOperatorService(db, config.project);
      const input = {
        action,
        version_id: values[action],
        ...(values.reason !== undefined ? { reason: values.reason } : {}),
      };
      const preview = service.prepare(input);
      const grant = await confirmOperatorReview(preview);
      result = service.commit(input, grant);
    } else if (action === 'pending') {
      result = read.pending({
        ...(values.limit !== undefined ? { limit: integer(values.limit) } : {}),
        ...(values.offset !== undefined ? { offset: integer(values.offset) } : {}),
      });
    } else {
      const input = { version_id: values[action] };
      result =
        action === 'show'
          ? read.review(input)
          : action === 'diff'
            ? read.diff(input)
            : read.evaluation(input);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}
function integer(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new AgentMindError('INVALID_INPUT', 'Expected a nonnegative integer.');
  return Number(value);
}
main().catch((error) => {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
