import type Database from 'better-sqlite3';
import { z } from 'zod';
import { authoringStorageExists } from '../authoring/storage.js';
import { curatorDigest } from '../curator/model.js';
import { curatorStorageExists } from '../curator/storage.js';
import { AgentMindError } from '../errors.js';
import type { LearningSignal } from '../learning/model.js';
import { learningStorageExists } from '../learning/storage.js';
import type { ProjectScope } from '../project.js';
import { parseReview, REVIEW_POLICY, REVIEW_WARNING, reviewListSchema } from './model.js';
import { redactReview } from './presentation.js';
import { reviewStorageExists } from './storage.js';
export type ReviewEvent = {
  id: string;
  project_id: string;
  proposal_id: string;
  request_id: string;
  request_digest: string;
  revision: number;
  candidate_digest: string;
  snapshot_digest: string;
  evidence_digest: string;
  decision: string;
  state: string;
  reason: string;
  actor_json: string;
  created_at: string;
};
const metaSchema = z.object({
  signal_ids: z.array(z.uuid()).max(3),
  experience_ids: z.array(z.uuid()).max(5),
  base_digest: z.string().nullable(),
  candidate_digest: z.string(),
  risks: z.array(z.string()).max(5),
});
const validationProjection = `CASE WHEN e.id IS NULL THEN 'VALID_AT_SUBMISSION' WHEN EXISTS(SELECT 1 FROM json_each(e.checks_json) c WHERE json_extract(c.value,'$.name')='validation.current-policy' AND json_extract(c.value,'$.result')='FAIL') THEN 'INVALID_EVALUATED' WHEN EXISTS(SELECT 1 FROM json_each(e.checks_json) c WHERE json_extract(c.value,'$.name')='validation.current-policy' AND json_extract(c.value,'$.result')='PASS') THEN 'VALID_EVALUATED' ELSE 'NOT_VERIFIED' END`;
const projection = `SELECT ${validationProjection} AS validation_state, p.id,p.type,p.skill_id,p.base_id,p.candidate_id,p.created_at,p.payload_json,k.name,k.active_version_id,k.revision AS skill_revision,
 v.version,v.content_hash,v.description,s.status AS candidate_state,s.revision AS state_revision,s.latest_evaluation_id,s.review_id,
 e.result AS evaluation_result,e.content_hash AS evaluated_digest,e.baseline_version_id,e.evaluator_version,e.created_at AS evaluated_at,s.updated_at AS state_updated_at,k.updated_at AS skill_updated_at,
 (SELECT MAX(v2.version) FROM skill_versions v2 WHERE v2.skill_id=p.skill_id AND v2.project_id=p.project_id) AS latest_version
 FROM authoring_proposals p JOIN skills k ON k.id=p.skill_id AND k.project_id=p.project_id
 JOIN skill_versions v ON v.id=p.candidate_id AND v.project_id=p.project_id
 JOIN skill_version_states s ON s.version_id=p.candidate_id AND s.project_id=p.project_id
 LEFT JOIN skill_evaluations e ON e.id=s.latest_evaluation_id AND e.project_id=p.project_id`;
type Row = {
  id: string;
  validation_state: string;
  type: string;
  skill_id: string;
  base_id: string | null;
  candidate_id: string;
  created_at: string;
  payload_json: string;
  name: string;
  active_version_id: string | null;
  skill_revision: number;
  version: number;
  content_hash: string;
  description: string;
  candidate_state: string;
  state_revision: number;
  latest_evaluation_id: string | null;
  review_id: string | null;
  evaluation_result: string | null;
  evaluated_digest: string | null;
  baseline_version_id: string | null;
  evaluator_version: string | null;
  evaluated_at: string | null;
  state_updated_at: string;
  skill_updated_at: string;
  latest_version: number;
};
/** A bounded scan can stop without exhausting the matching queue. */
export function reviewPageProgress(
  offset: number,
  consumed: number,
  more: boolean,
  itemCount: number,
) {
  const next = more && offset + consumed <= 10000 ? offset + consumed : null;
  return {
    next_offset: next,
    exhausted: !more,
    page_status: !more
      ? 'END'
      : next === null
        ? 'OFFSET_LIMIT_REACHED'
        : itemCount === 0
          ? 'CONTINUE'
          : 'HAS_MORE',
    scan_truncated: more && consumed === 100,
  };
}

export class LearningReviewQuery {
  readonly scope: ProjectScope;
  constructor(
    readonly db: Database.Database,
    scope: ProjectScope,
  ) {
    this.scope = Object.freeze({ ...scope });
  }
  row(id: string): Row {
    const row = authoringStorageExists(this.db)
      ? (this.db.prepare(`${projection} WHERE p.id=? AND p.project_id=?`).get(id, this.scope.id) as
          | Row
          | undefined)
      : undefined;
    if (!row)
      throw new AgentMindError('REVIEW_NOT_FOUND', 'Review item unavailable in this project.');
    return row;
  }
  latest(id: string) {
    return reviewStorageExists(this.db)
      ? (this.db
          .prepare(
            'SELECT * FROM learning_review_events WHERE project_id=? AND proposal_id=? ORDER BY revision DESC LIMIT 1',
          )
          .get(this.scope.id, id) as ReviewEvent | undefined)
      : undefined;
  }
  sources(row: Row) {
    const parsed = metaSchema.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success)
      throw new AgentMindError('REVIEW_PROVENANCE_INVALID', 'Invalid authoring provenance.');
    const meta = parsed.data;
    const signals = meta.signal_ids.map((id) => {
      const r = learningStorageExists(this.db)
        ? (this.db
            .prepare(
              'SELECT payload_json,revision,status FROM learning_signals WHERE id=? AND project_id=?',
            )
            .get(id, this.scope.id) as
            | { payload_json: string; revision: number; status: string }
            | undefined)
        : undefined;
      if (!r) return { id, available: false, source_digest: null, signal: null };
      const s = JSON.parse(r.payload_json) as LearningSignal;
      if (s.project_id !== this.scope.id || s.id !== id)
        throw new AgentMindError('REVIEW_PROVENANCE_INVALID', 'Signal record scope mismatch.');
      return { id, available: true, source_digest: curatorDigest(r), signal: s };
    });
    const experiences = meta.experience_ids.map((id) => {
      const r = this.db
        .prepare(
          'SELECT id,problem,solution,outcome_status,outcome_summary,reviewed_at,approval_status,updated_at FROM experiences WHERE id=? AND project_id=?',
        )
        .get(id, this.scope.id) as
        | {
            id: string;
            problem: string;
            solution: string;
            outcome_status: string;
            outcome_summary: string;
            reviewed_at: string | null;
            approval_status: string;
            updated_at: string;
          }
        | undefined;
      return r
        ? { id, available: true, source_digest: curatorDigest(r), record: r }
        : { id, available: false, source_digest: null, record: null };
    });
    const refs = signals
      .flatMap((s) => (s.signal?.evidence ?? []).slice(0, 8))
      .map((ref) => {
        const queries: Record<string, string> = {
          experience:
            'SELECT id,updated_at,approval_status FROM experiences WHERE id=? AND project_id=?',
          evaluation:
            'SELECT id,content_hash,result,checks_json FROM skill_evaluations WHERE id=? AND project_id=?',
          skill_version: 'SELECT id,content_hash FROM skill_versions WHERE id=? AND project_id=?',
          recommendation: curatorStorageExists(this.db)
            ? 'SELECT id,revision,state,payload_json FROM curator_recommendations WHERE id=? AND project_id=?'
            : '',
          usage:
            'SELECT event_id,artifact_digest,category,verification,event_type FROM skill_usage_events WHERE event_id=? AND project_id=?',
        };
        // Telemetry table has an independent optional migration; never run a mutation to inspect it.
        const sql = queries[ref.kind];
        let r: unknown = null;
        if (
          sql &&
          (ref.kind !== 'usage' ||
            this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='skill_usage_events'").get())
        )
          r = this.db.prepare(sql).get(ref.id, this.scope.id) ?? null;
        return { ...ref, available: r !== null, source_digest: r ? curatorDigest(r) : null };
      });
    const recommendations = curatorStorageExists(this.db)
      ? this.db
          .prepare(
            'SELECT id,version_id,state,priority,revision,last_evaluated_at FROM curator_recommendations WHERE project_id=? AND version_id IN (?,?) ORDER BY priority,id LIMIT 4',
          )
          .all(this.scope.id, row.candidate_id, row.base_id)
      : [];
    return {
      meta,
      signals,
      experiences,
      refs,
      recommendations: recommendations.slice(0, 3),
      recommendations_truncated: recommendations.length > 3,
    };
  }
  snapshot(row: Row) {
    const sources = this.sources(row),
      event = this.latest(row.id);
    const evidence_digest = curatorDigest({ policy: REVIEW_POLICY, row, sources });
    const snapshot_digest = curatorDigest({
      evidence_digest,
      decision_id: event?.id ?? null,
      revision: event?.revision ?? 0,
    });
    const warnings: string[] = [];
    if (row.content_hash !== sources.meta.candidate_digest)
      warnings.push('ARTIFACT_PROVENANCE_MISMATCH');
    if (row.version < row.latest_version) warnings.push('NEWER_VERSION_EXISTS');
    if (
      row.base_id &&
      row.active_version_id !== row.base_id &&
      row.active_version_id !== row.candidate_id
    )
      warnings.push('ACTIVE_VERSION_DIFFERS_FROM_BASE');
    if (row.evaluated_digest && row.evaluated_digest !== row.content_hash)
      warnings.push('EVALUATION_DIGEST_MISMATCH');
    if (
      row.latest_evaluation_id &&
      row.candidate_state === 'candidate' &&
      row.baseline_version_id !== row.active_version_id
    )
      warnings.push('EVALUATION_BASELINE_CHANGED');
    if (
      sources.signals.some((s) => !s.available || s.signal?.status !== 'open') ||
      sources.experiences.some((s) => !s.available || s.record?.approval_status !== 'approved') ||
      sources.refs.some((r) => !r.available)
    )
      warnings.push('SOURCE_MISSING_OR_CHANGED');
    const stale = warnings.length > 0 || (!!event && event.evidence_digest !== evidence_digest);
    if (event && event.evidence_digest !== evidence_digest)
      warnings.push('REVIEW_SNAPSHOT_CHANGED');
    const missing = !row.latest_evaluation_id || row.evaluation_result !== 'PASS';
    const state =
      event?.state === 'DISMISSED'
        ? 'DISMISSED'
        : stale
          ? 'STALE'
          : (event?.state ?? (missing ? 'NEEDS_EVIDENCE' : 'PENDING_REVIEW'));
    const risks = [
      ...(row.type === 'REWRITE_EXISTING' ? ['HIGH_REVIEW_RISK'] : []),
      ...warnings,
      ...(sources.signals.some((s) => s.signal?.type === 'SKILL_CONFLICT')
        ? ['CONFLICT_REVIEW']
        : []),
      ...(sources.signals.some(
        (s) =>
          s.signal?.type === 'REPEATED_FAILURE' &&
          s.signal.triage.evidence_trust === 'VERIFIED_STATIC_CHECK',
      )
        ? ['STATIC_FAILURE_SIGNAL']
        : []),
      ...(missing ? ['EVALUATION_INCOMPLETE'] : []),
      'BEHAVIORAL_EXECUTION_NOT_VERIFIED',
    ];
    return { row, sources, event, evidence_digest, snapshot_digest, stale, state, risks };
  }
  summary(s: ReturnType<LearningReviewQuery['snapshot']>) {
    const r = s.row;
    return redactReview({
      queue_item_id: r.id,
      proposal_id: r.id,
      project_id: this.scope.id,
      type: r.type,
      name: r.name,
      skill_id: r.skill_id,
      base_version_id: r.base_id,
      base_digest: s.sources.meta.base_digest,
      candidate_version_id: r.candidate_id,
      candidate_digest: r.content_hash,
      source_signal_ids: s.sources.meta.signal_ids,
      experience_ids: s.sources.meta.experience_ids,
      validation: r.validation_state,
      validation_scope:
        'Stored submission/latest evaluation summary. Detail performs current full validation.',
      evaluation: r.evaluation_result ?? 'MISSING',
      review_state: s.state,
      stale: s.stale,
      risks: s.risks,
      priority:
        r.type === 'REWRITE_EXISTING' || r.evaluation_result === 'FAIL'
          ? 'HIGH_REVIEW_RISK'
          : 'NORMAL',
      priority_rationale: 'Heuristic review urgency; not confidence or evidence of effectiveness.',
      learning_triage: s.sources.signals.map((s) => ({
        id: s.id,
        action: s.signal?.triage.action ?? null,
        evidence_trust: s.signal?.triage.evidence_trust ?? null,
        reusability: s.signal?.reusability ?? null,
      })),
      linked_recommendations: s.sources.recommendations,
      linked_recommendations_truncated: s.sources.recommendations_truncated,
      candidate_state: r.candidate_state,
      active_version_id: r.active_version_id,
      superseded: r.version < r.latest_version,
      created_at: r.created_at,
      last_updated_at:
        [
          r.created_at,
          r.evaluated_at ?? '',
          r.state_updated_at,
          r.skill_updated_at,
          s.event?.created_at ?? '',
          ...s.sources.signals.map((v) => v.signal?.updated_at ?? ''),
          ...s.sources.experiences.map((v) => v.record?.updated_at ?? ''),
        ]
          .sort()
          .at(-1) ?? r.created_at,
      snapshot_digest: s.snapshot_digest,
      review_revision: s.event?.revision ?? 0,
      decision: s.event
        ? {
            id: s.event.id,
            decision: s.event.decision,
            reason: s.event.reason,
            actor: JSON.parse(s.event.actor_json),
            created_at: s.event.created_at,
          }
        : null,
    });
  }
  list(input: unknown = {}) {
    const p = parseReview(reviewListSchema, input);
    return this.db.transaction(() => {
      if (!authoringStorageExists(this.db))
        return { items: [], ...reviewPageProgress(p.offset, 0, false, 0), warning: REVIEW_WARNING };
      const clauses = ['p.project_id=?'];
      const params: (string | number)[] = [this.scope.id];
      // Only prefilter states whose membership has a safe SQL necessary condition.
      // Dynamic staleness still comes from the exact scoped source snapshot below.
      const latestState = reviewStorageExists(this.db)
        ? '(SELECT re.state FROM learning_review_events re WHERE re.project_id=p.project_id AND re.proposal_id=p.id ORDER BY re.revision DESC LIMIT 1)'
        : 'NULL';
      if (p.pending_only) {
        clauses.push("s.status='candidate'");
        clauses.push(`COALESCE(${latestState},'')!='DISMISSED'`);
      }
      if (p.state && ['DISMISSED', 'DEFERRED', 'REVIEWED', 'RECOMMENDED'].includes(p.state)) {
        clauses.push(`${latestState}=?`);
        params.push(p.state);
      }
      if (p.state === 'STALE') clauses.push(`COALESCE(${latestState},'')!='DISMISSED'`);
      if (p.type) {
        clauses.push('p.type=?');
        params.push(p.type);
      }
      if (p.validation) {
        clauses.push(`${validationProjection}=?`);
        params.push(p.validation);
      }
      if (p.name) {
        clauses.push('instr(k.name,?)>0');
        params.push(p.name);
      }
      if (p.evaluation) {
        clauses.push("COALESCE(e.result,'MISSING')=?");
        params.push(p.evaluation);
      }
      const order =
        p.order === 'risk'
          ? "CASE WHEN p.type='REWRITE_EXISTING' OR e.result='FAIL' THEN 0 ELSE 1 END,"
          : '';
      const rows = this.db
        .prepare(
          `${projection} WHERE ${clauses.join(' AND ')} ORDER BY ${order}p.created_at,p.id LIMIT 101 OFFSET ?`,
        )
        .all(...params, p.offset) as Row[];
      const items: ReturnType<LearningReviewQuery['summary']>[] = [];
      let consumed = 0;
      for (const r of rows.slice(0, 100)) {
        consumed++;
        const s = this.snapshot(r);
        if (p.state && s.state !== p.state) continue;
        if (
          p.pending_only &&
          (r.candidate_state !== 'candidate' ||
            ['DISMISSED', 'DEFERRED', 'RECOMMENDED', 'REVIEWED'].includes(s.state))
        )
          continue;
        const item = this.summary(s);
        if (Buffer.byteLength(JSON.stringify([...items, item])) > 48000) {
          consumed--;
          break;
        }
        items.push(item);
        if (items.length === p.limit) break;
      }
      const more = rows.length > consumed;
      return {
        items,
        ...reviewPageProgress(p.offset, consumed, more, items.length),
        pagination:
          'Continue using next_offset even when items is empty. exhausted alone indicates completion; OFFSET_LIMIT_REACHED requires narrowing filters. Concurrent changes can shift offsets.',
        warning: REVIEW_WARNING,
        untrusted_data: true,
      };
    })();
  }
}
