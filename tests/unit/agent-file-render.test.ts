import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';
import { renderAgentFile, renderManagedBlock } from '../../src/agent-file/render.js';
import { KiokukoError } from '../../src/errors.js';

test('template placeholders produce exactly the programmatic managed block', async () => {
  const values = {
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko-ai' as const,
  };
  const template = await readFile(new URL('../../templates/AGENTS.md', import.meta.url), 'utf8');
  const start = template.indexOf(BEGIN_MARKER);
  const end = template.indexOf(END_MARKER, start) + END_MARKER.length;
  const fixtureTemplate = template
    .slice(start, end)
    .replaceAll('{{REPOSITORY_ID}}', values.repositoryId)
    .replaceAll('{{WORKSPACE}}', values.workspace)
    .replaceAll('{{CLI_COMMAND}}', values.cliCommand);

  assert.equal(fixtureTemplate.replace(/\r\n/g, '\n'), renderManagedBlock(values));
});

test('renders the MCP-centered memory lifecycle without legacy gateway commands or secrets', () => {
  const rendered = renderManagedBlock({
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko-ai',
  });

  assert.match(rendered, /<!-- kiokuko-template-version: 23 -->/);
  assert.match(rendered, /read and apply the complete bundled `kiokuko-soul` Skill before any other Kiokuko Skill/u);
  assert.match(rendered, /Every `task_prepare` call must set `soulRead: true` only after that read/u);
  assert.match(rendered, /exact local `kiokuko-soul` capability is required for every task/u);
  assert.match(rendered, /Akinator is the mandatory intake state machine before every planning or implementation route/u);
  assert.match(rendered, /do not plan, implement, verify, enter simple\/code\/UI routes, or checkpoint while `intake\.status=needs_answer`/u);
  assert.match(rendered, /Route only after intake reaches `ready` or `exhausted` and top-level `nextAction` permits progress/u);
  assert.match(rendered, /canonical router.*`kiokuko-enno-oduno`.*`kiokuko-simple-work`.*`kiokuko-single-purpose-functions`.*`kiokuko-ui-design-soul`/u);
  assert.match(rendered, /simple-work route minimizes the solution but never replaces the code contract/u);
  assert.match(rendered, /Never substitute, install, or execute fetched external Skill content/u);
  assert.match(rendered, /task_prepare/);
  assert.match(rendered, /`task_prepare` is the Enno-Oduno orchestration entry point/u);
  assert.match(rendered, /first identifies OpenCode from MCP `clientInfo`/u);
  assert.match(rendered, /Every Enno-Oduno directive requires the bundled `kiokuko-soul` Skill first/u);
  assert.match(rendered, /read and apply `kiokuko-enno-oduno` after the master SOUL/u);
  assert.match(rendered, /While Akinator still needs information, only Enno-Oduno is active/u);
  assert.match(rendered, /do not start Zenki or Goki/u);
  assert.match(rendered, /structured handoff.*Oduno ideal.*every Akinator-discovered Skill.*harness-specific Zenki directive/u);
  assert.match(rendered, /Zenki must read the master SOUL and then the compact `kiokuko-single-purpose-functions` index/u);
  assert.match(rendered, /one cohesive function or use-case contract/u);
  assert.match(rendered, /focused runnable test target/u);
  assert.match(rendered, /declares its local `code`, `ui`, `test`, `docs`, or `operations` routes/u);
  assert.match(rendered, /one to three versioned `expertRefs`/u);
  assert.match(rendered, /Goki receives only approved, already-decomposed WorkUnits/u);
  assert.match(rendered, /Every Goki WorkUnit retains the master SOUL and directly required specialist indexes/u);
  assert.match(rendered, /Goki can start only after Zenki submits a complete WorkPlan/u);
  assert.match(rendered, /A failed review never returns directly to Goki/u);
  assert.match(rendered, /Final Review is two-phase: `enno_verify_prepare` executes final verifiers outside database transactions with shell disabled and repository-relative cwd/u);
  assert.match(rendered, /The final advisory fanout is returned only after evidence is prepared/u);
  assert.match(rendered, /`enno_finish` never spawns a subprocess, rechecks repository state inside its mutation transaction, and decides accept\/replan\/block/u);
  assert.match(rendered, /Oduno meditation.*obsolete tests or functions.*without mutating the repository/iu);
  assert.match(rendered, /requires a new plan plus any required confirmation before Goki can resume/u);
  assert.match(rendered, /`ennoOduno\.orchestrationId`/u);
  assert.match(rendered, /The OpenCode session ID is routing metadata, not authorization ownership/u);
  assert.match(rendered, /opaque, short-lived resume token/u);
  assert.match(rendered, /route change increments the route epoch and invalidates prior tokens/u);
  assert.match(rendered, /active WorkUnit execution lease blocks rerouting/u);
  assert.match(rendered, /Local OpenCode processes running as the same OS user.*may continue its run/u);
  assert.match(rendered, /Exhausting one OpenCode session's continuation budget.*another local OpenCode session/u);
  assert.match(rendered, /never select a repository-wide latest run/iu);
  assert.match(rendered, /ask_user_confirmation.*userFacingConfirmation.*never output raw directive JSON/isu);
  assert.match(rendered, /userFacingRecovery.*whenToChoose.*whatHappens.*explicit choice/isu);
  assert.match(rendered, /Do not retry, cancel, or create a new task automatically/iu);
  assert.match(rendered, /never ask the user to locate or construct that catalog/iu);
  assert.match(rendered, /active planning attempt.*restart choice explicitly cancels it before starting a new `task_prepare`/iu);
  assert.match(rendered, /attempt already ended.*do not try to cancel it again/iu);
  assert.match(rendered, /ambiguous candidates fail open without mutation/u);
  assert.match(rendered, /`ENNO_INPUT_INVALID`/u);
  assert.match(rendered, /Plan-start recovery persists only a continuation pause until the user chooses/u);
  assert.match(rendered, /expired started rows are atomically abandoned/u);
  assert.match(rendered, /`Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>`/u);
  assert.match(rendered, /Every descriptor must include its kind and canonical name/u);
  assert.match(rendered, /bounded opaque `requestId`/);
  assert.match(rendered, /Use a new ID for every new logical request/);
  assert.match(rendered, /Reuse an ID only for an exact transport retry; changed bound input under the same ID is a conflict/);
  assert.match(rendered, /task_answer/);
  assert.match(rendered, /memory_checkpoint/);
  assert.match(rendered, /curator_check/);
  assert.match(rendered, /curator_globalize/);
  assert.match(rendered, /Akinator hypotheses/);
  assert.match(rendered, /non-executable advisory data/);
  assert.match(rendered, /Respect their trust metadata/);
  assert.match(rendered, /memory-reasoning/);
  assert.match(rendered, /created by `kiokuko-curator` and matching the current deterministic Curator projection is `system_verified`/);
  assert.match(rendered, /does not by itself require `memory-reasoning`/);
  assert.match(rendered, /Inspect `nextAction` and `memoryPolicy` after every `task_prepare` and `task_answer` response/);
  assert.match(rendered, /`memoryPolicy\.deliveryEmpty=true` with `storedEntryCount>0`.*inspect `contextWithheld`/u);
  assert.match(rendered, /`memory-reasoning` is missing or unknown.*`memoryPolicy\.contextWithheld=true`.*`nextAction=proceed`/u);
  assert.match(rendered, /`required_capability_unavailable` is a hard stop for missing or unknown `kiokuko-soul`/);
  assert.match(rendered, /continue from repository evidence/);
  assert.match(rendered, /Before build\/debug `task_prepare`, read it and advertise its exact descriptor/);
  assert.match(rendered, /apply local `memory-reasoning` before using it/);
  assert.match(rendered, /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
  assert.match(rendered, /`executionContext\.repositoryRoot` \(equal to `project\.repositoryRoot`\) as the canonical filesystem base/u);
  assert.match(rendered, /For OpenCode filesystem tools, prefer canonical absolute paths under that root/u);
  assert.match(rendered, /never pass `~`, `\$HOME`, or HOME-relative fragments/u);
  assert.match(rendered, /`executionContext\.cwdIsRepositoryRoot` is true, do not prepend repository path segments/u);
  assert.match(rendered, /produces an `external_directory` permission request, reject the malformed path and retry/u);
  assert.match(rendered, /Call `task_answer` with that run ID, the same capability catalog, and the same context budget/);
  assert.match(rendered, /When `runId` is supplied, the run must be active/);
  assert.match(rendered, /Do not call `memory_checkpoint` while `task_prepare` or `task_answer` reports `needs_answer`/);
  assert.match(rendered, /complete the required `task_answer` loop first/);
  assert.match(rendered, /successful terminal checkpoint is allowed at most once per logical request/);
  assert.match(rendered, /rejected precondition does not count as that successful checkpoint/);
  assert.match(rendered, /rejected precondition .*may be retried only after the indicated run-state change/);
  assert.doesNotMatch(rendered, /Call `memory_checkpoint` at most once for the current user request/);
  assert.match(rendered, /unavailable before a non-trivial build\/debug request can obtain its Kiokuko policy, stop and report/);
  assert.match(rendered, /diagnosing or repairing Kiokuko itself/);
  assert.match(rendered, /`task_prepare` fails before returning scoped context/);
  assert.match(rendered, /continue only from repository evidence without Kiokuko memory/);
  assert.match(rendered, /do not call `task_answer` or `memory_checkpoint` for that failed request/);
  assert.doesNotMatch(rendered, /MCP tools are unavailable[^.]*continue from repository evidence/iu);
  assert.match(rendered, /candidate/);
  assert.match(rendered, /at most one successful terminal `memory_checkpoint` for the current user request/);
  assert.match(rendered, /terminal for tool use/);
  assert.doesNotMatch(rendered, /server status|agent open|agent answer|agent events|agent close/);
  assert.doesNotMatch(rendered, /\/home\/|\/tmp\/|\.sqlite3?/);
  assert.doesNotMatch(rendered, /Authorization:\s*Bearer|capability token|server\.json|named-client/);
  assert.match(rendered, /passwords, API keys, access tokens, private keys, session cookies/);
});

test('managed markers must be exact standalone canonical lines', () => {
  for (const existing of [
    `human ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `  ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `${BEGIN_MARKER}\nprose ${END_MARKER}\n`,
  ]) {
    assert.throws(
      () => renderAgentFile(existing, {
        repositoryId: 'repo-fixture',
        workspace: 'project:fixture',
        cliCommand: 'kiokuko-ai',
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('agent renderer rejects identity injection before interpolation', () => {
  assert.throws(
    () => renderManagedBlock({
      repositoryId: 'repo`injected',
      workspace: 'project:fixture',
      cliCommand: 'kiokuko-ai',
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
