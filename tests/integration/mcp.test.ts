import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { BoundedStdioServerTransport } from '../../src/mcp/bounded-stdio-transport.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { GLOBAL_WORKSPACE } from '../../src/memory/workspaces.js';
import { MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS } from '../../src/akinator/capabilities.js';
import { KiokukoError, type ErrorCode } from '../../src/errors.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const SOUL_CAPABILITY = {
  kind: 'skill',
  name: 'kiokuko-soul',
  description: 'Route Kiokuko work to every applicable bundled Skill.',
} as const;

function sqliteError(errcode: number, message = 'sqlite operation failed'): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

test('MCP exposes only the gated task and lifecycle tools and persists candidate memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'kiokuko', version: PACKAGE_VERSION });
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(instructions, /Every descriptor must include its kind and canonical name/u);
    assert.match(instructions, /memory-reasoning is missing or unknown.*nextAction remains proceed.*repository evidence/iu);
    assert.match(instructions, /read and apply the available local memory-reasoning Skill before using that memory/);
    assert.match(instructions, /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(instructions, /executionContext\.repositoryRoot as the filesystem base/u);
    assert.match(instructions, /OpenCode filesystem tools, prefer canonical absolute paths under that root/u);
    assert.match(instructions, /read and apply the complete bundled `kiokuko-soul` Skill before any other Kiokuko Skill/iu);
    assert.match(instructions, /Every `task_prepare` call must set `soulRead: true` only after that read/iu);
    assert.match(instructions, /exact local `kiokuko-soul` capability is required for every task/iu);
    assert.match(instructions, /Akinator is the mandatory intake state machine before every planning or implementation route/iu);
    assert.match(instructions, /whether or not Enno-Oduno applies/iu);
    assert.match(instructions, /do not plan, implement, verify, enter simple\/code\/UI routes, or checkpoint while `intake\.status=needs_answer`/u);
    assert.match(instructions, /Route only after intake reaches `ready` or `exhausted` and top-level `nextAction` permits progress/u);
    assert.match(instructions, /`task_prepare` is the Enno-Oduno orchestration entry point/u);
    assert.match(instructions, /first identifies OpenCode from MCP `clientInfo`/u);
    assert.match(instructions, /Every Enno-Oduno directive requires the bundled `kiokuko-soul` Skill first/u);
    assert.match(instructions, /While Akinator still needs information, only Enno-Oduno is active/u);
    assert.match(instructions, /structured handoff.*Oduno ideal.*every Akinator-discovered Skill.*harness-specific Zenki directive/u);
    assert.match(instructions, /Zenki must read the master SOUL and then the compact `kiokuko-single-purpose-functions` index/u);
    assert.match(instructions, /focused runnable test target/u);
    assert.match(instructions, /one to three versioned `expertRefs`/u);
    assert.match(instructions, /Goki receives only approved, already-decomposed WorkUnits/u);
    assert.match(instructions, /Goki can start only after Zenki submits a complete WorkPlan/u);
    assert.match(instructions, /A failed review never returns directly to Goki/u);
    assert.match(instructions, /Oduno meditation.*obsolete tests or functions.*without mutating the repository/iu);
    assert.match(instructions, /never select a repository-wide latest run/iu);
    assert.match(instructions, /ask_user_confirmation.*userFacingConfirmation.*never output raw directive JSON/isu);
    assert.match(instructions, /userFacingRecovery.*whenToChoose.*whatHappens.*explicit choice/isu);
    assert.match(instructions, /Do not retry, cancel, or create a new task automatically/iu);
    assert.match(instructions, /never ask the user to locate or construct that catalog/iu);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'curator_check',
      'curator_globalize',
      'enno_advice_read',
      'enno_advice_submit',
      'enno_answer',
      'enno_finish',
      'enno_ideal_submit',
      'enno_meditation_submit',
      'enno_plan_submit',
      'enno_verify_prepare',
      'enno_work_report',
      'memory_checkpoint',
      'task_answer',
      'task_prepare',
    ]);
    assert.equal(tools.tools.find((tool) => tool.name === 'task_prepare')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'task_answer')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_check')?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_check')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === 'curator_globalize')?.annotations?.idempotentHint, true);
    assert.match(tools.tools.find((tool) => tool.name === 'curator_globalize')?.description ?? '', /stored as verified\/system_verified memory created by kiokuko-curator/);
    const planDescription = tools.tools.find((tool) => tool.name === 'enno_plan_submit')?.description ?? '';
    assert.match(planDescription, /label and recommendation.*whenToChoose.*whatHappens/isu);
    assert.match(planDescription, /Never display the machine action.*reason code.*raw JSON/isu);
    assert.match(planDescription, /without retrying, cancelling, or starting a replacement automatically/iu);
    assert.equal(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.annotations?.idempotentHint, false);
    const adviceReadTool = tools.tools.find((tool) => tool.name === 'enno_advice_read');
    assert.equal(adviceReadTool?.annotations?.readOnlyHint, true);
    assert.equal(adviceReadTool?.annotations?.destructiveHint, false);
    assert.equal(adviceReadTool?.annotations?.idempotentHint, true);
    assert.equal(adviceReadTool?.annotations?.openWorldHint, false);
    assert.match(adviceReadTool?.description ?? '', /recovery only/iu);
    const taskPrepareTool = tools.tools.find((tool) => tool.name === 'task_prepare');
    const taskAnswerTool = tools.tools.find((tool) => tool.name === 'task_answer');
    const ennoFinishTool = tools.tools.find((tool) => tool.name === 'enno_finish');
    const ennoIdealTool = tools.tools.find((tool) => tool.name === 'enno_ideal_submit');
    const ennoMeditationTool = tools.tools.find((tool) => tool.name === 'enno_meditation_submit');
    assert.match(taskPrepareTool?.description ?? '', /once for one logical user request/);
    assert.match(taskPrepareTool?.description ?? '', /create a new bounded opaque value for each logical request/);
    assert.match(taskPrepareTool?.description ?? '', /reuse it only for an exact transport retry/);
    assert.match(taskPrepareTool?.description ?? '', /Reusing an ID with changed bound input is a conflict/);
    assert.match(taskPrepareTool?.description ?? '', /Inspect the returned nextAction and memoryPolicy before proceeding/);
    assert.match(taskPrepareTool?.description ?? '', /Akinator is the mandatory intake state machine before every planning or implementation route/iu);
    assert.match(taskPrepareTool?.description ?? '', /do not plan, implement, verify, enter simple\/code\/UI routes, or checkpoint while `intake\.status=needs_answer`/u);
    assert.match(taskPrepareTool?.description ?? '', /missing or unknown memory-reasoning alone.*nextAction at proceed.*repository evidence/iu);
    assert.match(taskPrepareTool?.description ?? '', /created by kiokuko-curator and matching the current deterministic Curator projection is system-verified/);
    assert.match(taskPrepareTool?.description ?? '', /repairing Kiokuko itself.*fails before returning scoped context.*repository evidence/iu);
    assert.match(taskPrepareTool?.description ?? '', /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(taskPrepareTool?.description ?? '', /read and apply local memory-reasoning before using it and convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(taskPrepareTool?.description ?? '', /successful task_prepare or task_answer response includes executionContext/u);
    assert.match(taskPrepareTool?.description ?? '', /never use ~, \$HOME, or HOME-relative path fragments/u);
    assert.match(taskPrepareTool?.description ?? '', /first identifies OpenCode from MCP `clientInfo`/u);
    assert.match(taskPrepareTool?.description ?? '', /Every Enno-Oduno directive requires the bundled `kiokuko-soul` Skill first/u);
    assert.match(taskPrepareTool?.description ?? '', /do not start Zenki or Goki/u);
    assert.match(taskPrepareTool?.description ?? '', /structured handoff.*Oduno ideal.*every Akinator-discovered Skill.*harness-specific Zenki directive/u);
    assert.match(taskPrepareTool?.description ?? '', /failed review never returns directly to Goki/u);
    assert.match(taskPrepareTool?.description ?? '', /ennoOduno\.orchestrationId/u);
    assert.match(taskAnswerTool?.description ?? '', /required run ID returned by task_prepare/);
    assert.match(taskAnswerTool?.description ?? '', /Repeat the same capability catalog and context budget/);
    assert.match(taskAnswerTool?.description ?? '', /changed context budget conflicts before intake mutation/);
    assert.match(taskAnswerTool?.description ?? '', /inspect the returned nextAction and memoryPolicy before proceeding/);
    assert.match(taskAnswerTool?.description ?? '', /missing or unknown memory-reasoning alone.*nextAction at proceed.*repository evidence/iu);
    assert.match(taskAnswerTool?.description ?? '', /created by kiokuko-curator and matching the current deterministic Curator projection is system-verified/);
    assert.match(taskAnswerTool?.description ?? '', /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u);
    assert.match(taskAnswerTool?.description ?? '', /read and apply local memory-reasoning before using it and convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
    assert.match(ennoFinishTool?.description ?? '', /returns Review feedback to Zenki for a new plan/u);
    assert.match(ennoFinishTool?.description ?? '', /advances a new run to Oduno meditation instead of completing it directly/iu);
    const ennoPlanTool = tools.tools.find((tool) => tool.name === 'enno_plan_submit');
    const ennoAnswerTool = tools.tools.find((tool) => tool.name === 'enno_answer');
    assert.match(ennoPlanTool?.description ?? '', /needs_confirmation response carries the decided ennoOduno\.directive\.userFacingConfirmation projection/u);
    assert.match(ennoPlanTool?.description ?? '', /without raw directive JSON or internal identifiers/u);
    assert.match(ennoPlanTool?.description ?? '', /automatic-continuation pause.*wait for the user's explicit choice/iu);
    assert.match(ennoPlanTool?.description ?? '', /same-run retry must pass the selected recoveryAction/iu);
    assert.match(ennoAnswerTool?.description ?? '', /only the action the user explicitly chose after seeing the user-facing confirmation or plan-start recovery choices/iu);
    assert.match(ennoAnswerTool?.description ?? '', /During planning, only explicit cancellation is accepted/iu);
    assert.match(ennoIdealTool?.description ?? '', /optimal goal.*task_prepare handoff.*every Akinator-discovered Skill.*before Zenki planning/iu);
    assert.match(ennoMeditationTool?.description ?? '', /obsolete test or function deletion candidates.*without mutating the repository/iu);
    assert.match(taskAnswerTool?.description ?? '', /successful task_prepare or task_answer response includes executionContext/u);
    type JsonSchema = {
      type?: string;
      description?: string;
      additionalProperties?: boolean;
      properties?: Record<string, JsonSchema>;
      items?: JsonSchema;
      enum?: unknown[];
      const?: unknown;
      maxItems?: number;
      required?: string[];
    };
    type ToolInputSchema = JsonSchema;
    const taskAnswerSchema = taskAnswerTool?.inputSchema as ToolInputSchema;
    const taskPrepareSchema = taskPrepareTool?.inputSchema as ToolInputSchema;
    const ennoPlanSchema = ennoPlanTool?.inputSchema as ToolInputSchema;
    assert.ok(taskPrepareSchema.required?.includes('soulRead'));
    assert.equal(taskPrepareSchema.properties?.soulRead?.const, true);
    assert.match(taskPrepareSchema.properties?.soulRead?.description ?? '', /self-attestation.*complete exact local kiokuko-soul/iu);
    assert.ok(taskPrepareSchema.required?.includes('requestId'));
    assert.ok(taskAnswerSchema.required?.includes('runId'));
    assert.match(taskPrepareSchema.properties?.client?.description ?? '', /normally identifies OpenCode from the MCP initialize clientInfo/u);
    assert.match(taskPrepareSchema.properties?.client?.description ?? '', /host session ID is not authorization ownership/u);
    assert.match(taskPrepareSchema.properties?.client?.description ?? '', /single unambiguous active run in the canonical repository/u);
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /Use the exact current question/);
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /value must be exactly one returned option/);
    assert.match(taskAnswerSchema.properties?.value?.description ?? '', /options is null, provide grounded non-empty text/);
    for (const schema of [taskPrepareSchema, taskAnswerSchema]) {
      assert.equal(schema.properties?.capabilities?.type, 'array');
      assert.match(
        schema.properties?.capabilities?.description ?? '',
        /Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>/u,
      );
      assert.match(schema.properties?.capabilities?.description ?? '', /kind and canonical name/u);
    }
    assert.equal(ennoPlanSchema.properties?.capabilities?.type, 'array');
    assert.match(ennoPlanSchema.properties?.capabilities?.description ?? '', /transport-optional.*user-facing recovery choice/iu);
    for (const toolName of [
      'enno_advice_submit',
      'enno_advice_read',
      'enno_ideal_submit',
      'enno_plan_submit',
      'enno_answer',
      'enno_verify_prepare',
      'enno_work_report',
      'enno_finish',
      'enno_meditation_submit',
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      const schema = tool?.inputSchema as ToolInputSchema;
      assert.match(tool?.description ?? '', /resumeToken.*current OpenCode repository session/iu);
      assert.equal(schema.required?.includes('orchestrationId'), false);
      assert.equal(schema.required?.includes('clientSessionId'), false);
      assert.match(schema.properties?.orchestrationId?.description ?? '', /Exact ennoOduno\.orchestrationId returned by task_prepare or task_answer/u);
      assert.ok(schema.properties?.resumeToken);
    }
    assert.match(tools.tools.find((tool) => tool.name === 'memory_checkpoint')?.description ?? '', /call no more tools/);
    const checkpointTool = tools.tools.find((tool) => tool.name === 'memory_checkpoint');
    assert.match(checkpointTool?.description ?? '', /runId.*active/u);
    assert.match(checkpointTool?.description ?? '', /needs_answer/);
    assert.match(checkpointTool?.description ?? '', /answer_from_evidence_or_ask_user/);
    assert.match(checkpointTool?.description ?? '', /complete the required `task_answer` loop/);
    assert.match(checkpointTool?.description ?? '', /successful terminal checkpoint.*at most once/u);
    assert.match(checkpointTool?.description ?? '', /rejected precondition does not count as that successful checkpoint/u);
    assert.match(checkpointTool?.description ?? '', /indicated run-state change/);
    assert.doesNotMatch(checkpointTool?.description ?? '', /Call at most once per user request/u);
    const checkpointSchema = checkpointTool?.inputSchema as ToolInputSchema;
    assert.equal(checkpointSchema.type, 'object');
    assert.equal(checkpointSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(checkpointSchema.properties ?? {}).sort(), ['cwd', 'deliveryId', 'evidence', 'feedback', 'memories', 'outcome', 'runId']);
    assert.equal(checkpointSchema.properties?.evidence?.type, 'object');
    assert.equal(checkpointSchema.properties?.evidence?.additionalProperties, false);
    assert.deepEqual(Object.keys(checkpointSchema.properties?.evidence?.properties ?? {}).sort(), ['changedPaths', 'commands', 'errorSignatures', 'tests', 'verification']);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.commands?.items?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.tests?.items?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.verification?.additionalProperties, false);
    assert.equal(checkpointSchema.properties?.feedback?.items?.additionalProperties, false);
    assert.deepEqual(checkpointSchema.properties?.feedback?.items?.required, ['entryId', 'entryRevision', 'verdict']);
    assert.equal(checkpointSchema.properties?.feedback?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.commands?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.tests?.maxItems, 100);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.changedPaths?.maxItems, 200);
    assert.equal(checkpointSchema.properties?.evidence?.properties?.errorSignatures?.maxItems, 200);
    assert.equal('checks' in (checkpointSchema.properties?.evidence?.properties ?? {}), false);
    assert.match(checkpointSchema.properties?.runId?.description ?? '', /active/u);
    assert.match(checkpointSchema.properties?.runId?.description ?? '', /needs_answer/u);
    const globalizeSchema = tools.tools.find((tool) => tool.name === 'curator_globalize')?.inputSchema as { properties?: { confirmed?: { const?: unknown } }; required?: string[] };
    assert.equal(globalizeSchema.properties?.confirmed?.const, true);
    assert.ok(globalizeSchema.required?.includes('confirmed'));

    for (const argumentsValue of [{
      requestId: 'mcp-missing-soul-read',
      task: 'Implement the durable beacon',
      capabilities: [SOUL_CAPABILITY],
    }, {
      soulRead: false,
      requestId: 'mcp-false-soul-read',
      task: 'Implement the durable beacon',
      capabilities: [SOUL_CAPABILITY],
    }]) {
      const unattested = await client.callTool({ name: 'task_prepare', arguments: argumentsValue });
      assert.equal(unattested.isError, true);
    }

    const missingRequestId = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        task: 'Implement the durable beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The durable beacon tests pass' },
        capabilities: [],
      },
    });
    assert.equal(missingRequestId.isError, true);
    assert.deepEqual(missingRequestId.structuredContent, { code: 'VALIDATION_ERROR', retryable: false });
    assert.match(JSON.stringify(missingRequestId.content), /Request is invalid/u);

    const checkpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        memories: [{ kind: 'lesson', title: 'Implement the durable beacon and add tests', body: 'Use the MCP durable-beacon contract.' }],
      },
    });
    assert.equal(checkpoint.isError, undefined);
    const checkpointContent = checkpoint.structuredContent as { entries: Array<{ status: string; workspace: string }> };
    assert.equal(checkpointContent.entries[0]?.status, 'candidate');
    assert.match(checkpointContent.entries[0]?.workspace ?? '', /^project:/);

    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-gated-ready-request',
        task: 'Implement the durable beacon and add tests',
        profileHints: {
          taskType: 'build',
          target: 'src/beacon.ts',
          expected: 'The durable beacon tests pass',
        },
        capabilities: [
          SOUL_CAPABILITY,
          { kind: 'skill', name: 'tdd', description: 'Implement changes test first' },
          { kind: 'skill', name: 'memory-reasoning', description: 'Verify recalled memory before implementation' },
          { kind: 'mcp_tool', name: 'github_search_code', description: 'Search repository code for durable beacon implementations' },
        ],
      },
    });
    const preparedContent = prepared.structuredContent as {
      intake: { status: string; sessionId: string; reasoning: { stage: string; selectedAction: string; silo: { completeness: number } } };
      context: { items: Array<{ metadata: { untrusted: boolean } }> };
      capabilities: { availability: string; recommendations: Array<{ kind: string; name: string; availability: string }> };
      memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
      executionContext: { canonicalCwd: string; repositoryRoot: string; cwdIsRepositoryRoot: boolean; pathPolicy: string };
      ennoOduno: {
        applicable: boolean;
        status: string;
        orchestrationId: string | null;
        clientBinding: { status: string; clientKind: string | null; clientVersion: string | null; identified: boolean } | null;
        directive: {
          role: string;
          harness: { kind: string | null; continuation: string };
          handoff: { sourceRole: string; objective: string } | null;
        } | null;
        nextAction: string;
      };
      nextAction: string;
    } & Record<string, unknown>;
    assert.equal(preparedContent.intake.status, 'ready');
    assert.equal(preparedContent.intake.reasoning.stage, 'actionable');
    assert.match(preparedContent.intake.reasoning.selectedAction, /src\/beacon\.ts/u);
    assert.equal(preparedContent.intake.reasoning.silo.completeness, 1);
    assert.equal(preparedContent.nextAction, 'proceed');
    assert.equal(preparedContent.ennoOduno.applicable, true);
    assert.equal(preparedContent.ennoOduno.status, 'oduno_ideal');
    assert.equal(preparedContent.ennoOduno.orchestrationId, preparedContent.intake.sessionId);
    assert.deepEqual(preparedContent.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: null,
      clientVersion: null,
      identified: false,
    });
    assert.equal(preparedContent.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(preparedContent.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.match(preparedContent.ennoOduno.directive?.handoff?.objective ?? '', /src\/beacon\.ts/u);
    assert.equal(preparedContent.ennoOduno.directive?.harness.kind, null);
    assert.equal(preparedContent.ennoOduno.directive?.harness.continuation, 'unidentified');
    assert.equal(preparedContent.ennoOduno.nextAction, 'submit_ideal');
    assert.equal(preparedContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(preparedContent.memoryPolicy, {
      memoryReasoningRequired: true,
      contextWithheld: false,
      withheldReason: null,
    });
    const canonicalRoot = await realpath(root);
    assert.deepEqual(preparedContent.executionContext, {
      canonicalCwd: canonicalRoot,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(preparedContent.context.items[0]?.metadata.untrusted, true);
    assert.equal('memory' in preparedContent, false);
    assert.equal('references' in preparedContent, false);
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'tdd' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'kiokuko-soul' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'skill' && item.name === 'memory-reasoning' && item.availability === 'available'));
    assert.ok(preparedContent.capabilities.recommendations.some((item) => item.kind === 'mcp_tool' && item.name === 'github_search_code' && item.availability === 'available'));

    const answerCapabilities = [
      SOUL_CAPABILITY,
      { kind: 'skill', name: 'memory-reasoning', description: 'Verify recalled memory before implementation' },
    ];
    const unclassified = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-unclassified-enno-intake-request',
        task: 'Help me with this request',
        capabilities: answerCapabilities,
      },
    });
    const unclassifiedContent = unclassified.structuredContent as {
      intake: { status: string; sessionId: string; question: { id: string } };
      ennoOduno: {
        applicable: boolean;
        status: string;
        orchestrationId: string | null;
        clientBinding: { status: string; clientKind: string | null; clientVersion: string | null; identified: boolean };
        contractRevision: number | null;
        currentRole: string | null;
        directive: { role: string; handoff: null; objective: string; requiredSkills: string[] } | null;
        nextAction: string;
      };
    };
    assert.equal(unclassifiedContent.intake.status, 'needs_answer');
    assert.equal(unclassifiedContent.intake.question.id, 'taskType');
    assert.equal(unclassifiedContent.ennoOduno.applicable, true);
    assert.equal(unclassifiedContent.ennoOduno.status, 'intake');
    assert.equal(unclassifiedContent.ennoOduno.orchestrationId, unclassifiedContent.intake.sessionId);
    assert.deepEqual(unclassifiedContent.ennoOduno.clientBinding, {
      status: 'pending', clientKind: null, clientVersion: null, identified: false,
    });
    assert.equal(unclassifiedContent.ennoOduno.contractRevision, null);
    assert.equal(unclassifiedContent.ennoOduno.currentRole, 'enno-oduno');
    assert.equal(unclassifiedContent.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(unclassifiedContent.ennoOduno.directive?.handoff, null);
    assert.deepEqual(unclassifiedContent.ennoOduno.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-enno-oduno']);
    assert.match(unclassifiedContent.ennoOduno.directive?.objective ?? '', /exact question.*user/iu);
    assert.equal(unclassifiedContent.ennoOduno.nextAction, 'answer_intake');

    const research = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-non-enno-research-request',
        task: 'Research the durable beacon contract',
        profileHints: {
          taskType: 'research',
          target: 'durable beacon contract',
          expected: 'a verified explanation',
          constraints: null,
        },
        capabilities: [],
      },
    });
    const researchContent = research.structuredContent as {
      ennoOduno: { applicable: boolean };
      nextAction: string;
      capabilities: { recommendations: Array<{ name: string; availability: string; required?: boolean }> };
    };
    assert.equal(researchContent.ennoOduno.applicable, false);
    assert.equal(researchContent.nextAction, 'required_capability_unavailable');
    assert.ok(researchContent.capabilities.recommendations.some((item) => item.name === 'kiokuko-soul'
      && item.availability === 'missing'
      && item.required === true));

    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-gated-incomplete-request',
        task: 'Implement the durable beacon',
        profileHints: { taskType: 'build' },
        capabilities: answerCapabilities,
      },
    });
    const incompleteContent = incomplete.structuredContent as {
      intake: { status: string; sessionId: string; question: { id: string } };
      context: unknown;
      run: { runId: string };
      nextAction: string;
      ennoOduno: {
        applicable: boolean;
        status: string;
        orchestrationId: string | null;
        currentRole: string | null;
        directive: { role: string; handoff: null; objective: string; requiredSkills: string[] } | null;
        nextAction: string;
      };
    } & Record<string, unknown>;
    assert.equal(incompleteContent.intake.status, 'needs_answer');
    assert.equal(incompleteContent.intake.question.id, 'target');
    assert.equal(incompleteContent.context, null);
    assert.equal('memory' in incompleteContent, false);
    assert.equal('references' in incompleteContent, false);
    assert.equal(incompleteContent.nextAction, 'answer_from_evidence_or_ask_user');
    assert.equal(incompleteContent.ennoOduno.applicable, true);
    assert.equal(incompleteContent.ennoOduno.status, 'intake');
    assert.equal(incompleteContent.ennoOduno.orchestrationId, incompleteContent.intake.sessionId);
    assert.equal(incompleteContent.ennoOduno.currentRole, 'enno-oduno');
    assert.equal(incompleteContent.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(incompleteContent.ennoOduno.directive?.handoff, null);
    assert.deepEqual(incompleteContent.ennoOduno.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-enno-oduno']);
    assert.match(incompleteContent.ennoOduno.directive?.objective ?? '', /exact question.*user/iu);
    assert.equal(incompleteContent.ennoOduno.nextAction, 'answer_intake');

    const missingRunId = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: answerCapabilities,
      },
    });
    assert.equal(missingRunId.isError, true);
    assert.deepEqual(missingRunId.structuredContent, { code: 'VALIDATION_ERROR', retryable: false });
    assert.match(JSON.stringify(missingRunId.content), /Request is invalid/u);

    const targetAnswered = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: answerCapabilities,
      },
    });
    const targetContent = targetAnswered.structuredContent as { intake: { status: string; question: { id: string } } };
    assert.equal(targetContent.intake.status, 'needs_answer');
    assert.equal(targetContent.intake.question.id, 'expected');

    const completed = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'expected',
        value: 'The durable beacon tests pass',
        capabilities: answerCapabilities,
      },
    });
    const completedContent = completed.structuredContent as {
      intake: { status: string };
      executionContext: { canonicalCwd: string; repositoryRoot: string; cwdIsRepositoryRoot: boolean; pathPolicy: string };
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
        recommendations: Array<{ name: string; source: string; availability: string; required?: boolean }>;
      };
      nextAction: string;
    };
    assert.equal(completedContent.intake.status, 'ready');
    assert.equal(completedContent.nextAction, 'proceed');
    assert.deepEqual(completedContent.executionContext, {
      canonicalCwd: canonicalRoot,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(completedContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(completedContent.capabilities.diagnostics, { received: 2, accepted: 2, truncated: 0, dropped: 0 });
    assert.ok(completedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
      && item.source === 'akinator_policy'
      && item.availability === 'available'
      && item.required === true));

    for (const catalogAvailability of ['missing', 'unknown'] as const) {
      const catalogArguments = catalogAvailability === 'missing' ? { capabilities: [] } : {};
      const pending = await client.callTool({
        name: 'task_prepare',
        arguments: {
          soulRead: true,
          requestId: `mcp-gated-${catalogAvailability}-request`,
          task: 'Implement the durable beacon and add tests',
          profileHints: { taskType: 'build' },
          client: { kind: 'test', sessionId: `task-answer-${catalogAvailability}` },
          ...catalogArguments,
        },
      });
      const pendingContent = pending.structuredContent as {
        intake: { status: string; sessionId: string; question: { id: string } };
        run: { runId: string };
        nextAction: string;
      };
      assert.equal(pendingContent.intake.status, 'needs_answer');
      assert.equal(pendingContent.intake.question.id, 'target');
      assert.equal(pendingContent.nextAction, 'required_capability_unavailable');

      const target = await client.callTool({
        name: 'task_answer',
        arguments: {
          sessionId: pendingContent.intake.sessionId,
          runId: pendingContent.run.runId,
          questionId: 'target',
          value: 'src/beacon.ts',
          ...catalogArguments,
        },
      });
      const targetContent = target.structuredContent as { intake: { status: string; question: { id: string } }; nextAction: string };
      assert.equal(targetContent.intake.status, 'needs_answer');
      assert.equal(targetContent.intake.question.id, 'expected');
      assert.equal(targetContent.nextAction, 'required_capability_unavailable');

      const stopped = await client.callTool({
        name: 'task_answer',
        arguments: {
          sessionId: pendingContent.intake.sessionId,
          runId: pendingContent.run.runId,
          questionId: 'expected',
          value: 'The durable beacon tests pass',
          ...catalogArguments,
        },
      });
      const stoppedContent = stopped.structuredContent as {
        intake: { status: string };
        context: unknown;
        capabilities: Record<string, unknown> & {
          recommendations: Array<{ name: string; source: string; availability: string; required?: boolean }>;
        };
        skillDiscovery: { attempted: boolean; selected: unknown[] };
        memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
        nextAction: string;
      } & Record<string, unknown>;
      assert.equal(stoppedContent.intake.status, 'ready');
      assert.equal(stoppedContent.nextAction, 'required_capability_unavailable');
      assert.deepEqual(stoppedContent.memoryPolicy, {
        memoryReasoningRequired: true,
        contextWithheld: true,
        withheldReason: catalogAvailability === 'missing'
          ? 'memory_reasoning_missing'
          : 'memory_reasoning_unknown',
        deliveryEmpty: true,
        storedEntryCount: 1,
      });
      assert.equal(stoppedContent.context, null);
      assert.equal('memory' in stoppedContent, false);
      assert.equal('references' in stoppedContent, false);
      assert.ok(stoppedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
        && item.source === 'akinator_policy'
        && item.availability === catalogAvailability
        && item.required === true));
      assert.ok(stoppedContent.capabilities.recommendations.some((item) => item.name === 'kiokuko-soul'
        && item.source === 'akinator_policy'
        && item.availability === catalogAvailability
        && item.required === true));
      assert.equal(stoppedContent.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
        && item.source === 'catalog_similarity'), false);
      assert.equal('externalSkillFallback' in stoppedContent.capabilities, false);
      assert.equal(stoppedContent.skillDiscovery.attempted, false);
      assert.deepEqual(stoppedContent.skillDiscovery.selected, []);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP transport projects non-Enno input validation failures to the stable public envelope', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-validation-'));
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko-ai.sqlite') });
  const client = new Client({ name: 'kiokuko-validation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const calls = [
      { name: 'task_prepare', arguments: { requestId: 'missing-soul', task: 'review' } },
      { name: 'task_prepare', arguments: { soulRead: true, requestId: 'relative-cwd', task: 'review', cwd: 'relative/path' } },
      { name: 'task_answer', arguments: { sessionId: 'session', runId: 'run', questionId: 'wrong', value: 'answer' } },
      { name: 'task_prepare', arguments: { soulRead: true, requestId: 'extra-field', task: 'review', unexpected: true } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { code: 'VALIDATION_ERROR', retryable: false });
      const serialized = JSON.stringify(result);
      assert.match(serialized, /Request is invalid/u);
      assert.doesNotMatch(serialized, /Input validation error|invalid_type|unrecognized_keys/iu);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare identifies OpenCode before Oduno derives the ideal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-opencode-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-opencode-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'opencode', version: 'fixture-version' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-client-info-opencode',
        task: 'Repair the add function and make tests pass',
        profileHints: {
          taskType: 'debug',
          target: 'src/add.js',
          expected: 'node --test passes',
        },
        capabilities: [SOUL_CAPABILITY, {
          kind: 'skill',
          name: 'kiokuko-single-purpose-functions',
          description: 'Focused code contracts and tests.',
        }],
      },
    });
    assert.equal(prepared.isError, undefined);
    const content = prepared.structuredContent as {
      ennoOduno: {
        status: string;
        currentRole: string | null;
        clientBinding: {
          status: string;
          clientKind: string | null;
          clientVersion: string | null;
          identified: boolean;
        } | null;
        directive: {
          role: string;
          objective: string;
          requiredSkills: string[];
          harness: { kind: string | null; version: string | null; continuation: string; instructions: string[] };
          handoff: { sourceRole: string; taskType: string } | null;
        } | null;
      };
    };
    assert.equal(content.ennoOduno.status, 'oduno_ideal');
    assert.equal(content.ennoOduno.currentRole, 'enno-oduno');
    assert.deepEqual(content.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: 'opencode',
      clientVersion: 'fixture-version',
      identified: true,
    });
    assert.equal(content.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(content.ennoOduno.directive?.harness.kind, 'opencode');
    assert.equal(content.ennoOduno.directive?.harness.version, 'fixture-version');
    assert.equal(content.ennoOduno.directive?.harness.continuation, 'session_idle_plugin');
    assert.ok(content.ennoOduno.directive?.harness.instructions.some((instruction) => /Own intake.*state transitions/iu.test(instruction)));
    assert.ok(content.ennoOduno.directive?.harness.instructions.some((instruction) => /kiokuko-enno-oduno/iu.test(instruction)));
    assert.deepEqual(content.ennoOduno.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-enno-oduno']);
    assert.match(content.ennoOduno.directive?.objective ?? '', /optimal goal.*task_prepare handoff/iu);
    assert.match(content.ennoOduno.directive?.objective ?? '', /call enno_ideal_submit/iu);
    assert.equal(content.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(content.ennoOduno.directive?.handoff?.taskType, 'debug');

    const conflict = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-client-info-conflict',
        task: 'Repair another function',
        profileHints: { taskType: 'debug', target: 'src/other.js', expected: 'tests pass' },
        capabilities: [],
        client: { kind: 'other-client' },
      },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /conflict/iu);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('enno_plan_submit returns the userFacingConfirmation projection over the MCP boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-confirmation-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-confirmation-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-confirmation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [SOUL_CAPABILITY, {
      kind: 'skill',
      name: 'kiokuko-single-purpose-functions',
      description: 'Focused code contracts and tests.',
    }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-confirmation-request',
        task: 'Repair the add function and make tests pass',
        profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'node --test passes' },
        capabilities,
      },
    });
    const preparedContent = prepared.structuredContent as {
      run: { runId: string };
      project: { workspace: string };
      intake: { sessionId: string };
      ennoOduno: { status: string };
    };
    assert.equal(preparedContent.ennoOduno.status, 'oduno_ideal');
    const identity = {
      runId: preparedContent.run.runId,
      workspace: preparedContent.project.workspace,
      orchestrationId: preparedContent.intake.sessionId,
    };
    const ideal = await client.callTool({
      name: 'enno_ideal_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-confirmation-ideal',
        ideal: {
          objective: 'Repair the add function with focused verification',
          principles: ['Preserve the public API'],
          skillContributions: [],
          successSignals: ['node --test passes'],
        },
      },
    });
    const idealContent = ideal.structuredContent as { ennoOduno: { status: string } };
    assert.equal(idealContent.ennoOduno.status, 'zenki_planning');
    const plan = await client.callTool({
      name: 'enno_plan_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-confirmation-plan',
        scope: ['src/add.js'],
        exclusions: [],
        acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
        workPlan: {
          objective: 'Repair add behind the confirmation',
          units: [{
            id: 'repair-add',
            objective: 'Repair the add implementation',
            scope: ['src/add.js'],
            dependencies: [],
            routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'],
            expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the add regression with focused tests' }],
            acceptanceCriteria: ['node --test passes'],
            focusedVerifiers: [],
          }],
        },
        skillRequirements: [],
        finalVerifiers: [{ id: 'final-test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5000 }],
        maxAttempts: 5,
        provenance: {
          scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
          workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
        },
        capabilities,
      },
    });
    assert.equal(plan.isError, undefined);
    const planContent = plan.structuredContent as {
      ennoOduno: {
        status: string;
        contractRevision: number;
        directive: {
          objective: string;
          userFacingConfirmation?: {
            presentationVersion: number;
            summary: { basis: string; text: string };
            scope: { basis: string; paths: string[] };
            workItems: Array<{ number: number; summary: string; expertise: Array<{ area: string; reason: string }> }>;
            finalChecks: { checks: Array<{ executable: string; arguments: string[]; directory: string; timeoutMs: number }> };
            attemptLimit: { basis: string; maxAttempts: number };
            actions: string[];
          };
        } | null;
      };
    };
    assert.equal(planContent.ennoOduno.status, 'needs_confirmation');
    assert.equal(planContent.ennoOduno.contractRevision, 2);
    assert.match(planContent.ennoOduno.directive?.objective ?? '', /Return every item in userFacingConfirmation/iu);
    const projection = planContent.ennoOduno.directive?.userFacingConfirmation;
    assert.ok(projection !== undefined);
    assert.equal(projection.presentationVersion, 1);
    assert.equal(projection.summary.basis, 'proposal');
    assert.equal(projection.scope.basis, 'user');
    assert.equal(projection.workItems[0]?.number, 1);
    assert.equal(projection.workItems[0]?.expertise[0]?.area, 'Regression prevention and verification design');
    assert.deepEqual(projection.finalChecks.checks[0], {
      category: 'test', executable: process.execPath, arguments: ['--eval', 'process.exit(0)'], directory: '.', timeoutMs: 5000,
    });
    assert.deepEqual(projection.actions, ['approve', 'revise', 'cancel']);
    const rendered = JSON.stringify(projection);
    for (const forbidden of ['repair-add', 'final-test', 'code.verification.v1', 'expertRefs', 'focusedVerifiers', 'finalVerifiers', 'provenance']) {
      assert.equal(rendered.includes(forbidden), false, `MCP projection leaked internal token: ${forbidden}`);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP transports advisory submission and final verification preparation with replay and conflict boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-advisory-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-advisory-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-advisory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [SOUL_CAPABILITY, {
      kind: 'skill',
      name: 'kiokuko-single-purpose-functions',
      description: 'Focused code contracts and tests.',
    }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-advisory-request',
        cwd: root,
        task: 'Repair the add function and make tests pass',
        profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'node --test passes' },
        capabilities,
      },
    });
    assert.equal(prepared.isError, undefined);
    const preparedContent = prepared.structuredContent as {
      run: { runId: string };
      project: { workspace: string };
      intake: { sessionId: string };
      ennoOduno: {
        status: string;
        directive: { advisoryRound?: { phase: string; context: Record<string, unknown>; slots: unknown[] } };
      };
    };
    assert.equal(preparedContent.ennoOduno.status, 'oduno_ideal');
    const identity = {
      runId: preparedContent.run.runId,
      workspace: preparedContent.project.workspace,
      orchestrationId: preparedContent.intake.sessionId,
    };
    const idealRound = preparedContent.ennoOduno.directive.advisoryRound;
    assert.ok(idealRound);
    assert.equal(idealRound.phase, 'ideal');
    assert.equal(idealRound.slots.length, 3);
    const serializedAdvisorContext = JSON.stringify(idealRound.context);
    for (const forbidden of [identity.runId, identity.workspace, identity.orchestrationId, 'idempotencyKey', 'contractRevision', 'mutationRevision']) {
      assert.equal(serializedAdvisorContext.includes(forbidden), false, `MCP advisor context leaked ${forbidden}`);
    }
    const contributions = [
      { slotId: 'constraint_guardian', outcome: 'completed', summary: 'Preserve constraints', recommendations: [], risks: [], evidence: [] },
      { slotId: 'skill_trust_analyst', outcome: 'completed', summary: 'Use only trusted local guidance', recommendations: [], risks: [], evidence: [] },
      { slotId: 'success_signal_critic', outcome: 'completed', summary: 'Require passing tests', recommendations: [], risks: [], evidence: [] },
    ];
    const adviceArguments = {
      ...identity,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'mcp-advice-1',
      phase: 'ideal',
      allowlistedContext: idealRound.context,
      contributions,
    };
    const advice = await client.callTool({ name: 'enno_advice_submit', arguments: adviceArguments });
    assert.equal(advice.isError, undefined);
    const adviceContent = advice.structuredContent as { ennoOduno: { status: string }; advisoryRound: { inputDigest: string } };
    assert.equal(adviceContent.ennoOduno.status, 'oduno_ideal');
    assert.match(adviceContent.advisoryRound.inputDigest, /^[0-9a-f]{64}$/u);
    const adviceRead = await client.callTool({
      name: 'enno_advice_read',
      arguments: {
        ...identity,
        expectedRevision: 1,
        advisoryRoundDigest: adviceContent.advisoryRound.inputDigest,
      },
    });
    assert.equal(adviceRead.isError, undefined);
    const adviceReadContent = adviceRead.structuredContent as {
      protocolVersion: number;
      advisoryRound: { inputDigest: string; contributions: unknown[] };
      allowlistedContext: Record<string, unknown>;
    };
    assert.equal(adviceReadContent.protocolVersion, 1);
    assert.equal(adviceReadContent.advisoryRound.inputDigest, adviceContent.advisoryRound.inputDigest);
    assert.equal(adviceReadContent.advisoryRound.contributions.length, 3);
    assert.deepEqual(adviceReadContent.allowlistedContext, idealRound.context);
    const adviceReplay = await client.callTool({ name: 'enno_advice_submit', arguments: adviceArguments });
    assert.deepEqual(adviceReplay.structuredContent, advice.structuredContent);
    const adviceConflict = await client.callTool({
      name: 'enno_advice_submit',
      arguments: {
        ...adviceArguments,
        contributions: [{ ...contributions[0], summary: 'Changed input' }, contributions[1], contributions[2]],
      },
    });
    assert.equal(adviceConflict.isError, true);
    assert.match(JSON.stringify(adviceConflict.content), /conflict/iu);

    const ideal = await client.callTool({
      name: 'enno_ideal_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-advisory-ideal',
        advisoryRoundDigest: adviceContent.advisoryRound.inputDigest,
        advisoryDisposition: [
          { slotId: 'constraint_guardian', disposition: 'adopted', rationale: 'Preserve constraints' },
          { slotId: 'skill_trust_analyst', disposition: 'adopted', rationale: 'Use bounded guidance' },
          { slotId: 'success_signal_critic', disposition: 'adopted', rationale: 'Require tests' },
        ],
        ideal: {
          objective: 'Repair the add function with focused verification',
          principles: ['Preserve the public API'],
          skillContributions: [],
          successSignals: ['node --test passes'],
        },
      },
    });
    assert.equal(ideal.isError, undefined);
    const idealContent = ideal.structuredContent as { ennoOduno: { status: string; directive: { advisoryRound?: { context: Record<string, unknown> } } } };
    assert.equal(idealContent.ennoOduno.status, 'zenki_planning');
    const planningContext = idealContent.ennoOduno.directive.advisoryRound?.context;
    assert.ok(planningContext);
    const plan = await client.callTool({
      name: 'enno_plan_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-advisory-plan',
        scope: ['src/add.js'],
        exclusions: [],
        acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
        workPlan: {
          objective: 'Repair add',
          units: [{
            id: 'repair-add', objective: 'Repair add', scope: ['src/add.js'], dependencies: [],
            routes: ['code'], skillNames: [], expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the repair with focused verification' }],
            acceptanceCriteria: ['node --test passes'], focusedVerifiers: [],
          }],
        },
        skillRequirements: [],
        finalVerifiers: [{ id: 'mcp-final', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5000 }],
        maxAttempts: 3,
        provenance: {
          scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
          workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
        },
        capabilities,
      },
    });
    assert.equal(plan.isError, undefined, JSON.stringify(plan.content));
    const planContent = plan.structuredContent as { ennoOduno: { status: string } };
    assert.equal(planContent.ennoOduno.status, 'goki_executing');
    const worked = await client.callTool({
      name: 'enno_work_report',
      arguments: {
        ...identity,
        expectedRevision: 2,
        idempotencyKey: 'mcp-advisory-work',
        workUnitId: 'repair-add',
        result: { outcome: 'completed', summary: 'Repair completed', mutated: false, changedPaths: [] },
      },
    });
    assert.equal(worked.isError, undefined);
    const workedContent = worked.structuredContent as { ennoOduno: { status: string; nextAction: string; directive: { advisoryRound?: unknown } } };
    assert.equal(workedContent.ennoOduno.status, 'enno_verifying');
    assert.equal(workedContent.ennoOduno.nextAction, 'run_final_verification');
    assert.equal(workedContent.ennoOduno.directive.advisoryRound, undefined);

    const verifyArguments = {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'mcp-verify-prepare-1',
    };
    const verified = await client.callTool({ name: 'enno_verify_prepare', arguments: verifyArguments });
    assert.equal(verified.isError, undefined);
    const verifiedContent = verified.structuredContent as {
      ennoOduno: { status: string; nextAction: string; directive: { advisoryRound?: { phase: string; context: Record<string, unknown> } } };
      verifierResults: Array<{ status: string }>;
    };
    assert.equal(verifiedContent.ennoOduno.status, 'enno_verifying');
    assert.equal(verifiedContent.ennoOduno.nextAction, 'submit_final_review');
    assert.equal(verifiedContent.verifierResults[0]?.status, 'passed');
    assert.equal(verifiedContent.ennoOduno.directive.advisoryRound?.phase, 'final_review');
    const verifyReplay = await client.callTool({ name: 'enno_verify_prepare', arguments: verifyArguments });
    assert.deepEqual(verifyReplay.structuredContent, verified.structuredContent);
    const verifyConflict = await client.callTool({
      name: 'enno_verify_prepare',
      arguments: { ...verifyArguments, expectedRevision: 99 },
    });
    assert.equal(verifyConflict.isError, true);
    assert.match(JSON.stringify(verifyConflict.content), /conflict/iu);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('plan-start recovery exposes only concise user choices and leaves the same run reusable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-plan-recovery-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-plan-recovery-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-plan-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [SOUL_CAPABILITY, {
      kind: 'skill',
      name: 'kiokuko-single-purpose-functions',
      description: 'Focused code contracts and tests.',
    }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-plan-recovery-request',
        task: 'Repair the add function',
        profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass' },
        capabilities,
      },
    });
    const preparedContent = prepared.structuredContent as {
      run: { runId: string };
      project: { workspace: string; repositoryRoot: string };
      intake: { sessionId: string };
    };
    const identity = {
      runId: preparedContent.run.runId,
      workspace: preparedContent.project.workspace,
      orchestrationId: preparedContent.intake.sessionId,
    };
    await client.callTool({
      name: 'enno_ideal_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-plan-recovery-ideal',
        ideal: {
          objective: 'Repair the add function with focused verification',
          principles: ['Preserve the public API'],
          skillContributions: [],
          successSignals: ['tests pass'],
        },
      },
    });
    const plan = {
      ...identity,
      expectedRevision: 1,
      scope: ['src/add.js'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: {
        objective: 'Repair add with a reusable plan',
        units: [{
          id: 'repair-add',
          objective: 'Repair the add implementation',
          scope: ['src/add.js'],
          dependencies: [],
          routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'],
          expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the regression with focused evidence' }],
          acceptanceCriteria: ['tests pass'],
          focusedVerifiers: [],
        }],
      },
      skillRequirements: [],
      finalVerifiers: [{
        id: 'final-test', kind: 'test', executable: process.execPath,
        args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5000,
      }],
      maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    };

    const invalidPlan = await client.callTool({
      name: 'enno_plan_submit',
      arguments: {
        ...plan,
        idempotencyKey: 'mcp-plan-structured-invalid',
        capabilities,
        workPlan: {
          ...plan.workPlan,
          units: [{
            ...plan.workPlan.units[0],
            expertRefs: [
              { id: 'code.boundary.v1', reason: 'Boundary' },
              { id: 'code.domain.v1', reason: 'Domain' },
              { id: 'code.effects.v1', reason: 'Effects' },
              { id: 'code.protocol.v1', reason: 'Protocol' },
            ],
          }],
        },
      },
    });
    assert.equal(invalidPlan.isError, true);
    assert.deepEqual(invalidPlan.content, [{ type: 'text', text: 'Request is invalid' }]);
    assert.deepEqual(invalidPlan.structuredContent, {
      code: 'ENNO_INPUT_INVALID',
      operation: 'plan_submit',
      presentationVersion: 1,
      issues: [{
        path: ['workPlan', 'units', 0, 'expertRefs'],
        reasonCode: 'too_many_items',
        expected: { maxItems: 3 },
      }],
      retry: 'correct_input',
      mutationApplied: false,
    });

    const recovery = await client.callTool({
      name: 'enno_plan_submit',
      arguments: { ...plan, idempotencyKey: 'mcp-plan-recovery-missing' },
    });
    assert.equal(recovery.isError, true);
    const recoveryContent = recovery.structuredContent as {
      code: string;
      reason: string;
      effect: {
        mutationApplied: boolean;
        continuationPaused: boolean;
        planPersisted: boolean;
        advisoryConsumed: boolean;
        operationReceiptCreated: boolean;
        implementationStarted: boolean;
      };
      retry: { sameRunAllowed: boolean; requiresUserChoice: boolean };
      userFacingRecovery: {
        presentationVersion: number;
        whatHappened: string;
        workState: string;
        resolution: string;
        options: Array<{
          action: string;
          label: string;
          recommended: boolean;
          whenToChoose: string;
          whatHappens: string;
        }>;
      };
    };
    assert.equal(recoveryContent.code, 'PLAN_START_RECOVERY_REQUIRED');
    assert.equal(recoveryContent.reason, 'environment_information_missing');
    assert.deepEqual(recoveryContent.effect, {
      mutationApplied: false,
      continuationPaused: true,
      planPersisted: false,
      advisoryConsumed: false,
      operationReceiptCreated: false,
      implementationStarted: false,
    });
    assert.deepEqual(recoveryContent.retry, { sameRunAllowed: true, requiresUserChoice: true });
    assert.equal(recoveryContent.userFacingRecovery.presentationVersion, 1);
    assert.match(recoveryContent.userFacingRecovery.whatHappened, /features available in this environment.*not carried into the plan/iu);
    assert.match(recoveryContent.userFacingRecovery.workState, /did not begin new work or make additional code changes/iu);
    assert.match(recoveryContent.userFacingRecovery.resolution, /continue with the same plan/iu);
    assert.deepEqual(recoveryContent.userFacingRecovery.options, [
      {
        action: 'continue_same_plan',
        label: 'Continue with the same plan',
        recommended: true,
        whenToChoose: 'The plan is still correct and only the current environment information needs to be attached.',
        whatHappens: 'The current environment information is attached automatically, and the same attempt continues.',
      },
      {
        action: 'revise_plan',
        label: 'Review the plan',
        recommended: false,
        whenToChoose: 'You want to change the scope, work items, or verification before continuing.',
        whatHappens: 'You are asked what to change, and implementation does not start until you answer.',
      },
      {
        action: 'cancel',
        label: 'Cancel',
        recommended: false,
        whenToChoose: 'You no longer want this work to continue.',
        whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
      },
    ]);
    const visible = JSON.stringify(recovery.content);
    for (const option of recoveryContent.userFacingRecovery.options) {
      assert.match(visible, new RegExp(option.label, 'u'));
      assert.match(visible, new RegExp(option.whenToChoose, 'u'));
      assert.match(visible, new RegExp(option.whatHappens, 'u'));
    }
    assert.equal((visible.match(/Recommended/gu) ?? []).length, 1);
    for (const forbidden of [
      'enno_', 'capabilities', 'catalog', 'digest', 'revision', identity.runId,
      'continue_same_plan', 'whenToChoose', 'whatHappens', 'presentationVersion',
    ]) {
      assert.equal(visible.toLowerCase().includes(forbidden.toLowerCase()), false, `recovery display leaked internal token: ${forbidden}`);
    }
    const inspection = openConnection(databasePath);
    try {
      assert.equal(inspection.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
        .get<{ status: string }>(identity.runId)?.status, 'active');
      const contract = inspection.prepare('SELECT status, revision FROM enno_contracts WHERE run_id = ?')
        .get<{ status: string; revision: number }>(identity.runId);
      assert.deepEqual(contract === undefined ? undefined : { ...contract }, { status: 'zenki_planning', revision: 1 });
      assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE run_id = ? AND operation = 'plan_submit'")
        .get<{ count: number }>(identity.runId)?.count, 0);
    } finally {
      inspection.close();
    }
    await assert.rejects(access(path.join(root, 'src', 'add.js')));

    const continued = await client.callTool({
      name: 'enno_plan_submit',
      arguments: {
        ...plan,
        idempotencyKey: 'mcp-plan-recovery-continued',
        capabilities,
        recoveryAction: 'continue_same_plan',
      },
    });
    assert.equal(continued.isError, undefined);
    assert.equal((continued.structuredContent as { ennoOduno: { status: string } }).ennoOduno.status, 'goki_executing');
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('malformed compatibility discovery degrades across task_prepare and enno_plan_submit without an integrity error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-malformed-discovery-repo-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-malformed-discovery-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  let registryCalls = 0;
  let sourceCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'skills.sh') {
      sourceCalls += 1;
      throw new Error(`unexpected source fetch: ${url.origin}${url.pathname}`);
    }
    registryCalls += 1;
    const query = url.searchParams.get('q') ?? '';
    return new Response(JSON.stringify({
      skills: [],
      query,
      searchType: query.includes(' ') ? 'semantic' : 'fuzzy',
      count: 0,
      duration_ms: 1,
      searchVersion: 'undocumented-fixture',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root, fetchImpl });
  const client = new Client({ name: 'opencode-malformed-discovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [SOUL_CAPABILITY, {
      kind: 'skill',
      name: 'kiokuko-single-purpose-functions',
      description: 'Focused code contracts and tests.',
    }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-malformed-discovery-request',
        task: 'Repair the Svelte component and make tests pass',
        profileHints: { taskType: 'debug', target: 'src/component.ts', expected: 'node --test passes' },
        capabilities,
      },
    });
    assert.equal(prepared.isError, undefined);
    assert.doesNotMatch(JSON.stringify(prepared), /Internal integrity error/u);
    const preparedContent = prepared.structuredContent as {
      run: { runId: string };
      project: { workspace: string };
      intake: { sessionId: string };
      ennoOduno: { status: string };
      skillDiscovery: { selected: unknown[]; failures: Array<{ stage: string; code: string }> };
    };
    assert.equal(preparedContent.ennoOduno.status, 'oduno_ideal');
    assert.deepEqual(preparedContent.skillDiscovery.selected, []);
    assert.deepEqual(preparedContent.skillDiscovery.failures, [{ stage: 'search', code: 'registry_invalid_response' }]);
    const identity = {
      runId: preparedContent.run.runId,
      workspace: preparedContent.project.workspace,
      orchestrationId: preparedContent.intake.sessionId,
    };
    const ideal = await client.callTool({
      name: 'enno_ideal_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-malformed-discovery-ideal',
        ideal: {
          objective: 'Repair the Svelte component with focused verification',
          principles: ['Preserve the public API'],
          skillContributions: [],
          successSignals: ['node --test passes'],
        },
      },
    });
    assert.equal(ideal.isError, undefined);
    const plan = await client.callTool({
      name: 'enno_plan_submit',
      arguments: {
        ...identity,
        expectedRevision: 1,
        idempotencyKey: 'mcp-malformed-discovery-plan',
        scope: ['src/component.ts'],
        exclusions: [],
        acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
        workPlan: {
          objective: 'Repair the Svelte component',
          units: [{
            id: 'repair-component',
            objective: 'Repair the Svelte component',
            scope: ['src/component.ts'],
            dependencies: [],
            routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'],
            expertRefs: [
              { id: 'code.boundary.v1', reason: 'Keep malformed provider data outside the planning boundary' },
              { id: 'code.protocol.v1', reason: 'Preserve replay and idempotency contracts' },
              { id: 'code.verification.v1', reason: 'Prove the MCP regression with focused evidence' },
            ],
            acceptanceCriteria: ['node --test passes'],
            focusedVerifiers: [],
          }],
        },
        skillRequirements: [],
        finalVerifiers: [{ id: 'final-test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5000 }],
        maxAttempts: 1,
        provenance: {
          scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
          workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
        },
        capabilities,
      },
    });
    assert.equal(plan.isError, undefined);
    assert.doesNotMatch(JSON.stringify(plan), /Internal integrity error/u);
    const planContent = plan.structuredContent as { ennoOduno: { status: string } };
    assert.equal(planContent.ennoOduno.status, 'goki_executing');
    assert.equal(registryCalls, 2);
    assert.equal(sourceCalls, 0);

    const database = openConnection(databasePath);
    try {
      const contractRow = database.prepare('SELECT contract_json AS contractJson FROM enno_contracts WHERE run_id = ?')
        .get<{ contractJson: string }>(identity.runId);
      assert.ok(contractRow !== undefined);
      const contract = JSON.parse(contractRow.contractJson) as {
        skillSet: { zenkiDiscovery: { selected: unknown[]; failures: Array<{ stage: string; code: string }> } };
      };
      assert.deepEqual(contract.skillSet.zenkiDiscovery.selected, []);
      assert.deepEqual(contract.skillSet.zenkiDiscovery.failures, [{ stage: 'search', code: 'registry_invalid_response' }]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
      assert.deepEqual(database.prepare(`
        SELECT phase, state FROM agent_task_skill_discovery_attempts
        WHERE run_id = ? ORDER BY phase
      `).all(identity.runId).map((row) => ({ ...row })), [
        { phase: 'intake', state: 'completed' },
        { phase: 'zenki', state: 'completed' },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('memory_checkpoint returns actionable MCP guidance during intake and succeeds after task_answer finalizes the run', async () => {  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-recovery-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-recovery-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-checkpoint-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }];
    const prepared = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-checkpoint-recovery-request',
        task: 'Implement the checkpoint recovery behavior',
        profileHints: { taskType: 'build' },
        capabilities,
      },
    });
    const preparedContent = prepared.structuredContent as {
      intake: { status: string; sessionId: string; question: { id: string } };
      run: { runId: string };
      nextAction: string;
    };
    assert.equal(preparedContent.intake.status, 'needs_answer');
    assert.equal(preparedContent.nextAction, 'answer_from_evidence_or_ask_user');
    const runId = preparedContent.run.runId;

    const before = openConnection(databasePath);
    let eventCount: number;
    try {
      eventCount = before.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0;
    } finally {
      before.close();
    }

    const earlyCheckpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Recovery sentinel', body: 'token=private-intake-checkpoint-sentinel must not persist during intake.' }],
      },
    });
    assert.equal(earlyCheckpoint.isError, true);
    assert.equal(JSON.stringify(earlyCheckpoint).includes('private-intake-checkpoint-sentinel'), false);
    assert.deepEqual(earlyCheckpoint.content, [{
      type: 'text',
      text: 'Checkpoint is blocked while the run awaits intake answers. Complete task_answer before retrying.',
    }]);
    assert.deepEqual(earlyCheckpoint.structuredContent, {
      code: 'CHECKPOINT_RUN_NOT_ACTIVE',
      reason: 'run_awaiting_intake_answer',
      runStatus: 'intake',
      nextAction: 'answer_from_evidence_or_ask_user',
      retryableAfterStateChange: true,
    });

    const afterEarlyCheckpoint = openConnection(databasePath);
    try {
      assert.equal(afterEarlyCheckpoint.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(runId)?.status, 'intake');
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(runId)?.count, eventCount);
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
      assert.equal(afterEarlyCheckpoint.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
    } finally {
      afterEarlyCheckpoint.close();
    }

    const target = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: preparedContent.intake.sessionId,
        runId,
        questionId: 'target',
        value: 'src/mcp/server.ts',
        capabilities,
      },
    });
    const targetContent = target.structuredContent as { intake: { status: string; question: { id: string } }; nextAction: string };
    assert.equal(targetContent.intake.status, 'needs_answer');
    assert.equal(targetContent.intake.question.id, 'expected');
    assert.equal(targetContent.nextAction, 'answer_from_evidence_or_ask_user');

    const completed = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: preparedContent.intake.sessionId,
        runId,
        questionId: 'expected',
        value: 'Focused tests pass',
        capabilities,
      },
    });
    const completedContent = completed.structuredContent as { intake: { status: string }; nextAction: string };
    assert.equal(completedContent.intake.status, 'ready');
    assert.equal(completedContent.nextAction, 'proceed');

    const finalCheckpoint = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Recovery lesson', body: 'Complete task_answer before checkpointing the run.' }],
      },
    });
    assert.equal(finalCheckpoint.isError, undefined);
    const finalContent = finalCheckpoint.structuredContent as { run: { runId: string; status: string }; entries: unknown[] };
    assert.deepEqual(finalContent.run, {
      runId,
      status: 'completed',
      feedbackCount: 0,
      evidenceCount: 0,
      reasoningPaths: 1,
      qualifiedReasoningPaths: 0,
    });
    assert.equal(finalContent.entries.length, 1);

    const terminalRetry = await client.callTool({
      name: 'memory_checkpoint',
      arguments: {
        runId,
        outcome: 'completed',
        memories: [{ kind: 'lesson', title: 'Terminal retry sentinel', body: 'This must not create a second checkpoint.' }],
      },
    });
    assert.equal(terminalRetry.isError, true);
    assert.deepEqual(terminalRetry.content, [{
      type: 'text',
      text: 'Checkpoint is blocked because the run is terminal.',
    }]);
    assert.deepEqual(terminalRetry.structuredContent, {
      code: 'CHECKPOINT_RUN_NOT_ACTIVE',
      reason: 'run_terminal',
      runStatus: 'completed',
      nextAction: 'stop',
      retryableAfterStateChange: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare degrades safely for oversized and malformed capability items', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-capability-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-capability-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-capability-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: 'memory_checkpoint',
      arguments: { memories: [{ kind: 'lesson', title: 'Oversized catalog beacon', body: 'Keep capability handling bounded and ephemeral.' }] },
    });
    const knownMissing = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-known-missing-memory-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: [SOUL_CAPABILITY],
      },
    });
    const knownMissingContent = knownMissing.structuredContent as {
      context: null;
      nextAction: string;
      capabilities: { availability: string; recommendations: Array<{ name: string; availability: string }> };
      memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
    };
    assert.equal(knownMissingContent.context, null);
    assert.equal(knownMissingContent.nextAction, 'proceed');
    assert.deepEqual(knownMissingContent.memoryPolicy, {
      memoryReasoningRequired: true,
      contextWithheld: true,
      withheldReason: 'memory_reasoning_missing',
      deliveryEmpty: true,
      storedEntryCount: 1,
    });
    assert.equal(knownMissingContent.capabilities.availability, 'known-nonempty');
    assert.ok(knownMissingContent.capabilities.recommendations.some(
      (item) => item.name === 'memory-reasoning' && item.availability === 'missing',
    ));

    const sentinel = 'capability-secret-sentinel-private-path';
    const oversizedCapabilities = [
      SOUL_CAPABILITY,
      { kind: 'skill', name: 'tdd', description: `${sentinel}${'x'.repeat(64_001)}` },
      { kind: 'mcp_tool', name: 'repository_search', description: `${sentinel}${'y'.repeat(64_001)}` },
      { kind: 'invalid', name: 'discarded' },
    ];
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-oversized-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      run: { runId: string };
      nextAction: string;
      context: null;
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
        recommendations: Array<{ name: string; availability: string }>;
        warnings: Array<{ message: string }>;
      };
      warnings: Array<{ message: string }>;
      memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
    } & Record<string, unknown>;
    assert.equal(content.context, null);
    assert.deepEqual(content.memoryPolicy, {
      memoryReasoningRequired: true,
      contextWithheld: true,
      withheldReason: 'memory_reasoning_unknown',
      deliveryEmpty: true,
      storedEntryCount: 1,
    });
    assert.equal('memory' in content, false);
    assert.equal('references' in content, false);
    assert.equal(content.capabilities.availability, 'unknown');
    assert.deepEqual(content.capabilities.diagnostics, { received: 4, accepted: 3, truncated: 2, dropped: 1 });
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'kiokuko-soul' && item.availability === 'available'));
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'tdd' && item.availability === 'available'));
    assert.ok(content.capabilities.recommendations.some((item) => item.name === 'memory-reasoning' && item.availability === 'unknown'));
    assert.equal(content.nextAction, 'proceed');
    assert.equal(content.capabilities.warnings.length, 3);
    assert.deepEqual(content.warnings, content.capabilities.warnings);
    assert.match(JSON.stringify(content), /CAPABILITY_CATALOG_UNAVAILABLE|could not be safely classified/u);
    assert.equal(JSON.stringify(content).includes(sentinel), false);
    const available = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-available-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }],
      },
    });
    const availableContent = available.structuredContent as {
      context: { policyVersion: string; deliveryId: string };
      capabilities: {
        availability: string;
        diagnostics: { received: number; accepted: number; truncated: number; dropped: number };
      };
      nextAction: string;
      memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
    };
    assert.equal(availableContent.nextAction, 'proceed');
    assert.deepEqual(availableContent.memoryPolicy, {
      memoryReasoningRequired: true,
      contextWithheld: false,
      withheldReason: null,
    });
    assert.equal(availableContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(availableContent.capabilities.diagnostics, { received: 2, accepted: 2, truncated: 0, dropped: 0 });
     assert.equal(availableContent.context.policyVersion, 'context-ranking-v6');

    const exactBoundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-exact-boundary-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 200 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    const exactBoundaryContent = exactBoundary.structuredContent as { run: { runId: string }; capabilities: { availability: string; diagnostics: unknown } };
    assert.equal(exactBoundaryContent.capabilities.availability, 'known-nonempty');
    assert.deepEqual(
      exactBoundaryContent.capabilities.diagnostics,
      { received: 200, accepted: 200, truncated: 0, dropped: 0 },
    );

    const boundary = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-over-boundary-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: Array.from({ length: 201 }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` })),
      },
    });
    const boundaryContent = boundary.structuredContent as { run: { runId: string }; capabilities: { availability: string; diagnostics: unknown } };
    assert.notEqual(exactBoundaryContent.run.runId, content.run.runId);
    assert.notEqual(boundaryContent.run.runId, exactBoundaryContent.run.runId);
    assert.equal(boundaryContent.capabilities.availability, 'unknown');
    assert.deepEqual(boundaryContent.capabilities.diagnostics, { received: 201, accepted: 200, truncated: 0, dropped: 1 });

    const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
      - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
      - 8;
    const budgetCapabilities = [
      ...Array.from({ length: 7 }, () => ({ kind: 'mcp_tool', name: 'x', description: 'a'.repeat(MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) })),
      { kind: 'skill', name: 'y', description: 'b'.repeat(finalExactDescription + 1) },
    ];
    const budget = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-budget-catalog-request',
        task: 'Implement the oversized catalog beacon and add tests',
        profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
        capabilities: budgetCapabilities,
      },
    });
    const budgetContent = budget.structuredContent as { capabilities: { availability: string; diagnostics: unknown; warnings: Array<{ code: string }> } };
    assert.equal(budgetContent.capabilities.availability, 'unknown');
    assert.deepEqual(budgetContent.capabilities.diagnostics, { received: 8, accepted: 8, truncated: 8, dropped: 0 });
    assert.ok(budgetContent.capabilities.warnings.some((warning) => warning.code === 'CAPABILITY_CATALOG_BUDGET_EXCEEDED'));

    const incomplete = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'mcp-oversized-incomplete-request', task: 'Implement the oversized catalog beacon', profileHints: { taskType: 'build' }, capabilities: oversizedCapabilities },
    });
    const incompleteContent = incomplete.structuredContent as { intake: { sessionId: string; question: { id: string } }; run: { runId: string } };
    const target = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal((target.structuredContent as { intake: { question: { id: string } } }).intake.question.id, 'expected');
    const answered = await client.callTool({
      name: 'task_answer',
      arguments: {
        sessionId: incompleteContent.intake.sessionId,
        runId: incompleteContent.run.runId,
        questionId: 'expected',
        value: 'The tests pass',
        capabilities: oversizedCapabilities,
      },
    });
    assert.equal((answered.structuredContent as { intake: { status: string }; capabilities: { availability: string } }).intake.status, 'ready');
    assert.equal((answered.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');

    const catalogBase = {
      task: 'Implement the oversized catalog beacon and add tests',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'The tests pass' },
    };
    const explicitEmpty = await client.callTool({ name: 'task_prepare', arguments: { soulRead: true, ...catalogBase, requestId: 'mcp-explicit-empty-catalog-request', capabilities: [] } });
    const omitted = await client.callTool({ name: 'task_prepare', arguments: { soulRead: true, ...catalogBase, requestId: 'mcp-omitted-catalog-request' } });
    const whollyInvalid = await client.callTool({ name: 'task_prepare', arguments: { soulRead: true, ...catalogBase, requestId: 'mcp-invalid-catalog-request', capabilities: [{ kind: 'invalid', name: 'invalid' }] } });
    const nonArray = await client.callTool({ name: 'task_prepare', arguments: { soulRead: true, ...catalogBase, requestId: 'mcp-non-array-catalog-request', capabilities: { kind: 'skill', name: 'memory-reasoning' } } });
    assert.equal((explicitEmpty.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'known-empty');
    assert.equal((omitted.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');
    assert.equal((whollyInvalid.structuredContent as { capabilities: { availability: string } }).capabilities.availability, 'unknown');
    assert.equal(nonArray.isError, true);

    const database = openConnection(databasePath);
    try {
      const persisted = JSON.stringify({
        runs: database.prepare('SELECT * FROM ledger_runs').all(),
        sessions: database.prepare('SELECT * FROM akinator_sessions').all(),
        events: database.prepare('SELECT * FROM ledger_events').all(),
        deliveries: database.prepare('SELECT * FROM context_deliveries').all(),
      });
      assert.equal(persisted.includes(sentinel), false);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(content.run.runId)?.count, 0);
       assert.equal(database.prepare('SELECT policy_version FROM context_deliveries WHERE delivery_id = ?').get<{ policy_version: string }>(availableContent.context.deliveryId)?.policy_version, 'context-ranking-v6');
      const storedReasons = database.prepare(`
        SELECT selection_reason_json
          FROM context_delivery_entries
         WHERE delivery_id = ?
         ORDER BY rank ASC
         LIMIT 1
      `).get<{ selection_reason_json: string }>(availableContent.context.deliveryId);
      assert.ok(storedReasons);
      const parsedReasons = JSON.parse(storedReasons.selection_reason_json) as string[];
      assert.ok(parsedReasons.some((reason) => ['word_match', 'lexical_match', 'substring_match', 'literal_fallback_match', 'tag_match'].includes(reason)));
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare proceeds without memory-reasoning for managed curator global memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-curator-trust-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-curator-trust-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const now = '2026-08-26T00:00:00.000Z';
  const curated = recordEntry(database, {
    workspace: GLOBAL_WORKSPACE,
    kind: 'lesson',
    status: 'verified',
    title: 'Kiokuko intake capability repair workflow',
    body: 'Repair Kiokuko intake capability failures with focused regression tests.',
    scope: buildStructuredScope({
      visibility: 'global',
      retrievalScope: 'global',
      memoryClass: 'troubleshooting',
      portableReason: 'This Kiokuko repair workflow applies across repositories.',
    }),
    provenance: {
      type: 'curator_globalize',
      reference: 'source-entry@1#deterministic-v1',
      sourceWorkspace: 'project:curator-source',
      clientKind: 'kiokuko-curator',
      timestamp: now,
    },
    trustLevel: 'system_verified',
    confidence: 0.8,
    tags: ['curator:deterministic-v1', 'global', 'kiokuko', 'skill:curated'],
    createdBy: 'kiokuko-curator',
    actor: 'kiokuko-curator',
  }, { now });
  database.close();

  const server = createKiokukoMcpServer({ databasePath, cwd: () => root });
  const client = new Client({ name: 'kiokuko-curator-trust-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: {
        soulRead: true,
        requestId: 'mcp-curator-trust-task-prepare',
        task: 'Repair the Kiokuko intake capability failure',
        profileHints: {
          taskType: 'debug',
          target: 'Kiokuko intake capability',
          expected: 'The focused regression passes',
        },
        capabilities: [SOUL_CAPABILITY],
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as {
      nextAction: string;
      memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean; withheldReason: string | null };
      context: { items: Array<{ entryId: string }> };
    };
    assert.equal(content.nextAction, 'proceed');
    assert.equal(content.memoryPolicy.memoryReasoningRequired, false);
    assert.equal(content.memoryPolicy.contextWithheld, false);
    assert.equal(content.memoryPolicy.withheldReason, null);
    assert.equal(content.context.items.some((item) => item.entryId === curated.id), true);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP tool failures redact arbitrary internal error messages', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-error-boundary-'));
  const sentinel = 'token=private-mcp-sentinel';
  const privateMigrationsPath = path.join(data, sentinel, 'private-migrations');
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko-ai.sqlite'),
    migrationsDirectory: privateMigrationsPath,
  });
  const client = new Client({ name: 'kiokuko-error-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'untyped-error-boundary-request', task: 'Boundary failure', profileHints: { taskType: 'review' }, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Internal integrity error/u);
    assert.doesNotMatch(serialized, /Database unavailable/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes(privateMigrationsPath), false);
    assert.deepEqual(result.structuredContent, {
      code: 'INTEGRITY_ERROR',
      retryable: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP generic tool errors expose the complete stable public classification', async () => {
  const cases: Array<{ code: ErrorCode; message: string; retryable: boolean }> = [
    { code: 'USAGE_ERROR', message: 'Request is invalid', retryable: false },
    { code: 'VALIDATION_ERROR', message: 'Request is invalid', retryable: false },
    { code: 'NOT_FOUND', message: 'Resource not found', retryable: false },
    { code: 'CONFLICT', message: 'Request conflicts with current state', retryable: false },
    { code: 'DATABASE_ERROR', message: 'Database unavailable', retryable: false },
    { code: 'BACKPRESSURE', message: 'Service is busy', retryable: true },
    { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', retryable: true },
    { code: 'SECURITY_REJECTION', message: 'Request rejected', retryable: false },
    { code: 'AUTHENTICATION_ERROR', message: 'Authorization is invalid', retryable: false },
    { code: 'INTEGRITY_ERROR', message: 'Internal integrity error', retryable: false },
    { code: 'PARTIAL_FAILURE', message: 'Operation partially failed', retryable: false },
    { code: 'NOT_IMPLEMENTED', message: 'Operation is not implemented', retryable: false },
  ];

  for (const entry of cases) {
    const data = await mkdtemp(path.join(tmpdir(), `kiokuko-mcp-${entry.code.toLowerCase()}-`));
    const sentinel = `token=private-${entry.code.toLowerCase()}-sentinel`;
    const server = createKiokukoMcpServer({
      databasePath: path.join(data, 'kiokuko-ai.sqlite'),
      cwd: () => { throw new KiokukoError(entry.code, sentinel, { retryAfterSeconds: 999, secret: sentinel }); },
    });
    const client = new Client({ name: `kiokuko-${entry.code.toLowerCase()}-test`, version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'task_prepare',
        arguments: { soulRead: true, requestId: `public-${entry.code.toLowerCase()}`, task: 'Classify failure', capabilities: [] },
      });
      assert.equal(result.isError, true, entry.code);
      assert.deepEqual(result.content, [{ type: 'text', text: entry.message }], entry.code);
      assert.deepEqual(result.structuredContent, {
        code: entry.code,
        retryable: entry.retryable,
        ...(entry.code === 'BACKPRESSURE' ? { retryAfterSeconds: 60 } : {}),
      }, entry.code);
      assert.equal(JSON.stringify(result).includes(sentinel), false, entry.code);
    } finally {
      await client.close();
      if (server.isConnected()) await server.close();
    }
  }
});

test('MCP cwd-bearing tools reject relative paths without reporting an internal integrity error', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-relative-cwd-'));
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko-ai.sqlite') });
  const client = new Client({ name: 'kiokuko-relative-cwd-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const calls = [
      {
        name: 'task_prepare',
        arguments: { soulRead: true, requestId: 'relative-cwd-request', task: 'Review', cwd: 'Sites/project', capabilities: [] },
      },
      {
        name: 'task_answer',
        arguments: {
          sessionId: 'relative-cwd-session',
          runId: 'relative-cwd-run',
          questionId: 'taskType',
          value: 'review',
          cwd: 'Sites/project',
          capabilities: [],
        },
      },
      { name: 'curator_check', arguments: { cwd: 'Sites/project' } },
      {
        name: 'memory_checkpoint',
        arguments: {
          cwd: 'Sites/project',
          memories: [{ kind: 'lesson', title: 'Relative cwd rejection', body: 'Use an absolute cwd.' }],
        },
      },
    ];

    for (const call of calls) {
      const result = await client.callTool(call);
      const serialized = JSON.stringify(result);
      assert.equal(result.isError, true, call.name);
      assert.match(serialized, /cwd must be an absolute path|Request is invalid/u, call.name);
      assert.doesNotMatch(serialized, /Internal integrity error/u, call.name);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare reports a missing absolute cwd as not found instead of an integrity error', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-missing-cwd-'));
  const missing = path.join(data, 'missing-worktree');
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko-ai.sqlite') });
  const client = new Client({ name: 'kiokuko-missing-cwd-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'missing-cwd-request', task: 'Review', cwd: missing, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Resource not found/u);
    assert.doesNotMatch(serialized, /Internal integrity error/u);
    assert.deepEqual(result.structuredContent, {
      code: 'NOT_FOUND',
      retryable: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('task_prepare reports exhausted SQLite locking as service backpressure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-locked-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-locked-data-'));
  let beginAttempts = 0;
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko-ai.sqlite'),
    openConnection: (databasePath, options) => {
      const database = openConnection(databasePath, options);
      const exec = database.exec.bind(database);
      database.exec = (sql: string): void => {
        if (sql === 'BEGIN IMMEDIATE') {
          beginAttempts += 1;
          throw sqliteError(5);
        }
        exec(sql);
      };
      return database;
    },
  });
  const client = new Client({ name: 'kiokuko-locked-database-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'locked-database-request', task: 'Review', cwd: root, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Service is busy/u);
    assert.doesNotMatch(serialized, /Internal integrity error/u);
    assert.deepEqual(result.structuredContent, {
      code: 'BACKPRESSURE',
      retryable: true,
      retryAfterSeconds: 1,
    });
    assert.equal(beginAttempts, 5);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP identity schemas reject padding instead of normalizing identities', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-canonical-identities-'));
  const server = createKiokukoMcpServer({ databasePath: path.join(data, 'kiokuko-ai.sqlite') });
  const client = new Client({ name: 'kiokuko-identity-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const calls = [
      { name: 'task_prepare', arguments: { soulRead: true, requestId: 'identity-prepare', task: 'Review', client: { sessionId: ' padded-client-session ' } } },
      { name: 'task_answer', arguments: { sessionId: ' padded-session ', runId: 'run-1', questionId: 'taskType', value: 'review' } },
      { name: 'task_answer', arguments: { sessionId: 'session-1', runId: ' padded-run ', questionId: 'taskType', value: 'review' } },
      { name: 'curator_check', arguments: { workspace: ' project:workspace ' } },
      { name: 'curator_globalize', arguments: { workspace: 'project:workspace', entryId: ' padded-entry ', expectedRevision: 1, confirmed: true } },
      { name: 'memory_checkpoint', arguments: { runId: ' padded-run ' } },
      { name: 'memory_checkpoint', arguments: { deliveryId: ' padded-delivery ' } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true, call.name);
    }
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP preserves only typed database failures as DATABASE_ERROR', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-database-error-boundary-'));
  const sentinel = 'private-database-detail';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko-ai.sqlite'),
    cwd: () => { throw new KiokukoError('DATABASE_ERROR', sentinel, { debug: sentinel }); },
  });
  const client = new Client({ name: 'kiokuko-database-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'database-error-request', task: 'Database failure', capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Database unavailable/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.deepEqual(result.structuredContent, {
      code: 'DATABASE_ERROR',
      retryable: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP tool failures sanitize typed Kiokuko errors instead of trusting their message or details', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-typed-error-boundary-'));
  const sentinel = 'token=private-typed-mcp-sentinel';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko-ai.sqlite'),
    cwd: () => { throw new KiokukoError('INTEGRITY_ERROR', sentinel, { debug: sentinel }); },
  });
  const client = new Client({ name: 'kiokuko-typed-error-boundary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'task_prepare',
      arguments: { soulRead: true, requestId: 'typed-error-boundary-request', task: 'Typed boundary failure', profileHints: { taskType: 'review' }, capabilities: [] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Internal integrity error/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.deepEqual(result.structuredContent, {
      code: 'INTEGRITY_ERROR',
      retryable: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('MCP checkpoint keeps unsupported eligibility details on the generic redacted error path', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-checkpoint-redaction-'));
  const sentinel = 'token=private-unsupported-checkpoint-sentinel';
  const server = createKiokukoMcpServer({
    databasePath: path.join(data, 'kiokuko-ai.sqlite'),
    openConnection: () => {
      throw new KiokukoError('CONFLICT', sentinel, {
        runStatus: 'intake',
        checkpointEligibility: {
          allowed: false,
          reason: 'unsupported_reason',
          nextAction: 'leak_internal_action',
          retryableAfterStateChange: true,
        },
        secret: sentinel,
      });
    },
  });
  const client = new Client({ name: 'kiokuko-checkpoint-redaction-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'memory_checkpoint',
      arguments: { memories: [{ kind: 'lesson', title: 'Redaction test', body: 'bounded' }] },
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.match(serialized, /Request conflicts with current state/u);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('unsupported_reason'), false);
    assert.equal(serialized.includes('leak_internal_action'), false);
    assert.deepEqual(result.structuredContent, {
      code: 'CONFLICT',
      retryable: false,
    });
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('stdio framing rejects an oversized envelope before parsing and accepts the next message', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BoundedStdioServerTransport(input, output, 256);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let written = '';
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  await transport.start();
  try {
    const sentinel = 'transport-secret-sentinel';
    input.write(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"value":"${sentinel}${'x'.repeat(400)}`);
    input.write('"}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const responses = written.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0], {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'JSON-RPC message exceeds the configured transport limit.' },
    });
    assert.equal(written.includes(sentinel), false);
    assert.equal(errors.length, 0);
    assert.deepEqual(messages, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  } finally {
    await transport.close();
  }
});
