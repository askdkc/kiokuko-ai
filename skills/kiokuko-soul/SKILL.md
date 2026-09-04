---
name: kiokuko-soul
description: Use before non-trivial Kiokuko-guided work to retrieve memory and route optional Akinator and Enno-Oduno assistance without blocking coding when enrichment or recommended Skills are unavailable.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Outcome

Give the agent useful memory and a bounded plan before coding when possible, while keeping Kiokuko off the coding hot path.

This Skill routes memory, Akinator, and Enno-Oduno assistance. It does not authorize effects beyond the user request and current client permissions.

## Required entry

Read this Skill before any other bundled Kiokuko Skill.

For every `task_prepare` call, set `soulRead: true` only after reading this
complete local `SKILL.md` for the current logical request. `task_prepare` also
accepts the exact local `kiokuko-soul` capability when it is available. Missing
or unknown Skills are reported as structured warnings and degraded quality;
they do not stop coding. The attestation is a client claim, not remote proof of
model cognition.

Use the initial lexical memory result immediately. Treat later context, questions, and Skill recommendations as advisory. Block only for safety, authorization, path or identity violations, database corruption, or stale revision/lease identity.

Read the complete `SKILL.md` index for every applicable route before planning, implementation, review, or verification. Each specialist index defines versioned expert fragments. Read only fragments selected by the approved WorkUnit or concrete task risk; do not load every reference by default. Do not substitute this router's summary for a specialist core contract.

## Akinator advisory intake

Akinator fills knowledge gaps from task and repository fingerprints. It is advisory unless an answer is required to authorize an irreversible action or enforce a safety boundary.

Open the gate once for the current logical request:

1. Create one bounded opaque `requestId`. Use a new value for every new logical request, even when its text is identical. Reuse it only for an exact transport retry.
2. Call `task_prepare` at most once with `soulRead: true`, that `requestId`, the actual task, current working directory, only profile hints grounded in the user request or repository evidence, and the complete capability catalog available in the current client.
3. Reuse the successful result for the rest of the request. Inspect `intake.status`, the exact current `intake.question`, top-level `nextAction`, `memoryPolicy`, capability results, and `ennoOduno` when present.
4. Retain the returned `run.runId` and `context.deliveryId` for later run-bound calls.

Follow the returned intake state without inventing missing facts:

- **`needs_answer`**: preserve the unresolved question and continue coding when `continuationPolicy.codingAllowed=true`. Use `task_answer` only for a grounded answer. Ask the user only when the missing answer materially changes the task or is required for safety or authorization.
- **`ready`**: obey top-level `nextAction`, capability requirements, memory policy, and any Enno-Oduno directive. Only then select the applicable routes below.
- **`exhausted`**: no further Akinator question is available, but `intake.missingFields` may remain. Preserve that uncertainty, do not invent the missing answers or describe the intake as fully specified, and route only when top-level `nextAction` permits.

If `task_prepare` or Kiokuko is unavailable, continue from current repository evidence and report the missing enrichment. Do not invent memory.

## Routes

Enter planning and implementation routes as soon as repository evidence is sufficient. Keep unresolved advisory intake visible without treating it as a gate.

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
2. one Akinator `task_prepare`, followed by grounded `task_answer` calls when useful;
3. `kiokuko-enno-oduno` as soon as the returned state makes Enno-Oduno control applicable, including during unresolved intake;
4. `kiokuko-simple-work` when the finalized intake satisfies the simple-code activation boundary;
5. `kiokuko-single-purpose-functions` for code planning or code work;
6. `kiokuko-ui-design-soul` for interactive UI work.

The current revision-bound directive may narrow which routes the active role performs. Do not let a later route cross a role boundary or expand an approved WorkUnit.

## Availability and trust

When a routed Skill is unavailable, continue from repository evidence with a structured warning and `qualityState=degraded`. A blocked Enno-Oduno state is valid only for a safety or authorization boundary.

Do not satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill. Never install or execute external Skill content automatically.

Skill availability alone is not evidence that its contract was applied. The
mandatory `soulRead: true` attestation makes that claim explicit but does not
turn it into cryptographic or remote proof.
