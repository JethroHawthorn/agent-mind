import { join } from 'node:path';
import { AgentMindError, SCHEMA_VERSION } from '@agentmind/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DAILY_TOOLS } from '../codex/configuration.js';
import { readBounded } from '../codex/files.js';
import { type Diagnostic, diagnostic, type Provider } from './model.js';
import type { UnifiedInstaller } from './service.js';
/** Opt-in SDK probe. No model/authentication; normal server startup can initialize its enrolled DB. */
export async function runtimeDoctor(
  service: UnifiedInstaller,
  id: Provider,
  timeoutMs = 10000,
): Promise<Diagnostic[]> {
  const c = service.context,
    report: Diagnostic[] = [];
  const inspected = service.adapters[id].inspect();
  if (
    inspected.state !== 'CONFIGURED' &&
    !(
      id === 'claude' &&
      c.scope === 'user' &&
      inspected.managed &&
      inspected.router === 'MANAGED_CURRENT'
    )
  )
    return [
      diagnostic(
        `${id}.runtime`,
        'FAIL',
        'A current managed installation is required before the runtime probe.',
        id,
      ),
    ];
  const client = new Client({ name: 'agentmind-unified-doctor', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [c.adapters[id], '--enrollment', join(c.root, `.agentmind/${id}/enrollment.json`)],
    cwd: c.root,
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: c.home, LANG: 'C' },
  });
  transport.stderr?.on('data', () => {
    /* Drain bounded SDK diagnostics without reflecting untrusted stderr. */
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const start = performance.now();
  try {
    const work = async () => {
      const enrollment = JSON.parse(
        readBounded(c.root, join(c.root, `.agentmind/${id}/enrollment.json`), 4096) ?? 'null',
      );
      if (enrollment?.database !== c.database || enrollment?.project_id !== service.project.id)
        throw Error('registry binding');
      await client.connect(transport);
      await client.ping();
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      if (
        names.length !== DAILY_TOOLS.length ||
        new Set(names).size !== names.length ||
        names.some((n) =>
          /approve|promote|rollback|deactivate|distribution_sync|review_decide/.test(n),
        ) ||
        DAILY_TOOLS.some((n) => !names.includes(n)) ||
        tools.some((t) => t.inputSchema?.type !== 'object')
      )
        throw Error('schema');
      const result = await client.callTool({ name: 'agentmind_status', arguments: {} });
      if (result.isError) throw Error('health');
      const s = JSON.parse((result.content as { text?: string }[])[0]?.text ?? 'null');
      if (
        s.ok !== true ||
        s.project_id !== service.project.id ||
        s.source_agent !== id ||
        s.schema_version !== SCHEMA_VERSION
      )
        throw Error('scope');
      report.push({
        ...diagnostic(
          `${id}.mcp-health-tools`,
          'PASS',
          `SDK handshake, health/scope and daily tool schemas verified in ${(performance.now() - start).toFixed(1)} ms. This is not native CLI discovery.`,
          id,
        ),
        evidence: 'OFFLINE_RUNTIME',
      });
      const r = await client.callTool({
        name: 'skill_route',
        arguments: {
          selection_cards: true,
          context: { summary: 'agentmind diagnostic unmatched sentinel' },
        },
      });
      if (r.isError) throw Error('retrieval');
      report.push({
        ...diagnostic(
          `${id}.retrieval-smoke`,
          'PASS',
          'Bounded read-only routing request completed; no skill content or task success is inferred.',
          id,
        ),
        evidence: 'OFFLINE_RUNTIME',
      });
    };
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void transport.close();
          reject(new AgentMindError('INSTALLER_PROBE_TIMEOUT', 'MCP probe timed out.'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    report.push({
      ...diagnostic(
        `${id}.runtime`,
        'FAIL',
        'MCP probe failed or timed out. Inspect enrollment, scope, schema and registry permissions; raw process output is suppressed.',
        id,
      ),
      evidence: 'OFFLINE_RUNTIME',
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await client.close();
      await transport.close();
    } catch {
      report.push(
        diagnostic(
          `${id}.shutdown`,
          'FAIL',
          'SDK transport shutdown did not complete cleanly.',
          id,
        ),
      );
    }
  }
  return report;
}
