<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.effects.v1` — effects, data, and resource lifetime

Select this expert when a contract touches a database, filesystem, network, subprocess, cache, message bus, clock, random source, UI runtime, or long-lived resource.

## Contract

Make the effect profile visible at the function boundary. A function that appears pure but reads global state, mutates a cache, logs sensitive data, or launches background work has a misleading contract.

Separate four concerns when practical:

1. validate and authorize the request;
2. decide the domain change;
3. apply effects under an explicit atomicity policy;
4. translate infrastructure outcomes into the public result.

Do not split a transaction merely to make functions shorter. Operations that must commit or roll back together belong under one transaction owner. Conversely, do not hide unrelated writes inside a function whose name promises only a read or calculation.

## Data integrity

- State which writes are atomic and which partial outcomes are possible.
- Use compare-and-set, revision checks, unique constraints, or locks where concurrent writers can violate invariants.
- Check affected-row counts when they prove the intended state transition occurred.
- Never claim persistence before durable completion.
- Keep schema or serialization compatibility explicit at stored-data boundaries.
- Do not swallow a failed cleanup, rollback, or close when it changes correctness.

## External effects

- Bound time, output, memory, and retries.
- Define cancellation semantics: cancelling the UI is not the same as cancelling the work.
- Close files, streams, transactions, child processes, and subscriptions on success and failure.
- Avoid fire-and-forget work unless ownership, failure reporting, and process lifetime are deliberately defined.
- Sanitize logs and previews; do not leak secrets or private payloads through diagnostic output.

## Testing seam

Inject the narrow effect capability needed by the contract rather than an entire ambient service container. A focused fake should let tests observe calls, order, arguments, cleanup, and failure mapping without reproducing the infrastructure implementation.

## Focused verification

Test successful effect order, failure before mutation, failure during mutation, rollback or cleanup, timeout/cancellation, and concurrent or stale writes when applicable. Integration-test the real adapter separately from deterministic domain tests.
