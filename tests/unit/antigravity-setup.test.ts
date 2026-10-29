import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourceAgentSchema } from '../../packages/core/src/source-agent.js';
import { AntigravitySetup } from '../../packages/mcp-server/src/antigravity/setup.js';
import { detectCli } from '../../packages/mcp-server/src/installer/detection.js';
import { PROVIDERS } from '../../packages/mcp-server/src/installer/model.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
import { legacyAntigravity } from '../helpers/antigravity-legacy-fixture.js';
import { installerFixture } from '../helpers/installer-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function fixture(scope: 'project' | 'user' = 'user') {
  const f = installerFixture();
  cleanup.push(f.cleanup);
  const service = new UnifiedInstaller({ ...f.options, scope });
  const setup = new AntigravitySetup({
    ...f.options,
    scope,
    adapter: f.options.adapters.antigravity,
  });
  return { ...f, service, setup };
}
function put(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}
it('recognizes Antigravity independently as provider and provenance', () => {
  expect(PROVIDERS).toEqual(['codex', 'claude', 'gemini', 'antigravity']);
  expect(sourceAgentSchema.parse('antigravity')).toBe('antigravity');
});
it('detects only agy from PATH and supports an explicit executable override without native MCP/model commands', () => {
  const f = fixture(),
    old = process.env.PATH;
  put(join(f.root, 'agy'), readFileSync(f.options.executables.antigravity, 'utf8'));
  chmodSync(join(f.root, 'agy'), 0o700);
  try {
    process.env.PATH = f.root;
    expect(detectCli('antigravity')).toMatchObject({
      state: 'DETECTED',
      executable: join(f.root, 'agy'),
      stdio: 'NOT_VERIFIED',
      capabilities_verified: false,
    });
    unlinkSync(join(f.root, 'agy'));
    expect(detectCli('antigravity').state).toBe('NOT_INSTALLED');
    expect(detectCli('antigravity', f.options.executables.antigravity).state).toBe('DETECTED');
  } finally {
    process.env.PATH = old;
  }
});
it.each(['relative/agy', '/missing-agy', 'agy\n--prompt'])(
  'rejects unsafe/missing executable %j',
  (path) => {
    expect(detectCli('antigravity', path).state).not.toBe('DETECTED');
  },
);
it('rejects directories and nonexecutable files', () => {
  const f = fixture();
  expect(detectCli('antigravity', f.root).state).toBe('CONFIG_ERROR');
  chmodSync(f.options.executables.antigravity, 0o600);
  expect(detectCli('antigravity', f.options.executables.antigravity).state).toBe('CONFIG_ERROR');
});
it.each(['user'] as const)(
  'installs official %s JSON and skill layout, merges unrelated settings, repeats without rewriting, removes owned files only',
  (scope) => {
    const f = fixture(scope),
      s = f.setup;
    expect(s.config).toBe(join(f.home, '.gemini/config/mcp_config.json'));
    const original = JSON.stringify({
      mcpServers: { other: { command: 'USER_SERVER' } },
      preference: 'preserved',
    });
    put(s.config, original);
    const unrelated = join(f.root, '.agents/skills/user-skill/SKILL.md');
    put(unrelated, 'USER SKILL');
    const plans = f.service.plan('setup', ['antigravity']);
    expect(plans[0]?.disposition).toBe('INSTALL');
    expect(existsSync(s.statePath)).toBe(false);
    expect(existsSync(f.options.database)).toBe(false);
    f.service.apply(plans);
    expect(f.service.status(['antigravity']).integrations[0]).toMatchObject({
      state: 'CONFIGURED',
      router: 'MANAGED_CURRENT',
      mcp: 'REGISTERED',
    });
    const d = JSON.parse(readFileSync(s.config, 'utf8'));
    expect(d.preference).toBe('preserved');
    expect(d.mcpServers.other.command).toBe('USER_SERVER');
    expect(d.mcpServers.agentmind).toEqual(s.entry());
    expect(d.mcpServers.agentmind).not.toHaveProperty('trust');
    expect(d.mcpServers.agentmind).not.toHaveProperty('includeTools');
    expect(d.mcpServers.agentmind).not.toHaveProperty('cwd'); // Inherit caller cwd so global use cannot impersonate the enrolled project.
    expect(statSync(s.config).mode & 0o777).toBe(0o600);
    const before = statSync(s.config).mtimeMs;
    expect(f.service.plan('setup', ['antigravity'])[0]?.disposition).toBe('SKIP');
    expect(statSync(s.config).mtimeMs).toBe(before);
    f.service.apply(f.service.plan('uninstall', ['antigravity']));
    expect(readFileSync(s.config, 'utf8')).toBe(original);
    expect(readFileSync(unrelated, 'utf8')).toBe('USER SKILL');
  },
);
it.each(['user'] as const)(
  'blocks an imported/unowned entry and cross-scope collision for %s',
  (scope) => {
    const f = fixture(scope);
    const alternate = join(f.root, '.agents/mcp_config.json');
    put(alternate, JSON.stringify({ mcpServers: { agentmind: { command: 'gemini-imported' } } }));
    expect(f.service.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
    expect(f.service.status(['antigravity']).integrations[0]?.state).toBe('CONFIG_ERROR');
    expect(existsSync(f.setup.statePath)).toBe(false);
  },
);
it.each(['{bad', '[]', '{"mcpServers":[]}'])(
  'refuses malformed config %j without writes',
  (text) => {
    const f = fixture();
    put(f.setup.config, text);
    expect(f.service.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
    expect(readFileSync(f.setup.config, 'utf8')).toBe(text);
  },
);
it('refuses config symlinks, changed receipt, edited MCP entry and conflicting registry binding', () => {
  const f = fixture();
  mkdirSync(join(f.setup.config, '..'), { recursive: true });
  const target = join(f.root, 'target.json');
  put(target, '{}');
  symlinkSync(target, f.setup.config);
  expect(f.service.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
  unlinkSync(f.setup.config);
  f.service.apply(f.service.plan('setup', ['antigravity']));
  expect(
    () => new UnifiedInstaller({ ...f.options, database: join(f.root, 'different.db') }),
  ).toThrow();
  const state = readFileSync(f.setup.statePath, 'utf8');
  put(f.setup.statePath, state.replace(f.options.database, join(f.root, 'forged.db')));
  expect(f.service.plan('repair', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
  put(f.setup.statePath, state);
  const config = JSON.parse(readFileSync(f.setup.config, 'utf8'));
  config.mcpServers.agentmind.disabled = true;
  put(f.setup.config, JSON.stringify(config));
  expect(f.service.plan('uninstall', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
});
it('repairs missing owned artifacts, updates router explicitly and preserves registry bytes on uninstall', () => {
  const f = fixture();
  put(f.options.database, 'MEMORY_SENTINEL');
  f.service.apply(f.service.plan('setup', ['antigravity']));
  unlinkSync(f.setup.routerPath);
  const repair = f.service.plan('repair', ['antigravity']);
  expect(repair[0]?.disposition).toBe('REPAIR');
  f.service.apply(repair);
  const service = new UnifiedInstaller({
    ...f.options,
    scope: 'user',
    router: `${f.options.router}\nUpdated router.\n`,
  });
  const update = service.plan('update', ['antigravity']);
  expect(update[0]?.disposition).toBe('UPDATE');
  service.apply(update);
  expect(readFileSync(f.setup.routerPath, 'utf8')).toContain('Updated router.');
  service.apply(service.plan('uninstall', ['antigravity']));
  expect(readFileSync(f.options.database, 'utf8')).toBe('MEMORY_SENTINEL');
});
it('keeps Gemini config without its executable and never imports or adopts its MCP entry', () => {
  const f = fixture();
  put(
    join(f.root, '.gemini/settings.json'),
    '{"mcpServers":{"agentmind":{"command":"USER_GEMINI"}}}',
  );
  unlinkSync(f.options.executables.gemini);
  f.service.apply(f.service.plan('setup', ['antigravity']));
  expect(readFileSync(join(f.root, '.gemini/settings.json'), 'utf8')).toContain('USER_GEMINI');
});
it('coexists with Gemini-owned router and preserves it during Antigravity uninstall', () => {
  const f = fixture();
  const project = new UnifiedInstaller(f.options);
  project.apply(project.plan('setup', ['gemini']));
  f.service.apply(f.service.plan('setup', ['antigravity']));
  f.service.apply(f.service.plan('uninstall', ['antigravity']));
  expect(project.status(['gemini']).integrations[0]?.state).toBe('CONFIGURED');
});
it('preserves legacy shared routers when uninstalling their owner with a managed dependent', () => {
  const f = fixture('project');
  legacyAntigravity(f);
  f.service.apply(f.service.plan('setup', ['gemini']));
  expect(f.service.plan('uninstall', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
  f.service.apply(f.service.plan('uninstall', ['gemini', 'antigravity']));
  expect(existsSync(f.setup.routerPath)).toBe(false);
});
it('rejects project setup/repair/update without persistent writes or a silent global fallback', () => {
  const f = fixture('project');
  for (const action of ['setup', 'repair', 'update'] as const) {
    if (action !== 'setup') legacyAntigravity(f);
    const plan = f.service.plan(action, ['antigravity']);
    expect(plan[0]?.disposition).toBe('CONFLICT');
    expect(
      plan[0]?.diagnostics.some((d) => d.message.includes('ANTIGRAVITY_SCOPE_UNSUPPORTED')),
    ).toBe(true);
  }
  expect(f.service.status(['antigravity']).integrations[0]?.state).toBe('UNSUPPORTED_SCOPE');
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
});
it('refuses pre-existing agentmind plugins and preserves unrelated plugin bytes', () => {
  const f = fixture();
  put(join(f.root, '.agents/plugins/other/plugin.json'), '{"name":"other"}');
  f.service.apply(f.service.plan('setup', ['antigravity']));
  expect(readFileSync(join(f.root, '.agents/plugins/other/plugin.json'), 'utf8')).toBe(
    '{"name":"other"}',
  );
  f.service.apply(f.service.plan('uninstall', ['antigravity']));
  put(join(f.root, '.agents/plugins/agentmind/plugin.json'), '{"name":"agentmind"}');
  expect(f.service.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
});
it('status, doctor and dry-run leave configuration, receipts and registry absent', () => {
  const f = fixture();
  f.service.status(['antigravity']);
  f.service.diagnostics(['antigravity']);
  f.service.plan('setup', ['antigravity']);
  expect(existsSync(f.setup.config)).toBe(false);
  expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
  expect(existsSync(f.options.database)).toBe(false);
});
it('refreshes installed runtime paths only through the matched receipt while retaining registry/project binding', () => {
  const f = fixture();
  const oldAdapter = join(f.root, 'old-runtime-adapter.js');
  put(oldAdapter, '// loadAntigravityEnrollment: packaging identity fixture; never executed\n');
  const oldService = new UnifiedInstaller({
    ...f.options,
    scope: 'user',
    adapters: { ...f.options.adapters, antigravity: oldAdapter },
  });
  oldService.apply(oldService.plan('setup', ['antigravity']));
  const before = JSON.parse(readFileSync(f.setup.enrollment, 'utf8'));
  const update = f.service.plan('update', ['antigravity']);
  expect(update[0]?.disposition).toBe('UPDATE');
  f.service.apply(update);
  const after = JSON.parse(readFileSync(f.setup.enrollment, 'utf8'));
  expect(after.project_id).toBe(before.project_id);
  expect(after.database).toBe(before.database);
  expect(JSON.parse(readFileSync(f.setup.config, 'utf8')).mcpServers.agentmind.args[0]).toBe(
    f.options.adapters.antigravity,
  );
  expect(f.service.status(['antigravity']).integrations[0]?.state).toBe('CONFIGURED');
});
it('rejects moved legacy receipts and enrollment links without touching either registry', () => {
  const f = fixture('project'),
    old = legacyAntigravity(f);
  const receipt = JSON.parse(readFileSync(old.setup.statePath, 'utf8'));
  receipt.root = join(f.root, 'moved');
  put(old.setup.statePath, JSON.stringify(receipt));
  const user = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect(user.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
  put(old.setup.statePath, JSON.stringify(old.receipt));
  unlinkSync(old.setup.enrollment);
  symlinkSync(old.setup.statePath, old.setup.enrollment);
  expect(user.plan('setup', ['antigravity'])[0]?.disposition).toBe('CONFLICT');
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
});
it('refuses a shared-router update during preview before removing an existing working registration', () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup', ['antigravity']));
  put(join(f.root, '.agents/skills/agentmind-router/SKILL.md'), f.options.router);
  const before = readFileSync(f.setup.config, 'utf8');
  const updated = new UnifiedInstaller({
    ...f.options,
    scope: 'user',
    router: `${f.options.router}\nUpdated.\n`,
  });
  const plan = updated.plan('update', ['antigravity']);
  expect(plan[0]?.disposition).toBe('CONFLICT');
  expect(
    plan[0]?.diagnostics.some((d) => d.message === 'ANTIGRAVITY_SHARED_ROUTER_UPDATE_REQUIRED'),
  ).toBe(true);
  expect(readFileSync(f.setup.config, 'utf8')).toBe(before);
});
