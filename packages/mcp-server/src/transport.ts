import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/** Explicit local transport budget; public schemas constrain individual operations further.
 * This is a buffer bound, not authentication, rate limiting or an execution sandbox.
 */
export const MCP_BUFFER_BYTES = 2 * 1024 * 1024;
export function createMcpTransport() {
  return new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MCP_BUFFER_BYTES,
  });
}
