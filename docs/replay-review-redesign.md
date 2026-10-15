# Reviewed replay memory

## Source and history evidence

This change starts at `askdkc/kiokuko-ai` commit
`df55c3dccfc91221c9a1527425b474f673e23a1e` (0.2.9), not a reconstructed tree.
The supplied atomic-context archive named base `56b786c`; all five final file
hashes match this checkout, including the change committed as `423e256`.

Useful fixes retained:
- `423e256`: selection and persistence share an atomic snapshot, preventing a
  concurrent learning write from invalidating a successful context selection.
- `d01b800`: temporary test directories are allocated under the platform temp
  root and cleaned up, rather than depending on an existing developer directory.
- `391dd2b`: cancellation/pipe failure lifecycle handling and child cleanup.
- `86045f4`: stored data is not proof of provider-visible retrieval delivery.
- `56b786c`: safe MCP error classifications preserve diagnostic codes without
  revealing private paths, logs or credentials.

Patterns deliberately replaced:
- `c212155` automatically persisted praise, complaints, completion and model
  switches. Such events are evidence, not permission to store derived memory.
- Historical checkpoint wording made memory completion terminate all tool use.
  Memory-free task evidence remains available; optional memory bookkeeping no
  longer controls ordinary completion or independent verification results.
- A model-supplied `confirmed` flag is not a human approval boundary.

These are findings from source/history and regression tests. They do not establish
one common cause for every historical CI incident, and do not describe the user's
computer or installed runtime.

## Runtime contract

Server prompt/context hooks recall advisory memory asynchronously and retain only
volatile public handoff excerpts. They do not persist new observations. They never
await memory availability before allowing the user's task to proceed.

The exported `/tui` entrypoint is resolved by the installed OpenCode plugin host.
It offers review after a root session reaches settled succeeded/failed idle with a completed
assistant `finish=stop`, public final text, and no queued requests. Tool-only turns
and duplicate events do not qualify. The native organization dialog asks the user
whether the task is actually finished; an idle event alone is not a task-success
claim. New execution and explicit Stop cancel any pending review.

The optional `memory_review_completed` MCP tool supports clients advertising
native elicitation. It validates an already-settled completed/failed operational run, then asks
organization and revision-bound review questions through the client's native UI.
A memory-free terminal checkpoint queues that review without awaiting the answer.
The TUI avoids duplicating a review already queued by that request.
It has no model-callable approval argument. Clients without supported native UI
return an unavailable receipt, without blocking or undoing the completed task.

Candidates, revisions and approval state remain in process-local memory until
approval. Native UI comments replace proposed findings with explicitly attributed
user corrections, preserve source observations, and show a new exact revision.
Decline, dismissal, stale answers, shutdown and cancellation do not save candidates.
The approved revision and contextual keyword/tag index commit together in SQLite.
An uncertain COMMIT is confirmed only through a separate read-only connection;
an uncommitted receipt visible to its writer is not treated as a saved memory.
User approval is not reclassified as verified task success. Existing source,
redaction, contradiction, revision and purge tools remain quality controls.

The selected recording can span multiple requests or sessions. Preview includes
its exact run, digest and coverage gaps; review-session/task labels identify the
review, not a proven one-to-one source capture. Recorded commands/results retain
separate attempted, unknown, failed, succeeded and denied states. Missing results
and unsealed recordings are disclosed. No private reasoning is extracted.

The TUI adapter uses the configured package-owned Node runtime for SQLite; native
UI answers travel on its private IPC channel. It never exposes a save/approve
command as a model tool. Real rendered UI and platform matrix coverage must be
reported separately from SDK-typed adapter fixtures and Node regression tests.

After a save acknowledgement is lost, adapters keep only the already-approved
revision and approval identity in their host-session closure. Repeating that
review reconciles the same key through a separate read-only connection, without
extracting another candidate, asking for another approval, or issuing another
write. The TUI worker waits for the host to acknowledge retaining this identity
before writing. An absent or unreadable receipt stays unknown. This recovery
cache is ephemeral: process restart loses it and is not reported as recovery.

## Standalone maintenance boundary

Legacy `record`, `promote`, and interactive `curator` commands are standalone
human-operated maintenance paths, not adapters for the post-task review loop.
Their terminal check and typed confirmation are convenience checks, not proof of
authenticated human origin: a process controlling a PTY could provide that input.
Agents must never invoke them or send terminal answers as a substitute for the
revision-bound native TUI or MCP review. They are absent from the automatic flow;
model-callable persistence endpoints return review-required receipts instead.
The review loop's approval boundary assumes the native host owns its UI, while
the model does not control native dialog or elicitation responses. This is not an
OS security boundary against a process with arbitrary filesystem access.
