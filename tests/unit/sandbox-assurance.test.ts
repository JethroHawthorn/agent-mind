import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  behavioralDigest,
  behavioralSandboxStatus,
  type collectSandboxRefusal,
  SkillEvaluationService,
  skillEvaluateSchema,
  verifySandboxRefusal,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const f of clean.splice(0)) f();
});
function fixture() {
  const f = distributionFixture();
  clean.push(f.close);
  const candidate = f.propose('Untrusted PASS text; no behavioral execution.');
  const service = new SkillEvaluationService(f.db, f.scope);
  const input = {
    version_id: candidate.version.id,
    expected_content_hash: candidate.version.content_hash,
    expected_state_revision: candidate.state.revision,
    mode: 'behavioral' as const,
  };
  return { ...f, activeId: f.candidate.version.id, candidate, evaluator: service, input };
}
it('reports unavailable isolation independently from policy requirements; returned policy is not authority', () => {
  const first = behavioralSandboxStatus(),
    second = behavioralSandboxStatus();
  first.policy.accepted_backends.push('host-shell');
  expect(second.policy.accepted_backends).toEqual([]);
  expect(second.capability).toMatchObject({
    status: 'UNAVAILABLE',
    image_digest: null,
    verified_limits: null,
    network_verified: false,
  });
  expect(second.policy_digest).toBe(behavioralDigest(second.policy));
  expect(second.execution_supported).toBe(false);
});
it('read-only planning does not migrate, stage files, record evidence or alter active identity', () => {
  const f = fixture(),
    before = f.db.prepare('SELECT total_changes() AS n').get();
  const tables = () => f.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
  const initial = tables();
  const first = f.evaluator.plan(f.input),
    second = f.evaluator.plan(f.input);
  expect(first).toEqual(second);
  expect(tables()).toEqual(initial);
  expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(first.plan.manifest).toHaveLength(2);
  expect(JSON.stringify(first)).not.toContain('Untrusted PASS text');
  expect(first.plan.execution_started).toBe(false);
  expect(first.plan.suite_digest).toMatch(/^[a-f0-9]{64}$/);
});
it('binds every supporting member and records an immutable refusal without activation', () => {
  const f = fixture(),
    planned = f.evaluator.plan(f.input);
  const result = f.evaluator.evaluate({ ...f.input, expected_plan_digest: planned.plan_digest });
  const assurance = result.behavioral?.assurance as ReturnType<typeof collectSandboxRefusal>;
  expect(assurance.plan).toEqual(planned.plan);
  expect(assurance.host_execution).toBe(false);
  expect(assurance.artifacts).toEqual([]);
  expect(result.behavioral?.execution_verified).toBe(false);
  expect(result.evaluation.result).toBe('NOT_VERIFIED');
  expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(f.activeId);
  expect(() =>
    f.db.prepare('UPDATE behavioral_evidence SET evidence_digest=?').run('a'.repeat(64)),
  ).toThrow();
});
it('rejects a changed plan before creating any behavioral schema or report', () => {
  const f = fixture();
  expect(() => f.evaluator.evaluate({ ...f.input, expected_plan_digest: 'a'.repeat(64) })).toThrow(
    /fresh plan/,
  );
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='behavioral_schema'").get(),
  ).toBeUndefined();
  expect(f.store.getVersion(f.candidate.version.id).state.latest_evaluation_id).toBeNull();
});
it('rejects foreign projects and stale expected identity without revealing candidate content', () => {
  const f = fixture();
  expect(() => new SkillEvaluationService(f.db, f.otherScope).plan(f.input)).toThrow(
    /not available/,
  );
  expect(() => f.evaluator.plan({ ...f.input, expected_state_revision: 999 })).toThrow(/changed/);
  expect(() => f.evaluator.plan({ ...f.input, expected_content_hash: 'a'.repeat(64) })).toThrow(
    /changed/,
  );
});
for (const [key, value] of Object.entries({
  command: 'echo PASS',
  image: '/host/path',
  network: 'host',
  mounts: ['/Users'],
  backend: 'host',
  observations: { result: 'PASS' },
  verified: true,
  project_id: 'a'.repeat(64),
  policy: { timeout: 0 },
  assertions: [],
  environment: { SECRET: 'value' },
  operator_uid: 501,
})) {
  it(`refuses agent-provided ${key} execution/authority overrides`, () => {
    const f = fixture();
    expect(() => f.evaluator.plan({ ...f.input, [key]: value })).toThrow();
  });
}
const mutations: Array<[string, (a: ReturnType<typeof collectSandboxRefusal>) => void]> = [
  [
    'run replay',
    (a) => {
      a.run_id = randomUUID();
    },
  ],
  [
    'candidate substitution',
    (a) => {
      a.plan.version_id = randomUUID();
    },
  ],
  [
    'project substitution',
    (a) => {
      a.plan.project_id = 'a'.repeat(64);
    },
  ],
  [
    'package substitution',
    (a) => {
      a.plan.candidate_digest = 'a'.repeat(64);
    },
  ],
  [
    'suite substitution',
    (a) => {
      a.plan.suite_digest = 'a'.repeat(64);
    },
  ],
  [
    'policy substitution',
    (a) => {
      a.plan.policy_digest = 'a'.repeat(64);
    },
  ],
  [
    'environment substitution',
    (a) => {
      a.plan.environment.os = 'forged';
    },
  ],
  [
    'member omission',
    (a) => {
      a.plan.manifest.pop();
    },
  ],
  [
    'member change',
    (a) => {
      const member = a.plan.manifest[0];
      if (member) member.digest = 'a'.repeat(64);
    },
  ],
];
for (const [label, mutate] of mutations)
  it(`detects ${label} in a supplemental refusal`, () => {
    const f = fixture(),
      r = f.evaluator.evaluate(f.input);
    const a = structuredClone(r.behavioral?.assurance) as ReturnType<typeof collectSandboxRefusal>;
    mutate(a);
    expect(() => verifySandboxRefusal(a, r.evaluation, f.candidate.version.files)).toThrow();
  });
it('cannot forge observations, execution, artifacts or a PASS with stdout-like strings', () => {
  const f = fixture(),
    r = f.evaluator.evaluate(f.input),
    a = r.behavioral?.assurance as ReturnType<typeof collectSandboxRefusal>;
  for (const fields of [
    { host_execution: true },
    { observations: { stdout: 'PASS' } },
    { artifacts: [{ name: 'result', result: 'PASS' }] },
    { evidence_kind: 'PASS' },
  ])
    expect(() =>
      verifySandboxRefusal({ ...a, ...fields }, r.evaluation, f.candidate.version.files),
    ).toThrow();
});
it('validates suite and rejects arbitrary paths and oversized inputs through existing schemas', () => {
  const f = fixture();
  expect(() =>
    f.evaluator.plan({ ...f.input, suite_id: '../../policy', suite_version: 1 }),
  ).toThrow();
  expect(() => f.evaluator.plan({ ...f.input, expected_suite_digest: 'a'.repeat(64) })).toThrow(
    /digest/,
  );
  expect(() => f.evaluator.plan({ ...f.input, mode: 'static' })).toThrow();
  expect(
    skillEvaluateSchema.safeParse({ ...f.input, suite_id: 'x'.repeat(100000), suite_version: 1 })
      .success,
  ).toBe(false);
});
it('can describe an unsupported suite but cannot authorize or execute it', () => {
  const f = fixture();
  const r = f.evaluator.evaluate({ ...f.input, suite_id: 'unknown.suite', suite_version: 1 });
  expect(r.behavioral?.suite).toBeNull();
  expect(r.evaluation.result).toBe('NOT_VERIFIED');
});

it('invalidates a planned candidate when the active pointer changes (synthetic fixture transition)', () => {
  const f = fixture(),
    p = f.evaluator.plan(f.input);
  f.transition(f.candidate.identity.id, null, 'deactivate');
  expect(() => f.evaluator.evaluate({ ...f.input, expected_plan_digest: p.plan_digest })).toThrow(
    /fresh plan/,
  );
  expect(f.store.getVersion(f.candidate.version.id).state.latest_evaluation_id).toBeNull();
});
it('rejects receipt stripping even when an adversarial database owner recomputes the row checksum', () => {
  const f = fixture(),
    r = f.evaluator.evaluate(f.input);
  const row = f.db
    .prepare('SELECT evidence_json FROM behavioral_evidence WHERE evaluation_id=?')
    .get(r.evaluation.id) as { evidence_json: string };
  const e = JSON.parse(row.evidence_json);
  delete e.assurance;
  f.db.exec('DROP TRIGGER behavioral_evidence_no_update');
  f.db
    .prepare(
      'UPDATE behavioral_evidence SET evidence_json=?,evidence_digest=? WHERE evaluation_id=?',
    )
    .run(JSON.stringify(e), behavioralDigest(e), r.evaluation.id);
  expect(() => f.evaluator.getReport({ evaluation_id: r.evaluation.id })).toThrow(
    /integrity|binding/,
  );
});
it('rejects changed supporting content rather than trusting a matching old plan', () => {
  const f = fixture(),
    p = f.evaluator.plan(f.input);
  f.db.exec('DROP TRIGGER skill_versions_immutable_update');
  const files = structuredClone(f.candidate.version.files);
  const resource = files.find((x) => x.path !== 'SKILL.md');
  if (resource) resource.content = 'changed';
  f.db
    .prepare('UPDATE skill_versions SET files_json=? WHERE id=?')
    .run(JSON.stringify(files), f.candidate.version.id);
  expect(() => f.evaluator.evaluate({ ...f.input, expected_plan_digest: p.plan_digest })).toThrow(
    /integrity/,
  );
});
