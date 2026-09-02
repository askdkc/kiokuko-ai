<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.verification.v1` — focused evidence and review

Select this expert for regression repair, behavior review, compatibility changes, or any function whose correctness claim depends on evidence beyond ordinary local reasoning.

## Evidence contract

Verification must exercise the same boundary and pipeline as the reported or intended behavior. A build does not replace a typecheck. A unit test of a helper does not replace the HTTP, CLI, hook, database, browser, or packaging path that failed.

Before editing, state a falsifiable invariant and at least one counterexample. After editing, run the smallest focused verifier that proves the change, then the broader verifier proportional to regression risk.

## Test shape

For each changed contract cover:

- representative success;
- important expected failure;
- the reported regression or a concrete counterexample;
- absence of forbidden effects after rejection;
- ownership or immutability when mutable input is possible;
- concurrency, retry, cancellation, or cleanup when the selected experts require them.

Prefer observable behavior over private implementation details. Use deterministic inputs and narrow fakes. Keep test names specific enough to identify the contract and failure class.

## Review method

Trace caller to boundary to domain decision to effects to public result. Check generated instructions, stored representations, migrations, packaging manifests, and runtime adapters when they are part of delivery; source code alone may not be the shipped behavior.

Classify uncertainty honestly:

- verified by a matching runnable test;
- inspected from source only;
- blocked by environment or unavailable dependency;
- not checked.

Do not convert a sandbox, listener, DNS, registry, or permission restriction into a product defect without a matching permitted rerun. Do not repeatedly run an unchanged blocked verifier.

## Completion

Report exact verifier commands or test names, their result, changed contract scope, and remaining gaps. If only a subset ran, do not claim the full suite passed.
