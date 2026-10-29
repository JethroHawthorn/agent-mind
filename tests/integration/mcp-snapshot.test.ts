import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const { z } = createRequire(resolve('packages/core/package.json'))('zod');

import { agentOperations, authoringSubmitSchema } from '../../packages/core/src/index.js';
import { DAILY_TOOLS } from '../../packages/mcp-server/src/codex/configuration.js';
import { installerFixture } from '../helpers/installer-fixture.js';

it('measures real stdio tool surfaces with controlled project/config and no native model', async () => {
  const f = installerFixture(),
    snapshots: Record<string, unknown> = {};
  const measure = (tools: unknown[]) => {
    const values = tools as Array<{
      name: string;
      inputSchema: unknown;
      description?: string;
      outputSchema?: unknown;
    }>;
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    return {
      count: tools.length,
      total_bytes: bytes,
      input_schema_bytes: values.reduce(
        (n, t) => n + Buffer.byteLength(JSON.stringify(t.inputSchema)),
        0,
      ),
      output_schema_bytes: values.reduce(
        (n, t) => n + (t.outputSchema ? Buffer.byteLength(JSON.stringify(t.outputSchema)) : 0),
        0,
      ),
      description_bytes: values.reduce((n, t) => n + Buffer.byteLength(t.description ?? ''), 0),
      estimated_tokens_byte_div4: Math.ceil(bytes / 4),
      tool_list_sha256: createHash('sha256').update(JSON.stringify({ tools })).digest('hex'),
      tools,
    };
  };
  try {
    f.service.apply(f.service.plan('setup'));
    for (const name of ['standalone-default', 'standalone-all', 'codex', 'claude', 'gemini']) {
      const native = ['codex', 'claude', 'gemini'].includes(name);
      const entry = native
        ? resolve(`packages/mcp-server/dist/${name}/adapter.js`)
        : resolve('packages/mcp-server/dist/index.js');
      const args = native
        ? [entry, '--enrollment', join(f.root, `.agentmind/${name}/enrollment.json`)]
        : [
            entry,
            '--project-root',
            f.root,
            '--db',
            f.options.database,
            ...(name === 'standalone-all'
              ? [
                  '--enable-learning',
                  '--enable-authoring',
                  '--enable-retrieval',
                  '--enable-curator',
                ]
              : []),
          ];
      const client = new Client({ name: 'offline-contract-snapshot', version: '1' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        cwd: f.root,
        env: { PATH: process.env.PATH ?? '', HOME: f.home, NO_COLOR: '1' },
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        const tools = (await client.listTools()).tools;
        snapshots[name] = measure(tools);
        expect(tools.length).toBeGreaterThan(0);
        if (native) expect(tools.map((t) => t.name).sort()).toEqual([...DAILY_TOOLS].sort());
        for (const tool of tools) {
          if (['curator_analyze', 'agentmind_status'].includes(tool.name)) continue;
          expect(Object.keys(tool.inputSchema.properties ?? {}).length, tool.name).toBeGreaterThan(
            0,
          );
        }
      } finally {
        await client.close();
        await transport.close();
      }
    }
    const expanded = z.toJSONSchema(authoringSubmitSchema, { io: 'input' });
    const report = {
      schema_version: 1,
      method: 'ACTUAL_STDIO_SDK_LIST_TOOLS_WITH_PUBLIC_PROVIDER_DOUBLES_NO_NATIVE_MODEL_OR_OS_AUTH',
      serialization:
        'UTF8 JSON.stringify({tools}) SDK ordering; estimated tokens=Math.ceil(bytes/4), not measured tokenizer/model tokens',
      sdk_version: 'installed lockfile',
      daily_profile_count: DAILY_TOOLS.length,
      broker_allowlist_count: agentOperations.length,
      expanded_authoring_schema_bytes: Buffer.byteLength(JSON.stringify(expanded)),
      expanded_authoring_schema: expanded,
      surfaces: snapshots,
    };
    if (process.env.AGENTMIND_MCP_SNAPSHOT_OUTPUT)
      writeFileSync(
        process.env.AGENTMIND_MCP_SNAPSHOT_OUTPUT,
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
  } finally {
    f.cleanup();
  }
}, 60000);
