import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LearningReviewDecisions,
  LearningReviewService,
  localReviewCaller,
  SkillAuthoringService,
  SkillEvaluationService,
} from '../../packages/core/src/index.js';
import {
  CONTINUOUS_SUITE,
  CONTINUOUS_SUITE_DIGEST,
  runContinuousTask,
} from '../../scripts/continuous-fixture.mjs';
import {
  loadLearningFixture,
  saveLearningFixture,
  skillFixtureFiles,
} from '../../scripts/learning-fixture.mjs';
import { learningE2E } from './learning-e2e.js';
export type TraceEvent = {
  stage: string;
  timestamp: string;
  principal:
    | 'SIMULATED_CODEX_MCP'
    | 'SIMULATED_CLAUDE_MCP'
    | 'TEST_OPERATOR_AUTOMATION'
    | 'CONTROLLED_FIXTURE'
    | 'SERVICE';
  input_id: string | null;
  output_id: string | null;
  content_digest: string | null;
  evidence: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'NOT VERIFIED';
};
export class AcceptanceTrace {
  readonly events: TraceEvent[] = [];
  constructor(readonly scenario: string) {}
  record(event: Omit<TraceEvent, 'timestamp'>) {
    if (this.events.length >= 100) throw Error('Trace event limit.');
    if (event.content_digest !== null && !/^[a-f0-9]{64}$/.test(event.content_digest))
      throw Error('Trace digest format.');
    const {
      stage,
      principal,
      input_id,
      output_id,
      content_digest,
      evidence,
      expected,
      actual,
      status,
    } = event;
    if ([stage, evidence, expected, actual].some((s) => s.length > 1024))
      throw Error('Trace field limit.');
    this.events.push({
      stage,
      principal,
      input_id,
      output_id,
      content_digest,
      evidence,
      expected,
      actual,
      status,
      timestamp: new Date().toISOString(),
    });
  }
  export(
    directory: string,
    status: 'PASS' | 'FAIL' | 'NOT VERIFIED',
    extra: Record<string, unknown> = {},
  ) {
    const data = {
      schema_version: 1,
      scenario: this.scenario,
      status,
      evidence_level: 'LEVEL_1_OFFLINE',
      suite: CONTINUOUS_SUITE,
      suite_digest: CONTINUOUS_SUITE_DIGEST,
      native_codex: 'NOT VERIFIED',
      cross_cli: 'NOT VERIFIED',
      human_approval: 'AUTOMATED TEST OPERATOR; not a human or OS-isolation claim',
      ...extra,
      events: this.events,
    };
    writeFileSync(join(directory, `${this.scenario}.json`), JSON.stringify(data, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    return data;
  }
}
export async function continuousLearning() {
  const f = await learningE2E({ continuous: true });
  const marker = loadLearningFixture(f.root);
  marker.continuous = {
    schema: 1,
    suite: CONTINUOUS_SUITE,
    suite_digest: CONTINUOUS_SUITE_DIGEST,
    stage: 'offline',
  };
  saveLearningFixture(marker);
  const client = await f.connect('codex');
  const capture = async (reuse = false) => {
    const existing = reuse
      ? await f.call(client, 'experience_search', { query: 'Clamp regression' })
      : null;
    const experience = existing?.experiences[0] ?? (await f.capture());
    const signal = await f.call(client, 'learning_signal_record', {
      schema_version: 1,
      type: 'PROBLEM_SOLVED',
      title: 'Numeric clamp lower boundary repair',
      summary:
        'A reproducible numeric clamp utility lost lower-bound handling; preserve both boundaries and verify zero and in-range values.',
      experience_ids: [experience.id],
      reusability: 'potentially_reusable',
      supporting_evidence: [
        {
          kind: 'test',
          reference: CONTINUOUS_SUITE,
          summary:
            'Actual code-owned test evidence is recorded separately; this reference remains an agent claim.',
        },
      ],
    });
    return { experience, signal };
  };
  const context = (experienceId: string, signalId: string, base?: string) =>
    f.call(client, 'skill_authoring_context', {
      signal_ids: [signalId],
      experience_ids: [experienceId],
      query: 'numeric clamp bounds',
      ...(base ? { target_version_id: base } : {}),
    });
  const draft = (
    ctx: { id: string; context_digest: string },
    patch: Record<string, unknown> = {},
  ) => ({
    schema_version: 1,
    request_id: randomUUID(),
    context_id: ctx.id,
    context_digest: ctx.context_digest,
    type: 'CREATE_NEW',
    name: f.fixture.name,
    description: 'Check lower and upper bounds in a numeric clamp utility',
    rationale:
      'Fixture-generated reusable procedure preserves the observed numeric clamp boundary lesson for separately reviewed tasks.',
    expected_improvement: 'Explicit lower and upper boundary checks may reduce omitted cases.',
    known_limitations: [
      'Fixture-generated authoring, not model output. Static evaluation does not establish behavior.',
    ],
    files: skillFixtureFiles(f.fixture),
    ...patch,
  });
  const submit = (input: Record<string, unknown>) =>
    f.call(client, 'skill_authoring_submit', input);
  const authoring = new SkillAuthoringService(f.db, f.scope, 'codex');
  const review = new LearningReviewService(f.db, f.scope);
  const decisions = new LearningReviewDecisions(f.db, f.scope, localReviewCaller());
  const decide = (id: string, decision = 'MARK_REVIEWED') => {
    const s = review.get({ proposal_id: id });
    return decisions.decide({
      proposal_id: id,
      request_id: randomUUID(),
      expected_snapshot_digest: s.snapshot_digest,
      candidate_digest: s.candidate_digest,
      decision,
      reason: 'AUTOMATED DISPOSABLE P3-007 ADVISORY REVIEW; not human approval.',
    });
  };
  const evaluate = (id: string, mode: 'static' | 'behavioral' = 'static') => {
    const v = f.store.getVersion(id);
    return new SkillEvaluationService(f.db, f.scope).evaluate({
      version_id: id,
      expected_content_hash: v.version.content_hash,
      expected_state_revision: v.state.revision,
      mode,
    });
  };
  const learned = async () => {
    const source = await capture();
    const approval = await f.approveExperience(source.experience);
    if (approval.status !== 0) throw Error('Offline source review failed.');
    const ctx = await context(source.experience.id, source.signal.id);
    const proposal = await submit(draft(ctx));
    if (!proposal.proposal_id) throw Error('Offline candidate rejected.');
    const evaluation = evaluate(proposal.candidate_version_id);
    if (evaluation.evaluation.result !== 'PASS') throw Error('Static contract fixture failed.');
    decide(proposal.proposal_id, 'RECOMMEND_FOR_APPROVAL');
    for (const action of ['approve', 'promote']) {
      const r = await f.operator(action, proposal.candidate_version_id);
      if (r.status !== 0) throw Error('Offline terminal operation failed.');
    }
    return { ...source, ctx, proposal, evaluation };
  };
  return {
    ...f,
    client,
    capture,
    context,
    draft,
    submit,
    authoring,
    review,
    decisions,
    decide,
    evaluate,
    learned,
    task: (task: 'primary' | 'transfer', mode: 'baseline' | 'reference') =>
      runContinuousTask(f.root, task, mode),
  };
}
