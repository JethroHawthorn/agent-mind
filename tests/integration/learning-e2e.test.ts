import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  hashSkillFiles,
  migrate,
  openUsageDatabase,
  SkillDistributionService,
  SkillOperatorService,
  SkillUsageService,
} from '../../packages/core/src/index.js';
import { learningE2E } from '../helpers/learning-e2e.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await learningE2E();
  cleanup.push(f.cleanup);
  return f;
}
function passed(r: { status: number; output: string }) {
  expect(r.status, r.output.slice(-2000)).toBe(0);
}
function copies(
  f: Awaited<ReturnType<typeof learningE2E>>,
  candidate: { version: { content_hash: string; files: Array<{ path: string; content: string }> } },
) {
  for (const folder of ['.agents', '.claude']) {
    const dest = join(f.root, folder, 'skills', f.fixture.name);
    const files = candidate.version.files.map((file) => ({
      path: file.path,
      content: readFileSync(join(dest, file.path), 'utf8'),
    }));
    expect(hashSkillFiles(files)).toBe(candidate.version.content_hash);
    expect(files).toEqual(candidate.version.files);
  }
}
it('E2E-01/02/03/07: complete offline MCP learning path, exact authorization, distribution and evidence semantics', async () => {
  const f = await fixture();
  expect(f.test(false)).toMatchObject({ exit_code: 1, passed: false });
  expect(f.test(true)).toMatchObject({ exit_code: 0, passed: true });
  const experience = await f.capture();
  expect(experience).toMatchObject({
    project_id: f.scope.id,
    source_agent: 'codex',
    approval_status: 'candidate',
    verification_status: 'unverified',
  });
  const claude = await f.connect('claude');
  const retrieved = await f.call(claude, 'experience_search', { query: 'Clamp regression' });
  expect(retrieved.experiences[0].id).toBe(experience.id);
  expect(retrieved.experiences[0].solution).toBe(experience.solution);
  const foreign = await f.connect('claude', true);
  expect(
    (await f.call(foreign, 'experience_search', { query: 'Clamp regression' })).experiences,
  ).toEqual([]);
  passed(await f.approveExperience(experience));
  const v1 = await f.propose(experience.id);
  expect(
    (await f.call(claude, 'skill_validate', { version_id: v1.version.id })).validation_result,
  ).toBe('VALID');
  const evaluation = await f.evaluate(v1.version.id);
  expect(evaluation.evaluation).toMatchObject({
    result: 'PASS',
    content_hash: v1.version.content_hash,
  });
  expect(f.store.getVersion(v1.version.id).state.status).toBe('candidate');
  expect((await f.operator('promote', v1.version.id)).status).toBe(1);
  expect(() =>
    new SkillOperatorService(f.db, f.scope).commit(
      { action: 'approve', version_id: v1.version.id },
      { session: 'forged' },
    ),
  ).toThrow('terminal confirmation');
  passed(await f.operator('approve', v1.version.id));
  passed(await f.operator('promote', v1.version.id));
  const audit = f.db
    .prepare(
      'SELECT action,content_hash,evaluation_id FROM skill_operator_events ORDER BY created_at',
    )
    .all();
  expect(audit).toEqual(
    ['approve', 'promote'].map((action) => ({
      action,
      content_hash: v1.version.content_hash,
      evaluation_id: evaluation.evaluation.id,
    })),
  );
  const service = new SkillDistributionService(f.db, f.scope, f.home);
  expect(
    service
      .plan({ skill_id: v1.identity.id, target: 'all', scope: 'project' })
      .entries.map((e) => e.action),
  ).toEqual(['INSTALL', 'INSTALL']);
  const sentinel = join(f.root, '.agents', 'skills', 'user-owned');
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, 'SKILL.md'), 'USER SENTINEL');
  passed(await f.sync(v1.identity.id));
  copies(f, v1);
  const before = f.db
    .prepare('SELECT manifest_json FROM skill_installations ORDER BY target')
    .all();
  const auditBefore = f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get() as {
    n: number;
  };
  passed(await f.sync(v1.identity.id));
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get()).toEqual({
    n: auditBefore.n + 2,
  });
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM skill_distribution_events WHERE action='SKIP'").get(),
  ).toEqual({ n: 2 });
  expect(
    f.db.prepare('SELECT manifest_json FROM skill_installations ORDER BY target').all(),
  ).toEqual(before);
  expect(readFileSync(join(sentinel, 'SKILL.md'), 'utf8')).toBe('USER SENTINEL');
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  expect(usage.collectInstallations().events?.filter((e) => e.stored)).toHaveLength(2);
  await f.call(claude, 'skill_get', { version_id: v1.version.id });
  const codex = await f.connect('codex');
  const base = {
    schema_version: 1,
    version_id: v1.version.id,
    artifact_digest: v1.version.content_hash,
    task_id: 'clamp-task',
    session_id: 'same-session',
  };
  const success = {
    ...base,
    event_id: f.event(),
    event_type: 'task_succeeded',
    note: 'password=must-not-persist',
  };
  await f.call(codex, 'skill_usage_record', success);
  expect((await f.call(codex, 'skill_usage_record', success)).duplicate).toBe(true);
  for (const event_type of ['invoked', 'task_failed', 'task_unknown'])
    await f.call(claude, 'skill_usage_record', { ...base, event_id: f.event(), event_type });
  expect(usage.runCheck({ ...base, event_id: f.event(), event_type: 'executed' })).toMatchObject({
    stored: true,
    event: { verification: 'verified_check', details: { task_success_verified: false } },
  });
  const summary = await f.call(claude, 'skill_usage_summary', {});
  expect(
    summary.groups.find((g: { source_cli: string }) => g.source_cli === 'codex'),
  ).toMatchObject({
    observed_invocations: 0,
    verified_outcomes: 0,
    unverified_outcomes: 1,
    success: 1,
    failure: 0,
    unknown: 0,
  });
  expect(
    summary.groups.find((g: { source_cli: string }) => g.source_cli === 'claude'),
  ).toMatchObject({
    observed_invocations: 0,
    reported_invocations: 1,
    verified_outcomes: 0,
    unverified_outcomes: 2,
    success: 0,
    failure: 1,
    unknown: 1,
  });
  expect(summary.sampled_events).toBe(8);
  expect(JSON.stringify(usage.query())).not.toContain('must-not-persist');
  expect((await f.call(foreign, 'skill_usage_query', {})).events).toEqual([]);
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
  await f.close(claude);
  const restart = await f.connect('claude');
  expect((await f.call(restart, 'skill_get', { name: f.fixture.name })).version.id).toBe(
    v1.version.id,
  );
}, 60000);

it('E2E-04/05: changed V2 is blocked while V1 is active; explicit reviewed activation-gap workflow supports upgrade and rollback', async () => {
  const f = await fixture();
  const { experience, candidate: v1 } = await f.approved();
  passed(await f.sync(v1.identity.id));
  const v2 = await f.propose(experience.id, 2);
  const blocked = await f.evaluate(v2.version.id);
  expect(blocked.evaluation).toMatchObject({
    result: 'NOT_VERIFIED',
    baseline_version_id: v1.version.id,
    regression_result: 'NOT_VERIFIED',
  });
  expect((await f.operator('approve', v2.version.id)).status).toBe(1);
  expect((await f.operator('promote', v2.version.id)).status).toBe(1);
  expect(f.store.getIdentity(v1.identity.id).active_version_id).toBe(v1.version.id);
  const v1Review = f.store.getVersion(v1.version.id).state.review_id;
  expect(() =>
    new SkillOperatorService(f.db, f.scope).commit(
      { action: 'promote', version_id: v2.version.id, approval_id: v1Review },
      {},
    ),
  ).toThrow();
  // Existing documented operator policy, not a new evaluator waiver or proof of continuous-active upgrading.
  passed(await f.operator('deactivate', v1.version.id));
  copies(f, v1);
  expect((await f.operator('approve', v2.version.id)).status).toBe(1);
  expect((await f.evaluate(v2.version.id)).evaluation.result).toBe('PASS');
  passed(await f.operator('approve', v2.version.id));
  passed(await f.operator('promote', v2.version.id));
  expect(f.store.getVersion(v2.version.id).state.review_id).not.toBe(v1Review);
  const request = { skill_id: v1.identity.id, target: 'all', scope: 'project' };
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  expect(dist.plan(request).entries.map((e) => e.action)).toEqual(['UPDATE', 'UPDATE']);
  passed(await f.sync(v1.identity.id));
  copies(f, v2);
  passed(await f.operator('rollback', v1.version.id));
  expect(f.store.getIdentity(v1.identity.id).active_version_id).toBe(v1.version.id);
  copies(f, v2);
  expect(dist.plan(request).entries.map((e) => e.action)).toEqual(['UPDATE', 'UPDATE']);
  passed(await f.sync(v1.identity.id));
  copies(f, v1);
  expect(dist.plan(request).entries.map((e) => e.action)).toEqual(['SKIP', 'SKIP']);
  passed(await f.sync(v1.identity.id));
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM skill_operator_events WHERE action='rollback'").get(),
  ).toEqual({ n: 1 });
  expect(f.store.getVersion(v2.version.id).state.status).toBe('approved');
  const note = join(f.root, '.claude', 'skills', f.fixture.name, 'references', 'notes.md');
  writeFileSync(note, 'LOCAL EDIT');
  expect(dist.plan(request).entries[1]?.action).toBe('CONFLICT');
  expect((await f.sync(v1.identity.id)).status).toBe(1);
  expect(readFileSync(note, 'utf8')).toBe('LOCAL EDIT');
}, 60000);

it('E2E-04 standard activation-gap recovery restores V1 after a failed V2 decision without synchronizing the gap', async () => {
  const f = await fixture();
  const { experience, candidate: v1 } = await f.approved();
  passed(await f.sync(v1.identity.id));
  const v2 = await f.propose(experience.id, 2);
  expect((await f.evaluate(v2.version.id)).evaluation.result).toBe('NOT_VERIFIED');
  passed(await f.operator('deactivate', v1.version.id));
  copies(f, v1);
  expect((await f.evaluate(v2.version.id)).evaluation.result).toBe('PASS');
  f.db.exec(
    "CREATE TRIGGER e2e_decision_outage BEFORE INSERT ON skill_reviews BEGIN SELECT RAISE(ABORT,'isolated decision outage');END;",
  );
  expect((await f.operator('approve', v2.version.id)).status).toBe(1);
  expect(f.store.getVersion(v2.version.id).state.status).toBe('candidate');
  expect(f.store.getIdentity(v1.identity.id).active_version_id).toBeNull();
  copies(f, v1);
  f.db.exec('DROP TRIGGER e2e_decision_outage');
  passed(await f.operator('rollback', v1.version.id));
  expect(f.store.getIdentity(v1.identity.id).active_version_id).toBe(v1.version.id);
  expect(
    new SkillDistributionService(f.db, f.scope, f.home)
      .plan({ skill_id: v1.identity.id, target: 'all', scope: 'project' })
      .entries.map((e) => e.action),
  ).toEqual(['SKIP', 'SKIP']);
  expect((await f.operator('approve', v2.version.id)).status).toBe(1);
}, 60000);

it('E2E-06: agent MCP cannot cross scope or gain approval, distribution or telemetry authority', async () => {
  const f = await fixture();
  const exp = await f.capture();
  passed(await f.approveExperience(exp));
  const v = await f.propose(exp.id);
  const client = await f.connect('codex');
  const foreign = await f.connect('claude', true);
  for (const name of [
    'skill_approve',
    'skill_promote',
    'skill_rollback',
    'skill_sync',
    'skill_install',
    'skill_usage_confirm',
  ])
    expect((await client.callTool({ name, arguments: { version_id: v.version.id } })).isError).toBe(
      true,
    );
  expect(
    (await foreign.callTool({ name: 'skill_get', arguments: { version_id: v.version.id } }))
      .isError,
  ).toBe(true);
  for (const extra of [
    { project_id: f.scope.id },
    { approvedBy: 'human' },
    { verification: 'operator_confirmed' },
  ])
    expect(
      (
        await client.callTool({
          name: 'skill_usage_record',
          arguments: {
            schema_version: 1,
            event_id: f.event(),
            version_id: v.version.id,
            artifact_digest: v.version.content_hash,
            event_type: 'task_succeeded',
            ...extra,
          },
        })
      ).isError,
    ).toBe(true);
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  expect(
    dist
      .plan({ skill_id: v.identity.id, target: 'all', scope: 'project' })
      .entries.every((e) => e.action === 'SKIP'),
  ).toBe(true);
  expect(() =>
    dist.commit(
      { skill_id: v.identity.id, target: 'all', scope: 'project' },
      { session: 'forged' },
    ),
  ).toThrow('terminal confirmation');
  expect(
    (
      await client.callTool({
        name: 'skill_propose',
        arguments: {
          name: 'escape',
          description: 'Unsafe path fixture',
          source_experience_ids: [exp.id],
          files: [{ path: '../SKILL.md', content: 'escape' }],
        },
      })
    ).isError,
  ).toBe(true);
  expect(f.store.getVersion(v.version.id).state.status).toBe('candidate');
  expect(f.store.getIdentity(v.identity.id).active_version_id).toBeNull();
});

it('E2E-06: supporting-file changes, forged manifests, user collisions and static symlink escapes are preserved', async () => {
  const f = await fixture();
  const { candidate: v } = await f.approved();
  passed(await f.sync(v.identity.id));
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  const request = { skill_id: v.identity.id, target: 'all', scope: 'project' };
  const dest = join(f.root, '.claude', 'skills', f.fixture.name);
  const record = readFileSync(join(dest, '.agentmind-install.json'));
  writeFileSync(join(dest, 'references', 'notes.md'), 'modified support');
  expect(dist.plan(request).entries[1]?.action).toBe('CONFLICT');
  expect((await f.sync(v.identity.id)).status).toBe(1);
  expect(readFileSync(join(dest, 'references', 'notes.md'), 'utf8')).toBe('modified support');
  // Deliberate disposable test drift; no production registry/file owner is touched.
  rmSync(dest, { recursive: true });
  mkdirSync(dest);
  writeFileSync(join(dest, '.agentmind-install.json'), record);
  writeFileSync(join(dest, 'SKILL.md'), 'USER OWNED');
  expect(dist.plan(request).entries[1]?.action).toBe('CONFLICT');
  expect((await f.sync(v.identity.id)).status).toBe(1);
  rmSync(dest, { recursive: true });
  symlinkSync(f.home, dest);
  expect(dist.plan(request).entries[1]?.action).toBe('CONFLICT');
  expect((await f.sync(v.identity.id)).status).toBe(1);
  expect(existsSync(join(f.home, 'SKILL.md'))).toBe(false);
}, 60000);

it('E2E-08: metadata failure after publication and interrupted staging are recoverable without forged authorization', async () => {
  const f = await fixture();
  const { candidate: v } = await f.approved();
  const request = { skill_id: v.identity.id, target: 'codex', scope: 'project' };
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  f.db.exec(
    "CREATE TRIGGER e2e_metadata_fault BEFORE INSERT ON skill_installations BEGIN SELECT RAISE(ABORT,'isolated metadata fault');END;",
  );
  expect((await f.sync(v.identity.id, 'codex')).status).toBe(1);
  expect(dist.plan(request).entries[0]?.action).toBe('REPAIR');
  expect(f.store.getIdentity(v.identity.id).active_version_id).toBe(v.version.id);
  f.db.exec('DROP TRIGGER e2e_metadata_fault');
  passed(await f.sync(v.identity.id, 'codex'));
  expect(dist.plan(request).entries[0]?.action).toBe('SKIP');
  // A DB fault after staging but before publication simulates process interruption at a deterministic boundary.
  f.db.exec(
    "CREATE TRIGGER e2e_stage_fault BEFORE UPDATE OF stage_identity ON skill_distribution_intents BEGIN SELECT RAISE(ABORT,'isolated staging interruption');END;",
  );
  expect((await f.sync(v.identity.id, 'claude')).status).toBe(1);
  f.db.exec('DROP TRIGGER e2e_stage_fault');
  const repair = await f.sync(v.identity.id, 'claude');
  passed(repair);
  expect(repair.output).toContain('retained_work');
  passed(await f.sync(v.identity.id, 'claude'));
  copies(f, v);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 0 });
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
}, 60000);

it('E2E-08: locked or unavailable telemetry cannot corrupt registry state or fail exact skill retrieval', async () => {
  const f = await fixture();
  const { candidate: v } = await f.approved();
  const before = f.store.getVersion(v.version.id);
  const db = openUsageDatabase(f.path);
  const usage = new SkillUsageService(db, f.scope, 'codex');
  const event = {
    schema_version: 1,
    event_id: f.event(),
    version_id: v.version.id,
    artifact_digest: v.version.content_hash,
    event_type: 'task_unknown',
  };
  f.db.exec('BEGIN IMMEDIATE');
  try {
    expect(() => usage.record(event)).toThrow('not stored');
  } finally {
    f.db.exec('ROLLBACK');
  }
  expect(usage.record(event)).toMatchObject({ stored: true });
  db.close();
  f.db.exec(
    "CREATE TRIGGER e2e_telemetry_fault BEFORE INSERT ON skill_usage_events BEGIN SELECT RAISE(ABORT,'isolated telemetry outage');END;",
  );
  const client = await f.connect('claude');
  expect((await f.call(client, 'skill_get', { version_id: v.version.id })).version.id).toBe(
    v.version.id,
  );
  expect(f.store.getVersion(v.version.id)).toEqual(before);
  expect(new SkillUsageService(f.db, f.scope, 'claude').query().events).toHaveLength(1);
}, 60000);

it('E2E-08: concurrent confirmed promotions and sync requests have only one winner per displayed state', async () => {
  const f = await fixture();
  const exp = await f.capture();
  passed(await f.approveExperience(exp));
  const v = await f.propose(exp.id);
  await f.evaluate(v.version.id);
  passed(await f.operator('approve', v.version.id));
  const first = f.prompt('skill-operator', ['--promote', v.version.id]);
  const second = f.prompt('skill-operator', ['--promote', v.version.id]);
  expect((await first.ready).event).toBe('ready');
  expect((await second.ready).event).toBe('ready');
  first.respond();
  second.respond();
  const promotions = await Promise.all([first.exit, second.exit]);
  expect(promotions.filter((p) => p.status === 0)).toHaveLength(1);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 1 });
  const syncArgs = [
    '--skill-id',
    v.identity.id,
    '--target',
    'all',
    '--scope',
    'project',
    '--home-root',
    f.home,
    '--sync',
  ];
  const a = f.prompt('skill-distribute', syncArgs);
  const b = f.prompt('skill-distribute', syncArgs);
  expect((await a.ready).event).toBe('ready');
  expect((await b.ready).event).toBe('ready');
  a.respond();
  b.respond();
  const syncs = await Promise.all([a.exit, b.exit]);
  expect(syncs.filter((s) => s.status === 0)).toHaveLength(1);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_installations').get()).toEqual({ n: 2 });
  copies(f, v);
}, 60000);

it('E2E-08: unavailable target is a non-destructive conflict; approval digest tampering fails closed', async () => {
  const f = await fixture();
  const { candidate: v } = await f.approved();
  writeFileSync(join(f.root, '.claude'), 'unavailable directory fixture');
  const dist = new SkillDistributionService(f.db, f.scope, f.home);
  expect(
    dist.plan({ skill_id: v.identity.id, target: 'all', scope: 'project' }).entries[1]?.action,
  ).toBe('CONFLICT');
  expect((await f.sync(v.identity.id)).status).toBe(1);
  expect(existsSync(join(f.root, '.agents'))).toBe(false);
  // Corruption injection only, never an approval fixture or production write. Immutable guard removal is explicit.
  f.db.exec('DROP TRIGGER skill_versions_immutable_update');
  f.db
    .prepare('UPDATE skill_versions SET content_hash=? WHERE id=?')
    .run('0'.repeat(64), v.version.id);
  expect((await f.operator('promote', v.version.id)).status).toBe(1);
  expect(f.store.getIdentity(v.identity.id).active_version_id).toBe(v.version.id);
  expect(
    f.db.prepare('SELECT content_hash FROM skill_evaluations WHERE version_id=?').get(v.version.id),
  ).toEqual({ content_hash: v.version.content_hash });
}, 60000);

it('E2E-08: migration interruption rolls back DDL and preserves existing scoped memory', async () => {
  const f = await fixture();
  const client = await f.connect('codex');
  const saved = await f.call(client, 'memory_save', {
    title: 'Migration sentinel',
    content: 'Preserve this isolated project memory.',
  });
  await f.close(client);
  f.db.exec(
    'DROP TABLE IF EXISTS schema_migrations; DROP INDEX IF EXISTS memories_scope_recent; DROP INDEX IF EXISTS experiences_scope_recent; DROP TABLE skill_usage_cleanup;DROP TABLE skill_usage_events;DROP TABLE skill_usage_dedup;PRAGMA user_version=8',
  );
  // Existing table name collision is a safe migration failure, not an approval or policy bypass.
  f.db.exec('CREATE TABLE skill_usage_events (collision TEXT)');
  expect(() => migrate(f.db)).toThrow();
  expect(f.db.pragma('user_version', { simple: true })).toBe(8);
  expect(f.db.prepare('SELECT id FROM memories WHERE id=?').get(saved.memory.id)).toEqual({
    id: saved.memory.id,
  });
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='skill_usage_dedup'").get(),
  ).toBeUndefined();
  f.db.exec('DROP TABLE skill_usage_events');
  migrate(f.db);
  expect(f.db.pragma('user_version', { simple: true })).toBe(12);
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});

it.each(['permission', 'interrupted'])(
  'E2E-08: %s publication failure preserves registry history and permits authorized recovery',
  async (fault) => {
    const f = await fixture();
    const { experience, candidate: v1 } = await f.approved();
    passed(await f.sync(v1.identity.id));
    const v2 = await f.propose(experience.id, 2);
    passed(await f.operator('deactivate', v1.version.id));
    await f.evaluate(v2.version.id);
    passed(await f.operator('approve', v2.version.id));
    passed(await f.operator('promote', v2.version.id));
    const args = [
      '--home-root',
      f.home,
      '--skill-id',
      v1.identity.id,
      '--target',
      'codex',
      '--scope',
      'project',
      '--sync',
      '--e2e-fault',
      fault,
    ];
    const p = f.prompt(
      'skill-distribute',
      args,
      resolve('tests/fixtures/e2e-filesystem-fault.mjs'),
    );
    expect((await p.ready).event).toBe('ready');
    p.respond();
    const failed = await p.exit;
    expect(failed.status).not.toBe(0);
    if (fault === 'interrupted') expect(failed.status).toBe(-9);
    expect(f.store.getIdentity(v1.identity.id).active_version_id).toBe(v2.version.id);
    expect(f.store.getVersion(v1.version.id).state.status).toBe('approved');
    const dist = new SkillDistributionService(f.db, f.scope, f.home);
    const request = { skill_id: v1.identity.id, target: 'codex', scope: 'project' };
    expect(dist.plan(request).entries[0]?.action).toBe('REPAIR');
    passed(await f.sync(v1.identity.id, 'codex'));
    passed(await f.sync(v1.identity.id));
    copies(f, v2);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  },
  60000,
);

it('E2E-08: interrupted MCP session retries remain idempotent, and missing artifacts cannot replace valid state', async () => {
  const f = await fixture();
  const { candidate: v } = await f.approved();
  const client = await f.connect('codex');
  const event = {
    schema_version: 1,
    event_id: f.event(),
    version_id: v.version.id,
    artifact_digest: v.version.content_hash,
    event_type: 'task_unknown',
  };
  const pending = client
    .callTool({ name: 'skill_usage_record', arguments: event })
    .catch(() => undefined);
  await f.close(client);
  await pending;
  const restarted = await f.connect('codex');
  await f.call(restarted, 'skill_usage_record', event);
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM skill_usage_events WHERE event_id=?')
      .get(event.event_id),
  ).toEqual({ n: 1 });
  expect(
    (await restarted.callTool({ name: 'skill_get', arguments: { version_id: f.event() } })).isError,
  ).toBe(true);
  expect((await f.operator('promote', f.event())).status).toBe(1);
  expect(f.store.getIdentity(v.identity.id).active_version_id).toBe(v.version.id);
  expect(f.store.getVersion(v.version.id).state.status).toBe('approved');
}, 60000);
