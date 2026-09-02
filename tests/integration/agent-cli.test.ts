import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { buildCli, runCli } from '../../src/cli.js';
import {
  createServerClient,
  type FetchImplementation,
  type ServerClient,
  type ServerRequest,
} from '../../src/client/server-client.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';
import {
  AGENT_MUTATION_OPERATIONS,
  agentRequestBindingHash,
  type AgentMutationOperation,
} from '../../src/server/routes/request-binding.js';

const token = 'a'.repeat(64);

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

interface OutputCapture {
  stdout: string;
  stderr: string;
}

const outputCaptureContext = new AsyncLocalStorage<OutputCapture>();
let outputCaptureLock: Promise<void> = Promise.resolve();

async function captureOutput<T>(operation: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const previousCapture = outputCaptureLock;
  let releaseCapture: (() => void) | undefined;
  outputCaptureLock = new Promise<void>((resolve) => { releaseCapture = resolve; });
  await previousCapture;
  const capture: OutputCapture = { stdout: '', stderr: '' };
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const active = outputCaptureContext.getStore();
    if (active === capture) {
      active.stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }
    return originalStdout.call(process.stdout, chunk as never);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const active = outputCaptureContext.getStore();
    if (active === capture) {
      active.stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }
    return originalStderr.call(process.stderr, chunk as never);
  }) as typeof process.stderr.write;
  try {
    const result = await outputCaptureContext.run(capture, operation);
    return { result, stdout: capture.stdout, stderr: capture.stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    releaseCapture?.();
  }
}

function parsed(output: string): Record<string, any> {
  assert.equal(output.endsWith('\n'), true);
  return JSON.parse(output) as Record<string, any>;
}

const syntheticProfile = {
  taskType: 'build',
  target: 'src/feature.ts',
  expected: 'focused tests pass',
  constraints: null,
} as const;
const syntheticProfileHash = createHash('sha256').update(JSON.stringify({
  constraints: syntheticProfile.constraints,
  expected: syntheticProfile.expected,
  target: syntheticProfile.target,
  taskType: syntheticProfile.taskType,
}), 'utf8').digest('hex');

function syntheticCapabilities(recommendations: unknown[] = []) {
  return {
    availability: 'unknown',
    catalogProvided: false,
    availableSkillCount: null,
    diagnostics: { received: 0, accepted: 0, truncated: 0, dropped: 0 },
    warnings: [],
    recommendations,
  };
}

function syntheticContext(throughSequence = 1) {
  return {
    deliveryId: 'synthetic-delivery',
    runId: 'synthetic-run',
    throughSequence,
    taskProfileHash: syntheticProfileHash,
    queryHash: 'b'.repeat(64),
    policyVersion: 'context-ranking-v1+recommendations.v1',
    items: [],
    untrusted: true,
  };
}

function syntheticIntakeResponse(input: {
  memoryContextWithheld?: boolean;
  requiredCapabilityUnavailable?: boolean;
  needsAnswer?: boolean;
} = {}) {
  const memoryContextWithheld = input.memoryContextWithheld ?? false;
  const needsAnswer = input.needsAnswer ?? false;
  const requiredCapabilityUnavailable = input.requiredCapabilityUnavailable ?? false;
  const profile = needsAnswer
    ? { taskType: null, target: null, expected: null, constraints: null }
    : syntheticProfile;
  const question = needsAnswer
    ? {
      id: 'taskType',
      prompt: 'この作業の主目的はどれですか？',
      options: ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'],
      required: true,
    }
    : null;
  const capabilities = requiredCapabilityUnavailable
    ? {
      availability: 'unknown',
      catalogProvided: false,
      availableSkillCount: null,
      diagnostics: { received: 0, accepted: 0, truncated: 0, dropped: 0 },
      warnings: [],
      recommendations: [{
        kind: 'skill',
        name: 'kiokuko-soul',
        availability: 'unknown',
        reason: 'Non-trivial Kiokuko work must begin from the master routing Skill.',
        source: 'akinator_policy',
        required: true,
      }],
    }
    : memoryContextWithheld
      ? syntheticCapabilities([{
        kind: 'skill',
        name: 'memory-reasoning',
        availability: 'unknown',
        reason: 'Relevant stored memory requires the explicit reasoning workflow.',
        source: 'akinator_policy',
        required: true,
      }])
      : syntheticCapabilities();
  return {
    runId: 'synthetic-run',
    runStatus: needsAnswer ? 'intake' : 'active',
    intakeSessionId: 'synthetic-session',
    intakeStatus: needsAnswer ? 'needs_answer' : 'ready',
    intake: { status: needsAnswer ? 'needs_answer' : 'ready', sessionId: 'synthetic-session', question },
    question,
    currentQuestion: question,
    missingFields: needsAnswer ? ['taskType', 'target', 'expected'] : [],
    recommendedTags: needsAnswer ? ['bot:common'] : ['bot:builder', 'skill:tdd'],
    taskProfile: profile,
    profileHash: needsAnswer ? null : syntheticProfileHash,
    context: needsAnswer || requiredCapabilityUnavailable || memoryContextWithheld ? null : syntheticContext(),
    untrusted: true,
    recommendations: [],
    capabilities,
    memoryPolicy: memoryContextWithheld
      ? {
        memoryReasoningRequired: true,
        contextWithheld: true,
        withheldReason: 'memory_reasoning_unknown',
      }
      : { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null },
    warnings: [],
    nextAction: needsAnswer
      ? 'answer_from_evidence_or_ask_user'
      : requiredCapabilityUnavailable ? 'required_capability_unavailable' : 'proceed',
  };
}

function syntheticAck() {
  return {
    runId: 'synthetic-run',
    acceptedThrough: 1,
    localSequences: [1],
    sourceSequences: [null],
    eventIds: ['synthetic-event'],
  };
}

function syntheticResponses(): Record<string, Record<string, unknown>> {
  return {
    'agent.open': syntheticIntakeResponse({ needsAnswer: true }),
    'agent.answer': syntheticIntakeResponse(),
    'agent.events': { ...syntheticAck(), runStatus: 'active', untrusted: true },
    'agent.checkpoint': {
      ...syntheticAck(),
      runStatus: 'active',
      intakeStatus: 'ready',
      taskProfile: { ...syntheticProfile, source: 'akinator+ledger-revisions' },
      profileHash: syntheticProfileHash,
      projection: {
        throughSequence: 1,
        taskProfile: syntheticProfile,
        profileHash: syntheticProfileHash,
        evidenceState: 'none',
        unresolvedFailureEventIds: [],
        unknownOutcomeEventIds: [],
        latestMutationSequence: null,
        latestPassingVerificationSequence: null,
        coverage: 'partial',
        declaredCoverage: {
          run: 'declared', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable',
        },
        intakeIncomplete: false,
        missingProfileFields: [],
      },
      recommendations: [],
      characterBudget: 8_000,
      context: syntheticContext(),
      untrusted: true,
      capabilities: syntheticCapabilities(),
      memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null },
      warnings: [],
      nextAction: 'proceed',
    },
    'agent.close': {
      ...syntheticAck(), status: 'completed', runStatus: 'completed', untrusted: true,
    },
    'agent.feedback': {
      category: 'run',
      record: {
        feedbackId: 'synthetic-feedback',
        workspace: 'synthetic-workspace',
        runId: 'synthetic-run',
        outcome: 'completed',
        recommendationCode: null,
        recommendationVerdict: null,
        rating: 5,
        comment: null,
        actor: 'synthetic-agent',
        idempotencyKeyHash: 'a'.repeat(64),
        createdAt: '2026-08-20T00:00:00.000Z',
      },
      untrusted: true,
    },
  };
}

type RequestBindingMode = 'exact' | 'missing' | 'wrong';

function requestPathRunId(request: ServerRequest): string | null {
  assert.equal(
    AGENT_MUTATION_OPERATIONS.includes(request.operation as AgentMutationOperation),
    true,
    `unexpected synthetic operation: ${request.operation}`,
  );
  if (request.operation === 'agent.open') {
    assert.equal(request.path, '/api/v1/agent/runs');
    return null;
  }
  const match = /^\/api\/v1\/agent\/runs\/([^/]+)\/(?:intake\/answers|events|checkpoints|close|feedback)$/u.exec(request.path);
  assert.notEqual(match?.[1], undefined, `unexpected synthetic request path: ${request.path}`);
  return decodeURIComponent(match?.[1] as string);
}

function responseWithRequestBinding(
  value: Record<string, unknown>,
  request: ServerRequest,
  mode: RequestBindingMode,
): Record<string, unknown> {
  const response = { ...value };
  if (request.operation === 'agent.feedback') {
    const record = response.record as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    response.record = {
      ...record,
      actor: body.actor ?? 'kiokuko-feedback',
      idempotencyKeyHash: createHash('sha256').update(request.idempotencyKey as string, 'utf8').digest('hex'),
    };
  }
  if (mode !== 'missing') {
    response.requestBindingHash = mode === 'wrong'
      ? '0'.repeat(64)
      : agentRequestBindingHash({
        operation: request.operation,
        pathRunId: requestPathRunId(request),
        idempotencyKey: request.idempotencyKey ?? null,
        requestBody: request.body,
      });
  }
  return response;
}

function clientReturning(
  value: Record<string, unknown>,
  mode: RequestBindingMode = 'exact',
): ServerClient {
  return {
    request: async <T>(request: ServerRequest) => responseWithRequestBinding(value, request, mode) as T,
  };
}

function syntheticArgumentsByOperation(inputPath: string): Record<AgentMutationOperation, string[]> {
  return {
    'agent.open': ['agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't', '--json'],
    'agent.answer': ['agent', 'answer', 'synthetic-run', '--question-id', 'taskType', '--value', 'build', '--json'],
    'agent.events': ['agent', 'events', 'synthetic-run', '--input-json', inputPath, '--json'],
    'agent.checkpoint': ['agent', 'checkpoint', 'synthetic-run', '--input-json', inputPath, '--json'],
    'agent.close': ['agent', 'close', 'synthetic-run', '--input-json', inputPath, '--json'],
    'agent.feedback': ['agent', 'feedback', 'synthetic-run', '--input-json', inputPath, '--json'],
  };
}

function syntheticInputByOperation(operation: AgentMutationOperation): Record<string, unknown> {
  switch (operation) {
    case 'agent.events':
      return {
        apiVersion: '1',
        events: [{
          eventType: 'step.started',
          actor: 'synthetic-agent',
          occurredAt: '2026-08-20T00:00:00.000Z',
          payload: { step: 'verify' },
        }],
      };
    case 'agent.checkpoint':
      return { apiVersion: '1', currentStep: 'verify' };
    case 'agent.close':
      return { apiVersion: '1', status: 'completed' };
    case 'agent.feedback':
      return {
        apiVersion: '1',
        category: 'run',
        feedbackId: 'synthetic-feedback',
        outcome: 'completed',
        rating: 5,
      };
    case 'agent.open':
    case 'agent.answer':
      return {};
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  await initializeDatabase({ databasePath });
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    capabilityToken: token,
  });
  const requests: CapturedRequest[] = [];
  const fetchImplementation: FetchImplementation = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const captured: CapturedRequest = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    };
    if (typeof init.body === 'string') captured.body = init.body;
    requests.push(captured);
    return fetch(url, init);
  };
  const keyValues = ['cli-open-key', 'cli-answer-type', 'cli-answer-target', 'cli-answer-expected', 'cli-checkpoint-key', 'cli-close-key', 'cli-feedback-key'];
  let keyIndex = 0;
  const agent = {
    createClient: () => createServerClient({
      descriptorPath,
      isPidAlive: () => true,
      fetchImplementation,
    }),
    idempotencyKeyFactory: () => keyValues[keyIndex++] ?? `unexpected-key-${keyIndex}`,
  };
  return { directory, runtime, requests, agent };
}

async function invoke(args: string[], agent: Awaited<ReturnType<typeof fixture>>['agent']): Promise<Record<string, any>> {
  const captured = await captureOutput(() => runCli(['node', 'kiokuko-ai', ...args], { agent }));
  assert.equal(captured.result, 0, `${args.join(' ')}: ${captured.stderr}${captured.stdout}`);
  assert.equal(captured.stderr, '');
  return parsed(captured.stdout);
}

test('generic agent CLI opens and answers intake without fabricating lifecycle data', async () => {
  const value = await fixture();
  try {
    const capabilitiesPath = path.join(value.directory, 'capabilities.json');
    await writeFile(capabilitiesPath, JSON.stringify([
      { kind: 'skill', name: 'kiokuko-soul' },
      { kind: 'skill', name: 'memory-reasoning' },
    ]));
    const capabilityArguments = ['--capabilities-json', capabilitiesPath];
    const opened = await invoke([
      'agent', 'open', '--workspace', 'cli-workspace', '--client', 'generic', '--task', 'Implement the feature', ...capabilityArguments, '--json',
    ], value.agent);
    assert.equal(opened.operation, 'agent.open');
    assert.equal(opened.data.intakeStatus, 'needs_answer');
    assert.equal(opened.data.runStatus, 'intake');
    assert.equal(opened.data.context, null);
    const runId = opened.data.runId as string;
    const firstQuestionId = opened.data.currentQuestion.id as string;

    const answeredType = await invoke([
      'agent', 'answer', runId, '--question-id', firstQuestionId, '--value', 'build', ...capabilityArguments, '--json',
    ], value.agent);
    assert.equal(answeredType.operation, 'agent.answer');
    assert.equal(answeredType.data.runStatus, 'intake');
    assert.equal(answeredType.data.context, null);

    const secondQuestionId = answeredType.data.currentQuestion.id as string;
    const answeredTarget = await invoke([
      'agent', 'answer', runId, '--question-id', secondQuestionId, '--value', 'src/feature.ts', ...capabilityArguments, '--json',
    ], value.agent);
    let finalAnswer = answeredTarget;
    if (answeredTarget.data.runStatus === 'intake') {
      const thirdQuestionId = answeredTarget.data.currentQuestion.id as string;
      finalAnswer = await invoke([
        'agent', 'answer', runId, '--question-id', thirdQuestionId, '--value', 'focused tests pass', ...capabilityArguments, '--json',
      ], value.agent);
    }
    assert.equal(finalAnswer.data.runStatus, 'active');
    assert.equal(['ready', 'exhausted'].includes(finalAnswer.data.intakeStatus), true);
    assert.equal(finalAnswer.data.context.untrusted, true);
    assert.equal(finalAnswer.data.untrusted, true);

    const openRequest = value.requests[0];
    assert.equal(openRequest?.method, 'POST');
    assert.equal(new URL(openRequest?.url ?? '').pathname, '/api/v1/agent/runs');
    assert.equal(openRequest?.headers.authorization, `Bearer ${token}`);
    assert.equal(openRequest?.headers['idempotency-key'], 'cli-open-key');
    const openBody = JSON.parse(openRequest?.body ?? '{}') as Record<string, any>;
    assert.deepEqual(openBody.client, { kind: 'generic' });
    assert.equal(openBody.task.title, 'Implement the feature');
    assert.equal(openBody.task.query, 'Implement the feature');
    assert.equal(openBody.captureProfile, 'standard');
    assert.equal(openBody.coverage.run, 'declared');
    assert.equal(openBody.coverage.approval, 'unavailable');
    assert.deepEqual(openBody.capabilities, [
      { kind: 'skill', name: 'kiokuko-soul' },
      { kind: 'skill', name: 'memory-reasoning' },
    ]);
    assert.equal(JSON.stringify(openBody).includes('complete'), false);
  } finally {
    await value.runtime.close();
  }
});

test('generic agent CLI sends exact write paths, bodies, and one idempotency key per operation', async () => {
  const value = await fixture();
  try {
    const capabilitiesPath = path.join(value.directory, 'write-capabilities.json');
    await writeFile(capabilitiesPath, JSON.stringify([{ kind: 'skill', name: 'kiokuko-soul' }]));
    const capabilityArguments = ['--capabilities-json', capabilitiesPath];
    const opened = await invoke([
      'agent', 'open', '--workspace', 'cli-write-workspace', '--client', 'opencode', '--client-version', '1.0', '--session-id', 's1', '--task', 'Complete task', '--capture-profile', 'full', ...capabilityArguments, '--json',
    ], value.agent);
    const runId = opened.data.runId as string;
    const answerOne = await invoke(['agent', 'answer', runId, '--question-id', opened.data.currentQuestion.id, '--value', 'build', ...capabilityArguments, '--json'], value.agent);
    const answerTwo = await invoke(['agent', 'answer', runId, '--question-id', answerOne.data.currentQuestion.id, '--value', 'src/a.ts', ...capabilityArguments, '--json'], value.agent);
    await invoke(['agent', 'answer', runId, '--question-id', answerTwo.data.currentQuestion.id, '--value', 'tests pass', ...capabilityArguments, '--json'], value.agent);

    const inputDirectory = path.join(value.directory, 'inputs');
    await mkdir(inputDirectory);
    const eventPath = path.join(inputDirectory, 'events.json');
    const checkpointPath = path.join(inputDirectory, 'checkpoint.json');
    const closePath = path.join(inputDirectory, 'close.json');
    const feedbackPath = path.join(inputDirectory, 'feedback.json');
    await writeFile(eventPath, JSON.stringify({
      idempotencyKey: 'cli-events-key',
      apiVersion: '1',
      events: [{ eventId: 'cli-event-1', eventType: 'step.started', actor: 'cli', occurredAt: '2026-08-20T00:00:00.000Z', payload: { step: 'build' } }],
    }));
    await writeFile(checkpointPath, JSON.stringify({ apiVersion: '1', currentStep: 'verify' }));
    await writeFile(closePath, JSON.stringify({ apiVersion: '1', status: 'completed' }));
    await writeFile(feedbackPath, JSON.stringify({ apiVersion: '1', category: 'run', feedbackId: 'feedback-1', outcome: 'completed', rating: 5 }));

    const events = await invoke(['agent', 'events', runId, '--input-json', eventPath, '--json'], value.agent);
    assert.equal(events.operation, 'agent.events');
    const checkpoint = await invoke(['agent', 'checkpoint', runId, '--input-json', checkpointPath, ...capabilityArguments, '--json'], value.agent);
    assert.equal(checkpoint.operation, 'agent.checkpoint');
    const closed = await invoke(['agent', 'close', runId, '--input-json', closePath, '--json'], value.agent);
    assert.equal(closed.operation, 'agent.close');
    const feedback = await invoke(['agent', 'feedback', runId, '--input-json', feedbackPath, '--json'], value.agent);
    assert.equal(feedback.operation, 'agent.feedback');

    const paths = value.requests.slice(-4).map((request) => new URL(request.url).pathname);
    assert.deepEqual(paths, [
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/events`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/close`,
      `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`,
    ]);
    assert.deepEqual(value.requests.slice(-4).map((request) => request.headers['idempotency-key']), [
      'cli-events-key', 'cli-checkpoint-key', 'cli-close-key', 'cli-feedback-key',
    ]);
    assert.equal(JSON.parse(value.requests.at(-4)?.body ?? '{}').idempotencyKey, undefined);
    assert.equal(JSON.parse(value.requests.at(-3)?.body ?? '{}').apiVersion, '1');
    assert.equal(JSON.parse(value.requests.at(-2)?.body ?? '{}').status, 'completed');
    assert.equal(JSON.parse(value.requests.at(-1)?.body ?? '{}').feedbackId, 'feedback-1');
  } finally {
    await value.runtime.close();
  }
});

test('generic agent CLI exposes explicit idempotency keys for exact open and answer retries', async () => {
  const value = await fixture();
  try {
    const capabilitiesPath = path.join(value.directory, 'retry-capabilities.json');
    await writeFile(capabilitiesPath, JSON.stringify([{ kind: 'skill', name: 'kiokuko-soul' }]));
    const capabilityArguments = ['--capabilities-json', capabilitiesPath];
    const openArguments = [
      'agent', 'open', '--workspace', 'cli-retry-workspace', '--client', 'opencode', '--task', 'Retry this exact open',
      ...capabilityArguments, '--idempotency-key', 'explicit-open-retry', '--json',
    ];
    const opened = await invoke(openArguments, value.agent);
    const replayedOpen = await invoke(openArguments, value.agent);
    assert.equal(replayedOpen.data.runId, opened.data.runId);
    assert.deepEqual(value.requests.slice(0, 2).map((request) => request.headers['idempotency-key']), [
      'explicit-open-retry', 'explicit-open-retry',
    ]);

    const answerArguments = [
      'agent', 'answer', opened.data.runId, '--question-id', opened.data.currentQuestion.id, '--value', 'build',
      ...capabilityArguments, '--idempotency-key', 'explicit-answer-retry', '--json',
    ];
    const answered = await invoke(answerArguments, value.agent);
    const replayedAnswer = await invoke(answerArguments, value.agent);
    assert.equal(replayedAnswer.data.runId, answered.data.runId);
    assert.deepEqual(value.requests.slice(2, 4).map((request) => request.headers['idempotency-key']), [
      'explicit-answer-retry', 'explicit-answer-retry',
    ]);
  } finally {
    await value.runtime.close();
  }
});

test('agent JSON input rejects trailing data and server absence is a fixed error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-invalid-'));
  const inputPath = path.join(directory, 'invalid.json');
  await writeFile(inputPath, '{"apiVersion":"1"} trailing');
  const dependency = {
    createClient: async () => { throw new Error('client should not be created'); },
    idempotencyKeyFactory: () => 'unused-key',
  };
  const invalid = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'events', 'run-1', '--input-json', inputPath, '--json',
  ], { agent: dependency }));
  assert.equal(invalid.result, 3);
  assert.equal(invalid.stderr, '');
  const error = parsed(invalid.stdout);
  assert.equal(error.operation, 'agent.events');
  assert.equal(error.error.code, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(error).includes(inputPath), false);

  const spacedKey = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't',
    '--idempotency-key', ' normalized-on-wire ', '--json',
  ], { agent: dependency }));
  assert.equal(spacedKey.result, 3);
  assert.equal(parsed(spacedKey.stdout).error.code, 'VALIDATION_ERROR');

  const unavailable = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't', '--json',
  ]));
  assert.equal(unavailable.result, 6);
  assert.equal(unavailable.stderr, '');
  const unavailableBody = parsed(unavailable.stdout);
  assert.equal(unavailableBody.operation, 'agent.open');
  assert.equal(unavailableBody.error.code, 'SERVICE_UNAVAILABLE');
});

test('agent input preserves both validation and descriptor-close failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-input-dual-failure-'));
  const inputPath = path.join(directory, 'oversized.json');
  await writeFile(inputPath, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
  const closeFailure = new Error('agent-input-close-failure-sentinel');
  const cli = buildCli({
    agent: {
      closeInputFile: async (handle) => {
        await handle.close();
        throw closeFailure;
      },
      createClient: async () => { throw new Error('client must not be created'); },
    },
  });

  await assert.rejects(
    cli.parseAsync(['node', 'kiokuko-ai', 'agent', 'events', 'run-1', '--input-json', inputPath, '--json']),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Agent input read failed and its file descriptor could not be closed');
      assert.equal((error.errors[0] as { code?: unknown }).code, 'VALIDATION_ERROR');
      assert.equal(error.errors[1], closeFailure);
      return true;
    },
  );
});

test('agent capability catalogs reject non-strict JSON before any request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-strict-catalog-'));
  const catalogPath = path.join(directory, 'capabilities.json');
  let clientCalls = 0;
  const dependency = {
    createClient: async () => {
      clientCalls += 1;
      throw new Error('malformed catalog must not reach the server');
    },
    idempotencyKeyFactory: () => 'strict-catalog-key',
  };
  const malformedCatalogs: Array<string | Buffer> = [
    '[{"kind":"invalid","kind":"skill","name":"memory-reasoning"}]',
    '[{"kind":"skill","name":"unrelated","name":"memory-reasoning"}]',
    '[/* trusted */{"kind":"skill","name":"memory-reasoning"}]',
    '[{"kind":"skill","name":"memory-reasoning"},]',
    '\ufeff[{"kind":"skill","name":"memory-reasoning"}]',
    '[{"kind":"skill","name":"memory-reasoning","weight":1e400}]',
    `[${'{"nested":'.repeat(129)}null${'}'.repeat(129)}]`,
    '',
    Buffer.from([0xc3, 0x28]),
  ];

  for (const catalog of malformedCatalogs) {
    await writeFile(catalogPath, catalog);
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Implement the fix',
      '--capabilities-json', catalogPath, '--json',
    ], { agent: dependency }));
    assert.equal(captured.result, 3);
    assert.equal(captured.stderr, '');
    const error = parsed(captured.stdout);
    assert.equal(error.operation, 'agent.open');
    assert.equal(error.error.code, 'VALIDATION_ERROR');
    assert.equal(JSON.stringify(error).includes(catalogPath), false);
  }
  assert.equal(clientCalls, 0);
});

test('non-JSON agent output names each required unavailable capability', async () => {
  const response = syntheticIntakeResponse({ requiredCapabilityUnavailable: true });
  const captured = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Implement the fix',
  ], {
    agent: {
      createClient: async () => clientReturning(response),
      idempotencyKeyFactory: () => 'human-required-capability',
    },
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.stderr, '');
  assert.equal(captured.stdout.split('\n', 1)[0], 'Kiokuko agent.open: required_capability_unavailable; required capabilities unavailable: kiokuko-soul (unknown)');
});

test('agent CLI accepts a soft memory-reasoning gate with withheld context', async () => {
  const response = syntheticIntakeResponse({ memoryContextWithheld: true });
  const captured = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Implement the fix', '--json',
  ], {
    agent: {
      createClient: async () => clientReturning(response),
      idempotencyKeyFactory: () => 'soft-memory-capability',
    },
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.stderr, '');
  const result = parsed(captured.stdout);
  assert.equal(result.data.nextAction, 'proceed');
  assert.equal(result.data.context, null);
});

test('agent CLI accepts a consistent machine-readable empty-delivery policy', async () => {
  const base = syntheticIntakeResponse();
  const context = { ...(base.context as Record<string, unknown>), items: [] };
  const response = {
    ...base,
    context,
    memoryPolicy: {
      memoryReasoningRequired: false,
      contextWithheld: false,
      withheldReason: null,
      deliveryEmpty: true,
      storedEntryCount: 2,
    },
  };
  const captured = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Research the gap', '--json',
  ], {
    agent: {
      createClient: async () => clientReturning(response),
      idempotencyKeyFactory: () => 'machine-readable-empty-delivery',
    },
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.stderr, '');
  assert.deepEqual(parsed(captured.stdout).data.memoryPolicy, response.memoryPolicy);
});

test('agent CLI rejects incomplete or contradictory empty-delivery fields', async () => {
  const base = syntheticIntakeResponse();
  const invalidPolicies = [
    { ...base.memoryPolicy, deliveryEmpty: true },
    { ...base.memoryPolicy, storedEntryCount: 1 },
    { ...base.memoryPolicy, deliveryEmpty: false, storedEntryCount: 1 },
    { ...base.memoryPolicy, deliveryEmpty: true, storedEntryCount: 0 },
  ];
  for (const [index, memoryPolicy] of invalidPolicies.entries()) {
    const response = { ...base, memoryPolicy };
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Research the gap', '--json',
    ], {
      agent: {
        createClient: async () => clientReturning(response),
        idempotencyKeyFactory: () => `invalid-empty-delivery-${index}`,
      },
    }));
    assert.equal(captured.result, 8);
    assert.equal(parsed(captured.stdout).error.code, 'INTEGRITY_ERROR');
  }
});

test('agent CLI rejects memory policy fields that contradict the capability recommendation', async () => {
  const base = syntheticIntakeResponse({ memoryContextWithheld: true });
  const invalidPolicies = [
    { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null },
    { memoryReasoningRequired: true, contextWithheld: true, withheldReason: 'memory_reasoning_missing' },
    { memoryReasoningRequired: false, contextWithheld: true, withheldReason: 'memory_reasoning_unknown' },
  ];
  for (const [index, memoryPolicy] of invalidPolicies.entries()) {
    const response = { ...base, memoryPolicy };
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 'Implement the fix', '--json',
    ], {
      agent: {
        createClient: async () => clientReturning(response),
        idempotencyKeyFactory: () => `invalid-memory-policy-${index}`,
      },
    }));
    assert.equal(captured.result, 8);
    assert.equal(parsed(captured.stdout).error.code, 'INTEGRITY_ERROR');
  }
});

test('agent client and idempotency dependency programming failures propagate unchanged', async () => {
  const arguments_ = ['node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't', '--json'];
  const createSentinel = new Error('create-client programming sentinel');
  await assert.rejects(
    () => buildCli({
      agent: {
        createClient: async () => { throw createSentinel; },
        idempotencyKeyFactory: () => 'create-sentinel-key',
      },
    }).parseAsync(arguments_),
    (error: unknown) => error === createSentinel,
  );

  const requestSentinel = new Error('request programming sentinel');
  await assert.rejects(
    () => buildCli({
      agent: {
        createClient: async () => ({ request: async () => { throw requestSentinel; } }),
        idempotencyKeyFactory: () => 'request-sentinel-key',
      },
    }).parseAsync(arguments_),
    (error: unknown) => error === requestSentinel,
  );

  const keySentinel = new Error('idempotency programming sentinel');
  await assert.rejects(
    () => buildCli({
      agent: {
        createClient: async () => { throw new Error('client must not be created'); },
        idempotencyKeyFactory: () => { throw keySentinel; },
      },
    }).parseAsync(arguments_),
    (error: unknown) => error === keySentinel,
  );
});

test('agent JSON object boundary rejects hostile shapes without invoking accessors or proxy traps', async () => {
  let clientCalls = 0;
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  const dependencyFor = (value: unknown) => ({
    readJsonInput: async () => value,
    createClient: async () => {
      clientCalls += 1;
      throw new Error('hostile input must not reach client creation');
    },
    idempotencyKeyFactory: () => 'hostile-input-key',
  });
  const accessor: Record<string, unknown> = { apiVersion: '1' };
  Object.defineProperty(accessor, 'events', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return [];
    },
  });
  const proxied = new Proxy({ apiVersion: '1' }, {
    ownKeys(target) {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  const nonPlain = Object.create({ inherited: true }) as Record<string, unknown>;
  nonPlain.apiVersion = '1';

  for (const value of [accessor, proxied, nonPlain]) {
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'events', 'run-1', '--input-json', 'virtual.json', '--json',
    ], { agent: dependencyFor(value) }));
    assert.equal(captured.result, 3);
    assert.equal(parsed(captured.stdout).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(clientCalls, 0);
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test('agent input extraction preserves __proto__ as an ordinary request body field', async () => {
  const input = JSON.parse('{"apiVersion":"1","idempotencyKey":"proto-input-key","__proto__":{"polluted":true}}');
  let capturedBody: unknown;
  const captured = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'events', 'synthetic-run', '--input-json', 'virtual.json', '--json',
  ], {
    agent: {
      readJsonInput: async () => input,
      createClient: async () => ({
        request: async <T>(request: ServerRequest) => {
          capturedBody = request.body;
          return responseWithRequestBinding(syntheticResponses()['agent.events'] as Record<string, unknown>, request, 'exact') as T;
        },
      }),
      idempotencyKeyFactory: () => 'must-not-be-used',
    },
  }));
  assert.equal(captured.result, 8);
  assert.equal(parsed(captured.stdout).error.code, 'INTEGRITY_ERROR');
  assert.equal(typeof capturedBody === 'object' && capturedBody !== null && Object.hasOwn(capturedBody, '__proto__'), true);
  assert.equal(JSON.stringify((capturedBody as Record<string, unknown>).__proto__), '{"polluted":true}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('every agent operation rejects missing, malformed, or unknown success fields as integrity failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-response-schema-'));
  const inputPath = path.join(directory, 'input.json');
  const argumentsByOperation = syntheticArgumentsByOperation(inputPath);
  const invalidResponses = syntheticResponses();
  delete invalidResponses['agent.open']?.runStatus;
  (invalidResponses['agent.answer'] as Record<string, unknown>).currentQuestion = {
    id: 'taskType', options: null, required: true,
  };
  (invalidResponses['agent.events'] as Record<string, unknown>).runStatus = 'completed';
  delete invalidResponses['agent.checkpoint']?.recommendations;
  (invalidResponses['agent.close'] as Record<string, unknown>).runStatus = 'failed';
  delete ((invalidResponses['agent.feedback'] as Record<string, any>).record as Record<string, unknown>).createdAt;

  for (const [operation, response] of Object.entries(invalidResponses)) {
    await writeFile(inputPath, JSON.stringify(syntheticInputByOperation(operation as AgentMutationOperation)));
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', ...argumentsByOperation[operation as AgentMutationOperation],
    ], {
      agent: {
        createClient: async () => clientReturning(response),
        idempotencyKeyFactory: () => `schema-${operation}`,
      },
    }));
    assert.equal(captured.result, 8, operation);
    const envelope = parsed(captured.stdout);
    assert.equal(envelope.operation, operation);
    assert.equal(envelope.error.code, 'INTEGRITY_ERROR');
  }
});

test('every agent operation requires the exact request-binding hash', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-cli-request-binding-'));
  const inputPath = path.join(directory, 'input.json');
  const argumentsByOperation = syntheticArgumentsByOperation(inputPath);

  for (const operation of AGENT_MUTATION_OPERATIONS) {
    await writeFile(inputPath, JSON.stringify(syntheticInputByOperation(operation)));
    for (const mode of ['exact', 'missing', 'wrong'] as const) {
      const captured = await captureOutput(() => runCli([
        'node', 'kiokuko-ai', ...argumentsByOperation[operation],
      ], {
        agent: {
          createClient: async () => clientReturning(syntheticResponses()[operation] as Record<string, unknown>, mode),
          idempotencyKeyFactory: () => `binding-${operation}-${mode}`,
        },
      }));
      if (mode === 'exact') {
        assert.equal(captured.result, 0, `${operation}: ${captured.stderr}${captured.stdout}`);
        assert.equal(parsed(captured.stdout).data.requestBindingHash.length, 64);
      } else {
        assert.equal(captured.result, 8, `${operation}/${mode}`);
        const envelope = parsed(captured.stdout);
        assert.equal(envelope.operation, operation);
        assert.equal(envelope.error.code, 'INTEGRITY_ERROR');
      }
    }
  }
});

test('agent close binds its acknowledgement to requested close events plus the lifecycle event', async () => {
  const request = {
    apiVersion: '1',
    status: 'completed',
    events: [{
      eventId: 'requested-close-event',
      eventType: 'verification.recorded',
      actor: 'synthetic-agent',
      sourceSequence: 7,
      payload: { outcome: 'pass' },
    }],
  };
  const validResponse = {
    runId: 'synthetic-run',
    acceptedThrough: 2,
    localSequences: [1, 2],
    sourceSequences: [7, null],
    eventIds: ['requested-close-event', 'generated-run-closed-event'],
    status: 'completed',
    runStatus: 'completed',
    untrusted: true,
  };
  const valid = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'close', 'synthetic-run', '--input-json', 'virtual.json', '--json',
  ], {
    agent: {
      readJsonInput: async () => request,
      createClient: async () => clientReturning(validResponse),
      idempotencyKeyFactory: () => 'close-event-valid-binding',
    },
  }));
  assert.equal(valid.result, 0, `${valid.stderr}${valid.stdout}`);

  const omittedResponse = {
    ...syntheticAck(),
    status: 'completed',
    runStatus: 'completed',
    untrusted: true,
  };
  const captured = await captureOutput(() => runCli([
    'node', 'kiokuko-ai', 'agent', 'close', 'synthetic-run', '--input-json', 'virtual.json', '--json',
  ], {
    agent: {
      readJsonInput: async () => request,
      createClient: async () => clientReturning(omittedResponse),
      idempotencyKeyFactory: () => 'close-event-ack-binding',
    },
  }));
  assert.equal(captured.result, 8);
  const envelope = parsed(captured.stdout);
  assert.equal(envelope.operation, 'agent.close');
  assert.equal(envelope.error.code, 'INTEGRITY_ERROR');
});

test('agent request hashing and JSON output ignore ambient Array.prototype.toJSON', { concurrency: false }, async () => {
  const input = syntheticInputByOperation('agent.events');
  const originalToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let toJSONCalls = 0;
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value: () => {
      toJSONCalls += 1;
      return ['tampered'];
    },
  });
  try {
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'events', 'synthetic-run', '--input-json', 'virtual.json', '--json',
    ], {
      agent: {
        readJsonInput: async () => input,
        createClient: async () => clientReturning(syntheticResponses()['agent.events'] as Record<string, unknown>),
        idempotencyKeyFactory: () => 'ambient-array-to-json',
      },
    }));
    assert.equal(captured.result, 0, `${captured.stderr}${captured.stdout}`);
    assert.equal(parsed(captured.stdout).data.runId, 'synthetic-run');
    assert.equal(toJSONCalls, 0);
  } finally {
    if (originalToJSON === undefined) {
      delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
    } else {
      Object.defineProperty(Array.prototype, 'toJSON', originalToJSON);
    }
  }
});

test('agent success boundary rejects response proxies and accessors without invoking them', async () => {
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, 'runId', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'must-not-run';
    },
  });
  const proxied = new Proxy(syntheticIntakeResponse({ needsAnswer: true }), {
    ownKeys(target) {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  for (const response of [accessor, proxied]) {
    const captured = await captureOutput(() => runCli([
      'node', 'kiokuko-ai', 'agent', 'open', '--workspace', 'w', '--client', 'generic', '--task', 't', '--json',
    ], {
      agent: {
        createClient: async () => ({ request: async <T>() => response as T }),
        idempotencyKeyFactory: () => 'hostile-response-key',
      },
    }));
    assert.equal(captured.result, 8);
    assert.equal(parsed(captured.stdout).error.code, 'INTEGRITY_ERROR');
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});
