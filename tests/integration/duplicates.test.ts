import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { files, retry } from '../helpers/duplicate-fixtures.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  const versions = ['left-skill', 'right-skill'].map((n) => {
    const id = f.identity(n),
      v = f.version(id, undefined, undefined, files(retry, n));
    f.evaluation(v);
    f.review(v);
    return v;
  });
  return { ...f, versions };
}
const cli = resolve('packages/mcp-server/dist/curator.js');
it('runs duplicate CLI analysis and read-only exact comparison across separate processes', () => {
  const f = fixture();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, '--project-root', f.root, '--db', f.path, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      cwd: f.root,
    });
  const a = run(['--duplicates']);
  expect(a.status, a.stderr).toBe(0);
  expect(JSON.parse(a.stdout).recommendation_count).toBe(1);
  const c = run(['--compare', f.versions[0] ?? '', '--against', f.versions[1] ?? '']);
  expect(c.status, c.stderr).toBe(0);
  expect(JSON.parse(c.stdout).comparisons[0].classification).toBe('NEAR_DUPLICATE');
  expect(run(['--duplicates', '--promote']).status).toBe(1);
  expect(f.db.prepare('SELECT active_version_id FROM skills').all()).toEqual([
    { active_version_id: null },
    { active_version_id: null },
  ]);
});
it('real stdio MCP exposes advisory analysis and comparison with scope validation', async () => {
  const f = fixture();
  const c = new Client({ name: 'duplicate-advisory-test', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('packages/mcp-server/dist/index.js'),
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--enable-curator',
      ],
      stderr: 'pipe',
      cwd: f.root,
    }),
  );
  expect((await c.listTools()).tools.map((t) => t.name)).toContain('curator_compare');
  const result = await c.callTool({ name: 'curator_duplicates', arguments: {} });
  expect(result.isError).not.toBe(true);
  const compare = await c.callTool({
    name: 'curator_compare',
    arguments: { left_version_id: f.versions[0], right_version_id: f.versions[1] },
  });
  expect(compare.isError).not.toBe(true);
  expect(
    (
      await c.callTool({
        name: 'curator_duplicates',
        arguments: { project_id: f.otherScope.id, action: 'approve' },
      })
    ).isError,
  ).toBe(true);
  expect(
    (await c.listTools()).tools.some((t) => /curator_(approve|install|merge|delete)/.test(t.name)),
  ).toBe(false);
});
it('concurrent duplicate analysis remains transactional and idempotent', async () => {
  const f = fixture();
  const run = () =>
    new Promise<{ status: number | null; error: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [cli, '--project-root', f.root, '--db', f.path, '--duplicates'],
        { cwd: f.root },
      );
      let error = '';
      child.stdout.resume();
      child.stderr.on('data', (b) => (error += b));
      child.on('error', reject);
      child.on('close', (status) => done({ status, error }));
    });
  const results = await Promise.all([run(), run()]);
  expect(results.some((r) => r.status === 0)).toBe(true);
  for (const r of results)
    if (r.status !== 0) expect(r.error).toMatch(/CURATOR_ANALYSIS_STALE|CURATOR_STORAGE_FAILED/);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM curator_recommendations').get()).toEqual({ n: 1 });
});
