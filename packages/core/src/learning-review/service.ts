import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type Database from 'better-sqlite3';
import { authoringDiffSchema } from '../authoring/model.js';
import { SkillAuthoringService } from '../authoring/service.js';
import { curatorDigest } from '../curator/model.js';
import { AgentMindError, safeError } from '../errors.js';
import { sanitizeExperienceText } from '../experience-privacy.js';
import { redactSecrets } from '../privacy.js';
import type { ProjectScope } from '../project.js';
import { SkillEvaluationService } from '../skill-evaluation.js';
import { SkillOperatorService } from '../skill-operator.js';
import { SkillStore } from '../skill-store.js';
import {
  parseReview,
  REVIEW_WARNING,
  reviewDecisionSchema,
  reviewGetSchema,
  reviewHandoffSchema,
} from './model.js';
import { redactReview } from './presentation.js';
import { LearningReviewQuery, type ReviewEvent } from './query.js';
import { migrateLearningReview, reviewStorageExists } from './storage.js';

/** Read-only transport-facing API. Decisions live in a separate operator-only service. */
export class LearningReviewService extends LearningReviewQuery {
  get(input: unknown) {
    const p = parseReview(reviewGetSchema, input);
    return this.db.transaction(() => {
      const s = this.snapshot(this.row(p.proposal_id));
      const authoring = new SkillAuthoringService(this.db, this.scope).get(p);
      const evidence = this.evidenceSnapshot(s);
      const installations = this.db
        .prepare(
          'SELECT id,version_id,target,scope,installed_digest,status,last_verified_at,updated_at FROM skill_installations WHERE project_id=? AND skill_id=? ORDER BY target,scope,id LIMIT 21',
        )
        .all(this.scope.id, s.row.skill_id);
      const history = reviewStorageExists(this.db)
        ? (this.db
            .prepare(
              'SELECT id,revision,decision,state,reason,actor_json,created_at,candidate_digest,snapshot_digest FROM learning_review_events WHERE project_id=? AND proposal_id=? ORDER BY revision DESC LIMIT 21',
            )
            .all(this.scope.id, s.row.id) as { actor_json: string }[])
        : [];
      const report = s.row.latest_evaluation_id
        ? new SkillEvaluationService(this.db, this.scope).getReport({
            evaluation_id: s.row.latest_evaluation_id,
          })
        : null;
      // Keep check details bounded without pretending that an omitted check is absent.
      const evaluation = report
        ? {
            ...authoring.evaluation,
            checks: report.evaluation.checks.slice(0, 12).map((c) => ({
              ...c,
              details: c.details.slice(0, 250),
              details_truncated: c.details.length > 250,
            })),
            checks_truncated: report.evaluation.checks.length > 12,
            behavioral_status: 'NOT_VERIFIED',
            execution_supported: report.capabilities.execution_supported,
            full_report_reference: report.evaluation.id,
          }
        : null;
      const operatorEvents = this.db
        .prepare(
          'SELECT id,action,review_id,promotion_id,content_hash,evaluation_id,authorization_method,created_at FROM skill_operator_events WHERE project_id=? AND version_id=? ORDER BY created_at DESC,id LIMIT 11',
        )
        .all(this.scope.id, s.row.candidate_id);
      const approvalProvenance = s.row.review_id
        ? (this.db
            .prepare(
              "SELECT id,authorization_method FROM skill_operator_events WHERE project_id=? AND version_id=? AND review_id=? AND action='approve' AND content_hash=?",
            )
            .get(this.scope.id, s.row.candidate_id, s.row.review_id, s.row.content_hash) ?? null)
        : null;
      const result = redactReview({
        ...this.summary(s),
        authoring: { ...authoring, evaluation, warning: undefined },
        evidence,
        lifecycle: {
          candidate_state: s.row.candidate_state,
          approval_id: s.row.review_id,
          approval_provenance: approvalProvenance,
          operator_events: operatorEvents.slice(0, 10),
          operator_events_truncated: operatorEvents.length > 10,
          active_version_id: s.row.active_version_id,
          is_active: s.row.active_version_id === s.row.candidate_id,
          superseded: s.row.version < s.row.latest_version,
          installations: installations.slice(0, 20),
          installations_truncated: installations.length > 20,
          installation_integrity:
            'Registry records only; current filesystem integrity is NOT VERIFIED by this read.',
        },
        history: history
          .slice(0, 20)
          .map(({ actor_json, ...e }) => ({ ...e, actor: JSON.parse(actor_json) })),
        history_truncated: history.length > 20,
        approval_handoff: this.eligibility(s, authoring.validation.validation_result),
        warning: REVIEW_WARNING,
        untrusted_data: true,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 65536)
        throw new AgentMindError(
          'REVIEW_RESPONSE_LIMIT',
          'Detail exceeds its budget; use scoped evidence and diff pages.',
        );
      return result;
    })();
  }
  evidence(input: unknown) {
    const p = parseReview(reviewGetSchema, input);
    return this.db.transaction(() => {
      const s = this.snapshot(this.row(p.proposal_id));
      return redactReview({
        proposal_id: s.row.id,
        snapshot_digest: s.snapshot_digest,
        ...this.evidenceSnapshot(s),
        warning: REVIEW_WARNING,
        untrusted_data: true,
      });
    })();
  }
  private evidenceSnapshot(s: ReturnType<LearningReviewQuery['snapshot']>) {
    return {
      signals: s.sources.signals.map((s) => ({
        id: s.id,
        available: s.available,
        status: s.signal?.status ?? null,
        revision: s.signal?.revision ?? null,
        title: s.signal?.title ?? null,
        summary: s.signal?.summary ?? null,
        origin: s.signal?.origin ?? null,
        evidence_trust: s.signal?.triage.evidence_trust ?? null,
        limitations: s.signal?.triage.limitations ?? [],
        references: s.signal?.supporting_evidence ?? [],
        task_success: 'NOT_VERIFIED',
      })),
      experiences: s.sources.experiences.map((e) => ({
        id: e.id,
        available: e.available,
        approval_status: e.record?.approval_status ?? null,
        problem: e.record?.problem.slice(0, 400) ?? null,
        solution: e.record?.solution.slice(0, 400) ?? null,
        summary_truncated:
          !!e.record && (e.record.problem.length > 400 || e.record.solution.length > 400),
        trust: 'Stored experience approval is local review, not verified task success.',
      })),
      references: s.sources.refs.map(({ source_digest, ...r }) => ({ ...r, source_digest })),
      recommendations: s.sources.recommendations,
      recommendations_truncated: s.sources.recommendations_truncated,
      limitations: [
        'Agent claims remain agent-reported. External evidence references are not fetched or executed.',
        'Recommendations and priority are heuristic. Static PASS is not behavioral verification.',
      ],
    };
  }
  diff(input: unknown) {
    const p = parseReview(authoringDiffSchema, input);
    return this.db.transaction(() => {
      const s = this.snapshot(this.row(p.proposal_id));
      const result = new SkillAuthoringService(this.db, this.scope).diff(p);
      if (!('next_offset' in result))
        return {
          ...result,
          snapshot_digest: s.snapshot_digest,
          complete: false,
          redacted: false,
          resource_format:
            'Text snapshots only; unsupported binary resources are not accepted by the skill validator.',
          warning: REVIEW_WARNING,
        };
      const store = new SkillStore(this.db, this.scope);
      const before = s.row.base_id
        ? (store.getVersion(s.row.base_id).version.files.find((f) => f.path === p.path)?.content ??
          null)
        : null;
      const after =
        store.getVersion(s.row.candidate_id).version.files.find((f) => f.path === p.path)
          ?.content ?? null;
      const safeBefore = before === null ? null : redactSecrets(before),
        safeAfter = after === null ? null : redactSecrets(after);
      const page = (text: string | null, original: typeof result.before) =>
        text === null
          ? null
          : {
              ...original,
              content: text.slice(p.offset, p.offset + p.limit),
              displayed_chars: text.length,
            };
      const next =
        Math.max(safeBefore?.length ?? 0, safeAfter?.length ?? 0) > p.offset + p.limit
          ? p.offset + p.limit
          : null;
      return {
        ...result,
        before: page(safeBefore, result.before),
        after: page(safeAfter, result.after),
        next_offset: next,
        snapshot_digest: s.snapshot_digest,
        complete: next === null && p.offset === 0,
        redacted: safeBefore !== before || safeAfter !== after,
        offset_basis:
          'Redacted display characters; hashes and total_chars identify original immutable files.',
        exact_artifacts:
          'Full-file redaction precedes paging. Renames appear as removal plus addition. Hashes are verified; redacted display is not a byte-exact export.',
        warning: REVIEW_WARNING,
      };
    })();
  }
  handoff(input: unknown) {
    const p = parseReview(reviewHandoffSchema, input);
    return this.db.transaction(() => {
      const s = this.snapshot(this.row(p.proposal_id));
      this.assertSnapshot(s, p);
      const r = new SkillAuthoringService(this.db, this.scope).get({ proposal_id: p.proposal_id });
      return {
        ...this.eligibility(s, r.validation.validation_result),
        proposal_id: p.proposal_id,
        version_id: s.row.candidate_id,
        candidate_digest: s.row.content_hash,
        snapshot_digest: s.snapshot_digest,
        execution:
          'No command executed. Existing operator workflow rechecks eligibility and requires its own authorization.',
        warning: REVIEW_WARNING,
      };
    })();
  }
  private eligibility(s: ReturnType<LearningReviewQuery['snapshot']>, validation: string) {
    let blocked: string | null = null;
    if (s.stale) blocked = 'REVIEW_STALE';
    else if (validation !== 'VALID') blocked = 'VALIDATION_FAILED';
    else if (s.row.type === 'REWRITE_EXISTING') blocked = 'BEHAVIORAL_EXECUTION_NOT_VERIFIED';
    if (!blocked)
      try {
        new SkillOperatorService(this.db, this.scope).prepare({
          action: 'approve',
          version_id: s.row.candidate_id,
        });
      } catch (e) {
        blocked = safeError(e).code;
      }
    return {
      eligible_for_existing_workflow: blocked === null,
      blocked_reason: blocked,
      review_is_approval: false,
      protected_deployment: 'NOT VERIFIED',
      supervised_workflow: {
        module: 'packages/mcp-server/dist/skill-operator.js',
        action: '--approve',
        version_id: s.row.candidate_id,
        requires:
          'Independent existing interactive confirmation; same-UID PTY automation is not prevented.',
      },
      protected_workflow: {
        module: 'packages/mcp-server/dist/broker-operator.js',
        requires:
          'Separately deployed OS-authenticated operator channel and existing operator_prepare/operator_commit flow. No new grants issued here.',
      },
    };
  }
  assertSnapshot(
    s: ReturnType<LearningReviewQuery['snapshot']>,
    p: { expected_snapshot_digest: string; candidate_digest: string },
  ) {
    if (
      s.snapshot_digest !== p.expected_snapshot_digest ||
      s.row.content_hash !== p.candidate_digest
    )
      throw new AgentMindError(
        'REVIEW_STALE_SNAPSHOT',
        'Candidate, evaluation, evidence or review decision changed; inspect a fresh snapshot.',
      );
  }
}
/** Trusted application constructor context, never an IPC/request field. Not approval authority. */
export type ReviewCaller =
  | { method: 'supervised-local-review-v1'; uid: number; username: string }
  | { method: 'broker-peer-review-v1'; uid: number; gid: number };
export function localReviewCaller(): ReviewCaller {
  const u = userInfo();
  return { method: 'supervised-local-review-v1', uid: u.uid, username: u.username };
}
export class LearningReviewDecisions {
  private readonly read: LearningReviewService;
  constructor(
    private readonly db: Database.Database,
    private readonly scope: ProjectScope,
    private readonly caller: ReviewCaller,
  ) {
    this.scope = Object.freeze({ ...scope });
    this.caller = Object.freeze({ ...caller });
    this.read = new LearningReviewService(db, this.scope);
  }
  decide(input: unknown) {
    const p = parseReview(reviewDecisionSchema, input);
    const reason = sanitizeExperienceText(p.reason).text;
    const digest = curatorDigest(p);
    const timeout = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('busy_timeout=250');
    try {
      return this.db
        .transaction(() => {
          if (reviewStorageExists(this.db)) {
            const prior = this.db
              .prepare('SELECT * FROM learning_review_events WHERE project_id=? AND request_id=?')
              .get(this.scope.id, p.request_id) as ReviewEvent | undefined;
            if (prior) {
              if (prior.request_digest !== digest)
                throw new AgentMindError(
                  'REVIEW_REPLAY_CONFLICT',
                  'Request ID already bound to another decision.',
                );
              return { event: this.event(prior), duplicate: true, warning: REVIEW_WARNING };
            }
          }
          const s = this.read.snapshot(this.read.row(p.proposal_id));
          this.read.assertSnapshot(s, p);
          // Full immutable package verification occurs for decisions, never just trusting a list projection.
          const store = new SkillStore(this.db, this.scope);
          store.getVersion(s.row.candidate_id);
          if (s.row.base_id) store.getVersion(s.row.base_id);
          if (s.event?.state === 'DISMISSED' && p.decision !== 'REOPEN')
            throw new AgentMindError(
              'REVIEW_REOPEN_REQUIRED',
              'Dismissed items require explicit reopening against a fresh snapshot.',
            );
          if (p.decision === 'RECOMMEND_FOR_APPROVAL') {
            const h = this.read.handoff({
              proposal_id: p.proposal_id,
              expected_snapshot_digest: p.expected_snapshot_digest,
              candidate_digest: p.candidate_digest,
            });
            if (!h.eligible_for_existing_workflow)
              throw new AgentMindError(
                'REVIEW_EVIDENCE_INCOMPLETE',
                'Existing approval eligibility or behavioral evidence is incomplete.',
              );
          }
          migrateLearningReview(this.db);
          const states = {
            DEFER: 'DEFERRED',
            DISMISS: 'DISMISSED',
            MARK_REVIEWED: 'REVIEWED',
            RECOMMEND_FOR_APPROVAL: 'RECOMMENDED',
            REQUEST_MORE_EVIDENCE: 'NEEDS_EVIDENCE',
            REOPEN: 'PENDING_REVIEW',
          };
          const event: ReviewEvent = {
            id: randomUUID(),
            project_id: this.scope.id,
            proposal_id: p.proposal_id,
            request_id: p.request_id,
            request_digest: digest,
            revision: (s.event?.revision ?? 0) + 1,
            candidate_digest: p.candidate_digest,
            snapshot_digest: p.expected_snapshot_digest,
            evidence_digest: s.evidence_digest,
            decision: p.decision,
            state: states[p.decision],
            reason,
            actor_json: JSON.stringify(this.caller),
            created_at: new Date().toISOString(),
          };
          this.db
            .prepare('INSERT INTO learning_review_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(
              event.id,
              event.project_id,
              event.proposal_id,
              event.request_id,
              event.request_digest,
              event.revision,
              event.candidate_digest,
              event.snapshot_digest,
              event.evidence_digest,
              event.decision,
              event.state,
              event.reason,
              event.actor_json,
              event.created_at,
            );
          return { event: this.event(event), duplicate: false, warning: REVIEW_WARNING };
        })
        .immediate();
    } catch (e) {
      if (e instanceof AgentMindError) throw e;
      throw new AgentMindError(
        'REVIEW_STORAGE_FAILED',
        'Review transaction failed; no partial decision committed.',
      );
    } finally {
      this.db.pragma(`busy_timeout=${Number(timeout)}`);
    }
  }
  private event({ actor_json, ...e }: ReviewEvent) {
    return redactReview({ ...e, actor: JSON.parse(actor_json), is_privileged_approval: false });
  }
}
