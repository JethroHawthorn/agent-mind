import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import { fileDigest } from '../../packages/core/src/authoring/patch.js';
import {
  brokerRequest,
  hashSkillFiles,
  openUsageDatabase,
  RecommendationService,
  SkillDistributionService,
  SkillOperatorService,
} from '../../packages/core/src/index.js';
import { AcceptanceTrace, continuousLearning } from '../helpers/continuous-learning.js';

const resultsRoot =
  process.env.AGENTMIND_P3_007_OUTPUT ??
  realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-p3-007-results-')));
if (realpathSync(resultsRoot) !== resultsRoot || readdirSync(resultsRoot).length)
  throw Error('Acceptance output must be a fresh canonical empty directory.');
const cleanup: Array<() => Promise<void>> = [];
const summaries: Array<{ scenario: string; status: string }> = [];
const expectedScenarios = [
  'A-new-skill',
  'B-blocked-upgrade',
  'C-unsafe-learning',
  'D-duplicates',
  'E-scope-integrity',
  'F-failure-recovery',
  'rollback-compatibility',
  'distribution-recovery',
];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(() =>
  writeFileSync(
    join(resultsRoot, 'p3-007-summary.json'),
    JSON.stringify(
      {
        schema: 1,
        evidence_level: 'LEVEL_1_OFFLINE',
        overall:
          summaries.length !== expectedScenarios.length ||
          summaries.some((s) => s.status === 'FAIL')
            ? 'FAIL'
            : summaries.some((s) => s.status !== 'PASS')
              ? 'NOT VERIFIED'
              : 'PASS',
        missing_scenarios: expectedScenarios.filter(
          (name) => !summaries.some((s) => s.scenario === name),
        ),
        scenarios: summaries,
        native_codex: 'NOT VERIFIED',
        cross_cli: 'NOT VERIFIED',
        effectiveness: 'Illustrative code-owned reference tests, not observed model learning.',
        protected_deployment: 'NOT VERIFIED',
        autonomous_activation: 'NO-GO',
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  ),
);
async function fixture() {
  const f = await continuousLearning();
  cleanup.push(f.cleanup);
  return f;
}
function record(
  trace: AcceptanceTrace,
  stage: string,
  input: string | null,
  output: string | null,
  digest: string | null,
  actual: string,
  principal:
    | 'SIMULATED_CODEX_MCP'
    | 'SIMULATED_CLAUDE_MCP'
    | 'TEST_OPERATOR_AUTOMATION'
    | 'CONTROLLED_FIXTURE'
    | 'SERVICE' = 'SERVICE',
  status: 'PASS' | 'FAIL' | 'NOT VERIFIED' = 'PASS',
) {
  trace.record({
    stage,
    principal,
    input_id: input,
    output_id: output,
    content_digest: digest,
    evidence:
      principal === 'TEST_OPERATOR_AUTOMATION'
        ? 'SIMULATED_OPERATOR'
        : principal === 'SIMULATED_CODEX_MCP' || principal === 'SIMULATED_CLAUDE_MCP'
          ? 'MCP_INTEGRATION'
          : 'CODE_OWNED_TEST',
    expected: actual,
    actual,
    status,
  });
}
function finish(
  t: AcceptanceTrace,
  status: 'PASS' | 'NOT VERIFIED',
  extra: Record<string, unknown> = {},
) {
  t.export(resultsRoot, status, extra);
  summaries.push({ scenario: t.scenario, status });
}
it('A: offline signal → genuine stored evidence links → fixture proposal → static evaluation → simulated terminal approval → pinned retrieval → independent reference task', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('A-new-skill');
  const baseline = f.task('primary', 'baseline'),
    fixed = f.task('primary', 'reference');
  expect(baseline.exit_code).toBe(1);
  expect(fixed.exit_code).toBe(0);
  record(
    t,
    'task-primary-reference',
    null,
    null,
    fixed.source_digest,
    '4 code-owned boundary assertions passed',
    'CONTROLLED_FIXTURE',
  );
  const source = await f.capture();
  expect(source.experience.verification_status).toBe('unverified');
  record(
    t,
    'experience',
    null,
    source.experience.id,
    null,
    'candidate/unverified claim preserved',
    'SIMULATED_CODEX_MCP',
  );
  record(
    t,
    'learning-signal',
    source.experience.id,
    source.signal.id,
    null,
    'agent-reported signal linked to stored experience',
    'SIMULATED_CODEX_MCP',
  );
  expect((await f.approveExperience(source.experience)).status).toBe(0);
  record(
    t,
    'source-review',
    source.experience.id,
    source.experience.id,
    null,
    'automated disposable local review',
    'TEST_OPERATOR_AUTOMATION',
  );
  const ctx = await f.context(source.experience.id, source.signal.id);
  expect(ctx.decision).toBe('NO_BOUNDED_MATCH');
  record(
    t,
    'authoring-context',
    source.signal.id,
    ctx.id,
    ctx.context_digest,
    'bounded linked context',
    'SIMULATED_CODEX_MCP',
  );
  const draft = f.draft(ctx),
    proposal = await f.submit(draft);
  expect(proposal.validation.validation_result).toBe('VALID');
  expect(proposal.provenance.signal_ids).toContain(source.signal.id);
  expect(proposal.provenance.experience_ids).toContain(source.experience.id);
  record(
    t,
    'fixture-authored-create',
    ctx.id,
    proposal.candidate_version_id,
    proposal.content_digest,
    'immutable candidate; not AI authorship',
    'SIMULATED_CODEX_MCP',
  );
  const evaluation = f.evaluate(proposal.candidate_version_id);
  expect(evaluation.evaluation.result).toBe('PASS');
  expect(evaluation.capabilities.execution_supported).toBe(false);
  expect(evaluation.evaluation.content_hash).toBe(proposal.content_digest);
  record(
    t,
    'static-evaluation',
    proposal.candidate_version_id,
    evaluation.evaluation.id,
    proposal.content_digest,
    'static PASS; behavior NOT VERIFIED',
  );
  const review = f.review.get({ proposal_id: proposal.proposal_id });
  expect(review.evidence.signals[0]?.id).toBe(source.signal.id);
  expect(review.authoring.diff.some((d) => d.path === 'SKILL.md')).toBe(true);
  f.decide(proposal.proposal_id, 'RECOMMEND_FOR_APPROVAL');
  record(
    t,
    'advisory-review',
    proposal.proposal_id,
    review.snapshot_digest,
    proposal.content_digest,
    'recommendation is not approval',
  );
  expect((await f.operator('promote', proposal.candidate_version_id)).status).toBe(1);
  expect(() =>
    new SkillOperatorService(f.db, f.scope).commit(
      { action: 'approve', version_id: proposal.candidate_version_id },
      { session: 'forged' },
    ),
  ).toThrow();
  for (const action of ['approve', 'promote']) {
    expect((await f.operator(action, proposal.candidate_version_id)).status).toBe(0);
    const audit = f.db
      .prepare('SELECT id FROM skill_operator_events WHERE version_id=? AND action=?')
      .get(proposal.candidate_version_id, action) as { id: string };
    record(
      t,
      action,
      proposal.candidate_version_id,
      audit.id,
      proposal.content_digest,
      'existing terminal workflow; automated test consent only',
      'TEST_OPERATOR_AUTOMATION',
    );
  }
  const sdk = await f.connect('claude'),
    search = await f.call(sdk, 'skill_discover', { query: 'numeric clamp bounds' });
  expect(search.skills[0].active_version_id).toBe(proposal.candidate_version_id);
  const pin = {
    skill_id: proposal.skill_id,
    expected_version_id: proposal.candidate_version_id,
    expected_digest: proposal.content_digest,
  };
  const loaded = await f.call(sdk, 'skill_load', pin),
    resource = await f.call(sdk, 'skill_resource_get', { ...pin, path: 'references/notes.md' });
  expect(loaded.version_id).toBe(resource.version_id);
  expect(loaded.content).toContain('Math.min(Math.max(value, min), max)');
  record(
    t,
    'pinned-retrieval',
    proposal.skill_id,
    loaded.version_id,
    loaded.content_digest,
    'separate SDK session, not native Claude',
    'SIMULATED_CLAUDE_MCP',
  );
  const secondBaseline = f.task('transfer', 'baseline'),
    secondReference = f.task('transfer', 'reference');
  expect(secondBaseline.exit_code).toBe(1);
  expect(secondReference.exit_code).toBe(0);
  record(
    t,
    'independent-reference-task',
    loaded.version_id,
    null,
    secondReference.source_digest,
    'reference retry-delay task passed; model application not observed',
    'CONTROLLED_FIXTURE',
  );
  const reopened = openUsageDatabase(f.path);
  try {
    expect(
      reopened.prepare('SELECT active_version_id FROM skills WHERE id=?').get(proposal.skill_id),
    ).toEqual({ active_version_id: proposal.candidate_version_id });
  } finally {
    reopened.close();
  }
  finish(t, 'PASS', {
    authoring: 'FIXTURE_GENERATED',
    approval: 'AUTOMATED_PTY_TEST',
    task_evidence: { baseline, fixed, secondBaseline, secondReference },
    model_application: 'NOT VERIFIED',
    causal_improvement: 'NOT VERIFIED',
    context_bytes: {
      context: Buffer.byteLength(JSON.stringify(ctx)),
      discovery: Buffer.byteLength(JSON.stringify(search)),
      main: Buffer.byteLength(JSON.stringify(loaded)),
      resource: Buffer.byteLength(JSON.stringify(resource)),
    },
  });
}, 30000);
it('B: blocked changed V2 preserves active V1 and truthful NOT VERIFIED behavioral evidence', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('B-blocked-upgrade'),
    a = await f.learned();
  const original = f.store.getVersion(a.proposal.candidate_version_id);
  const md = original.version.files.find((x) => x.path === 'SKILL.md');
  if (!md) throw Error('fixture');
  const gap = await f.call(f.client, 'learning_signal_record', {
    schema_version: 1,
    type: 'SKILL_GAP',
    title: 'Inverted clamp interval needs investigation',
    summary:
      'The reference clamp returns the upper boundary for inverted bounds; investigate explicit interval validation without claiming a verified repair.',
    experience_ids: [a.experience.id],
    version_ids: [original.version.id],
    reusability: 'potentially_reusable',
  });
  expect(Math.min(Math.max(5, 10), 0)).toBe(0);
  record(
    t,
    'gap-signal',
    original.version.id,
    gap.id,
    original.version.content_hash,
    'code-owned inverted-range counterexample; incomplete repair evidence',
    'SIMULATED_CODEX_MCP',
  );
  const context = await f.context(a.experience.id, gap.id, original.version.id);
  expect(context.decision).toBe('EXPLICIT_TARGET');
  const draft = f.draft(context, {
    type: 'PATCH_EXISTING',
    target_skill_id: original.version.skill_id,
    target_version_id: original.version.id,
    expected_base_digest: original.version.content_hash,
    operations: [
      {
        op: 'replace',
        path: 'SKILL.md',
        expected_file_digest: fileDigest(md.content),
        old_text: 'Check lower-bound, upper-bound, zero and in-range cases.',
        new_text:
          'Check lower-bound, upper-bound, zero and in-range cases; investigate inverted bounds before applying the formula.',
      },
    ],
  });
  delete (draft as Partial<typeof draft>).files;
  const v2 = await f.submit(draft);
  expect(v2.content_digest).not.toBe(original.version.content_hash);
  record(
    t,
    'patch-candidate',
    original.version.id,
    v2.candidate_version_id,
    v2.content_digest,
    'exact base, new immutable candidate; V1 still active',
    'SIMULATED_CODEX_MCP',
  );
  const staticReport = f.evaluate(v2.candidate_version_id);
  expect(staticReport.evaluation.result).toBe('NOT_VERIFIED');
  const behavioral = f.evaluate(v2.candidate_version_id, 'behavioral');
  expect(behavioral.evaluation.result).toBe('NOT_VERIFIED');
  expect(behavioral.capabilities.execution_supported).toBe(false);
  record(
    t,
    'behavioral-evaluation',
    v2.candidate_version_id,
    behavioral.evaluation.id,
    v2.content_digest,
    'NOT VERIFIED: executable isolation backend unavailable',
    'SERVICE',
    'NOT VERIFIED',
  );
  const diff = f.review.diff({ proposal_id: v2.proposal_id, path: 'SKILL.md' });
  expect('after' in diff && diff.after?.content).toContain('inverted bounds');
  expect(() => f.decide(v2.proposal_id, 'RECOMMEND_FOR_APPROVAL')).toThrow();
  expect((await f.operator('approve', v2.candidate_version_id)).status).toBe(1);
  record(
    t,
    'approval-denied',
    v2.candidate_version_id,
    null,
    v2.content_digest,
    'existing approval gate refused incomplete evidence',
  );
  expect(f.store.getIdentity(original.version.skill_id).active_version_id).toBe(
    original.version.id,
  );
  expect(f.store.getVersion(original.version.id)).toEqual(original);
  const result = await f.call(f.client, 'skill_load', {
    skill_id: original.version.skill_id,
    expected_version_id: original.version.id,
    expected_digest: original.version.content_hash,
  });
  expect(result.version_id).toBe(original.version.id);
  finish(t, 'NOT VERIFIED', {
    changed_v2_promotion: 'NOT VERIFIED',
    v2_reuse: 'NOT VERIFIED',
    v1_preserved: true,
    approval_failure_enforced: true,
  });
}, 30000);
it('C: unsafe/forged learning never gains activation, with denial evidence retained in the trace', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('C-unsafe-learning');
  const { experience, signal } = await f.capture();
  expect((await f.approveExperience(experience)).status).toBe(0);
  const ctx = await f.context(experience.id, signal.id);
  const before = f.db.prepare('SELECT COUNT(*) n FROM skill_versions').get();
  const request = f.draft(ctx);
  for (const [name, change] of [
    ['unsafe-path', { files: [{ path: '../escape.md', content: 'unsafe' }] }],
    ['forged-digest', { content_digest: 'f'.repeat(64) }],
    ['forged-approval', { approved: true }],
  ] as const) {
    await expect(f.submit({ ...request, ...change, request_id: randomUUID() })).rejects.toThrow();
    record(t, name, ctx.id, null, null, 'request rejected; no candidate created');
  }
  const secret = structuredClone(request);
  if (!secret.files[0]) throw Error('fixture main file');
  secret.files[0].content += '\napi_key=sk-proj-abcdefghijklmnopqrstuv';
  const invalid = await f.submit(secret);
  expect(invalid.stored).toBe(false);
  expect(invalid.status).toBe('VALIDATION_FAILED');
  record(t, 'secret-rejected', ctx.id, null, null, 'VALIDATION_FAILED; unsafe bytes not persisted');
  await expect(f.context(randomUUID(), signal.id)).rejects.toThrow();
  expect(f.db.prepare('SELECT COUNT(*) n FROM skill_versions').get()).toEqual(before);
  const p = await f.submit(f.draft(ctx));
  expect((await f.call(f.client, 'skill_discover', { query: 'numeric clamp' })).skills).toEqual([]);
  expect((await f.operator('reject', p.candidate_version_id)).status).toBe(0);
  expect((await f.call(f.client, 'skill_discover', { query: 'numeric clamp' })).skills).toEqual([]);
  expect((await f.operator('promote', p.candidate_version_id)).status).toBe(1);
  const rejectionAudit = f.db
    .prepare("SELECT id FROM skill_operator_events WHERE version_id = ? AND action = 'reject'")
    .get(p.candidate_version_id) as { id: string };
  expect(rejectionAudit.id).toBeTruthy();
  record(
    t,
    'rejected-terminal-state',
    p.candidate_version_id,
    rejectionAudit.id,
    p.content_digest,
    'rejection audited; promotion denied',
  );
  const tools = (await f.client.listTools()).tools.map((x) => x.name);
  for (const name of ['skill_approve', 'skill_promote', 'review_decide', 'distribution_sync'])
    expect(tools).not.toContain(name);
  finish(t, 'PASS', { approval_bypass: false, unsafe_bytes_persisted: false });
}, 30000);
it('D: duplicate lessons resolve to existing evidence and existing-skill review without automatic consolidation', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('D-duplicates'),
    a = await f.learned();
  const duplicate = await f.capture(true);
  expect(duplicate.experience.id).toBe(a.experience.id);
  expect(duplicate.signal.id).toBe(a.signal.id);
  const ctx = await f.context(a.experience.id, a.signal.id);
  expect(ctx.matching_skills.some((x: { id: string }) => x.id === a.proposal.skill_id)).toBe(true);
  await expect(f.submit(f.draft(ctx))).rejects.toThrow(/Existing plausible skills/);
  record(
    t,
    'new-skill-suppressed',
    a.signal.id,
    a.proposal.skill_id,
    a.proposal.content_digest,
    'existing skill review required',
  );
  // Explicit legacy catalog fixture: a second already-approved identity permits P3-002 pair analysis.
  const original = f.store.getVersion(a.proposal.candidate_version_id),
    name = 'numeric-boundary-catalog';
  const legacy = await f.call(f.client, 'skill_propose', {
    name,
    description: original.version.description,
    source_experience_ids: [a.experience.id],
    files: original.version.files.map((x) => ({
      ...x,
      content: x.content.replace(`name: ${f.fixture.name}`, `name: ${name}`),
    })),
    expected_latest_version: 0,
  });
  f.evaluate(legacy.version.id);
  for (const action of ['approve', 'promote'])
    expect((await f.operator(action, legacy.version.id)).status).toBe(0);
  const curator = new RecommendationService(f.db, f.scope);
  const comparison = curator.compare({
    left_version_id: original.version.id,
    right_version_id: legacy.version.id,
  });
  expect(comparison.comparisons).toHaveLength(1);
  expect(['EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'POSSIBLE_OVERLAP']).toContain(
    comparison.comparisons[0]?.classification,
  );
  curator.analyzeDuplicates();
  const count = f.db.prepare('SELECT COUNT(*) n FROM curator_recommendations').get();
  curator.analyzeDuplicates();
  expect(f.db.prepare('SELECT COUNT(*) n FROM curator_recommendations').get()).toEqual(count);
  expect(f.store.getIdentity(a.proposal.skill_id).active_version_id).toBe(original.version.id);
  record(
    t,
    'overlap-analysis',
    original.version.id,
    legacy.version.id,
    original.version.content_hash,
    'advisory comparison only; rerun recommendation count stable',
  );
  finish(t, 'PASS', {
    initial_catalog: 'explicit test fixture; not P3-004 duplicate creation',
    comparison: comparison.comparisons[0]?.classification,
  });
}, 30000);
it('E: scope, complete package integrity and stale pins remain enforced across independent processes', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('E-scope-integrity'),
    a = await f.learned();
  const foreign = await f.connect('claude', true);
  expect((await f.call(foreign, 'skill_discover', { query: 'numeric clamp' })).skills).toEqual([]);
  await expect(f.call(foreign, 'skill_load', { skill_id: a.proposal.skill_id })).rejects.toThrow();
  const pin = {
    skill_id: a.proposal.skill_id,
    expected_version_id: a.proposal.candidate_version_id,
    expected_digest: a.proposal.content_digest,
  };
  await expect(
    f.call(f.client, 'skill_resource_get', { ...pin, path: '../escape' }),
  ).rejects.toThrow();
  await expect(
    f.call(f.client, 'skill_load', { ...pin, expected_digest: 'f'.repeat(64) }),
  ).rejects.toThrow();
  expect((await f.operator('deactivate', a.proposal.candidate_version_id)).status).toBe(0);
  await expect(f.call(f.client, 'skill_load', pin)).rejects.toThrow();
  expect((await f.operator('rollback', a.proposal.candidate_version_id)).status).toBe(0);
  expect((await f.call(f.client, 'skill_load', pin)).content_digest).toBe(
    a.proposal.content_digest,
  );
  const v = f.store.getVersion(a.proposal.candidate_version_id);
  expect(hashSkillFiles(v.version.files)).toBe(pin.expected_digest);
  record(
    t,
    'scoped-pinned-reads',
    a.proposal.skill_id,
    v.version.id,
    v.version.content_hash,
    'foreign, traversal and stale/invalid pins denied',
  );
  finish(t, 'PASS');
}, 30000);
it('F: interrupted candidate persistence, busy writes, unavailable broker and review conflicts recover safely', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('F-failure-recovery');
  const source = await f.capture();
  expect((await f.approveExperience(source.experience)).status).toBe(0);
  const ctx = await f.context(source.experience.id, source.signal.id),
    draft = f.draft(ctx);
  f.db.exec(
    "CREATE TRIGGER p3_007_candidate_fault BEFORE INSERT ON authoring_proposals BEGIN SELECT RAISE(ABORT,'controlled fault');END;",
  );
  await expect(f.submit(draft)).rejects.toThrow();
  expect(f.db.prepare('SELECT COUNT(*) n FROM skill_versions').get()).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER p3_007_candidate_fault');
  const p = await f.submit(draft);
  record(
    t,
    'candidate-transaction-recovery',
    ctx.id,
    p.candidate_version_id,
    p.content_digest,
    'failed candidate/provenance transaction rolled back; retry created one candidate',
  );
  const snapshot = f.review.get({ proposal_id: p.proposal_id }),
    decision = {
      proposal_id: p.proposal_id,
      request_id: randomUUID(),
      expected_snapshot_digest: snapshot.snapshot_digest,
      candidate_digest: snapshot.candidate_digest,
      decision: 'DEFER',
      reason: 'Disposable contention fixture.',
    };
  const lock = openUsageDatabase(f.path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    expect(() => f.decisions.decide(decision)).toThrow(/transaction failed/);
    lock.exec('ROLLBACK');
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
  expect(f.decisions.decide(decision).duplicate).toBe(false);
  expect(() =>
    f.decisions.decide({ ...decision, request_id: randomUUID(), decision: 'DISMISS' }),
  ).toThrow(/fresh snapshot/);
  await expect(
    brokerRequest(
      {
        schema_version: 1,
        broker_uid: 202,
        helper: join(f.root, 'absent-native-helper'),
        socket_directory: join(f.root, 'absent-socket'),
      },
      'agent',
      { schema_version: 1, op: 'skill_discover', input: { query: 'clamp' } },
    ),
  ).rejects.toThrow('BROKER_UNAVAILABLE');
  f.evaluate(p.candidate_version_id);
  expect((await f.operator('approve', p.candidate_version_id)).status).toBe(0);
  f.db.exec(
    "CREATE TRIGGER p3_007_promotion_fault BEFORE INSERT ON skill_operator_events WHEN NEW.action='promote' BEGIN SELECT RAISE(ABORT,'controlled interruption');END;",
  );
  expect((await f.operator('promote', p.candidate_version_id)).status).toBe(1);
  expect(f.store.getIdentity(p.skill_id).active_version_id).toBeNull();
  expect(
    f.db.prepare("SELECT COUNT(*) n FROM skill_promotions WHERE action='promote'").get(),
  ).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER p3_007_promotion_fault');
  expect((await f.operator('promote', p.candidate_version_id)).status).toBe(0);
  record(
    t,
    'promotion-recovery',
    p.candidate_version_id,
    p.skill_id,
    p.content_digest,
    'failed promotion/audit rolled back; fresh confirmed retry succeeded',
    'TEST_OPERATOR_AUTOMATION',
  );
  const reopened = openUsageDatabase(f.path);
  try {
    expect(
      reopened.prepare('SELECT active_version_id FROM skills WHERE id=?').get(p.skill_id),
    ).toEqual({ active_version_id: p.candidate_version_id });
  } finally {
    reopened.close();
  }
  finish(t, 'PASS');
}, 30000);
it('rollback compatibility: identity-only V2 promotion is atomic and recoverable without claiming behavioral improvement', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('rollback-compatibility'),
    a = await f.learned();
  const old = f.store.getVersion(a.proposal.candidate_version_id);
  const next = await f.call(f.client, 'skill_propose', {
    name: f.fixture.name,
    description: old.version.description,
    files: old.version.files,
    source_experience_ids: [a.experience.id],
    expected_latest_version: 1,
  });
  expect(f.evaluate(next.version.id).evaluation.result).toBe('PASS');
  expect((await f.operator('approve', next.version.id)).status).toBe(0);
  f.db.exec(
    "CREATE TRIGGER p3_007_identity_fault BEFORE INSERT ON skill_operator_events WHEN NEW.action='promote' BEGIN SELECT RAISE(ABORT,'controlled interruption');END;",
  );
  expect((await f.operator('promote', next.version.id)).status).toBe(1);
  expect(f.store.getIdentity(a.proposal.skill_id).active_version_id).toBe(old.version.id);
  f.db.exec('DROP TRIGGER p3_007_identity_fault');
  expect((await f.operator('promote', next.version.id)).status).toBe(0);
  await expect(
    f.call(f.client, 'skill_load', {
      skill_id: a.proposal.skill_id,
      expected_version_id: old.version.id,
    }),
  ).rejects.toThrow();
  expect((await f.operator('rollback', old.version.id)).status).toBe(0);
  expect(f.store.getVersion(old.version.id).version).toEqual(old.version);
  expect(
    (
      await f.call(f.client, 'skill_load', {
        skill_id: a.proposal.skill_id,
        expected_version_id: old.version.id,
      })
    ).version_id,
  ).toBe(old.version.id);
  record(
    t,
    'rollback',
    next.version.id,
    old.version.id,
    old.version.content_hash,
    'same-content identity revision rollback; no behavior-change claim',
    'TEST_OPERATOR_AUTOMATION',
  );
  finish(t, 'PASS', { behavioral_upgrade: 'NOT VERIFIED; identical bytes only' });
}, 30000);

it('distribution recovery: modified deployed files conflict without changing the approved registry', async () => {
  const f = await fixture(),
    t = new AcceptanceTrace('distribution-recovery');
  const learned = await f.learned();
  const version = learned.proposal.candidate_version_id;
  const identity = f.db
    .prepare('SELECT skill_id FROM skill_versions WHERE id = ?')
    .get(version) as { skill_id: string };
  expect((await f.sync(identity.skill_id)).status).toBe(0);
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  const request = {
    skill_id: identity.skill_id,
    target: 'all' as const,
    scope: 'project' as const,
  };
  const plan = dist.plan(request);
  expect(plan.entries.map((e) => e.action)).toEqual(['SKIP', 'SKIP']);
  const file = join(f.root, '.claude', 'skills', f.fixture.name, 'SKILL.md');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, `${original}\nLocal user change.\n`);
  expect(dist.plan(request).entries.some((e) => e.action === 'CONFLICT')).toBe(true);
  expect((await f.sync(identity.skill_id)).status).toBe(1);
  expect(readFileSync(file, 'utf8')).toContain('Local user change.');
  expect(
    (
      f.db.prepare('SELECT active_version_id FROM skills WHERE id = ?').get(identity.skill_id) as {
        active_version_id: string;
      }
    ).active_version_id,
  ).toBe(version);
  record(
    t,
    'distribution-conflict',
    version,
    version,
    null,
    'Modified deployed copy preserved; registry unchanged; authorized sync refused.',
  );
  // Explicit restoration by the isolated test owner, not automatic repair/force overwrite.
  writeFileSync(file, original);
  expect((await f.sync(identity.skill_id)).status).toBe(0);
  expect(dist.plan(request).entries.map((e) => e.action)).toEqual(['SKIP', 'SKIP']);
  record(
    t,
    'distribution-recovery',
    version,
    version,
    null,
    'Owner restored exact bytes; reconciliation is idempotent.',
    'TEST_OPERATOR_AUTOMATION',
  );
  finish(t, 'PASS');
}, 30000);
