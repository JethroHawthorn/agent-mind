import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { initializeProtectedRegistry, openDatabase } from '../../packages/core/src/index.js';
import { loadAntigravityEnrollment } from '../../packages/mcp-server/src/antigravity/adapter.js';
import { AntigravitySetup } from '../../packages/mcp-server/src/antigravity/setup.js';
import { DAILY_TOOLS } from '../../packages/mcp-server/src/codex/configuration.js';
import { runtimeDoctor } from '../../packages/mcp-server/src/installer/doctor.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
import { completeSetup } from '../../packages/mcp-server/src/installer/setup.js';
import { outputSchemas } from '../../packages/mcp-server/src/mcp-output.js';
import { legacyAntigravity } from '../helpers/antigravity-legacy-fixture.js';
import { installerFixture } from '../helpers/installer-fixture.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
function fixture() {
  const f = installerFixture();
  cleanup.push(f.cleanup);
  return f;
}
async function connect(root: string, entry: { command: string; args: string[] }) {
  const c = new Client({ name: 'DIRECT-STDIO-ANTIGRAVITY-ADAPTER-NOT-NATIVE-MODEL', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: root,
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const data = JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null');
  const schema = outputSchemas[name as keyof typeof outputSchemas];
  expect(schema?.safeParse(data).success, name).toBe(true);
  return data;
}
it('direct stdio: setup readiness, exact daily tools/output schemas, persisted memory/experience/signals, restart, four-adapter sharing, isolation and protected denial', async () => {
  const f = fixture();
  const ag = new UnifiedInstaller({ ...f.options, scope: 'user' });
  const dry = await completeSetup(ag, ['antigravity'], false);
  expect(dry.exit_code).toBe(0);
  expect(existsSync(f.options.database)).toBe(false);
  const result = await completeSetup(f.service, ['codex', 'claude', 'gemini', 'antigravity'], true);
  expect(result.ready, JSON.stringify(result)).toBe(true);
  expect((await completeSetup(ag, ['antigravity'], true)).ready).toBe(true);
  const c = await connect(
    f.root,
    JSON.parse(readFileSync(join(f.home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers
      .agentmind,
  );
  await c.ping();
  const tools = (await c.listTools()).tools;
  expect(tools.map((t) => t.name).sort()).toEqual([...DAILY_TOOLS].sort());
  for (const t of tools) {
    expect(t.inputSchema.type).toBe('object');
    expect(t.outputSchema?.type).toBe('object');
  }
  const health = await call(c, 'agentmind_status');
  expect(health.source_agent).toBe('antigravity');
  const codex = await connect(f.root, {
    command: process.execPath,
    args: [
      f.options.adapters.codex,
      '--enrollment',
      join(f.root, '.agentmind/codex/enrollment.json'),
    ],
  });
  const memory = (
    await call(codex, 'memory_save', {
      title: 'Antigravity shared boundary',
      content: 'Preserve numeric zero in SQLite boundary checks.',
    })
  ).memory;
  expect((await call(c, 'memory_search', { query: 'shared boundary' })).memories[0].id).toBe(
    memory.id,
  );
  const xp = (
    await call(c, 'experience_record', {
      problem: 'Antigravity boundary retained zero',
      solution: 'Inspect SQLite lower and upper bounds.',
      outcome: { status: 'unknown', summary: 'Fixture observation requires review.' },
    })
  ).experience;
  expect(xp.source_agent).toBe('antigravity');
  expect(xp.verification_status).toBe('unverified');
  for (const id of ['codex', 'claude', 'gemini'] as const) {
    const other = await connect(f.root, {
      command: process.execPath,
      args: [
        f.options.adapters[id],
        '--enrollment',
        join(f.root, `.agentmind/${id}/enrollment.json`),
      ],
    });
    expect(
      (await call(other, 'experience_search', { query: 'retained zero' })).experiences[0].id,
    ).toBe(xp.id);
    expect((await call(other, 'agentmind_status')).project_id).toBe(health.project_id);
  }
  const signal = await call(c, 'learning_signal_record', {
    schema_version: 1,
    type: 'PROBLEM_SOLVED',
    title: 'Boundary lesson',
    summary: 'Retain zero boundaries; no verified outcome.',
    experience_ids: [xp.id],
    reusability: 'potentially_reusable',
  });
  expect(signal.evidence_trust).toBe('AGENT_REPORTED');
  expect(JSON.stringify(await call(c, 'learning_signal_get', { signal_id: signal.id }))).toContain(
    'antigravity',
  );
  for (const name of [
    'skill_approve',
    'skill_promote',
    'review_decide',
    'distribution_sync',
    'db_migrate',
    'confirm_outcome',
  ]) {
    const denied = await c.callTool({ name, arguments: {} });
    expect(denied.isError, name).toBe(true);
  }
  await c.close();
  const restarted = await connect(f.root, {
    command: process.execPath,
    args: [
      f.options.adapters.antigravity,
      '--enrollment',
      join(f.root, '.agentmind/antigravity/enrollment.json'),
    ],
  });
  expect(
    (await call(restarted, 'memory_search', { query: 'shared boundary' })).memories[0].id,
  ).toBe(memory.id);
  const foreign = fixture();
  const foreignService = new UnifiedInstaller({
    ...foreign.options,
    scope: 'user',
    database: f.options.database,
  });
  foreignService.apply(foreignService.plan('setup', ['antigravity']));
  const isolated = await connect(foreign.root, {
    command: process.execPath,
    args: [
      foreign.options.adapters.antigravity,
      '--enrollment',
      join(foreign.root, '.agentmind/antigravity/enrollment.json'),
    ],
  });
  expect((await call(isolated, 'memory_search', { query: 'shared boundary' })).memories).toEqual(
    [],
  );
  expect(
    (await isolated.callTool({ name: 'learning_signal_get', arguments: { signal_id: signal.id } }))
      .isError,
  ).toBe(true);
  expect(
    (
      await isolated.callTool({
        name: 'memory_search',
        arguments: { query: 'boundary', project_id: health.project_id },
      })
    ).isError,
  ).toBe(true);
  expect(() =>
    loadAntigravityEnrollment(join(f.root, '.agentmind/antigravity/enrollment.json'), foreign.root),
  ).toThrow();
  const before = statSync(join(f.home, '.gemini/config/mcp_config.json')).mtimeMs;
  expect((await completeSetup(ag, ['antigravity'], true)).results[0]?.action).toBe('SKIP');
  expect(statSync(join(f.home, '.gemini/config/mcp_config.json')).mtimeMs).toBe(before);
  expect((await runtimeDoctor(ag, 'antigravity')).every((d) => d.status === 'PASS')).toBe(true);
  await restarted.close();
  await isolated.close();
  ag.apply(ag.plan('uninstall', ['antigravity']));
  expect(existsSync(f.options.database)).toBe(true);
  expect((await call(codex, 'memory_search', { query: 'shared boundary' })).memories[0].id).toBe(
    memory.id,
  );
}, 30000);
it('direct stdio: routes/retrieves only approved digest-pinned skills, rejects changed digest and preserves lifecycle', async () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  const s = new AntigravitySetup({
    root: f.root,
    home: f.home,
    database: f.path,
    scope: 'user',
    adapter: resolve('packages/mcp-server/dist/antigravity/adapter.js'),
    router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
  });
  s.setup();
  const skill = f.add({
    name: 'sqlite-antigravity-boundary',
    description: 'Inspect SQLite retry boundaries and preserve numeric zero.',
  });
  const c = await connect(f.root, s.entry());
  expect(
    (await call(c, 'skill_route', { context: { summary: 'sqlite retry boundary' } })).skills[0]
      .active_version_id,
  ).toBe(skill.version.id);
  const pin = {
    skill_id: skill.identity.id,
    expected_version_id: skill.version.id,
    expected_digest: skill.version.content_hash,
  };
  expect((await call(c, 'skill_load', pin)).version_id).toBe(skill.version.id);
  expect(
    (
      await c.callTool({
        name: 'skill_load',
        arguments: { ...pin, expected_digest: '0'.repeat(64) },
      })
    ).isError,
  ).toBe(true);
  const state = f.db
    .prepare('SELECT * FROM skill_version_states WHERE version_id=?')
    .get(skill.version.id);
  await c.callTool({ name: 'skill_promote', arguments: { version_id: skill.version.id } });
  expect(
    f.db.prepare('SELECT * FROM skill_version_states WHERE version_id=?').get(skill.version.id),
  ).toEqual(state);
}, 15000);
it('CLI parser accepts antigravity/override and keeps status/ordinary doctor read-only; all includes it', () => {
  const f = fixture();
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/agentmind.js'),
        ...args,
        '--project-root',
        f.root,
        '--db',
        f.options.database,
        '--antigravity',
        f.options.executables.antigravity,
        '--json',
      ],
      { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: f.home } },
    );
  for (const action of ['status', 'doctor']) {
    const result = run([action, '--cli', 'antigravity']);
    expect([0, 7]).toContain(result.status);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
    expect(existsSync(f.options.database)).toBe(false);
  }
  const all = JSON.parse(run(['status', '--cli', 'all']).stdout);
  expect(all.integrations.some((i: { cli: string }) => i.cli === 'antigravity')).toBe(true);
  const apply = run(['setup', '--cli', 'antigravity', '--scope', 'user', '--apply']);
  expect(apply.status, apply.stdout).toBe(0);
  expect(JSON.parse(apply.stdout).ready).toBe(true);
  const enrollment = join(f.root, '.agentmind/antigravity/enrollment.json');
  const raw = JSON.parse(readFileSync(enrollment, 'utf8'));
  raw.integration = 'agentmind-gemini-v1';
  writeFileSync(enrollment, JSON.stringify(raw));
  expect(() => loadAntigravityEnrollment(enrollment)).toThrow();
}, 30000);
it('user-scope stdio inherits caller project and rejects another project rather than pinning cwd', async () => {
  const f = fixture(),
    foreign = fixture();
  const service = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect((await completeSetup(service, ['antigravity'], true)).ready).toBe(true);
  const entry = JSON.parse(readFileSync(join(f.home, '.gemini/config/mcp_config.json'), 'utf8'))
    .mcpServers.agentmind;
  expect(entry.cwd).toBeUndefined();
  await expect(connect(foreign.root, entry)).rejects.toThrow();
  mkdirSync(join(f.root, 'subdirectory'));
  const c = await connect(join(f.root, 'subdirectory'), entry);
  expect((await call(c, 'agentmind_status')).source_agent).toBe('antigravity');
}, 15000);
it('explicit user migration verifies MCP and native inventory before removing only the old receipt-owned entry', async () => {
  const f = fixture(),
    old = legacyAntigravity(f);
  const ag = new UnifiedInstaller({ ...f.options, scope: 'user' });
  const before = readFileSync(old.setup.config, 'utf8');
  const preview = await completeSetup(ag, ['antigravity'], false);
  expect(preview.plans[0]?.disposition).toBe('MIGRATE');
  expect(preview.plans[0]?.post_health_operations?.[0]?.path).toBe(old.setup.config);
  expect(readFileSync(old.setup.config, 'utf8')).toBe(before);
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
  const result = await completeSetup(ag, ['antigravity'], true);
  expect(result.ready, JSON.stringify(result)).toBe(true);
  expect(existsSync(old.setup.config)).toBe(false);
  expect(JSON.parse(readFileSync(old.setup.statePath, 'utf8'))).toMatchObject({
    scope: 'user',
    migration: { completed: true, legacy: { scope: 'project', database: f.options.database } },
  });
  expect(existsSync(f.options.database)).toBe(true);
}, 15000);
it('native inventory failure retains old owned config and migration journal; a healthy rerun finishes cleanup', async () => {
  const f = fixture(),
    old = legacyAntigravity(f),
    executable = f.options.executables.antigravity;
  const bytes = readFileSync(executable, 'utf8');
  writeFileSync(
    executable,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('1.4.10');else process.exit(1);`,
  );
  const ag = new UnifiedInstaller({ ...f.options, scope: 'user' });
  const failed = await completeSetup(ag, ['antigravity'], true);
  expect(failed.ready).toBe(false);
  expect(existsSync(old.setup.config)).toBe(true);
  expect(JSON.parse(readFileSync(old.setup.statePath, 'utf8')).migration.completed).toBe(false);
  writeFileSync(executable, bytes);
  const retry = await completeSetup(ag, ['antigravity'], true);
  expect(retry.ready, JSON.stringify(retry)).toBe(true);
  expect(existsSync(old.setup.config)).toBe(false);
}, 15000);
it('refuses migration of edited or unowned legacy configuration before changing global registration', async () => {
  const f = fixture(),
    old = legacyAntigravity(f);
  const changed = JSON.parse(readFileSync(old.setup.config, 'utf8'));
  changed.mcpServers.agentmind.command = '/edited';
  writeFileSync(old.setup.config, JSON.stringify(changed));
  const ag = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect((await completeSetup(ag, ['antigravity'], true)).ready).toBe(false);
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
  expect(readFileSync(old.setup.config, 'utf8')).toContain('/edited');
});
it('uninstalling a failed migration restores the exact legacy enrollment/receipt without deleting memory', async () => {
  const f = fixture(),
    old = legacyAntigravity(f),
    exe = f.options.executables.antigravity;
  writeFileSync(
    exe,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('1.4.10');else process.exit(1);`,
  );
  const ag = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect((await completeSetup(ag, ['antigravity'], true)).ready).toBe(false);
  ag.apply(ag.plan('uninstall', ['antigravity']));
  expect(JSON.parse(readFileSync(old.setup.statePath, 'utf8'))).toEqual(old.receipt);
  expect(readFileSync(old.setup.enrollment, 'utf8')).toBe(old.receipt.enrollment);
  expect(existsSync(old.setup.config)).toBe(true);
  expect(existsSync(f.options.database)).toBe(true);
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
}, 15000);
it('refuses protected registries before writing user registration or changing registry bytes', async () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  initializeProtectedRegistry(db, 'ba688c5f-38ab-4dfc-a035-3297e130077e');
  db.close();
  const before = readFileSync(f.options.database);
  const service = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect(await completeSetup(service, ['antigravity'], true)).toMatchObject({
    ready: false,
    exit_code: 3,
  });
  expect(readFileSync(f.options.database)).toEqual(before);
  expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
});
it('MCP startup failure retains the old owned entry and pending journal without claiming readiness', async () => {
  const f = fixture(),
    old = legacyAntigravity(f),
    adapter = join(f.root, 'broken.js');
  writeFileSync(adapter, '// loadAntigravityEnrollment\nprocess.exit(1);\n');
  const service = new UnifiedInstaller({
    ...f.options,
    scope: 'user',
    adapters: { ...f.options.adapters, antigravity: adapter },
  });
  const result = await completeSetup(service, ['antigravity'], true);
  expect(result.ready).toBe(false);
  expect(result.checks.some((d) => d.id === 'mcp-health' && d.status === 'FAIL')).toBe(true);
  expect(existsSync(old.setup.config)).toBe(true);
  expect(JSON.parse(readFileSync(old.setup.statePath, 'utf8')).migration.completed).toBe(false);
}, 15000);
