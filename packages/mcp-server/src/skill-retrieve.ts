#!/usr/bin/env node
import { readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  brokerRequest,
  loadBrokerClient,
  migrateRetrieval,
  openDatabaseReadOnly,
  openUsageDatabase,
  reviewText,
  SkillRetrievalService,
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
      'client-config': { type: 'string' },
      project: { type: 'string' },
      initialize: { type: 'boolean' },
      discover: { type: 'string' },
      route: { type: 'boolean' },
      load: { type: 'string' },
      resources: { type: 'string' },
      resource: { type: 'string' },
      path: { type: 'string' },
      version: { type: 'string' },
      digest: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      'description-chars': { type: 'string' },
      'search-bytes': { type: 'string' },
      'content-bytes': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const action = ['initialize', 'discover', 'load', 'resources', 'resource', 'route'].filter(
    (k) => values[k as keyof typeof values] !== undefined,
  );
  if (action.length !== 1)
    throw new AgentMindError(
      'RETRIEVAL_INVALID_INPUT',
      'Choose one action: --initialize, --route (JSON stdin), --discover QUERY, --load ID, --resources ID or --resource ID --path MEMBER.',
    );
  if (
    (values.path && !values.resource) ||
    ((values.version || values.digest || values.offset) &&
      !values.load &&
      !values.resources &&
      !values.resource) ||
    (values.limit && !values.discover && !values.resources) ||
    (values.resource && !values.path)
  )
    throw new AgentMindError(
      'RETRIEVAL_INVALID_INPUT',
      'Selector does not apply to the selected retrieval action.',
    );
  const n = (s: string | undefined) =>
    s !== undefined ? Number(/^\d+$/.test(s) ? s : 'NaN') : undefined;
  const config = Object.fromEntries(
    [
      ['description_chars', n(values['description-chars'])],
      ['discovery_bytes', n(values['search-bytes'])],
      ['content_bytes', n(values['content-bytes'])],
    ].filter(([, v]) => v !== undefined),
  );
  let op = 'skill_load';
  let input: unknown = {};
  if (values.route) {
    if (values.limit || values.offset || values.path || values.digest || values.version)
      throw new AgentMindError(
        'RETRIEVAL_INVALID_INPUT',
        'Routing selectors belong in bounded JSON on stdin.',
      );
    const bytes = Buffer.alloc(2049);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(0, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > 2048)
      throw new AgentMindError('RETRIEVAL_INVALID_INPUT', 'Routing request exceeds 2048 bytes.');
    try {
      input = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } catch {
      throw new AgentMindError(
        'RETRIEVAL_INVALID_INPUT',
        'Routing requires a JSON request on stdin.',
      );
    }
    op = 'skill_route';
  } else if (values.discover) {
    op = 'skill_discover';
    input = { query: values.discover, ...(values.limit ? { limit: n(values.limit) } : {}) };
  } else if (!values.initialize) {
    op = values.resources
      ? 'skill_resources'
      : values.resource
        ? 'skill_resource_get'
        : 'skill_load';
    input = {
      skill_id: values.load ?? values.resources ?? values.resource,
      ...(values.path ? { path: values.path } : {}),
      ...(values.version ? { expected_version_id: values.version } : {}),
      ...(values.digest ? { expected_digest: values.digest } : {}),
      ...(values.offset ? { offset: n(values.offset) } : {}),
      ...(values.limit ? { limit: n(values.limit) } : {}),
    };
  }
  let result: unknown;
  if (values['client-config']) {
    if (
      values.initialize ||
      Object.keys(config).length ||
      !values.project ||
      [values.db, values['project-root'], values['project-key']].some((v) => v !== undefined)
    )
      throw new AgentMindError(
        'RETRIEVAL_INVALID_INPUT',
        'Broker read mode requires a configured project alias and forbids registry/index/policy overrides.',
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
        'RETRIEVAL_INVALID_INPUT',
        'A project alias requires broker configuration.',
      );
    const args: string[] = [];
    for (const k of ['project-root', 'project-key', 'db'] as const)
      if (values[k]) args.push(`--${k}`, values[k]);
    const c = readConfig(args),
      db = values.initialize ? openUsageDatabase(c.dbPath) : openDatabaseReadOnly(c.dbPath);
    try {
      if (values.initialize) {
        migrateRetrieval(db);
        result = {
          initialized: true,
          core_schema_version: 9,
          source_of_truth: 'Existing immutable registry; derived metadata index only.',
        };
      } else {
        const s = new SkillRetrievalService(db, c.project, config);
        result =
          op === 'skill_route'
            ? s.route(input)
            : op === 'skill_discover'
              ? s.discover(input)
              : op === 'skill_resources'
                ? s.resources(input)
                : op === 'skill_resource_get'
                  ? s.resource(input)
                  : s.load(input);
      }
    } finally {
      db.close();
    }
  }
  process.stdout.write(`${reviewText(result, !values.json)}\n`);
}
main().catch((e) => {
  const f = safeError(e);
  console.error(`[agentmind] ${f.code}: ${f.message}`);
  process.exitCode = 1;
});
