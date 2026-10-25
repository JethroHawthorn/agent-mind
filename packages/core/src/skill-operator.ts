import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import { consumeOperatorGrant, reviewDigest } from './operator-confirmation.js';
import { assertSafeSummary } from './privacy.js';
import type { ProjectScope } from './project.js';
import {
  aggregateEvaluation,
  compareStaticRegression,
  evaluateStaticContract,
  SKILL_EVALUATOR,
  SKILL_EVALUATOR_VERSION,
} from './skill-evaluation-engine.js';
import { SkillReviewService } from './skill-review.js';
import { nextTimestamp } from './timestamp.js';

export const skillOperatorActionSchema = z.strictObject({
  action: z.enum(['approve', 'reject', 'promote', 'rollback', 'deactivate']),
  version_id: z.uuid(),
  reason: z.string().trim().min(1).max(2000).default('Explicit local operator confirmation.'),
});
type Review = ReturnType<SkillReviewService['review']>;

export class SkillOperatorService {
  readonly #scope: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
  ) {
    this.#scope = Object.freeze({ ...scope });
  }
  prepare(input: unknown) {
    const p = skillOperatorActionSchema.safeParse(input);
    if (!p.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Expected a supported action, exact version UUID and optional non-secret reason.',
      );
    assertSafeSummary(p.data.reason);
    return this.db.transaction(() => {
      const review = new SkillReviewService(this.db, this.#scope).review({
        version_id: p.data.version_id,
      });
      this.eligible(p.data.action, review);
      return {
        action: p.data.action,
        reason: p.data.reason,
        review,
        transition: {
          from_version_id: review.identity.active_version_id,
          to_version_id:
            p.data.action === 'deactivate'
              ? null
              : p.data.action === 'promote' || p.data.action === 'rollback'
                ? review.version.id
                : review.identity.active_version_id,
          warning:
            p.data.action === 'deactivate'
              ? 'Explicit activation gap: the registry will have no active version. Installed CLI copies are not synchronized.'
              : 'Registry-only action. Approval/rejection does not activate a version; installed CLI copies are not synchronized.',
        },
      };
    })();
  }
  commit(input: unknown, grant: unknown) {
    // Consume a genuine grant before inspecting attacker-selected fields/state.
    // Fresh state is compared inside the same write transaction as history/audit updates.
    return this.db
      .transaction(() => {
        const preview = this.prepare(input);
        const authorization = consumeOperatorGrant(grant, reviewDigest(preview));
        const { action, reason, review: r } = preview;
        if (
          (action === 'promote' || action === 'rollback') &&
          r.identity.active_version_id === r.version.id
        )
          return {
            status: 'already_active',
            active_version_id: r.version.id,
            untrusted_data: true as const,
          };
        if (action === 'approve' && r.state.status === 'approved')
          return {
            status: 'already_approved',
            approval_id: r.state.review_id,
            untrusted_data: true as const,
          };
        const id = randomUUID();
        const at = nextTimestamp(
          [
            r.identity.updated_at,
            r.state.updated_at,
            ...r.sources_current.map((s) => (s as { updated_at: string }).updated_at),
          ]
            .sort()
            .at(-1),
        );
        const reviewAction = action === 'approve' || action === 'reject';
        if (reviewAction) {
          this.db
            .prepare(`INSERT INTO skill_reviews (id,version_id,skill_id,project_id,decision,evaluation_id,reviewer,reason,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(
              id,
              r.version.id,
              r.identity.id,
              this.#scope.id,
              action === 'approve' ? 'approved' : 'rejected',
              r.state.latest_evaluation_id,
              authorization.operator,
              reason,
              at,
            );
        } else {
          this.db
            .prepare(`INSERT INTO skill_promotions (id,skill_id,project_id,from_version_id,to_version_id,approval_id,action,expected_revision,actor,reason,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(
              id,
              r.identity.id,
              this.#scope.id,
              r.identity.active_version_id,
              action === 'deactivate' ? null : r.version.id,
              action === 'deactivate' ? null : r.state.review_id,
              action,
              r.identity.revision,
              authorization.operator,
              reason,
              at,
            );
        }
        this.db
          .prepare(`INSERT INTO skill_operator_events
        (id,skill_id,project_id,version_id,content_hash,evaluation_id,evaluator_version,action,review_id,promotion_id,operator_id,session_id,authorization_method,context_digest,reason,created_at,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            randomUUID(),
            r.identity.id,
            this.#scope.id,
            r.version.id,
            r.version.content_hash,
            r.state.latest_evaluation_id,
            r.evaluation?.evaluator_version ?? null,
            action,
            reviewAction ? id : null,
            reviewAction ? null : id,
            authorization.operator,
            authorization.session,
            'local-tty-confirmation-v1',
            reviewDigest(preview),
            reason,
            at,
            JSON.stringify({
              same_uid_boundary: false,
              confirmation_version: 1,
              ...(authorization.broker_peer
                ? { broker_peer: authorization.broker_peer, boundary: 'os-peer-v1' }
                : {}),
              from_version_id: preview.transition.from_version_id,
              to_version_id: preview.transition.to_version_id,
            }),
          );
        return {
          status: 'applied',
          action,
          history_id: id,
          version_id: r.version.id,
          active_version_id:
            action === 'promote' || action === 'rollback'
              ? r.version.id
              : action === 'deactivate'
                ? null
                : r.identity.active_version_id,
          untrusted_data: true as const,
        };
      })
      .immediate();
  }
  private eligible(action: string, r: Review) {
    if (action === 'deactivate') {
      if (r.identity.active_version_id !== r.version.id)
        throw new AgentMindError(
          'INVALID_SKILL_STATE',
          'Deactivation must name the currently active exact version.',
        );
      return;
    }
    if (action === 'reject') {
      if (r.state.status === 'rejected' || r.identity.active_version_id === r.version.id)
        throw new AgentMindError(
          'INVALID_SKILL_STATE',
          'Rejected versions are terminal; an active version must be explicitly deactivated before rejection.',
        );
      return;
    }
    if (r.state.status === 'rejected')
      throw new AgentMindError(
        'INVALID_SKILL_STATE',
        'Rejected versions cannot be approved or activated.',
      );
    const already = r.identity.active_version_id === r.version.id;
    if (action === 'approve') {
      if (r.state.status === 'candidate' && r.version.version !== r.latest_version)
        throw new AgentMindError(
          'SUPERSEDED_CANDIDATE',
          'Only the latest candidate version can receive a new approval.',
        );
    } else if (r.state.status !== 'approved')
      throw new AgentMindError(
        'APPROVAL_REQUIRED',
        'Only an operator-approved version can be activated.',
      );
    this.evidence(
      r,
      action === 'rollback' || already || (r.state.status === 'approved' && action === 'approve'),
    );
    if (r.state.status === 'approved') {
      const audit = this.db
        .prepare(`SELECT id FROM skill_operator_events WHERE project_id=? AND version_id=? AND action='approve'
        AND review_id=? AND evaluation_id=? AND content_hash=? AND evaluator_version=? AND authorization_method='local-tty-confirmation-v1'`)
        .get(
          this.#scope.id,
          r.version.id,
          r.state.review_id,
          r.evaluation?.id,
          r.version.content_hash,
          SKILL_EVALUATOR_VERSION,
        );
      if (!audit)
        throw new AgentMindError(
          'OPERATOR_APPROVAL_REQUIRED',
          'Legacy or unmatched approval lacks operator confirmation provenance.',
        );
    }
    if (action === 'rollback') {
      const prior = this.db
        .prepare(
          `SELECT id FROM skill_promotions WHERE skill_id=? AND project_id=? AND to_version_id=? LIMIT 1`,
        )
        .get(r.identity.id, this.#scope.id, r.version.id);
      if (!prior)
        throw new AgentMindError(
          'ROLLBACK_NOT_ELIGIBLE',
          'Rollback target must have been active previously and remain approved.',
        );
    }
  }
  private evidence(r: Review, historical: boolean) {
    const e = r.evaluation;
    if (
      !e ||
      e.id !== r.state.latest_evaluation_id ||
      e.version_id !== r.version.id ||
      e.content_hash !== r.version.content_hash ||
      e.result !== 'PASS' ||
      e.evaluator !== SKILL_EVALUATOR ||
      e.evaluator_version !== SKILL_EVALUATOR_VERSION ||
      e.checks.some((c) => c.result !== 'PASS')
    )
      throw new AgentMindError(
        'EVALUATION_NOT_ELIGIBLE',
        'A complete PASS from the current accepted evaluator is required; FAIL, NOT_VERIFIED and unknown policies cannot be waived.',
      );
    if (!historical && e.baseline_version_id !== r.identity.active_version_id)
      throw new AgentMindError(
        'STALE_EVALUATION',
        'Evaluation baseline changed; reevaluate before approval or promotion.',
      );
    if (
      r.sources_current.length !== r.sources.length ||
      r.sources_current.some(
        (s) => (s as { approval_status: string }).approval_status !== 'approved',
      )
    )
      throw new AgentMindError(
        'SOURCE_NOT_APPROVED',
        'Every source must still be approved in this project.',
      );
    const expected = evaluateStaticContract({ ...r.version, name: r.identity.name });
    if (aggregateEvaluation(expected) !== 'PASS')
      throw new AgentMindError(
        'EVALUATION_NOT_ELIGIBLE',
        'Current content validation or static contract failed.',
      );
    const originalBaseline = e.baseline_version_id
      ? new SkillReviewService(this.db, this.#scope).review({ version_id: e.baseline_version_id })
      : null;
    const regression = compareStaticRegression(
      { ...r.version, name: r.identity.name },
      originalBaseline
        ? { ...originalBaseline.version, name: originalBaseline.identity.name }
        : null,
    );
    if (
      regression.result !== 'PASS' ||
      e.regression_result !== (e.baseline_version_id ? 'PASS' : 'NOT_VERIFIED')
    )
      throw new AgentMindError(
        'EVALUATION_NOT_ELIGIBLE',
        'Regression evidence does not match the evaluated artifact.',
      );
    const checkNames = [
      ...expected.map((c) => c.name),
      'content.integrity',
      'sources.current-approval',
      'regression.active-baseline',
      'baseline.snapshot',
    ];
    if (
      e.checks.length !== checkNames.length ||
      new Set(e.checks.map((c) => c.name)).size !== checkNames.length ||
      checkNames.some((name) => !e.checks.some((c) => c.name === name))
    )
      throw new AgentMindError(
        'EVALUATION_NOT_ELIGIBLE',
        'Mandatory evaluation checks are missing or unsupported.',
      );
    for (const check of [...expected, regression]) {
      if (e.checks.find((c) => c.name === check.name)?.details !== check.details)
        throw new AgentMindError(
          'EVALUATION_NOT_ELIGIBLE',
          'Current evaluator evidence does not match the report.',
        );
    }
    const baseline = e.checks.find((c) => c.name === 'baseline.snapshot');
    try {
      const value = z
        .strictObject({
          version_id: z.uuid().nullable(),
          content_hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          identity_revision: z.number().int().nonnegative(),
        })
        .parse(JSON.parse(baseline?.details ?? ''));
      if (
        value.version_id !== e.baseline_version_id ||
        value.content_hash !== (originalBaseline?.version.content_hash ?? null) ||
        (!historical && value.identity_revision !== r.identity.revision)
      )
        throw new Error('stale');
    } catch {
      throw new AgentMindError(
        'EVALUATION_NOT_ELIGIBLE',
        'Baseline evidence is malformed, stale or corrupted.',
      );
    }
  }
}
