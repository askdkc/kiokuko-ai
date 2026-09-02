# Execution ledger

The execution ledger is an append-oriented audit of agent runs. It is separate from curated memory (`entries`, `entry_revisions`, `entry_revision_tags`, `entry_links`) and from memory mutation audit (`audit_events`). A ledger event never becomes verified memory automatically.

## Storage model

Migration `004_agent_gateway.sql` adds:

- `ledger_runs`: immutable workspace/client/protocol/capture/coverage identity and mutable lifecycle cursor/status.
- `run_intakes`: one-to-one link from a run to an existing Akinator session, including policy/schema versions, field sources, initial profile hash, and recommended tags.
- `intake_feedback`: question/profile feedback with XOR target and actor/idempotency uniqueness.
- `ledger_events`: contiguous local sequence, source identity, canonical/source types, bounded sanitized payload, redaction metadata, and hash-chain fields.
- `ledger_evidence`: bounded command/test/file/diff/URL/artifact locators and digests; never binary or unlimited output.
- `context_deliveries` and `context_delivery_entries`: exact cursor/profile/query/policy/budget and selected immutable entry revision/rank/score/reason. The child row has a composite foreign key to `entry_revisions`, so a delivery cannot reference a missing or silently substituted revision.
- `context_feedback` and `run_feedback`: explicit weak ranking signals and outcome/recommendation feedback.
- `ledger_memory_links`: provenance from run/event/delivery to promoted candidate memory.
- `ledger_purge_audit`: content-free tombstones after privacy purge.

Migration `010_nudge_deliveries.sql` adds:

- `nudge_deliveries`: presentation history for selected advisory nudges. It stores the run, policy version, checkpoint identity, logical occurrence, code, sequence, priority, and bounded evidence/reference ID snapshots, but not rendered message text.

Migration `011_nudge_integrity.sql` adds database guards for the supported nudge policy, code/priority pairs, and bounded JSON snapshots.

Enno client routing writes `enno.client_bound` for the first session route and
`enno.client_rebound` for later route changes. The payload records the previous
and current client kind, session ID, and version projection; a rebound clears
the old version. These events audit routing changes and do not confer ownership
or advance the Enno contract state.

The Enno execution ledger also uses database-backed ownership rows rather than
process memory. Resume tokens are stored only as hashes and bind a route epoch;
rerouting invalidates old epochs. A WorkUnit execution lease prevents two local
clients from reporting the same unit and blocks rerouting while current.
Operation receipts and verifier runs have `started`, `completed`, `failed`, and
`abandoned` states with bounded leases and owner nonces. Recovery atomically
abandons an expired owner before one new owner claims the exact operation; a
losing or stale nonce cannot complete it.

Final evidence binds contract revision, mutation revision, verifier
specification digest, and complete repository-state digests captured before and
after verifier execution. A verifier-caused repository mutation marks the run
unacceptable, and any later HEAD/index/worktree/untracked/symlink change makes
the evidence stale before `enno_finish` can commit.

## Invariants

1. A run belongs to one workspace for its lifetime.
2. One run links to one intake session, and one intake session links to one run; their workspaces must match.
3. `intake → active` is valid only after the linked session is `ready` or `exhausted`.
4. A run's coverage declaration is preserved rather than inferred upward.
5. `event_id` is globally unique; events also have unique `(run_id, sequence)` and unique `(run_id, source_event_id)` when present. Exact replay may identify an event by its explicit `eventId` or its run-scoped source identity; a different sanitized body conflicts.
6. A batch receives contiguous local sequence numbers in one `BEGIN IMMEDIATE` transaction or writes nothing.
7. Corrections and task-profile revisions are new events; prior event rows and finalized intake profiles are not rewritten.
8. Terminal runs reject new events except exact replay of an acknowledged idempotency/source identity.
9. Delivery rows reference entry revisions instead of copying memory bodies.
10. Feedback cannot mutate entry status/trust or an existing policy/session/profile.
11. Promotion is explicit, creates `candidate` memory only, and records provenance.

## Canonical event types

V1 recognizes intake/run/request/constraint/decision/step/approval/tool/command/file/test/verification/error/retry/cancellation/context/memory/task-profile/correction/source event families. Unknown client event names are retained only as `sourceType` behind the canonical `source.event` type; they are not invented or silently mapped.

## Integrity chain

Before storage, Kiokuko performs strict validation, creates an owned JSON snapshot, recursively sanitizes keys/values/URLs/paths/environment data, enforces byte limits, and canonicalizes JSON. Optional hash fields are represented explicitly as `null`, so the write-time preimage is identical after a SQLite round trip. The event hash commits to run ID, local sequence, canonical event data, sanitized payload, and previous hash. The first event uses the deterministic genesis hash. `doctor` checks contiguous sequence, run cursor, hash links, and orphans.

One sanitized event payload, task snapshot, profile-hints snapshot, intake-answer snapshot, or run-metadata snapshot is limited to 64 KiB. The limit is applied after sanitization and before hashing or opening a write transaction.

The chain is tamper-evident, not a signature or remote attestation. SQLite and same-user host security still define the local trust boundary.

## Projection and evidence freshness

Projection is deterministic through a committed local sequence. It derives current task profile from the immutable intake profile plus ordered `task_profile.revised` events, unresolved failures, unknown side effects, latest mutation, and latest passing verification. Evidence state is:

- `none`: no verification evidence;
- `failed`: latest relevant verification failed;
- `fresh`: passing verification is at or after the latest mutation;
- `stale`: a later mutation exists.

Minimum recommendation codes are `INTAKE_INCOMPLETE`, `VERIFY_AFTER_MUTATION`, `SIDE_EFFECT_OUTCOME_UNKNOWN`, `UNRESOLVED_FAILURE`, `CONTEXT_STALE`, `CONTRADICTORY_MEMORY`, `COVERAGE_INCOMPLETE`, and `PROMOTION_CANDIDATE`. Recommendations are stored data with evidence IDs, not commands.

Recommendations describe every currently applicable deterministic condition. A nudge is a separate presentation decision: at most one eligible advisory item selected from the v1 nudge subset (`SIDE_EFFECT_OUTCOME_UNKNOWN`, `UNRESOLVED_FAILURE`, and `VERIFY_AFTER_MUTATION`). `CONTRADICTORY_MEMORY` remains a recommendation but is not a nudge because the HTTP checkpoint broker does not currently expose its complete contradiction-pair state. Nudge candidates are derived from the committed projection and final capability-gated recommendations only; fixed messages and bounded evidence/reference IDs are returned, and rate limiting never removes the corresponding recommendation.

Nudge policy version `nudges.v1` shows one logical occurrence at most once per run, permits at most three deliveries per run, and requires at least three committed ledger sequence positions between deliveries of the same code. Eligibility uses occurrence identity and ledger sequence, not wall-clock time. `nudge_deliveries` is presentation history outside `ledger_events`, so delivering a nudge cannot change the execution projection.

## Archive, backup, purge

Existing memory export remains memory-only. Ledger export/import uses a separate deterministic manifest/checksum and includes nudge delivery history. Full SQLite backup contains memory, ledger, nudge deliveries, and feedback. Purge removes bounded content under explicit confirmation while preserving only a content-free tombstone and any promoted memory that has its own lifecycle.
