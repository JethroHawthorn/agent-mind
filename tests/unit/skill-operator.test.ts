import { statSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import {
  migrate,
  openDatabase,
  SkillEvaluationService,
  SkillOperatorService,
  SkillReviewService,
} from '../../packages/core/src/index.js';
import {
  confirmOperatorReview,
  consumeOperatorGrant,
  operatorReviewText,
  reviewDigest,
} from '../../packages/core/src/operator-confirmation.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  return f;
}
it('rejects fabricated, serialized, and reused-capability-shaped grants at runtime', () => {
  for (const grant of [{ session: 'x' }, JSON.parse('{"session":"x"}'), undefined, true, 'yes'])
    expect(() => consumeOperatorGrant(grant, 'a'.repeat(64))).toThrow('terminal confirmation');
});
it('rejects non-TTY confirmation without any environment bypass', async () => {
  const previous = process.env.AGENTMIND_OPERATOR_CONFIRM;
  process.env.AGENTMIND_OPERATOR_CONFIRM = 'yes';
  try {
    await expect(confirmOperatorReview({ action: 'approve' })).rejects.toThrow(
      'interactive terminal',
    );
  } finally {
    if (previous === undefined) delete process.env.AGENTMIND_OPERATOR_CONFIRM;
    else process.env.AGENTMIND_OPERATOR_CONFIRM = previous;
  }
});
it('binds all displayed state, content, action, evaluation and reason in the context digest', () => {
  const original = {
    action: 'approve',
    reason: 'Inspected',
    version_id: 'v1',
    content_hash: 'a',
    evaluation_id: 'e1',
    active_version_id: 'v0',
    revision: 1,
  };
  for (const patch of [
    { action: 'promote' },
    { reason: 'Different' },
    { version_id: 'v2' },
    { content_hash: 'b' },
    { evaluation_id: 'e2' },
    { active_version_id: null },
    { revision: 2 },
  ])
    expect(reviewDigest({ ...original, ...patch })).not.toBe(reviewDigest(original));
});
it('denies obsolete evaluator policy even if stored result is PASS', () => {
  const f = fixture();
  const id = f.identity();
  const version = f.version(id);
  f.evaluation(version, 'PASS', {
    evaluator: 'agentmind-deterministic',
    evaluator_version: 'static-contract-v1/agentmind-markdown-v1',
  });
  expect(() =>
    new SkillOperatorService(f.db, f.scope).prepare({ action: 'approve', version_id: version }),
  ).toThrow('current accepted evaluator');
});
it('does not accept authority fields or unknown scope selectors in review operations', () => {
  const f = fixture();
  const id = f.identity();
  const version = f.version(id);
  const read = new SkillReviewService(f.db, f.scope);
  expect(() => read.review({ version_id: version, project_id: f.otherScope.id })).toThrow();
  expect(() => read.pending({ limit: 51 })).toThrow();
  expect(() =>
    new SkillOperatorService(f.db, f.scope).prepare({
      action: 'approve',
      version_id: version,
      operator_id: 'root',
    }),
  ).toThrow();
  expect(read.diff({ version_id: version }).diff[0]?.change).toBe('added');
});
it('migrates populated v6 transactionally, preserving existing versions and evaluations', () => {
  const f = fixture();
  const id = f.identity();
  const version = f.version(id);
  const evaluation = f.evaluation(version);
  const before = f.store.getVersion(version);
  f.db.exec(
    'DROP TABLE skill_distribution_events; DROP TABLE skill_distribution_intents; DROP TABLE skill_installations; DROP TABLE skill_registry_identity; DROP TABLE skill_operator_events; PRAGMA user_version=6',
  );
  migrate(f.db);
  migrate(f.db);
  expect(f.db.pragma('user_version', { simple: true })).toBe(8);
  expect(f.store.getVersion(version)).toEqual(before);
  expect(f.db.prepare('SELECT id FROM skill_evaluations WHERE id=?').get(evaluation)).toEqual({
    id: evaluation,
  });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_operator_events').get()).toEqual({ n: 0 });
  f.db.close();
  const reopened = openDatabase(f.path);
  try {
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
  } finally {
    reopened.close();
  }
});
it('rolls migration v7 back after partial DDL and allows a safe retry', () => {
  const f = fixture();
  f.db.exec(
    'DROP TABLE skill_distribution_events; DROP TABLE skill_distribution_intents; DROP TABLE skill_installations; DROP TABLE skill_registry_identity; DROP TABLE skill_operator_events; PRAGMA user_version=6',
  );
  const original = f.db.exec.bind(f.db);
  const fault = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
    if (sql.includes('PRAGMA user_version = 7')) {
      original(sql.slice(0, sql.indexOf('CREATE INDEX')));
      throw new Error('fixture migration fail');
    }
    return original(sql);
  });
  expect(() => migrate(f.db)).toThrow('fixture migration fail');
  fault.mockRestore();
  expect(f.db.pragma('user_version', { simple: true })).toBe(6);
  expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='skill_operator_events'").get(),
  ).toBeUndefined();
  migrate(f.db);
  expect(f.db.pragma('user_version', { simple: true })).toBe(8);
});
it('rejects source revocation after a passing evaluation before approval', () => {
  const f = fixture();
  const id = f.identity();
  const version = f.version(id, undefined, undefined, [
    {
      path: 'SKILL.md',
      content:
        '---\nname: retry-sqlite\ndescription: Retry SQLite busy errors safely\n---\n# Goal\nProse.\n# When to use\nProse.\n# Procedure\nProse.\n# Verification\nProse.',
    },
  ]);
  new SkillEvaluationService(f.db, f.scope).evaluate({
    version_id: version,
    expected_content_hash: f.store.getVersion(version).version.content_hash,
    expected_state_revision: 0,
  });
  const source = f.experiences.inspect(f.approvedSource.id);
  f.experiences.review({
    id: source.id,
    decision: 'rejected',
    expected_updated_at: source.updated_at,
    reviewer: 'fixture operator',
    reason: 'Revoked.',
  });
  expect(() =>
    new SkillOperatorService(f.db, f.scope).prepare({ action: 'approve', version_id: version }),
  ).toThrow('still be approved');
});

it('renders untrusted terminal control characters without changing the reviewed data', () => {
  const value = { content: '\u001b[2J\u202eCONFIRM counterfeit\u2028next\u{e0001}' };
  const rendered = operatorReviewText(value);
  expect(rendered).not.toContain('\u001b');
  expect(rendered).not.toContain('\u202e');
  expect(JSON.parse(rendered)).toEqual(value);
});

it('uses owner-only database permissions while the runtime and operator share the same owner', () => {
  const f = fixture();
  const info = statSync(f.path);
  if (process.platform !== 'win32') {
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.uid).toBe(process.getuid?.());
  }
});
