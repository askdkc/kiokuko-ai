import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function responseBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolNames = tools
    .map((tool) => tool?.function?.name ?? tool?.name)
    .filter((name) => typeof name === 'string');
  const calledNames = messages
    .flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map((call) => call?.function?.name)
    .filter((name) => typeof name === 'string');
  const taskPrepare = toolNames.find((name) => /(?:^|_)task_prepare$/u.test(name));
  if (calledNames.length === 0 && taskPrepare !== undefined) {
    return {
      toolCalls: [{
        id: 'fixture-task-prepare-1',
        type: 'function',
        function: {
          name: taskPrepare,
          arguments: JSON.stringify({
            soulRead: true,
            requestId: 'fixture-request-1',
            task: 'Run the deterministic OpenCode host contract check.',
            profileHints: { taskType: 'build', target: 'host contract', expected: 'the host contract passes' },
            capabilities: toolNames.map((name) => ({ kind: 'mcp_tool', name })),
            maxContextChars: 12000,
          }),
        },
      }],
    };
  }
  return { text: 'fixture provider completed the OpenCode host contract.' };
}

function completion(body, sequence) {
  const response = responseBody(body);
  const id = `fixture-completion-${sequence}`;
  if (response.toolCalls !== undefined) {
    return {
      id,
      object: 'chat.completion',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', tool_calls: response.toolCalls }, finish_reason: 'tool_calls' }],
    };
  }
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: response.text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function streamCompletion(value) {
  const content = value.choices?.[0]?.message?.content ?? '';
  const toolCalls = value.choices?.[0]?.message?.tool_calls;
  const chunks = [
    {
      id: value.id,
      object: 'chat.completion.chunk',
      created: value.created,
      model: value.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
  ];
  if (toolCalls !== undefined) {
    chunks.push({
      id: value.id,
      object: 'chat.completion.chunk',
      created: value.created,
      model: value.model,
      choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
    });
  } else if (content.length > 0) {
    chunks.push({
      id: value.id,
      object: 'chat.completion.chunk',
      created: value.created,
      model: value.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  }
  chunks.push({
    id: value.id,
    object: 'chat.completion.chunk',
    created: value.created,
    model: value.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  return chunks;
}

export async function startFakeOpenAiServer() {
  const stats = { models: 0, chatCompletions: 0, taskPrepareResponses: 0, requestDigests: [] };
  let sequence = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      stats.models += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'kiokuko' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    stats.chatCompletions += 1;
    stats.requestDigests.push(digest(raw));
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      response.writeHead(400).end();
      return;
    }
    sequence += 1;
    const value = completion(body, sequence);
    if (value.choices?.[0]?.message?.tool_calls?.some((call) => /(?:^|_)task_prepare$/u.test(call?.function?.name ?? ''))) {
      stats.taskPrepareResponses += 1;
    }
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const chunk of streamCompletion(value)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a TCP port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    stats,
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
