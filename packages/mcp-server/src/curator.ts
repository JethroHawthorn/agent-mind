#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  openDatabaseReadOnly,
  openUsageDatabase,
  RecommendationService,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';

function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      analyze: { type: 'boolean' },
      duplicates: { type: 'boolean' },
      compare: { type: 'string' },
      against: { type: 'string' },
      'include-candidates': { type: 'boolean' },
      'include-inactive': { type: 'boolean' },
      recommendations: { type: 'boolean' },
      show: { type: 'string' },
      explain: { type: 'string' },
      dismiss: { type: 'string' },
      'expected-revision': { type: 'string' },
      state: { type: 'string' },
      classification: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const actions = [
    'analyze',
    'recommendations',
    'show',
    'explain',
    'dismiss',
    'duplicates',
    'compare',
  ].filter((k) => values[k as keyof typeof values] !== undefined);
  if (actions.length !== 1)
    throw new AgentMindError(
      'CURATOR_INVALID_INPUT',
      'Choose one advisory action. No skill lifecycle or filesystem actions exist.',
    );
  if (
    (values['expected-revision'] !== undefined && !values.dismiss) ||
    ([values.state, values.limit, values.offset, values.classification].some(
      (v) => v !== undefined,
    ) &&
      !values.recommendations)
  )
    throw new AgentMindError(
      'CURATOR_INVALID_INPUT',
      'Filters apply only to listing; revisions apply only to dismissal.',
    );
  if (
    (values.against && !values.compare) ||
    (values.compare && !values.against) ||
    ((values['include-candidates'] || values['include-inactive']) &&
      !values.duplicates &&
      !values.compare)
  )
    throw new AgentMindError(
      'CURATOR_INVALID_INPUT',
      'Comparison options require duplicate analysis or two exact version IDs.',
    );
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db'] as const)
    if (values[key]) args.push(`--${key}`, values[key]);
  const config = readConfig(args);
  const write = !!(values.analyze || values.dismiss || values.duplicates);
  const db = write ? openUsageDatabase(config.dbPath) : openDatabaseReadOnly(config.dbPath);
  const integer = (v: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(v))
      throw new AgentMindError('CURATOR_INVALID_INPUT', 'Expected a bounded integer.');
    return Number(v);
  };
  try {
    const service = new RecommendationService(db, config.project);
    const options = {
      include_candidates: !!values['include-candidates'],
      include_inactive: !!values['include-inactive'],
    };
    const result = values.duplicates
      ? service.analyzeDuplicates(options)
      : values.compare
        ? service.compare({
            ...options,
            left_version_id: values.compare,
            right_version_id: values.against,
          })
        : values.analyze
          ? service.analyze({})
          : values.dismiss
            ? service.dismiss({
                recommendation_id: values.dismiss,
                expected_revision: integer(values['expected-revision'] ?? 'invalid'),
              })
            : values.show || values.explain
              ? service.get({ recommendation_id: values.show ?? values.explain })
              : service.list({
                  ...(values.state ? { state: values.state } : {}),
                  ...(values.classification ? { classification: values.classification } : {}),
                  ...(values.limit ? { limit: integer(values.limit) } : {}),
                  ...(values.offset ? { offset: integer(values.offset) } : {}),
                });
    console.log(JSON.stringify(result));
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
