// One disposable SDK client process for offline verification; no agent login involved.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [project, db, agent, name, args] = process.argv.slice(2);
const entry = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
const client = new Client({ name: 'agentmind-offline-client', version: '0.0.1' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--project-root', project, '--db', db, '--source-agent', agent],
      cwd: project,
      stderr: 'inherit',
    }),
  );
  await client.ping();
  const result = await client.callTool({ name, arguments: JSON.parse(args) });
  if (result.isError) throw new Error('MCP call failed');
  process.stdout.write(result.content[0].text);
} catch {
  console.error('Offline MCP client failed.');
  process.exitCode = 1;
} finally {
  await client.close();
}
