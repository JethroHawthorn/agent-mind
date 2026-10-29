import { afterEach, expect, it } from 'vitest';
import {
  BEHAVIORAL_POLICY,
  behavioralDigest,
  compareBehavioralContract,
  listBehavioralSuites,
  migrateBehavioral,
  openDatabase,
  SkillEvaluationService,
  SkillOperatorService,
  SkillReviewService,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
const selected = () => {
  const s = listBehavioralSuites()[0];
  if (!s) throw new Error('fixture suite missing');
  return { suite_id: s.definition.id, suite_version: s.definition.version, suite_digest: s.digest };
};
const good = () => ({
  status: 'complete',
  outputs: [
    { task_id: 'lower', value: 0 },
    { task_id: 'upper', value: 10 },
    { task_id: 'in-range', value: 6 },
    { task_id: 'zero', value: 0 },
  ],
});
/** Synthetic observations test comparison logic only. They are never persisted as trusted executions. */
it.each(['identical', 'improvement', 'markdown-only', 'optional-failure'])(
  'compares %s contract data without granting behavioral approval',
  (kind) => {
    const baseline = good(),
      candidate = good();
    if (kind === 'improvement') baseline.outputs[0] = { task_id: 'lower', value: -4 };
    if (kind === 'optional-failure') candidate.outputs[3] = { task_id: 'zero', value: 9 };
    const r = compareBehavioralContract({ ...selected(), baseline, candidate });
    expect(r.comparison_result).toBe('PASS');
    expect(r.authorization_result).toBe('NOT_VERIFIED');
  },
);
it('detects a mandatory numeric regression independently of unchanged text', () => {
  const candidate = good();
  candidate.outputs[0] = { task_id: 'lower', value: -4 };
  expect(compareBehavioralContract({ ...selected(), baseline: good(), candidate })).toMatchObject({
    comparison_result: 'FAIL',
    authorization_result: 'NOT_VERIFIED',
  });
});
it.each(['baseline', 'candidate', 'timeout', 'interrupted', 'missing-output', 'duplicate-output'])(
  'keeps incomplete %s contract observations unverified',
  (kind) => {
    const candidate = good();
    if (kind === 'missing-output') candidate.outputs.shift();
    if (kind === 'duplicate-output') candidate.outputs.push({ task_id: 'lower', value: 0 });
    const r = compareBehavioralContract({
      ...selected(),
      baseline: kind === 'baseline' ? null : good(),
      candidate:
        kind === 'candidate'
          ? null
          : {
              ...candidate,
              status:
                kind === 'timeout'
                  ? 'timeout'
                  : kind === 'interrupted'
                    ? 'interrupted'
                    : 'complete',
            },
    });
    expect(r).toMatchObject({
      comparison_result: 'NOT_VERIFIED',
      authorization_result: 'NOT_VERIFIED',
    });
  },
);
it('rejects tampered/unsupported suites and cannot mutate release-owned acceptance criteria', () => {
  const copy = listBehavioralSuites()[0];
  if (!copy) throw new Error('missing suite');
  const task = copy.definition.tasks[0];
  if (!task) throw new Error('missing task');
  task.expected = 99;
  expect(listBehavioralSuites()[0]?.digest).toBe(selected().suite_digest);
  expect(behavioralDigest(copy.definition)).not.toBe(selected().suite_digest);
  expect(() =>
    compareBehavioralContract({
      ...selected(),
      suite_digest: '0'.repeat(64),
      baseline: good(),
      candidate: good(),
    }),
  ).toThrow('digest');
  expect(
    compareBehavioralContract({
      ...selected(),
      suite_version: 999,
      baseline: good(),
      candidate: good(),
    }),
  ).toMatchObject({ comparison_result: 'NOT_VERIFIED' });
  expect(() =>
    compareBehavioralContract({
      ...selected(),
      definition: copy.definition,
      baseline: good(),
      candidate: good(),
    }),
  ).toThrow();
});
function fixture(active = true) {
  const f = distributionFixture(active);
  cleanup.push(f.close);
  const candidate = active
    ? f.propose('Changed Markdown, not evidence of a behavior change.')
    : f.candidate;
  const service = new SkillEvaluationService(f.db, f.scope);
  const request = () => ({
    version_id: candidate.version.id,
    expected_content_hash: candidate.version.content_hash,
    expected_state_revision: f.store.getVersion(candidate.version.id).state.revision,
    mode: 'behavioral' as const,
  });
  return { ...f, candidate, service, request };
}
it('persists exact candidate/baseline/suite evidence with V1 continuously active and blocks incomplete approval', () => {
  const f = fixture();
  const v1 = f.store.getIdentity(f.candidate.identity.id).active_version_id;
  const report = f.service.evaluate(f.request());
  expect(report.evaluation).toMatchObject({
    result: 'NOT_VERIFIED',
    evaluator_version: BEHAVIORAL_POLICY,
    baseline_version_id: v1,
    regression_result: 'NOT_VERIFIED',
  });
  expect(report.behavioral).toMatchObject({
    candidate: { version_id: f.candidate.version.id, digest: f.candidate.version.content_hash },
    execution: { backend: 'disabled', candidate_observation: null, baseline_observation: null },
    execution_verified: false,
  });
  expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(v1);
  const operator = new SkillOperatorService(f.db, f.scope);
  expect(() => operator.prepare({ action: 'approve', version_id: f.candidate.version.id })).toThrow(
    'No accepted isolated',
  );
  expect(() =>
    operator.prepare({ action: 'promote', version_id: f.candidate.version.id }),
  ).toThrow();
  expect(
    new SkillReviewService(f.db, f.scope).evaluation({ version_id: f.candidate.version.id }),
  ).toHaveProperty('behavioral');
});
it('records missing baseline and unsupported suite as NOT VERIFIED, never a successful comparison', () => {
  const f = fixture(false);
  const r = f.service.evaluate({ ...f.request(), suite_id: 'unknown-suite', suite_version: 1 });
  expect(r.evaluation.result).toBe('NOT_VERIFIED');
  expect(r.behavioral?.baseline).toBe(null);
  expect(r.behavioral?.suite).toBe(null);
});
it.each([
  { result: 'PASS' },
  { observations: good() },
  { command: 'run something' },
  { baseline_version_id: 'fake' },
  { project_id: 'foreign' },
  { suite_definition: { required: false } },
])('rejects forged evidence/authority inputs %j', (extra) => {
  const f = fixture();
  expect(() => f.service.evaluate({ ...f.request(), ...extra })).toThrow();
});
it('checks candidate and suite digests before storing and refuses foreign projects', () => {
  const f = fixture();
  expect(() =>
    f.service.evaluate({ ...f.request(), expected_content_hash: '0'.repeat(64) }),
  ).toThrow('hash');
  expect(() =>
    f.service.evaluate({ ...f.request(), expected_suite_digest: '0'.repeat(64) }),
  ).toThrow('digest');
  expect(() => new SkillEvaluationService(f.db, f.otherScope).evaluate(f.request())).toThrow();
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM skill_evaluations WHERE version_id=?')
      .get(f.candidate.version.id),
  ).toEqual({ n: 0 });
});
it('persists immutable evidence across restart and refuses missing evidence', () => {
  const f = fixture();
  const r = f.service.evaluate(f.request());
  const db = openDatabase(f.path);
  try {
    expect(
      new SkillEvaluationService(db, f.scope).getReport({ evaluation_id: r.evaluation.id }),
    ).toEqual(r);
  } finally {
    db.close();
  }
  for (const sql of [
    'UPDATE behavioral_evidence SET evidence_digest=evidence_digest',
    'DELETE FROM behavioral_evidence',
    'INSERT OR REPLACE INTO behavioral_evidence SELECT * FROM behavioral_evidence',
  ])
    expect(() => f.db.exec(sql)).toThrow('immutable');
  f.db.exec('DROP TRIGGER behavioral_evidence_no_delete;DELETE FROM behavioral_evidence');
  expect(() => f.service.getReport({ evaluation_id: r.evaluation.id })).toThrow('missing');
  expect(() =>
    new SkillOperatorService(f.db, f.scope).prepare({
      action: 'approve',
      version_id: f.candidate.version.id,
    }),
  ).toThrow();
});
it('rejects suite tampering, unknown migration versions and preserves core registry compatibility', () => {
  const f = fixture();
  const r = f.service.evaluate(f.request());
  expect(f.db.pragma('user_version', { simple: true })).toBe(12);
  expect(() => f.db.exec("UPDATE behavioral_suites SET definition_json='{}'")).toThrow('immutable');
  f.db.exec(
    "DROP TRIGGER behavioral_suites_no_update;UPDATE behavioral_suites SET definition_json='{}'",
  );
  expect(() => f.service.getReport({ evaluation_id: r.evaluation.id })).toThrow('verification');
  f.db.exec('PRAGMA ignore_check_constraints=ON;UPDATE behavioral_schema SET version=2');
  expect(() => migrateBehavioral(f.db)).toThrow('Unknown');
});
it('rolls back failed evidence persistence without changing V1, state revision or evaluation history', () => {
  const f = fixture();
  migrateBehavioral(f.db);
  const before = f.store.getVersion(f.candidate.version.id);
  f.db.exec(
    "CREATE TRIGGER fixture_be_fault BEFORE INSERT ON behavioral_evidence BEGIN SELECT RAISE(ABORT,'injected evidence failure');END",
  );
  expect(() => f.service.evaluate(f.request())).toThrow('injected');
  expect(f.store.getVersion(f.candidate.version.id)).toEqual(before);
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM skill_evaluations WHERE version_id=?')
      .get(f.candidate.version.id),
  ).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER fixture_be_fault');
  expect(f.service.evaluate(f.request()).evaluation.result).toBe('NOT_VERIFIED');
});
it('rejects a forged behavioral PASS lacking independently collected execution evidence', () => {
  const f = fixture();
  const id = f.evaluation(f.candidate.version.id, 'PASS', {
    evaluator: 'agentmind-deterministic',
    evaluator_version: BEHAVIORAL_POLICY,
  });
  expect(() =>
    new SkillOperatorService(f.db, f.scope).prepare({
      action: 'approve',
      version_id: f.candidate.version.id,
    }),
  ).toThrow();
  expect(() => f.service.getReport({ evaluation_id: id })).toThrow('missing');
});

it('rejects actual supporting-file mutation after evaluation', () => {
  const f = fixture();
  const report = f.service.evaluate(f.request());
  f.db.exec('DROP TRIGGER skill_versions_immutable_update');
  const files = f.candidate.version.files.map((file) =>
    file.path === 'SKILL.md' ? file : { ...file, content: 'changed supporting bytes' },
  );
  f.db
    .prepare('UPDATE skill_versions SET files_json=? WHERE id=?')
    .run(JSON.stringify(files), f.candidate.version.id);
  expect(() => f.service.getReport({ evaluation_id: report.evaluation.id })).toThrow(
    'verification',
  );
});
