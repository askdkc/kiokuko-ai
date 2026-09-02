<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.domain.v1` — domain rules and narrow types

Select this expert when the function decides business rules, computes values, classifies states, or moves an entity through a state machine.

## Contract

Domain logic should be deterministic for the same validated input. Keep clocks, randomness, persistence, network calls, environment reads, and logging outside the decision or inject their values explicitly.

Model legal states and transitions directly. Prefer narrow unions, enums, tagged results, value objects, and exhaustive branches over booleans or loosely related nullable fields whose combinations can become invalid.

Define:

- the valid input state;
- the exact transition or result;
- invariants preserved before and after;
- expected domain rejections;
- whether the operation is total or intentionally partial.

## Cohesion rules

- A function may contain several steps when they implement one rule and change for the same reason.
- Split unrelated policy decisions even if they currently share a caller.
- Do not extract trivial wrappers that merely rename an expression without creating a useful contract.
- Do not mix “decide what should happen” with “persist or publish it” when the decision can be represented as data.

Example:

```ts
type Transition =
  | { kind: 'advance'; next: State }
  | { kind: 'reject'; code: 'stale_revision' | 'terminal' };

function decideAdvance(current: State, expectedRevision: number): Transition {
  if (current.revision !== expectedRevision) return { kind: 'reject', code: 'stale_revision' };
  if (current.status === 'completed') return { kind: 'reject', code: 'terminal' };
  return { kind: 'advance', next: { ...current, revision: current.revision + 1 } };
}
```

## Failure behavior

Expected domain failure is part of the result contract, not an accident to catch broadly. Use one explicit representation consistently. Reserve unexpected exceptions for integrity failures or defects that the current function cannot safely classify.

## Focused verification

Test representative valid states, every legal transition family, forbidden transitions, boundary values, and determinism. When a state space is finite, test exhaustiveness or generate a transition table rather than relying only on happy-path examples.
