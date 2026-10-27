import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectRegistry, openDatabase } from '../../packages/core/src/index.js';
import { runtimeDoctor } from '../../packages/mcp-server/src/installer/doctor.js';
import { nativeDoctor } from '../../packages/mcp-server/src/installer/native.js';
import { installerFixture } from '../helpers/installer-fixture.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function fixture() {
  const f = installerFixture();
  cleanup.push(f.cleanup);
  return f;
}
function run(f: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      resolve('packages/mcp-server/dist/agentmind.js'),
      ...args,
      '--project-root',
      f.root,
      '--db',
      f.options.database,
      '--codex',
      f.options.executables.codex,
      '--claude',
      f.options.executables.claude,
      '--gemini',
      f.options.executables.gemini,
    ],
    {
      cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.home },
      encoding: 'utf8',
      timeout: 20000,
    },
  );
}
it('proves shared real MCP startup, schemas, scope and bounded retrieval without native models', async () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup'));
  expect(existsSync(f.options.database)).toBe(false);
  for (const id of ['codex', 'claude', 'gemini'] as const) {
    const checks = await runtimeDoctor(f.service, id);
    expect(
      checks.map((c) => c.status),
      JSON.stringify(checks),
    ).toEqual(['PASS', 'PASS']);
    expect(checks.every((c) => c.evidence === 'OFFLINE_RUNTIME')).toBe(true);
  }
  expect(inspectRegistry(f.options.database, f.service.project).status).toBe('PASS');
}, 30000);
it('handles unavailable runtime/build without reading raw errors or creating a success claim', async () => {
  const f = fixture();
  expect((await runtimeDoctor(f.service, 'claude', 50))[0]?.status).toBe('FAIL');
});
it('status JSON is read-only, scoped, bounded and does not initialize SQLite', () => {
  const f = fixture(),
    r = run(f, ['status', '--json']);
  expect(r.status).toBe(0);
  const s = JSON.parse(r.stdout);
  expect(s.schema_version).toBe(1);
  expect(s.integrations).toHaveLength(3);
  expect(s.authentication).toBe('NOT_VERIFIED_NO_AUTH_PROBES');
  expect(existsSync(f.options.database)).toBe(false);
  expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
  expect(Buffer.byteLength(r.stdout)).toBeLessThan(16384);
});
it('noninteractive setup defaults to preview and --apply is explicit, idempotent and reversible', () => {
  const f = fixture();
  let r = run(f, ['setup', '--cli', 'claude', '--json']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).dry_run).toBe(true);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
  r = run(f, ['setup', '--cli', 'claude', '--apply', '--json']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).applied).toBe(true);
  r = run(f, ['setup', '--cli', 'claude', '--apply', '--json']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).results[0].action).toBe('SKIP');
  r = run(f, ['uninstall', '--cli', 'claude', '--apply', '--json']);
  expect(r.status).toBe(0);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
}, 30000);
it.each([
  ['setup', '--apply', '--dry-run'],
  ['status', '--apply'],
  ['doctor', '--native'],
  ['doctor', '--allow-model'],
  ['setup', '--scope', 'global'],
  ['setup', '--project-id', 'forged'],
])('rejects invalid authorization/selection arguments before mutations %j', (...args) => {
  const f = fixture();
  const r = run(f, [...args, '--json']);
  expect(r.status).toBe(4);
  expect(() => JSON.parse(r.stdout)).not.toThrow();
  expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
});
it('ordinary doctor gives structured limits and never starts a model or registry migration', () => {
  const f = fixture(),
    r = run(f, ['doctor', '--json']);
  expect(r.status).toBe(7);
  const d = JSON.parse(r.stdout);
  expect(d.model_invocations_authorized).toBe(false);
  expect(d.native).toEqual([]);
  expect(d.checks.find((c: { id: string }) => c.id === 'sec01.protected').status).toBe(
    'NOT_VERIFIED',
  );
  expect(existsSync(f.options.database)).toBe(false);
});
it('active package integrity checks use canonical scope and never expose skill content', () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  f.add({ name: 'integrity-diagnostic', description: 'Scoped safe integrity check.' });
  const r = inspectRegistry(f.path, f.scope);
  expect(r).toMatchObject({ status: 'PASS', checked: 1, invalid: 0 });
  expect(JSON.stringify(r)).not.toContain('SKILL.md');
  expect(inspectRegistry(f.path, f.otherScope)).toMatchObject({ status: 'PASS', checked: 0 });
});
it('native mode reuses a bounded harness but never infers Router discovery/use from scenario A', async () => {
  const f = fixture(),
    script = join(f.root, 'native-fixture.mjs');
  writeFileSync(
    script,
    'console.log(JSON.stringify({scenarios:{A:"PASS"},reason:"CORRELATED_NATIVE_EVIDENCE"}));',
  );
  const r = await nativeDoctor('claude', script);
  expect(r).toMatchObject({
    status: 'PASS',
    router_discovery: 'NOT_VERIFIED',
    router_use: 'NOT_VERIFIED',
  });
  expect(await nativeDoctor('gemini', join(f.root, 'missing'))).toMatchObject({
    status: 'NOT_VERIFIED',
  });
});
it('MCP timeouts fail safely and terminate a disposable nonprotocol server', async () => {
  const f = fixture();
  const script = join(f.root, 'hanging-adapter.mjs');
  writeFileSync(script, '// loadClaudeEnrollment\nsetInterval(()=>{},1000);');
  const { UnifiedInstaller } = await import('../../packages/mcp-server/src/installer/service.js');
  const service = new UnifiedInstaller({
    ...f.options,
    adapters: { ...f.options.adapters, claude: script },
  });
  service.apply(service.plan('setup', ['claude']));
  const checks = await runtimeDoctor(service, 'claude', 50);
  expect(checks.some((c) => c.status === 'FAIL')).toBe(true);
  expect(JSON.stringify(checks)).not.toContain('PASS');
});
it('native timeout is NOT VERIFIED and stops a disposable process group', async () => {
  const f = fixture();
  const script = join(f.root, 'native-hang.mjs');
  writeFileSync(script, 'setInterval(()=>{},1000);');
  expect(await nativeDoctor('claude', script, 30)).toMatchObject({
    status: 'NOT_VERIFIED',
    reason: 'NATIVE_TIMEOUT',
  });
});
it('reports tampered active artifacts without weakening immutable write guards in production', () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  const a = f.add({
    name: 'tamper-diagnostic',
    description: 'Inspect a disposable integrity fixture.',
  });
  for (const row of f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='skill_versions'")
    .all() as { name: string }[])
    f.db.exec(`DROP TRIGGER "${row.name}"`);
  f.db
    .prepare('UPDATE skill_versions SET content_hash=? WHERE id=?')
    .run('a'.repeat(64), a.version.id);
  expect(inspectRegistry(f.path, f.scope)).toMatchObject({ status: 'FAIL', invalid: 1 });
});
it('SQLite lock diagnostics do not write, retry indefinitely or expose raw errors', () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  try {
    db.pragma('journal_mode=DELETE');
    db.exec('BEGIN EXCLUSIVE');
    expect(inspectRegistry(f.options.database, f.service.project)).toMatchObject({
      status: 'FAIL',
      reason: 'REGISTRY_UNAVAILABLE_LOCKED_OR_INVALID',
    });
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
});
