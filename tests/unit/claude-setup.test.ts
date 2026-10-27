import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadClaudeEnrollment } from '../../packages/mcp-server/src/claude/adapter.js';
import { inspectClaude, mcpDocument } from '../../packages/mcp-server/src/claude/configuration.js';
import { ClaudeSetup } from '../../packages/mcp-server/src/claude/setup.js';
import { codexFixture } from '../helpers/codex-fixture.js';

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture(scope: 'project' | 'user' = 'project') {
  const f = codexFixture(' Claude spaces');
  cleanup.push(f.cleanup);
  const home = join(f.root, 'fake-home');
  mkdirSync(home, { recursive: true });
  const options = {
    ...f.options,
    adapter: resolve('packages/mcp-server/dist/claude/adapter.js'),
    scope,
    home,
  };
  const setup = new ClaudeSetup(options);
  return { ...f, options, setup, home };
}
it('dry-run does not create integration files or databases; CLAUDE.md remains unchanged', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'CLAUDE.md'), 'User guidance\n');
  expect(f.setup.plan().action).toBe('INSTALL');
  expect(existsSync(f.setup.config)).toBe(false);
  expect(existsSync(f.setup.statePath)).toBe(false);
  expect(existsSync(f.options.database)).toBe(false);
  expect(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8')).toBe('User guidance\n');
});
it('preserves existing configuration, idempotent setup and safe uninstall with later unrelated changes', () => {
  const f = fixture();
  const original = {
    mcpServers: { other: { type: 'stdio', command: 'other', env: { FIXTURE: 'DO_NOT_EXPOSE' } } },
    extra: { keep: true },
  };
  writeFileSync(f.setup.config, JSON.stringify(original));
  expect(f.setup.setup().installed).toBe(true);
  const first = readFileSync(f.setup.config, 'utf8');
  expect(f.setup.setup().installed).toBe(true);
  expect(readFileSync(f.setup.config, 'utf8')).toBe(first);
  const d = JSON.parse(first);
  d.mcpServers.later = { command: 'later' };
  writeFileSync(f.setup.config, JSON.stringify(d));
  expect(f.setup.uninstall(false)).toMatchObject({ dry_run: true });
  f.setup.uninstall(true);
  const after = JSON.parse(readFileSync(f.setup.config, 'utf8'));
  expect(after.mcpServers.other).toEqual(original.mcpServers.other);
  expect(after.mcpServers.later).toEqual({ command: 'later' });
  expect(existsSync(f.setup.routerPath)).toBe(false);
  expect(existsSync(f.setup.enrollment)).toBe(false);
  expect(f.setup.uninstall(true).action).toBe('SKIP');
});
it.each(['router', 'entry', 'enrollment'])('never overwrites changed managed %s', (kind) => {
  const f = fixture();
  f.setup.setup();
  if (kind === 'router') writeFileSync(f.setup.routerPath, 'user content');
  if (kind === 'enrollment') writeFileSync(f.setup.enrollment, '{}');
  if (kind === 'entry') {
    const d = JSON.parse(readFileSync(f.setup.config, 'utf8'));
    d.mcpServers[f.setup.serverName].command = 'user';
    writeFileSync(f.setup.config, JSON.stringify(d));
  }
  expect(() => f.setup.setup()).toThrow();
  expect(() => f.setup.uninstall(true)).toThrow();
});
it.each(['router', 'registration', 'malformed', 'duplicate'])(
  'rejects user-owned collision: %s',
  (kind) => {
    const f = fixture();
    if (kind === 'router') {
      mkdirSync(join(f.root, '.claude/skills/agentmind-router'), { recursive: true });
      writeFileSync(f.setup.routerPath, 'user-owned');
    }
    if (kind === 'registration')
      writeFileSync(
        f.setup.config,
        JSON.stringify({ mcpServers: { [f.setup.serverName]: { command: 'user' } } }),
      );
    if (kind === 'duplicate')
      writeFileSync(
        f.setup.config,
        JSON.stringify({ mcpServers: { agentmind: { command: 'user' } } }),
      );
    if (kind === 'malformed') writeFileSync(f.setup.config, '{bad');
    expect(() => f.setup.setup()).toThrow();
    expect(existsSync(f.setup.enrollment)).toBe(false);
  },
);
it('rejects symlink escape, held setup lock, and forged enrollment roles/project IDs', () => {
  const f = fixture();
  symlinkSync(f.home, join(f.root, '.claude'));
  expect(() => f.setup.plan()).toThrow();
  const g = fixture();
  mkdirSync(join(g.root, '.agentmind/claude'), { recursive: true, mode: 0o700 });
  writeFileSync(join(g.root, '.agentmind/claude/setup.lock'), 'held');
  expect(() => g.setup.setup()).toThrow('locked');
  const h = fixture();
  h.setup.setup();
  const e = JSON.parse(readFileSync(h.setup.enrollment, 'utf8'));
  e.project_id = 'a'.repeat(64);
  writeFileSync(h.setup.enrollment, JSON.stringify(e));
  expect(() => loadClaudeEnrollment(h.setup.enrollment, h.root)).toThrow();
});
it('recovers interrupted installation and removal from durable journal, retaining backup', () => {
  const f = fixture();
  f.setup.setup();
  const r = JSON.parse(readFileSync(f.setup.statePath, 'utf8'));
  r.phase = 'installing';
  writeFileSync(f.setup.statePath, JSON.stringify(r));
  expect(f.setup.setup().installed).toBe(true);
  r.phase = 'removing';
  writeFileSync(f.setup.statePath, JSON.stringify(r));
  expect(() => f.setup.setup()).toThrow('Finish uninstall');
  expect(f.setup.uninstall(true).installed).toBe(false);
  expect(existsSync(join(f.root, `.agentmind/claude/backup-${r.installation_id}.json`))).toBe(true);
});
it('user scope uses official CLI in fake home; credentials/config remain CLI-owned and unrelated entries survive', () => {
  const f = fixture('user');
  const env = { PATH: process.env.PATH, HOME: f.home, CLAUDE_CONFIG_DIR: join(f.home, '.claude') };
  const run = (args: string[]) =>
    spawnSync(f.setup.claude, args, { cwd: f.root, env, encoding: 'utf8', timeout: 15000 });
  expect(
    run([
      'mcp',
      'add-json',
      '--scope',
      'user',
      'unrelated',
      JSON.stringify({ command: '/nonexistent-fixture' }),
    ]).status,
  ).toBe(0);
  expect(f.setup.setup().installed).toBe(true);
  expect(existsSync(f.setup.config)).toBe(false);
  expect(f.setup.setup().installed).toBe(true);
  f.setup.uninstall(true);
  expect(run(['mcp', 'get', f.setup.serverName]).status).toBe(1);
  expect(run(['mcp', 'get', 'unrelated']).status).toBe(0);
}, 30000);
it('strict JSON config validation and CLI help do not require a project', () => {
  expect(() => mcpDocument('{"mcpServers":[]}')).toThrow();
  for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [resolve('packages/mcp-server/dist/claude.js'), flag], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--scope project|user');
  }
});
it('missing executable and unsupported CLI fail before enrollment', () => {
  const f = fixture();
  expect(() => new ClaudeSetup({ ...f.options, claude: '/nonexistent-claude-fixture' })).toThrow(
    'official Claude',
  );
  const stub = new ClaudeSetup({ ...f.options, claude: '/usr/bin/true' });
  expect(() => stub.plan()).toThrow('Claude must support');
  expect(existsSync(stub.enrollment)).toBe(false);
});

it('non-secret official auth projection never returns arbitrary CLI identity or credential fields', () => {
  const f = fixture(),
    path = join(f.root, 'auth-status-fixture');
  writeFileSync(
    path,
    `#!/usr/bin/env node
console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token',email:'PRIVATE_FIXTURE_EMAIL',token:'PRIVATE_FIXTURE_CREDENTIAL'}));
`,
  );
  chmodSync(path, 0o700);
  const status = inspectClaude(path);
  expect(status.authentication.configured).toBe(true);
  expect(status.authentication.model_execution).toBe('NOT VERIFIED');
  expect(JSON.stringify(status)).not.toContain('PRIVATE_FIXTURE');
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token'}));process.exitCode=1;\n`,
  );
  expect(inspectClaude(path).authentication.configured).toBe(false);
});
it('duplicate JSON keys are rejected and embedded strings remain inert', () => {
  expect(() => mcpDocument('{"mcpServers":{"a":{},"a":{}}}')).toThrow();
  expect(() => mcpDocument('{"mcpServers":{},"mcpServers":{}}')).toThrow();
  expect(
    mcpDocument(JSON.stringify({ mcpServers: { a: { args: ['{ "mcpServers": 1 }'] } } })).mcpServers
      .a,
  ).toBeDefined();
});
it('CLI JSON preview excludes unrelated values and rejects conflicting apply flags', () => {
  const f = fixture();
  writeFileSync(
    f.setup.config,
    JSON.stringify({
      mcpServers: { other: { command: 'other', env: { PRIVATE: 'PRIVATE_FIXTURE_SENTINEL' } } },
    }),
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/claude.js'),
        ...args,
        '--project-root',
        f.root,
        '--db',
        f.options.database,
        '--json',
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
  const r = run(['setup', '--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('PRIVATE_FIXTURE_SENTINEL');
  expect(JSON.parse(r.stdout).apply_required).toBe(true);
  expect(existsSync(f.setup.statePath)).toBe(false);
  expect(run(['setup', '--apply', '--dry-run']).status).toBe(1);
  expect(run(['doctor', '--connect', '--dry-run']).status).toBe(1);
});

it('user setup serializes shared home installation and rejects duplicate scoped ownership', () => {
  const f = fixture('user');
  const parent = join(f.home, '.claude/agentmind-integration');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(join(parent, 'setup.lock'), 'held');
  expect(() => f.setup.setup()).toThrow('locked');
  expect(existsSync(f.setup.enrollment)).toBe(false);
});
