import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { SkillUsageService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const usage = new SkillUsageService(f.db, f.scope, 'codex');
  for (const task of ['one', 'two'])
    usage.record({
      schema_version: 1,
      event_id: randomUUID(),
      version_id: f.candidate.version.id,
      artifact_digest: f.candidate.version.content_hash,
      event_type: 'task_failed',
      task_id: task,
    });
  return f;
}
const cli = resolve('packages/mcp-server/dist/curator.js');
it('persists advisory metadata across CLI processes and supports scoped read, explain and dismissal', () => {
  const f = fixture();
  const run = (args: string[], root = f.root) =>
    spawnSync(process.execPath, [cli, '--project-root', root, '--db', f.path, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 6000,
    });
  const a = run(['--analyze']);
  expect(a.status, a.stderr).toBe(0);
  const summary = JSON.parse(a.stdout);
  expect(summary.advisory_only).toBe(true);
  const list = run(['--recommendations']);
  expect(list.status).toBe(0);
  const id = JSON.parse(list.stdout).recommendations[0].id;
  const shown = run(['--explain', id]);
  expect(shown.status).toBe(0);
  const r = JSON.parse(shown.stdout);
  expect(r.evidence.length).toBeGreaterThan(0);
  expect(run(['--show', id], f.otherScope.root).status).toBe(1);
  const dismissed = run(['--dismiss', id, '--expected-revision', String(r.revision)]);
  expect(dismissed.status).toBe(0);
  expect(JSON.parse(dismissed.stdout).state).toBe('dismissed');
  for (const flag of ['--approve', '--promote', '--install', '--force'])
    expect(run([flag, id]).status).toBe(1);
});
it('enables advisory MCP explicitly, scopes reports and introduces no privileged tools', async () => {
  const f = fixture();
  const connect = async (root: string) => {
    const client = new Client({ name: 'curator-test-client', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve('packages/mcp-server/dist/index.js'),
          '--project-root',
          root,
          '--db',
          f.path,
          '--enable-curator',
        ],
        cwd: root,
        stderr: 'pipe',
      }),
    );
    return client;
  };
  const client = await connect(f.root);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['curator_analyze', 'curator_recommendations', 'curator_recommendation_get'])
    expect(names).toContain(name);
  for (const name of [
    'skill_approve',
    'skill_promote',
    'skill_rollback',
    'skill_install',
    'curator_promote',
  ])
    expect(names).not.toContain(name);
  expect(
    (await client.callTool({ name: 'curator_analyze', arguments: { operation: 'promote' } }))
      .isError,
  ).toBe(true);
  const analyzed = await client.callTool({ name: 'curator_analyze', arguments: {} });
  expect(analyzed.isError).not.toBe(true);
  const text = analyzed.content as Array<{ text: string }>;
  const id = JSON.parse(text[0]?.text ?? '{}').recommendation_ids[0];
  const own = await client.callTool({
    name: 'curator_recommendation_get',
    arguments: { recommendation_id: id },
  });
  expect(own.isError).not.toBe(true);
  const foreign = await connect(f.otherScope.root);
  expect(
    (
      await foreign.callTool({
        name: 'curator_recommendation_get',
        arguments: { recommendation_id: id },
      })
    ).isError,
  ).toBe(true);
  const read = await client.callTool({ name: 'curator_recommendations', arguments: {} });
  expect(read.isError).not.toBe(true);
});
it('serializes concurrent analysis metadata and suppresses duplicate recommendations', async () => {
  const f = fixture();
  const run = () =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const p = spawn(
        process.execPath,
        [cli, '--project-root', f.root, '--db', f.path, '--analyze'],
        { cwd: f.root },
      );
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (b) => (stdout += b));
      p.stderr.on('data', (b) => (stderr += b));
      p.on('error', reject);
      p.on('close', (status) => done({ status, stdout, stderr }));
    });
  const results = await Promise.all([run(), run()]);
  expect(results.some((r) => r.status === 0)).toBe(true);
  for (const r of results)
    if (r.status !== 0) expect(r.stderr).toMatch(/CURATOR_ANALYSIS_STALE|CURATOR_STORAGE_FAILED/);
  const rows = f.db
    .prepare('SELECT fingerprint,COUNT(*) AS n FROM curator_recommendations GROUP BY fingerprint')
    .all() as Array<{ n: number }>;
  expect(rows.every((r) => r.n === 1)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
});
