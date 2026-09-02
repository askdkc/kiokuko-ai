<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# `code.boundary.v1` — boundaries and ownership

Select this expert when a function receives data or authority from a caller, user, file, database, environment, network, parser, plugin, or another process.

## Contract

The public boundary accepts broad input only long enough to validate and normalize it into a narrow internal value. Reject malformed, ambiguous, oversized, unauthorized, or out-of-scope input before domain work or effects begin.

Define explicitly:

- what input representations are accepted;
- whether normalization changes identity or only representation;
- which limits prevent resource abuse;
- which caller or principal is authorized;
- which errors are public and stable;
- who owns mutable collections, buffers, streams, or objects after the call.

Validation must match the actual threat boundary. A TypeScript type annotation does not validate JSON. A UI constraint does not validate an HTTP request. A prior parser does not authorize the current operation.

## Ownership rules

- Treat caller-owned inputs as immutable by default. Copy before sorting, filtering in place, deleting keys, or retaining a mutable reference.
- Do not return internal mutable state directly when callers could corrupt invariants.
- Make transfer of ownership explicit for streams, handles, transactions, and buffers.
- Avoid aliases where one layer can mutate data another layer assumes is stable.
- Preserve original user data through validation failures unless destructive normalization is the explicit contract.

## Boundary shape

Prefer a thin public function that performs hostile-boundary work and then calls a constrained private core:

```ts
function parseCreateRequest(input: unknown): CreateRequest {
  const parsed = createRequestSchema.safeParse(input);
  if (!parsed.success) throw new PublicError('invalid_request');
  return parsed.data;
}

function decideCreate(request: CreateRequest): CreateDecision {
  // No unknown input remains here.
}
```

Do not scatter the same validation across several deeper functions. Centralize public error mapping so transport, database, or parser details do not accidentally become the API.

## Focused verification

Test at least one valid input, each materially different rejection class, caller-input immutability, and the absence of effects after rejection. For authorization boundaries, include a counterexample that has valid shape but insufficient authority.
