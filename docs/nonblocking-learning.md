# Nonblocking project learning

Kiokuko AI uses its existing SQLite database, version-pinned CLI and OpenCode
2.0.18 plugin. An external core service is not required. The shared operations
are `memory_observe`, `memory_context` and `memory_improve` over MCP, or
`kiokuko-ai memory observe|context|improve --input-json -` with JSON on stdin.
The existing local HTTP server also exposes authenticated POST requests at
`/api/memory/observe`, `/api/memory/context` and `/api/memory/improve`. Its existing
Bearer capability and web origin checks still apply.

OpenCode's actual `prompt`, `context`, `compaction`, `execute.after` hooks and
`session.execution.*`, `session.compaction.ended`, `session.model.selected`
events feed the observer. Prompt/context/tool hooks do not await learning. They
use an already available advisory cache while background work persists or
recalls data. Failed recording, conflicts and unavailable runtime produce
bounded diagnostic codes; they never prevent the user's ordinary work. Missing
memory decisions or failed checks downgrade a terminal checkpoint to
`verification: "unverified"`; an asserted fresh result alone is insufficient.
Otherwise the checkpoint labels supplied checks `reported`; execution origin
remains explicit in the memory application evidence, rather than being inferred.
Safety, identity, lease, repository and host authorization checks remain intact.

Observations contain bounded public response excerpts and tool names/statuses.
Reasoning parts, quoted feedback examples, code blocks and raw tool outputs are
excluded. Credential-shaped input is rejected before storage. Host-executed
focused verifiers can supply action-level results with evidence IDs; these do
not prove the full task was verified. A successful host turn, praise or silence
does not change `verification: "unknown"` into a passing test.

`eventId` is the producer's stable event/message ID. `sessionId` stays the same
through model changes; a new session uses a new ID. The automatic OpenCode
producer uses that host session ID as `source.runId`, not an invented Enno run.
Replay binds the repository, producer, event ID and source revision. Identical
replay returns the stored receipt; conflicting reuse records nothing.
`source.revision` defaults to 0. Updates require a higher revision and the same
session/source run. `source.tombstone: true` withdraws that evaluation and may omit its summary. Immutable
source revisions are retained, while old observation entries and dependent
routine/principle candidates are superseded immediately. Producers with no
observable update/delete event must submit an explicit source revision; no
fictional host event or automatic deletion is claimed.

`memory_context` accepts `{cwd, query?, tags?, sessionId?, limit?}`. Its result
contains `entries` (same-repository observations, actions, uncertainty, source
references and bounded portable Global candidates), `handoff` (same-session public
continuation expiring after 24 hours), `available`, `warnings`, and `workMayContinue: true`.
Entry fields include revision, verificationProvenance, opaque sourceEventIds and
scope. Local projection aliases `items`/`principles` and diagnostics remain available.
Model-switch and compaction summaries belong to handoff, rather than reusable search. Recording APIs
distinguish `accepted` from `recorded`; a failed or missing receipt is not proof
of storage. Cached data may arrive after the first model request, because
retrieval is not on the coding critical path. A cold start without available
public context cannot reconstruct an unobserved history.

Project candidates also use the existing entry/search projection, so the next
same-repository `task_prepare` can retrieve them. Keyword/tag selectors run
before the response limit. The host also fetches current same-repository complaint
cautions independently of the new task's words, so an unrelated request still
receives them. Derived project routines are included in `memory_context` as well
as ordinary entry retrieval. Complaints retain a reported failure and a prevention
candidate; deterministic feedback detection is conservative, and does not
establish the cause. Praise retains recorded action/result/public explanation
summaries as candidates. For AgenticReplay evidence, supply
`source.producer: "agenticreplay"` and its exact ingested `source.runId`. The
observer validates that run against the current repository's registered trace
store, integrity and digest. It never guesses that a latest unrelated trace
belongs to a praised task. Automatic OpenCode observations preserve their own
event provenance. When the existing `AGENTICREPLAY_RUN_DIR` is supplied, praise
also attaches that exact repository-contained, registered run's validated public
metadata. Missing or unrelated directories are ignored; a session mapping is not invented.

The existing MCP background worker periodically consumes bounded improvement
jobs. Explicit `memory_improve` runs the same extraction when that worker is
not active. Independent sessions with repeated action sequences may produce a
low-confidence routine candidate. A later complaint invalidates dependent
candidates. Repeated completion also creates a fixed generic Global principle
candidate with explicit uncertainty. Global extraction writes fixed generic principles with opaque
source links, never project summary text, personal information, full logs or
private reasoning. All such entries remain **untrusted candidates**, without
automatic promotion or authorization to execute anything.
