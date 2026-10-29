import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { expect, it } from 'vitest';
import { agentOperations } from '../../packages/core/src/index.js';
import { createBrokerMcpServer } from '../../packages/mcp-server/src/broker-mcp.js';
import { DAILY_TOOLS } from '../../packages/mcp-server/src/codex/configuration.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';
import { installerFixture } from '../helpers/installer-fixture.js';

function required<T>(value: T | undefined | null): T {
  if (value == null) throw Error('Required test fixture absent');
  return value;
}
const forbidden = [
  'skill_approve',
  'skill_promote',
  'skill_rollback',
  'distribution_sync',
  'db_restore',
  'operator_grant',
  'evaluation_record',
  'broker_policy_set',
];
const hidden = [
  'skill_propose',
  'skill_get',
  'skill_list',
  'curator_analyze',
  'curator_duplicates',
  'learning_signal_detect',
  'learning_signal_refresh',
  'learning_signal_recommend',
];
const validator = new AjvJsonSchemaValidator();
async function denied(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    expect((await c.callTool({ name, arguments: args })).isError).toBe(true);
  } catch (e) {
    expect(String(e)).toMatch(/not found|disabled|Unknown tool|Invalid parameters/i);
  }
}
it.each(['codex', 'claude', 'gemini'])(
  '%s enforces daily visibility and direct denial with structured, scoped results',
  async (provider) => {
    const f = installerFixture();
    const c = new Client({ name: 'offline-hardening', version: '1' });
    try {
      f.service.apply(f.service.plan('setup'));
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            resolve(`packages/mcp-server/dist/${provider}/adapter.js`),
            '--enrollment',
            join(f.root, `.agentmind/${provider}/enrollment.json`),
          ],
          cwd: f.root,
          env: { PATH: process.env.PATH ?? '', HOME: f.home },
          stderr: 'pipe',
        }),
      );
      const list = (await c.listTools()).tools;
      expect(list.map((t) => t.name).sort()).toEqual([...DAILY_TOOLS].sort());
      for (const t of list) {
        expect(t.outputSchema?.properties).toBeDefined();
        if (t.name !== 'agentmind_status')
          expect(Object.keys(t.inputSchema.properties ?? {}).length, t.name).toBeGreaterThan(0);
      }
      const saved = await c.callTool({
        name: 'memory_save',
        arguments: {
          title: 'Synthetic project decision',
          content: 'Preserve numeric zero and project boundaries.',
        },
      });
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent).toEqual(
        JSON.parse(required((saved.content as { text: string }[])[0]).text),
      );
      const out = required(list.find((t) => t.name === 'memory_save')?.outputSchema);
      expect(validator.getValidator(out)(saved.structuredContent).valid).toBe(true);
      for (const name of [...hidden, ...forbidden]) await denied(c, name);
      await denied(c, 'experience_record', {
        problem: 'Synthetic issue',
        solution: 'Synthetic solution',
        outcome: 'success',
      });
      await denied(c, 'skill_route', { context: 'please fix it' });
      const status = await c.callTool({ name: 'agentmind_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({
        mode: 'supervised-local',
        protected_deployment: 'NOT VERIFIED',
        autonomous_activation: 'NO-GO',
      });
      const found = await c.callTool({
        name: 'memory_search',
        arguments: { query: 'numeric zero' },
      });
      expect((found.structuredContent as { memories: unknown[] }).memories).toHaveLength(1);
    } finally {
      await c.close();
      f.cleanup();
    }
  },
  30000,
);

it.each([false, true])(
  'broker factory preserves its fixed agent operation boundary; restricted=%s',
  async (restricted) => {
    let calls = 0;
    const server = createBrokerMcpServer(
      {} as never,
      (async () => {
        calls++;
        return {
          memory: {
            id: 'synthetic',
            project_id: 'fixture',
            title: 'fixture',
            content: 'fixture',
            kind: 'note',
            source_agent: 'codex',
            status: 'unverified',
            created_at: 'fixture',
          },
        };
      }) as never,
      restricted ? DAILY_TOOLS : undefined,
    );
    const c = new Client({ name: 'broker-software-protocol-only', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await c.connect(b);
      const tools = (await c.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(
        (restricted
          ? agentOperations.filter((n) => (DAILY_TOOLS as readonly string[]).includes(n))
          : [...agentOperations]
        ).sort(),
      );
      expect(
        tools.find((t) => t.name === 'skill_authoring_submit')?.inputSchema.properties,
      ).toHaveProperty('type');
      expect(tools.filter((t) => t.outputSchema)).toHaveLength(18);
      for (const name of forbidden) await denied(c, name);
      if (restricted) for (const name of hidden) await denied(c, name);
      expect(calls).toBe(0);
      const result = await c.callTool({
        name: 'memory_save',
        arguments: { title: 'test', content: 'test' },
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toBe(1);
    } finally {
      await c.close();
      await server.close();
    }
  },
);

it('broker rejects malformed successful output without returning forged evidence or private contents', async () => {
  const server = createBrokerMcpServer(
    {} as never,
    async () => ({ PASS: true, secret: 'synthetic-private-canary' }) as never,
  );
  const c = new Client({ name: 'invalid-output', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await c.connect(b);
    const r = await c.callTool({ name: 'memory_search', arguments: { query: 'test' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('synthetic-private-canary');
  } finally {
    await c.close();
    await server.close();
  }
});

it.each(['CREATE_NEW', 'PATCH_EXISTING', 'REWRITE_EXISTING'])(
  '%s advertised schema and strict handler agree; invalid variants never persist',
  async (operation) => {
    const f = authoringFixture(operation !== 'CREATE_NEW');
    const c = new Client({ name: 'schema-parity', version: '1' });
    try {
      await c.connect(
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
          ],
          cwd: f.root,
          stderr: 'pipe',
        }),
      );
      const tools = (await c.listTools()).tools;
      const tool = required(tools.find((t) => t.name === 'skill_authoring_submit'));
      const valid = validator.getValidator(tool.inputSchema);
      let input = f.draft();
      if (operation !== 'CREATE_NEW') input = f.patch();
      if (operation === 'REWRITE_EXISTING') {
        input.type = operation;
        input.files = f.store.getVersion(required(f.base)).version.files.map((file) => ({
          path: file.path,
          content:
            file.content +
            (file.path === 'SKILL.md'
              ? '\nCheck bounded retry exhaustion before reporting success.\n'
              : ''),
        }));
        delete input.operations;
      }
      expect(valid(input).valid).toBe(true);
      for (const change of [
        { name: undefined },
        { type: 'INVALID' },
        { context_digest: 'bad' },
        { files: [{ path: '../escape', content: 'bad' }] },
        { approve: true },
        { description: 'x'.repeat(2000) },
      ]) {
        const bad = JSON.parse(JSON.stringify({ ...input, ...change }));
        expect(valid(bad).valid).toBe(false);
        await denied(c, 'skill_authoring_submit', bad);
      }
      if (operation !== 'CREATE_NEW') {
        for (const change of [
          { expected_base_digest: 'a'.repeat(64) },
          { target_version_id: randomUUID() },
          { target_skill_id: randomUUID() },
        ]) {
          const r = await c.callTool({
            name: 'skill_authoring_submit',
            arguments: { ...input, ...change },
          });
          expect(r.isError).toBe(true);
        }
      }
      expect(f.service.list().proposals).toHaveLength(0);
      const result = await c.callTool({ name: 'skill_authoring_submit', arguments: input });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.type).toBe(operation);
      expect(data.candidate_state).toBe('candidate');
      expect(validator.getValidator(required(tool.outputSchema))(data).valid).toBe(true);
      const duplicate = await c.callTool({ name: 'skill_authoring_submit', arguments: input });
      expect(duplicate.structuredContent).toMatchObject({
        proposal_id: data.proposal_id,
        content_digest: data.content_digest,
      });
      expect(f.service.list().proposals).toHaveLength(1);
      const get = required(tools.find((t) => t.name === 'skill_get'));
      const getValid = validator.getValidator(get.inputSchema);
      expect(getValid({ version_id: randomUUID() }).valid).toBe(true);
      expect(getValid({ name: 'example' }).valid).toBe(true);
      expect(getValid({}).valid).toBe(false);
      expect(getValid({ name: 'example', version_id: randomUUID() }).valid).toBe(false);
    } finally {
      await c.close();
      f.close();
    }
  },
  30000,
);

it('checks all 18 core daily success contracts and bounded response measurements through real stdio', async () => {
  const f = authoringFixture(true),
    c = new Client({ name: 'daily-contract-results', version: '1' });
  const measurements: Record<string, unknown> = {};
  try {
    await c.connect(
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
          '--enable-learning',
          '--enable-authoring',
          '--enable-retrieval',
        ],
        cwd: f.root,
        stderr: 'pipe',
      }),
    );
    const tools = (await c.listTools()).tools;
    async function call(name: string, input: Record<string, unknown>) {
      const r = await c.callTool({ name, arguments: input });
      expect(r.isError, JSON.stringify(r)).not.toBe(true);
      const data = required(r.structuredContent) as Record<string, unknown>;
      expect(data).toEqual(JSON.parse(required((r.content as { text: string }[])[0]).text));
      expect(
        validator.getValidator(required(tools.find((t) => t.name === name)?.outputSchema))(data)
          .valid,
        name,
      ).toBe(true);
      measurements[name] = {
        payload_bytes: Buffer.byteLength(JSON.stringify(data)),
        wire_result_bytes: Buffer.byteLength(JSON.stringify(r)),
        estimated_payload_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(data)) / 4),
      };
      return data;
    }
    await call('skill_authoring_context', f.contextRequest);
    const proposal = await call('skill_authoring_submit', f.patch());
    const proposal_id = proposal.proposal_id;
    await call('skill_authoring_get', { proposal_id });
    await call('skill_authoring_diff', { proposal_id });
    await call('skill_authoring_diff', { proposal_id, path: 'SKILL.md' });
    await call('skill_authoring_evaluate', {
      proposal_id,
      expected_content_hash: proposal.content_digest,
      expected_state_revision: 0,
    });
    await call('review_queue', { limit: 5 });
    await call('review_get', { proposal_id });
    await call('memory_save', {
      title: 'Synthetic note',
      content: 'Bound SQLite startup retries.',
    });
    await call('memory_search', { query: 'SQLite' });
    const xp = await call('experience_record', {
      problem: 'Synthetic lock contention',
      solution: 'Use bounded retries.',
      outcome: { status: 'failed', summary: 'Reported fixture, not verified success.' },
    });
    await call('experience_search', { query: 'contention' });
    const signal = await call('learning_signal_record', {
      schema_version: 1,
      type: 'REPEATED_FAILURE',
      title: 'Lock contention',
      summary: 'Bounded retries need explicit exhaustion handling.',
      experience_ids: [(xp.experience as { id: string }).id],
      reusability: 'potentially_reusable',
    });
    await call('learning_signal_get', { signal_id: signal.id });
    const version = f.store.getVersion(required(f.base)).version;
    await call('skill_route', { context: { summary: 'sqlite startup' } });
    await call('skill_discover', { query: 'sqlite' });
    const pin = {
      skill_id: version.skill_id,
      expected_version_id: version.id,
      expected_digest: version.content_hash,
    };
    await call('skill_load', pin);
    await call('skill_resources', pin);
    await call('skill_resource_get', { ...pin, path: 'references/notes.md' });
    expect(Object.keys(measurements)).toHaveLength(18);
    if (process.env.AGENTMIND_MCP_RESPONSE_OUTPUT)
      writeFileSync(
        process.env.AGENTMIND_MCP_RESPONSE_OUTPUT,
        `${JSON.stringify({ classification: 'OFFLINE_STDIO_SYNTHETIC_APPROVED_HISTORY_NOT_OS_AUTH_OR_MODEL_USAGE', tokens: 'estimated UTF8 bytes /4; not actual model tokens', measurements }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
  } finally {
    await c.close();
    f.close();
  }
}, 30000);

it('dynamic status obeys an explicitly empty server-side profile', async () => {
  const f = installerFixture(),
    c = new Client({ name: 'empty-runtime-profile', version: '1' });
  try {
    const runtime = new URL(`file://${resolve('packages/mcp-server/dist/runtime.js')}`).href;
    const config = new URL(`file://${resolve('packages/mcp-server/dist/config.js')}`).href;
    const code = `import {startServer} from ${JSON.stringify(runtime)};import {readConfig} from ${JSON.stringify(config)};await startServer(readConfig(${JSON.stringify(['--project-root', f.root, '--db', f.options.database])}),true,[]);`;
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--input-type=module', '-e', code],
        cwd: f.root,
        stderr: 'pipe',
      }),
    );
    expect((await c.listTools()).tools).toEqual([]);
    await denied(c, 'agentmind_status');
    await denied(c, 'memory_save', { title: 'Denied', content: 'Denied' });
  } finally {
    await c.close();
    f.cleanup();
  }
}, 15000);
