import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { authoringFixture } from '../helpers/authoring-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function connect(f: ReturnType<typeof authoringFixture>, root = f.root) {
  const c = new Client({ name: 'offline-authoring-client', version: '1' });
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
        '--source-agent',
        'codex',
        '--enable-authoring',
      ],
      cwd: root,
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c: Client, name: string, input: unknown) {
  const r = await c.callTool({ name, arguments: input as Record<string, unknown> });
  expect(r.isError).not.toBe(true);
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
}
it('E2E A: turns an offline reusable lesson into a valid CREATE_NEW candidate with provenance and no activation', async () => {
  const f = authoringFixture();
  cleanup.push(f.close);
  const buggy = (vertices: Array<number | null>) => vertices.filter(Boolean);
  const fixed = (vertices: Array<number | null>) => vertices.filter((v) => v !== null);
  expect(buggy([0, 1, null])).toEqual([1]);
  expect(fixed([0, 1, null])).toEqual([0, 1]);
  const c = await connect(f);
  const ctx = await call(c, 'skill_authoring_context', f.contextRequest);
  const candidate = await call(
    c,
    'skill_authoring_submit',
    f.draft({ context_id: ctx.id, context_digest: ctx.context_digest }),
  );
  expect(candidate.type).toBe('CREATE_NEW');
  expect(candidate.candidate_state).toBe('candidate');
  expect(candidate.provenance.signal_ids).toContain(f.signal.id);
  expect(f.store.getIdentity(candidate.skill_id).active_version_id).toBeNull();
  const report = await call(c, 'skill_authoring_evaluate', {
    proposal_id: candidate.proposal_id,
    expected_content_hash: candidate.content_digest,
    expected_state_revision: 0,
  });
  expect(report.evaluation.result).toBe('PASS');
  expect(report.capabilities.execution_supported).toBe(false);
});
it('E2E B: patches an active skill through real MCP with an exact diff and unchanged original artifact', async () => {
  const f = authoringFixture(true);
  cleanup.push(f.close);
  const c = await connect(f);
  const before = f.store.getVersion(f.base);
  const p = f.patch();
  const r = await call(c, 'skill_authoring_submit', p);
  const diff = await call(c, 'skill_authoring_diff', {
    proposal_id: r.proposal_id,
    path: 'SKILL.md',
  });
  expect(diff.after.content).toContain('Check bounded retry exhaustion');
  expect(diff.before.content).not.toContain('Check bounded retry exhaustion');
  expect(f.store.getVersion(f.base)).toEqual(before);
  expect(f.store.getIdentity(before.version.skill_id).active_version_id).toBe(f.base);
});
it('E2E C: refuses a stale patch after the active registry pointer changes', async () => {
  const f = authoringFixture(true);
  cleanup.push(f.close);
  const c = await connect(f);
  const p = f.patch();
  const target = f.store.getVersion(f.base).version.skill_id;
  f.transition(target, null, 'deactivate');
  const r = await c.callTool({ name: 'skill_authoring_submit', arguments: p });
  expect(r.isError).toBe(true);
  expect(f.store.getIdentity(target).active_version_id).toBeNull();
  expect(f.service.list().proposals).toEqual([]);
});
it('E2E D: rejects malicious paths, foreign context and privileged flags without any registry writes', async () => {
  const f = authoringFixture(true);
  cleanup.push(f.close);
  const c = await connect(f);
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get();
  const p = f.patch();
  const bad = await c.callTool({
    name: 'skill_authoring_submit',
    arguments: { ...p, operations: [{ op: 'add', path: '../../escape', content: 'bad' }] },
  });
  expect(bad.isError).toBe(true);
  const foreign = await connect(f, f.otherScope.root);
  expect((await foreign.callTool({ name: 'skill_authoring_submit', arguments: p })).isError).toBe(
    true,
  );
  expect(
    (await c.callTool({ name: 'skill_authoring_submit', arguments: { ...p, approved: true } }))
      .isError,
  ).toBe(true);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  for (const name of [
    'skill_authoring_approve',
    'skill_authoring_promote',
    'skill_authoring_install',
  ])
    expect(tools).not.toContain(name);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get()).toEqual(before);
});
it('concurrent subprocess retries return exactly one immutable candidate and one tracked proposal', async () => {
  const f = authoringFixture();
  cleanup.push(f.close);
  const request = f.draft({ request_id: randomUUID() });
  const cli = resolve('packages/mcp-server/dist/authoring.js');
  const run = () =>
    new Promise<{ status: number | null; data: string; error: string }>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          cli,
          '--project-root',
          f.root,
          '--db',
          f.path,
          '--source-agent',
          'codex',
          '--session',
          'test-session',
          '--submit',
        ],
        { cwd: f.root },
      );
      let data = '',
        error = '';
      p.stdout.on('data', (b) => (data += b));
      p.stderr.on('data', (b) => (error += b));
      p.on('error', reject);
      p.on('close', (status) => done({ status, data, error }));
      p.stdin.end(JSON.stringify(request));
    });
  const results = await Promise.all([run(), run()]);
  for (const r of results) expect(r.status, r.error).toBe(0);
  expect(JSON.parse(results[0]?.data ?? '{}').candidate_version_id).toBe(
    JSON.parse(results[1]?.data ?? '{}').candidate_version_id,
  );
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_versions').get()).toEqual({ n: 1 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM authoring_proposals').get()).toEqual({ n: 1 });
});
