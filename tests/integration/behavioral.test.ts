import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { listBehavioralSuites } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
const entry = resolve('packages/mcp-server/dist/skill-evaluate.js');
function fixture() {
  const f = distributionFixture();
  cleanup.push(f.close);
  const v2 = f.propose('Changed guidance, still a candidate.');
  const args = [
    '--project-root',
    f.root,
    '--db',
    f.path,
    '--version-id',
    v2.version.id,
    '--expected-content-hash',
    v2.version.content_hash,
    '--expected-state-revision',
    String(v2.state.revision),
    '--mode',
    'behavioral',
  ];
  return { ...f, v2, args };
}
it('records and retrieves exact paired evidence across real evaluator processes without deactivating V1', () => {
  const f = fixture();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], { cwd: f.root, encoding: 'utf8', timeout: 5000 });
  const first = run([
    ...f.args,
    '--suite-id',
    'agentmind.clamp-contract',
    '--suite-version',
    '1',
    '--expected-suite-digest',
    listBehavioralSuites()[0]?.digest ?? '',
  ]);
  expect(first.status, first.stderr).toBe(0);
  const report = JSON.parse(first.stdout);
  expect(report.evaluation.result).toBe('NOT_VERIFIED');
  expect(report.behavioral.execution_verified).toBe(false);
  const read = run(['--project-root', f.root, '--db', f.path, '--report-id', report.evaluation.id]);
  expect(read.status).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(report);
  expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
    f.candidate.version.id,
  );
  const denied = spawnSync(
    process.execPath,
    [
      resolve('packages/mcp-server/dist/skill-operator.js'),
      '--project-root',
      f.root,
      '--db',
      f.path,
      '--approve',
      f.v2.version.id,
    ],
    { cwd: f.root, encoding: 'utf8', timeout: 5000 },
  );
  expect(denied.status).toBe(1);
  expect(
    f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews WHERE version_id=?').get(f.v2.version.id),
  ).toEqual({ n: 0 });
});
it('serializes concurrent evaluations and preserves one active version with immutable history', async () => {
  const f = fixture();
  const run = () =>
    new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
      const p = spawn(process.execPath, [entry, ...f.args], { cwd: f.root });
      let out = '';
      p.stdout.on('data', (b) => (out += b));
      p.stderr.resume();
      p.on('error', reject);
      p.on('close', (status) => resolve({ status, stdout: out }));
    });
  const results = await Promise.all([run(), run()]);
  expect(results.map((r) => r.status).sort()).toEqual([0, 1]);
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM behavioral_evidence WHERE version_id=?')
      .get(f.v2.version.id),
  ).toEqual({ n: 1 });
  expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
    f.candidate.version.id,
  );
});
it('rejects CLI shell/observation injection instead of treating self-reported success as evidence', () => {
  const f = fixture();
  for (const flags of [
    ['--command', 'echo PASS'],
    ['--result', 'PASS'],
    ['--suite-definition', '{}'],
  ]) {
    const r = spawnSync(process.execPath, [entry, ...f.args, ...flags], {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(r.status).toBe(1);
  }
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM skill_evaluations WHERE version_id=?')
      .get(f.v2.version.id),
  ).toEqual({ n: 0 });
});

it('exposes behavioral evidence through the existing scoped stdio MCP review tool', async () => {
  const f = fixture();
  const run = spawnSync(process.execPath, [entry, ...f.args], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(run.status).toBe(0);
  const clients: Client[] = [];
  try {
    for (const root of [f.root, f.otherScope.root]) {
      const client = new Client({ name: 'behavioral-review-test', version: '1' });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            resolve('packages/mcp-server/dist/index.js'),
            '--project-root',
            root,
            '--db',
            f.path,
          ],
          cwd: root,
          stderr: 'pipe',
        }),
      );
      const result = await client.callTool({
        name: 'skill_evaluation',
        arguments: { version_id: f.v2.version.id },
      });
      if (root === f.root) {
        expect(result.isError).not.toBe(true);
        const blocks = result.content as Array<{ text: string }>;
        expect(JSON.parse(blocks[0]?.text ?? '{}')).toMatchObject({
          evaluation: { result: 'NOT_VERIFIED' },
          behavioral: { execution_verified: false },
        });
      } else expect(result.isError).toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).not.toContain('skill_promote');
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});
