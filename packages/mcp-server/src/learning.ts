#!/usr/bin/env node
import { readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  confirmOperatorReview,
  LearningSignalService,
  openDatabaseReadOnly,
  openUsageDatabase,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      'source-agent': { type: 'string' },
      record: { type: 'boolean' },
      detect: { type: 'boolean' },
      list: { type: 'boolean' },
      get: { type: 'string' },
      refresh: { type: 'string' },
      dismiss: { type: 'string' },
      supersede: { type: 'string' },
      recommend: { type: 'string' },
      'confirm-correction': { type: 'string' },
      'expected-revision': { type: 'string' },
      limit: { type: 'string' },
      'disable-learning-capture': { type: 'boolean' },
      capabilities: { type: 'boolean' },
    },
  });
  if (values.capabilities) {
    if (Object.keys(values).length !== 1) throw Error('invalid');
    console.log(
      JSON.stringify({
        codex: { adapter: 'explicit-mcp-v1', native_learning_hook: false },
        claude: {
          adapter: 'explicit-mcp-v1',
          native_learning_hook: false,
          authenticated_verification: 'NOT VERIFIED',
        },
        reason:
          'Lifecycle/tool events do not establish reusable learning or verified task outcomes.',
      }),
    );
    return;
  }
  const actions = [
    'record',
    'detect',
    'list',
    'get',
    'refresh',
    'dismiss',
    'supersede',
    'recommend',
    'confirm-correction',
  ].filter((k) => values[k as keyof typeof values] !== undefined);
  if (actions.length !== 1)
    throw new AgentMindError('LEARNING_INVALID_INPUT', 'Choose one learning metadata action.');
  const revision = values['expected-revision'];
  if (
    (revision !== undefined &&
      !values.refresh &&
      !values.dismiss &&
      !values.supersede &&
      !values['confirm-correction']) ||
    (values.limit && !values.list && !values.detect)
  )
    throw new AgentMindError(
      'LEARNING_INVALID_INPUT',
      'Filters/revisions do not apply to this action.',
    );
  const args: string[] = [];
  for (const key of ['project-root', 'project-key', 'db', 'source-agent'] as const)
    if (values[key]) args.push(`--${key}`, values[key]);
  const config = readConfig(args);
  const readOnly = !!(values.list || values.get);
  const db = readOnly ? openDatabaseReadOnly(config.dbPath) : openUsageDatabase(config.dbPath);
  const number = (v: string | undefined) => {
    if (!v || !/^(0|[1-9][0-9]*)$/.test(v))
      throw new AgentMindError('LEARNING_INVALID_INPUT', 'Expected a bounded integer.');
    return Number(v);
  };
  try {
    const service = new LearningSignalService(
      db,
      config.project,
      config.sourceAgent,
      'explicit-cli-v1',
      !values['disable-learning-capture'],
    );
    let result: unknown;
    if (values.record) {
      const buffer = Buffer.alloc(4097);
      let bytes = 0;
      while (bytes < buffer.length) {
        const n = readSync(0, buffer, bytes, buffer.length - bytes, null);
        if (n === 0) break;
        bytes += n;
      }
      if (bytes > 4096)
        throw new AgentMindError('LEARNING_INVALID_INPUT', 'Learning input exceeds 4096 bytes.');
      result = service.record(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
    } else if (values.detect)
      result = service.detect(values.limit ? { limit: number(values.limit) } : {});
    else if (values.list)
      result = service.list(values.limit ? { limit: number(values.limit) } : {});
    else if (values.get) result = service.get({ signal_id: values.get });
    else if (values.recommend) result = service.recommend({ signal_id: values.recommend });
    else if (values.refresh)
      result = service.refresh({ signal_id: values.refresh, expected_revision: number(revision) });
    else if (values.dismiss || values.supersede)
      result = service.state({
        signal_id: values.dismiss ?? values.supersede,
        expected_revision: number(revision),
        state: values.dismiss ? 'dismissed' : 'superseded',
      });
    else {
      const input = {
        signal_id: values['confirm-correction'],
        expected_revision: number(revision),
      };
      const preview = service.prepareCorrection(input);
      result = service.confirmCorrection(input, await confirmOperatorReview(preview));
    }
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}
main().catch((error) => {
  const e = safeError(error);
  console.error(`[agentmind] ${e.code}: ${e.message}`);
  process.exitCode = 1;
});
