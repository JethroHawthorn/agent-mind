import type Database from 'better-sqlite3';
import { normalizeExperienceText } from '../experience.js';
import { redactSecrets } from '../privacy.js';
import type { ProjectScope } from '../project.js';
import type { Coverage, CuratorPolicy } from './model.js';
export type SkillEvidence = {
  skill_id: string;
  version_id: string;
  content_hash: string;
  name: string;
  description: string;
  created_at: string;
  maintained_at: string;
  source_ids: string[];
  experience_ids: string[];
  evaluation_id: string | null;
  evaluation_result: string | null;
  evaluation_policy: string | null;
};
export type EventEvidence = {
  event_id: string;
  skill_id: string;
  version_id: string;
  task_id: string | null;
  session_id: string | null;
  event_type: string;
  source_cli: string;
  category: string;
  verification: string;
  method: string;
  received_at: string;
  operator_authorized: boolean;
};
export type EvidenceCollection = {
  skills: SkillEvidence[];
  events: EventEvidence[];
  coverage: Coverage;
};
const stop = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'only',
  'use',
  'skill',
  'safe',
  'using',
]);
export function evidenceWords(text: string) {
  return [
    ...new Set(
      normalizeExperienceText(redactSecrets(text))
        .split(' ')
        .filter((w) => w.length >= 3 && !stop.has(w)),
    ),
  ].slice(0, 64);
}
/** SELECT-only collector; reuses the existing project-column FTS5 experience index and normalization. */
export function collectCuratorEvidence(
  db: Database.Database,
  scope: ProjectScope,
  policy: CuratorPolicy,
): EvidenceCollection {
  const rows = db
    .prepare(`SELECT k.id AS skill_id,v.id AS version_id,v.content_hash,k.name,v.description,v.created_at,
 MAX(k.updated_at,(SELECT MAX(vv.created_at) FROM skill_versions vv WHERE vv.skill_id=k.id AND vv.project_id=k.project_id)) AS maintained_at,
 s.latest_evaluation_id AS evaluation_id,e.result AS evaluation_result,e.evaluator_version AS evaluation_policy
 FROM skills k JOIN skill_versions v ON v.id=COALESCE(k.active_version_id,(SELECT vv.id FROM skill_versions vv JOIN skill_version_states ss ON ss.version_id=vv.id AND ss.project_id=vv.project_id WHERE vv.skill_id=k.id AND vv.project_id=k.project_id AND ss.status!='rejected' ORDER BY vv.version DESC LIMIT 1)) AND v.skill_id=k.id AND v.project_id=k.project_id
 JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=k.project_id
 LEFT JOIN skill_evaluations e ON e.id=s.latest_evaluation_id AND e.project_id=k.project_id
 WHERE k.project_id=? AND s.status!='rejected' ORDER BY k.id LIMIT ?`)
    .all(scope.id, policy.max_skills + 1) as Array<
    Omit<SkillEvidence, 'source_ids' | 'experience_ids'>
  >;
  const coverage: Coverage = {
    skills_truncated: rows.length > policy.max_skills,
    events_truncated: false,
    experiences_truncated: false,
    recommendations_truncated: false,
  };
  const skills: SkillEvidence[] = rows.slice(0, policy.max_skills).map((row) => {
    const sources = db
      .prepare(
        'SELECT experience_id FROM skill_version_sources WHERE version_id=? AND skill_id=? AND project_id=? ORDER BY experience_id LIMIT 33',
      )
      .all(row.version_id, row.skill_id, scope.id) as Array<{ experience_id: string }>;
    const matches = new Set<string>();
    // Literal one-token queries; no model-provided FTS operators, paths, prompts or evidence ingestion.
    for (const word of evidenceWords(`${row.name} ${row.description}`).slice(0, 3)) {
      const found = db
        .prepare(
          `SELECT e.id FROM experiences_fts JOIN experiences e ON e.rowid=experiences_fts.rowid WHERE experiences_fts MATCH ? AND e.project_id=? AND e.approval_status='approved' AND e.updated_at>? ORDER BY e.updated_at DESC,e.id LIMIT 6`,
        )
        .all(
          `project_id : "${scope.id}" AND {problem solution outcome_summary} : ("${word}")`,
          scope.id,
          row.created_at,
        ) as Array<{ id: string }>;
      if (found.length > 5) coverage.experiences_truncated = true;
      for (const e of found.slice(0, 5))
        if (!sources.some((s) => s.experience_id === e.id)) matches.add(e.id);
    }
    if (matches.size > 5) coverage.experiences_truncated = true;
    return {
      ...row,
      source_ids: sources.map((s) => s.experience_id),
      experience_ids: [...matches].sort().slice(0, 5),
    };
  });
  if (!skills.length) return { skills, events: [], coverage };
  const ids = skills.map((s) => s.skill_id);
  const events = db
    .prepare(`SELECT u.event_id,u.skill_id,u.version_id,u.task_id,u.session_id,u.event_type,u.source_cli,u.category,u.verification,u.method,u.received_at,
 json_extract(u.details_json,'$.authorization.operator') AS operator_id,json_extract(u.details_json,'$.authorization.session') AS operator_session,json_extract(u.details_json,'$.authorization.context_digest') AS context_digest
 FROM skill_usage_events u JOIN skill_versions v ON v.id=u.version_id AND v.skill_id=u.skill_id AND v.project_id=u.project_id AND v.content_hash=u.artifact_digest
 WHERE u.project_id=? AND u.skill_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.received_at DESC,u.event_id LIMIT ?`)
    .all(scope.id, ...ids, policy.max_events + 1) as Array<
    Omit<EventEvidence, 'operator_authorized'> & {
      operator_id: unknown;
      operator_session: unknown;
      context_digest: unknown;
    }
  >;
  coverage.events_truncated =
    events.length > policy.max_events ||
    skills.some(
      (skill) => events.filter((event) => event.version_id === skill.version_id).length > 24,
    );
  return {
    skills,
    coverage,
    events: events
      .slice(0, policy.max_events)
      .map(({ operator_id, operator_session, context_digest, ...e }) => ({
        ...e,
        operator_authorized:
          typeof operator_id === 'string' &&
          operator_id.length > 0 &&
          typeof operator_session === 'string' &&
          operator_session.length > 0 &&
          typeof context_digest === 'string' &&
          /^[a-f0-9]{64}$/.test(context_digest),
      })),
  };
}
export function evidenceExists(
  db: Database.Database,
  scope: ProjectScope,
  kind: string,
  id: string,
) {
  switch (kind) {
    case 'learning_signal':
      return (
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_signals'").get() &&
        !!db.prepare('SELECT 1 FROM learning_signals WHERE id=? AND project_id=?').get(id, scope.id)
      );
    case 'usage':
      return !!db
        .prepare('SELECT 1 FROM skill_usage_events WHERE event_id=? AND project_id=?')
        .get(id, scope.id);
    case 'experience':
      return !!db
        .prepare('SELECT 1 FROM experiences WHERE id=? AND project_id=?')
        .get(id, scope.id);
    case 'evaluation':
      return !!db
        .prepare('SELECT 1 FROM skill_evaluations WHERE id=? AND project_id=?')
        .get(id, scope.id);
    case 'skill_version':
      return !!db
        .prepare('SELECT 1 FROM skill_versions WHERE id=? AND project_id=?')
        .get(id, scope.id);
    default:
      return false;
  }
}
