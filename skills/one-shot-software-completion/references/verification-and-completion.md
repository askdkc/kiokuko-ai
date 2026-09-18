<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

# Verification and completion

Use when selecting evidence, reviewing a patch or validating its delivery.

## Prove behavior at the changed boundary

Use commands defined by the repository. Run required checks and choose further
checks by the affected contract: typecheck, lint, focused tests, relevant
integration tests, build/package inspection and an actual entry-point exercise.
Reuse a passing integration test when it already exercises that entry point;
do not add a redundant live operation merely to tick a runtime checkbox.

- State expected outputs before implementation. Check meaningful success and
  failure cases, forbidden effects after rejection, ownership and compatibility.
- For a regression test, observe failure before the fix or demonstrate that an
  isolated mutation of the defective behavior makes it fail. Do not revert user
  work to create that demonstration. Excessive mocks can hide missing wiring.
- Exercise the public route, CLI, mounted interaction, migration or package
  consumer that must work. If a fixture substitutes for a live service, identify
  the substitution and the remaining uncertainty.
- Compare failures with recorded baseline evidence. Do not label a failure
  pre-existing without evidence or infer a product defect from a sandbox/network
  restriction alone.
- Broaden checks for changed shared callers, public contracts or delivery. After
  a repair, rerun invalidated checks, including integration/build checks affected
  by it. Repeat the full suite only when required or justified by the change.

Tests should protect behavior rather than mirror implementation or prose.
For low-impact mechanical edits, an existing focused check or direct inspection
may suffice. Missing credentials or unavailable infrastructure must be reported;
they never turn an unrun check into a pass.

## Review the complete patch

Read staged, unstaged and new-file changes in scope. For each hunk ask:

1. Does it implement the requested observable behavior or required integration?
2. Which accepted input, failure or caller could make it wrong?
3. Are error behavior, authorization, cleanup and compatibility preserved?
4. Is a new function actually reachable through registration/export/binding?
5. Are placeholders, debug effects, hardcoded secrets/paths, accidental `.only`
   or `.skip`, casts and suppressed checks justified or removed?

Inspect generated/snapshot changes rather than accepting churn. Reconcile the
diff with the plan and accompanying artifacts: present, deliberately omitted
with a reason, or still missing. A correct helper with no consumer is unfinished.
If review causes edits, rerun the checks whose evidence those edits invalidate.

## Completion decision

The request is complete when its observable behavior has matching evidence,
required integration and compatibility are covered, relevant boundaries and
failure cases are handled, required checks have no unexplained new failures,
and the final review has no unresolved issue within scope.

Report the changed behavior, material assumptions and repository basis, exact
checks/results, and any adjacent repair, dependency or breaking change. Name
unverified runtime/deployment paths, blockers and deliberate exclusions. Distinguish
source, packaged files, deployed copies and the active process; evidence for one
does not prove the others. Do not call partially verified delivery fully verified.
