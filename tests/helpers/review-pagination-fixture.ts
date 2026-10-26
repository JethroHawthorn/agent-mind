import { randomUUID } from 'node:crypto';
import {
  LearningReviewDecisions,
  LearningReviewService,
  localReviewCaller,
  SkillAuthoringService,
} from '../../packages/core/src/index.js';
import { authoringFixture } from './authoring-fixture.js';

/** Public authoring/decision services with disposable, synthetic approved experience provenance. */
export function reviewPaginationFixture(count = 101) {
  const f = authoringFixture();
  try {
    for (let i = 0; i < count; i++) {
      const service = new SkillAuthoringService(f.db, f.scope, 'codex');
      const context = service.context(f.contextRequest),
        name = `shader-pagination-${i}`;
      const draft = f.draft({
        name,
        context_id: context.id,
        context_digest: context.context_digest,
      });
      if (!draft.files) throw Error('fixture files');
      draft.files = draft.files.map((file) => ({
        ...file,
        content: file.content.replaceAll('shader-adjacency', name),
      }));
      const result = service.submit(draft);
      if (!('proposal_id' in result)) throw Error('fixture candidate');
    }
    const read = new LearningReviewService(f.db, f.scope);
    const decisions = new LearningReviewDecisions(f.db, f.scope, localReviewCaller());
    const ids = (
      f.db
        .prepare('SELECT id FROM authoring_proposals WHERE project_id=? ORDER BY created_at,id')
        .all(f.scope.id) as { id: string }[]
    ).map((r) => r.id);
    const decide = (id: string, decision = 'DEFER') => {
      const snapshot = read.get({ proposal_id: id });
      return decisions.decide({
        proposal_id: id,
        request_id: randomUUID(),
        expected_snapshot_digest: snapshot.snapshot_digest,
        candidate_digest: snapshot.candidate_digest,
        decision,
        reason: 'Disposable pagination test; no approval or activation.',
      });
    };
    const changeEvidence = () => {
      const s = f.learning.get({ signal_id: f.signal.id });
      return f.learning.record({
        schema_version: 1,
        type: s.type,
        title: s.title,
        summary: s.summary,
        reusability: s.reusability,
        experience_ids: s.experience_ids,
        supporting_evidence: [
          {
            kind: 'test',
            reference: 'pagination-second-observation',
            summary: 'Additional unverified evidence reference; no tests executed by this signal.',
          },
        ],
      });
    };
    return { ...f, read, ids, decide, changeEvidence };
  } catch (e) {
    f.close();
    throw e;
  }
}
