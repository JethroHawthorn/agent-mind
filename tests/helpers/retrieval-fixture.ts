import { randomUUID } from 'node:crypto';
import {
  migrateRetrieval,
  type ProjectScope,
  SkillEvaluationService,
  SkillProposalService,
  SkillRetrievalService,
  SkillStore,
} from '../../packages/core/src/index.js';
import { distributionFixture } from './distribution-fixture.js';
export type RetrievalDraft = {
  name: string;
  description: string;
  body?: string;
  resources?: { path: string; content: string }[];
  activate?: boolean;
  scope?: ProjectScope;
};
/** Synthetic approval/transition audit fixtures, never real human or OS authentication evidence. */
export function retrievalFixture() {
  const f = distributionFixture(false);
  migrateRetrieval(f.db);
  const foreignSource = f.source(true);
  const audit = (
    versionId: string,
    history: string,
    action: 'approve' | 'promote' | 'rollback',
    scope = f.scope,
  ) => {
    const v = new SkillStore(f.db, scope).getVersion(versionId),
      e = f.db
        .prepare('SELECT evaluator_version FROM skill_evaluations WHERE id=?')
        .get(v.state.latest_evaluation_id) as { evaluator_version: string };
    const h = f.db
      .prepare(
        `SELECT * FROM ${action === 'approve' ? 'skill_reviews' : 'skill_promotions'} WHERE id=?`,
      )
      .get(history) as { created_at: string; reviewer: string; actor: string; reason: string };
    f.db
      .prepare(
        `INSERT INTO skill_operator_events(id,skill_id,project_id,version_id,content_hash,evaluation_id,evaluator_version,action,review_id,promotion_id,operator_id,session_id,authorization_method,context_digest,reason,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        v.version.skill_id,
        scope.id,
        versionId,
        v.version.content_hash,
        v.state.latest_evaluation_id,
        e.evaluator_version,
        action,
        action === 'approve' ? history : null,
        action === 'approve' ? null : history,
        action === 'approve' ? h.reviewer : h.actor,
        randomUUID(),
        'local-tty-confirmation-v1',
        'a'.repeat(64),
        h.reason,
        h.created_at,
        JSON.stringify({ synthetic_fixture: true, same_uid_boundary: false }),
      );
  };
  const add = (d: RetrievalDraft) => {
    const scope = d.scope ?? f.scope;
    const latest = f.db
      .prepare(
        'SELECT MAX(v.version) AS n FROM skill_versions v JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id WHERE k.name=? AND k.project_id=?',
      )
      .get(d.name, scope.id) as { n: number | null };
    const candidate = new SkillProposalService(f.db, scope, 'codex').propose({
      name: d.name,
      description: d.description,
      expected_latest_version: latest.n ?? 0,
      source_experience_ids: [scope.id === f.scope.id ? f.approvedSource.id : foreignSource.id],
      files: [
        {
          path: 'SKILL.md',
          content: `---\nname: ${d.name}\ndescription: ${d.description}\n---\n# Goal\nApply the scoped workflow.\n# When to use\n${d.description}\n# Procedure\n${d.body ?? 'Inspect the named scenario and retain unresolved outcomes.'}\n# Verification\nCheck task-specific acceptance criteria; no verified task success is implied.\n`,
        },
        ...(d.resources ?? []),
      ],
    });
    if (d.activate !== false) {
      new SkillEvaluationService(f.db, scope).evaluate({
        version_id: candidate.version.id,
        expected_content_hash: candidate.version.content_hash,
        expected_state_revision: 0,
      });
      const approved = f.review(candidate.version.id);
      audit(candidate.version.id, approved, 'approve', scope);
      const promotion = f.transition(candidate.identity.id, candidate.version.id);
      audit(candidate.version.id, promotion, 'promote', scope);
    }
    return new SkillStore(f.db, scope).get({ version_id: candidate.version.id });
  };
  return { ...f, add, audit, retrieval: new SkillRetrievalService(f.db, f.scope) };
}
