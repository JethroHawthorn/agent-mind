import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { BrokerService, validateBrokerConfig } from '../../packages/core/src/index.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture() {
  const f = retrievalFixture();
  cleanup.push(f.close);
  return f;
}
async function connect(f: ReturnType<typeof fixture>, root = f.root) {
  const c = new Client({ name: 'offline-retrieval-SDK-client', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('packages/mcp-server/dist/index.js'),
        '--project-root',
        root,
        '--db',
        f.path,
        '--enable-retrieval',
      ],
      cwd: root,
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError).not.toBe(true);
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
}
const draft = {
  name: 'retry-sqlite',
  description: 'Retry SQLite startup busy errors with bounded backoff.',
};
it('offline A/E: discovers compact metadata, explicitly loads exact main content and just one resource through real MCP', async () => {
  const f = fixture();
  const a = f.add({
    ...draft,
    resources: [{ path: 'references/note.md', content: 'Inspect bounded startup retries.' }],
  });
  const c = await connect(f);
  const r = await call(c, 'skill_discover', { query: 'retry sqlite' });
  expect(r.skills[0].active_version_id).toBe(a.version.id);
  expect(JSON.stringify(r)).not.toContain('# Procedure');
  const selected = r.skills[0];
  const pin = {
    skill_id: selected.skill_id,
    expected_version_id: selected.active_version_id,
    expected_digest: selected.content_digest,
  };
  const main = await call(c, 'skill_load', pin);
  expect(main.content).toBe(a.version.files[0]?.content);
  expect(main.complete).toBe(true);
  expect(main.content).not.toContain('Inspect bounded startup retries.');
  const manifest = await call(c, 'skill_resources', pin);
  expect(manifest.resources).toHaveLength(1);
  const resource = await call(c, 'skill_resource_get', { ...pin, path: 'references/note.md' });
  expect(resource.content).toBe('Inspect bounded startup retries.');
  expect(resource.version_id).toBe(main.version_id);
  expect(f.db.prepare('SELECT COUNT(*) n FROM skill_usage_events').get()).toEqual({ n: 0 });
});
it('offline B: returns an ambiguous shortlist without selecting, merging or rewriting', async () => {
  const f = fixture();
  const a = f.add(draft);
  f.add({
    name: 'sqlite-query-plan',
    description: 'Inspect SQLite query planning and explain slow statements.',
  });
  const c = await connect(f);
  const r = await call(c, 'skill_discover', { query: 'sqlite' });
  expect(r.skills).toHaveLength(2);
  expect(r.ambiguity).toBe('MULTIPLE_LEXICAL_MATCHES');
  expect(r.selection_required).toBe(true);
  expect(f.store.getVersion(a.version.id).state.status).toBe('approved');
  expect(f.db.prepare('SELECT COUNT(*) n FROM skill_installations').get()).toEqual({ n: 0 });
});
it('offline C: denies private foreign skills uniformly without candidate or historical leakage', async () => {
  const f = fixture();
  const a = f.add({ ...draft, scope: f.otherScope });
  const c = await connect(f);
  expect((await call(c, 'skill_discover', { query: 'retry sqlite' })).skills).toEqual([]);
  const denied = await c.callTool({ name: 'skill_load', arguments: { skill_id: a.identity.id } });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).not.toContain(a.version.content_hash);
  const tools = (await c.listTools()).tools;
  for (const tool of ['skill_discover', 'skill_load', 'skill_resources', 'skill_resource_get'])
    expect(tools.find((t) => t.name === tool)?.annotations?.readOnlyHint).toBe(true);
  for (const tool of ['skill_approve', 'skill_promote', 'distribution_sync'])
    expect(tools.some((t) => t.name === tool)).toBe(false);
});
it('offline D: a separate MCP process refuses stale version/digest after promotion and rollback', async () => {
  const f = fixture();
  const a = f.add(draft),
    c = await connect(f);
  const r = await call(c, 'skill_discover', { query: 'retry sqlite' });
  const pin = {
    skill_id: a.identity.id,
    expected_version_id: r.skills[0].active_version_id,
    expected_digest: r.skills[0].content_digest,
  };
  // Existing reviewed static upgrade policy requires an explicit fixture activation gap.
  f.transition(a.identity.id, null, 'deactivate');
  const b = f.add({
    ...draft,
    body: 'Inspect the revised retry checkpoint and preserve unknown outcomes.',
  });
  expect((await c.callTool({ name: 'skill_load', arguments: pin })).isError).toBe(true);
  expect((await call(c, 'skill_load', { skill_id: a.identity.id })).version_id).toBe(b.version.id);
  const transition = f.transition(a.identity.id, a.version.id, 'rollback');
  f.audit(a.version.id, transition, 'rollback');
  expect((await call(c, 'skill_load', pin)).version_id).toBe(a.version.id);
  expect(
    (
      await c.callTool({
        name: 'skill_load',
        arguments: { ...pin, expected_version_id: b.version.id },
      })
    ).isError,
  ).toBe(true);
});
it('offline F: unrelated registry growth does not inflate discovery context or write lifecycle state', async () => {
  const f = fixture();
  for (let i = 0; i < 35; i++)
    f.add({
      name: `bounded-case-${i}`,
      description: 'Inspect bounded retry cases with explicit task acceptance.',
    });
  const c = await connect(f);
  const r = await call(c, 'skill_discover', { query: 'bounded', limit: 3 });
  expect(r.skills).toHaveLength(3);
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(8192);
  expect(r.diagnostics.telemetry_recorded).toBe(false);
});
it('CLI exposes read-only initialization/discovery/loading/resource inspection and rejects authority flags', () => {
  const f = fixture();
  const a = f.add({
    ...draft,
    resources: [{ path: 'references/note.md', content: 'Bounded note.' }],
  });
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/skill-retrieve.js'),
        '--project-root',
        f.root,
        '--db',
        f.path,
        ...args,
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 10000 },
    );
  const r = run(['--discover', 'retry sqlite', '--limit', '1', '--json']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).skills[0].skill_id).toBe(a.identity.id);
  expect(
    run([
      '--load',
      a.identity.id,
      '--version',
      a.version.id,
      '--digest',
      a.version.content_hash,
      '--json',
    ]).status,
  ).toBe(0);
  expect(run(['--resource', a.identity.id, '--path', 'references/note.md']).status).toBe(0);
  expect(run(['--initialize']).status).toBe(0);
  for (const args of [
    ['--approve', a.version.id],
    ['--force'],
    ['--load', a.identity.id, '--path', '/etc/passwd'],
    ['--discover', 'retry', '--client-config', '/nonexistent', '--project', 'a'],
  ])
    expect(run(args).status).toBe(1);
});
it('broker dispatch binds retrieval scope to authenticated principal (synthetic peer fixtures)', () => {
  const f = fixture();
  const a = f.add(draft);
  f.add({ ...draft, scope: f.otherScope });
  const b = new BrokerService(
    f.db,
    validateBrokerConfig({
      schema_version: 1,
      broker_uid: 201,
      runtime_root: f.root,
      registry_directory: f.root,
      socket_directory: f.root,
      projects: [{ name: 'test', root: f.root, scope_id: f.scope.id, distribution_home: f.home }],
      agents: [{ uid: 203, project: 'test', source: 'codex' }],
      operators: [{ uid: 202, projects: ['test'] }],
    }),
  );
  const r = b.handle(
    'agent',
    { uid: 203, gid: 20 },
    { schema_version: 1, op: 'skill_discover', input: { query: 'retry sqlite' } },
  ) as { skills: { skill_id: string }[] };
  expect(r.skills.map((x) => x.skill_id)).toEqual([a.identity.id]);
  const routeRequest = {
    schema_version: 1,
    op: 'skill_route',
    input: { context: { summary: 'retry sqlite' } },
  };
  const routed = b.handle('agent', { uid: 203, gid: 20 }, routeRequest) as {
    skills: { skill_id: string }[];
    diagnostics: { cache_hit: boolean };
  };
  expect(routed.skills.map((x) => x.skill_id)).toEqual([a.identity.id]);
  expect(
    (b.handle('agent', { uid: 203, gid: 20 }, routeRequest) as typeof routed).diagnostics.cache_hit,
  ).toBe(true);
  expect(() => b.handle('agent', { uid: 999, gid: 20 }, routeRequest)).toThrow();
  expect(() =>
    b.handle('agent', { uid: 203, gid: 20 }, { ...routeRequest, project: 'foreign' }),
  ).toThrow();

  expect(() =>
    b.handle(
      'agent',
      { uid: 203, gid: 20 },
      {
        schema_version: 1,
        op: 'skill_load',
        input: { skill_id: a.identity.id, project_id: f.otherScope.id },
      },
    ),
  ).toThrow();
  expect(() =>
    b.handle(
      'agent',
      { uid: 203, gid: 20 },
      { schema_version: 1, op: 'distribution_sync', input: { skill_id: a.identity.id } },
    ),
  ).toThrow();
});
it('P3-008 A/B/C/D/G: routes compactly over actual MCP, caches computations and loads only explicitly selected resources', async () => {
  const f = fixture();
  const a = f.add({
    ...draft,
    resources: [{ path: 'references/note.md', content: 'SELECTIVE_REFERENCE_ONLY' }],
  });
  const c = await connect(f);
  const request = { context: { summary: 'retry sqlite', languages: ['typescript'] }, limit: 5 };
  const first = await call(c, 'skill_route', request),
    second = await call(c, 'skill_route', request);
  expect(first.skills[0].skill_id).toBe(a.identity.id);
  expect(first.diagnostics.cache_hit).toBe(false);
  expect(second.diagnostics.cache_hit).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(second)).not.toContain('SELECTIVE_REFERENCE_ONLY');
  expect(JSON.stringify(second)).not.toContain('# Procedure');
  expect(
    (await c.listTools()).tools.find((t) => t.name === 'skill_route')?.annotations?.readOnlyHint,
  ).toBe(true);
  const pin = {
    skill_id: a.identity.id,
    expected_version_id: a.version.id,
    expected_digest: a.version.content_hash,
  };
  expect((await call(c, 'skill_load', pin)).version_id).toBe(a.version.id);
  expect(
    (await call(c, 'skill_resource_get', { ...pin, path: 'references/note.md' })).content,
  ).toBe('SELECTIVE_REFERENCE_ONLY');
  expect(
    (await call(c, 'skill_route', { context: { summary: 'astronomy telescope optics' } })).outcome,
  ).toBe('NO_MATCH');
  f.add({ name: 'sqlite-reconnect', description: draft.description });
  expect((await call(c, 'skill_route', { context: { summary: 'sqlite' } })).outcome).toBe(
    'SHORTLIST',
  );
  expect(f.db.prepare('SELECT COUNT(*) n FROM skill_usage_events').get()).toEqual({ n: 0 });
});
it('P3-008 E/F: a warm MCP cache detects promotion and rollback by another process connection', async () => {
  const f = fixture(),
    a = f.add(draft),
    c = await connect(f);
  const request = { context: { summary: 'retry sqlite' } };
  await call(c, 'skill_route', request);
  expect((await call(c, 'skill_route', request)).diagnostics.cache_hit).toBe(true);
  f.transition(a.identity.id, null, 'deactivate');
  const b = f.add({
    ...draft,
    description: 'Retry SQLite startup busy errors with bounded recovery checks.',
  });
  const updated = await call(c, 'skill_route', request);
  expect(updated.diagnostics.cache_hit).toBe(false);
  expect(updated.skills[0].active_version_id).toBe(b.version.id);
  const oldPin = {
    skill_id: a.identity.id,
    expected_version_id: a.version.id,
    expected_digest: a.version.content_hash,
  };
  expect((await c.callTool({ name: 'skill_load', arguments: oldPin })).isError).toBe(true);
  const transition = f.transition(a.identity.id, a.version.id, 'rollback');
  f.audit(a.version.id, transition, 'rollback');
  expect((await call(c, 'skill_route', request)).skills[0].active_version_id).toBe(a.version.id);
  const foreign = await connect(f, f.otherScope.root);
  expect((await call(foreign, 'skill_route', request)).skills).toEqual([]);
  expect(
    (
      await c.callTool({
        name: 'skill_route',
        arguments: { ...request, project_id: f.otherScope.id },
      })
    ).isError,
  ).toBe(true);
});
it('P3-008 CLI accepts bounded route JSON on stdin and refuses override flags and oversized input', () => {
  const f = fixture(),
    a = f.add(draft);
  const run = (text: string, args: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/skill-retrieve.js'),
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--route',
        '--json',
        ...args,
      ],
      { cwd: f.root, input: text, encoding: 'utf8', timeout: 10000 },
    );
  const r = run(JSON.stringify({ context: { summary: 'retry sqlite' } }));
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).skills[0].skill_id).toBe(a.identity.id);
  expect(run('x'.repeat(2049)).status).toBe(1);
  expect(run('{}', ['--force']).status).toBe(1);
  expect(
    run(JSON.stringify({ context: { summary: 'retry' }, project_id: f.otherScope.id })).status,
  ).toBe(1);
});
