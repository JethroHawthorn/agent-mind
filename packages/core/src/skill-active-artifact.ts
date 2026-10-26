import type Database from 'better-sqlite3';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import { SkillOperatorService } from './skill-operator.js';
import { SkillStore } from './skill-store.js';

/** Read-only, common distribution/retrieval eligibility. Does not create an operator grant. */
export function resolveActiveArtifact(db: Database.Database, scope: ProjectScope, skillId: string) {
  return db.transaction(() => {
    const identity = new SkillStore(db, scope).getIdentity(skillId);
    if (!identity.active_version_id)
      throw new AgentMindError('SKILL_NOT_FOUND', 'No eligible active artifact in this project.');
    const { review } = new SkillOperatorService(db, scope).prepare({
      action: 'promote',
      version_id: identity.active_version_id,
    });
    const event = db
      .prepare(
        `SELECT id FROM skill_operator_events WHERE project_id=? AND version_id=? AND promotion_id=? AND action IN ('promote','rollback') AND content_hash=? AND authorization_method='local-tty-confirmation-v1'`,
      )
      .get(
        scope.id,
        identity.active_version_id,
        identity.last_transition_id,
        review.version.content_hash,
      );
    if (!event)
      throw new AgentMindError(
        'OPERATOR_APPROVAL_REQUIRED',
        'Active transition lacks operator provenance.',
      );
    return { review };
  })();
}
