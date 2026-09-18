---
name: one-shot-software-completion
description: Complete repository code changes through requirement discovery, integration, and verification. Use when writing or changing code; scale to the task and load detailed guidance only for the current risk or failure.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

<!-- kiokuko:runtime contract -->
# One-Shot Software Completion

Make the first delivered result satisfy the user's observable requirements,
including reachable integration and evidence. "One-shot" describes the delivery
goal; it promises neither success in one model turn nor permission to act beyond
the request. Repository evidence supplies defaults, not authority to override
user intent, permissions, or host safety, identity and integrity checks.

## Read economically

Read this entire index. It is sufficient for a bounded change with clear callers
and checks. For unresolved risks, select the matching reference below; read one
at a time, usually one or two per work unit. Do not preload all references or
load them again solely because the phase changed. All core obligations remain
applicable even when no reference is needed.

| Read when | Reference |
| --- | --- |
| Requirements, callers, scope or integration are unclear | [Discovery and scope](references/discovery-and-scope.md) |
| Inputs, effects, resource lifetime or compatibility change | [Boundaries and lifecycle](references/boundaries-and-lifecycle.md) |
| Choosing evidence, reviewing the diff or checking delivery | [Verification and completion](references/verification-and-completion.md) |
| A check fails or progress stalls | [Failure recovery](references/failure-recovery.md) |

For a 256K context window or smaller, leave room for the task, code, tools,
history and output: select repository reads by symbols and relevant contiguous
regions; expand only when dependencies require it. Keep a brief working note of
requirements, affected contracts, unresolved risks and check results. Byte size
is not a model token count; use a model tokenizer or host usage if available and
never infer the remaining budget from advertised context capacity alone.

## Completion contract

1. **Frame:** State "when X, Y becomes observable." Resolve routine choices from
   current analogs and project conventions. Ask only when unresolved intent,
   compatibility or authorization materially changes the result; do not guess
   consequential choices or treat every omission as a blocker.
2. **Trace:** Follow the real entry point through the target to consumers and
   effects. Inspect callers, helpers, nearby tests and verification commands.
   Identify required registrations, exports, schemas, docs and delivery steps
   from that path. Read enough surrounding code to avoid duplicate mechanisms.
3. **Bound:** Plan the affected files, each intended behavior and its proving
   check. Include necessary adjacent repairs; preserve unrelated user work.
   Reuse local primitives, layering, error shapes and style. A minimal patch
   must still complete the requested behavior.
4. **Implement:** Define accepted inputs, failures, effects and compatibility.
   Cover relevant boundaries, ownership, cleanup and safe retry semantics.
   Write concrete expected results before the implementation drives the tests.
   Add regression tests for material behavior; reuse adequate checks for small
   changes instead of creating tests that merely mirror wording or code.
5. **Verify:** Establish relevant baseline evidence when needed to attribute
   failures. Run required repository checks and the smallest meaningful check
   through the changed user entry point. Broaden for affected shared contracts.
   Keep source, package, deployed copy and active runtime evidence separate.
6. **Review and finish:** Read the complete changed diff, including new files;
   reconcile it with requirements and necessary integration. Remove accidental
   placeholders, debug effects and weakened checks. After edits, rerun affected
   checks. Report completion only within observed evidence; name blockers and
   unverified paths explicitly.

## Composition and stopping

In Kiokuko, enter through `kiokuko-soul`; also apply
`kiokuko-single-purpose-functions` for code and the applicable UI/workflow Skills.
Reuse their contract, plan and evidence rather than generating duplicate plans
or checklists. In DSH, the host owns intake, model routing, delegation and
continuation. Respect the current role/WorkUnit scope; this Skill neither creates
an Enno run nor authorizes extra agents, retries, publication or deployment.

Continue authorized work while evidence supports a next step. On failure, read
the recovery reference before changing strategy. Do not retry an unchanged
failed operation or hide failures by weakening checks. Stop on completion or a
specific blocker requiring unavailable access, evidence or user action.

Report the changed behavior, material assumptions, checks and their results,
and anything unverified or deliberately excluded. Passing a helper test alone
does not establish a working user workflow.
<!-- /kiokuko:runtime -->
