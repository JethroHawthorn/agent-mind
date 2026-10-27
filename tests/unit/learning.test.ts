import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  LearningSignalService,
  learningStorageExists,
  migrateLearning,
  openDatabase,
  openDatabaseReadOnly,
  RecommendationService,
  SkillEvaluationService,
  SkillProposalService,
  SkillUsageService,
} from '../../packages/core/src/index.js';
import { issueBrokerGrant, reviewDigest } from '../../packages/core/src/operator-confirmation.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const input = (patch: Record<string, unknown> = {}) => ({
  schema_version: 1,
  type: 'PROBLEM_SOLVED',
  title: 'Bounded retry handles temporary locks',
  summary:
    'SQLite startup retry exhaustion was reproduced and a bounded backoff solution was proposed for further checking.',
  reusability: 'potentially_reusable',
  ...patch,
});
function fixture(withSkill = false) {
  const f = withSkill ? distributionFixture(true, 'sqlite-startup') : skillFixture();
  cleanup.push(f.close);
  return { ...f, learning: new LearningSignalService(f.db, f.scope, 'codex') };
}
function stored(value: unknown) {
  const r = value as {
    id: string;
    revision: number;
    stored: boolean;
    status: string;
    action: string;
  };
  expect(r.stored).toBe(true);
  return r;
}
it('captures a solved-problem claim as unverified agent provenance with hashed correlation labels', () => {
  const f = fixture();
  const r = stored(
    f.learning.record(input({ task_ref: 'private-task', session_ref: 'private-session' })),
  );
  const s = f.learning.get({ signal_id: r.id });
  expect(s.origin).toMatchObject({
    source_agent: 'codex',
    detection_source: 'agent_reported',
    adapter: 'explicit-mcp-v1',
  });
  expect(s.triage.evidence_trust).toBe('AGENT_REPORTED');
  expect(s.task_ref).not.toBe('private-task');
  expect(JSON.stringify(s)).not.toContain('private-session');
});
it('captures all seven signal types without granting verification', () => {
  const f = fixture();
  for (const type of [
    'PROBLEM_SOLVED',
    'USER_CORRECTION',
    'REUSABLE_WORKFLOW',
    'REPEATED_FAILURE',
    'SKILL_GAP',
    'SKILL_CONFLICT',
    'NEW_PATTERN',
  ]) {
    const r = stored(f.learning.record(input({ type })));
    expect(f.learning.get({ signal_id: r.id }).triage.evidence_trust).toBe('AGENT_REPORTED');
  }
});
it('ignores weak generic completion instead of growing the signal store', () => {
  const f = fixture();
  expect(
    f.learning.record(input({ title: 'Task complete', summary: 'Done tests passed' })),
  ).toMatchObject({ stored: false, action: 'IGNORE' });
  expect(learningStorageExists(f.db)).toBe(false);
});
it('deduplicates retries and cross-agent reports of the same concise lesson', () => {
  const f = fixture();
  const a = stored(f.learning.record(input({ task_ref: 'one' })));
  const b = stored(
    new LearningSignalService(f.db, f.scope, 'claude').record(input({ task_ref: 'one' })),
  );
  expect(a.id).toBe(b.id);
  expect(b.revision).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_history').get()).toEqual({ n: 1 });
});
it('rejects caller-provided scope, verification, provenance and arbitrary hook payloads', () => {
  const f = fixture();
  for (const patch of [
    { project_id: f.otherScope.id },
    { verified: true },
    { evidence_trust: 'VERIFIED' },
    { source_agent: 'human' },
    { hook_event_name: 'Stop' },
    { operator_correction: { operator: 'human' } },
  ])
    expect(() => f.learning.record(input(patch))).toThrow();
});
it('rejects cross-project and forged evidence before persisting metadata', () => {
  const f = fixture();
  const e = f.source(true);
  for (const id of [e.id, randomUUID()])
    expect(() => f.learning.record(input({ experience_ids: [id] }))).toThrow();
  expect(learningStorageExists(f.db)).toBe(false);
});
it('scopes get, state, refresh, recommendation and list at the service boundary', () => {
  const f = fixture();
  const r = stored(f.learning.record(input()));
  const foreign = new LearningSignalService(f.db, f.otherScope);
  for (const method of [
    () => foreign.get({ signal_id: r.id }),
    () => foreign.state({ signal_id: r.id, expected_revision: 0, state: 'dismissed' }),
    () => foreign.refresh({ signal_id: r.id, expected_revision: 0 }),
    () => foreign.recommend({ signal_id: r.id }),
  ])
    expect(method).toThrow();
  expect(foreign.list().signals).toEqual([]);
});
it('redacts secrets and rejects transcript summaries', () => {
  const f = fixture();
  const r = stored(
    f.learning.record(
      input({
        summary:
          'Recovered a connection issue; api_key=private-sensitive-value should never appear in persisted lesson summaries or future prompts.',
      }),
    ),
  );
  expect(JSON.stringify(f.learning.get({ signal_id: r.id }))).not.toContain(
    'private-sensitive-value',
  );
  expect(() =>
    f.learning.record(input({ summary: 'user: private conversation\nassistant: answer' })),
  ).toThrow('transcript');
});
it('rejects oversized input and excessive references', () => {
  const f = fixture();
  expect(() => f.learning.record(input({ summary: 'x'.repeat(1001) }))).toThrow();
  expect(() =>
    f.learning.record(
      input({
        evidence: Array.from({ length: 9 }, () => ({ kind: 'experience', id: randomUUID() })),
      }),
    ),
  ).toThrow();
});
it('links existing experiences without writing a second experience', () => {
  const f = fixture();
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get();
  const r = stored(
    f.learning.record(
      input({ title: 'SQLite busy startup', experience_ids: [f.approvedSource.id] }),
    ),
  );
  const s = f.learning.get({ signal_id: r.id });
  expect(s.triage.related_experiences).toContain(f.approvedSource.id);
  expect(s.triage.novelty).toBe('possibly_covered');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual(before);
});
it('matches existing skill metadata through bounded project-scoped search', () => {
  const f = fixture(true);
  const r = stored(f.learning.record(input({ title: 'SQLite startup guidance' })));
  const s = f.learning.get({ signal_id: r.id });
  expect(s.triage.related_versions.length).toBeGreaterThan(0);
  expect(s.triage.action).toBe('POTENTIAL_SKILL_UPDATE');
});
it('permits only a potential-new-skill suggestion from meaningful reusable evidence', () => {
  const f = fixture();
  const r = stored(
    f.learning.record(
      input({
        type: 'NEW_PATTERN',
        title: 'Unique shader geometry harmonization',
        summary:
          'A reusable tessellation arrangement can preserve edge adjacency across multiple rendering algorithms with explicit input constraints.',
        experience_ids: [f.approvedSource.id],
      }),
    ),
  );
  expect(f.learning.get({ signal_id: r.id }).triage.action).toBe('IGNORE');
  // Existing experience links suppress novelty; an evaluation/usage reference does not imply prior lesson coverage.
  const id = f.identity('other-context'),
    v = f.version(id);
  f.evaluation(v);
  const evaluation = (
    f.db.prepare('SELECT id FROM skill_evaluations WHERE version_id=?').get(v) as { id: string }
  ).id;
  const next = stored(
    f.learning.record(
      input({
        type: 'NEW_PATTERN',
        title: 'Unique shader geometry harmonization',
        summary:
          'A reusable tessellation arrangement was found for rendering curved mesh boundaries and needs further investigation.',
        evidence: [{ kind: 'evaluation', id: evaluation }],
      }),
    ),
  );
  expect(['POTENTIAL_SKILL_UPDATE', 'INVESTIGATE']).toContain(
    f.learning.get({ signal_id: next.id }).triage.action,
  );
});
it('records a reusable solved claim without evidence as an explicit experience suggestion', () => {
  const f = fixture();
  const r = stored(
    f.learning.record(
      input({
        title: 'Shader edge adjacency contract',
        summary:
          'Apply the shared edge adjacency contract before recalculating curved mesh tessellation in a second rendering pass.',
      }),
    ),
  );
  expect(r.action).toBe('RECORD_EXPERIENCE');
});
it('detects an actual static evaluator FAIL as a verified static observation, never task failure', () => {
  const f = fixture();
  const id = f.identity('incomplete-fixture'),
    v = f.version(id);
  const snapshot = f.store.getVersion(v);
  const evaluation = new SkillEvaluationService(f.db, f.scope).evaluate({
    version_id: v,
    expected_content_hash: snapshot.version.content_hash,
    expected_state_revision: snapshot.state.revision,
  });
  expect(evaluation.evaluation.result).toBe('FAIL');
  f.learning.detect({ limit: 30 });
  const list = f.learning.list().signals;
  const item = list.find((s) => s.type === 'SKILL_GAP');
  if (!item) throw Error('missing detection');
  const signal = f.learning.get({ signal_id: item.id });
  expect(signal.origin.detection_source).toBe('verified_observation');
  expect(signal.triage.evidence_trust).toBe('VERIFIED_STATIC_CHECK');
  expect(signal.triage.limitations.join(' ')).toContain('not a verified task failure');
});
it('does not upgrade synthetic evaluator labels into verified deterministic failures', () => {
  const f = fixture();
  const id = f.identity(),
    v = f.version(id);
  f.evaluation(v, 'FAIL');
  f.learning.detect();
  expect(f.learning.list().signals.some((s) => s.type === 'SKILL_GAP')).toBe(false);
});
it('requires an exact one-use grant to attest a user-correction claim', () => {
  const f = fixture();
  const r = stored(f.learning.record(input({ type: 'USER_CORRECTION' })));
  const request = { signal_id: r.id, expected_revision: r.revision };
  expect(() => f.learning.confirmCorrection(request, { approvedBy: 'human' })).toThrow();
  const preview = f.learning.prepareCorrection(request);
  // Explicitly isolated authorization fixture; not real human or OS authentication evidence.
  const grant = issueBrokerGrant(reviewDigest(preview), { uid: 202, gid: 20 });
  f.learning.confirmCorrection(request, grant);
  const s = f.learning.get({ signal_id: r.id });
  expect(s.operator_correction?.method).toBe('local-tty-learning-correction-v1');
  expect(s.triage.evidence_trust).toBe('OPERATOR_ATTESTED');
  expect(() =>
    f.learning.confirmCorrection({ signal_id: r.id, expected_revision: s.revision }, grant),
  ).toThrow();
});
it('refuses stale correction grants and mismatched revisions', () => {
  const f = fixture();
  const r = stored(f.learning.record(input({ type: 'USER_CORRECTION' })));
  const grant = issueBrokerGrant('a'.repeat(64), { uid: 202, gid: 20 });
  expect(() =>
    f.learning.confirmCorrection({ signal_id: r.id, expected_revision: 0 }, grant),
  ).toThrow();
  expect(() => f.learning.refresh({ signal_id: r.id, expected_revision: 8 })).toThrow();
});
it('does not turn repeated agent failures or unknown/session events into verified learning', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  for (const [task, event_type] of [
    ['a', 'task_failed'],
    ['b', 'task_failed'],
    ['c', 'task_unknown'],
    ['d', 'invoked'],
  ])
    usage.record({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type,
      task_id: task,
    });
  const service = new LearningSignalService(f.db, f.scope);
  service.detect({ limit: 30 });
  const failures = service.list().signals.filter((s) => s.type === 'REPEATED_FAILURE');
  expect(failures).toHaveLength(2);
  for (const failure of failures)
    expect(service.get({ signal_id: failure.id }).triage.evidence_trust).toBe('AGENT_REPORTED');
});
it('preserves conflicting outcomes for one underlying task without a success inference', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  const refs = [];
  for (const event_type of ['task_succeeded', 'task_failed']) {
    const id = randomUUID();
    usage.record({
      schema_version: 1,
      event_id: id,
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type,
      task_id: 'same-task',
    });
    refs.push({ kind: 'usage', id });
  }
  const learning = new LearningSignalService(f.db, f.scope);
  const r = stored(learning.record(input({ evidence: refs })));
  const s = learning.get({ signal_id: r.id });
  expect(s.triage.action).toBe('INVESTIGATE');
  expect(s.triage.limitations.join(' ')).toContain('opposing outcome');
});
it('detects approved/candidate experience observations without claiming verified outcomes', () => {
  const f = fixture();
  f.learning.detect();
  const list = f.learning.list().signals;
  expect(list).toHaveLength(1);
  expect(list[0]?.type).toBe('NEW_PATTERN');
  expect(f.learning.get({ signal_id: list[0]?.id }).triage.evidence_trust).toBe('AGENT_REPORTED');
});
it('supports incremental bounded detection without duplicating source observations', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.source();
  const a = f.learning.detect({ limit: 1 });
  expect('more' in a && a.more).toBe(true);
  for (let i = 0; i < 6; i++) f.learning.detect({ limit: 1 });
  const n = f.db.prepare('SELECT COUNT(*) AS n FROM learning_signals').get();
  f.learning.detect();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_signals').get()).toEqual(n);
});
it('preserves dismissal/supersession and reevaluates new references without reopening', () => {
  const f = fixture();
  const r = stored(f.learning.record(input()));
  f.learning.state({ signal_id: r.id, expected_revision: 0, state: 'dismissed' });
  const again = stored(f.learning.record(input({ experience_ids: [f.approvedSource.id] })));
  expect(again.status).toBe('dismissed');
  expect(f.learning.get({ signal_id: r.id }).status).toBe('dismissed');
  const s = f.learning.get({ signal_id: r.id });
  f.learning.state({ signal_id: r.id, expected_revision: s.revision, state: 'superseded' });
  expect(() => f.learning.recommend({ signal_id: r.id })).toThrow();
});
it('does not initialize learning tables during read-only reporting', () => {
  const f = fixture();
  const ro = openDatabaseReadOnly(f.path);
  cleanup.push(() => ro.close());
  expect(new LearningSignalService(ro, f.scope).list().signals).toEqual([]);
  expect(learningStorageExists(f.db)).toBe(false);
});
it('persists signals across database restart', () => {
  const f = fixture();
  const r = stored(f.learning.record(input()));
  const second = openDatabase(f.path);
  cleanup.push(() => second.close());
  expect(new LearningSignalService(second, f.scope).get({ signal_id: r.id }).id).toBe(r.id);
});
it('disabled capture/detection stores no metadata while retaining historical reporting', () => {
  const f = fixture();
  const disabled = new LearningSignalService(f.db, f.scope, 'codex', 'explicit-mcp-v1', false);
  expect(disabled.record(input())).toMatchObject({ disabled: true, stored: false });
  expect(disabled.detect()).toMatchObject({ disabled: true, stored: 0 });
  expect(learningStorageExists(f.db)).toBe(false);
});
it('rolls back an injected history failure and permits recovery', () => {
  const f = fixture();
  f.db.transaction(() => migrateLearning(f.db))();
  f.db.exec(
    "CREATE TRIGGER fail_learning BEFORE INSERT ON learning_history BEGIN SELECT RAISE(ABORT,'injected');END",
  );
  expect(() => f.learning.record(input())).toThrow('transaction failed');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_signals').get()).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER fail_learning');
  expect(f.learning.record(input())).toMatchObject({ stored: true });
});
it('deduplicates escalation through P3-001 and preserves recommendation namespaces', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const learning = new LearningSignalService(f.db, f.scope);
  const r = stored(learning.record(input({ version_ids: [f.candidate.version.id] })));
  const first = learning.recommend({ signal_id: r.id }) as { recommendation_ids: string[] };
  const next = learning.recommend({ signal_id: r.id }) as { recommendation_ids: string[] };
  expect(next.recommendation_ids).toEqual(first.recommendation_ids);
  const curator = new RecommendationService(f.db, f.scope);
  curator.analyze();
  curator.analyzeDuplicates();
  expect(curator.get({ recommendation_id: first.recommendation_ids[0] }).state).toBe('open');
});
it('keeps source/lifecycle/telemetry records unchanged during capture, triage and detection', () => {
  const f = fixture(true);
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
  const snapshot = () => tables.map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const before = snapshot();
  f.learning.record(input());
  f.learning.detect();
  expect(snapshot()).toEqual(before);
});
it('fails closed on unsupported learning metadata migrations', () => {
  const f = fixture();
  f.db.exec('CREATE TABLE learning_schema(version INTEGER);INSERT INTO learning_schema VALUES(2)');
  expect(() => f.learning.list()).toThrow('Unsupported');
});
it('suggests only a potential new skill from bounded external evidence without fetching it', () => {
  const f = fixture();
  const r = stored(
    f.learning.record(
      input({
        type: 'NEW_PATTERN',
        title: 'Shader topology adjacency lesson',
        summary:
          'A reusable adjacency contract stabilizes geometric patch boundaries before tessellation updates in repeated rendering workflows.',
        supporting_evidence: [
          {
            kind: 'file',
            reference: 'tests/geometry.spec.ts',
            summary: 'Agent-provided reference only; not executed or verified.',
          },
        ],
      }),
    ),
  );
  const signal = f.learning.get({ signal_id: r.id });
  expect(signal.triage.action).toBe('POTENTIAL_NEW_SKILL');
  expect(signal.triage.evidence_trust).toBe('AGENT_REPORTED');
  expect(f.learning.recommend({ signal_id: r.id })).toMatchObject({ stored: false });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
});
it('refreshes with newly supplied bounded external evidence while retaining the original provenance', () => {
  const f = fixture();
  const p = input({
    type: 'NEW_PATTERN',
    title: 'Shader geometry adjacency lesson',
    summary:
      'A reusable adjacency contract stabilizes geometric patch boundaries before tessellation updates in repeated rendering workflows.',
  });
  const a = stored(f.learning.record(p));
  const b = stored(
    f.learning.record({
      ...p,
      supporting_evidence: [
        {
          kind: 'test',
          reference: 'geometry-acceptance',
          summary: 'An agent report, not a trusted test runner.',
        },
      ],
    }),
  );
  expect(b.id).toBe(a.id);
  expect(b.revision).toBeGreaterThan(a.revision);
  expect(b.action).toBe('POTENTIAL_NEW_SKILL');
});
it('fails atomically on a schema migration fault and retains core schema compatibility', () => {
  const f = fixture();
  f.db.exec('CREATE TABLE learning_history(unrelated TEXT)');
  expect(() => f.learning.record(input())).toThrow();
  expect(learningStorageExists(f.db)).toBe(false);
  expect(f.db.pragma('user_version', { simple: true })).toBe(10);
  f.db.exec('DROP TABLE learning_history');
  expect(f.learning.record(input())).toMatchObject({ stored: true });
});
it('retains immutable signal history and safely reports pruned evidence', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  const event = randomUUID();
  usage.record({
    schema_version: 1,
    event_id: event,
    version_id: f.candidate.version.id,
    artifact_digest: f.candidate.version.content_hash,
    event_type: 'task_failed',
  });
  const service = new LearningSignalService(f.db, f.scope);
  const r = stored(service.record(input({ evidence: [{ kind: 'usage', id: event }] })));
  f.db.prepare('DELETE FROM skill_usage_events WHERE event_id=?').run(event);
  const result = service.get({ signal_id: r.id });
  expect(result.triage.evidence_status[0]?.status).toBe('MISSING_OR_UNAVAILABLE');
  expect(result.triage.action).toBe('INVESTIGATE');
  expect(() => f.db.exec('DELETE FROM learning_history')).toThrow();
  expect(() => f.db.exec('DELETE FROM learning_signals')).toThrow();
});
it('supersedes only the linked advisory recommendation when its source signal is dismissed', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const service = new LearningSignalService(f.db, f.scope);
  const r = stored(service.record(input({ version_ids: [f.candidate.version.id] })));
  const rec = service.recommend({ signal_id: r.id }) as { recommendation_ids: string[] };
  service.state({ signal_id: r.id, expected_revision: 0, state: 'dismissed' });
  expect(
    new RecommendationService(f.db, f.scope).get({ recommendation_id: rec.recommendation_ids[0] })
      .state,
  ).toBe('superseded');
});
it('invalidates correction attestation when new unreviewed evidence is added', () => {
  const f = fixture();
  const p = input({ type: 'USER_CORRECTION' });
  const r = stored(f.learning.record(p));
  const request = { signal_id: r.id, expected_revision: 0 };
  const grant = issueBrokerGrant(reviewDigest(f.learning.prepareCorrection(request)), {
    uid: 202,
    gid: 20,
  });
  f.learning.confirmCorrection(request, grant);
  f.learning.record({
    ...p,
    supporting_evidence: [
      {
        kind: 'note',
        reference: 'new unreviewed claim',
        summary: 'This evidence was not in the confirmed artifact.',
      },
    ],
  });
  const updated = f.learning.get({ signal_id: r.id });
  expect(updated.operator_correction).toBeUndefined();
  expect(updated.triage.evidence_trust).toBe('AGENT_REPORTED');
});
it('detects P3-002 conflict findings as advisory records without interpreting instructions or changing active skills', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const proposals = new SkillProposalService(f.db, f.scope, 'codex');
  for (const [name, modal] of [
    ['logging-on', 'Must'],
    ['logging-off', 'Never'],
  ] as const)
    proposals.propose({
      name,
      description: f.candidate.version.description,
      source_experience_ids: [f.approvedSource.id],
      files: f.candidate.version.files.map((file) =>
        file.path === 'SKILL.md'
          ? {
              ...file,
              content:
                file.content.replaceAll('sqlite-startup', name) +
                `\n${modal} enable write ahead logging.\n`,
            }
          : file,
      ),
    });
  const pointer = f.db
    .prepare('SELECT active_version_id FROM skills WHERE id=?')
    .get(f.candidate.identity.id);
  const curator = new RecommendationService(f.db, f.scope);
  curator.analyzeDuplicates({ include_candidates: true });
  expect(
    curator.list({ classification: 'POSSIBLE_CONFLICT' }).recommendations.length,
  ).toBeGreaterThan(0);
  const learning = new LearningSignalService(f.db, f.scope);
  learning.detect({ limit: 30 });
  const signal = learning.list({ limit: 20 }).signals.find((s) => s.type === 'SKILL_CONFLICT');
  if (!signal) throw Error('missing conflict observation');
  expect(learning.get({ signal_id: signal.id }).triage.action).toBe('INVESTIGATE');
  expect(
    f.db.prepare('SELECT active_version_id FROM skills WHERE id=?').get(f.candidate.identity.id),
  ).toEqual(pointer);
});
it('continues incremental usage detection after event retention reuses SQLite event rowids', () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  const service = new LearningSignalService(f.db, f.scope);
  const report = () =>
    usage.record({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type: 'task_failed',
    });
  report();
  service.detect({ limit: 30 });
  f.db.exec('DELETE FROM skill_usage_events');
  report();
  service.detect({ limit: 30 });
  expect(
    service.list({ limit: 20 }).signals.filter((s) => s.type === 'REPEATED_FAILURE'),
  ).toHaveLength(2);
});
it('canonicalizes repeated unordered evidence without duplicate observations or history revisions', () => {
  const f = fixture();
  const second = f.source();
  const p = input({
    evidence: [
      { kind: 'experience', id: second.id },
      { kind: 'experience', id: f.approvedSource.id },
      { kind: 'experience', id: second.id },
    ],
    experience_ids: [second.id, f.approvedSource.id, second.id],
  });
  const a = stored(f.learning.record(p));
  const b = stored(f.learning.record(p));
  expect(b.id).toBe(a.id);
  expect(b.revision).toBe(0);
  expect(f.learning.get({ signal_id: a.id }).evidence).toHaveLength(2);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_history').get()).toEqual({ n: 1 });
});
