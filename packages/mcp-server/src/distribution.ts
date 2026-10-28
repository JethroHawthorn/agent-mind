import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  brokerRequest,
  loadBrokerClient,
  openDatabaseReadOnly,
  SkillDistributionService,
} from '@agentmind/core';
import { readConfig } from './config.js';
import { diagnosticText } from './installer/files.js';
export const distributionHelp = `AgentMind distribution — read-only inspection; no lifecycle authorization
 agentmind distribution status|plan|verify SKILL_UUID [options]
 agentmind distribution history SKILL_UUID [--limit 1..50 --offset N]
 agentmind distribution recover|rollback SKILL_UUID --dry-run [options]
 --target codex|claude|all  Default all; Gemini uses Router + authorized MCP retrieval
 --scope project|user     Default project; user installs expose skills across local projects
 --project-root PATH --project-key KEY --db PATH --home-root PATH
 --client-config PATH --project NAME  Operator-only authenticated broker reads; no direct DB
 --json                   Safe JSON only; no scripts, file copy, migrations or writes
Recovery planning never consumes a grant or resumes work. Reuse the trusted existing
skill-distribute.js confirmation/broker workflow for mutations. Rollback remains a
separate trusted skill lifecycle decision, followed by a fresh distribution plan.
Registry activation, MCP retrieval publication and native copies are distinct.
Protected OS deployment and behavioral execution remain NOT_VERIFIED.
`;
export async function runDistributionCLI(args: string[]) {
  const { values: v, positionals: p } = (() => {
    try {
      return parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          json: { type: 'boolean' },
          'dry-run': { type: 'boolean' },
          target: { type: 'string', default: 'all' },
          scope: { type: 'string', default: 'project' },
          'project-root': { type: 'string' },
          'project-key': { type: 'string' },
          db: { type: 'string' },
          'home-root': { type: 'string' },
          'client-config': { type: 'string' },
          project: { type: 'string' },
          limit: { type: 'string' },
          offset: { type: 'string' },
        },
      });
    } catch {
      throw new AgentMindError('INVALID_INPUT', 'Invalid distribution arguments; use --help.');
    }
  })();
  if (v.help) {
    process.stdout.write(`${distributionHelp}\n`);
    return;
  }
  const action = p[0];
  if (
    p.length !== 2 ||
    !['status', 'plan', 'verify', 'history', 'recover', 'rollback'].includes(action ?? '') ||
    (['recover', 'rollback'].includes(action ?? '') && !v['dry-run']) ||
    ((v.limit !== undefined || v.offset !== undefined) && action !== 'history')
  )
    throw new AgentMindError(
      'INVALID_INPUT',
      'Use distribution --help; recovery and rollback are planning only and require --dry-run.',
    );
  const integer = (value: string | undefined, min: number, max: number) => {
    if (value === undefined) return undefined;
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new AgentMindError('INVALID_INPUT', 'Expected bounded canonical integer pagination.');
    return Number(value);
  };
  const limit = integer(v.limit, 1, 50),
    offset = integer(v.offset, 0, 10000);
  const historyInput = {
    skill_id: p[1],
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
  if (v['client-config'] || v.project) {
    if (
      !v['client-config'] ||
      !v.project ||
      v.db ||
      v['project-root'] ||
      v['project-key'] ||
      v['home-root'] ||
      v.scope !== 'project'
    )
      throw new AgentMindError(
        'INVALID_INPUT',
        'Broker reads require --client-config and --project, without local database/root overrides.',
      );
    const result = await brokerRequest(loadBrokerClient(v['client-config']), 'operator', {
      schema_version: 1,
      project: v.project,
      op:
        action === 'history'
          ? 'distribution_history'
          : action === 'rollback'
            ? 'distribution_rollback_plan'
            : 'distribution_plan',
      input:
        action === 'history'
          ? historyInput
          : action === 'rollback'
            ? { skill_id: p[1] }
            : { skill_id: p[1], target: v.target, scope: 'project', operation: 'sync' },
    });
    if (
      result &&
      typeof result === 'object' &&
      'entries' in result &&
      Array.isArray(result.entries) &&
      result.entries.some(
        (e) => e && typeof e === 'object' && ['CONFLICT', 'REPAIR'].includes(e.action),
      )
    )
      process.exitCode = 3;
    process.stdout.write(`${diagnosticText(result, !v.json)}\n`);
    return;
  }
  const configArgs: string[] = [];
  for (const k of ['project-root', 'project-key', 'db'] as const)
    if (v[k]) configArgs.push(`--${k}`, v[k]);
  const config = readConfig(configArgs),
    db = openDatabaseReadOnly(config.dbPath);
  try {
    const service = new SkillDistributionService(db, config.project, v['home-root']);
    let result: unknown;
    if (action === 'history') result = service.history(historyInput);
    else if (action === 'rollback') result = service.rollbackPlan({ skill_id: p[1] });
    else {
      const plan = service.plan({
        skill_id: p[1],
        target: v.target,
        scope: v.scope,
        operation: 'sync',
      });
      result = {
        schema_version: 1,
        plan_digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
        action,
        project_id: config.project.id,
        skill_id: plan.registry.identity.id,
        active_version_id: plan.registry.identity.active_version_id,
        identity_revision: plan.registry.identity.revision,
        active_digest: plan.registry.artifact?.review.version.content_hash ?? null,
        registry_error: plan.registry.error,
        entries: plan.entries.map((e) => ({
          target: e.target,
          scope: e.scope,
          version_id: e.version_id,
          digest: e.content_digest,
          action: e.action,
          reason: e.reason,
          current_status: e.current_status,
          intent: e.pending ? { id: e.pending.id, status: e.pending.status } : null,
        })),
        dry_run: true,
        mutation_authorized: false,
        protected_deployment: 'NOT_VERIFIED',
        recovery_requires_fresh_operator_confirmation: true,
        ...(action === 'rollback'
          ? {
              guidance:
                'Select an exact eligible historical version in the existing trusted operator workflow. This plan does not authorize rollback or install a historical package.',
            }
          : {}),
        warning: plan.warning,
      };
      if (plan.entries.some((e) => e.action === 'CONFLICT' || e.action === 'REPAIR'))
        process.exitCode = 3;
    }
    process.stdout.write(`${diagnosticText(result, !v.json)}\n`);
  } finally {
    db.close();
  }
}
