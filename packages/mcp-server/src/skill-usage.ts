#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  confirmOperatorReview,
  openDatabase,
  openDatabaseReadOnly,
  SkillUsageService,
  safeError,
  usageCapabilities,
} from '@agentmind/core';
import { readConfig } from './config.js';

async function input() {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 8192)
      throw new AgentMindError('INVALID_USAGE_INPUT', 'Telemetry input exceeds 8192 bytes.');
    parts.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    throw new AgentMindError('INVALID_USAGE_INPUT', 'Expected one JSON telemetry object on stdin.');
  }
}
async function main() {
  process.umask(0o077);
  const { values: v } = parseArgs({
    options: {
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      'source-agent': { type: 'string' },
      'disable-telemetry': { type: 'boolean' },
      query: { type: 'boolean' },
      summary: { type: 'boolean' },
      capabilities: { type: 'boolean' },
      'collect-installations': { type: 'boolean' },
      'confirm-outcome': { type: 'string' },
      check: { type: 'boolean' },
      prune: { type: 'boolean' },
      'retention-days': { type: 'string' },
      'skill-id': { type: 'string' },
      'version-id': { type: 'string' },
      agent: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      after: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const actions = [
    'query',
    'summary',
    'capabilities',
    'collect-installations',
    'confirm-outcome',
    'check',
    'prune',
  ].filter((k) => v[k as keyof typeof v] !== undefined);
  if (actions.length !== 1)
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Choose one telemetry query, summary, capabilities, collect-installations, confirm-outcome FILE, check or prune action.',
    );
  if (v.capabilities) {
    console.log(JSON.stringify(usageCapabilities));
    return;
  }
  const args: string[] = [];
  for (const k of [
    'project-root',
    'project-key',
    'db',
    'source-agent',
    'disable-telemetry',
  ] as const)
    if (v[k] !== undefined)
      args.push(`--${k}`, ...(typeof v[k] === 'string' ? [v[k] as string] : []));
  const config = readConfig(args);
  const db =
    v.query || v.summary ? openDatabaseReadOnly(config.dbPath) : openDatabase(config.dbPath);
  try {
    const service = new SkillUsageService(
      db,
      config.project,
      config.sourceAgent,
      config.telemetryEnabled,
    );
    let result: unknown;
    if (v.query || v.summary) {
      const filters = {
        ...(v['skill-id'] ? { skill_id: v['skill-id'] } : {}),
        ...(v['version-id'] ? { version_id: v['version-id'] } : {}),
        ...(v.agent ? { source_cli: v.agent } : {}),
        ...(v.since ? { since: v.since } : {}),
        ...(v.until ? { until: v.until } : {}),
      };
      result = v.query
        ? service.query({
            ...filters,
            ...(v.limit ? { limit: Number(v.limit) } : {}),
            ...(v.offset ? { offset: Number(v.offset) } : {}),
          })
        : service.summary(filters);
    } else if (v['collect-installations'])
      result = service.collectInstallations({
        ...(v.limit ? { limit: Number(v.limit) } : {}),
        ...(v.after ? { after: v.after } : {}),
      });
    else if (v.check) result = service.runCheck(await input());
    else if (v.prune) {
      const policy = { days: Number(v['retention-days']) };
      const preview = service.prepareRetention(policy);
      result = service.prune(policy, await confirmOperatorReview(preview));
    } else {
      // A file permits input inspection while keeping stdin attached to the operator's terminal.
      const { readFileSync, statSync } = await import('node:fs');
      const file = v['confirm-outcome'] ?? '';
      if (statSync(file).size > 8192)
        throw new AgentMindError('INVALID_USAGE_INPUT', 'Outcome file is too large.');
      const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const preview = service.prepareOutcome(data);
      result = service.confirmOutcome(data, await confirmOperatorReview(preview));
    }
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}
main().catch((e) => {
  const error = safeError(e);
  console.error(`[agentmind] ${error.code}: ${error.message}`);
  process.exitCode = 1;
});
