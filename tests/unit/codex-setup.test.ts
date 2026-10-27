import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadEnrollment } from '../../packages/mcp-server/src/codex/adapter.js';
import {
  codexCapabilities,
  configBlock,
  configuredEntry,
} from '../../packages/mcp-server/src/codex/configuration.js';
import { readBounded, replaceFile } from '../../packages/mcp-server/src/codex/files.js';
import { projectScope } from '../../packages/mcp-server/src/codex/project.js';
import { CodexSetup } from '../../packages/mcp-server/src/codex/setup.js';
import { codexFixture } from '../helpers/codex-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const fn of clean.splice(0).reverse()) fn();
});
function fixture() {
  const f = codexFixture();
  clean.push(f.cleanup);
  return f;
}
function seedConfig(f: ReturnType<typeof fixture>, text: string) {
  mkdirSync(dirname(f.config), { recursive: true });
  writeFileSync(f.config, text);
}
it('dry-run validates exact stdio with installed Codex parser without target writes or database initialization', () => {
  const f = fixture(),
    plan = f.setup.plan();
  expect(plan.action).toBe('INSTALL');
  expect(existsSync(f.config)).toBe(false);
  expect(existsSync(f.state)).toBe(false);
  expect(existsSync(f.options.database)).toBe(false);
  const parsed = configuredEntry(
    f.setup.codex,
    plan.record.changes[0]?.after ?? '',
    f.setup.serverName,
  );
  expect(parsed.transport.command).toBe(process.execPath);
  expect(parsed.transport.cwd).toBeNull();
  expect(parsed.transport.args).toEqual([f.options.adapter, '--enrollment', f.enrollment]);
  expect(plan.record.changes.map((c) => c.path)).not.toContain('AGENTS.md');
});
it('preserves unrelated TOML/comments byte-for-byte across idempotent setup and uninstall, retains enrollment backup and database', () => {
  const f = fixture(),
    before =
      '# user-owned settings\nmodel = "fixture-only"\n[mcp_servers.unrelated]\ncommand = "node"\nargs = ["user-owned"]\n';
  seedConfig(f, before);
  writeFileSync(join(f.root, 'AGENTS.md'), 'USER INSTRUCTIONS');
  expect(f.setup.setup().action).toBe('INSTALL');
  expect(f.setup.setup().action).toBe('SKIP');
  expect(f.setup.status().installed).toBe(true);
  const record = f.setup.state();
  if (!record) throw Error('Missing installation fixture');
  expect(readFileSync(f.config, 'utf8')).toBe(before + configBlock(record));
  expect(statSync(f.state).mode & 0o777).toBe(0o600);
  writeFileSync(f.options.database, 'disposable sentinel');
  expect(f.setup.uninstall().action).toBe('REMOVE');
  expect(existsSync(f.routerFile)).toBe(true);
  expect(f.setup.uninstall(true).action).toBe('REMOVED');
  expect(readFileSync(f.config, 'utf8')).toBe(before);
  expect(readFileSync(join(f.root, 'AGENTS.md'), 'utf8')).toBe('USER INSTRUCTIONS');
  expect(existsSync(f.options.database)).toBe(true);
  expect(f.setup.uninstall(true).action).toBe('SKIP');
  expect(
    existsSync(join(f.root, '.agentmind/codex/backups', `${record?.installation_id}.json`)),
  ).toBe(true);
});
it('retains unrelated configuration edits made after setup and removes only the managed block', () => {
  const f = fixture();
  f.setup.setup();
  const current = readFileSync(f.config, 'utf8');
  writeFileSync(f.config, `${current}\n[mcp_servers.new_user_server]\ncommand="node"\n`);
  expect(f.setup.setup().action).toBe('SKIP');
  f.setup.uninstall(true);
  expect(readFileSync(f.config, 'utf8')).toBe('\n[mcp_servers.new_user_server]\ncommand="node"\n');
});
it.each(['router', 'config', 'enrollment'])(
  'does not overwrite locally modified managed %s',
  (which) => {
    const f = fixture();
    f.setup.setup();
    const path = which === 'router' ? f.routerFile : which === 'config' ? f.config : f.enrollment;
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, current.replace('agentmind', 'user-modified'));
    expect(() => f.setup.setup()).toThrow();
    expect(() => f.setup.uninstall(true)).toThrow();
    expect(readFileSync(path, 'utf8')).toContain('user-modified');
  },
);
it('refuses user-owned router collisions, malformed TOML and unmanaged server-name collisions', () => {
  const f = fixture();
  mkdirSync(dirname(f.routerFile), { recursive: true });
  writeFileSync(f.routerFile, f.options.router);
  expect(() => f.setup.plan()).toThrow(/owned/);
  unlinkSync(f.routerFile);
  seedConfig(f, 'invalid = [');
  expect(() => f.setup.plan()).toThrow(/rejected/);
  writeFileSync(f.config, `[mcp_servers.${f.setup.serverName}]\ncommand="user-owned"\n`);
  expect(() => f.setup.plan()).toThrow(/already exists/);
});
it('refuses static symlink/hardlink paths and never truncates the linked target', () => {
  const f = fixture(),
    sentinel = join(f.root, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  mkdirSync(dirname(f.config), { recursive: true });
  symlinkSync(sentinel, f.config);
  expect(() => f.setup.plan()).toThrow();
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
  unlinkSync(f.config);
  linkSync(sentinel, f.config);
  expect(() => f.setup.plan()).toThrow();
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
});
it('recovers interrupted setup from the durable pre-change journal without re-authoring configuration', () => {
  const f = fixture(),
    r = f.setup.plan().record;
  mkdirSync(dirname(f.state), { recursive: true, mode: 0o700 });
  writeFileSync(f.state, JSON.stringify(r), { mode: 0o600 });
  const c = r.changes[0];
  if (!c) throw Error('Missing config fixture');
  replaceFile(f.root, f.config, c.before, c.after);
  expect(f.setup.plan().action).toBe('RECOVER');
  expect(f.setup.setup().action).toBe('RECOVER');
  expect(f.setup.status().installed).toBe(true);
});
it('repairs only missing managed files through explicit setup and rejects concurrent file changes', () => {
  const f = fixture();
  f.setup.setup();
  unlinkSync(f.routerFile);
  expect(f.setup.status().installed).toBe(false);
  expect(f.setup.plan().action).toBe('REPAIR');
  f.setup.setup();
  expect(f.setup.status().installed).toBe(true);
  expect(() => replaceFile(f.root, f.config, 'stale', 'replacement')).toThrow(/changed/);
});
it('locks concurrent setup fail-closed, retaining existing state until explicit lock recovery', () => {
  const f = fixture();
  mkdirSync(dirname(f.state), { recursive: true, mode: 0o700 });
  const lock = join(f.root, '.agentmind/codex/setup.lock');
  writeFileSync(lock, 'test live lock');
  expect(() => f.setup.setup()).toThrow(/lock/);
  expect(readFileSync(lock, 'utf8')).toBe('test live lock');
  unlinkSync(lock);
  expect(f.setup.setup().action).toBe('INSTALL');
});
it('forged receipt alone cannot authorize replacing unrelated config or removal paths', () => {
  const f = fixture(),
    r = f.setup.plan().record;
  mkdirSync(dirname(f.state), { recursive: true, mode: 0o700 });
  r.phase = 'installed';
  writeFileSync(f.state, JSON.stringify(r), { mode: 0o600 });
  seedConfig(f, '# unrelated content\n');
  expect(() => f.setup.uninstall(true)).toThrow(/ownership/);
  const first = r.changes[0];
  if (!first) throw Error('Missing config fixture');
  first.path = '../escape';
  writeFileSync(f.state, JSON.stringify(r), { mode: 0o600 });
  expect(() => f.setup.status()).toThrow();
});
it('resolves canonical symlink aliases, separates nested repositories and denies project relocation', () => {
  const f = fixture();
  f.setup.setup();
  const nested = join(f.root, 'nested');
  mkdirSync(nested);
  spawnSync('git', ['init', '-q', nested]);
  expect(() => loadEnrollment(f.enrollment, nested)).toThrow(/differs/);
  expect(() => loadEnrollment(f.enrollment, dirname(f.root))).toThrow();
  const sub = join(f.root, 'sub');
  mkdirSync(sub);
  expect(loadEnrollment(f.enrollment, sub).project_id).toBe(f.setup.status().project_id);
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias);
  expect(projectScope(alias).id).toBe(f.setup.status().project_id);
  const record = JSON.parse(readFileSync(f.enrollment, 'utf8'));
  record.project_root = join(f.root, 'moved');
  writeFileSync(f.enrollment, JSON.stringify(record));
  expect(() => loadEnrollment(f.enrollment, f.root)).toThrow();
});
it('diagnoses missing executable/build and rejects relative enrollment paths', () => {
  const f = fixture();
  expect(() => new CodexSetup({ ...f.options, codex: '/missing-codex' })).toThrow(/not found/);
  expect(() => new CodexSetup({ ...f.options, adapter: '/missing-adapter' }).plan()).toThrow();
  expect(() => loadEnrollment('relative', f.root)).toThrow();
  expect(codexCapabilities().stdio).toBe(true);
});
it('does not silently relabel same-UID supervised deployment as protected', () => {
  const f = fixture();
  f.setup.setup();
  expect(f.setup.status()).toMatchObject({
    mode: 'supervised-local',
    protected_deployment: 'NOT VERIFIED',
    autonomous_activation: 'NO-GO',
  });
  expect(readBounded(f.root, f.enrollment)).not.toContain('token');
});
it('handles canonical project paths containing spaces and quotes without shell interpolation', () => {
  const f = codexFixture(" project's space");
  clean.push(f.cleanup);
  expect(f.setup.setup().action).toBe('INSTALL');
  expect(loadEnrollment(f.enrollment, f.root).project_root).toBe(f.root);
  f.setup.uninstall(true);
});
it('recovers an interrupted uninstall using only derived managed removal operations', () => {
  const f = fixture();
  f.setup.setup();
  const r = f.setup.state();
  if (!r) throw Error('missing fixture');
  const cfg = readFileSync(f.config, 'utf8'),
    after = cfg.replace(configBlock(r), '');
  r.phase = 'removing';
  r.removal = [
    { path: '.codex/config.toml', before: cfg, after: after === '' ? null : after },
    ...r.changes.slice(1).map((c) => ({ path: c.path, before: c.after, after: null })),
  ];
  writeFileSync(f.state, JSON.stringify(r), { mode: 0o600 });
  replaceFile(f.root, f.config, cfg, after === '' ? null : after);
  expect(f.setup.uninstall(true).action).toBe('REMOVED');
  expect(existsSync(f.routerFile)).toBe(false);
  expect(f.setup.uninstall(true).action).toBe('SKIP');
});
it('separates Git worktrees even when they share Git object storage', () => {
  const f = fixture();
  f.setup.setup();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: f.root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const commit = spawnSync(
    'git',
    [
      '-C',
      f.root,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    { env },
  );
  expect(commit.status).toBe(0);
  const worktree = join(f.root, 'worktree');
  expect(
    spawnSync(
      'git',
      [
        '-C',
        f.root,
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        '--detach',
        worktree,
        'HEAD',
      ],
      { env },
    ).status,
  ).toBe(0);
  expect(projectScope(worktree).id).not.toBe(f.setup.status().project_id);
  expect(() => loadEnrollment(f.enrollment, worktree)).toThrow(/differs/);
});

it('fails closed on public private-state permissions without silently changing them', () => {
  const f = fixture();
  mkdirSync(dirname(f.state), { recursive: true, mode: 0o755 });
  expect(() => f.setup.setup()).toThrow(/private/);
  expect(existsSync(f.config)).toBe(false);
  chmodSync(dirname(f.state), 0o700);
  f.setup.setup();
  chmodSync(f.state, 0o644);
  expect(() => f.setup.status()).toThrow(/private/);
});

it('rejects forged project identities and protected-mode labels in enrollment', () => {
  const f = fixture();
  f.setup.setup();
  const record = JSON.parse(readFileSync(f.enrollment, 'utf8'));
  for (const patch of [{ project_id: 'f'.repeat(64) }, { mode: 'protected' }, { approved: true }]) {
    writeFileSync(f.enrollment, JSON.stringify({ ...record, ...patch }));
    expect(() => loadEnrollment(f.enrollment, f.root)).toThrow();
  }
});

it('refuses an oversized final configuration before publishing any managed files', () => {
  const f = fixture();
  const before = `#${'x'.repeat(130500)}\n`;
  seedConfig(f, before);
  expect(() => f.setup.plan()).toThrow(/128 KiB/);
  expect(readFileSync(f.config, 'utf8')).toBe(before);
  expect(existsSync(f.state)).toBe(false);
  expect(existsSync(f.routerFile)).toBe(false);
});
