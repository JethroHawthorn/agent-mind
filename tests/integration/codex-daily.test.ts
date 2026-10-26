import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { fileDigest } from '../../packages/core/src/authoring/patch.js';
import { openDatabase, validateSkillBundle } from '../../packages/core/src/index.js';
import { DAILY_TOOLS } from '../../packages/mcp-server/src/codex/configuration.js';
import { connectDoctor } from '../../packages/mcp-server/src/codex/doctor.js';
import { CodexSetup } from '../../packages/mcp-server/src/codex/setup.js';
import { discoverCodex } from '../../scripts/native-process.mjs';
import { codexFixture } from '../helpers/codex-fixture.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const f = codexFixture();
  cleanup.push(f.cleanup);
  return f;
}
async function connect(f: ReturnType<typeof fixture>, cwd = f.root) {
  const c = new Client({ name: 'SIMULATED-CODEX-DAILY-SDK', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [f.options.adapter, '--enrollment', f.enrollment],
      cwd,
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw Error(JSON.stringify(r.content));
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? 'null');
}
it('offline A/B/D/G/H: daily adapter exposes scoped health, durable memory and lower-trust learning over real stdio processes', async () => {
  const f = fixture();
  f.setup.setup();
  const d = await connectDoctor(f.setup);
  expect(d.health.project_id).toBe(f.setup.status().project_id);
  expect(d.enabled_tool_count).toBe(DAILY_TOOLS.length);
  const c = await connect(f);
  const status = await call(c, 'agentmind_status');
  expect(status.mode).toBe('supervised-local');
  const memory = await call(c, 'memory_save', {
    title: 'Boundary procedure fixture',
    content: 'Preserve zero while applying both numeric bounds.',
  });
  const xp = await call(c, 'experience_record', {
    problem: 'Numeric fixture lost its lower bound',
    solution: 'Preserve both bounds and zero in the utility.',
    outcome: {
      status: 'unknown',
      summary: 'Agent-reported fixture; no independently verified outcome.',
    },
  });
  const signal = await call(c, 'learning_signal_record', {
    schema_version: 1,
    type: 'PROBLEM_SOLVED',
    title: 'Potential lower-bound repair',
    summary: 'A reusable boundary procedure may need checks for lower, upper and zero.',
    experience_ids: [xp.experience.id],
    reusability: 'potentially_reusable',
  });
  const signalDetail = await call(c, 'learning_signal_get', { signal_id: signal.id });
  expect(signalDetail.origin.detection_source).toBe('agent_reported');
  expect(signalDetail.triage.evidence_trust).toBe('AGENT_REPORTED');
  await c.close();
  const next = await connect(f);
  expect((await call(next, 'memory_search', { query: 'Preserve zero' })).memories[0].id).toBe(
    memory.memory.id,
  );
  expect((await call(next, 'learning_signal_get', { signal_id: signal.id })).id).toBe(signal.id);
  const other = fixture();
  other.options.database = f.options.database;
  other.setup = new CodexSetup(other.options);
  other.setup.setup();
  const foreign = await connect(other);
  expect((await call(foreign, 'memory_search', { query: 'Preserve zero' })).memories).toEqual([]);
  await expect(call(foreign, 'learning_signal_get', { signal_id: signal.id })).rejects.toThrow();
  const tools = (await next.listTools()).tools.map((t) => t.name);
  for (const op of ['skill_approve', 'skill_promote', 'skill_rollback', 'distribution_sync'])
    expect(tools).not.toContain(op);
  expect((await call(next, 'review_queue', { limit: 5 })).items).toEqual([]);
  const metrics = {
    classification: 'SIMULATED_SDK; not native behavior',
    ...d,
    router_bytes: Buffer.byteLength(f.options.router),
    memory_response_bytes: Buffer.byteLength(JSON.stringify(memory)),
    experience_response_bytes: Buffer.byteLength(JSON.stringify(xp)),
    signal_response_bytes: Buffer.byteLength(JSON.stringify(signal)),
    agents_md_added_bytes: 0,
  };
  writeFileSync(
    join(tmpdir(), 'agentmind-p4-001-daily-metrics.json'),
    JSON.stringify(metrics, null, 2),
  );
}, 20000);
it('native configuration I: actual Codex reads project MCP entry in an isolated trusted CLI home; unrelated settings survive uninstall', () => {
  const f = fixture();
  f.setup.setup();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: f.root,
    CODEX_HOME: join(f.root, 'fake-home'),
    LANG: 'C',
  };
  writeFileSync(
    join(f.root, 'fake-home/config.toml'),
    `[projects.${JSON.stringify(f.root)}]\ntrust_level = "trusted"\n`,
  );
  const result = spawnSync(f.setup.codex, ['mcp', 'get', f.setup.serverName, '--json'], {
    cwd: f.root,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  expect(result.status).toBe(0);
  const entry = JSON.parse(result.stdout);
  expect(entry.transport.args).toEqual([f.options.adapter, '--enrollment', f.enrollment]);
  f.setup.uninstall(true);
  const missing = spawnSync(f.setup.codex, ['mcp', 'get', f.setup.serverName, '--json'], {
    cwd: f.root,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  expect(missing.status).toBe(1);
  expect(readFileSync(join(f.root, 'fake-home/config.toml'), 'utf8')).toContain('trust_level');
});
it('validates the daily Router Skill and measures native discovery separately from authenticated execution', async () => {
  const f = fixture();
  f.setup.setup();
  const description = f.options.router
    .split('\n')
    .find((l) => l.startsWith('description: '))
    ?.slice(13);
  expect(
    validateSkillBundle({
      name: 'agentmind-router',
      description,
      files: [{ path: 'SKILL.md', content: f.options.router }],
    }).validation_result,
  ).toBe('VALID');
  const evidence = await discoverCodex(f.root, 'agentmind-router', f.routerFile, {
    PATH: process.env.PATH ?? '',
    HOME: f.root,
    CODEX_HOME: join(f.root, 'fake-home'),
    LANG: 'C',
  });
  writeFileSync(
    join(tmpdir(), 'agentmind-p4-001-router-native.json'),
    JSON.stringify(
      { ...evidence, authenticated_execution: 'NOT VERIFIED', credential_copy: false },
      null,
      2,
    ),
  );
  // Discovery is environment-dependent; no synthetic/native upgrade of evidence is performed.
  expect(['REAL CODEX VERIFIED', 'NOT VERIFIED']).toContain(evidence.discovery);
}, 15000);
it('handles EOF, startup failure and restarted sessions without a forwarding child or protocol stdout pollution', async () => {
  const f = fixture();
  f.setup.setup();
  const result = spawnSync(process.execPath, [f.options.adapter, '--enrollment', f.enrollment], {
    cwd: f.root,
    input: '',
    encoding: 'utf8',
    timeout: 7000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  spawnSync('git', ['init', '-q', join(f.root, 'other-project')]);
  const bad = spawnSync(process.execPath, [f.options.adapter, '--enrollment', f.enrollment], {
    cwd: dirnameFixture(f.root),
    input: '',
    encoding: 'utf8',
    timeout: 7000,
  });
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe('');
  const a = await connect(f),
    b = await connect(f);
  expect((await call(a, 'agentmind_status')).project_id).toBe(
    (await call(b, 'agentmind_status')).project_id,
  );
});
function dirnameFixture(root: string) {
  const path = join(root, 'other-project');
  return path;
}
it('CLI preview does not disclose unrelated secrets or apply changes; explicit fixture apply/uninstall is reversible', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.codex'), { recursive: true });
  writeFileSync(
    f.config,
    '[mcp_servers.other]\ncommand="node"\n[mcp_servers.other.env]\nDUMMY_VALUE="PRIVATE_FIXTURE_SENTINEL"\n',
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/codex.js'),
        ...args,
        '--project-root',
        f.root,
        '--db',
        f.options.database,
        '--json',
      ],
      { cwd: f.root, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 },
    );
  const preview = run(['setup', '--dry-run']);
  expect(preview.status).toBe(0);
  expect(preview.stdout).not.toContain('PRIVATE_FIXTURE_SENTINEL');
  expect(existsSync(f.routerFile)).toBe(false);
  expect(run(['setup', '--apply']).status).toBe(0);
  expect(JSON.parse(run(['status']).stdout).installed).toBe(true);
  expect(run(['uninstall', '--apply']).status).toBe(0);
  expect(readFileSync(f.config, 'utf8')).toContain('PRIVATE_FIXTURE_SENTINEL');
  expect(run(['setup', '--scope', 'user', '--apply']).status).toBe(1);
  expect(run(['setup', '--apply', '--dry-run']).status).toBe(1);
  expect(run(['doctor', '--connect', '--dry-run']).status).toBe(1);
});
it('offline C/E: daily tools retrieve approved active guidance and queue a fixture-authored immutable patch without promotion', async () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  const router = readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
    adapter = resolve('packages/mcp-server/dist/codex/adapter.js');
  const setup = new CodexSetup({ root: f.root, database: f.path, adapter, router });
  setup.setup();
  const base = f.add({
    name: 'sqlite-daily-retry',
    description: 'Inspect SQLite startup errors with bounded retry checkpoints.',
    resources: [{ path: 'references/note.md', content: 'SELECT_THIS_REFERENCE_ONLY' }],
  });
  const c = new Client({ name: 'SIMULATED-CODEX-DAILY-AUTHOR', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [adapter, '--enrollment', join(f.root, '.agentmind/codex/enrollment.json')],
      cwd: f.root,
      stderr: 'pipe',
    }),
  );
  const route = await call(c, 'skill_route', { context: { summary: 'sqlite startup retry' } });
  expect(route.skills[0].active_version_id).toBe(base.version.id);
  expect(JSON.stringify(route)).not.toContain('SELECT_THIS_REFERENCE_ONLY');
  const pin = {
    skill_id: base.identity.id,
    expected_version_id: base.version.id,
    expected_digest: base.version.content_hash,
  };
  const mainResponse = await call(c, 'skill_load', pin);
  const resourceResponse = await call(c, 'skill_resource_get', {
    ...pin,
    path: 'references/note.md',
  });
  expect(mainResponse.version_id).toBe(base.version.id);
  expect(resourceResponse.content).toBe('SELECT_THIS_REFERENCE_ONLY');
  const signal = await call(c, 'learning_signal_record', {
    schema_version: 1,
    type: 'SKILL_GAP',
    title: 'Retry exhaustion evidence gap',
    summary: 'The existing SQLite startup procedure may need an explicit exhaustion checkpoint.',
    experience_ids: [f.approvedSource.id],
    version_ids: [base.version.id],
    reusability: 'potentially_reusable',
  });
  const ctx = await call(c, 'skill_authoring_context', {
    signal_ids: [signal.id],
    experience_ids: [f.approvedSource.id],
    query: 'sqlite startup retry',
    target_version_id: base.version.id,
  });
  const main = base.version.files.find((x) => x.path === 'SKILL.md');
  if (!main) throw Error('fixture main');
  const request = {
    schema_version: 1,
    request_id: randomUUID(),
    type: 'PATCH_EXISTING',
    context_id: ctx.id,
    context_digest: ctx.context_digest,
    name: base.identity.name,
    description: base.version.description,
    target_skill_id: base.identity.id,
    target_version_id: base.version.id,
    expected_base_digest: base.version.content_hash,
    rationale: 'Fixture-authored patch adds a bounded exhaustion review checkpoint.',
    expected_improvement: 'Make missing recovery evidence visible to the operator.',
    known_limitations: ['Fixture-authored, not native AI authorship or verified effectiveness.'],
    operations: [
      {
        op: 'replace',
        path: 'SKILL.md',
        expected_file_digest: fileDigest(main.content),
        old_text: 'Inspect the named scenario and retain unresolved outcomes.',
        new_text:
          'Inspect the named scenario and retain unresolved outcomes. Record retry exhaustion before reporting recovery.',
      },
    ],
  };
  const proposal = await call(c, 'skill_authoring_submit', request);
  expect(proposal.candidate_state).toBe('candidate');
  expect((await call(c, 'skill_authoring_submit', request)).proposal_id).toBe(proposal.proposal_id);
  expect(
    (await call(c, 'review_queue', { limit: 5 })).items.some(
      (i: { proposal_id: string }) => i.proposal_id === proposal.proposal_id,
    ),
  ).toBe(true);
  const evaluation = await call(c, 'skill_authoring_evaluate', {
    proposal_id: proposal.proposal_id,
    expected_content_hash: proposal.content_digest,
    expected_state_revision: 0,
  });
  expect(evaluation.evaluation.result).toBe('NOT_VERIFIED');
  expect(
    (await call(c, 'skill_route', { context: { summary: 'sqlite startup retry' } })).skills[0]
      .active_version_id,
  ).toBe(base.version.id);
  expect(f.store.getVersion(base.version.id).version.content_hash).toBe(base.version.content_hash);
  expect(f.store.getVersion(proposal.candidate_version_id).state.status).not.toBe('approved');
  const metricsPath = join(tmpdir(), 'agentmind-p4-001-author-metrics.json');
  writeFileSync(
    metricsPath,
    JSON.stringify(
      {
        classification: 'FIXTURE_AUTHORED_OVER_REAL_MCP',
        context_bytes: Buffer.byteLength(JSON.stringify(ctx)),
        submission_bytes: Buffer.byteLength(JSON.stringify(request)),
        proposal_response_bytes: Buffer.byteLength(JSON.stringify(proposal)),
        discovery_bytes: Buffer.byteLength(JSON.stringify(route)),
        main_response_bytes: Buffer.byteLength(JSON.stringify(mainResponse)),
        resource_response_bytes: Buffer.byteLength(JSON.stringify(resourceResponse)),
        active_preserved: true,
        behavioral_execution: 'NOT VERIFIED',
      },
      null,
      2,
    ),
  );
}, 20000);
it('bounded SQLite write contention returns an error, then coding-session storage recovers without losing prior data', async () => {
  const f = fixture();
  f.setup.setup();
  const c = await connect(f);
  await call(c, 'memory_save', {
    title: 'Recovery fixture',
    content: 'Preserve existing facts after a failed write.',
  });
  const db = openDatabase(f.options.database);
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = await c.callTool({
      name: 'memory_save',
      arguments: { title: 'Blocked fixture', content: 'Must not falsely report persistence.' },
    });
    expect(result.isError).toBe(true);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
  expect(
    (await call(c, 'memory_search', { query: 'Preserve existing facts' })).memories,
  ).toHaveLength(1);
  await call(c, 'memory_save', {
    title: 'Recovered fixture',
    content: 'A later write succeeds after lock release.',
  });
}, 15000);
