import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const entry = resolve('packages/mcp-server/dist/index.js');
const reviewEntry = resolve('packages/mcp-server/dist/review.js');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmind-experience-mcp-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  return { a, b, db: join(dir, 'shared.db') };
}
const input = {
  problem: 'Orchid SQLite concurrent startup fails',
  solution: 'Retry journal mode setup on SQLite busy errors',
  outcome: { status: 'succeeded', summary: 'The local concurrency fixture passed.' },
  evidence: [{ kind: 'test', reference: 'tests/integration/experience-mcp.test.ts' }],
};
async function connect(root: string, db: string, agent: string, disabled = false) {
  const client = new Client({ name: `${agent}-compatible-sdk-client`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    cwd: root,
    stderr: 'pipe',
    args: [
      entry,
      '--project-root',
      root,
      '--db',
      db,
      '--source-agent',
      agent,
      ...(disabled ? ['--disable-experience-capture'] : []),
    ],
  });
  let logs = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, logs: () => logs };
}
function data(result: Awaited<ReturnType<Client['callTool']>>) {
  const first = (result.content as Array<{ type: string; text: string }>)[0];
  if (first?.type !== 'text') throw new Error('Expected MCP text');
  return JSON.parse(first.text);
}
function localReview(
  root: string,
  db: string,
  saved: { id: string; updated_at: string },
  decision: string,
) {
  return spawnSync(
    process.execPath,
    [
      reviewEntry,
      '--project-root',
      root,
      '--db',
      db,
      '--id',
      saved.id,
      '--decision',
      decision,
      '--expected-updated-at',
      saved.updated_at,
      '--reviewer',
      'local tester',
      '--reason',
      'Reviewed the referenced test fixture.',
    ],
    { cwd: root, encoding: 'utf8', timeout: 10000 },
  );
}

describe('experience MCP interoperability (SDK clients, not native agent sessions)', () => {
  it('keeps the top MCP match under the minimum response budget', async () => {
    const { a, db } = fixture();
    const { client } = await connect(a, db, 'claude');
    const saved = data(
      await client.callTool({
        name: 'experience_record',
        arguments: {
          ...input,
          problem: `Orchid ${'problem '.repeat(100)}`,
          solution: `Retry ${'solution '.repeat(150)}`,
          evidence: [{ kind: 'note', reference: 'r'.repeat(512), summary: 's'.repeat(512) }],
        },
      }),
    ).experience;
    const result = data(
      await client.callTool({
        name: 'experience_search',
        arguments: { query: 'Orchid', max_chars: 1024 },
      }),
    );
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]).toMatchObject({
      id: saved.id,
      approval_status: 'candidate',
      verification_status: 'unverified',
      content_truncated: true,
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1024);
  });
  it('records in one client OS process and retrieves after restart in another', () => {
    const { a, b, db } = fixture();
    const call = (root: string, agent: string, name: string, args: object) => {
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/mcp-call.mjs'), root, db, agent, name, JSON.stringify(args)],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(result.status, result.stderr).toBe(0);
      return { pid: result.pid, data: JSON.parse(result.stdout) };
    };
    const saved = call(a, 'codex', 'experience_record', input);
    const found = call(a, 'claude', 'experience_search', { query: 'Orchid SQLite' });
    expect(saved.pid).not.toBe(found.pid);
    expect(found.data.experiences[0]).toMatchObject({
      id: saved.data.experience.id,
      source_agent: 'codex',
      approval_status: 'candidate',
      verification_status: 'unverified',
    });
    expect(
      call(b, 'claude', 'experience_search', { query: 'Orchid SQLite' }).data.experiences,
    ).toEqual([]);
    expect(call(b, 'claude', 'experience_record', input).data.possible_duplicates).toEqual([]);
  });
  it('serializes concurrent duplicate detection and keeps approved content intact', async () => {
    const { a, db } = fixture();
    const [codex, claude] = await Promise.all([connect(a, db, 'codex'), connect(a, db, 'claude')]);
    const results = await Promise.all(
      [codex.client, claude.client].map(async (client) =>
        data(await client.callTool({ name: 'experience_record', arguments: input })),
      ),
    );
    expect(results.map((item) => item.possible_duplicates.length).sort()).toEqual([0, 1]);
    const original = results[0].experience;
    const approved = localReview(a, db, original, 'approved');
    expect(approved.status, approved.stderr).toBe(0);
    expect(JSON.parse(approved.stdout).experience.id).toBe(original.id);
    expect(approved.stderr).toBe('');
    const third = data(
      await claude.client.callTool({ name: 'experience_record', arguments: input }),
    );
    expect(
      third.possible_duplicates.some(
        (item: { experience: { id: string; approval_status: string } }) =>
          item.experience.id === original.id && item.experience.approval_status === 'approved',
      ),
    ).toBe(true);
    const found = data(
      await codex.client.callTool({
        name: 'experience_search',
        arguments: { query: 'Orchid', status: 'approved' },
      }),
    );
    expect(found.experiences[0]).toMatchObject({
      id: original.id,
      solution: original.solution,
      verification_status: 'unverified',
    });
  });
  it('denies forged scope, status, transcript fields and MCP approval capability', async () => {
    const { a, db } = fixture();
    const { client } = await connect(a, db, 'claude');
    for (const extra of [
      { project_id: 'other' },
      { project_key: 'other' },
      { approval_status: 'approved' },
      { source_agent: 'codex' },
      { transcript: 'raw' },
    ]) {
      expect(
        (await client.callTool({ name: 'experience_record', arguments: { ...input, ...extra } }))
          .isError,
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: 'experience_search',
          arguments: { query: 'Orchid', scope: 'global' },
        })
      ).isError,
    ).toBe(true);
    expect((await client.callTool({ name: 'experience_review', arguments: {} })).isError).toBe(
      true,
    );
    expect(
      data(await client.callTool({ name: 'experience_search', arguments: { query: 'Orchid' } }))
        .experiences,
    ).toEqual([]);
    await client.ping();
  });
  it('redacts before returning results and never logs the secret', async () => {
    const { a, db } = fixture();
    const { client, logs } = await connect(a, db, 'codex');
    const secret = `sk-proj-${'s'.repeat(24)}`;
    const saved = data(
      await client.callTool({
        name: 'experience_record',
        arguments: { ...input, solution: `Rotate ${secret}` },
      }),
    );
    expect(saved.experience.redacted).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);
    const found = data(
      await client.callTool({ name: 'experience_search', arguments: { query: 'Orchid' } }),
    );
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(logs()).not.toContain(secret);
    expect(
      (
        await client.callTool({
          name: 'experience_record',
          arguments: { ...input, solution: 'x'.repeat(4001) },
        })
      ).isError,
    ).toBe(true);
  });
  it('disables experience capture while retaining retrieval and Phase 0 tools', async () => {
    const { a, db } = fixture();
    const { client } = await connect(a, db, 'claude', true);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'experience_search',
      'memory_save',
      'memory_search',
      'skill_get',
      'skill_list',
      'skill_propose',
      'skill_search',
      'skill_validate',
    ]);
    expect((await client.callTool({ name: 'experience_record', arguments: input })).isError).toBe(
      true,
    );
    expect(
      (
        await client.callTool({
          name: 'memory_save',
          arguments: { title: 'Phase zero', content: 'Preserved memory save' },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      data(await client.callTool({ name: 'experience_search', arguments: { query: 'Orchid' } }))
        .experiences,
    ).toEqual([]);
  });
  it('limits human review to the trusted root and rejects stale reviews', async () => {
    const { a, b, db } = fixture();
    const { client } = await connect(a, db, 'codex');
    const saved = data(
      await client.callTool({ name: 'experience_record', arguments: input }),
    ).experience;
    const denied = localReview(b, db, saved, 'approved');
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('EXPERIENCE_NOT_FOUND');
    const approved = localReview(a, db, saved, 'approved');
    expect(approved.status).toBe(0);
    const stale = localReview(a, db, saved, 'rejected');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('STALE_REVIEW');
    const approvedExperience = JSON.parse(approved.stdout).experience;
    expect(localReview(a, db, approvedExperience, 'rejected').status).toBe(0);
    expect(
      data(await client.callTool({ name: 'experience_search', arguments: { query: 'Orchid' } }))
        .experiences,
    ).toEqual([]);
    const inspected = spawnSync(
      process.execPath,
      [reviewEntry, '--project-root', a, '--db', db, '--inspect', saved.id],
      { cwd: a, encoding: 'utf8' },
    );
    expect(inspected.status).toBe(0);
    expect(inspected.stderr).toBe('');
    expect(JSON.parse(inspected.stdout).experience.approval_status).toBe('rejected');
  });
});
