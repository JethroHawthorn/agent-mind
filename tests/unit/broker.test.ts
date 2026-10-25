import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  BrokerService,
  MemoryService,
  migrateBroker,
  openDatabase,
  principal,
  resolveProject,
  validateBrokerConfig,
} from '../../packages/core/src/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
/** These are protocol/domain tests with synthetic UID fixtures, NOT OS isolation evidence. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-broker-'));
  for (const name of ['a', 'b', 'home']) mkdirSync(join(root, name));
  const path = join(root, 'registry.db');
  let db = openDatabase(path);
  const config = validateBrokerConfig({
    schema_version: 1,
    broker_uid: 201,
    runtime_root: root,
    registry_directory: root,
    socket_directory: root,
    projects: ['a', 'b'].map((name) => ({
      name,
      root: join(root, name),
      project_key: `protected-project-${name}`,
      distribution_home: join(root, 'home'),
    })),
    agents: [
      { uid: 203, project: 'a', source: 'codex' },
      { uid: 204, project: 'a', source: 'claude' },
      { uid: 205, project: 'b', source: 'unknown' },
    ],
    operators: [{ uid: 202, projects: ['a'] }],
  });
  let service = new BrokerService(db, config);
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (op: string, input: unknown = {}, uid = 203) =>
    service.handle('agent', { uid, gid: 20 }, { schema_version: 1, op, input });
  const operator = (op: string, input: unknown, uid = 202, project = 'a') =>
    service.handle('operator', { uid, gid: 20 }, { schema_version: 1, op, project, input });
  const prepare = (input: unknown) =>
    operator('operator_prepare', input) as {
      challenge_id: string;
      digest: string;
      preview: unknown;
    };
  const commit = (r: ReturnType<typeof prepare>) =>
    operator('operator_commit', { challenge_id: r.challenge_id, review_digest: r.digest });
  const record = () =>
    call('experience_record', {
      problem: 'Clamp ignores lower bound',
      solution: 'Apply both bounds with Math.max and Math.min',
      outcome: {
        status: 'succeeded',
        summary: 'Explicit test fixture; no native CLI verification',
      },
    }) as { experience: { id: string; updated_at: string } };
  const candidate = () => {
    const e = record().experience;
    commit(
      prepare({
        kind: 'experience',
        request: {
          id: e.id,
          decision: 'approved',
          expected_updated_at: e.updated_at,
          reason: 'Review fixture evidence',
        },
      }),
    );
    const p = call('skill_propose', {
      name: 'safe-clamp',
      description: 'Apply lower and upper numeric bounds',
      source_experience_ids: [e.id],
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: safe-clamp\ndescription: Apply lower and upper numeric bounds\n---\n# Goal\nClamp a number.\n# When to use\nFor bounded numbers.\n# Procedure\nApply both bounds.\n# Verification\nCheck lower, upper and in-range cases.\n',
        },
      ],
    }) as { version: { id: string; content_hash: string }; state: { revision: number } };
    call('skill_evaluate', {
      version_id: p.version.id,
      expected_content_hash: p.version.content_hash,
      expected_state_revision: p.state.revision,
    });
    return p;
  };
  return {
    root,
    path,
    config,
    call,
    operator,
    prepare,
    commit,
    record,
    candidate,
    get db() {
      return db;
    },
    restart() {
      db.close();
      db = openDatabase(path);
      service = new BrokerService(db, config);
    },
  };
}
it('requires four distinct principals and fixed per-project agent mappings', () => {
  const f = fixture();
  expect(() =>
    validateBrokerConfig({
      ...f.config,
      projects: f.config.projects.map((p) => ({ ...p, distribution: 'untrusted-copy' })),
    }),
  ).toThrow();
  for (const patch of [
    { broker_uid: 202 },
    { agents: [{ uid: 202, project: 'a', source: 'codex' }] },
    {
      agents: [
        { uid: 203, project: 'a', source: 'codex' },
        { uid: 203, project: 'b', source: 'claude' },
      ],
    },
    { agents: [{ uid: 0, project: 'a', source: 'codex' }] },
    { agents: [{ uid: 203, project: 'missing', source: 'codex' }] },
  ])
    expect(() => validateBrokerConfig({ ...f.config, ...patch })).toThrow();
  expect(() => principal(f.config, 'agent', { uid: 203, gid: 20 }, 'b')).toThrow();
  expect(() => principal(f.config, 'operator', { uid: 202, gid: 20 }, 'b')).toThrow();
});
it.each([
  'operator_prepare',
  'operator_commit',
  'approve',
  'promote',
  'rollback',
  'deactivate',
  'distribution_plan',
  'distribution_verify',
  'sync',
  'sql',
  '__proto__',
])('denies agent operation %s at the dispatcher boundary', (op) => {
  const f = fixture();
  expect(() =>
    f.call(op, { sql: 'UPDATE skills SET active_version_id=1', approvedBy: 'human' }),
  ).toThrow();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_operator_events').get()).toEqual({ n: 0 });
});
it('rejects forged caller, peer credentials, project and alternate registry metadata', () => {
  const f = fixture();
  for (const patch of [
    { uid: 202 },
    { peer: { uid: 202, gid: 20 } },
    { project: 'b' },
    { db: '/tmp/alternate.db' },
    { approvedBy: 'human' },
  ])
    expect(() =>
      new BrokerService(f.db, f.config).handle(
        'agent',
        { uid: 203, gid: 20 },
        { schema_version: 1, op: 'skill_pending', input: {}, ...patch },
      ),
    ).toThrow();
  expect(() => f.call('skill_pending', {}, 999)).toThrow();
  expect(() =>
    f.operator(
      'operator_prepare',
      { kind: 'skill', request: { action: 'approve', version_id: 'x' } },
      203,
    ),
  ).toThrow();
});
it('shares persisted experiences between scoped source identities without cross-project retrieval', () => {
  const f = fixture();
  f.record();
  f.restart();
  expect(f.call('experience_search', { query: 'Clamp' }, 204)).toMatchObject({
    experiences: [{ source_agent: 'codex' }],
  });
  expect(f.call('experience_search', { query: 'Clamp' }, 205)).toMatchObject({ experiences: [] });
  expect(() => f.call('experience_record', { project_id: 'a', source_agent: 'claude' })).toThrow();
});
it('binds protected approval and promotion to exact review, peer identity and digest', () => {
  const f = fixture();
  const p = f.candidate();
  expect(() =>
    f.prepare({ kind: 'skill', request: { action: 'promote', version_id: p.version.id } }),
  ).toThrow();
  const approval = f.prepare({
    kind: 'skill',
    request: { action: 'approve', version_id: p.version.id },
  });
  expect(() =>
    f.operator(
      'operator_commit',
      { challenge_id: approval.challenge_id, review_digest: approval.digest },
      203,
    ),
  ).toThrow();
  expect(() =>
    f.operator('operator_commit', {
      challenge_id: approval.challenge_id,
      review_digest: '0'.repeat(64),
    }),
  ).toThrow();
  expect(f.commit(approval)).toMatchObject({ status: 'applied', action: 'approve' });
  expect(approval).not.toHaveProperty('confirmation');
  expect(() => f.commit(approval)).toThrow();
  expect(
    f.commit(
      f.prepare({ kind: 'skill', request: { action: 'promote', version_id: p.version.id } }),
    ),
  ).toMatchObject({ active_version_id: p.version.id });
  const audit = f.db
    .prepare("SELECT operator_id,metadata_json FROM skill_operator_events WHERE action='approve'")
    .get() as { operator_id: string; metadata_json: string };
  expect(audit.operator_id).toBe('uid:202:broker-operator');
  expect(JSON.parse(audit.metadata_json)).toMatchObject({
    boundary: 'os-peer-v1',
    broker_peer: { uid: 202, gid: 20 },
  });
});
it('rejects stale approvals and persists spent review claims across restart', () => {
  const f = fixture();
  const p = f.candidate();
  const a = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  const b = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  f.commit(b);
  expect(() => f.commit(a)).toThrow('stale');
  f.restart();
  expect(() => f.commit(a)).toThrow();
});
it('atomically rolls back domain changes when broker audit persistence fails', () => {
  const f = fixture();
  const p = f.candidate();
  const a = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  f.db.exec(
    "CREATE TRIGGER fault_broker_audit BEFORE INSERT ON broker_audit WHEN NEW.result='applied' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  expect(() => f.commit(a)).toThrow();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews').get()).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER fault_broker_audit');
  expect(() => f.commit(a)).toThrow();
  expect(
    f.commit(
      f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } }),
    ),
  ).toMatchObject({ status: 'applied' });
});
it('rejects expired, malformed, oversized and forged operator reviews and disabled distribution', () => {
  const f = fixture();
  const p = f.candidate();
  const a = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  f.db.prepare('UPDATE broker_challenges SET expires=0 WHERE id=?').run(a.challenge_id);
  expect(() => f.commit(a)).toThrow();
  expect(() =>
    f.prepare({
      kind: 'skill',
      request: { action: 'approve', version_id: p.version.id, approvedBy: 'human' },
    }),
  ).toThrow();
  expect(() => f.call('memory_save', { title: 'x', content: 'x'.repeat(131073) })).toThrow();
  expect(() =>
    f.prepare({
      kind: 'distribution',
      request: { skill_id: p.version.id, target: 'all', scope: 'project' },
    }),
  ).toThrow('disabled');
});
it('fails closed on unknown broker schema without changing registry data', () => {
  const f = fixture();
  f.record();
  f.db.exec('PRAGMA ignore_check_constraints=ON;UPDATE broker_schema SET version=3');
  expect(() => migrateBroker(f.db)).toThrow('Unsupported');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 1 });
  expect(() =>
    f.db.exec('INSERT OR REPLACE INTO broker_audit SELECT * FROM broker_audit LIMIT 1'),
  ).toThrow('immutable');
});

it('retains administrator-bound legacy scope IDs without rewriting existing memories', () => {
  const f = fixture();
  const scope = resolveProject(join(f.root, 'a'), join(f.root, 'a'));
  new MemoryService(f.db, scope).save({ title: 'legacy fact', content: 'preserve existing scope' });
  const config = validateBrokerConfig({
    ...f.config,
    projects: f.config.projects.map((p) =>
      p.name === 'a' ? { ...p, project_key: undefined, scope_id: scope.id } : p,
    ),
  });
  const broker = new BrokerService(f.db, config);
  expect(
    broker.handle(
      'agent',
      { uid: 203, gid: 20 },
      { schema_version: 1, op: 'memory_search', input: { query: 'legacy' } },
    ),
  ).toMatchObject({ memories: [{ project_id: scope.id }] });
  expect(
    () =>
      new BrokerService(f.db, {
        ...config,
        projects: config.projects.map((p) =>
          p.name === 'a' ? { ...p, root: join(f.root, 'b') } : p,
        ),
      }),
  ).toThrow();
});

it('never authorizes an agent using a complete public operator review ticket', () => {
  const f = fixture();
  const p = f.candidate();
  const r = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  expect(r).not.toHaveProperty('confirmation');
  expect(() =>
    f.call('operator_commit', { challenge_id: r.challenge_id, review_digest: r.digest }),
  ).toThrow();
  expect(f.call('skill_get', { version_id: p.version.id })).toMatchObject({
    state: { status: 'candidate' },
  });
  expect(() =>
    f.operator('operator_commit', {
      challenge_id: r.challenge_id,
      confirmation: 'legacy bearer value',
    }),
  ).toThrow();
  expect(f.commit(r)).toMatchObject({ status: 'applied' });
});
it('migrates broker v1 transactionally, invalidates outstanding legacy reviews and preserves registry data', () => {
  const f = fixture();
  const p = f.candidate();
  const r = f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } });
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get();
  f.db.exec(`ALTER TABLE broker_challenges DROP COLUMN protocol_version;
 ALTER TABLE broker_challenges RENAME COLUMN review_binding TO confirmation_hash;
 ALTER TABLE broker_schema RENAME TO broker_schema_v2;
 CREATE TABLE broker_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO broker_schema VALUES(1);DROP TABLE broker_schema_v2;`);
  migrateBroker(f.db);
  expect(f.db.prepare('SELECT version FROM broker_schema').get()).toEqual({ version: 2 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM broker_challenges').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual(before);
  expect(() => f.commit(r)).toThrow();
  expect(
    f.commit(
      f.prepare({ kind: 'skill', request: { action: 'approve', version_id: p.version.id } }),
    ),
  ).toMatchObject({ status: 'applied' });
});
