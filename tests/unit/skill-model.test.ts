import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashSkillFiles,
  MemoryService,
  migrate,
  openDatabase,
  SkillStore,
  skillEvaluationSchema,
  skillFilesSchema,
  skillIdentitySchema,
  skillNameSchema,
  skillVersionSchema,
  skillVersionStateSchema,
} from '../../packages/core/src/index.js';
import { skillFixture } from '../helpers/skill-fixture.js';
import { removeSkillSchema } from '../helpers/skill-schema.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  return f;
}

describe('P2-001 skill domain records', () => {
  it('creates scoped identities and immutable version snapshots from approved source references', () => {
    const f = fixture();
    const identity = f.identity();
    const version = f.version(identity);
    expect(f.store.getIdentity(identity)).toMatchObject({
      id: identity,
      project_id: f.scope.id,
      active_version_id: null,
      last_transition_id: null,
      revision: 0,
    });
    const snapshot = f.store.getVersion(version);
    expect(snapshot.state).toMatchObject({
      status: 'candidate',
      latest_evaluation_id: null,
      review_id: null,
    });
    expect(snapshot.sources[0]).toMatchObject({
      experience_id: f.approvedSource.id,
      experience_updated_at: f.approvedSource.updated_at,
    });
    expect(snapshot.version.content_hash).toBe(hashSkillFiles(snapshot.version.files));
    expect(
      skillVersionSchema.safeParse({ ...snapshot.version, content_hash: 'f'.repeat(64) }).success,
    ).toBe(false);
    expect(snapshot.untrusted_data).toBe(true);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('has deterministic bundle hashes independent of file order', () => {
    const files = [
      { path: 'SKILL.md', content: 'Procedure' },
      { path: 'references/notes.md', content: 'Notes' },
    ];
    expect(hashSkillFiles(files)).toBe(hashSkillFiles([...files].reverse()));
    expect(hashSkillFiles(files)).not.toBe(
      hashSkillFiles([{ ...files[0], path: 'SKILL.md', content: 'Changed' }]),
    );
  });
  it.each(['../escape', 'UpperCase', '-leading', 'trailing-', 'two--hyphens', 'a'.repeat(65)])(
    'rejects invalid skill identity name %s',
    (name) => {
      expect(skillNameSchema.safeParse(name).success).toBe(false);
      expect(() => fixture().identity(name)).toThrow();
    },
  );
  it.each([
    '../SKILL.md',
    '/SKILL.md',
    'references/../bad.md',
    'references\\bad.md',
    'C:/bad.md',
    './SKILL.md',
  ])('rejects unsafe snapshot path %s', (path) => {
    expect(skillFilesSchema.safeParse([{ path, content: 'data' }]).success).toBe(false);
  });
  it('rejects duplicate/missing SKILL.md snapshots and inconsistent record fields', () => {
    expect(skillFilesSchema.safeParse([{ path: 'reference.md', content: 'x' }]).success).toBe(
      false,
    );
    expect(
      skillFilesSchema.safeParse([
        { path: 'SKILL.md', content: 'x' },
        { path: 'skill.md', content: 'y' },
      ]).success,
    ).toBe(false);
    const f = fixture();
    const id = f.identity();
    expect(
      skillIdentitySchema.safeParse({ ...f.store.getIdentity(id), projectId: 'foreign' }).success,
    ).toBe(false);
    const version = f.version(id);
    expect(
      skillVersionStateSchema.safeParse({ ...f.store.getVersion(version).state, status: 'active' })
        .success,
    ).toBe(false);
  });
  it('allows duplicate names across projects but not within one project', () => {
    const f = fixture();
    f.identity();
    expect(() => f.identity()).toThrow();
    expect(() => f.identity('retry-sqlite', f.otherScope)).not.toThrow();
  });
  it('denies foreign and model-selected scope in the read boundary', () => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    const other = new SkillStore(f.db, f.otherScope);
    expect(() => other.getIdentity(id)).toThrow('not available');
    expect(() => other.getVersion(version)).toThrow('not available');
    expect(() => f.store.getVersion({ id: version, project_id: f.otherScope.id })).toThrow(
      'Expected a skill',
    );
  });
  it('requires approved, scoped source experiences and rejects unsealed versions at commit', () => {
    const f = fixture();
    const id = f.identity();
    expect(() => f.version(id, [f.source(false, false)])).toThrow('approved scoped experience');
    expect(() => f.version(id, [f.source(true)])).toThrow('approved scoped experience');
    expect(() => f.version(id, [])).toThrow('initial skill version');
    const sourceVersion = f.version(id);
    const original = f.db
      .prepare('SELECT * FROM skill_versions WHERE id = ?')
      .get(sourceVersion) as Record<string, unknown>;
    expect(() =>
      f.db
        .transaction(() => {
          f.db
            .prepare(`INSERT INTO skill_versions (id, skill_id, project_id, version, description, files_json, content_hash, source_agent, created_at)
        VALUES (@id, @skill_id, @project_id, @version, @description, @files_json, @content_hash, @source_agent, @created_at)`)
            .run({ ...original, id: randomUUID(), version: 2, created_at: f.now() });
        })
        .immediate(),
    ).toThrow('FOREIGN KEY');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get()).toEqual({ n: 1 });
  });
  it('prevents updates, deletes, REPLACE and late source edits to immutable snapshots', () => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    expect(() =>
      f.db
        .prepare('UPDATE skill_versions SET description = ? WHERE id = ?')
        .run('Changed', version),
    ).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM skill_versions WHERE id = ?').run(version)).toThrow(
      'immutable',
    );
    expect(() =>
      f.db
        .prepare(`INSERT OR REPLACE INTO skill_versions SELECT id, skill_id, project_id, version + 1,
      'Changed', files_json, content_hash, source_agent, created_at FROM skill_versions WHERE id = ?`)
        .run(version),
    ).toThrow();
    expect(() =>
      f.db
        .prepare(
          'INSERT OR REPLACE INTO skill_version_states SELECT * FROM skill_version_states WHERE version_id = ?',
        )
        .run(version),
    ).toThrow('initial');
    expect(() =>
      f.db
        .prepare('UPDATE skill_version_sources SET experience_updated_at = ? WHERE version_id = ?')
        .run(f.now(), version),
    ).toThrow('immutable');
    expect(() =>
      f.db.prepare('INSERT OR REPLACE INTO skills SELECT * FROM skills WHERE id = ?').run(id),
    ).toThrow('initial');
  });
});

describe('P2-001 lifecycle persistence invariants (synthetic reports; no evaluator)', () => {
  it.each(['FAIL', 'NOT_VERIFIED'])('does not approve or activate a %s report', (result) => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    f.evaluation(version, result);
    expect(() => f.review(version)).toThrow('invalid skill review');
    expect(() => f.transition(id, version)).toThrow();
    expect(f.store.getIdentity(id).active_version_id).toBeNull();
  });
  it('requires an actual stored PASS report and an explicit stored review before activation', () => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    expect(() => f.review(version)).toThrow('invalid skill review');
    expect(() =>
      f.db
        .prepare(
          "UPDATE skill_version_states SET status = 'approved', revision = revision + 1, updated_at = ? WHERE version_id = ?",
        )
        .run(f.now(), version),
    ).toThrow('invalid skill lifecycle');
    f.evaluation(version);
    expect(f.store.getVersion(version).state.status).toBe('candidate');
    expect(() => f.transition(id, version)).toThrow();
    const approval = f.review(version);
    f.transition(id, version);
    expect(f.store.getIdentity(id).active_version_id).toBe(version);
    expect(f.store.getVersion(version).state.review_id).toBe(approval);
  });
  it('rejects forged PASS checks, wrong content hashes and failed regression comparisons', () => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    expect(() =>
      f.evaluation(version, 'PASS', { checks_json: '[{"name":"fixture","result":"FAIL"}]' }),
    ).toThrow('invalid skill evaluation');
    expect(() => f.evaluation(version, 'PASS', { content_hash: 'f'.repeat(64) })).toThrow(
      'invalid skill evaluation',
    );
    f.evaluation(version);
    f.review(version);
    f.transition(id, version);
    const next = f.version(id);
    expect(() => f.evaluation(next, 'PASS', { regression_result: 'FAIL' })).toThrow(
      'invalid skill evaluation',
    );
    const report = {
      id: randomUUID(),
      version_id: next,
      skill_id: id,
      project_id: f.scope.id,
      evaluator: 'fixture',
      evaluator_version: '1',
      result: 'PASS',
      checks: [{ name: 'check', result: 'NOT_VERIFIED', details: 'Not run' }],
      baseline_version_id: version,
      regression_result: 'PASS',
      content_hash: 'a'.repeat(64),
      created_at: f.now(),
    };
    expect(skillEvaluationSchema.safeParse(report).success).toBe(false);
  });
  it('makes rejection terminal and prevents unsupported state transitions', () => {
    const f = fixture();
    const version = f.version(f.identity());
    f.review(version, 'rejected');
    expect(() => f.evaluation(version)).toThrow('invalid skill evaluation');
    expect(() => f.review(version)).toThrow('invalid skill review');
    expect(() =>
      f.db.prepare('DELETE FROM skill_version_states WHERE version_id = ?').run(version),
    ).toThrow('immutable');
  });
  it('preserves Phase 1 source revocation and blocks a later skill approval', () => {
    const f = fixture();
    const version = f.version(f.identity());
    f.evaluation(version);
    const current = f.experiences.inspect(f.approvedSource.id);
    f.experiences.review({
      id: current.id,
      decision: 'rejected',
      expected_updated_at: current.updated_at,
      reviewer: 'fixture reviewer',
      reason: 'Retracting the source experience.',
    });
    expect(() => f.review(version)).toThrow('invalid skill review');
    expect(f.store.getVersion(version).sources[0]?.experience_id).toBe(current.id);
    expect(f.experiences.search({ query: 'SQLite' }).experiences).toEqual([]);
  });
  it('keeps one active pointer while retaining historical approvals for rollback', () => {
    const f = fixture();
    const id = f.identity();
    const first = f.version(id);
    f.evaluation(first);
    f.review(first);
    f.transition(id, first);
    const next = f.version(id);
    f.evaluation(next);
    f.review(next);
    f.transition(id, next);
    const failed = f.version(id);
    f.evaluation(failed, 'FAIL');
    expect(() => f.review(failed)).toThrow();
    expect(f.store.getIdentity(id).active_version_id).toBe(next);
    f.transition(id, first, 'rollback');
    expect(f.store.getIdentity(id)).toMatchObject({ active_version_id: first, revision: 3 });
    expect(f.store.getVersion(next).state.status).toBe('approved');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 3 });
    expect(() => f.review(first, 'rejected')).toThrow();
    f.transition(id, null, 'deactivate');
    f.review(first, 'rejected');
    expect(f.store.getIdentity(id).active_version_id).toBeNull();
  });
  it('rejects stale revisions, foreign targets and direct pointer edits', () => {
    const f = fixture();
    const id = f.identity();
    const first = f.version(id);
    const second = f.version(id);
    for (const version of [first, second]) {
      f.evaluation(version);
      f.review(version);
    }
    f.transition(id, first);
    expect(() => f.transition(id, second, 'promote', { expected_revision: 0 })).toThrow(
      'invalid skill promotion',
    );
    expect(() => f.transition(id, second)).toThrow('invalid skill promotion'); // evaluated against stale null baseline
    const foreignId = f.identity('foreign-skill', f.otherScope);
    const foreign = f.version(foreignId, [f.source(true)], f.otherScope);
    f.evaluation(foreign);
    f.review(foreign);
    expect(() => f.transition(id, foreign)).toThrow();
    expect(() =>
      f.db
        .prepare('UPDATE skills SET active_version_id = ?, revision = revision + 1 WHERE id = ?')
        .run(second, id),
    ).toThrow('audited transition');
    expect(f.store.getIdentity(id).active_version_id).toBe(first);
  });
  it('cannot activate another skill identity’s approved version within the same project', () => {
    const f = fixture();
    const first = f.identity('first-skill');
    const second = f.identity('second-skill');
    const target = f.version(second);
    f.evaluation(target);
    f.review(target);
    expect(() => f.transition(first, target)).toThrow();
    expect(f.store.getIdentity(first).active_version_id).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 0 });
  });
  it('preserves immutable report/history rows and rolls back a failed pointer mutation', () => {
    const f = fixture();
    const id = f.identity();
    const version = f.version(id);
    f.evaluation(version);
    f.review(version);
    for (const table of ['skill_evaluations', 'skill_reviews']) {
      expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow('immutable');
      expect(() => f.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(
        'immutable',
      );
    }
    f.db.exec(
      "CREATE TRIGGER fixture_fail_pointer BEFORE UPDATE ON skills BEGIN SELECT RAISE(ABORT, 'fixture pointer failure'); END",
    );
    expect(() => f.transition(id, version)).toThrow('fixture pointer failure');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 0 });
    expect(f.store.getIdentity(id).active_version_id).toBeNull();
  });
});

describe('P2-001 migration and restart', () => {
  it('upgrades populated v4, retains Phase 0/1 records, and reopens model records', () => {
    const f = fixture();
    const memory = new MemoryService(f.db, f.scope).save({
      title: 'Legacy',
      content: 'SQLite memory stays intact',
    });
    removeSkillSchema(f.db);
    const experiences = f.db.prepare('SELECT * FROM experiences').all();
    const reviews = f.db.prepare('SELECT * FROM experience_reviews').all();
    migrate(f.db);
    migrate(f.db);
    expect(f.db.pragma('user_version', { simple: true })).toBe(9);
    expect(f.db.prepare('SELECT * FROM experiences').all()).toEqual(experiences);
    expect(f.db.prepare('SELECT * FROM experience_reviews').all()).toEqual(reviews);
    expect(new MemoryService(f.db, f.scope).search({ query: 'SQLite' })).toEqual([memory]);
    const id = f.identity();
    const version = f.version(id);
    f.evaluation(version);
    f.review(version);
    f.transition(id, version);
    const snapshot = f.store.getVersion(version);
    f.db.close();
    const reopened = openDatabase(f.path);
    try {
      expect(new SkillStore(reopened, f.scope).getVersion(version)).toEqual(snapshot);
      expect(new SkillStore(reopened, f.scope).getIdentity(id).active_version_id).toBe(version);
      expect(reopened.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
    }
  });
  it('rolls back v5 DDL and restores foreign keys if migration fails partway', () => {
    const f = fixture();
    removeSkillSchema(f.db);
    const original = f.db.exec.bind(f.db);
    const fault = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
      if (sql.includes('PRAGMA user_version = 5')) {
        original(sql.slice(0, sql.indexOf('CREATE TABLE skill_evaluations')));
        throw new Error('fixture migration failure');
      }
      return original(sql);
    });
    expect(() => migrate(f.db)).toThrow('fixture migration failure');
    fault.mockRestore();
    expect(f.db.pragma('user_version', { simple: true })).toBe(4);
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'skills'").get(),
    ).toBeUndefined();
    expect(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'skill_experience_scope'").get(),
    ).toBeUndefined();
    migrate(f.db);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
