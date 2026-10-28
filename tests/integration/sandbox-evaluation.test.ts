import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const f of clean.splice(0)) f();
});
const entry = resolve('packages/mcp-server/dist/agentmind.js');
function fixture() {
  const f = distributionFixture();
  clean.push(f.close);
  const c = f.propose('Refusal CLI fixture.');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [entry, 'evaluation', ...args], {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 5000,
    });
  const scope = ['--project-root', f.root, '--db', f.path, '--json'];
  const pins = ['--digest', c.version.content_hash, '--revision', String(c.state.revision)];
  return { ...f, c, run, scope, pins };
}
it('status and doctor are no-model, no-registry capability inspections', () => {
  const f = fixture();
  for (const action of ['status', 'doctor']) {
    const r = f.run([action, '--json']);
    expect(r.status, r.stderr).toBe(2);
    const d = JSON.parse(r.stdout);
    expect(d.execution_supported).toBe(false);
    expect(d.capability.status).toBe('UNAVAILABLE');
    expect(d.model_invocations).toBe(0);
  }
});
it('plans read-only and records a bound refusal only on explicit run', () => {
  const f = fixture();
  const p = f.run(['plan', f.c.version.id, ...f.pins, ...f.scope]);
  expect(p.status, p.stderr).toBe(2);
  const plan = JSON.parse(p.stdout);
  expect(plan.plan.candidate_digest).toBe(f.c.version.content_hash);
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='behavioral_schema'").get(),
  ).toBeUndefined();
  const r = f.run([
    'run',
    f.c.version.id,
    ...f.pins,
    ...f.scope,
    '--plan-digest',
    plan.plan_digest,
  ]);
  expect(r.status, r.stderr).toBe(2);
  const record = JSON.parse(r.stdout);
  expect(record.evaluation.result).toBe('NOT_VERIFIED');
  const read = f.run(['evidence', record.evaluation.id, ...f.scope]);
  expect(read.status, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(record);
  expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
    f.candidate.version.id,
  );
});
it('requires a plan pin and rejects stale plans, host commands and forged result flags', () => {
  const f = fixture();
  for (const flags of [
    [],
    ['--plan-digest', 'a'.repeat(64)],
    ['--command', 'echo PASS'],
    ['--result', 'PASS'],
  ]) {
    const r = f.run(['run', f.c.version.id, ...f.pins, ...f.scope, ...flags]);
    expect(r.status).toBe(flags[0] === '--plan-digest' ? 3 : 4);
  }
  expect(
    f.db
      .prepare('SELECT count(*) AS n FROM skill_evaluations WHERE version_id=?')
      .get(f.c.version.id),
  ).toEqual({ n: 0 });
});
it('denies cross-project plans through real process scope checks', () => {
  const f = fixture();
  const r = f.run([
    'plan',
    f.c.version.id,
    ...f.pins,
    '--project-root',
    f.otherScope.root,
    '--db',
    f.path,
    '--json',
  ]);
  expect(r.status).toBe(3);
  expect(JSON.parse(r.stdout).error.code).toMatch(/PROJECT|SCOPE/);
});
it('supports safe help without a registry and never exposes candidate content on planning', () => {
  const f = fixture();
  const help = f.run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('no accepted execution backend');
  const p = f.run(['plan', f.c.version.id, ...f.pins, ...f.scope]);
  expect(p.stdout).not.toContain('Refusal CLI fixture');
  expect(p.stdout).not.toContain('\u001b');
});
