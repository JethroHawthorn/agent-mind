import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentMindError } from '@agentmind/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DAILY_TOOLS } from './configuration.js';
import type { CodexSetup } from './setup.js';
/** Explicit opt-in connection: normal MCP startup can initialize/migrate the enrolled registry. */
export async function connectDoctor(setup: CodexSetup) {
  const record = setup.state();
  if (record?.phase !== 'installed')
    throw new AgentMindError('CODEX_NOT_ENROLLED', 'Complete setup before connecting.');
  const client = new Client({ name: 'agentmind-codex-doctor-SDK', version: '1' });
  const transport = new StdioClientTransport({
    command: setup.node,
    args: [setup.adapter, '--enrollment', record.enrollment],
    cwd: setup.root,
    stderr: 'pipe',
  });
  let runtimeCode: string | undefined;
  transport.stderr?.on('data', (b: Buffer) => {
    const m = String(b)
      .slice(0, 1024)
      .match(/\[agentmind\] ([A-Z][A-Z0-9_]+)/);
    if (m) runtimeCode = m[1];
  });
  const started = performance.now();
  const timeout = setTimeout(() => {
    void transport.close();
  }, 10000);
  timeout.unref();
  try {
    await client.connect(transport);
    const connection_ms = performance.now() - started;
    await client.ping();
    const result = await client.callTool({ name: 'agentmind_status', arguments: {} });
    if (result.isError)
      throw new AgentMindError('CODEX_HEALTH_FAILED', 'MCP health request failed.');
    const content = result.content as { type: string; text?: string }[];
    const status = JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null');
    if (status?.project_id !== setup.status().project_id)
      throw new AgentMindError('CODEX_SCOPE_DENIED', 'MCP returned a different project identity.');
    const tools = (await client.listTools()).tools;
    if (
      tools.some((t) =>
        ['skill_approve', 'skill_promote', 'distribution_sync', 'review_decide'].includes(t.name),
      )
    )
      throw new AgentMindError('CODEX_PRIVILEGED_TOOL', 'Unexpected privileged MCP capability.');
    const selected = tools.filter((t) => (DAILY_TOOLS as readonly string[]).includes(t.name));
    const queue = await client.callTool({ name: 'review_queue', arguments: { limit: 5 } });
    return {
      evidence: 'MCP_SDK_VERIFIED; not authenticated native Codex',
      connection_ms,
      health: status,
      startup_health_tools_ms: performance.now() - started,
      enabled_tool_count: selected.length,
      enabled_schema_bytes: Buffer.byteLength(JSON.stringify(selected)),
      queue_available: !queue.isError,
      review_command: [
        setup.node,
        join(dirname(dirname(setup.adapter)), 'learning-review.js'),
        '--project-root',
        setup.root,
        '--db',
        setup.database,
        '--list',
        '--json',
      ],
    };
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
    throw new AgentMindError(
      'CODEX_MCP_START_FAILED',
      `Cannot connect to the enrolled MCP runtime (${runtimeCode ?? 'CONNECTION_CLOSED'}). Check scope, build and local database access.`,
    );
  } finally {
    clearTimeout(timeout);
    await client.close();
    await transport.close();
  }
}
