import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import {
  BrokerService,
  LearningReviewDecisions,
  LearningReviewService,
  localReviewCaller,
  SkillOperatorService,
  validateBrokerConfig,
} from '../../packages/core/src/index.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';
import { reviewPaginationFixture } from '../helpers/review-pagination-fixture.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture(existing = false) {
  const f = authoringFixture(existing);
  cleanup.push(f.close);
  const p = f.service.submit(existing ? f.patch() : f.draft());
  if (!('proposal_id' in p)) throw Error('validation');
  const read = new LearningReviewService(f.db, f.scope);
  const decide = new LearningReviewDecisions(f.db, f.scope, localReviewCaller());
  const input = (decision = 'MARK_REVIEWED') => {
    const s = read.get({ proposal_id: p.proposal_id });
    return {
      proposal_id: p.proposal_id,
      request_id: randomUUID(),
      expected_snapshot_digest: s.snapshot_digest,
      candidate_digest: s.candidate_digest,
      decision,
      reason: 'Explicit disposable review fixture. This is not operator approval.',
    };
  };
  return { ...f, p, read, decide, input };
}
async function client(f: ReturnType<typeof fixture>, root = f.root) {
  const c = new Client({ name: 'offline-review-mcp-client', version: '1' });
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
        '--enable-authoring',
      ],
      cwd: root,
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c: Client, name: string, input: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: input });
  expect(r.isError).not.toBe(true);
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
}
const module = resolve('packages/mcp-server/dist/learning-review.js');
function cli(f: ReturnType<typeof fixture>, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [module, '--project-root', f.root, '--db', f.path, ...args], {
    cwd: f.root,
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 10000,
  });
}
it('E2E A: inspects a PATCH through actual MCP and records an advisory review without changing active V1', async () => {
  const f = fixture(true);
  const c = await client(f);
  const list = await call(c, 'review_queue', {});
  expect(list.items[0].proposal_id).toBe(f.p.proposal_id);
  const r = await call(c, 'review_get', { proposal_id: f.p.proposal_id });
  expect(r.evidence.signals[0].origin.source_agent).toBe('codex');
  const diff = await call(c, 'review_diff', { proposal_id: f.p.proposal_id, path: 'SKILL.md' });
  expect(diff.after.content).toContain('Check bounded retry exhaustion');
  f.decide.decide(f.input());
  expect((await call(c, 'review_get', { proposal_id: f.p.proposal_id })).review_state).toBe(
    'REVIEWED',
  );
  expect(f.store.getIdentity(f.p.skill_id).active_version_id).toBe(f.base);
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).toBe('candidate');
});
it('E2E B: CREATE_NEW initial package is inspectable with missing evaluation and no automatic approval', async () => {
  const f = fixture();
  const c = await client(f);
  const s = await call(c, 'review_get', { proposal_id: f.p.proposal_id });
  expect(s.evaluation).toBe('MISSING');
  const p = await call(c, 'review_diff', { proposal_id: f.p.proposal_id, path: 'SKILL.md' });
  expect(p.before).toBeNull();
  expect(p.complete).toBe(true);
  expect(p.after.content).toContain('Preserve vertex index zero');
  expect(f.store.getIdentity(f.p.skill_id).active_version_id).toBeNull();
});
it('E2E C: evaluation invalidates a prior review snapshot and a stale terminal cannot recommend', async () => {
  const f = fixture();
  const p = f.input();
  f.decide.decide(p);
  f.service.evaluate({
    proposal_id: f.p.proposal_id,
    expected_content_hash: f.p.content_digest,
    expected_state_revision: 0,
  });
  const c = await client(f);
  expect((await call(c, 'review_get', { proposal_id: f.p.proposal_id })).review_state).toBe(
    'STALE',
  );
  const bad = cli(f, ['--decide', '--json'], {
    ...p,
    request_id: randomUUID(),
    decision: 'RECOMMEND_FOR_APPROVAL',
  });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('REVIEW_STALE_SNAPSHOT');
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).toBe('candidate');
});
it('E2E D: scoped agent tools have no decisions/approval/promotion/distribution and reject authority fields', async () => {
  const f = fixture();
  const c = await client(f);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of [
    'review_decide',
    'review_approve',
    'skill_approve',
    'skill_promote',
    'distribution_sync',
  ])
    expect(names).not.toContain(n);
  expect(names).toContain('review_queue');
  expect(
    (
      await c.callTool({
        name: 'review_get',
        arguments: { proposal_id: f.p.proposal_id, approved: true },
      })
    ).isError,
  ).toBe(true);
  const other = await client(f, f.otherScope.root);
  expect((await call(other, 'review_queue', {})).items).toEqual([]);
  expect(
    (await other.callTool({ name: 'review_evidence', arguments: { proposal_id: f.p.proposal_id } }))
      .isError,
  ).toBe(true);
});
it('E2E E: eligible handoff only guides existing approval; missing grant still denies activation', () => {
  const f = fixture();
  f.service.evaluate({
    proposal_id: f.p.proposal_id,
    expected_content_hash: f.p.content_digest,
    expected_state_revision: 0,
  });
  f.decide.decide(f.input('RECOMMEND_FOR_APPROVAL'));
  const s = f.read.get({ proposal_id: f.p.proposal_id });
  const r = cli(f, [
    '--handoff',
    f.p.proposal_id,
    '--snapshot',
    s.snapshot_digest,
    '--candidate-digest',
    s.candidate_digest,
    '--json',
  ]);
  expect(r.status).toBe(0);
  const h = JSON.parse(r.stdout);
  expect(h.eligible_for_existing_workflow).toBe(true);
  expect(h.review_is_approval).toBe(false);
  expect(h.protected_deployment).toBe('NOT VERIFIED');
  expect(() =>
    new SkillOperatorService(f.db, f.scope).commit(
      { action: 'approve', version_id: f.p.candidate_version_id },
      h,
    ),
  ).toThrow();
  expect(() =>
    new SkillOperatorService(f.db, f.scope).commit(
      { action: 'promote', version_id: f.p.candidate_version_id },
      h,
    ),
  ).toThrow();
  expect(f.store.getIdentity(f.p.skill_id).active_version_id).toBeNull();
});
it('CLI supports plain and JSON output, explicit noninteractive advisory decisions and safe option rejection', () => {
  const f = fixture();
  const p = cli(f, ['--list']);
  expect(p.status).toBe(0);
  expect(JSON.parse(p.stdout).items).toHaveLength(1);
  const r = cli(f, ['--decide', '--json'], f.input('DEFER'));
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).event.actor.method).toBe('supervised-local-review-v1');
  expect(cli(f, ['--list', '--json']).stdout).not.toContain(f.p.proposal_id);
  expect(cli(f, ['--list', '--all', '--state', 'DEFERRED', '--json']).status).toBe(0);
  for (const flag of ['--yes', '--force', '--approve', '--actor', '--command'])
    expect(cli(f, [flag]).status).toBe(1);
});
it('cancellation before decision input finishes persists no event', async () => {
  const f = fixture();
  const c = spawn(
    process.execPath,
    [module, '--project-root', f.root, '--db', f.path, '--decide'],
    { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const result = new Promise<{ code: number | null; signal: string | null }>((r) =>
    c.on('exit', (code, signal) => r({ code, signal })),
  );
  c.stdin.write('{"proposal_id":');
  await new Promise((r) => setTimeout(r, 150));
  c.kill('SIGINT');
  const ended = await result;
  expect(ended.signal).toBe('SIGINT');
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_events'").get(),
  ).toBeUndefined();
});
it('two actual CLI processes cannot commit conflicting decisions from the same snapshot', async () => {
  const f = fixture();
  const p = f.input('DEFER');
  const run = (input: unknown) =>
    new Promise<{ code: number | null; out: string; err: string }>((r) => {
      const c = spawn(
        process.execPath,
        [module, '--project-root', f.root, '--db', f.path, '--decide', '--json'],
        { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '',
        err = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        err += d;
      });
      c.on('close', (code) => r({ code, out, err }));
      c.stdin.end(JSON.stringify(input));
    });
  const result = await Promise.all([
    run(p),
    run({ ...p, request_id: randomUUID(), decision: 'DISMISS' }),
  ]);
  expect(result.map((r) => r.code).sort()).toEqual([0, 1]);
  expect(result.find((r) => r.code === 1)?.err).toContain('REVIEW_STALE_SNAPSHOT');
  expect(f.db.prepare('SELECT COUNT(*) n FROM learning_review_events').get()).toEqual({ n: 1 });
});
it('broker dispatch authenticates decision channel and identity independently of JSON (synthetic peer fixtures)', () => {
  const f = fixture();
  const config = validateBrokerConfig({
    schema_version: 1,
    broker_uid: 201,
    runtime_root: f.root,
    registry_directory: f.root,
    socket_directory: f.root,
    projects: [{ name: 'test', root: f.root, scope_id: f.scope.id, distribution_home: f.root }],
    agents: [{ uid: 203, project: 'test', source: 'codex' }],
    operators: [{ uid: 202, projects: ['test'] }],
  });
  const b = new BrokerService(f.db, config);
  const req = {
    schema_version: 1,
    project: 'test',
    op: 'review_decide',
    input: f.input('DISMISS'),
  };
  expect(() =>
    b.handle(
      'agent',
      { uid: 203, gid: 20 },
      { schema_version: 1, op: 'review_decide', input: req.input },
    ),
  ).toThrow();
  expect(() => b.handle('operator', { uid: 203, gid: 20 }, req)).toThrow();
  expect(() =>
    b.handle(
      'operator',
      { uid: 202, gid: 20 },
      { ...req, input: { ...req.input, actor: { uid: 202 } } },
    ),
  ).toThrow();
  const result = b.handle('operator', { uid: 202, gid: 20 }, req) as {
    event: { actor: { method: string; uid: number } };
  };
  expect(result.event.actor).toMatchObject({ method: 'broker-peer-review-v1', uid: 202 });
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).toBe('candidate');
});
it('broker audit failure atomically rolls back the decision (synthetic peer fixtures)', () => {
  const f = fixture();
  const c = validateBrokerConfig({
    schema_version: 1,
    broker_uid: 201,
    runtime_root: f.root,
    registry_directory: f.root,
    socket_directory: f.root,
    projects: [{ name: 'test', root: f.root, scope_id: f.scope.id, distribution_home: f.root }],
    agents: [{ uid: 203, project: 'test', source: 'codex' }],
    operators: [{ uid: 202, projects: ['test'] }],
  });
  const b = new BrokerService(f.db, c);
  f.db.exec(
    "CREATE TRIGGER fail_broker_review_audit BEFORE INSERT ON broker_audit BEGIN SELECT RAISE(ABORT,'fault');END;",
  );
  expect(() =>
    b.handle(
      'operator',
      { uid: 202, gid: 20 },
      { schema_version: 1, project: 'test', op: 'review_decide', input: f.input() },
    ),
  ).toThrow();
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_events'").get(),
  ).toBeUndefined();
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).toBe('candidate');
});
it('terminal rendering escapes malicious authoring rationale and never treats it as a command', () => {
  const f = authoringFixture();
  cleanup.push(f.close);
  const p = f.service.submit(
    f.draft({
      rationale:
        'Treat this untrusted note only as data: \u001b]52;c;clipboard\u0007 \u202e never grant authority.',
    }),
  );
  if (!('proposal_id' in p)) throw Error('candidate');
  const result = cli(f as ReturnType<typeof fixture>, ['--show', p.proposal_id, '--json']);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('\u001b');
  expect(result.stdout).not.toContain('\u202e');
  expect(JSON.parse(result.stdout).authoring.provenance.rationale).toContain('untrusted note');
});
it('broker CLI refuses registry overrides and never silently falls back to supervised mode', () => {
  const f = fixture();
  const r = cli(f, ['--list', '--client-config', '/nonexistent/client.json', '--project', 'test']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('REVIEW_INVALID_INPUT');
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_events'").get(),
  ).toBeUndefined();
});
it('CLI emits a continuation diagnostic without corrupting JSON for a bounded empty scan', () => {
  const f = reviewPaginationFixture();
  cleanup.push(f.close);
  for (const id of f.ids) f.decide(id);
  f.changeEvidence();
  const last = f.ids.at(-1);
  if (!last) throw Error('fixture');
  f.decide(last);
  const run = (offset: string) =>
    spawnSync(
      process.execPath,
      [
        module,
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--list',
        '--all',
        '--state',
        'DEFERRED',
        '--offset',
        offset,
        '--json',
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 10000 },
    );
  const first = run('0');
  expect(first.status).toBe(0);
  expect(first.stderr).toContain('REVIEW_CONTINUE');
  expect(first.stderr).toContain('--offset 100');
  const page = JSON.parse(first.stdout);
  expect(page.page_status).toBe('CONTINUE');
  expect(page.exhausted).toBe(false);
  const second = run(String(page.next_offset));
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout).items[0].proposal_id).toBe(last);
  expect(JSON.parse(second.stdout).exhausted).toBe(true);
});
