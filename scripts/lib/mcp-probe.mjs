import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Only repository-defined public codes are allowed into CI messages. Unknown
// codes, response text, exception messages, data, paths and stderr stay private.
const publicToolCodes = new Set([
  'USAGE_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'DATABASE_ERROR',
  'BACKPRESSURE', 'SERVICE_UNAVAILABLE', 'SECURITY_REJECTION', 'AUTHENTICATION_ERROR',
  'INTEGRITY_ERROR', 'PARTIAL_FAILURE', 'NOT_IMPLEMENTED', 'UNSUPPORTED_CLIENT',
  'MCP_REQUEST_TIMEOUT', 'MCP_REQUEST_CANCELLED', 'CHECKPOINT_RUN_NOT_ACTIVE',
  'PLAN_START_RECOVERY_REQUIRED', 'ENNO_INPUT_INVALID',
]);
const spawnCodes = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR']);
class ProbeFailure extends Error {
  constructor(label, diagnostic) {
    super(`MCP ${label} failed (${diagnostic.code ?? diagnostic.kind}) ${JSON.stringify(diagnostic)}`);
    this.diagnostic = Object.freeze(diagnostic);
  }
}
function toolDiagnostic(result) {
  const diagnostic = { kind: 'tool-error', phase: 'request' };
  const data = result.structuredContent;
  if (publicToolCodes.has(data?.code)) diagnostic.code = data.code;
  if (typeof data?.retryable === 'boolean') diagnostic.retryable = data.retryable;
  return diagnostic;
}

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
  let phase = 'connect';
  try {
    await client.connect(transport, options);
    phase = 'request';
    return await operation(client, options);
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    const code = error?.code;
    const kind = controller.signal.aborted || code === ErrorCode.RequestTimeout ? 'timeout'
      : phase === 'connect' && spawnCodes.has(code) ? 'spawn-error'
      : code === ErrorCode.ConnectionClosed ? 'connection-closed'
      : Number.isSafeInteger(code) ? 'protocol-error' : 'transport-error';
    const diagnostic = { kind, phase };
    if (Number.isSafeInteger(code) || (kind === 'spawn-error' && spawnCodes.has(code))) diagnostic.code = code;
    throw new ProbeFailure(label, diagnostic);
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
    if (result.isError === true) {
      options.onToolError?.(result.content);
      throw new ProbeFailure(name, toolDiagnostic(result));
    }
    return result.structuredContent ?? result;
  });
}
