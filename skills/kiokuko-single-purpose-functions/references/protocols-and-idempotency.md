<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.protocol.v1` — protocols, concurrency, and idempotency

Select this expert when callers retry, messages can be duplicated, state is revisioned, several actors race, or a public/API/storage protocol must remain compatible.

## Contract

Identity, ordering, and state transition rules are public behavior. Do not infer them from error text, timestamps, repository-wide “latest” records, or other ambiguous signals.

Define:

- the stable operation or request identity;
- which input fields are bound to that identity;
- the exact legal source states;
- the expected revision or version;
- retry and replay behavior;
- what a duplicate with identical input returns;
- what a duplicate identity with changed input returns;
- which actor owns each transition.

## Idempotency

A safe idempotent operation distinguishes exact replay from conflicting reuse. Persist or derive a digest from the complete bound input. Return the stored result for an exact replay; reject changed input under the same key.

Do not generate a new identity for a transport retry. Do generate a new identity for a new logical operation, even when the visible task text happens to match.

## Concurrency

- Check revision and allowed source state in the same atomic mutation.
- Make ambiguous candidates fail closed or remain unbound; never guess.
- Treat zero or multiple affected rows as evidence that the expected transition did not occur.
- Prevent stale completion, retry, or callback results from overwriting newer state.
- Keep terminal states terminal unless the protocol explicitly defines a new revision or recovery transition.

## Compatibility

For versioned APIs or stored structures, accept an older representation only when the compatibility policy is explicit and tested. Do not create silent fallback paths that bypass a new safety invariant. Prefer a clean break when old data cannot satisfy the current contract safely.

## Focused verification

Test first execution, exact replay, conflicting reuse, stale revision, wrong source state, concurrent claim, terminal-state behavior, and response compatibility. A text-match test is insufficient when the protocol exposes structured codes or exact identities.
