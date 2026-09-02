<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose implementation patterns

These patterns are repository- and language-agnostic contracts illustrated with TypeScript for concreteness. Translate them into the project’s language, framework, error model, persistence layer, and test tools. Reuse existing project helpers before creating substitutes.

## 1. Hostile boundary, constrained private core

An exported operation may accept unconstrained input when it is the real trust boundary. Validate once, create an owned value, then call a constrained helper.

```ts
interface ValidatedWindow {
  readonly start: number;
  readonly limit: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseWindow(value: unknown): ValidatedWindow {
  if (!isPlainRecord(value)) throw new Error('window must be an object');
  if (typeof value.start !== 'number' || !Number.isInteger(value.start) || value.start < 0) {
    throw new Error('window start is invalid');
  }
  if (typeof value.limit !== 'number' || !Number.isInteger(value.limit)
    || value.limit < 1 || value.limit > 100) {
    throw new Error('window limit is invalid');
  }
  return { start: value.start, limit: value.limit };
}

function calculateEnd(window: ValidatedWindow): number {
  return window.start + window.limit;
}

export function endOfWindow(value: unknown): number {
  return calculateEnd(parseWindow(value));
}
```

Use the project’s error type and validation library where available. Do not make `calculateEnd` accept `unknown` or repeat transport validation throughout the domain.

## 2. Closed schema at a request boundary

Use bounded schemas and reject unknown fields when the protocol is closed.

```ts
import * as z from 'zod/v4';

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(256),
  paths: z.array(z.string().trim().min(1).max(1_024)).max(100),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
```

A schema is the boundary. Internal helpers should consume its validated output or a narrower domain value.

## 3. Exact optional values

Omit absent optional properties rather than assigning ambiguous placeholders.

```ts
interface Candidate {
  readonly id: string;
  readonly description?: string;
}

function candidate(id: string, description: string | undefined): Candidate {
  return {
    id,
    ...(description === undefined ? {} : { description }),
  };
}
```

Use the equivalent convention in languages that distinguish missing, null, and empty values.

## 4. Immutable transformation and mutation test

```ts
interface Profile {
  readonly mode: 'build' | 'debug' | null;
  readonly target: string | null;
}

function withTarget(profile: Profile, target: string): Profile {
  return { ...profile, target: target.trim() };
}
```

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('returns a new profile without mutating the input', () => {
  const input = { mode: 'build' as const, target: null };
  const before = structuredClone(input);

  const result = withTarget(input, ' src/index.ts ');

  assert.deepEqual(result, { mode: 'build', target: 'src/index.ts' });
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
});
```

## 5. Explicit variable dependencies

Keep time and randomness out of pure ranking, hashing, transition, and validation functions.

```ts
interface Dependencies {
  readonly now: () => string;
  readonly createId: () => string;
}

interface CreatedRecord {
  readonly id: string;
  readonly createdAt: string;
}

function createRecord(dependencies: Dependencies): CreatedRecord {
  return {
    id: dependencies.createId(),
    createdAt: dependencies.now(),
  };
}
```

Production composition supplies real dependencies; tests supply deterministic ones.

## 6. Transaction-agnostic store, transaction-owning use case

The store performs persistence. The service or use case owns the atomic operation.

```ts
interface Transaction {
  execute(sql: string, parameters: readonly unknown[]): void;
}

interface NewItem {
  readonly id: string;
  readonly value: string;
}

function insertItem(transaction: Transaction, item: NewItem): void {
  transaction.execute(
    'INSERT INTO items (id, value) VALUES (?, ?)',
    [item.id, item.value],
  );
}

function createItem(
  runTransaction: (operation: (transaction: Transaction) => void) => void,
  item: NewItem,
): void {
  runTransaction((transaction) => {
    insertItem(transaction, item);
    transaction.execute(
      'INSERT INTO audit_events (event_type, target_id) VALUES (?, ?)',
      ['item_created', item.id],
    );
  });
}
```

Do not let `insertItem` start its own transaction if it must compose with other writes. Do not call a provider or perform unrelated slow I/O inside the transaction.

## 7. Validate stored data before domain use

Driver types and generated models are not always runtime proof, especially across migrations or external storage.

```ts
interface StoredItem {
  readonly id: string;
  readonly revision: number;
}

function parseStoredItem(row: Record<string, unknown> | undefined): StoredItem {
  if (row === undefined) throw new Error('Item not found');
  if (typeof row.id !== 'string'
    || typeof row.revision !== 'number'
    || !Number.isInteger(row.revision)
    || row.revision < 1) {
    throw new Error('Stored item is invalid');
  }
  return { id: row.id, revision: row.revision };
}
```

Do not include malformed row contents in a public error.

## 8. Safe public error mapping

Public messages should be stable. Keep only allowlisted bounded details.

```ts
interface PublicFailure {
  readonly code: 'busy' | 'invalid' | 'internal';
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

function publicFailure(error: unknown): PublicFailure {
  if (isBusyFailure(error)) {
    return {
      code: 'busy',
      message: 'Service is busy',
      retryAfterSeconds: clampRetryDelay(error.retryAfterSeconds),
    };
  }
  if (isValidationFailure(error)) {
    return { code: 'invalid', message: 'Request is invalid' };
  }
  return { code: 'internal', message: 'Internal error' };
}
```

Do not copy unknown exception messages, submitted values, credentials, URLs with secret query parameters, or provider bodies into public output.

## 9. Preserve operation and cleanup failures

When both fail, retain both failures without replacing the primary one.

```ts
async function useResource<T>(
  open: () => Promise<{ close: () => Promise<void> }>,
  operation: (resource: { close: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  const resource = await open();
  let operationFailure: unknown;
  let result: { value: T } | undefined;

  try {
    result = { value: await operation(resource) };
  } catch (error) {
    operationFailure = error;
  }

  try {
    await resource.close();
  } catch (cleanupFailure) {
    if (operationFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, cleanupFailure],
        'Resource operation and cleanup failed',
      );
    }
    throw cleanupFailure;
  }

  if (operationFailure !== undefined) throw operationFailure;
  if (result === undefined) throw new Error('Resource operation produced no result');
  return result.value;
}
```

Use the language’s structured multi-error or error-chaining mechanism where possible.

## 10. Classify failures by structured fields

Prefer error types, codes, status values, or discriminated variants over message matching.

```ts
interface RetryableFailure extends Error {
  readonly code: 'temporarily_unavailable';
  readonly retryAfterSeconds: number;
}

function isRetryableFailure(error: unknown): error is RetryableFailure {
  return error instanceof Error
    && 'code' in error
    && error.code === 'temporarily_unavailable'
    && 'retryAfterSeconds' in error
    && typeof error.retryAfterSeconds === 'number';
}
```

Do not treat an unrelated exception containing “busy” or “timeout” as retryable.

## 11. Immutable replay identity

Bind every field that changes the meaning of an idempotent operation.

```ts
interface BoundRequest {
  readonly operation: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly mode: 'validate' | 'apply';
}

function replayMatches(left: BoundRequest, right: BoundRequest): boolean {
  return left.operation === right.operation
    && left.subjectId === right.subjectId
    && left.expectedRevision === right.expectedRevision
    && left.mode === right.mode;
}
```

Reusing an identity with changed bound input is a conflict, not a second mutation.

## 12. Compare-and-swap filesystem changes

For managed files, the contract may include expected content, expected file identity, expected parent-directory identity, alternate paths that must remain absent, restrictive mode, reverse-order rollback, and explicit ambiguous-cleanup failure.

Use the project’s atomic compare-and-swap helpers where available. Plain write, rename, or delete calls are insufficient when concurrent changes or independently owned files must be protected.

## 13. Test secret non-echo

```ts
test('rejects invalid input without echoing it', () => {
  const submitted = 'secret-sentinel-value';

  assert.throws(
    () => parseWindow({ start: submitted, limit: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(submitted), false);
      return true;
    },
  );
});
```

## 14. Test deterministic output

For canonical order, hashes, manifests, and rankings, construct semantically equivalent inputs with different insertion order and assert identical output.

## 15. Verification sequence

Run commands that actually exist in the repository:

1. the narrowest test covering the changed contract;
2. relevant integration tests;
3. type or static checks;
4. the broader test suite when shared behavior changed;
5. build and package checks when distribution changed.

Report skipped commands and failures exactly. Do not invent a lint, formatter, build, or test command that the project does not define.
