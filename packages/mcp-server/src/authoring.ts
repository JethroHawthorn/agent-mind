#!/usr/bin/env node
import { readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  openDatabaseReadOnly,
  openUsageDatabase,
  SkillAuthoringService,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';

function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      'source-agent': { type: 'string' },
      context: { type: 'boolean' },
      submit: { type: 'boolean' },
      get: { type: 'string' },
      list: { type: 'boolean' },
      diff: { type: 'string' },
      path: { type: 'string' },
      offset: { type: 'string' },
      limit: { type: 'string' },
      evaluate: { type: 'string' },
      'expected-content-hash': { type: 'string' },
      'expected-state-revision': { type: 'string' },
      mode: { type: 'string' },
      session: { type: 'string' },
      all: { type: 'boolean' },
      'disable-skill-proposals': { type: 'boolean' },
    },
  });
  const actions = ['context', 'submit', 'get', 'list', 'diff', 'evaluate'].filter(
    (k) => values[k as keyof typeof values] !== undefined,
  );
  if (actions.length !== 1)
    throw new AgentMindError('AUTHORING_INVALID_INPUT', 'Choose one authoring action.');
  if (
    (values.path && !values.diff) ||
    (values.offset && !values.diff && !values.list) ||
    (values.limit && !values.diff && !values.list) ||
    (values.all && !values.list) ||
    ([values.mode, values['expected-content-hash'], values['expected-state-revision']].some(
      (v) => v !== undefined,
    ) &&
      !values.evaluate)
  )
    throw new AgentMindError(
      'AUTHORING_INVALID_INPUT',
      'Options do not apply to the selected action.',
    );
  const args: string[] = [];
  for (const k of ['project-root', 'project-key', 'db', 'source-agent'] as const)
    if (values[k]) args.push(`--${k}`, values[k]);
  const config = readConfig(args);
  if (values.session && values.session.length > 200)
    throw new AgentMindError('AUTHORING_INVALID_INPUT', 'Session label exceeds its bound.');
  const db =
    values.get || values.list || values.diff
      ? openDatabaseReadOnly(config.dbPath)
      : openUsageDatabase(config.dbPath);
  const integer = (s: string | undefined) => {
    if (!s || !/^\d+$/.test(s))
      throw new AgentMindError('AUTHORING_INVALID_INPUT', 'Expected a bounded integer.');
    return Number(s);
  };
  try {
    const service = new SkillAuthoringService(
      db,
      config.project,
      config.sourceAgent,
      !values['disable-skill-proposals'],
      values.session,
    );
    let result: unknown;
    if (values.context || values.submit) {
      const max = values.context ? 2048 : 65536;
      const buffer = Buffer.alloc(max + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(0, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > max)
        throw new AgentMindError('AUTHORING_INVALID_INPUT', 'Input exceeds its byte budget.');
      let p: unknown;
      try {
        p = JSON.parse(buffer.subarray(0, size).toString('utf8'));
      } catch {
        throw new AgentMindError('AUTHORING_INVALID_INPUT', 'Expected one JSON object on stdin.');
      }
      result = values.context ? service.context(p) : service.submit(p);
    } else if (values.get) result = service.get({ proposal_id: values.get });
    else if (values.list)
      result = service.list({
        pending_only: !values.all,
        ...(values.limit ? { limit: integer(values.limit) } : {}),
        ...(values.offset ? { offset: integer(values.offset) } : {}),
      });
    else if (values.diff)
      result = service.diff({
        proposal_id: values.diff,
        ...(values.path ? { path: values.path } : {}),
        ...(values.limit ? { limit: integer(values.limit) } : {}),
        ...(values.offset ? { offset: integer(values.offset) } : {}),
      });
    else
      result = service.evaluate({
        proposal_id: values.evaluate,
        expected_content_hash: values['expected-content-hash'],
        expected_state_revision: integer(values['expected-state-revision']),
        ...(values.mode ? { mode: values.mode } : {}),
      });
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}
try {
  main();
} catch (error) {
  const e = safeError(error);
  console.error(`[agentmind] ${e.code}: ${e.message}`);
  process.exitCode = 1;
}
