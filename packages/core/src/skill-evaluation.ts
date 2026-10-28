import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { collectSandboxRefusal, prepareSandboxPlan } from './behavioral/assurance.js';
import {
  BEHAVIORAL_POLICY,
  behavioralDigest,
  DEFAULT_BEHAVIORAL_SUITE,
  disabledBehavioralExecution,
  resolveBehavioralSuite,
} from './behavioral/model.js';
import {
  migrateBehavioral,
  persistBehavioralEvidence,
  readBehavioralEvidence,
} from './behavioral/storage.js';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import {
  aggregateEvaluation,
  compareStaticRegression,
  evaluateStaticContract,
  SKILL_EVALUATOR,
  SKILL_EVALUATOR_VERSION,
} from './skill-evaluation-engine.js';
import { hashSkillFiles, skillEvaluationSchema, skillFilesSchema } from './skill-model.js';
import { SkillStore } from './skill-store.js';
import { nextTimestamp } from './timestamp.js';

export const skillEvaluateSchema = z
  .strictObject({
    version_id: z.uuid(),
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_plan_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    expected_state_revision: z.number().int().nonnegative(),
    mode: z.enum(['static', 'behavioral']).default('static'),
    suite_id: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,99}$/)
      .optional(),
    suite_version: z.number().int().positive().optional(),
    expected_suite_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (
      (p.mode !== 'behavioral' &&
        (p.expected_plan_digest !== undefined ||
          p.suite_id !== undefined ||
          p.suite_version !== undefined ||
          p.expected_suite_digest !== undefined)) ||
      (p.suite_id === undefined) !== (p.suite_version === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Suite selection is behavioral-only and requires ID plus version.',
      });
  });
export const skillEvaluationGetSchema = z.strictObject({ evaluation_id: z.uuid() });
export const skillEvaluationListSchema = z.strictObject({
  version_id: z.uuid(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});

/** Local deterministic writer. No approval/promotion, code execution, or sandbox claim. */
export class SkillEvaluationService {
  readonly #project: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    project: ProjectScope,
  ) {
    this.#project = Object.freeze({ ...project });
  }

  /** Read-only plan: no migration, evaluation writes, candidate staging or execution. */
  plan(input: unknown) {
    const request = skillEvaluateSchema.parse(input);
    if (request.mode !== 'behavioral')
      throw new AgentMindError('INVALID_INPUT', 'Planning requires behavioral mode.');
    return this.db.transaction(() => {
      this.assertIntegrity(request.version_id);
      const snapshot = new SkillStore(this.db, this.#project).get({
        version_id: request.version_id,
      });
      if (
        snapshot.state.status !== 'candidate' ||
        snapshot.state.revision !== request.expected_state_revision ||
        snapshot.version.content_hash !== request.expected_content_hash
      )
        throw new AgentMindError(
          'STALE_SKILL_STATE',
          'Candidate identity, digest or revision changed.',
        );
      if (snapshot.identity.active_version_id)
        this.assertIntegrity(snapshot.identity.active_version_id);
      const plan = prepareSandboxPlan({
        version: snapshot.version,
        name: snapshot.identity.name,
        state_revision: snapshot.state.revision,
        identity_revision: snapshot.identity.revision,
        baseline_version_id: snapshot.identity.active_version_id,
        selector: {
          suite_id: request.suite_id ?? DEFAULT_BEHAVIORAL_SUITE,
          suite_version: request.suite_version ?? 1,
          ...(request.expected_suite_digest ? { suite_digest: request.expected_suite_digest } : {}),
        },
      });
      return {
        plan,
        plan_digest: behavioralDigest(plan),
        execution_supported: false,
        untrusted_data: true,
      };
    })();
  }

  evaluate(input: unknown) {
    const parsed = skillEvaluateSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Expected a version UUID, content hash, state revision and supported evaluation mode.',
      );
    const request = parsed.data;
    return this.db
      .transaction(() => {
        this.assertIntegrity(request.version_id);
        const store = new SkillStore(this.db, this.#project);
        const snapshot = store.get({ version_id: request.version_id });
        if (snapshot.state.status !== 'candidate')
          throw new AgentMindError(
            'INVALID_SKILL_STATE',
            'Only candidate versions can be evaluated.',
          );
        if (snapshot.version.content_hash !== request.expected_content_hash)
          throw new AgentMindError(
            'STALE_SKILL_CONTENT',
            'Expected content hash does not match the stored version.',
          );
        if (snapshot.state.revision !== request.expected_state_revision)
          throw new AgentMindError(
            'STALE_SKILL_STATE',
            'Skill state changed; inspect it before evaluating again.',
          );
        const baselineId = snapshot.identity.active_version_id;
        if (baselineId) this.assertIntegrity(baselineId);
        const baseline = baselineId ? store.get({ version_id: baselineId }) : null;
        const bundle = { ...snapshot.version, name: snapshot.identity.name };
        const checks = evaluateStaticContract(bundle);
        checks.push({
          name: 'content.integrity',
          result: 'PASS',
          details: 'Canonical SHA-256 matches stored and expected version hashes.',
        });
        const revoked = this.db
          .prepare(`SELECT COUNT(*) AS n FROM skill_version_sources s
        JOIN experiences e ON e.id = s.experience_id AND e.project_id = s.project_id
        WHERE s.version_id = ? AND s.project_id = ? AND e.approval_status != 'approved'`)
          .get(request.version_id, this.#project.id) as { n: number };
        checks.push({
          name: 'sources.current-approval',
          result: revoked.n ? 'FAIL' : 'PASS',
          details:
            'Checks current source approval only; evidence references are not executed or independently verified.',
        });
        const selector = {
          suite_id: request.suite_id ?? DEFAULT_BEHAVIORAL_SUITE,
          suite_version: request.suite_version ?? 1,
          ...(request.expected_suite_digest ? { suite_digest: request.expected_suite_digest } : {}),
        };
        const sandboxPlan = request.mode === 'behavioral' ? this.plan(request) : null;
        const selected = request.mode === 'behavioral' ? resolveBehavioralSuite(selector) : null;
        const regression =
          request.mode === 'behavioral'
            ? {
                name: 'regression.active-baseline',
                result: 'NOT_VERIFIED' as const,
                details:
                  'Paired observed execution is required; changed Markdown is not a demonstrated behavioral regression.',
              }
            : compareStaticRegression(
                bundle,
                baseline ? { ...baseline.version, name: baseline.identity.name } : null,
              );
        checks.push(regression);
        checks.push({
          name: 'baseline.snapshot',
          result: 'PASS',
          details: JSON.stringify({
            version_id: baselineId,
            content_hash: baseline?.version.content_hash ?? null,
            identity_revision: snapshot.identity.revision,
          }),
        });
        if (sandboxPlan) {
          if (
            request.expected_plan_digest &&
            request.expected_plan_digest !== sandboxPlan.plan_digest
          )
            throw new AgentMindError(
              'STALE_EVALUATION_PLAN',
              'Candidate, suite, policy or environment changed; prepare a fresh plan.',
            );
          migrateBehavioral(this.db);
          checks.push({
            name: 'sandbox.plan',
            result: 'NOT_VERIFIED',
            details: sandboxPlan.plan_digest,
          });
          checks.push(
            {
              name: 'suite.trusted',
              result: selected ? 'PASS' : 'NOT_VERIFIED',
              details: selected
                ? `Release-owned suite ${selected.definition.id}@${selected.definition.version}; SHA-256 ${selected.digest}. Contract only, not accepted execution.`
                : 'Requested suite/version is unsupported.',
            },
            {
              name: 'execution.behavioral',
              result: 'NOT_VERIFIED',
              details:
                'No accepted isolation backend. No scripts, subprocesses, network or host task execution occurred.',
            },
            {
              name: 'execution.baseline',
              result: 'NOT_VERIFIED',
              details: baseline
                ? 'Active baseline snapshot retained; no execution observation exists.'
                : 'No active baseline is available for a mandatory paired comparison.',
            },
          );
        }
        const report = skillEvaluationSchema.parse({
          id: randomUUID(),
          version_id: snapshot.version.id,
          skill_id: snapshot.identity.id,
          project_id: this.#project.id,
          evaluator: SKILL_EVALUATOR,
          evaluator_version:
            request.mode === 'behavioral' ? BEHAVIORAL_POLICY : SKILL_EVALUATOR_VERSION,
          result: aggregateEvaluation(checks),
          checks,
          baseline_version_id: baselineId,
          regression_result: baselineId ? regression.result : 'NOT_VERIFIED',
          content_hash: snapshot.version.content_hash,
          created_at: nextTimestamp(
            [snapshot.state.updated_at, snapshot.identity.updated_at].sort().at(-1),
          ),
        });
        this.db
          .prepare(`INSERT INTO skill_evaluations (id, version_id, skill_id, project_id, evaluator, evaluator_version, result,
        checks_json, baseline_version_id, regression_result, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            report.id,
            report.version_id,
            report.skill_id,
            report.project_id,
            report.evaluator,
            report.evaluator_version,
            report.result,
            JSON.stringify(report.checks),
            report.baseline_version_id,
            report.regression_result,
            report.content_hash,
            report.created_at,
          );
        if (sandboxPlan)
          persistBehavioralEvidence(this.db, report, {
            schema_version: 1,
            policy_version: BEHAVIORAL_POLICY,
            project_id: this.#project.id,
            evaluation_id: report.id,
            candidate: { version_id: snapshot.version.id, digest: snapshot.version.content_hash },
            baseline: baseline
              ? {
                  version_id: baseline.version.id,
                  digest: baseline.version.content_hash,
                  identity_revision: snapshot.identity.revision,
                }
              : null,
            selector,
            suite: selected
              ? {
                  id: selected.definition.id,
                  version: selected.definition.version,
                  digest: selected.digest,
                }
              : null,
            execution: disabledBehavioralExecution(),
            comparison_result: 'NOT_VERIFIED',
            evaluation_digest: behavioralDigest(report),
            assurance: collectSandboxRefusal(sandboxPlan.plan, report.id),
          });
        return this.getReport({ evaluation_id: report.id });
      })
      .immediate();
  }

  getReport(input: unknown) {
    const parsed = skillEvaluationGetSchema.safeParse(input);
    if (!parsed.success) throw new AgentMindError('INVALID_INPUT', 'Expected an evaluation UUID.');
    const row = this.db
      .prepare('SELECT * FROM skill_evaluations WHERE id = ? AND project_id = ?')
      .get(parsed.data.evaluation_id, this.#project.id) as { checks_json: string } | undefined;
    if (!row)
      throw new AgentMindError(
        'SKILL_EVALUATION_NOT_FOUND',
        'Evaluation report is not available in this project.',
      );
    const { checks_json, ...fields } = row;
    const evaluation = skillEvaluationSchema.parse({ ...fields, checks: JSON.parse(checks_json) });
    return {
      evaluation,
      ...(evaluation.evaluator_version === BEHAVIORAL_POLICY
        ? { behavioral: readBehavioralEvidence(this.db, this.#project, evaluation) }
        : {}),
      capabilities: {
        execution_supported: false,
        process_isolation_supported: false,
        task_success: 'NOT_VERIFIED' as const,
      },
      untrusted_data: true as const,
    };
  }

  listReports(input: unknown) {
    const parsed = skillEvaluationListSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Expected a version UUID and bounded pagination.');
    const request = parsed.data;
    return this.db.transaction(() => {
      new SkillStore(this.db, this.#project).getVersion(request.version_id);
      const rows = this.db
        .prepare(
          'SELECT id FROM skill_evaluations WHERE version_id = ? AND project_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?',
        )
        .all(request.version_id, this.#project.id, request.limit + 1, request.offset) as {
        id: string;
      }[];
      const more = rows.length > request.limit;
      return {
        reports: rows
          .slice(0, request.limit)
          .map((row) => this.getReport({ evaluation_id: row.id })),
        next_offset:
          more && request.offset + request.limit <= 10000 ? request.offset + request.limit : null,
        truncated: more,
        untrusted_data: true as const,
      };
    })();
  }

  private assertIntegrity(versionId: string) {
    const row = this.db
      .prepare(
        'SELECT files_json, content_hash FROM skill_versions WHERE id = ? AND project_id = ?',
      )
      .get(versionId, this.#project.id) as { files_json: string; content_hash: string } | undefined;
    if (!row)
      throw new AgentMindError('SKILL_NOT_FOUND', 'Skill record is not available in this project.');
    try {
      const files = skillFilesSchema.parse(JSON.parse(row.files_json));
      if (hashSkillFiles(files) !== row.content_hash) throw new Error('hash mismatch');
    } catch {
      throw new AgentMindError(
        'SKILL_INTEGRITY_ERROR',
        'Stored snapshot integrity check failed; no evaluation was recorded.',
      );
    }
  }
}
