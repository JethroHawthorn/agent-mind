import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const server = resolve('packages/mcp-server/dist/index.js'),
  cli = resolve('packages/mcp-server/dist/learning.js');
const report = {
  schema_version: 1,
  type: 'PROBLEM_SOLVED',
  title: 'Clamp preserves lower bound',
  summary:
    'Clamp ignored negative inputs below the configured minimum. Apply both lower and upper bounds before returning the numeric result.',
  reusability: 'potentially_reusable',
  task_ref: 'clamp-fixture',
};
async function connect(
  f: ReturnType<typeof skillFixture>,
  source = 'codex',
  root = f.root,
  disabled = false,
) {
  const c = new Client({ name: `simulated-${source}`, version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        server,
        '--project-root',
        root,
        '--db',
        f.path,
        '--source-agent',
        source,
        '--enable-learning',
        ...(disabled ? ['--disable-learning-capture'] : []),
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
it('E2E A: reports a reproducible resolved bug, links the existing experience and survives cross-client restart', async () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const c = await connect(f);
  const buggy = (value: number, _min: number, max: number) => Math.min(max, value);
  const fixed = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  expect(buggy(-5, 0, 10)).toBe(-5);
  expect(fixed(-5, 0, 10)).toBe(0);
  expect(fixed(15, 0, 10)).toBe(10);
  const e = await call(c, 'experience_record', {
    problem: 'Clamp ignores the lower numeric bound',
    solution: 'Apply Math.max(min, Math.min(max, value))',
    outcome: {
      status: 'succeeded',
      summary:
        'Agent reports the two fixture bounds passed; broader task success is not independently verified.',
    },
    evidence: [
      {
        kind: 'test',
        reference: 'controlled-clamp-fixture',
        summary: 'Two bounded fixture assertions in the offline E2E test.',
      },
    ],
  });
  const signal = await call(c, 'learning_signal_record', {
    ...report,
    experience_ids: [e.experience.id],
  });
  expect(signal.experience_ids).toContain(e.experience.id);
  await c.close();
  const other = await connect(f, 'claude');
  const saved = await call(other, 'learning_signal_get', { signal_id: signal.id });
  expect(saved.origin.source_agent).toBe('codex');
  expect(saved.triage.evidence_trust).toBe('AGENT_REPORTED');
  expect(saved.status).toBe('open');
  const foreign = await connect(f, 'codex', f.otherScope.root);
  expect(
    (await foreign.callTool({ name: 'learning_signal_get', arguments: { signal_id: signal.id } }))
      .isError,
  ).toBe(true);
});
it('E2E B: correction/supplement to an active skill yields advisory investigation with artifact intact', async () => {
  const f = distributionFixture(true, 'sqlite-startup');
  cleanup.push(f.close);
  const before = f.db.prepare('SELECT * FROM skill_versions').all();
  const pointer = f.db.prepare('SELECT active_version_id FROM skills').get();
  const c = await connect(f);
  const signal = await call(c, 'learning_signal_record', {
    ...report,
    type: 'USER_CORRECTION',
    title: 'SQLite startup retry correction',
    summary:
      'The reported retry procedure omits the final exhaustion condition. An operator should inspect the existing skill and bounded retry tests before changing it.',
    version_ids: [f.candidate.version.id],
  });
  expect(signal.action).toBe('INVESTIGATE');
  expect(signal.evidence_trust).toBe('AGENT_REPORTED');
  const a = await call(c, 'learning_signal_recommend', { signal_id: signal.id });
  const b = await call(c, 'learning_signal_recommend', { signal_id: signal.id });
  expect(a.recommendation_ids).toEqual(b.recommendation_ids);
  expect(f.db.prepare('SELECT * FROM skill_versions').all()).toEqual(before);
  expect(f.db.prepare('SELECT active_version_id FROM skills').get()).toEqual(pointer);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const forbidden of [
    'learning_signal_approve',
    'learning_signal_promote',
    'learning_signal_confirm_correction',
    'learning_signal_install',
  ])
    expect(names).not.toContain(forbidden);
  expect(
    (await c.callTool({ name: 'learning_signal_record', arguments: { ...report, verified: true } }))
      .isError,
  ).toBe(true);
});
it('E2E C: retries and duplicate lessons link existing experience instead of growing signals or skills', async () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const c = await connect(f);
  const args = { ...report, experience_ids: [f.approvedSource.id] };
  const a = await call(c, 'learning_signal_record', args);
  const b = await call(c, 'learning_signal_record', args);
  expect(b.id).toBe(a.id);
  expect(b.duplicate).toBe(true);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_signals').get()).toEqual({ n: 1 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 1 });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
});
it('concurrent CLI capture deduplicates atomically and defaults correction attestation to noninteractive denial', async () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const run = () =>
    new Promise<{ status: number | null; error: string }>((done, reject) => {
      const p = spawn(
        process.execPath,
        [cli, '--project-root', f.root, '--db', f.path, '--source-agent', 'codex', '--record'],
        { cwd: f.root },
      );
      let error = '';
      p.stdout.resume();
      p.stderr.on('data', (b) => (error += b));
      p.on('error', reject);
      p.on('close', (status) => done({ status, error }));
      p.stdin.end(JSON.stringify({ ...report, type: 'USER_CORRECTION' }));
    });
  const results = await Promise.all([run(), run()]);
  expect(results.every((r) => r.status === 0)).toBe(true);
  const row = f.db.prepare('SELECT id FROM learning_signals').get() as { id: string };
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM learning_signals').get()).toEqual({ n: 1 });
  const confirmation = spawnSync(
    process.execPath,
    [
      cli,
      '--project-root',
      f.root,
      '--db',
      f.path,
      '--confirm-correction',
      row.id,
      '--expected-revision',
      '0',
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
  expect(confirmation.status).toBe(1);
  expect(confirmation.stderr).toContain('INTERACTIVE_OPERATOR_REQUIRED');
});
it('disabled learning mode and unsupported native hook payloads never record observations', async () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const c = await connect(f, 'codex', f.root, true);
  expect(await call(c, 'learning_signal_record', report)).toMatchObject({
    stored: false,
    disabled: true,
  });
  expect(await call(c, 'learning_signal_detect', {})).toMatchObject({ stored: 0, disabled: true });
  expect(
    (
      await c.callTool({
        name: 'learning_signal_record',
        arguments: { hook_event_name: 'Stop', last_assistant_message: 'Task done', verified: true },
      })
    ).isError,
  ).toBe(true);
  const result = spawnSync(process.execPath, [cli, '--capabilities'], { encoding: 'utf8' });
  expect(JSON.parse(result.stdout).codex.native_learning_hook).toBe(false);
});
