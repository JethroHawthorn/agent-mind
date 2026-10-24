import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SkillDistributionService,
  SkillEvaluationService,
  SkillProposalService,
} from '../../packages/core/src/index.js';
import { skillFixture } from './skill-fixture.js';

/** Synthetic approved history for filesystem tests. Not evidence of real human approval. */
export function distributionFixture(activate = true, name = 'agentmind-distribution-demo') {
  const f = skillFixture();
  const home = join(f.root, 'fake-home');
  mkdirSync(home);
  const proposals = new SkillProposalService(f.db, f.scope, 'codex');
  const evaluations = new SkillEvaluationService(f.db, f.scope);
  const propose = (extra = '') => {
    const latest = f.db
      .prepare(
        'SELECT MAX(version) AS n FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE name=? AND project_id=?)',
      )
      .get(name, f.scope.id) as { n: number | null };
    return proposals.propose({
      name,
      description: 'Harmless local distribution test guidance',
      expected_latest_version: latest.n ?? 0,
      source_experience_ids: [f.approvedSource.id],
      files: [
        {
          path: 'SKILL.md',
          content: `---\nname: ${name}\ndescription: Harmless local distribution test guidance\n---\n# Goal\nDescribe the harmless local fixture.\n# When to use\nOnly for AgentMind distribution verification.\n# Procedure\nRead [notes](references/notes.md). Do not run shell commands.\n# Verification\nReport the marker AGENTMIND_DISTRIBUTION_DEMO and observed version.\n${extra}`,
        },
        {
          path: 'references/notes.md',
          content: 'AGENTMIND_DISTRIBUTION_DEMO supporting file.\r\n',
        },
      ],
    });
  };
  const audit = (action: string, version: string, history: string) => {
    const row = f.db
      .prepare(
        `SELECT * FROM ${action === 'approve' ? 'skill_reviews' : 'skill_promotions'} WHERE id=?`,
      )
      .get(history) as Record<string, string>;
    const snapshot = f.store.getVersion(version);
    const evaluation = snapshot.state.latest_evaluation_id;
    const policy = (
      f.db
        .prepare('SELECT evaluator_version FROM skill_evaluations WHERE id=?')
        .get(evaluation) as { evaluator_version: string }
    ).evaluator_version;
    f.db
      .prepare(
        `INSERT INTO skill_operator_events (id,skill_id,project_id,version_id,content_hash,evaluation_id,evaluator_version,action,review_id,promotion_id,operator_id,session_id,authorization_method,context_digest,reason,created_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        snapshot.version.skill_id,
        f.scope.id,
        version,
        snapshot.version.content_hash,
        evaluation,
        policy,
        action,
        action === 'approve' ? history : null,
        action === 'approve' ? null : history,
        action === 'approve' ? row.reviewer : row.actor,
        randomUUID(),
        'local-tty-confirmation-v1',
        'a'.repeat(64),
        row.reason,
        row.created_at,
        JSON.stringify({ synthetic_fixture: true, same_uid_boundary: false }),
      );
  };
  const evaluate = (version: string) => {
    const r = f.store.getVersion(version);
    return evaluations.evaluate({
      version_id: version,
      expected_content_hash: r.version.content_hash,
      expected_state_revision: r.state.revision,
    });
  };
  const approve = (version: string) => {
    const id = f.review(version);
    audit('approve', version, id);
  };
  const promote = (version: string, action = 'promote') => {
    const v = f.store.getVersion(version);
    const id = f.transition(v.version.skill_id, version, action);
    audit(action, version, id);
  };
  const candidate = propose();
  if (activate) {
    evaluate(candidate.version.id);
    approve(candidate.version.id);
    promote(candidate.version.id);
  }
  const service = new SkillDistributionService(f.db, f.scope, home);
  const request = {
    skill_id: candidate.identity.id,
    target: 'all' as const,
    scope: 'project' as const,
  };
  return { ...f, home, candidate, propose, evaluate, approve, promote, service, request, audit };
}
