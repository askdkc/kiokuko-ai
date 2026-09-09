import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Oversized synthetic control result for the real host's truncation test.
const server = new McpServer({ name: 'presentation-fixture', version: '1.0.0' });
server.registerTool('output', { inputSchema: { format: z.enum(['pretty', 'compact']) } }, async ({ format }) => {
  const value = { runId: 'AUDIT_PREFIX', body: 'あ '.repeat(14000), directive: 'AUDIT_REQUIRED_TAIL' };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, format === 'pretty' ? 2 : undefined) }], structuredContent: value };
});
await server.connect(new StdioServerTransport());
