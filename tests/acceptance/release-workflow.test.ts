import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import {
  ExperienceService,
  openDatabaseReadOnly,
  resolveProject,
} from '../../packages/core/src/index.js';
import {
  CONTINUOUS_SUITE_DIGEST,
  prepareContinuousFixture,
  runContinuousTask,
} from '../../scripts/continuous-fixture.mjs';
import { cleanupLearningFixture } from '../../scripts/learning-fixture.mjs';
import { qualityMetrics } from '../helpers/hybrid-metrics.js';
import {
  HYBRID_DATASET,
  hybridLabels,
  seedHybridQuality,
} from '../helpers/hybrid-quality-fixtures.js';
import { installerFixture } from '../helpers/installer-fixture.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
function artifact(name: string, value: unknown) {
  const root = process.env.AGENTMIND_P6_001_ARTIFACTS;
  if (!root) return;
  const st = lstatSync(root);
  if (resolve(root) !== realpathSync(root) || !st.isDirectory() || st.mode & 0o077)
    throw Error('Acceptance artifacts require a private canonical directory.');
  if (!['adapter-journey.json', 'retrieval-quality.json'].includes(name))
    throw Error('Unknown acceptance artifact');
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
function data(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '{}');
}
it('P6 shared workflow: three real adapter/MCP processes share memory and record reported learning without imitating native models or operator approval', async () => {
  const f = installerFixture();
  clean.push(f.cleanup);
  const start = performance.now(),
    plans = f.service.plan('setup');
  f.service.apply(plans);
  const setupMs = performance.now() - start;
  expect(f.service.plan('setup').every((p) => p.operations.length === 0)).toBe(true);
  const clients = new Map<string, Client>(),
    timings: Record<string, number> = { setup_ms: setupMs };
  async function connect(provider: 'codex' | 'claude' | 'gemini') {
    const begin = performance.now();
    const client = new Client({ name: `SIMULATED-${provider}-P6`, version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          f.options.adapters[provider],
          '--enrollment',
          join(f.root, '.agentmind', provider, 'enrollment.json'),
        ],
        cwd: f.root,
        stderr: 'pipe',
      }),
    );
    clean.push(() => client.close());
    clients.set(provider, client);
    timings[`${provider}_handshake_ms`] = performance.now() - begin;
    return client;
  }
  const codex = await connect('codex');
  const saved = data(
    await codex.callTool({
      name: 'memory_save',
      arguments: {
        title: 'P6 reusable boundary rule',
        content: 'Clamp lower and upper numeric boundaries separately; preserve zero.',
      },
    }),
  ).memory;
  expect(saved.source_agent).toBe('codex');
  expect(saved.status).toBe('unverified');
  for (const provider of ['claude', 'gemini'] as const) {
    const client = await connect(provider),
      begin = performance.now();
    const found = data(
      await client.callTool({
        name: 'memory_search',
        arguments: { query: 'P6 reusable boundary rule' },
      }),
    ).memories;
    timings[`${provider}_memory_search_ms`] = performance.now() - begin;
    expect(found.map((r: { id: string }) => r.id)).toContain(saved.id);
    expect(found[0].project_id).toBe(saved.project_id);
  }
  await codex.close();
  const restarted = await connect('codex');
  expect(
    data(
      await restarted.callTool({
        name: 'memory_search',
        arguments: { query: 'P6 reusable boundary rule' },
      }),
    ).memories[0].id,
  ).toBe(saved.id);
  const task = prepareContinuousFixture();
  clean.push(() => cleanupLearningFixture(task.root));
  const failing = runContinuousTask(task.root, 'primary', 'baseline'),
    passing = runContinuousTask(task.root, 'primary', 'reference');
  expect(failing.exit_code).not.toBe(0);
  expect(passing.exit_code).toBe(0);
  const transferBefore = runContinuousTask(task.root, 'transfer', 'baseline'),
    transferAfter = runContinuousTask(task.root, 'transfer', 'reference');
  expect(transferBefore.exit_code).not.toBe(0);
  expect(transferAfter.exit_code).toBe(0);
  const claude = clients.get('claude');
  if (!claude) throw Error('adapter');
  const experience = data(
    await claude.callTool({
      name: 'experience_record',
      arguments: {
        problem: 'A numeric clamp ignored its lower boundary during a controlled code-owned task.',
        solution: 'Compare lower and upper boundaries independently while preserving zero.',
        outcome: {
          status: 'succeeded',
          summary: 'Harness reports passing code-owned tests; agent outcome remains unverified.',
        },
        evidence: [
          {
            kind: 'test',
            reference: 'p6-controlled-boundary-fixture',
            summary: 'Parent harness observed independent test exit codes; not sandbox evaluation.',
          },
        ],
        provenance: { task_ref: 'p6-scripted-boundary-task' },
      },
    }),
  ).experience;
  expect(experience.verification_status).toBe('unverified');
  expect(experience.approval_status).toBe('candidate');
  expect(experience.source_agent).toBe('claude');
  const signalBegin = performance.now();
  const signal = data(
    await claude.callTool({
      name: 'learning_signal_record',
      arguments: {
        schema_version: 1,
        type: 'REUSABLE_WORKFLOW',
        title: 'P6 numeric boundary procedure',
        summary:
          'Preserve zero and explicitly check both numeric limits when implementing reusable clamping procedures.',
        experience_ids: [experience.id],
        reusability: 'potentially_reusable',
      },
    }),
  );
  timings.signal_ms = performance.now() - signalBegin;
  const detail = data(
    await claude.callTool({ name: 'learning_signal_get', arguments: { signal_id: signal.id } }),
  );
  expect(detail.origin.detection_source).toBe('agent_reported');
  const duplicate = data(
    await claude.callTool({
      name: 'learning_signal_record',
      arguments: {
        schema_version: 1,
        type: 'REUSABLE_WORKFLOW',
        title: 'P6 numeric boundary procedure',
        summary:
          'Preserve zero and explicitly check both numeric limits when implementing reusable clamping procedures.',
        experience_ids: [experience.id],
        reusability: 'potentially_reusable',
      },
    }),
  );
  expect(duplicate.id).toBe(signal.id);
  const blocked = await claude.callTool({
    name: 'skill_authoring_context',
    arguments: {
      signal_ids: [signal.id],
      experience_ids: [experience.id],
      query: 'numeric boundary clamp',
    },
  });
  expect(blocked.isError).toBe(true); // Source review is genuinely missing; never auto-approve it.
  const db = openDatabaseReadOnly(f.options.database);
  clean.push(() => db.close());
  const privateRoot = join(f.root, 'fake-home');
  const foreign = resolveProject(privateRoot, privateRoot);
  // No write constructor is used on the readonly source.
  expect(
    new ExperienceService(db, foreign, 'unknown', false, false).search({ query: 'numeric clamp' })
      .experiences,
  ).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM skill_operator_events').get()).toEqual({ n: 0 });
  artifact('adapter-journey.json', {
    classification: 'CONTRACT_DOUBLES_PLUS_REAL_ADAPTER_MCP_AND_CODE_OWNED_TASKS',
    native_models: false,
    source_experience_verified: false,
    fixture_task_suite_digest: CONTINUOUS_SUITE_DIGEST,
    source_memory_id: saved.id,
    experience_id: experience.id,
    signal_id: signal.id,
    shared_registry_identity: db.prepare('SELECT id FROM skill_registry_identity').get(),
    tasks: { failing, passing, transferBefore, transferAfter },
    timings,
    proposal_from_unreviewed_source: 'REFUSED_EXPECTED',
    approval: 'NOT VERIFIED; no operator action performed',
    learning: 'Harness initiated; not spontaneous native learning',
    transfer: 'Code-owned reference implementation applied by harness, not model skill reuse',
  });
}, 45000);
it('P6 fixed corpus: records Recall@1/3/5/10, MRR, no-match, negative applicability, bytes and estimated tokens without changing ranking', () => {
  const f = retrievalFixture();
  clean.push(f.close);
  seedHybridQuality(f);
  const cases = hybridLabels.map((q) => {
    const start = performance.now(),
      r = f.retrieval.selectionCards({ context: q.context, limit: 10 });
    return {
      ...q,
      names: r.skills.map((s) => s.name),
      outcome: r.outcome,
      latency_ms: performance.now() - start,
      bytes: Buffer.byteLength(JSON.stringify(r)),
    };
  });
  const positive = cases.filter((c) => c.relevant.length),
    labels = positive.reduce((n, c) => n + c.relevant.length, 0),
    negative = cases.filter((c) => c.label.includes('negative-applicability'));
  const recall3 =
    positive.reduce(
      (n, c) => n + c.names.slice(0, 3).filter((name) => c.relevant.includes(name)).length,
      0,
    ) / labels;
  const metrics = {
    ...qualityMetrics(cases),
    recall_at_3: recall3,
    negative_applicability_queries: negative.length,
    negative_applicability_accuracy: negative.length
      ? negative.filter((c) => !c.names.includes('data-export')).length / negative.length
      : null,
  };
  expect(metrics.recall_at_5).toBe(1);
  expect(metrics.no_match_accuracy).toBe(1);
  expect(metrics.negative_applicability_accuracy).toBe(1);
  const main = f.retrieval.selectionCards({ context: { summary: 'sqlite-retry' }, limit: 5 })
    .skills[0];
  if (!main) throw Error('No selected fixture');
  const content = f.retrieval.load({
    skill_id: main.skill_id,
    expected_version_id: main.active_version_id,
    expected_digest: main.content_digest,
  });
  const digest = createHash('sha256');
  for (const file of [
    'tests/helpers/hybrid-quality-fixtures.ts',
    'tests/helpers/routing-quality-fixtures.ts',
    'tests/helpers/retrieval-quality-fixtures.ts',
  ])
    digest.update(readFileSync(file));
  artifact('retrieval-quality.json', {
    dataset: HYBRID_DATASET,
    dataset_sha256: digest.digest('hex'),
    skills: f.db.prepare('SELECT count(*) AS n FROM skills').get(),
    metrics,
    cases,
    selected_skill_bytes: Buffer.byteLength(JSON.stringify(content)),
    token_estimator: 'UTF-8 response bytes divided by 4, no tokenizer or measured model usage',
    model_selection: 'NOT VERIFIED',
    inference_usage: null,
    prices: null,
    limits:
      'Fixed synthetic labels; latency is one warm-database sample per query. No native semantic-selection claim.',
  });
});
