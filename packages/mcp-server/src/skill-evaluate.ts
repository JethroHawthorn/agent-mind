#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AgentMindError, openDatabase, SkillEvaluationService, safeError } from '@agentmind/core';
import { readConfig } from './config.js';

function main() {
  process.umask(0o077);
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        'project-root': { type: 'string' },
        'project-key': { type: 'string' },
        db: { type: 'string' },
        'version-id': { type: 'string' },
        'expected-content-hash': { type: 'string' },
        'expected-state-revision': { type: 'string' },
        mode: { type: 'string' },
        'suite-id': { type: 'string' },
        'suite-version': { type: 'string' },
        'expected-suite-digest': { type: 'string' },
        'report-id': { type: 'string' },
        'list-version-id': { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Use evaluate arguments, --report-id UUID, or --list-version-id UUID; commands and scripts are unsupported.',
    );
  }
  const mutations = [
    values['expected-content-hash'],
    values['expected-state-revision'],
    values.mode,
    values['suite-id'],
    values['suite-version'],
    values['expected-suite-digest'],
  ];
  const actions = [values['version-id'], values['report-id'], values['list-version-id']].filter(
    (value) => value !== undefined,
  );
  if (
    actions.length !== 1 ||
    (!values['version-id'] && mutations.some((value) => value !== undefined)) ||
    (!values['list-version-id'] && (values.limit !== undefined || values.offset !== undefined))
  )
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Choose exactly one evaluation, report inspection or report listing action.',
    );
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db'] as const)
    if (values[key] !== undefined) args.push(`--${key}`, values[key]);
  const config = readConfig(args);
  const db = openDatabase(config.dbPath, { supervisedOnly: true });
  try {
    const service = new SkillEvaluationService(db, config.project);
    const result = values['report-id']
      ? service.getReport({ evaluation_id: values['report-id'] })
      : values['list-version-id']
        ? service.listReports({
            version_id: values['list-version-id'],
            ...(values.limit !== undefined ? { limit: integer(values.limit) } : {}),
            ...(values.offset !== undefined ? { offset: integer(values.offset) } : {}),
          })
        : service.evaluate({
            version_id: values['version-id'],
            expected_content_hash: values['expected-content-hash'],
            expected_state_revision: integer(values['expected-state-revision']),
            ...(values.mode !== undefined ? { mode: values.mode } : {}),
            ...(values['suite-id'] !== undefined ? { suite_id: values['suite-id'] } : {}),
            ...(values['suite-version'] !== undefined
              ? { suite_version: integer(values['suite-version']) }
              : {}),
            ...(values['expected-suite-digest'] !== undefined
              ? { expected_suite_digest: values['expected-suite-digest'] }
              : {}),
          });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}
function integer(value: string | undefined) {
  if (
    value === undefined ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new AgentMindError('INVALID_INPUT', 'Expected a nonnegative integer.');
  return Number(value);
}
try {
  main();
} catch (error) {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
