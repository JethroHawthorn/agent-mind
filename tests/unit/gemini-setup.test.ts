import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadGeminiEnrollment } from '../../packages/mcp-server/src/gemini/adapter.js';
import { geminiCapabilities } from '../../packages/mcp-server/src/gemini/configuration.js';
import { connectGemini } from '../../packages/mcp-server/src/gemini/doctor.js';
import { GeminiSetup } from '../../packages/mcp-server/src/gemini/setup.js';
import { codexFixture } from '../helpers/codex-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture(scope: 'project' | 'user' = 'project') {
  const f = codexFixture(' Gemini spaces');
  cleanup.push(f.cleanup);
  const home = join(f.root, 'fake-home');
  const options = {
    ...f.options,
    adapter: resolve('packages/mcp-server/dist/gemini/adapter.js'),
    home,
    scope,
    systemDefaults: join(home, 'system-defaults.json'),
    systemSettings: join(home, 'system-settings.json'),
    gemini: '/nonexistent-gemini-cli-fixture',
  };
  return { ...f, home, options, gemini: new GeminiSetup(options) };
}
function write(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
it('offline preview is accurate, bounded and creates no config, registry or instructions', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'GEMINI.md'), 'User instructions');
  const p = f.gemini.plan();
  expect(p.action).toBe('INSTALL');
  expect(p.capabilities.installed).toBe(false);
  expect(p.receipt.entry.trust).toBe(false);
  expect(p.receipt.entry.includeTools).toHaveLength(19);
  expect(existsSync(f.gemini.config)).toBe(false);
  expect(existsSync(f.gemini.statePath)).toBe(false);
  expect(existsSync(f.options.database)).toBe(false);
  expect(readFileSync(join(f.root, 'GEMINI.md'), 'utf8')).toBe('User instructions');
});
it.each(['project', 'user'] as const)(
  '%s setup preserves other servers, hooks, auth metadata, and later edits; idempotent safe removal',
  (scope) => {
    const f = fixture(scope),
      original = {
        mcpServers: { other: { command: 'other' } },
        security: { auth: { selectedType: 'DUMMY_EXISTING_AUTH' } },
        hooks: { AfterTool: [{ matcher: 'test', hooks: [] }] },
      };
    write(f.gemini.config, original);
    expect(f.gemini.setup().installed).toBe(true);
    const bytes = readFileSync(f.gemini.config, 'utf8');
    expect(f.gemini.setup().installed).toBe(true);
    expect(readFileSync(f.gemini.config, 'utf8')).toBe(bytes);
    expect(f.gemini.plan().action).toBe('SKIP');
    const d = JSON.parse(bytes);
    d.mcpServers.later = { command: 'later' };
    write(f.gemini.config, d);
    expect(f.gemini.uninstall(false)).toMatchObject({ dry_run: true });
    f.gemini.uninstall(true);
    const after = JSON.parse(readFileSync(f.gemini.config, 'utf8'));
    expect(after.security).toEqual(original.security);
    expect(after.hooks).toEqual(original.hooks);
    expect(after.mcpServers.other).toEqual(original.mcpServers.other);
    expect(after.mcpServers.later).toBeDefined();
    expect(after.mcpServers.agentmind).toBeUndefined();
    expect(f.gemini.uninstall(true).action).toBe('SKIP');
  },
);
it('reuses Codex .agents router read-only without adding a lower-priority Gemini copy', () => {
  const f = fixture();
  f.setup.setup();
  const before = readFileSync(f.routerFile, 'utf8');
  expect(f.gemini.plan().receipt.router.owned).toBe(false);
  expect(f.gemini.setup().router?.ownership).toBe('REUSED_READ_ONLY');
  expect(existsSync(join(f.root, '.gemini/skills/agentmind-router/SKILL.md'))).toBe(false);
  f.gemini.uninstall(true);
  expect(readFileSync(f.routerFile, 'utf8')).toBe(before);
  expect(f.setup.status().installed).toBe(true);
});
it('reuses an exact user alias router without duplicate installation, but rejects incompatible precedence tiers', () => {
  const f = fixture();
  const path = join(f.home, '.agents/skills/agentmind-router/SKILL.md');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, f.options.router);
  expect(f.gemini.setup().router?.ownership).toBe('REUSED_READ_ONLY');
  f.gemini.uninstall(true);
  expect(existsSync(path)).toBe(true);
  const g = fixture();
  write(join(g.root, '.agents/skills/agentmind-router/SKILL.md'), 'user router');
  expect(() => g.gemini.plan()).toThrow('existing router differs');
});
it.each(['router', 'enrollment', 'entry'])('preserves user edits to managed %s', (kind) => {
  const f = fixture();
  f.gemini.setup();
  const r = f.gemini.state();
  if (!r) throw Error('receipt');
  if (kind === 'router') writeFileSync(r.router.path, 'user change');
  if (kind === 'enrollment') writeFileSync(f.gemini.enrollment, '{}');
  if (kind === 'entry') {
    const d = JSON.parse(readFileSync(f.gemini.config, 'utf8'));
    d.mcpServers.agentmind.trust = true;
    write(f.gemini.config, d);
  }
  expect(() => f.gemini.setup()).toThrow();
  expect(() => f.gemini.uninstall(true)).toThrow();
});
it.each([
  'allowed',
  'excluded',
  'admin',
  'skills',
  'higher-collision',
  'lower-collision',
  'legacy',
  'invalid',
])('never rewrites restricting or conflicting policy: %s', (kind) => {
  const f = fixture();
  const d =
    kind === 'allowed'
      ? { mcp: { allowed: ['other'] } }
      : kind === 'excluded'
        ? { mcp: { excluded: ['agentmind'] } }
        : kind === 'admin'
          ? { admin: { mcp: { enabled: false } } }
          : kind === 'skills'
            ? { skills: { enabled: false } }
            : kind === 'legacy'
              ? { mcpServers: { agentmind_legacy: { command: 'old' } } }
              : kind === 'invalid'
                ? { mcp: { allowed: 'agentmind' } }
                : { mcpServers: { agentmind: { command: 'existing' } } };
  const path =
    kind === 'lower-collision' ? join(f.home, '.gemini/settings.json') : f.options.systemSettings;
  write(path, d);
  const before = readFileSync(path, 'utf8');
  expect(() => f.gemini.setup()).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(existsSync(f.gemini.enrollment)).toBe(false);
});
it('fails closed for malformed/duplicate settings, path interpolation, symlinks and forged project IDs', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.gemini'));
  writeFileSync(f.gemini.config, '{"mcpServers":{},"mcpServers":{}}');
  expect(() => f.gemini.plan()).toThrow();
  const g = fixture();
  symlinkSync(g.home, join(g.root, '.gemini'));
  expect(() => g.gemini.plan()).toThrow();
  const h = fixture();
  h.gemini.setup();
  const e = JSON.parse(readFileSync(h.gemini.enrollment, 'utf8'));
  e.project_id = 'a'.repeat(64);
  writeFileSync(h.gemini.enrollment, JSON.stringify(e));
  expect(() => loadGeminiEnrollment(h.gemini.enrollment, h.root)).toThrow();
  expect(() => new GeminiSetup({ ...h.options, database: join(h.root, '$OTHER.db') })).toThrow(
    'expansion',
  );
});
it('repairs missing owned files and resumes journal interruption without taking ownership of external files', () => {
  const f = fixture();
  f.gemini.setup();
  unlinkSync(f.gemini.enrollment);
  expect(f.gemini.plan().action).toBe('REPAIR');
  expect(f.gemini.setup().installed).toBe(true);
  const r = f.gemini.state();
  if (!r) throw Error('receipt');
  r.phase = 'installing';
  write(f.gemini.statePath, r);
  expect(f.gemini.plan().action).toBe('RECOVER');
  expect(f.gemini.setup().installed).toBe(true);
  r.phase = 'removing';
  write(f.gemini.statePath, r);
  expect(() => f.gemini.setup()).toThrow('Finish uninstall');
  f.gemini.uninstall(true);
  expect(f.gemini.state()?.phase).toBe('removed');
});
it('honors setup locks and rejects policy-blocked SDK diagnostics before database initialization', async () => {
  const f = fixture();
  mkdirSync(join(f.root, '.agentmind/gemini'), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, '.agentmind/gemini/setup.lock'), 'held');
  expect(() => f.gemini.setup()).toThrow('locked');
  const g = fixture();
  g.gemini.setup();
  write(g.options.systemSettings, { mcp: { excluded: ['agentmind'] } });
  await expect(connectGemini(g.gemini)).rejects.toThrow();
  expect(existsSync(g.options.database)).toBe(false);
});
it('CLI preview does not expose unrelated settings; help and missing executable are honest', () => {
  const f = fixture();
  write(f.gemini.config, {
    mcpServers: { other: { command: 'other', env: { DUMMY: 'PRIVATE_FIXTURE_SENTINEL' } } },
  });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve('packages/mcp-server/dist/gemini.js'), ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        GEMINI_CLI_HOME: f.home,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: f.options.systemSettings,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: f.options.systemDefaults,
      },
    });
  const p = run([
    'setup',
    '--project-root',
    f.root,
    '--db',
    f.options.database,
    '--dry-run',
    '--json',
  ]);
  expect(p.status).toBe(0);
  expect(p.stdout).not.toContain('PRIVATE_FIXTURE_SENTINEL');
  expect(JSON.parse(p.stdout).server_name).toBe('agentmind');
  expect(existsSync(f.gemini.statePath)).toBe(false);
  f.gemini.setup();
  const noop = JSON.parse(
    run(['setup', '--project-root', f.root, '--db', f.options.database, '--dry-run', '--json'])
      .stdout,
  );
  expect(noop.action).toBe('SKIP');
  expect(noop.changes).toEqual([]);
  expect(noop.apply_required).toBe(false);
  expect(run(['--help']).status).toBe(0);
  expect(run(['-h']).stdout).toContain('Offline');
  expect(geminiCapabilities('/absent-fixture').authentication).toBe('NOT VERIFIED');
  const unsupported = new GeminiSetup({ ...f.options, gemini: '/usr/bin/true' });
  expect(() => unsupported.plan()).toThrow('Installed CLI lacks');
});
