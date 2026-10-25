import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../packages/core/src/operator-confirmation.js', async (original) => ({
  ...(await original<typeof import('../../packages/core/src/operator-confirmation.js')>()),
  consumeOperatorGrant: (_: unknown, digest: string) => ({
    operator: 'isolated-test-operator',
    session: randomUUID(),
    digest,
  }),
}));

import {
  migrateCurator,
  RecommendationService,
  SkillProposalService,
  SkillUsageService,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
/** Operator evidence below is an explicitly synthetic grant fixture, never real human/OS verification. */
function fixture() {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'claude');
  const curator = new RecommendationService(f.db, f.scope);
  const event = (
    type = 'task_failed',
    task: string = randomUUID(),
    confirmed = false,
    version = f.candidate.version,
  ) => {
    const report = {
      schema_version: 1 as const,
      event_id: randomUUID(),
      version_id: version.id,
      artifact_digest: version.content_hash,
      event_type: type,
      task_id: task,
    };
    return confirmed
      ? usage.confirmOutcome(
          { report, acceptance_criteria: ['Fixture outcome reviewed'], coverage: 'partial' },
          {},
        )
      : usage.record(report);
  };
  const experience = (approve = true) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    const e = f.experiences.record({
      problem: 'SQLite startup retry guidance',
      solution: 'Use bounded startup retry and inspect current tests',
      outcome: { status: 'unknown', summary: 'Fixture claim only' },
    }).experience;
    return approve
      ? f.experiences.review({
          id: e.id,
          expected_updated_at: e.updated_at,
          decision: 'approved',
          reviewer: 'synthetic reviewer',
          reason: 'Isolated metadata fixture',
        })
      : e;
  };
  const list = () => curator.list({ state: 'all' }).recommendations;
  return { ...f, usage, curator, event, experience, list };
}
it('suggests investigation from repeated operator-attested failures with bounded categorical confidence', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.curator.analyze();
  const r = f.list().find((r) => r.rule_id === 'repeated-failures');
  expect(r).toMatchObject({
    type: 'INVESTIGATE',
    confidence: 'MEDIUM',
    priority: 'MEDIUM',
    state: 'open',
    advisory_only: true,
  });
  expect(r?.evidence.filter((e) => e.kind === 'usage')).toHaveLength(2);
  expect(r?.limitations.join(' ')).toContain('causation');
});
it('keeps agent-reported failures lower-trust and unknown outcomes separate', () => {
  const f = fixture();
  f.event('task_failed', 'one');
  f.event('task_failed', 'two');
  f.event('task_unknown', 'three');
  f.curator.analyze();
  expect(f.list().find((r) => r.rule_id === 'repeated-failures')).toMatchObject({
    confidence: 'LOW',
    priority: 'LOW',
  });
});
it('never counts unknown outcomes or absent telemetry as failures or obsolescence', () => {
  const f = fixture();
  f.event('task_unknown', 'one');
  f.curator.analyze();
  expect(f.list().map((r) => r.type)).toEqual(['REVIEW']);
  expect(f.list()[0]?.explanation).toContain('not failures or successes');
});
it('finds newer relevant approved experiences through scoped FTS and excludes unapproved records', () => {
  const f = fixture();
  const approved = f.experience();
  const candidate = f.experience(false);
  f.curator.analyze();
  const refs = f.list().flatMap((r) => r.evidence);
  expect(refs).toContainEqual({ kind: 'experience', id: approved.id });
  expect(refs).not.toContainEqual({ kind: 'experience', id: candidate.id });
  expect(f.list().find((r) => r.rule_id === 'new-experiences')?.explanation).toContain(
    'may already be covered',
  );
});
it('identifies lexical/source overlap as possible duplication, never semantic equivalence', () => {
  const f = fixture();
  new SkillProposalService(f.db, f.scope, 'claude').propose({
    name: 'sqlite-startup-copy',
    description: f.candidate.version.description,
    source_experience_ids: [f.approvedSource.id],
    files: f.candidate.version.files.map((file) =>
      file.path === 'SKILL.md'
        ? { ...file, content: file.content.replaceAll('sqlite-startup', 'sqlite-startup-copy') }
        : file,
    ),
  });
  f.curator.analyze();
  expect(f.list().find((r) => r.rule_id === 'possible-overlap')).toMatchObject({
    type: 'POSSIBLE_DUPLICATE',
    confidence: 'LOW',
  });
});
it('flags old versions only with corroborating currency signals, and not recent maintenance', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  const f = fixture();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  f.experience();
  f.curator.analyze();
  expect(f.list().some((r) => r.type === 'POSSIBLE_STALE')).toBe(true);
  f.propose('Current maintenance candidate');
  f.curator.analyze();
  expect(f.curator.list().recommendations.some((r) => r.type === 'POSSIBLE_STALE')).toBe(false);
});
it('does not infer staleness from old age and low usage alone', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  const f = fixture();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  f.curator.analyze();
  expect(f.list().some((r) => r.type === 'POSSIBLE_STALE')).toBe(false);
});
it('suppresses duplicate events and does not count repeated reports as independent task labels', () => {
  const f = fixture();
  const report = {
    schema_version: 1 as const,
    event_id: randomUUID(),
    version_id: f.candidate.version.id,
    artifact_digest: f.candidate.version.content_hash,
    event_type: 'task_failed' as const,
    task_id: 'same',
  };
  f.usage.record(report);
  expect(f.usage.record(report)).toMatchObject({ duplicate: true });
  f.curator.analyze();
  expect(f.list().some((r) => r.rule_id === 'repeated-failures')).toBe(false);
  f.event('task_failed', 'same', true);
  f.curator.analyze();
  expect(f.list().find((r) => r.rule_id === 'repeated-failures')).toMatchObject({
    confidence: 'LOW',
  });
});
it('lowers confidence for conflicting outcomes and never resolves them into success', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.event('task_succeeded', 'one');
  f.curator.analyze();
  const r = f.list().find((r) => r.rule_id === 'repeated-failures');
  expect(r?.confidence).toBe('LOW');
  expect(r?.limitations.join(' ')).toContain('same task');
  expect(f.list().some((r) => r.type === 'IMPROVE')).toBe(false);
});
it('combines attested failures, new experience, an evaluation gap and distinct observed sessions without causal claims', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.experience();
  for (const session of ['native-one', 'native-two'])
    f.usage.observeHook({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type: 'invoked',
      session_id: session,
    });
  f.curator.analyze();
  expect(f.list().find((r) => r.type === 'IMPROVE')).toMatchObject({
    priority: 'HIGH',
    confidence: 'MEDIUM',
  });
});
it('does not upgrade session expansion presence into invocation observations', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.experience();
  for (const session of ['one', 'two'])
    f.usage.observeSlashPresence({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type: 'discovered',
      session_id: session,
    });
  f.curator.analyze();
  expect(f.list().some((r) => r.type === 'IMPROVE')).toBe(false);
});
it('deduplicates analysis, refreshes evidence and preserves dismissal without lifecycle mutation', () => {
  const f = fixture();
  f.event('task_failed', 'one');
  f.event('task_failed', 'two');
  const before = f.db.prepare('SELECT * FROM skills').all();
  const a = f.curator.analyze();
  const b = f.curator.analyze();
  expect(b.run_id).toBe(a.run_id);
  expect(b.cached).toBe(true);
  const r = f.list().find((r) => r.rule_id === 'repeated-failures');
  if (!r) throw new Error('missing fixture recommendation');
  f.curator.dismiss({ recommendation_id: r.id, expected_revision: r.revision });
  f.event('task_failed', 'three');
  f.curator.analyze();
  expect(f.curator.get({ recommendation_id: r.id })).toMatchObject({
    state: 'dismissed',
    revision: 2,
  });
  expect(f.db.prepare('SELECT * FROM skills').all()).toEqual(before);
});
it('supersedes absent complete-window signals, retains history and annotates missing references', () => {
  const f = fixture();
  f.event('task_failed', 'one');
  f.event('task_failed', 'two');
  f.curator.analyze();
  const r = f.list().find((r) => r.rule_id === 'repeated-failures');
  if (!r) throw new Error('missing fixture');
  f.db.exec('DELETE FROM skill_usage_events');
  expect(
    f.curator
      .get({ recommendation_id: r.id })
      .evidence_status.some((e) => e.status === 'MISSING_OR_UNAVAILABLE'),
  ).toBe(true);
  f.curator.analyze();
  expect(f.curator.get({ recommendation_id: r.id }).state).toBe('superseded');
  expect(
    f.db.prepare('SELECT COUNT(*) AS n FROM curator_history WHERE recommendation_id=?').get(r.id),
  ).toEqual({ n: 2 });
});
it('scopes every query and denies cross-project recommendation access and forged options', () => {
  const f = fixture();
  f.curator.analyze();
  const r = f.list()[0];
  if (!r) throw new Error('missing fixture');
  const foreign = new RecommendationService(f.db, f.otherScope);
  expect(foreign.list().recommendations).toEqual([]);
  expect(() => foreign.get({ recommendation_id: r.id })).toThrow();
  expect(() =>
    foreign.dismiss({ recommendation_id: r.id, expected_revision: r.revision }),
  ).toThrow();
  for (const arg of [
    { project_id: f.otherScope.id },
    { approvedBy: 'human' },
    { operation: 'promote' },
    { policy: { min_failures: 0 } },
  ])
    expect(() => f.curator.analyze(arg)).toThrow();
});
it('retains no raw experience prose, secrets, prompts or event notes in recommendations', () => {
  const f = fixture();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 1000);
  const e = f.experiences.record({
    problem: 'SQLite startup private-prose-marker',
    solution: 'api_key=very-private-value',
    outcome: { status: 'unknown', summary: 'not verified' },
  }).experience;
  f.experiences.review({
    id: e.id,
    expected_updated_at: e.updated_at,
    decision: 'approved',
    reviewer: 'test',
    reason: 'fixture',
  });
  f.curator.analyze();
  const serialized = JSON.stringify(f.list());
  expect(serialized).not.toMatch(/very-private-value|private-prose-marker|api_key/);
});
it('rolls back recommendation/history writes when storage fails and can recover', () => {
  const f = fixture();
  migrateCurator(f.db);
  f.db.exec(
    "CREATE TRIGGER curator_fault BEFORE INSERT ON curator_history BEGIN SELECT RAISE(ABORT,'injected metadata failure');END",
  );
  expect(() => f.curator.analyze()).toThrow('transaction failed');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM curator_recommendations').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM curator_runs').get()).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER curator_fault');
  expect(f.curator.analyze().recommendation_count).toBeGreaterThan(0);
});
it('reports truncation and never supersedes recommendations from an incomplete window', () => {
  const f = fixture();
  f.event('task_failed', 'one');
  f.event('task_failed', 'two');
  f.curator.analyze();
  const old = f.list().find((r) => r.rule_id === 'repeated-failures');
  if (!old) throw new Error('missing fixture');
  new RecommendationService(f.db, f.scope, { max_events: 1 }).analyze();
  expect(f.curator.get({ recommendation_id: old.id }).state).toBe('open');
});
it('does not mutate records or create tables during read-only reporting', () => {
  const f = fixture();
  const before = f.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'curator_%'")
    .get();
  f.curator.list();
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'curator_%'").get(),
  ).toEqual(before);
  f.curator.analyze();
  const changes = f.db.prepare('SELECT total_changes() AS n').get();
  f.curator.list();
  const r = f.list()[0];
  if (r) f.curator.get({ recommendation_id: r.id });
  expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
});
it('fails closed on unknown recommendation schema versions', () => {
  const f = fixture();
  migrateCurator(f.db);
  f.db.exec('PRAGMA ignore_check_constraints=ON;UPDATE curator_schema SET version=2');
  expect(() => f.curator.list()).toThrow('Unknown');
});
it('treats mid-session version attribution as uncertain rather than consistent invocation evidence', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.experience();
  const v2 = f.propose();
  f.evaluate(v2.version.id);
  f.approve(v2.version.id);
  for (const version of [f.candidate.version, v2.version])
    f.usage.observeHook({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: version.id,
      artifact_digest: version.content_hash,
      event_type: 'invoked',
      session_id: 'shared-native-session',
    });
  f.curator.analyze();
  const r = f.list().find((r) => r.rule_id === 'repeated-failures');
  expect(r?.confidence).toBe('LOW');
  expect(r?.limitations.join(' ')).toContain('multiple versions');
  expect(f.list().some((r) => r.type === 'IMPROVE')).toBe(false);
});
it('keeps experience, memory, version, evaluation, approval, distribution and telemetry rows unchanged', () => {
  const f = fixture();
  f.event('task_failed', 'one', true);
  f.event('task_failed', 'two', true);
  f.experience();
  const tables = [
    'projects',
    'memories',
    'experiences',
    'experience_reviews',
    'skills',
    'skill_versions',
    'skill_version_states',
    'skill_evaluations',
    'skill_reviews',
    'skill_promotions',
    'skill_operator_events',
    'skill_installations',
    'skill_distribution_events',
    'skill_usage_events',
    'skill_usage_dedup',
  ];
  const snapshot = () =>
    tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  f.curator.analyze();
  expect(snapshot()).toEqual(before);
  const r = f.list()[0];
  if (r) f.curator.dismiss({ recommendation_id: r.id, expected_revision: r.revision });
  expect(snapshot()).toEqual(before);
});
it('actually kills an over-budget read-only worker without persisting recommendations', () => {
  const f = fixture();
  // Deliberately expensive view in a disposable registry: no untrusted script or production data.
  f.db.exec(`ALTER TABLE skills RENAME TO fixture_skills;
 CREATE VIEW skills AS WITH RECURSIVE spin(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM spin WHERE n<100000000) SELECT fixture_skills.* FROM fixture_skills,spin;`);
  const started = Date.now();
  expect(() => new RecommendationService(f.db, f.scope, { budget_ms: 250 }).analyze()).toThrow(
    'limit',
  );
  expect(Date.now() - started).toBeLessThan(5000);
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='curator_schema'").get(),
  ).toBeUndefined();
});

it('discloses per-version event sampling and avoids supersession from that incomplete window', () => {
  const f = fixture();
  f.event('task_failed', 'one');
  f.event('task_failed', 'two');
  f.curator.analyze();
  const prior = f.list().find((r) => r.rule_id === 'repeated-failures');
  if (!prior) throw new Error('missing fixture');
  for (let i = 0; i < 25; i++) f.event('task_unknown', `later-${i}`);
  const run = f.curator.analyze();
  expect(run.coverage.events_truncated).toBe(true);
  expect(f.curator.get({ recommendation_id: prior.id }).state).toBe('open');
});
