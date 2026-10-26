#!/usr/bin/env node
import { readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  brokerRequest,
  LearningReviewDecisions,
  LearningReviewService,
  loadBrokerClient,
  localReviewCaller,
  openDatabaseReadOnly,
  openUsageDatabase,
  reviewText,
  safeError,
} from '@agentmind/core';
import { readConfig } from './config.js';

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      'client-config': { type: 'string' },
      project: { type: 'string' },
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      list: { type: 'boolean' },
      show: { type: 'string' },
      status: { type: 'string' },
      evidence: { type: 'string' },
      diff: { type: 'string' },
      handoff: { type: 'string' },
      decide: { type: 'boolean' },
      all: { type: 'boolean' },
      state: { type: 'string' },
      type: { type: 'string' },
      name: { type: 'string' },
      evaluation: { type: 'string' },
      validation: { type: 'string' },
      order: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      path: { type: 'string' },
      snapshot: { type: 'string' },
      'candidate-digest': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const actions = ['list', 'show', 'status', 'evidence', 'diff', 'handoff', 'decide'].filter(
    (k) => values[k as keyof typeof values] !== undefined,
  );
  if (actions.length !== 1)
    throw new AgentMindError(
      'REVIEW_INVALID_INPUT',
      'Choose exactly one review action. Decisions are advisory only.',
    );
  for (const key of ['all', 'state', 'type', 'name', 'evaluation', 'validation', 'order'])
    if (values[key as keyof typeof values] !== undefined && !values.list)
      throw new AgentMindError('REVIEW_INVALID_INPUT', 'Queue filters apply only to --list.');
  if (
    (values.path && !values.diff) ||
    ((values.offset || values.limit) && !values.diff && !values.list) ||
    ((values.snapshot || values['candidate-digest']) && !values.handoff)
  )
    throw new AgentMindError('REVIEW_INVALID_INPUT', 'Selector does not apply to this action.');
  const integer = (v: string | undefined) =>
    v !== undefined ? Number(/^\d+$/.test(v) ? v : 'NaN') : undefined;
  let input: unknown;
  let op: string;
  if (values.list) {
    op = 'review_queue';
    input = {
      pending_only: !values.all,
      ...Object.fromEntries(
        ['state', 'type', 'name', 'evaluation', 'validation', 'order'].flatMap((k) =>
          values[k as keyof typeof values] === undefined
            ? []
            : [[k, values[k as keyof typeof values]]],
        ),
      ),
      ...(values.limit ? { limit: integer(values.limit) } : {}),
      ...(values.offset ? { offset: integer(values.offset) } : {}),
    };
  } else if (values.diff) {
    op = 'review_diff';
    input = {
      proposal_id: values.diff,
      ...(values.path ? { path: values.path } : {}),
      ...(values.limit ? { limit: integer(values.limit) } : {}),
      ...(values.offset ? { offset: integer(values.offset) } : {}),
    };
  } else if (values.evidence) {
    op = 'review_evidence';
    input = { proposal_id: values.evidence };
  } else if (values.handoff) {
    op = 'review_handoff';
    input = {
      proposal_id: values.handoff,
      expected_snapshot_digest: values.snapshot,
      candidate_digest: values['candidate-digest'],
    };
  } else if (values.decide) {
    op = 'review_decide';
    const b = Buffer.alloc(2049);
    let n = 0;
    while (n < b.length) {
      const r = readSync(0, b, n, b.length - n, null);
      if (!r) break;
      n += r;
    }
    if (n > 2048)
      throw new AgentMindError('REVIEW_INVALID_INPUT', 'Decision input exceeds 2048 bytes.');
    try {
      input = JSON.parse(b.subarray(0, n).toString('utf8'));
    } catch {
      throw new AgentMindError(
        'REVIEW_INVALID_INPUT',
        'Expected one advisory decision JSON object on stdin.',
      );
    }
  } else {
    op = 'review_get';
    input = { proposal_id: values.show ?? values.status };
  }
  let result: unknown;
  if (values['client-config']) {
    if (
      !values.project ||
      [values.db, values['project-root'], values['project-key']].some((v) => v !== undefined)
    )
      throw new AgentMindError(
        'REVIEW_INVALID_INPUT',
        'Broker mode requires a configured project alias and forbids local registry overrides.',
      );
    result = await brokerRequest(loadBrokerClient(values['client-config']), 'operator', {
      schema_version: 1,
      project: values.project,
      op,
      input,
    });
  } else {
    if (values.project)
      throw new AgentMindError(
        'REVIEW_INVALID_INPUT',
        'Project aliases require broker configuration.',
      );
    const args: string[] = [];
    for (const k of ['project-root', 'project-key', 'db'] as const)
      if (values[k]) args.push(`--${k}`, values[k]);
    const config = readConfig(args);
    const db = values.decide
      ? openUsageDatabase(config.dbPath)
      : openDatabaseReadOnly(config.dbPath);
    try {
      const read = new LearningReviewService(db, config.project);
      if (op === 'review_queue') result = read.list(input);
      else if (op === 'review_diff') result = read.diff(input);
      else if (op === 'review_evidence') result = read.evidence(input);
      else if (op === 'review_handoff') result = read.handoff(input);
      else if (op === 'review_decide')
        result = new LearningReviewDecisions(db, config.project, localReviewCaller()).decide(input);
      else result = read.get(input);
    } finally {
      db.close();
    }
  }
  if (op === 'review_queue' && result && typeof result === 'object' && 'page_status' in result) {
    const page = result as { page_status: string; next_offset: number | null };
    if (page.page_status === 'CONTINUE')
      console.error(
        `[agentmind] REVIEW_CONTINUE: No matches in this bounded scan; continue with --offset ${page.next_offset}.`,
      );
    if (page.page_status === 'OFFSET_LIMIT_REACHED')
      console.error(
        '[agentmind] REVIEW_OFFSET_LIMIT: Queue is not exhausted; narrow the filters and restart at offset 0.',
      );
  }
  process.stdout.write(`${reviewText(result, !values.json)}\n`);
}
main().catch((e) => {
  const r = safeError(e);
  console.error(`[agentmind] ${r.code}: ${r.message}`);
  process.exitCode = 1;
});
