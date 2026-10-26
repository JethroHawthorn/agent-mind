import type Database from 'better-sqlite3';
import { evidenceExists, evidenceWords } from '../curator/data.js';
import { curatorStorageExists } from '../curator/storage.js';
import type { ProjectScope } from '../project.js';
import { SKILL_EVALUATOR } from '../skill-evaluation-engine.js';
import { SkillStore } from '../skill-store.js';
import {
  LEARNING_LIMITATIONS,
  LEARNING_POLICY,
  type LearningSignal,
  type LearningTriage,
  type SignalEvidence,
} from './model.js';
export function referenceExists(db: Database.Database, scope: ProjectScope, e: SignalEvidence) {
  if (e.kind === 'recommendation')
    return (
      curatorStorageExists(db) &&
      !!db
        .prepare('SELECT 1 FROM curator_recommendations WHERE id=? AND project_id=?')
        .get(e.id, scope.id)
    );
  return evidenceExists(db, scope, e.kind, e.id);
}
export function evaluationFact(db: Database.Database, scope: ProjectScope, id: string) {
  const row = db
    .prepare('SELECT * FROM skill_evaluations WHERE id=? AND project_id=?')
    .get(id, scope.id) as
    | {
        version_id: string;
        content_hash: string;
        evaluator: string;
        evaluator_version: string;
        result: string;
        checks_json: string;
      }
    | undefined;
  if (!row) return null;
  const snapshot = new SkillStore(db, scope).getVersion(row.version_id);
  const checks = JSON.parse(row.checks_json) as Array<{ result: string }>;
  return row.evaluator === SKILL_EVALUATOR &&
    row.evaluator_version.startsWith('static-contract-v2/') &&
    row.content_hash === snapshot.version.content_hash &&
    row.result === 'FAIL' &&
    checks.some((c) => c.result === 'FAIL')
    ? row
    : null;
}
export function assessLearning(
  db: Database.Database,
  scope: ProjectScope,
  signal: LearningSignal,
): LearningTriage {
  const refs = [
    ...signal.evidence,
    ...signal.experience_ids.map((id) => ({ kind: 'experience' as const, id })),
    ...signal.version_ids.map((id) => ({ kind: 'skill_version' as const, id })),
  ];
  const status: LearningTriage['evidence_status'] = refs.map((e) => ({
    ...e,
    status: referenceExists(db, scope, e)
      ? ('AVAILABLE' as const)
      : ('MISSING_OR_UNAVAILABLE' as const),
  }));
  const experiences = new Set(signal.experience_ids),
    versions = new Set(signal.version_ids);
  const store = new SkillStore(db, scope);
  let unverifiedClaims = false;
  let failures = 0,
    verifiedStatic = false,
    conflicting = false,
    attested = !!signal.operator_correction;
  const tasks = new Map<string, Set<string>>();
  for (const e of status.filter((r) => r.status === 'AVAILABLE')) {
    e.trust = 'OBSERVED_RECORD';
    if (e.kind === 'experience') {
      experiences.add(e.id);
      unverifiedClaims = true;
      e.trust = 'AGENT_REPORTED';
    }
    if (e.kind === 'skill_version') versions.add(e.id);
    if (e.kind === 'evaluation') {
      const row = db
        .prepare('SELECT version_id FROM skill_evaluations WHERE id=? AND project_id=?')
        .get(e.id, scope.id) as { version_id: string };
      versions.add(row.version_id);
      verifiedStatic ||= !!evaluationFact(db, scope, e.id);
    }
    if (e.kind === 'usage') {
      const u = db
        .prepare('SELECT * FROM skill_usage_events WHERE event_id=? AND project_id=?')
        .get(e.id, scope.id) as {
        version_id: string;
        event_type: string;
        task_id: string | null;
        category: string;
        verification: string;
        details_json: string;
      };
      if (u.category === 'llm_reported' || u.verification === 'unverified') {
        unverifiedClaims = true;
        e.trust = 'AGENT_REPORTED';
      }
      versions.add(u.version_id);
      if (u.event_type === 'task_failed') failures++;
      if (u.task_id) {
        const set = tasks.get(u.task_id) ?? new Set();
        set.add(u.event_type);
        tasks.set(u.task_id, set);
      }
      const d = JSON.parse(u.details_json);
      attested ||=
        u.category === 'operator_confirmed' &&
        u.verification === 'operator_confirmed' &&
        !!d.authorization?.context_digest;
    }
    if (e.kind === 'recommendation') {
      const r = db
        .prepare('SELECT payload_json FROM curator_recommendations WHERE id=? AND project_id=?')
        .get(e.id, scope.id) as { payload_json: string };
      const p = JSON.parse(r.payload_json);
      if (p.version_id) versions.add(p.version_id);
      if (p.related_version_id) versions.add(p.related_version_id);
    }
  }
  conflicting = [...tasks.values()].some((s) => s.has('task_failed') && s.has('task_succeeded'));
  const words = evidenceWords(`${signal.title} ${signal.summary}`)
    .filter((w) => !['completed', 'successfully', 'finished', 'task', 'done'].includes(w))
    .slice(0, 3);
  // Existing scoped FTS indices and SkillStore search, max three literal tokens and three results/token.
  const ematches = new Map<string, number>(),
    vmatches = new Map<string, number>();
  for (const word of words) {
    const match = `project_id : "${scope.id}" AND {problem solution outcome_summary} : ("${word}")`;
    const found = db
      .prepare(
        "SELECT e.id FROM experiences_fts JOIN experiences e ON e.rowid=experiences_fts.rowid WHERE experiences_fts MATCH ? AND e.project_id=? AND e.approval_status!='rejected' ORDER BY e.id LIMIT 3",
      )
      .all(match, scope.id) as { id: string }[];
    for (const e of found) ematches.set(e.id, (ematches.get(e.id) ?? 0) + 1);
    for (const item of store.search(word, { limit: 3 }).skills) {
      const version = item.identity.active_version_id ?? item.latest_version_id;
      if (typeof version === 'string') vmatches.set(version, (vmatches.get(version) ?? 0) + 1);
    }
  }
  for (const [id, hits] of ematches) if (hits >= 2 && experiences.size < 4) experiences.add(id);
  for (const [id, hits] of vmatches) if (hits >= 2 && versions.size < 4) versions.add(id);
  for (const id of versions) store.getVersion(id); // Scoped model validates immutable artifact digest.
  let novelty: LearningTriage['novelty'] = experiences.size
    ? 'possibly_covered'
    : words.length >= 2
      ? 'no_bounded_match'
      : 'unknown';
  let action: LearningTriage['action'] = 'INVESTIGATE';
  let reason = 'Evidence is incomplete; gather references without claiming a verified lesson.';
  const meaningful = signal.summary.length >= 40 && words.length >= 2;
  const reusable = signal.reusability === 'potentially_reusable';
  if (!meaningful || signal.reusability === 'task_specific') {
    action = 'IGNORE';
    reason =
      'Generic completion or task-specific detail is insufficient for a reusable opportunity.';
  } else if (
    conflicting ||
    signal.type === 'SKILL_CONFLICT' ||
    signal.type === 'REPEATED_FAILURE' ||
    verifiedStatic
  ) {
    action = 'INVESTIGATE';
    reason =
      'A failure/conflict warrants investigation, not a causal conclusion or automatic update.';
  } else if (signal.type === 'USER_CORRECTION' && !signal.operator_correction) {
    action = 'INVESTIGATE';
    reason =
      'A claimed correction lacks explicit operator attestation; do not infer human provenance.';
  } else if (reusable && versions.size) {
    action = 'POTENTIAL_SKILL_UPDATE';
    reason =
      'A scoped version may be relevant; compare existing evidence before proposing a separate change.';
  } else if (experiences.size) {
    action = 'IGNORE';
    reason =
      'An existing experience may already cover the lesson; retain references without duplicating it.';
  } else if (
    reusable &&
    signal.supporting_evidence.length > 0 &&
    signal.type !== 'PROBLEM_SOLVED'
  ) {
    action = 'POTENTIAL_NEW_SKILL';
    reason =
      'No bounded match was found; novelty and usefulness still require human investigation.';
  } else if (reusable && signal.type === 'PROBLEM_SOLVED') {
    action = 'RECORD_EXPERIENCE';
    reason =
      'If appropriate, explicitly record a structured unverified experience through the existing tool.';
  }
  if (status.some((e) => e.status !== 'AVAILABLE')) {
    action = 'INVESTIGATE';
    reason = 'Evidence is unavailable; do not rely on the previous assessment.';
    novelty = 'unknown';
  }
  const limitations = [
    ...LEARNING_LIMITATIONS,
    `${failures} referenced failure reports across ${tasks.size} task labels; these are not proven independent samples.`,
    ...(verifiedStatic
      ? ['Verified static evaluator FAIL is not a verified task failure or behavioral regression.']
      : []),
    ...(conflicting
      ? ['The same task has opposing outcome claims; no resolution is inferred.']
      : []),
    ...(status.some((e) => e.kind === 'usage')
      ? []
      : ['No telemetry reference is present; absence of telemetry is not success.']),
  ];
  return {
    action,
    reason,
    novelty,
    reusability: signal.reusability,
    evidence_trust: signal.operator_correction
      ? 'OPERATOR_ATTESTED'
      : signal.origin.detection_source === 'agent_reported' || unverifiedClaims
        ? 'AGENT_REPORTED'
        : verifiedStatic
          ? 'VERIFIED_STATIC_CHECK'
          : attested
            ? 'OPERATOR_ATTESTED'
            : 'OBSERVED_RECORD',
    limitations,
    policy_version: LEARNING_POLICY,
    related_experiences: [...experiences].sort().slice(0, 4),
    related_versions: [...versions].sort().slice(0, 4),
    evidence_status: status,
  };
}
