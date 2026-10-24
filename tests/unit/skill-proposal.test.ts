import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  migrate,
  SkillProposalService,
  SkillStore,
  skillProposeSchema,
} from '../../packages/core/src/index.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  return { ...f, proposals: new SkillProposalService(f.db, f.scope, 'codex') };
}
function proposal(sourceId: string, patch = {}) {
  return {
    name: 'retry-sqlite',
    description: 'Retry SQLite startup safely',
    source_experience_ids: [sourceId],
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: retry-sqlite\ndescription: Retry SQLite startup safely\n---\n\n# Procedure\nUse bounded retry and inspect test evidence.\n',
      },
    ],
    ...patch,
  };
}

describe('P2-002 deterministic candidate authoring', () => {
  it('stores a candidate with server-owned scope/provenance and no evaluation, approval or activation', () => {
    const f = fixture();
    const result = f.proposals.propose(proposal(f.approvedSource.id));
    expect(result.version).toMatchObject({
      version: 1,
      project_id: f.scope.id,
      source_agent: 'codex',
    });
    expect(result.state).toMatchObject({
      status: 'candidate',
      latest_evaluation_id: null,
      review_id: null,
    });
    expect(result.identity.active_version_id).toBeNull();
    expect(result.evaluation_result).toBe('NOT_VERIFIED');
    expect(result.untrusted_data).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_evaluations').get()).toEqual({ n: 0 });
  });
  it('appends a numbered candidate only against the expected latest version and preserves approved content', () => {
    const f = fixture();
    const first = f.proposals.propose(proposal(f.approvedSource.id));
    f.evaluation(first.version.id);
    f.review(first.version.id);
    f.transition(first.identity.id, first.version.id);
    const original = f.store.getVersion(first.version.id);
    expect(() => f.proposals.propose(proposal(f.approvedSource.id))).toThrow(
      'latest version changed',
    );
    const second = f.proposals.propose(
      proposal(f.approvedSource.id, { expected_latest_version: 1 }),
    );
    expect(second.version.version).toBe(2);
    expect(second.state.status).toBe('candidate');
    expect(second.identity.active_version_id).toBe(first.version.id);
    expect(f.store.getVersion(first.version.id)).toEqual(original);
  });
  it('supports model lifecycle writers reading persisted timestamps with a frozen clock after a proposal', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1792800000000);
    const f = fixture();
    const candidate = f.proposals.propose(proposal(f.approvedSource.id));
    f.evaluation(candidate.version.id);
    f.review(candidate.version.id);
    f.transition(candidate.identity.id, candidate.version.id);
    expect(f.store.getIdentity(candidate.identity.id).active_version_id).toBe(candidate.version.id);
  });
  it('rejects foreign, unapproved and revoked sources without leaving an identity or version', () => {
    const f = fixture();
    for (const source of [f.source(true), f.source(false, false)])
      expect(() => f.proposals.propose(proposal(source.id))).toThrow('currently approved');
    const source = f.experiences.inspect(f.approvedSource.id);
    f.experiences.review({
      id: source.id,
      decision: 'rejected',
      expected_updated_at: source.updated_at,
      reviewer: 'human',
      reason: 'Retracted source',
    });
    expect(() => f.proposals.propose(proposal(source.id))).toThrow('currently approved');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
  });
  it.each([
    { project_id: 'foreign' },
    { source_agent: 'claude' },
    { status: 'approved' },
    { reviewer: 'human' },
    { actor: 'admin' },
    { evaluation_result: 'PASS' },
  ])('rejects forged authority fields', (extra) => {
    const f = fixture();
    expect(() => f.proposals.propose(proposal(f.approvedSource.id, extra))).toThrow(
      'Invalid skill proposal',
    );
  });
  it.each([
    'name: retry-sqlite\ndescription: Retry SQLite startup safely\n',
    '---\nname: retry-sqlite\nname: other\ndescription: Retry SQLite startup safely\n---\nBody',
    '---\nname: wrong-name\ndescription: Retry SQLite startup safely\n---\nBody',
    '---\nname: retry-sqlite\ndescription: !unsafe value\n---\nBody',
    '---\nname: &name retry-sqlite\ndescription: *name\n---\nBody',
    '---\nname: retry-sqlite\ndescription: Retry SQLite startup safely\nallowed-tools: Bash\n---\nBody',
  ])('rejects malformed, mismatched or unsupported frontmatter', (content) => {
    const f = fixture();
    expect(() =>
      f.proposals.propose(
        proposal(f.approvedSource.id, { files: [{ path: 'SKILL.md', content }] }),
      ),
    ).toThrow('frontmatter');
  });
  it('rejects executable files, traversal, symlink-shaped entries and known secrets before persistence', () => {
    const f = fixture();
    const base = proposal(f.approvedSource.id);
    for (const path of ['scripts/run.sh', '../bad.md', '/tmp/bad.md', 'agents/openai.yaml']) {
      expect(() =>
        f.proposals.propose({ ...base, files: [...base.files, { path, content: 'data' }] }),
      ).toThrow();
    }
    expect(
      skillProposeSchema.safeParse({
        ...base,
        files: [{ path: 'SKILL.md', content: 'x', symlink: '/tmp/target' }],
      }).success,
    ).toBe(false);
    const secret = `sk-proj-${'x'.repeat(24)}`;
    expect(() =>
      f.proposals.propose({
        ...base,
        files: [
          { ...base.files[0], path: 'SKILL.md', content: `${base.files[0]?.content}\n${secret}` },
        ],
      }),
    ).toThrow('Possible secret');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get()).toEqual({ n: 0 });
  });
  it('rejects quoted credential assignments without persisting any candidate', () => {
    const f = fixture();
    const base = proposal(f.approvedSource.id);
    expect(() =>
      f.proposals.propose({
        ...base,
        files: [
          {
            path: 'SKILL.md',
            content: `${base.files[0]?.content}\n{"password": "sensitive-example-value"}`,
          },
        ],
      }),
    ).toThrow('Possible secret');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
  });
  it('rolls back identity, FTS and version writes when sealing fails', () => {
    const f = fixture();
    f.db.exec(
      "CREATE TRIGGER fixture_seal_failure BEFORE INSERT ON skill_version_states BEGIN SELECT RAISE(ABORT, 'seal failed'); END",
    );
    expect(() => f.proposals.propose(proposal(f.approvedSource.id))).toThrow('seal failed');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
    expect(
      f.db.prepare("SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'sqlite'").all(),
    ).toEqual([]);
  });
  it('denies recording when proposals are disabled by runtime policy', () => {
    const f = fixture();
    expect(() =>
      new SkillProposalService(f.db, f.scope, 'codex', false).propose(
        proposal(f.approvedSource.id),
      ),
    ).toThrow('disabled');
  });
});

describe('scoped skill discovery', () => {
  it('lists and searches bounded summaries while keeping drafts separate from active lookup', () => {
    const f = fixture();
    const first = f.proposals.propose(proposal(f.approvedSource.id));
    expect(f.store.list().skills[0]?.identity.id).toBe(first.identity.id);
    expect(f.store.search('SQLite').skills).toHaveLength(1);
    expect(f.store.getActiveByName('retry-sqlite')).toBeNull();
    expect(() => f.store.get({ name: 'retry-sqlite' })).toThrow('not available');
    expect(f.store.get({ name: 'retry-sqlite', version: 1 }).version.id).toBe(first.version.id);
    expect(f.store.get({ version_id: first.version.id }).version.id).toBe(first.version.id);
    f.evaluation(first.version.id);
    f.review(first.version.id);
    f.transition(first.identity.id, first.version.id);
    expect(f.store.getActiveByName('retry-sqlite')?.version.id).toBe(first.version.id);
    expect(f.store.list({ status: 'active' }).skills).toHaveLength(1);
  });
  it('isolates foreign names, searches and active pointers and excludes rejected-only identities by default', () => {
    const f = fixture();
    const first = f.proposals.propose(proposal(f.approvedSource.id));
    f.review(first.version.id, 'rejected');
    expect(f.store.list().skills).toEqual([]);
    expect(f.store.search('sqlite').skills).toEqual([]);
    expect(f.store.list({ status: 'rejected' }).skills).toHaveLength(1);
    const other = new SkillStore(f.db, f.otherScope);
    expect(other.list({ status: 'rejected' }).skills).toEqual([]);
    expect(other.getActiveByName('retry-sqlite')).toBeNull();
    expect(() => other.get({ version_id: first.version.id })).toThrow('not available');
  });
  it('bounds paging, rejects scope selectors and treats FTS syntax as literal text', () => {
    const f = fixture();
    for (const name of ['alpha', 'beta', 'gamma']) {
      const base = proposal(f.approvedSource.id);
      f.proposals.propose({
        ...base,
        name,
        files: [
          {
            path: 'SKILL.md',
            content: base.files[0]?.content.replace('name: retry-sqlite', `name: ${name}`),
          },
        ],
      });
    }
    const first = f.store.list({ limit: 1 });
    expect(first.skills).toHaveLength(1);
    expect(first.next_offset).toBe(1);
    expect(f.store.list({ limit: 1, offset: 1 }).skills[0]?.identity.name).toBe('beta');
    expect(f.store.search('" * : ()').skills).toEqual([]);
    expect(f.store.search("' OR 1=1; DROP TABLE skills").skills).toEqual([]);
    expect(() => f.store.list({ limit: 51 })).toThrow();
    expect(() => f.store.list({ project_id: f.otherScope.id })).toThrow();
    expect(() => f.store.search('sqlite', { project_id: f.otherScope.id })).toThrow();
    expect(f.store.search(f.scope.id).skills).toEqual([]);
  });
  it('rebuilds discovery for populated v5 and preserves versions and lifecycle history', () => {
    const f = fixture();
    const first = f.proposals.propose(proposal(f.approvedSource.id));
    const before = f.store.getVersion(first.version.id);
    f.db.exec(
      'DROP TRIGGER skills_fts_insert; DROP TRIGGER skills_fts_delete; DROP TRIGGER skills_fts_update; DROP TABLE skills_fts; PRAGMA user_version = 5',
    );
    migrate(f.db);
    migrate(f.db);
    expect(f.db.pragma('user_version', { simple: true })).toBe(6);
    expect(f.store.getVersion(first.version.id)).toEqual(before);
    expect(f.store.search('SQLite').skills[0]?.identity.id).toBe(first.identity.id);
  });
  it('rolls back schema v6 DDL and supports a safe retry', () => {
    const f = fixture();
    const saved = f.proposals.propose(proposal(f.approvedSource.id));
    f.db.exec(
      'DROP TRIGGER skills_fts_insert; DROP TRIGGER skills_fts_delete; DROP TRIGGER skills_fts_update; DROP TABLE skills_fts; PRAGMA user_version = 5',
    );
    const original = f.db.exec.bind(f.db);
    const fault = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
      if (sql.includes('PRAGMA user_version = 6')) {
        original(sql.slice(0, sql.indexOf('CREATE TRIGGER')));
        throw new Error('discovery fixture failure');
      }
      return original(sql);
    });
    expect(() => migrate(f.db)).toThrow('discovery fixture failure');
    fault.mockRestore();
    expect(f.db.pragma('user_version', { simple: true })).toBe(5);
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'skills_fts'").get(),
    ).toBeUndefined();
    migrate(f.db);
    expect(f.store.search('SQLite').skills[0]?.identity.id).toBe(saved.identity.id);
  });
});
