import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SkillDistributionService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { operatorTTY } from '../helpers/operator-pty.js';

const entry = resolve('packages/mcp-server/dist/skill-distribute.js');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = distributionFixture();
  cleanup.push(f.close);
  const args = [
    '--project-root',
    f.root,
    '--db',
    f.path,
    '--home-root',
    f.home,
    '--skill-id',
    f.candidate.identity.id,
    '--target',
    'all',
    '--scope',
    'project',
  ];
  return { ...f, args };
}
async function confirmed(f: ReturnType<typeof fixture>, extra: string[] = []) {
  const p = operatorTTY(f.root, [...f.args, ...extra, '--sync'], entry);
  const prompt = await p.ready;
  if (prompt.event === 'ready') p.respond();
  return p.exit;
}
it('requires actual operator confirmation and does not accept forged grants, flags or MCP-triggered distribution', async () => {
  const f = fixture();
  expect(() =>
    new SkillDistributionService(f.db, f.scope, f.home).commit(f.request, { session: 'forged' }),
  ).toThrow('terminal confirmation');
  const pipe = spawnSync(process.execPath, [entry, ...f.args, '--sync'], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(pipe.status).toBe(1);
  expect(pipe.stderr).toContain('INTERACTIVE_OPERATOR_REQUIRED');
  for (const flag of ['--yes', '--force'])
    expect(
      spawnSync(process.execPath, [entry, ...f.args, '--sync', flag], {
        cwd: f.root,
        encoding: 'utf8',
        timeout: 5000,
      }).status,
    ).toBe(1);
  for (const name of ['skill_sync', 'skill_distribute', 'skill_install', 'skill_remove']) {
    const denied = spawnSync(
      process.execPath,
      [
        resolve('scripts/mcp-call.mjs'),
        f.root,
        f.path,
        'codex',
        name,
        JSON.stringify({ skill_id: f.candidate.identity.id }),
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 10000 },
    );
    expect(denied.status).toBe(1);
  }
  expect(existsSync(join(f.root, '.agents'))).toBe(false);
});
it('runs dry-run/status without publication, installs through a real terminal, then verifies and removes', async () => {
  const f = fixture();
  for (const args of [['--plan'], ['--status'], ['--sync', '--dry-run']]) {
    const result = spawnSync(process.execPath, [entry, ...f.args, ...args], {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).entries.map((e: { action: string }) => e.action)).toEqual([
      'INSTALL',
      'INSTALL',
    ]);
  }
  expect(existsSync(join(f.root, '.agents'))).toBe(false);
  const result = await confirmed(f);
  expect(result.status, result.output.slice(-1500)).toBe(0);
  const verify = spawnSync(process.execPath, [entry, ...f.args, '--verify'], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(verify.status, verify.stderr).toBe(0);
  expect(
    JSON.parse(verify.stdout).entries.every((e: { action: string }) => e.action === 'SKIP'),
  ).toBe(true);
  for (const directory of ['.agents', '.claude'])
    expect(
      readFileSync(
        join(f.root, directory, 'skills', f.candidate.identity.name, 'SKILL.md'),
        'utf8',
      ),
    ).toBe(f.candidate.version.files[0]?.content);
  const removal = operatorTTY(f.root, [...f.args, '--remove'], entry);
  expect((await removal.ready).event).toBe('ready');
  removal.respond();
  expect((await removal.exit).status).toBe(0);
  expect(existsSync(join(f.root, '.agents', 'skills', f.candidate.identity.name))).toBe(false);
});
it('serializes two independently confirmed sync attempts for the same destination', async () => {
  const f = fixture();
  const args = [...f.args, '--target', 'codex', '--sync'];
  const first = operatorTTY(f.root, args, entry);
  const second = operatorTTY(f.root, args, entry);
  expect((await first.ready).event).toBe('ready');
  expect((await second.ready).event).toBe('ready');
  first.respond();
  second.respond();
  const replies = await Promise.all([first.exit, second.exit]);
  expect(replies.filter((r) => r.status === 0)).toHaveLength(1);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_installations').get()).toEqual({ n: 1 });
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 0 });
});
it('rejects a registry change between displayed plan and confirmation', async () => {
  const f = fixture();
  const p = operatorTTY(f.root, [...f.args, '--sync'], entry);
  expect((await p.ready).event).toBe('ready');
  f.transition(f.candidate.identity.id, null, 'deactivate');
  p.respond();
  const denied = await p.exit;
  expect(denied.status).toBe(1);
  expect(denied.output).toContain('STALE_OPERATOR_REVIEW');
  expect(existsSync(join(f.root, '.agents'))).toBe(false);
});
