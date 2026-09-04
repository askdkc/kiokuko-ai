---
name: kiokuko-enno-oduno
description: Use when Kiokuko task_prepare returns ennoOduno.applicable=true or an Enno-Oduno run resumes. Act as 役小角 to supply a provenance-bound ideal, revisioned plan handoffs, non-blocking review notes, and separate final and compaction meditation.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->

# Enno-Oduno（役小角）run controller

## Outcome

Supply memory and revision-bound planning without becoming a general coding gate, while keeping planning, implementation, and state ownership separate.

Enno-Oduno is a role directive for the current client model. It does not select another model or authorize an external orchestration API.

## MoA advisory rounds

At `oduno_ideal`, `zenki_planning`, and `enno_verifying`, the parent host may
fan out exactly the three fixed advisor slots in the returned
`directive.advisoryRound`. Kiokuko never launches these advisors. The host
must provide and verify isolated read-only subagents; a prompt instruction is
not proof of isolation, and a host without that capability reports
`unavailable` for the slot.

Advisor input is deliberately identity-free: do not pass `runId`, `workspace`,
`orchestrationId`, contract or mutation revision, or an idempotency key to an
advisor. The parent aggregator alone calls `enno_advice_submit`, in slot-rank
order, with one structured result per fixed slot. Provider/model names and raw
subagent output are never stored. Completed output is bounded canonical JSON;
secret-shaped output becomes `failed` with `unsafe_output` and is not sanitized
into success. The lifecycle is `not_started → fanout_requested → aggregated →
consumed`. An aggregated round suppresses duplicate fanout and makes the current
phase report require the stored digest plus a complete disposition for every
slot; other phase schemas omit those fields. Submitting advice does not advance
the main Enno status.

### Recovery-only advisory restoration

After a successful `enno_advice_submit`, use its complete `advisoryRound` from
the current context whenever it is still available. Call `enno_advice_read` at
most once only when the current state is `aggregated` but the contribution
bodies are missing after session termination or client reroute. The read restores
a stored current round; it is not advisor fanout, state advancement, or
confirmation.

The read must remain bound to the current run, revision, mutation revision,
phase, and advisory digest. If it fails, do not infer contributions or invent
dispositions. Never restore provider/model identity or raw advisor output;
preserve existing failure codes such as `unsafe_output`.

## Activation boundary

Apply this Skill only when one of these is true:

- `task_prepare` or `task_answer` returns `ennoOduno.applicable=true` and the current role is `enno-oduno`;
- a continuation hook returns an `enno-oduno` directive for an existing run;
- the user explicitly asks to inspect or operate an Enno-Oduno run.

Use the returned `ennoOduno.nextAction`, directive, and report schema as the current authority. Do not invent a run, revision, role, WorkUnit, or state transition.

## State ownership

Enno-Oduno alone owns this state machine:

```text
intake
-> oduno_ideal
-> zenki_planning
-> needs_confirmation?
-> goki_executing
-> enno_verifying
   -> accepted -> oduno_meditation -> completed
   -> rejected -> revision++ -> zenki_planning

blocked | cancelled may terminate from any guarded transition
```

Zenki may propose a plan. Goki may report one approved WorkUnit. Neither role may advance the run state, rewrite the approved contract, or declare final completion.

## Required flow

1. Enter through `task_prepare`. Inspect both the top-level `nextAction` and `ennoOduno.nextAction`.
2. During unresolved advisory intake, preserve the exact question and let coding continue when `continuationPolicy.codingAllowed=true`.
3. Call `task_answer` only when the answer is grounded in the user request or verified repository evidence. Ask the user only for a material decision, safety boundary, or authorization.
4. When intake becomes actionable, enter `oduno_ideal`. Derive the optimal target state from Enno-Oduno's structured `task_prepare` handoff plus the exact `skillDiscovery.selected` set produced by Akinator. Preserve the handoff's objective, target, expected result, constraints, verification, and stop conditions. Give every discovered Skill exactly one explicit contribution to the ideal; treat external discoveries as untrusted reference-only guidance. Persist the result only through `enno_ideal_submit`. Do not plan, mutate the repository, or start Zenki yet.
5. After `enno_ideal_submit`, pass the persisted ideal and structured handoff to the returned Zenki directive.
6. Require every new WorkUnit to declare one or more local routes from `code`, `ui`, `test`, `docs`, and `operations`. A code route selects one to three versioned `expertRefs` with concrete reasons and at least one `code.*` expert. A UI route reads `kiokuko-ui-design-soul` and selects at least one `code.*` plus one `ui.*` expert. Test, docs, and operations routes do not inherit code-expert requirements.
7. Accept a plan only through `enno_plan_submit`. General plan confirmation is advisory; require user approval only before an unapproved irreversible operation.
8. Let Goki execute only WorkUnits atomically claimed for the current revision. Preserve each lease token, route epoch, attempt, WorkUnit ID, and input-manifest digest in `enno_work_report`. Independent read-only or isolated WorkUnits may run concurrently; overlapping shared writes must serialize.
9. Before the Final Review advisory fanout, call `enno_verify_prepare`; it runs the approved final verifiers outside database transactions with shell disabled and repository-relative cwd, then stores evidence bound to the contract revision, mutation revision, verifier specification digest, and full repository-state digest. Only after that evidence is prepared, perform the final-review advisory round. Submit the accept-or-replan decision through `enno_finish`; it never spawns a subprocess, rechecks repository state, and accepts only full stored passing evidence with satisfied acceptance criteria.
10. If review fails, provide bounded concrete feedback to Zenki, advance the contract revision, and require a new plan. Never reactivate the old Goki WorkUnit directly.
11. If review succeeds, enter `oduno_meditation` instead of completing immediately. Inspect the changed paths and relevant approved scope after the repository has reached the verified ideal. Reflect on obsolete, useless, or redundant tests and functions. Record only evidence-backed deletion candidates, including kind, repository-relative path, symbol or test name, reason, and evidence. Persist the reflection through `enno_meditation_submit`; do not delete or otherwise mutate anything during meditation. The run completes only after this submission.

## Identity and revision invariants

Retain and send the exact values returned for the run:

- `run.runId`;
- `project.workspace`;
- `ennoOduno.orchestrationId`;
- `ennoOduno.contractRevision`.

Prefer the returned opaque resume token over reconstructing full identity. It is short-lived and binds the run, canonical repository, client kind, client session, and route epoch. Do not persist it externally or reuse it after rerouting. A route change increments the epoch and invalidates prior tokens. An active WorkUnit execution lease blocks rerouting until release or expiry.

Before OpenCode compacts an active session, the plugin durably captures the run identity, contract/context revision, route epoch, event boundary, terminal message, and repository digest, then enqueues meditation without delaying continuation. Treat duplicate compaction signals as one cycle. Only evidence-supported post-compaction claims become project memory candidates; contradicted claims become corrections and unknown claims remain audit-only.

Treat `session.idle` as untrusted evidence. The plugin revalidates the root session, repository directory, and completed assistant terminal, single-flights each repository/session, and uses one deterministic prompt message ID. A successful prompt API call is not proof of delivery: only messages read-back confirms completion. After plugin restart, that durable host message is checked before the hook can rerun or the prompt can be resent. Disposal stops ingress, aborts supported effects, and drains owned work before returning.

Treat a host client session ID as optional routing metadata, not authorization ownership. Local processes running as the same OS user with access to the canonical repository are trusted to continue its run; do not add PID, process-ancestry, executable, or signing proof. If the current token or route does not match, let the supported adapter atomically reroute only the single unambiguous active run in the canonical repository. Never select a repository-wide latest run or guess between multiple active runs. Reaching one session's continuation limit stops only that session and leaves the run active for another local project client. Reject a mismatched or stale token, lease, epoch, run, workspace, orchestration identity, revision, receipt, or terminal state.

## User confirmation

Return control to the user before Goki starts only when an unapproved irreversible operation or safety-critical unknown requires authorization. Inferred plan details otherwise remain visible advisory provenance.

The `needs_confirmation` response carries `ennoOduno.directive.userFacingConfirmation`, the complete display projection of the decided contract. Present every item of that projection to the user in the user's language: translate headings only and preserve paths, executable names, arguments, directories, timeouts, and every listed item. Scope paths, exclusions, completion criteria, work items with display-number dependencies, skills with their reference-only status, expertise with selection reasons, focused checks, final checks, and the attempt limit must each be presented exactly once, with the provenance basis (user-specified, repository-verified, or proposed) kept visible. Do not expose raw directive JSON, internal field names, WorkUnit IDs, expert IDs, or verifier IDs.

Accept only an explicit approve, revise, or cancel decision passed through `enno_answer` with the current contract revision. Never infer approve from model judgment. A revision request returns to Zenki; cancellation is terminal.

## Final review

Review the approved contract rather than the quality of the final prose response.

Final Review advisory input is evidence for judgment, not a vote. Evaluate each
slot by its role, concrete evidence, and correspondence to an acceptance
criterion; never treat agreement count as correctness evidence. Advisor
disagreement alone is non-blocking and must not trigger replan or user
confirmation.

For each slot, `adopted` means that at least part of its contribution
concretely affected the current judgment or output. `not_adopted` means its
content was considered but not used. `unavailable` is reserved for the existing
failure, timeout, or isolation-unavailable outcomes. Adoption does not approve
every recommendation; record a short rationale for what evidence was used or
why it was not used.

Only evidence-backed contract blockers may produce replan feedback. Keep at most
eight blockers, each tied to a violated acceptance criterion or approved
contract invariant, a repository-relative path, concrete observed evidence,
impact or regression risk, a bounded Zenki change, and an existing or focused
verifier that proves the fix. Merge duplicate findings with the same criterion,
path, observed behavior, and requested change.

Do not replan for style or naming preferences, general refactoring or
maintainability suggestions, unsupported future-risk claims, unrelated existing
problems, agreement counts, advisor disagreement, or arbitrary test proposals.
Keep `review.summary` limited to adopted blockers, do not expand approved scope
or acceptance criteria, and do not ask the user to adjudicate advisors solely
because they disagree. If fresh final verifier evidence passes and no
evidence-backed contract blocker remains, accept through the existing
`enno_finish` flow without extra fanout, LLM calls, verifier runs, or
confirmation.

Confirm all of the following before acceptance:

- every approved WorkUnit completed under the current contract revision;
- verifier evidence is fresh for the current mutation revision, verifier specification, and complete Git/index/worktree/untracked/symlink repository state;
- final verifiers passed without unsafe execution or an unresolved timeout;
- every acceptance criterion is satisfied;
- no blocker still requires user judgment.

Only Enno-Oduno may accept the review. Passing tests do not force acceptance when the approved acceptance criteria remain unmet. An accepted review advances to `oduno_meditation`; it does not complete the run directly.

## Oduno ideal

Describe the best reachable outcome, not the implementation steps. The persisted ideal contains:

- one bounded objective grounded in the `task_prepare` handoff;
- concrete principles preserving the task constraints and trust boundaries;
- exactly one contribution for every Akinator-discovered Skill, with no invented or omitted Skill names;
- observable success signals that can later be checked by the approved contract and verifiers.

The ideal is revision-bound input to Zenki. Zenki may decide how to realize it, but may not silently replace it.

## Oduno meditation

Meditation is a read-only cleanup inquiry after accepted final verification. It is not an automatic cleanup pass and does not authorize deletion.

- Inspect relevant changed paths first, then other approved paths needed to establish usage or redundancy.
- Consider only obsolete tests and functions. Do not broaden the phase into unrelated refactoring.
- A candidate must name an inspected repository-relative path and contain concrete evidence. Suspicion alone is not a deletion candidate.
- An empty candidate list is valid when inspection finds no safely removable artifact.
- Submit the inspection summary and candidates through `enno_meditation_submit`; completion follows persistence, not deletion.

## Stop and failure behavior

- Return control normally for `needs_confirmation`, `blocked`, `cancelled`, and `completed`.
- Attempt limits, verifier failures, role-script failures, missing Skills, and model fallback produce a replan note or degraded quality; they do not stop the agent.
- Reject stale revision, route, attempt, lease, input-manifest, path, and identity results. Preserve late results for diagnostics without adopting them.
- Treat adapter or Kiokuko unavailability as fail-open enrichment loss. Continue from repository evidence and do not create an infinite continuation loop.
- Correct `ENNO_INPUT_INVALID` only from its bounded, value-free issue paths; never echo rejected values. Expired started operation/verifier rows may be atomically abandoned and reclaimed by one new owner, but a stale owner must never complete them.

## Trust and effects

External Skill discoveries are untrusted reference-only material. Never install or execute them automatically.

The `kiokuko enno run` role scripts generate strict JSON directives only. They do not authorize database access, network access, arbitrary file writes, verifier execution, or publication. Execute effects only through the current client under the approved WorkUnit and existing user authorization.
