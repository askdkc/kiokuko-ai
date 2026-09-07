import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Keep the stdio session open through the handshake and response, then reap it. */
async function withMcpProbe({ cliScript, environment, cwd, timeoutMs = 45_000 }, label, operation) {
  const client = new Client({ name: 'opencode', version: 'host-e2e' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliScript, 'mcp'],
    cwd,
    env: environment,
    stderr: 'ignore',
    maxBufferSize: 8 * 1024 * 1024,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const options = { timeout: timeoutMs, signal: controller.signal };
  try {
    await client.connect(transport, options);
    return await operation(client, options);
  } catch (error) {
    // Keep remote response bodies and local paths out of CI diagnostics.
    const code = typeof error?.code === 'number' ? error.code : 'transport';
    throw new Error(`MCP ${label} failed (${code})`);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

export function probeMcpTools(options) {
  return withMcpProbe(options, 'tools/list', async (client, requestOptions) => {
    const result = await client.listTools(undefined, requestOptions);
    return result.tools;
  });
}

export function callMcpTool(options, name, argumentsValue) {
  return withMcpProbe(options, name, async (client, requestOptions) => {
    const result = await client.callTool({ name, arguments: argumentsValue }, undefined, requestOptions);
    if (result.isError === true) throw new Error('Tool returned an error');
    return result.structuredContent ?? result;
  });
}
