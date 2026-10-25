import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { SkillUsageService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { operatorTTY } from '../helpers/operator-pty.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const f = distributionFixture();
  cleanup.push(f.close);
  return { ...f, usage: new SkillUsageService(f.db, f.scope, 'codex') };
}
function report(f: ReturnType<typeof fixture>, extra: object = {}) {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    version_id: f.candidate.version.id,
    artifact_digest: f.candidate.version.content_hash,
    event_type: 'invoked',
    session_id: 'fixture-session',
    task_id: 'fixture-task',
    ...extra,
  };
}
function call(f: ReturnType<typeof fixture>, agent: string, tool: string, args: object) {
  const r = spawnSync(
    process.execPath,
    [resolve('scripts/mcp-call.mjs'), f.root, f.path, agent, tool, JSON.stringify(args)],
    { encoding: 'utf8', timeout: 10000 },
  );
  return { status: r.status, data: r.stdout ? JSON.parse(r.stdout) : {}, stderr: r.stderr };
}
const cli = resolve('packages/mcp-server/dist/skill-usage.js');
const hook = resolve('packages/mcp-server/dist/skill-usage-hook.js');
function base(f: ReturnType<typeof fixture>) {
  return ['--project-root', f.root, '--db', f.path, '--source-agent', 'codex'];
}
it('records/query/summarizes through separate MCP processes and distinguishes tool retrieval from skill invocation', () => {
  const f = fixture();
  const p = report(f, { event_type: 'task_succeeded' });
  expect(call(f, 'codex', 'skill_usage_record', p)).toMatchObject({
    status: 0,
    data: { stored: true, event: { source_cli: 'codex', verification: 'unverified' } },
  });
  expect(call(f, 'codex', 'skill_usage_record', p)).toMatchObject({
    status: 0,
    data: { duplicate: true },
  });
  expect(call(f, 'claude', 'skill_usage_query', {}).data.events).toHaveLength(1);
  expect(call(f, 'claude', 'skill_usage_summary', {}).data.groups[0]).toMatchObject({
    verified_outcomes: 0,
    success: 1,
    observed_invocations: 0,
  });
  expect(call(f, 'claude', 'skill_get', { version_id: f.candidate.version.id }).status).toBe(0);
  expect(f.usage.query({ source_cli: 'claude' }).events[0]).toMatchObject({
    event_type: 'discovered',
    category: 'mcp_observation',
    verification: 'observed',
  });
  for (const extra of [
    { source_agent: 'claude' },
    { project_id: f.otherScope.id },
    { verification: 'operator_confirmed' },
  ])
    expect(call(f, 'codex', 'skill_usage_record', { ...report(f), ...extra }).status).toBe(1);
  expect(call(f, 'codex', 'skill_usage_confirm', {}).status).toBe(1);
  const other = { ...f, root: f.otherScope.root };
  expect(call(other, 'claude', 'skill_usage_record', report(f)).status).toBe(1);
  expect(call(other, 'claude', 'skill_usage_query', {}).data.events).toEqual([]);
});
it('deduplicates concurrent writes across independent MCP server processes', async () => {
  const f = fixture();
  const p = report(f);
  const send = () =>
    new Promise<{ status: number | null; data: Record<string, unknown> }>((yes, no) => {
      const c = spawn(
        process.execPath,
        [
          resolve('scripts/mcp-call.mjs'),
          f.root,
          f.path,
          'codex',
          'skill_usage_record',
          JSON.stringify(p),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('error', no);
      c.on('close', (status) => {
        try {
          yes({ status, data: JSON.parse(stdout) });
        } catch (e) {
          no(e);
        }
      });
    });
  const replies = await Promise.all([send(), send(), send()]);
  expect(replies.every((r) => r.status === 0)).toBe(true);
  expect(replies.filter((r) => r.data.stored)).toHaveLength(1);
  expect(f.usage.query().events).toHaveLength(1);
});
it('enforces actual opaque grants for operator outcomes independently of CLI and denies pipes', async () => {
  const f = fixture();
  const p = {
    report: report(f, { event_type: 'task_succeeded' }),
    acceptance_criteria: ['The entire harmless acceptance fixture was inspected'],
    coverage: 'complete',
  };
  expect(() => f.usage.confirmOutcome(p, { session: randomUUID() })).toThrow(
    'terminal confirmation',
  );
  const file = join(f.root, 'outcome.json');
  writeFileSync(file, JSON.stringify(p));
  expect(
    spawnSync(process.execPath, [cli, ...base(f), '--confirm-outcome', file], {
      encoding: 'utf8',
      timeout: 5000,
    }).status,
  ).toBe(1);
  const before = f.store.getVersion(f.candidate.version.id);
  const terminal = operatorTTY(f.root, [...base(f), '--confirm-outcome', file], cli);
  expect((await terminal.ready).event).toBe('ready');
  terminal.respond();
  expect((await terminal.exit).status).toBe(0);
  expect(f.usage.query().events[0]).toMatchObject({
    verification: 'operator_confirmed',
    category: 'operator_confirmed',
    event_type: 'task_succeeded',
  });
  expect(f.store.getVersion(f.candidate.version.id)).toEqual(before);
});
it('handles hook success, malformed payloads, oversized input and lock failures without stdout or blocked coding behavior', async () => {
  const f = fixture();
  const install = operatorTTY(
    f.root,
    [
      '--project-root',
      f.root,
      '--db',
      f.path,
      '--home-root',
      f.home,
      '--skill-id',
      f.candidate.identity.id,
      '--target',
      'claude',
      '--scope',
      'project',
      '--sync',
    ],
    resolve('packages/mcp-server/dist/skill-distribute.js'),
  );
  expect((await install.ready).event).toBe('ready');
  install.respond();
  expect((await install.exit).status).toBe(0);
  const { id } = f.db.prepare("SELECT id FROM skill_installations WHERE target='claude'").get() as {
    id: string;
  };
  const args = ['--project-root', f.root, '--db', f.path, '--installation-id', id];
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    cwd: f.root,
    tool_name: 'Skill',
    tool_use_id: 'tool',
    tool_input: { skill: f.candidate.identity.name, args: 'do not persist' },
    transcript_path: '/never/open',
  };
  const run = (input: string, extra: string[] = []) =>
    spawnSync(process.execPath, [hook, ...args, ...extra], {
      cwd: f.root,
      input,
      encoding: 'utf8',
      timeout: 3000,
    });
  const good = run(JSON.stringify(payload));
  expect(good.status).toBe(0);
  expect(good.stdout).toBe('');
  expect(good.stderr).toContain('USAGE_HOOK_STORED');
  const slash = JSON.stringify({
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    session_id: 'slash-session',
    cwd: f.root,
    command_name: f.candidate.identity.name,
    prompt: 'private slash prompt',
    command_args: 'private slash args',
    transcript_path: '/never/open/slash',
  });
  expect(run(slash)).toMatchObject({ status: 0, stdout: '' });
  expect(run(slash).stderr).toContain('USAGE_HOOK_SKIPPED');
  expect(f.usage.summary().groups[0]).toMatchObject({
    direct_slash_sessions: 1,
    observed_invocations: 1,
  });
  expect(JSON.stringify(f.usage.query())).not.toMatch(/private slash|never\/open|slash-session/);

  expect(run('not JSON')).toMatchObject({ status: 0, stdout: '' });
  expect(run('a'.repeat(65537)).stderr).toContain('NOT_STORED');
  expect(run(JSON.stringify({ ...payload, hook_event_name: 'Stop' })).stderr).toContain('SKIPPED');
  const before = f.usage.query().events.length;
  expect(
    run(JSON.stringify({ ...payload, tool_use_id: 'disabled' }), ['--disable-telemetry']).status,
  ).toBe(0);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const locked = run(JSON.stringify({ ...payload, tool_use_id: 'locked' }));
    expect(locked.status).toBe(0);
    expect(locked.stderr).toContain('NOT_STORED');
  } finally {
    f.db.exec('ROLLBACK');
  }
  expect(f.usage.query().events).toHaveLength(before);
  expect(JSON.stringify(f.usage.query())).not.toContain('do not persist');
});
it('exposes read-only CLI reports, capability limitations and no outcome authorization bypass flags', () => {
  const f = fixture();
  f.usage.record(report(f));
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM skill_usage_events').get();
  for (const action of ['--query', '--summary'])
    expect(
      spawnSync(process.execPath, [cli, ...base(f), action], {
        cwd: f.root,
        encoding: 'utf8',
        timeout: 3000,
      }).status,
    ).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_usage_events').get()).toEqual(before);
  const caps = spawnSync(process.execPath, [cli, '--capabilities'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  expect(JSON.parse(caps.stdout).codex.native_skill_invocation).toBe(false);
  for (const flag of ['--yes', '--force'])
    expect(
      spawnSync(process.execPath, [cli, ...base(f), '--prune', '--retention-days', '30', flag], {
        encoding: 'utf8',
        timeout: 3000,
      }).status,
    ).toBe(1);
});
it('disables agent telemetry recording and automatic discovery while keeping historical reads', async () => {
  const f = fixture();
  f.usage.record(report(f));
  const client = new Client({ name: 'usage-test', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      cwd: f.root,
      stderr: 'pipe',
      args: [resolve('packages/mcp-server/dist/index.js'), ...base(f), '--disable-telemetry'],
    }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).not.toContain('skill_usage_record');
  expect(names).toContain('skill_usage_query');
  await client.callTool({ name: 'skill_get', arguments: { version_id: f.candidate.version.id } });
  expect(f.usage.query().events).toHaveLength(1);
});
it('keeps exact skill retrieval functional when best-effort discovery telemetry persistence fails', () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER reject_usage_fixture BEFORE INSERT ON skill_usage_events BEGIN SELECT RAISE(ABORT,'injected storage failure');END;",
  );
  const r = call(f, 'codex', 'skill_get', { version_id: f.candidate.version.id });
  expect(r.status).toBe(0);
  expect(r.data.version.id).toBe(f.candidate.version.id);
  expect(f.usage.query().events).toHaveLength(0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_usage_dedup').get()).toEqual({ n: 0 });
});
it('ends a hook with an incomplete input stream without blocking native activity', async () => {
  const f = fixture();
  const c = spawn(
    process.execPath,
    [hook, '--project-root', f.root, '--db', f.path, '--installation-id', randomUUID()],
    { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  c.stdout.on('data', (d) => (stdout += d));
  c.stderr.on('data', (d) => (stderr += d));
  c.stdin.write('{');
  const status = await new Promise<number | null>((yes, no) => {
    c.on('error', no);
    c.on('close', yes);
  });
  expect(status).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toContain('input timeout');
});
