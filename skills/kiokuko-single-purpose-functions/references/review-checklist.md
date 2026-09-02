<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Function-contract coding and review checklist

Use this checklist while implementing, debugging, refactoring, or reviewing code in any language or repository. Apply only the sections relevant to the change.

## Scope

- [ ] The change addresses one stated behavior.
- [ ] No unrelated cleanup, public API redesign, migration rewrite, dependency replacement, or broad type churn was added.
- [ ] Relevant architecture, security, data, protocol, and feature contracts were checked.

## Function responsibility

- [ ] Each changed function has one cohesive externally observable responsibility.
- [ ] Boundary, domain, persistence, adapter, and orchestrator roles are not mixed without a specific reason.
- [ ] Extraction created a meaningful operation rather than a one-line wrapper.
- [ ] An atomic state machine, transaction, or cleanup sequence was not fragmented into an unreadable chain.

## Inputs and ownership

- [ ] Externally influenced values are untrusted until runtime validation.
- [ ] Strings, collections, nesting, retries, and output are bounded.
- [ ] Closed shapes reject unknown fields where required.
- [ ] Hostile input cannot trigger unsafe getters, proxies, hooks, or custom serialization during validation.
- [ ] Validated values are copied into owned data where references could escape.
- [ ] Caller-owned input is not mutated.
- [ ] Missing, null, empty, unknown, unavailable, and invalid states remain distinct where required.
- [ ] No new unchecked cast, suppressed diagnostic, or type escape hatch bypasses a boundary check.

## Domain behavior

- [ ] Pure calculations, normalization, ranking, and state transitions have no hidden I/O.
- [ ] Time, randomness, environment, locale, and external capabilities are explicit dependencies.
- [ ] Canonical order and serialization are deterministic where identity or hashing depends on them.
- [ ] Preconditions and postconditions are represented in code or tests.

## Errors, privacy, and security

- [ ] Expected failures use the project’s narrowest existing error or result category.
- [ ] Public messages and details are stable, bounded, and allowlisted.
- [ ] Invalid values, credentials, private data, provider bodies, and secret-like strings are not echoed.
- [ ] Unknown internal failures are not exposed as raw messages.
- [ ] Primary and cleanup failures are both preserved when both occur.
- [ ] No catch block turns corruption, conflict, partial failure, or uncertain state into success.
- [ ] Authorization, normalization, sanitization, and secret checks remain in the successful execution path.

## Persistence, transactions, and resources

- [ ] Queries are parameterized where applicable and kept out of transport or presentation code.
- [ ] Stored data is validated before becoming domain state.
- [ ] Low-level persistence functions remain transaction-agnostic when they compose inside a use case.
- [ ] One clear owner controls the transaction or resource lifecycle.
- [ ] No network, user prompt, child process, or unrelated slow work runs while holding a write transaction or scarce lock.
- [ ] Retry classification uses structured error information instead of message text.
- [ ] Ambiguous commit and incomplete cleanup states prevent unsafe compensation.

## Idempotency and identity

- [ ] Exact replay and changed-input conflict are distinguished.
- [ ] Every meaning-bearing input participates in replay, generation, revision, or cache identity.
- [ ] Expected-version checks happen before mutation.
- [ ] Independently owned or newer state is not silently overwritten.
- [ ] Partial or ambiguous cleanup is reported rather than presented as success.

## External contracts

- [ ] Public APIs, command output, exit status, schemas, event order, and serialized formats remain stable unless intentionally changed.
- [ ] Protocol output is not contaminated by diagnostics or logging.
- [ ] Authentication, authorization, origin, path, and confirmation boundaries remain intact.
- [ ] Package manifests include required runtime files.
- [ ] Migration history and recorded checksums are not rewritten in place.
- [ ] Managed markers, file modes, line endings, and unrelated user content are preserved where applicable.

## Tests

- [ ] A regression test captures the original failure or falsifying counterexample.
- [ ] Normal success behavior is covered.
- [ ] Empty, minimum, maximum, and exact-boundary values are covered where relevant.
- [ ] Wrong types, malformed shapes, unknown fields, or hostile values are covered at changed boundaries.
- [ ] Caller-owned input immutability is asserted where plausible.
- [ ] Secret and invalid-value non-echo is asserted where applicable.
- [ ] Each changed expected failure category is asserted.
- [ ] Retry bounds and non-retryable failures are covered when retry behavior changes.
- [ ] Rollback, ambiguous commit, and dual operation/cleanup failures are covered when ownership changes.
- [ ] Exact replay and changed-input conflict are covered when idempotency changes.
- [ ] Integration tests exercise the real storage, filesystem, network, process, or protocol boundary when adapter behavior changes.
- [ ] Tests assert observable contracts, not incidental private call order.

## Verification report

- [ ] The narrow affected test was run.
- [ ] Relevant static or type checks were run.
- [ ] The broader suite was run when shared behavior changed.
- [ ] Build and package checks were run when distribution changed.
- [ ] Every skipped command, known failure, assumption, and residual risk is stated exactly.
- [ ] Completion is not described as perfect, crash-proof, or fully verified beyond the evidence.
