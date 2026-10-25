import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const entry = resolve('packages/mcp-server/dist/index.js');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmind-integration-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  return { dir, a, b, db: join(dir, 'shared.db') };
}
async function connect(project: string, db: string, agent = 'unknown', projectKey?: string) {
  const client = new Client({ name: 'independent-test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      entry,
      '--project-root',
      project,
      '--db',
      db,
      '--source-agent',
      agent,
      ...(projectKey === undefined ? [] : ['--project-key', projectKey]),
    ],
    cwd: project,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, transport, logs: () => stderr };
}
function resultData(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (first?.type !== 'text') throw new Error('Expected MCP text result');
  return JSON.parse(first.text);
}

describe('real stdio MCP processes', () => {
  it('shares across roots only with an operator-configured project key', async () => {
    const { a, b, db } = fixture();
    const first = await connect(a, db, 'codex', 'trusted-project-key-123');
    const second = await connect(b, db, 'claude', 'trusted-project-key-123');
    const saved = resultData(
      await first.client.callTool({
        name: 'memory_save',
        arguments: {
          title: 'Shared worktree decision',
          content: 'Magnolia shared memory',
        },
      }),
    ).memory;
    expect(
      resultData(
        await second.client.callTool({ name: 'memory_search', arguments: { query: 'Magnolia' } }),
      ).memories,
    ).toEqual([saved]);
    const isolated = await connect(b, db);
    expect(
      resultData(
        await isolated.client.callTool({ name: 'memory_search', arguments: { query: 'Magnolia' } }),
      ).memories,
    ).toEqual([]);
    expect(
      (
        await isolated.client.callTool({
          name: 'memory_search',
          arguments: { query: 'Magnolia', project_key: 'trusted-project-key-123' },
        })
      ).isError,
    ).toBe(true);
  });
  it.each(['stalled', 'open-handle'])('forces bounded shutdown with %s cleanup', (mode) => {
    const { db } = fixture();
    const child = spawnSync(process.execPath, [resolve('tests/fixtures/shutdown.mjs'), mode, db], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.signal).toBeNull();
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('SHUTDOWN_TIMEOUT');
    expect(child.stderr).toContain('database closed');
  });
  it('shares persisted memory across separate client OS processes', () => {
    const { a, b, db } = fixture();
    const call = (project: string, agent: string, tool: string, args: object) => {
      const child = spawnSync(
        process.execPath,
        [resolve('scripts/mcp-call.mjs'), project, db, agent, tool, JSON.stringify(args)],
        {
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      return { pid: child.pid, data: JSON.parse(child.stdout) };
    };
    const saved = call(a, 'codex', 'memory_save', {
      title: 'Independent clients',
      content: 'Dahlia memory survives client termination',
    });
    const found = call(a, 'claude', 'memory_search', { query: 'Dahlia' });
    expect(saved.pid).not.toBe(found.pid);
    expect(found.data.memories).toEqual([saved.data.memory]);
    expect(call(b, 'unknown', 'memory_search', { query: 'Dahlia' }).data.memories).toEqual([]);
  });
  it('saves, terminates the server, and retrieves from an independent client/server', async () => {
    const { a, db } = fixture();
    const first = await connect(a, db, 'codex');
    expect((await first.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'experience_record',
      'experience_search',
      'memory_save',
      'memory_search',
      'skill_diff',
      'skill_evaluation',
      'skill_get',
      'skill_list',
      'skill_pending',
      'skill_propose',
      'skill_review',
      'skill_search',
      'skill_usage_query',
      'skill_usage_record',
      'skill_usage_summary',
      'skill_validate',
    ]);
    await first.client.ping();
    const saved = resultData(
      await first.client.callTool({
        name: 'memory_save',
        arguments: {
          title: 'Phase zero decision',
          content: 'Orchid uses SQLite WAL for shared memory.',
          kind: 'decision',
        },
      }),
    ).memory;
    const firstPid = first.transport.pid;
    if (firstPid === null) throw new Error('Expected server process PID');
    await first.client.close();
    expect(() => process.kill(firstPid, 0)).toThrow();
    const second = await connect(a, db, 'claude');
    expect(second.transport.pid).not.toBe(firstPid);
    const found = resultData(
      await second.client.callTool({ name: 'memory_search', arguments: { query: 'Orchid WAL' } }),
    );
    expect(found.memories).toEqual([saved]);
    expect(found.memories[0].source_agent).toBe('codex');
    expect(first.logs()).toContain('ready');
  });
  it('isolates simultaneous projects sharing the same database and refuses forged scopes', async () => {
    const { a, b, db } = fixture();
    const [first, second] = await Promise.all([connect(a, db), connect(b, db)]);
    await first.client.callTool({
      name: 'memory_save',
      arguments: { title: 'Private', content: 'Marigold project decision' },
    });
    expect(
      resultData(
        await second.client.callTool({ name: 'memory_search', arguments: { query: 'Marigold' } }),
      ).memories,
    ).toEqual([]);
    for (const extra of [{ project_id: 'forged' }, { scope: 'global' }, { project_root: a }]) {
      const result = await second.client.callTool({
        name: 'memory_search',
        arguments: { query: 'Marigold', ...extra },
      });
      expect(result.isError).toBe(true);
    }
    const rejectedSave = await second.client.callTool({
      name: 'memory_save',
      arguments: { title: 'x', content: 'y', project_id: 'forged' },
    });
    expect(rejectedSave.isError).toBe(true);
    // Failed requests do not break later requests.
    await second.client.ping();
  });
  it('returns bounded safe tool errors, rejects secrets and preserves the session', async () => {
    const { a, db } = fixture();
    const { client, logs } = await connect(a, db);
    const secret = 'password=should-never-be-stored';
    const rejected = await client.callTool({
      name: 'memory_save',
      arguments: { title: 'No secrets', content: secret },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(secret);
    expect(logs()).not.toContain(secret);
    expect(
      (await client.callTool({ name: 'memory_search', arguments: { query: '', limit: 0 } }))
        .isError,
    ).toBe(true);
    expect((await client.callTool({ name: 'missing_tool', arguments: {} })).isError).toBe(true);
    expect(
      resultData(await client.callTool({ name: 'memory_search', arguments: { query: 'stored' } }))
        .memories,
    ).toEqual([]);
    await client.ping();
  });
  it('runs health checks on stderr, and startup failures leave stdout empty', () => {
    const { a, b, db } = fixture();
    const healthy = spawnSync(
      process.execPath,
      [entry, '--project-root', a, '--db', db, '--health'],
      { cwd: a, encoding: 'utf8' },
    );
    expect(healthy.status).toBe(0);
    expect(healthy.stdout).toBe('');
    expect(JSON.parse(healthy.stderr).ok).toBe(true);
    for (const args of [
      [],
      ['--project-root', a],
      ['--project-root', b, '--db', a],
      ['--project-root', b, '--db', 'relative.db'],
    ]) {
      const failed = spawnSync(process.execPath, [entry, ...args], { cwd: b, encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe('');
      expect(failed.stderr).toMatch(/INVALID_CONFIG|PROJECT_SCOPE_DENIED|DATABASE_UNAVAILABLE/);
    }
  });
  it.each(['SIGINT', 'SIGTERM', 'EOF'] as const)('closes gracefully on %s', async (signal) => {
    const { a, db } = fixture();
    const child = spawn(process.execPath, [entry, '--project-root', a, '--db', db], {
      cwd: a,
      stdio: 'pipe',
    });
    cleanup.push(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    const exited = once(child, 'exit');
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.stderr.on('data', (data: Buffer) => {
        if (data.toString().includes('ready')) done();
      });
      child.once('exit', () => reject(new Error('Exited before ready')));
    });
    if (signal === 'EOF') child.stdin.end();
    else child.kill(signal);
    const [code, exitSignal] = await exited;
    expect(code).toBe(0);
    expect(exitSignal).toBeNull();
    expect(stdout).toBe('');
  });
});
