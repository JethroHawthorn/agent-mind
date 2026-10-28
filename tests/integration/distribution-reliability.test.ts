import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectPackage } from '../../packages/core/src/skill-distribution-files.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { operatorTTY } from '../helpers/operator-pty.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const f of clean.splice(0)) f();
});
function fixture() {
  const f = distributionFixture();
  clean.push(f.close);
  return {
    ...f,
    destination: join(f.root, '.agents', 'skills', f.candidate.identity.name),
    args: [
      '--project-root',
      f.root,
      '--db',
      f.path,
      '--home-root',
      f.home,
      '--skill-id',
      f.candidate.identity.id,
      '--target',
      'codex',
      '--scope',
      'project',
    ],
  };
}
async function sync(f: ReturnType<typeof fixture>) {
  const p = operatorTTY(
    f.root,
    [...f.args, '--sync'],
    resolve('packages/mcp-server/dist/skill-distribute.js'),
  );
  expect((await p.ready).event).toBe('ready');
  p.respond();
  expect((await p.exit).status).toBe(0);
}
for (const point of ['after-publish', 'after-backup', 'before-final-status'])
  it(`survives actual SIGKILL ${point}, then reconciles with a new fixture confirmation`, async () => {
    const f = fixture();
    if (point === 'after-backup') {
      await sync(f);
      f.transition(f.candidate.identity.id, null, 'deactivate');
      const v = f.propose('Crash replacement.');
      f.evaluate(v.version.id);
      f.approve(v.version.id);
      f.promote(v.version.id);
    }
    const child = operatorTTY(
      f.root,
      [f.root, f.path, f.home, f.candidate.identity.id, point],
      resolve('tests/helpers/distribution-crash-worker.mjs'),
    );
    expect((await child.ready).event).toBe('ready');
    child.respond();
    expect((await child.exit).status).toBe(-9);
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
        .get(),
    ).toEqual({ n: 1 });
    await sync(f);
    await sync(f);
    const current = f.store.getIdentity(f.candidate.identity.id);
    const v = f.store.getVersion(current.active_version_id ?? '');
    expect(inspectPackage(f.destination)).toMatchObject({
      status: 'present',
      content_digest: v.version.content_hash,
    });
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  }, 20000);
it('unified distribution inspections never migrate, copy, audit or authorize lifecycle actions', () => {
  const f = fixture(),
    entry = resolve('packages/mcp-server/dist/agentmind.js');
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get();
  for (const action of ['status', 'plan', 'verify', 'history', 'recover', 'rollback']) {
    const r = spawnSync(
      process.execPath,
      [
        entry,
        'distribution',
        action,
        f.candidate.identity.id,
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--home-root',
        f.home,
        '--json',
        ...(['recover', 'rollback'].includes(action) ? ['--dry-run'] : []),
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 5000 },
    );
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(r.stdout).not.toContain('Harmless local fixture');
  }
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get()).toEqual(before);
  expect(existsSync(f.destination)).toBe(false);
  for (const args of [['recover'], ['rollback'], ['plan', '--apply']]) {
    const r = spawnSync(
      process.execPath,
      [entry, 'distribution', ...args, f.candidate.identity.id, '--json'],
      { cwd: f.root, encoding: 'utf8', timeout: 5000 },
    );
    expect(r.status).toBe(4);
  }
});

it('F06 uses INVALID_INPUT/exit4 for malformed history UUID and numeric strings', () => {
  const f = fixture(),
    entry = resolve('packages/mcp-server/dist/agentmind.js');
  for (const extra of [
    ['--limit', '999'],
    ['--limit', ''],
    ['--offset', '   '],
    ['--offset', '1e2'],
    ['--offset', '-1'],
  ]) {
    const r = spawnSync(
      process.execPath,
      [
        entry,
        'distribution',
        'history',
        f.candidate.identity.id,
        ...f.args.slice(0, 6),
        '--json',
        ...extra,
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 5000 },
    );
    expect(r.status, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).error.code).toBe('INVALID_INPUT');
  }
  const r = spawnSync(
    process.execPath,
    [entry, 'distribution', 'history', 'not-a-uuid', ...f.args.slice(0, 6), '--json'],
    { cwd: f.root, encoding: 'utf8', timeout: 5000 },
  );
  expect(r.status).toBe(4);
});
