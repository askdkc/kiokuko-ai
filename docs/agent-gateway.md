# Agent Event Gateway HTTP/JSON v1

Kiokuko exposes a client-neutral local control-plane API. Coding agents send run lifecycle and normalized events to Kiokuko; Kiokuko commits sanitized records to SQLite and returns bounded, untrusted memory context plus deterministic recommendations.

The v1 gateway is **not** an OpenAI/Anthropic provider reverse proxy. It never requires provider credentials and does not claim to observe events that a client cannot report.

## Runtime and discovery

Start the foreground service with:

```bash
kiokuko-ai serve [--host 127.0.0.1] [--port 0] [--json]
kiokuko-ai server status --json
```

`kiokuko-ai web` is the compatibility entry point for the same server composition. The service accepts loopback hosts only. On startup it creates a same-user runtime descriptor containing protocol version, PID, base URL, database fingerprint, instance ID, start time, and a random capability token. The descriptor is mode `0600`; the token must not appear in stdout, argv, `AGENTS.md`, events, logs, or error responses.

All `/api/v1/*` endpoints require `Authorization: Bearer <capability-token>`. `GET /health/live` exposes only liveness; `GET /health/ready` is authenticated. CORS is not permissive.

## Write protocol

Every write requires:

- `Content-Type: application/json`
- `apiVersion: "1"`
- `Idempotency-Key: <opaque non-empty key>`
- strict unknown-field rejection
- request body at most 2 MiB

A key is scoped to the operation/run. Replaying the same key with the same canonical request returns the stored atomic mutation acknowledgement and does not repeat the mutation. Reusing it with different content returns `409 CONFLICT`. For operations that add capability-gated context, gating and retrieval happen after that mutation boundary and are re-evaluated against the current retrievable revisions and feedback. The full enriched JSON may therefore change on an exact retry even though the acknowledged mutation does not. Freezing the earlier enriched context would bypass current retrieval eligibility. Event batches are all-or-nothing and contain at most 200 events; one sanitized payload is at most 64 KiB.

Success envelope:

```json
{"apiVersion":"1","ok":true,"operation":"agent.checkpoint","data":{},"meta":{}}
```

Failure envelope:

```json
{"apiVersion":"1","ok":false,"operation":"agent.checkpoint","error":{"code":"VALIDATION_ERROR","message":"...","details":{}}}
```

The server never includes an auth token, matched secret, raw request, hidden reasoning, or internal stack in an error. Queue saturation returns `429` with `Retry-After`; unavailable storage returns `503`; validation returns `400`; authentication returns `401`; not found returns `404`; idempotency/source-ID conflict returns `409`.

## Lifecycle endpoints

### Open

`POST /api/v1/agent/runs`

Creates a ledger run, an Akinator intake session, and their one-to-one `run_intakes` link in one application transaction. Workspace is fixed here and is immutable for the rest of the run. Client-supplied coverage is stored exactly; Kiokuko does not upgrade it.

If intake needs an answer, the run remains `intake`, the response includes only the current question and no memory context. A client must present that question to the user without inventing an answer. A finalized `ready` or bounded `exhausted` intake moves the run to `active` and permits initial context delivery.

### Answer intake

`POST /api/v1/agent/runs/:runId/intake/answers`

Accepts only the currently outstanding question ID. The answer, intake transition, lifecycle event, and run status transition are atomic. Exact retry replays that mutation acknowledgement without repeating the answer; any post-commit capability gate and context retrieval are evaluated again under the bound catalog and current retrieval eligibility. A finalized profile is immutable; later task-understanding changes are appended as `task_profile.revised` events.

### Append events

`POST /api/v1/agent/runs/:runId/events`

The server preserves source event IDs/sequences and assigns a contiguous local sequence. The canonical event type and optional client `sourceType` are both stored. Non-intake events are rejected while the run is `intake`. Terminal runs reject new events except exact idempotent replay.

### Checkpoint

`POST /api/v1/agent/runs/:runId/checkpoints`

Atomically appends the included events, then projects state through the committed cursor. The response includes the authoritative finalized intake status (`ready` or `exhausted`). The request must include the exact complete `capabilities` catalog bound when the run opened; the server validates that binding before mutation and removes the catalog before strict checkpoint parsing. Retrieval happens after the write transaction and outside the bounded write queue. The broker ranks once, evaluates the capability gate against that fixed snapshot, and persists only that same snapshot after approval; it never previews and then re-queries. Inside the delivery transaction, every selected exact revision is revalidated as current and retrievable, including the active managed-external mapping and source identity. A concurrent revision, disable, stale, or refresh transition returns a conflict with no delivery instead of silently reranking. Every request requires the exact local `kiokuko-soul` Skill in the bound catalog; missing or unknown availability returns `nextAction: required_capability_unavailable`, `context: null`, and no persisted delivery, including while intake still needs an answer. Actionable ordinary build/debug memory from `ready` intake is returned only when the bound catalog also contains the local `memory-reasoning` Skill. Missing or unknown `memory-reasoning` alone sets `memoryPolicy.contextWithheld: true`, reports `memory_reasoning_missing` or `memory_reasoning_unknown` in `memoryPolicy.withheldReason`, and withholds that ordinary memory while leaving `nextAction: proceed`; the ready-only memory policy does not apply to bounded `exhausted` intake. After this gate, the response may contain one persisted v1 advisory nudge selected from the final recommendations; the nudge is never selected or persisted before capability gating.

### Close, feedback, promotion

- `POST /api/v1/agent/runs/:runId/close`
- `POST /api/v1/agent/runs/:runId/feedback`
- `POST /api/v1/agent/runs/:runId/promotions`

Close records a terminal status, final events/evidence, unresolved items, outcome, and explicit memory proposals. Feedback records context, recommendation, intake-question/profile, and run outcomes without automatically changing entry trust/status or the active intake policy. Promotion creates only an existing-memory `candidate` entry and records run/event/delivery/intake provenance; it never auto-promotes to `verified`.

The former unbound `POST /api/v1/context/query` route was removed. A request without a run cannot prove which capability catalog governs the returned memory, so the server does not provide an ungated compatibility fallback.

## Read protocol

Cursor-paginated read endpoints are:

- `GET /api/v1/agent/runs?workspace=&client=&status=&cursor=&limit=`
- `GET /api/v1/agent/runs/:runId`
- `GET /api/v1/agent/runs/:runId/intake`
- `GET /api/v1/agent/runs/:runId/events?after=&limit=&type=`

List pages are capped at 100 records. Event content returned to agents is marked
`untrusted: true` and must be checked against the current repository/runtime.
Workspace and memory inspection belongs to the human/operator CLI and Web
management surfaces; the Agent API does not expose ungated read aliases.

The former context-delivery listing route was removed because a GET request has no complete capability-catalog channel. Context deliveries are returned only by the capability-gated open, answer, and checkpoint operations that create them.

## Coverage

Each category is one of `complete`, `best_effort`, `declared`, or `unavailable`. `complete` is reserved for a versioned bridge with a clean-room contract test. Generic CLI runs normally use `declared` or `unavailable`. UI and recommendations must display incomplete coverage rather than call the ledger a complete transcript.

The Enno-Oduno user-confirmation and plan-start recovery display contracts are delivered only through the MCP boundary. A decided contract returns the `userFacingConfirmation` projection. Missing or changed environment information persists only a continuation pause and returns a projection containing a general explanation, the absence of new work from that plan-start attempt, a remedy, and bounded choices. Each choice supplies a label and recommendation followed by the user intent it fits and the exact result of choosing it; clients translate all four parts and hide machine actions, reason codes, internal fields, catalogs, identifiers, revisions, presentation versions, and raw JSON. A legacy attempt already ended by proven environment-information loss returns a restart projection without reopening or cancelling the terminal attempt. The client waits for the user's explicit response and performs no retry, cancellation, or replacement creation before it; it never asks the user to locate the internal capability catalog. A same-run plan retry carries the selected recovery action. `enno_answer` receives explicit confirmation or cancellation, including cancellation from active planning before a user-selected restart. The Agent Event Gateway does not expose, replicate, or continue Enno runs, and no gateway endpoint substitutes for explicit user input.
