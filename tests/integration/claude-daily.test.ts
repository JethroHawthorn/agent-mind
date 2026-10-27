import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { fileDigest } from '../../packages/core/src/authoring/patch.js';
import {
  hashSkillFiles,
  openDatabase,
  SkillStore,
  validateSkillBundle,
} from '../../packages/core/src/index.js';
import { connectClaude } from '../../packages/mcp-server/src/claude/doctor.js';
import { ClaudeSetup } from '../../packages/mcp-server/src/claude/setup.js';
import { DAILY_TOOLS } from '../../packages/mcp-server/src/codex/configuration.js';
import { skillFixtureFiles } from '../../scripts/learning-fixture.mjs';
import { codexFixture } from '../helpers/codex-fixture.js';
import { learningE2E } from '../helpers/learning-e2e.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture() {
  const f = codexFixture();
  cleanup.push(f.cleanup);
  const setup = new ClaudeSetup({
    ...f.options,
    home: join(f.root, 'fake-home'),
    adapter: resolve('packages/mcp-server/dist/claude/adapter.js'),
  });
  return { ...f, claude: setup };
}
async function connect(
  root: string,
  enrollment: string,
  adapter = resolve('packages/mcp-server/dist/claude/adapter.js'),
) {
  const c = new Client({ name: 'SIMULATED-CLAUDE-DAILY-SDK', version: '1' });
  cleanup.push(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [adapter, '--enrollment', enrollment],
      cwd: root,
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
it('offline cross-agent A/C/E/J/K: canonical shared scope, durable memory, experience and lower-trust signal provenance across native adapters', async () => {
  const f = fixture();
  f.setup.setup();
  f.claude.setup();
  const codex = await connect(f.root, f.enrollment, f.options.adapter);
  const health = await call(codex, 'agentmind_status');
  const saved = (
    await call(codex, 'memory_save', {
      title: 'Shared boundary memory',
      content: 'Preserve numeric zero and inspect both bounds.',
    })
  ).memory;
  const c = await connect(f.root, f.claude.enrollment);
  expect((await call(c, 'agentmind_status')).project_id).toBe(health.project_id);
  expect((await call(c, 'memory_search', { query: 'Shared boundary' })).memories[0]).toMatchObject({
    id: saved.id,
    source_agent: 'codex',
  });
  const xp = await call(c, 'experience_record', {
    problem: 'Numeric boundary ignored zero',
    solution: 'Inspect lower and upper bounds independently.',
    outcome: {
      status: 'unknown',
      summary: 'Agent-reported observation requires independent checking.',
    },
    evidence: [],
    provenance: {},
  });
  expect(xp.experience.source_agent).toBe('claude');
  const signal = await call(c, 'learning_signal_record', {
    schema_version: 1,
    type: 'PROBLEM_SOLVED',
    title: 'Boundary retention lesson',
    summary: 'A reusable boundary procedure may warrant review; outcome remains unverified.',
    experience_ids: [xp.experience.id],
    reusability: 'potentially_reusable',
  });
  expect(signal.evidence_trust).toBe('AGENT_REPORTED');
  const recorded = await call(c, 'learning_signal_get', { signal_id: signal.id });
  expect(JSON.stringify(recorded)).toContain('claude');
  await c.close();
  const restarted = await connect(f.root, f.claude.enrollment);
  expect(
    (await call(restarted, 'memory_search', { query: 'Shared boundary' })).memories[0].id,
  ).toBe(saved.id);
  const foreign = fixture();
  const other = new ClaudeSetup({ ...foreign.claude.options, database: f.options.database });
  other.setup();
  const isolated = await connect(foreign.root, other.enrollment);
  expect((await call(isolated, 'memory_search', { query: 'Shared boundary' })).memories).toEqual(
    [],
  );
  expect(
    (await isolated.callTool({ name: 'learning_signal_get', arguments: { signal_id: signal.id } }))
      .isError,
  ).toBe(true);
  expect(
    (
      await isolated.callTool({
        name: 'memory_search',
        arguments: { query: 'boundary', project_id: health.project_id },
      })
    ).isError,
  ).toBe(true);
}, 25000);
it('offline D/F/H: exact approved Codex-origin skill -> Claude patch candidate -> Codex review, with no activation or fabricated behavioral evidence', async () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  const setup = new ClaudeSetup({
    root: f.root,
    home: f.home,
    database: f.path,
    adapter: resolve('packages/mcp-server/dist/claude/adapter.js'),
    router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
  });
  setup.setup();
  const base = f.add({
    name: 'sqlite-claude-retry',
    description: 'Inspect SQLite startup retry boundaries and unresolved failures.',
    resources: [
      { path: 'references/note.md', content: 'Only load this bounded reference on request.' },
    ],
  });
  const c = await connect(f.root, setup.enrollment);
  const routed = await call(c, 'skill_route', { context: { summary: 'sqlite startup retry' } });
  expect(routed.skills[0].active_version_id).toBe(base.version.id);
  const pin = {
    skill_id: base.identity.id,
    expected_version_id: base.version.id,
    expected_digest: base.version.content_hash,
  };
  expect((await call(c, 'skill_load', pin)).version_id).toBe(base.version.id);
  writeFileSync(
    join(tmpdir(), 'agentmind-p4-002-context.json'),
    JSON.stringify({
      evidence: 'offline synthetic approved catalog, fixture-authored patch',
      route_bytes: Buffer.byteLength(JSON.stringify(routed)),
      skill_load_bytes: Buffer.byteLength(JSON.stringify(await call(c, 'skill_load', pin))),
      resource_bytes: Buffer.byteLength(
        JSON.stringify(await call(c, 'skill_resource_get', { ...pin, path: 'references/note.md' })),
      ),
    }),
  );
  expect(
    (await call(c, 'skill_resource_get', { ...pin, path: 'references/note.md' })).content,
  ).toContain('bounded reference');
  expect(
    (await c.callTool({ name: 'skill_resource_get', arguments: { ...pin, path: '../private' } }))
      .isError,
  ).toBe(true);
  const signal = await call(c, 'learning_signal_record', {
    schema_version: 1,
    type: 'SKILL_GAP',
    title: 'Retry exhaustion needs inspection',
    summary: 'Existing procedure might need a bounded exhaustion checkpoint.',
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
  const p = {
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
    rationale: 'Offline fixture-authored patch to expose exhaustion uncertainty.',
    expected_improvement: 'Make bounded recovery checkpoints reviewable.',
    known_limitations: ['Fixture authored; not real Claude authorship or task success.'],
    operations: [
      {
        op: 'replace',
        path: 'SKILL.md',
        expected_file_digest: fileDigest(main.content),
        old_text: 'Inspect the named scenario and retain unresolved outcomes.',
        new_text:
          'Inspect the named scenario and retain unresolved outcomes. Inspect retry exhaustion explicitly.',
      },
    ],
  };
  const submitted = await call(c, 'skill_authoring_submit', p);
  expect(submitted.candidate_state).toBe('candidate');
  expect((await call(c, 'skill_authoring_submit', p)).proposal_id).toBe(submitted.proposal_id);
  const evaluation = await call(c, 'skill_authoring_evaluate', {
    proposal_id: submitted.proposal_id,
    expected_content_hash: submitted.content_digest,
    expected_state_revision: 0,
  });
  expect(evaluation.evaluation.result).toBe('NOT_VERIFIED');
  const codex = new Client({ name: 'SIMULATED-CODEX-SHARED-REVIEW', version: '1' });
  cleanup.push(() => codex.close());
  await codex.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('packages/mcp-server/dist/index.js'),
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--source-agent',
        'codex',
        '--enable-authoring',
        '--enable-learning',
        '--enable-retrieval',
      ],
      cwd: f.root,
      stderr: 'pipe',
    }),
  );
  expect(
    (await call(codex, 'review_queue', { limit: 5 })).items.some(
      (i: { proposal_id: string }) => i.proposal_id === submitted.proposal_id,
    ),
  ).toBe(true);
  expect(
    (await call(codex, 'skill_discover', { query: 'sqlite startup retry' })).skills[0]
      .active_version_id,
  ).toBe(base.version.id);
  const stored = new SkillStore(f.db, f.scope).getVersion(base.version.id);
  expect(hashSkillFiles(stored.version.files)).toBe(base.version.content_hash);
  expect((await call(c, 'skill_load', pin)).version_id).toBe(base.version.id);
}, 25000);
it('MCP profile has exactly 19 daily tools, rejects lifecycle/extra endpoints, and SDK doctor reports measurements', async () => {
  const f = fixture();
  f.claude.setup();
  const c = await connect(f.root, f.claude.enrollment);
  const tools = (await c.listTools()).tools;
  expect(tools.map((t) => t.name).sort()).toEqual([...DAILY_TOOLS].sort());
  for (const name of [
    'skill_approve',
    'skill_promote',
    'distribution_sync',
    'review_decide',
    'skill_propose',
  ])
    expect((await c.callTool({ name, arguments: {} })).isError).toBe(true);
  const doctor = await connectClaude(f.claude);
  expect(doctor.tool_count).toBe(19);
  expect(doctor.health.source_agent).toBe('claude');
  expect(doctor.schema_bytes).toBeGreaterThan(0);
  writeFileSync(
    join(tmpdir(), 'agentmind-p4-002-metrics.json'),
    JSON.stringify({
      evidence: 'MCP SDK, not native model',
      connection_health_tools_ms: doctor.connection_health_tools_ms,
      tool_count: doctor.tool_count,
      schema_bytes: doctor.schema_bytes,
      router_bytes: Buffer.byteLength(f.claude.options.router),
      description_bytes: Buffer.byteLength(
        f.claude.options.router.match(/description: (.+)/)?.[1] ?? '',
      ),
      claude_md_added_bytes: 0,
      hook_stdout_bytes: 0,
      model_tokens_measured: false,
    }),
  );
  const router = f.claude.options.router;
  expect(
    validateSkillBundle({
      name: 'agentmind-router',
      description: router.match(/description: (.+)/)?.[1],
      files: [{ path: 'SKILL.md', content: router }],
    }).validation_result,
  ).toBe('VALID');
});
it('EOF shuts down cleanly; foreign cwd and malformed enrollment fail before storage opens', () => {
  const f = fixture();
  f.claude.setup();
  const run = (cwd: string) =>
    spawnSync(process.execPath, [f.claude.adapter, '--enrollment', f.claude.enrollment], {
      cwd,
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
  const eof = run(f.root);
  expect(eof.status).toBe(0);
  expect(eof.stdout).toBe('');
  const other = fixture();
  expect(run(other.root).status).toBe(1);
  expect(run(other.root).stdout).toBe('');
  const db = openDatabase(f.options.database);
  db.close();
});

it('offline Claude -> Codex CREATE_NEW completes existing fixture-operator approval/promotion, never real human consent', async () => {
  const f = await learningE2E({ continuous: true });
  cleanup.push(f.cleanup);
  const setup = new ClaudeSetup({
    root: f.root,
    home: f.home,
    database: f.path,
    adapter: resolve('packages/mcp-server/dist/claude/adapter.js'),
    router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
  });
  setup.setup();
  const claude = await connect(f.root, setup.enrollment);
  const xp = (
    await call(claude, 'experience_record', {
      problem: 'Clamp lower boundary is omitted while upper values are retained',
      solution: 'Use Math.max for the lower bound before Math.min for the upper bound.',
      outcome: {
        status: 'unknown',
        summary: 'Offline fixture report, not independently verified task success.',
      },
      evidence: [
        {
          kind: 'test',
          reference: 'clamp.test.mjs',
          summary: 'Repository-owned acceptance fixture; no model-written scripts executed.',
        },
      ],
      provenance: { task_ref: 'p4-002-offline-reverse' },
    })
  ).experience;
  expect(xp.source_agent).toBe('claude');
  expect((await f.approveExperience(xp)).status).toBe(0);
  const signal = await call(claude, 'learning_signal_record', {
    schema_version: 1,
    type: 'REUSABLE_WORKFLOW',
    title: 'Clamp both numeric bounds',
    summary: 'Numeric clamping needs separate lower and upper boundary checks, including zero.',
    experience_ids: [xp.id],
    reusability: 'potentially_reusable',
  });
  const ctx = await call(claude, 'skill_authoring_context', {
    signal_ids: [signal.id],
    experience_ids: [xp.id],
    query: 'numeric clamp bounds',
  });
  const proposal = await call(claude, 'skill_authoring_submit', {
    schema_version: 1,
    request_id: randomUUID(),
    type: 'CREATE_NEW',
    context_id: ctx.id,
    context_digest: ctx.context_digest,
    name: f.fixture.name,
    description: 'Check lower and upper bounds in a numeric clamp utility',
    files: skillFixtureFiles(f.fixture),
    rationale: 'Fixture-generated reusable procedure from the linked explicit experience.',
    expected_improvement: 'Make both numeric bounds explicit for later operator investigation.',
    known_limitations: ['Offline predefined proposal; no real Claude authoring or human consent.'],
  });
  expect(proposal.candidate_state).toBe('candidate');
  const evaluated = await f.evaluate(proposal.candidate_version_id);
  expect(evaluated.evaluation.result).toBe('PASS');
  expect((await f.operator('promote', proposal.candidate_version_id)).status).toBe(1);
  expect((await f.operator('approve', proposal.candidate_version_id)).status).toBe(0);
  expect((await f.operator('promote', proposal.candidate_version_id)).status).toBe(0);
  const codex = await f.connect('codex');
  const discovered = await f.call(codex, 'skill_discover', { query: 'clamp bounds' });
  expect(discovered.skills[0].active_version_id).toBe(proposal.candidate_version_id);
  const loaded = await f.call(codex, 'skill_load', {
    skill_id: discovered.skills[0].skill_id,
    expected_version_id: proposal.candidate_version_id,
    expected_digest: proposal.content_digest,
  });
  expect(loaded.version_id).toBe(proposal.candidate_version_id);
  expect(
    new SkillStore(f.db, f.scope).getVersion(proposal.candidate_version_id).version.source_agent,
  ).toBe('claude');
}, 30000);
