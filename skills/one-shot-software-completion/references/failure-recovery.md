<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

# Failure recovery

Read when a check fails or progress stalls. Recovery stays within the original
scope, current host role and permissions; it is not an automatic retry policy.

## Classify before editing

Read the relevant complete error and causal context. Separate observations from
hypotheses; multiple causes may coexist.

| Evidence indicates | Next action |
| --- | --- |
| Wrong interpretation of the requirement | Revisit the observable result and material ambiguity |
| Missed caller, helper contract or integration | Trace that dependency and correct the plan |
| Local implementation error | Apply a focused fix and its regression check |
| Environment/tooling failure | Verify the cause; make only an authorized, bounded repair |
| Failure demonstrated in the baseline | Report it; investigate if it blocks or interacts with the change |

If the same failure remains after two targeted fixes, stop making variants of
the same patch. Create a minimal reproduction or focused diagnostic, revisit
the input/contract and consider a different approach supported by repository
evidence. Do not rerun an unchanged failed operation without new information.

## Preserve the evidence

Do not loosen assertions, skip tests, add broad catches/casts, suppress errors
or increase timeouts merely to make a failure disappear. Change a check only
when evidence shows its expectation is wrong and explain that correction.

Fix tooling only when it blocks required verification and the repair is within
scope. Prefer a targeted runnable check when broader infrastructure is missing;
report exactly what it proves and what remains unverified. Do not rewrite CI,
install unrelated dependencies or change external configuration to evade a
blocker. A permission or credential gap is not a prompt to bypass controls.

After a repair, rerun the failed check and all checks affected by the new diff,
then review the final patch again. A signature repair can require caller tests,
typecheck and runtime integration even if only one test originally failed.
Stop when requirements are verified or progress requires unavailable evidence,
access or a consequential user decision. State the blocker and concrete next
action rather than claiming completion or promising unattended continuation.
