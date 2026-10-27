import { AgentMindError } from '@agentmind/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { GeminiSetup } from './setup.js';

export async function connectGemini(setup: GeminiSetup) {
  if (
    !setup.status().installed ||
    setup.status().policy.blockers.length ||
    setup.status().policy.collisions.length
  )
    throw new AgentMindError('GEMINI_NOT_ENROLLED', 'Complete setup before connecting.');
  const client = new Client({ name: 'agentmind-gemini-doctor-SDK', version: '1' });
  const transport = new StdioClientTransport({
    command: setup.node,
    args: [setup.adapter, '--enrollment', setup.enrollment],
    cwd: setup.root,
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    void transport.close();
  }, 10000);
  timer.unref();
  const start = performance.now();
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'agentmind_status', arguments: {} });
    if (result.isError) throw Error('health');
    const status = JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null');
    if (status.project_id !== setup.status().project_id || status.source_agent !== 'gemini')
      throw Error('scope');
    const tools = (await client.listTools()).tools;
    return {
      evidence: 'MCP INTEGRATION VERIFIED; SDK, not native Gemini',
      health: status,
      connection_health_tools_ms: performance.now() - start,
      tool_count: tools.length,
      schema_bytes: Buffer.byteLength(JSON.stringify(tools)),
      native_execution: 'NOT VERIFIED',
    };
  } catch {
    throw new AgentMindError(
      'GEMINI_MCP_FAILED',
      'Cannot connect; check enrollment scope, build and SQLite access. No native execution was verified.',
    );
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}
