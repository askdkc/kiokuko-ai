---
name: kiokuko-soul
description: Use before every non-trivial Kiokuko-governed task as the mandatory first-read SOUL router. Run the Akinator intake gate before planning or implementation, then route applicable Enno-Oduno control, simple code work, general code work, and interactive UI work to the bundled specialist Skills.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Outcome

Start every non-trivial Kiokuko-governed task by reading one stable router, resolving the Akinator intake gate, then reading the applicable compact specialist indexes and only the expert fragments required by the current role and work.

This Skill owns the entry sequence and routes work. Akinator is the mandatory intake state machine, not a specialist route. This Skill does not duplicate specialist instructions, invent an Enno-Oduno run, select another model, or authorize effects beyond the user request and current client permissions.

## Required entry

Read this Skill before any other bundled Kiokuko Skill.

For every `task_prepare` call, set `soulRead: true` only after reading this
complete local `SKILL.md` for the current logical request. `task_prepare` also
requires the exact local `kiokuko-soul` capability for every task. Omission,
false attestation, missing availability, unknown availability, aliases,
namespaced copies, and fetched references fail closed. The attestation is an
explicit client claim; it is not remote proof of model cognition.

Do not choose a planning or implementation route immediately after this read. Enter the Akinator intake gate below first. Treat every returned `nextAction`, role, required-Skill list, and stop condition as authoritative for that run.

Read the complete `SKILL.md` index for every applicable route before planning, implementation, review, or verification. Each specialist index defines versioned expert fragments. Read only fragments selected by the approved WorkUnit or concrete task risk; do not load every reference by default. Do not substitute this router's summary for a specialist core contract.

## Akinator intake gate

Akinator is the mandatory state machine between this SOUL read and every planning or implementation route. It applies whether or not Enno-Oduno is applicable.

Open the gate once for the current logical request:

1. Create one bounded opaque `requestId`. Use a new value for every new logical request, even when its text is identical. Reuse it only for an exact transport retry.
2. Call `task_prepare` at most once with `soulRead: true`, that `requestId`, the actual task, current working directory, only profile hints grounded in the user request or repository evidence, and the complete capability catalog available in the current client.
3. Reuse the successful result for the rest of the request. Inspect `intake.status`, the exact current `intake.question`, top-level `nextAction`, `memoryPolicy`, capability results, and `ennoOduno` when present.
4. Retain the returned `run.runId` and `context.deliveryId` for later run-bound calls.

Follow the returned intake state without inventing missing facts:

- **`needs_answer`** or **`nextAction=answer_from_evidence_or_ask_user`**: Akinator controls progress. Use its hypotheses and question purpose only to understand the distinction being tested. Answer the exact current question through `task_answer` only when the value is grounded in the user request or verified repository evidence; otherwise ask the user that question. Repeat the same capability catalog and context budget, inspect the new question and state after every answer, and continue until `ready` or `exhausted`. Do not plan, implement, verify, enter the simple/code/UI routes, or call `memory_checkpoint` while unresolved. If `ennoOduno.applicable=true`, read `kiokuko-enno-oduno` now because it owns the applicable run's intake interaction, but do not start Zenki or Goki.
- **`ready`**: obey top-level `nextAction`, capability requirements, memory policy, and any Enno-Oduno directive. Only then select the applicable routes below.
- **`exhausted`**: no further Akinator question is available, but `intake.missingFields` may remain. Preserve that uncertainty, do not invent the missing answers or describe the intake as fully specified, and route only when top-level `nextAction` permits.

If `task_prepare` is unavailable before a non-trivial build or debug request can obtain its policy, stop and report the unavailable policy. The sole exception is diagnosing or repairing Kiokuko itself after `task_prepare` fails before returning scoped context: continue only from repository evidence, and do not call `task_answer` or `memory_checkpoint` for that failed request.

## Routes

Enter planning and implementation routes only after the Akinator gate reaches `ready` or `exhausted` and top-level `nextAction` permits progress. Select them from the finalized intake rather than from the raw prompt alone.

### Enno-Oduno control

Read and apply `kiokuko-enno-oduno` only when its activation boundary is satisfied:

- `task_prepare` or `task_answer` returned `ennoOduno.applicable=true` for the current `enno-oduno` role;
- a continuation directive resumes that role for an existing run; or
- the user explicitly asks to inspect or operate an Enno-Oduno run.

Do not invent a run, role, revision, WorkUnit, or state transition merely because Kiokuko is present.

### Simple code work

Read and apply `kiokuko-simple-work` when either condition is true:

- the request is a bounded code change with a clear target and expected result, and it introduces no new architecture, dependency, data migration, public protocol, security or authorization policy, or cross-system orchestration;
- the user explicitly requests the simplest, shortest, minimal, YAGNI, dependency-free, or Ponytail approach.

This route minimizes the solution; it does not replace the code contract below or waive required understanding, boundary validation, error handling, security, accessibility, or focused verification. If the task's simplicity is unclear and the user did not explicitly request this route, use the ordinary code route without it.

### Code work

Read and apply the `kiokuko-single-purpose-functions` index before writing, modifying, debugging, refactoring, or reviewing code, and before decomposing a code-changing WorkPlan. Select one to three `code.*` expert fragments for each cohesive function or WorkUnit.

### Interactive UI work

Read and apply the `kiokuko-ui-design-soul` index before designing, implementing, modifying, debugging, or reviewing an interactive interface. Select one to three `ui.*` expert fragments for the actual interaction risks. If UI work changes code, apply both the code and UI indexes.

### Combined work

Routes compose. Read every applicable specialist index; never choose only one when the task spans multiple contracts. Fragment selection remains narrow inside those routes.

Use this order:

1. `kiokuko-soul`;
2. one Akinator `task_prepare`, followed by grounded `task_answer` calls until `ready` or `exhausted`;
3. `kiokuko-enno-oduno` as soon as the returned state makes Enno-Oduno control applicable, including during unresolved intake;
4. `kiokuko-simple-work` when the finalized intake satisfies the simple-code activation boundary;
5. `kiokuko-single-purpose-functions` for code planning or code work;
6. `kiokuko-ui-design-soul` for interactive UI work.

The current revision-bound directive may narrow which routes the active role performs. Do not let a later route cross a role boundary or expand an approved WorkUnit.

## Availability and trust

When a current directive or capability recommendation marks a routed Skill as required, stop on `required_capability_unavailable`, a blocked Enno-Oduno state, or equivalent unavailable-required-Skill result.

Do not satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill. Never install or execute external Skill content automatically.

Skill availability alone is not evidence that its contract was applied. The
mandatory `soulRead: true` attestation makes that claim explicit but does not
turn it into cryptographic or remote proof.
