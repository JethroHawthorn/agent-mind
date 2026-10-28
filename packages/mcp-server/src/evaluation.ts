import { parseArgs } from 'node:util';
import {
  AgentMindError,
  behavioralSandboxStatus,
  openDatabaseReadOnly,
  openUsageDatabase,
  SkillEvaluationService,
} from '@agentmind/core';
import { readConfig } from './config.js';
import { diagnosticText } from './installer/files.js';
export const evaluationHelp = `AgentMind behavioral evaluation — no accepted execution backend
 agentmind evaluation status|doctor [--json]
 agentmind evaluation plan VERSION --digest SHA256 --revision N [scope options]
 agentmind evaluation run VERSION --digest SHA256 --revision N --plan-digest SHA256 [scope options]
 agentmind evaluation show|evidence EVALUATION_ID [scope options]
 --project-root PATH --db PATH --project-key KEY   Established project authorization
 --suite-id ID --suite-version N --suite-digest SHA256  Release-owned suite only
 --json  Safe JSON; status/doctor never invoke a backend, model or initialize SQLite.
Plan is read-only. Run explicitly records a NOT_VERIFIED refusal; it cannot run host code.
No commands, image paths, mounts, network overrides or result submissions are accepted.
Exit 0 read success, 2 NOT_VERIFIED; existing unified codes: 3 stale/scope conflict, 4 arguments, 6 permission, 1 other failure. Evaluation is never approval.`;
export function runEvaluationCLI(args: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'project-root': { type: 'string' },
      'project-key': { type: 'string' },
      db: { type: 'string' },
      digest: { type: 'string' },
      revision: { type: 'string' },
      'plan-digest': { type: 'string' },
      'suite-id': { type: 'string' },
      'suite-version': { type: 'string' },
      'suite-digest': { type: 'string' },
    },
  });
  if (v.help) {
    process.stdout.write(`${evaluationHelp}\n`);
    return;
  }
  const action = p[0];
  if (!action || !['status', 'doctor', 'plan', 'run', 'show', 'evidence'].includes(action))
    throw new AgentMindError('INVALID_INPUT', 'Use evaluation --help.');
  let result: unknown;
  if (action === 'status' || action === 'doctor') {
    if (p.length !== 1 || Object.keys(v).some((k) => k !== 'json'))
      throw new AgentMindError('INVALID_INPUT', 'Status/doctor accept only --json.');
    result = behavioralSandboxStatus();
    process.exitCode = 2;
  } else {
    if (p.length !== 2)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Supply one complete candidate or evaluation UUID.',
      );
    const writing = action === 'run',
      planning = action === 'plan';
    if (
      (!writing && v['plan-digest']) ||
      (!writing &&
        !planning &&
        [v.digest, v.revision, v['suite-id'], v['suite-version'], v['suite-digest']].some(
          (x) => x !== undefined,
        ))
    )
      throw new AgentMindError('INVALID_INPUT', 'Evaluation flags are action specific.');
    if (writing && !v['plan-digest'])
      throw new AgentMindError(
        'INVALID_INPUT',
        'Run requires an exact --plan-digest from a fresh plan.',
      );
    const scopeArgs: string[] = [];
    for (const key of ['project-root', 'project-key', 'db'] as const)
      if (v[key]) scopeArgs.push(`--${key}`, v[key]);
    const config = readConfig(scopeArgs);
    const db = writing ? openUsageDatabase(config.dbPath) : openDatabaseReadOnly(config.dbPath);
    try {
      const service = new SkillEvaluationService(db, config.project);
      if (planning || writing) {
        if (!v.revision || !/^(0|[1-9][0-9]*)$/.test(v.revision))
          throw new AgentMindError('INVALID_INPUT', 'Supply --revision integer and --digest.');
        const input = {
          version_id: p[1],
          expected_content_hash: v.digest,
          expected_state_revision: Number(v.revision),
          mode: 'behavioral',
          ...(v['plan-digest'] ? { expected_plan_digest: v['plan-digest'] } : {}),
          ...(v['suite-id'] ? { suite_id: v['suite-id'] } : {}),
          ...(v['suite-version'] ? { suite_version: Number(v['suite-version']) } : {}),
          ...(v['suite-digest'] ? { expected_suite_digest: v['suite-digest'] } : {}),
        };
        result = writing ? service.evaluate(input) : service.plan(input);
        process.exitCode = 2;
      } else result = service.getReport({ evaluation_id: p[1] });
    } finally {
      db.close();
    }
  }
  process.stdout.write(`${diagnosticText(result, !v.json)}\n`);
}
