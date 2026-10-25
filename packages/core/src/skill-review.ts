import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import { SkillEvaluationService } from './skill-evaluation.js';
import { SkillStore } from './skill-store.js';

export const skillReviewRequestSchema = z.strictObject({ version_id: z.uuid() });
export const skillPendingSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const OPERATOR_WARNING =
  'Local confirmation only. Same-OS-user agents can create PTYs or edit SQLite; human authorization is NOT adversarially secure. Static PASS does not verify task behavior. No deployed CLI copies are updated.';

export class SkillReviewService {
  readonly #scope: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
  ) {
    this.#scope = Object.freeze({ ...scope });
  }
  pending(input: unknown = {}) {
    const p = skillPendingSchema.safeParse(input);
    if (!p.success)
      throw new AgentMindError('INVALID_INPUT', 'Expected bounded pending pagination.');
    const rows = this.db
      .prepare(`SELECT v.id,v.skill_id,v.version,v.content_hash,v.description,s.latest_evaluation_id,s.revision
      FROM skill_versions v JOIN skill_version_states s ON s.version_id=v.id
      WHERE v.project_id=? AND s.project_id=? AND s.status='candidate' ORDER BY v.created_at,v.id LIMIT ? OFFSET ?`)
      .all(this.#scope.id, this.#scope.id, p.data.limit + 1, p.data.offset);
    const more = rows.length > p.data.limit;
    return {
      candidates: rows.slice(0, p.data.limit),
      next_offset:
        more && p.data.offset + p.data.limit <= 10000 ? p.data.offset + p.data.limit : null,
      truncated: more,
      warning: OPERATOR_WARNING,
      untrusted_data: true as const,
    };
  }
  review(input: unknown) {
    const p = skillReviewRequestSchema.safeParse(input);
    if (!p.success) throw new AgentMindError('INVALID_INPUT', 'Expected an exact version UUID.');
    return this.db.transaction(() => {
      let snapshot: ReturnType<SkillStore['get']>;
      try {
        snapshot = new SkillStore(this.db, this.#scope).get(p.data);
      } catch (error) {
        if (error instanceof AgentMindError) throw error;
        throw new AgentMindError(
          'SKILL_INTEGRITY_ERROR',
          'Cannot inspect a malformed or corrupted skill snapshot.',
        );
      }
      const active = snapshot.identity.active_version_id
        ? new SkillStore(this.db, this.#scope).getVersion(snapshot.identity.active_version_id)
        : null;
      const evaluationReport = snapshot.state.latest_evaluation_id
        ? new SkillEvaluationService(this.db, this.#scope).getReport({
            evaluation_id: snapshot.state.latest_evaluation_id,
          })
        : null;
      const evaluation = evaluationReport?.evaluation ?? null;
      const sources = this.db
        .prepare(
          `SELECT e.id,e.approval_status,e.updated_at FROM skill_version_sources s JOIN experiences e ON e.id=s.experience_id AND e.project_id=s.project_id WHERE s.version_id=? AND s.project_id=? ORDER BY e.id`,
        )
        .all(p.data.version_id, this.#scope.id);
      const audit = this.db
        .prepare(
          'SELECT * FROM skill_operator_events WHERE version_id=? AND project_id=? ORDER BY created_at DESC,id LIMIT 101',
        )
        .all(p.data.version_id, this.#scope.id);
      const approvalEvent = snapshot.state.review_id
        ? (this.db
            .prepare('SELECT * FROM skill_operator_events WHERE review_id=? AND project_id=?')
            .get(snapshot.state.review_id, this.#scope.id) ?? null)
        : null;
      const latest = this.db
        .prepare(
          'SELECT MAX(version) AS version FROM skill_versions WHERE skill_id=? AND project_id=?',
        )
        .get(snapshot.identity.id, this.#scope.id) as { version: number };
      return {
        ...snapshot,
        project_root: this.#scope.root,
        active,
        evaluation,
        ...(evaluationReport && 'behavioral' in evaluationReport
          ? { behavioral: evaluationReport.behavioral }
          : {}),
        sources_current: sources,
        operator_events: audit.slice(0, 100),
        operator_events_truncated: audit.length > 100,
        approval_event: approvalEvent,
        latest_version: latest.version,
        diff: diffSkillFiles(active?.version.files ?? [], snapshot.version.files),
        warning: OPERATOR_WARNING,
      };
    })();
  }
  diff(input: unknown) {
    const r = this.review(input);
    return {
      version_id: r.version.id,
      content_hash: r.version.content_hash,
      active_version_id: r.identity.active_version_id,
      diff: r.diff,
      warning: r.warning,
      untrusted_data: true as const,
    };
  }
  evaluation(input: unknown) {
    const r = this.review(input);
    return {
      version_id: r.version.id,
      evaluation: r.evaluation,
      ...('behavioral' in r ? { behavioral: r.behavioral } : {}),
      warning: r.warning,
      untrusted_data: true as const,
    };
  }
}
export function diffSkillFiles(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[],
) {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const next = new Map(after.map((f) => [f.path, f.content]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .filter((path) => old.get(path) !== next.get(path))
    .map((path) => ({
      path,
      change: !old.has(path) ? 'added' : !next.has(path) ? 'removed' : 'changed',
      before: old.get(path) ?? null,
      after: next.get(path) ?? null,
    }));
}
