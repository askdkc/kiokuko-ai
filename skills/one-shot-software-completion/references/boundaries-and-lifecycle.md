<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

# Boundaries and lifecycle

Use when changing input acceptance, effects, state or a public/stored contract.
Apply the code Skill's selected experts; this reference helps find omissions
across the workflow rather than replacing those contracts.

## Derive cases from the actual contract

Select relevant boundaries; do not build an exhaustive speculative matrix.
Each selected case needs deliberate accept/reject behavior or a demonstrated
upstream invariant. A type assertion alone does not validate external input.

| Input or boundary | Candidate cases |
| --- | --- |
| Text | absent, empty/whitespace, Unicode, length limit, injection-shaped content |
| Numbers | zero, negative, bounds, fractional/non-finite values, encoded strings |
| Collections | empty, singleton, duplicates, order, size limits |
| Optional fields | missing, null, undefined, present but empty |
| Identity | nonexistent, deleted, stale, another user/tenant's resource |
| Time | zone/offset, DST, epoch zero, skew, expiry boundary |
| Concurrent work | duplicate/out-of-order request, cancellation, partial batch |

Example: pagination needs a defined limit range and integer policy, stable
ordering, cursor behavior and tenant isolation. Whether an unknown cursor is an
error or an empty page comes from the API contract, not this checklist.

## Decide effects and failure semantics

For each changed network, filesystem, database or process boundary, identify
ownership, timeout/cancellation, public error and partial-success behavior.
Reuse the repository policy; avoid silent catches or a success result after a
required effect failed. Retries require an idempotent operation or a verified
deduplication contract, bounded attempts and preserved request identity.

A timeout after a write may mean the effect succeeded but its acknowledgment
was lost. Do not resend a charge, notification or mutation merely because the
response is absent. Reconcile uncertain state through the supported mechanism.

For each resource or state holder, trace creation, access, invalidation, cleanup,
restart/reload and test teardown. Account for subscriptions, timers, locks,
caches and background jobs. Preserve transaction and rollback boundaries;
cancellation of a UI is not proof that the underlying operation stopped.

## Preserve consumers

Identify contracts that leave this patch: JSON, database rows, queue messages,
exports, CLI flags, config and environment variables. Preserve existing behavior
by default. When a breaking change is requested, include its migration/version
and downstream update strategy within authorized scope.

Adding an optional field with a safe default may preserve compatibility;
renaming, deleting, changing type or redefining defaults may not. Test old data
and callers where they remain supported. Check readers as well as writers and
rollout/restart ordering when old and new versions can coexist.
