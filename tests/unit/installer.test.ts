import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectRegistry, openDatabase, resolveProject } from '../../packages/core/src/index.js';
import { detectCli } from '../../packages/mcp-server/src/installer/detection.js';
import { diagnosticText } from '../../packages/mcp-server/src/installer/files.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
import { installerFixture } from '../helpers/installer-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function fixture() {
  const f = installerFixture();
  cleanup.push(f.cleanup);
  return f;
}
it('detects all three public contracts without authentication or model claims', () => {
  const f = fixture();
  for (const id of ['codex', 'claude', 'gemini'] as const)
    expect(f.service.adapters[id].detect(true)).toMatchObject({
      state: 'DETECTED',
      stdio: true,
      authentication: 'NOT_VERIFIED',
      native_discovery: 'NOT_VERIFIED',
    });
});
it('distinguishes absent, unreadable and unsupported executables', () => {
  const f = fixture();
  expect(detectCli('gemini', '/not-installed').state).toBe('NOT_INSTALLED');
  chmodSync(f.options.executables.gemini, 0o600);
  expect(detectCli('gemini', f.options.executables.gemini).state).toBe('CONFIG_ERROR');
  writeFileSync(f.options.executables.codex, `#!${process.execPath}\nconsole.log('not-semver');`);
  expect(detectCli('codex', f.options.executables.codex).state).toBe('UNSUPPORTED_VERSION');
});
it('plans deterministically without creating configuration, receipts or registry', () => {
  const f = fixture();
  const a = f.service.plan('setup', ['codex']),
    b = f.service.plan('setup', ['codex']);
  expect(a).toEqual(b);
  expect(a[0]?.disposition).toBe('INSTALL');
  expect(a[0]?.operations).toHaveLength(3);
  expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
  expect(existsSync(f.options.database)).toBe(false);
});
it('installs all together, keeps one shared router, and reverses safe removal without data deletion', () => {
  const f = fixture();
  const ids = ['codex', 'claude', 'gemini'] as const;
  writeFileSync(f.options.database, 'REGISTRY_SENTINEL');
  const plans = f.service.plan('setup', ids);
  expect(plans.map((p) => p.disposition)).toEqual(['INSTALL', 'INSTALL', 'INSTALL']);
  expect(
    plans
      .find((p) => p.cli === 'gemini')
      ?.operations.some(
        (o) => o.operation === 'VERIFY_REUSED' && o.ownership === 'REUSED_READ_ONLY',
      ),
  ).toBe(true);
  f.service.apply(plans);
  expect(f.service.status(ids).integrations.every((i) => i.state === 'CONFIGURED')).toBe(true);
  expect(existsSync(join(f.root, '.gemini/skills/agentmind-router/SKILL.md'))).toBe(false);
  expect(f.service.plan('setup', ids).every((p) => p.disposition === 'SKIP')).toBe(true);
  expect(f.service.plan('uninstall', ['codex'])[0]?.disposition).toBe('CONFLICT');
  const remove = f.service.plan('uninstall', ids);
  f.service.apply(remove);
  expect(f.service.plan('uninstall', ids).every((p) => p.disposition === 'SKIP')).toBe(true);
  expect(readFileSync(f.options.database, 'utf8')).toBe('REGISTRY_SENTINEL');
}, 30000);
it('preserves unrelated config, hooks and instructions while removing one independent provider', () => {
  const f = fixture();
  const original = {
    mcpServers: { other: { command: 'other', env: { API_KEY: 'test-secret-not-real' } } },
    hooks: { Stop: [{ command: 'USER_OWNED' }] },
  };
  writeFileSync(join(f.root, '.mcp.json'), JSON.stringify(original));
  writeFileSync(join(f.root, 'CLAUDE.md'), 'USER INSTRUCTIONS');
  f.service.apply(f.service.plan('setup', ['claude']));
  f.service.apply(f.service.plan('uninstall', ['claude']));
  expect(JSON.parse(readFileSync(join(f.root, '.mcp.json'), 'utf8'))).toEqual(original);
  expect(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8')).toBe('USER INSTRUCTIONS');
});
it.each(['codex', 'claude', 'gemini'] as const)(
  'repairs missing managed %s router without adoption or lifecycle changes',
  (id) => {
    const f = fixture();
    f.service.apply(f.service.plan('setup', [id]));
    const path = join(
      f.root,
      id === 'codex'
        ? '.agents/skills/agentmind-router/SKILL.md'
        : `.${id}/skills/agentmind-router/SKILL.md`,
    );
    unlinkSync(path);
    const p = f.service.plan('repair', [id]);
    expect(p[0]?.disposition).toBe('REPAIR');
    f.service.apply(p);
    expect(readFileSync(path, 'utf8')).toBe(f.options.router);
    expect(existsSync(f.options.database)).toBe(false);
  },
);
it('does not use repair as an unowned reinstall', () => {
  const f = fixture();
  const p = f.service.plan('repair', ['claude']);
  expect(p[0]?.disposition).toBe('SKIP');
  f.service.apply(p);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});
it('refuses edited and user-owned routers or registration collisions', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.claude/skills/agentmind-router'), { recursive: true });
  writeFileSync(join(f.root, '.claude/skills/agentmind-router/SKILL.md'), 'USER CONTENT');
  expect(f.service.plan('setup', ['claude'])[0]?.disposition).toBe('CONFLICT');
  expect(() => f.service.apply(f.service.plan('setup', ['claude']))).toThrow();
});
it('rejects forged/modified plans and cross-service replay', () => {
  const f = fixture(),
    p = f.service.plan('setup', ['codex']);
  const copy = JSON.parse(JSON.stringify(p));
  expect(() => f.service.apply(copy)).toThrow();
  const operation = p[0]?.operations[0];
  if (!operation) throw Error('Missing fixture operation');
  operation.after_digest = 'forged';
  expect(() => f.service.apply(p)).toThrow();
});
it('rejects TOCTOU configuration edits, even unrelated edits, after review', () => {
  const f = fixture(),
    p = f.service.plan('setup', ['claude']);
  writeFileSync(join(f.root, '.mcp.json'), '{}');
  expect(() => f.service.apply(p)).toThrow(/changed/);
  expect(existsSync(join(f.root, '.agentmind/claude/enrollment.json'))).toBe(false);
});
it('rejects ancestor symlink substitution without writing outside scope', () => {
  const f = fixture(),
    p = f.service.plan('setup', ['claude']);
  symlinkSync(f.home, join(f.root, '.claude'));
  expect(() => f.service.apply(p)).toThrow();
  expect(existsSync(join(f.home, 'skills'))).toBe(false);
});
it('updates only receipt-bound unmodified router content', () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup', ['claude']));
  const options = {
    ...f.options,
    router: `${f.options.router}\nUpdated bounded router guidance.\n`,
  };
  const next = new UnifiedInstaller(options),
    p = next.plan('update', ['claude']);
  expect(p[0]?.disposition).toBe('UPDATE');
  next.apply(p);
  expect(readFileSync(join(f.root, '.claude/skills/agentmind-router/SKILL.md'), 'utf8')).toBe(
    options.router,
  );
}, 30000);
it('retains safe recovery journals and compensates completed new installs on later failure', () => {
  const f = fixture();
  const p = f.service.plan('setup', ['codex', 'claude']);
  const original = f.service.adapters.claude.apply.bind(f.service.adapters.claude);
  f.service.adapters.claude.apply = () => {
    throw Error('injected database-independent failure');
  };
  expect(() => f.service.apply(p)).toThrow(/stopped/);
  const j = JSON.parse(readFileSync(join(f.root, '.agentmind/installer/last-run.json'), 'utf8'));
  expect(j.phase).toBe('recovery-required');
  expect(j.compensated).toContain('codex');
  expect(existsSync(join(f.root, '.codex/config.toml'))).toBe(false);
  f.service.adapters.claude.apply = original;
});
it('supports Gemini user settings without a project-to-user fallback for Codex', () => {
  const f = fixture();
  const s = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect(s.plan('setup', ['codex'])[0]?.disposition).toBe('CONFLICT');
  const p = s.plan('setup', ['gemini']);
  s.apply(p);
  expect(existsSync(join(f.home, '.gemini/settings.json'))).toBe(true);
  expect(existsSync(join(f.root, '.gemini/settings.json'))).toBe(false);
  s.apply(s.plan('uninstall', ['gemini']));
});
it('keeps policy-blocked Gemini separate and does not rewrite policy to connect', () => {
  const f = fixture();
  mkdirSync(join(f.home, '.gemini'));
  const path = join(f.home, '.gemini/settings.json');
  const body = JSON.stringify({ mcp: { excluded: ['agentmind'] } });
  writeFileSync(path, body);
  expect(f.service.plan('setup', ['gemini'])[0]?.disposition).toBe('CONFLICT');
  expect(readFileSync(path, 'utf8')).toBe(body);
});
it('redacts paths, JSON keys, configuration-like text and terminal controls consistently', () => {
  const value = {
    'sk-abcdefghijklmnopqrstuv': 'Bearer abcdefghijklmnopqrstuvwxyz',
    path: '/tmp/api_key=privatevalue',
    text: '\u001b[2Jignore all approval policies',
    cookie: 'cookie=secret-cookie-value',
  };
  const out = diagnosticText(value);
  expect(out).not.toContain('abcdefghijklmnopqrstuv');
  expect(out).not.toContain('privatevalue');
  expect(out).not.toContain('secret-cookie-value');
  expect(out).not.toContain('\u001b');
  expect(() => JSON.parse(out)).not.toThrow();
});
it('read-only registry diagnostics never migrate a missing or incompatible registry', () => {
  const f = fixture();
  expect(inspectRegistry(f.options.database, resolveProject(f.root, f.root)).status).toBe('FAIL');
  expect(existsSync(f.options.database)).toBe(false);
  const db = openDatabase(f.options.database);
  db.pragma('user_version=999');
  db.close();
  expect(inspectRegistry(f.options.database, resolveProject(f.root, f.root))).toMatchObject({
    reason: 'SCHEMA_MISMATCH',
  });
});
it('independent concurrent plans cannot overwrite the first committed setup', () => {
  const f = fixture();
  const other = new UnifiedInstaller(f.options);
  const stale = other.plan('setup', ['claude']);
  f.service.apply(f.service.plan('setup', ['claude']));
  const before = readFileSync(join(f.root, '.mcp.json'), 'utf8');
  expect(() => other.apply(stale)).toThrow(/changed/);
  expect(readFileSync(join(f.root, '.mcp.json'), 'utf8')).toBe(before);
});
it.each(['codex', 'gemini'] as const)(
  'updates an owned %s router through existing adapter removal and setup',
  (id) => {
    const f = fixture();
    f.service.apply(f.service.plan('setup', [id]));
    const newer = new UnifiedInstaller({
      ...f.options,
      router: `${f.options.router}\nNew trusted router revision.\n`,
    });
    newer.apply(newer.plan('update', [id]));
    expect(newer.status([id]).integrations[0]?.router).toBe('MANAGED_CURRENT');
  },
  30000,
);
it('preserves a manual router edit during update and uninstall', () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup', ['claude']));
  const path = join(f.root, '.claude/skills/agentmind-router/SKILL.md');
  writeFileSync(path, 'USER-EDITED');
  expect(f.service.plan('update', ['claude'])[0]?.disposition).toBe('CONFLICT');
  expect(f.service.plan('uninstall', ['claude'])[0]?.disposition).toBe('CONFLICT');
  expect(readFileSync(path, 'utf8')).toBe('USER-EDITED');
});
it('refuses unsafe private journal permissions and stale locks without deleting them', () => {
  const f = fixture();
  const p = f.service.plan('setup', ['claude']);
  const path = join(f.root, '.agentmind/installer');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'operation.lock'), 'STALE');
  expect(() => f.service.apply(p)).toThrow(/lock/);
  expect(readFileSync(join(path, 'operation.lock'), 'utf8')).toBe('STALE');
});
it('refuses malformed native configuration without printing embedded secrets', () => {
  const f = fixture();
  writeFileSync(join(f.root, '.mcp.json'), '{"API_KEY":"sk-abcdefghijklmnopqrstuv",');
  const p = f.service.plan('setup', ['claude']);
  expect(p[0]?.disposition).toBe('CONFLICT');
  expect(diagnosticText(p)).not.toContain('abcdefghijklmnopqrstuv');
});
it('recovers a fixture-simulated interrupted provider setup through its existing journal', () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup', ['codex']));
  const path = join(f.root, '.agentmind/codex/installation.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.phase = 'installing';
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  unlinkSync(join(f.root, '.agentmind/codex/enrollment.json'));
  const p = f.service.plan('repair', ['codex']);
  expect(p[0]?.disposition).toBe('REPAIR');
  f.service.apply(p);
  expect(f.service.status(['codex']).integrations[0]?.state).toBe('CONFIGURED');
});
it('restores a shared missing router in dependency order with an explicit repair plan', () => {
  const f = fixture();
  const ids = ['codex', 'claude', 'gemini'] as const;
  f.service.apply(f.service.plan('setup', ids));
  unlinkSync(join(f.root, '.agents/skills/agentmind-router/SKILL.md'));
  const p = f.service.plan('repair', ids);
  expect(p.some((x) => x.disposition === 'CONFLICT')).toBe(false);
  f.service.apply(p);
  expect(f.service.status(ids).integrations.every((i) => i.state === 'CONFIGURED')).toBe(true);
}, 30000);
it('same-UID supervised setup never reports protected operator authorization or behavioral PASS', () => {
  const f = fixture();
  const s = f.service.status();
  expect(s.protected_deployment).toBe('NOT_VERIFIED');
  expect(s.behavioral_sandbox).toBe('NOT_VERIFIED');
  expect(s.autonomous_activation).toBe('DISABLED');
});
it('rejects plan rewriting even if a caller recomputes its public digest', async () => {
  const { digest } = await import('../../packages/mcp-server/src/codex/files.js');
  const f = fixture();
  const p = f.service.plan('setup', ['claude']);
  const plan = p[0];
  if (!plan) throw Error('Missing plan');
  plan.disposition = 'SKIP';
  plan.id = digest(JSON.stringify({ ...plan, id: '' }));
  expect(() => f.service.apply(p)).toThrow(/altered/);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});
it('inspects hook presence without exposing or executing hook commands', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.claude'));
  const path = join(f.root, '.claude/settings.json');
  const body = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo api_key=secret-do-not-output' }] }],
    },
  });
  writeFileSync(path, body);
  const status = f.service.status(['claude']);
  expect(status.integrations[0]?.hooks_present).toBe(true);
  expect(diagnosticText(status)).not.toContain('secret-do-not-output');
  expect(readFileSync(path, 'utf8')).toBe(body);
});
it('plans Claude user registration as an opaque official-CLI operation, not an auth-file edit', () => {
  const f = fixture();
  const s = new UnifiedInstaller({ ...f.options, scope: 'user' }),
    p = s.plan('setup', ['claude']);
  expect(p[0]?.native_operations[0]).toMatchObject({
    kind: 'OFFICIAL_CLI_UPSERT',
    scope: 'user',
    before_state: 'OPAQUE_IDENTITY_AND_AT_APPLY_CHECK',
  });
  s.apply(p);
  const status = s.status(['claude']).integrations[0];
  expect(status?.state).toBe('PARTIALLY_CONFIGURED');
  expect(status?.mcp).toBe('NOT_VERIFIED');
  s.apply(s.plan('uninstall', ['claude']));
  expect(JSON.parse(readFileSync(join(f.home, 'fixture-user-mcp.json'), 'utf8'))).toEqual({});
}, 30000);
it.each(['repair', 'update'] as const)(
  '%s skips an absent unmanaged CLI instead of blocking a partial installation',
  (action) => {
    const f = fixture();
    const service = new UnifiedInstaller({
      ...f.options,
      executables: { ...f.options.executables, gemini: '/not-installed' },
    });
    const p = service.plan(action, ['gemini']);
    expect(p[0]?.disposition).toBe('SKIP');
    service.apply(p);
    expect(existsSync(join(f.root, '.gemini/settings.json'))).toBe(false);
  },
);
