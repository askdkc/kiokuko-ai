<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.async.v1` — asynchronous state and recovery

Select this expert for save, submit, upload, download, import, export, search, AI generation, OCR, sync, authentication, or any user-triggered delayed work.

## State machine

List reachable states before implementation:

```text
idle -> pressed -> processing -> success | failure | cancelled
                         \-> offline | permission-denied | stalled
```

Define how each state is entered, rendered, announced, exited, retried, and cleaned up. Loading, empty, and failure must be distinguishable.

## Processing

- Acknowledge activation immediately; do not wait for the server.
- Use determinate progress only when it measures real progress. Never fake a percentage.
- Keep completed user work visible.
- Prevent accidental duplicate execution while leaving unrelated controls usable.
- For long work, update expectations and offer cancellation only when it truly stops or safely abandons the operation.
- State whether work continues in the background and provide completion feedback if users may leave the view.

## Concurrency and lifetime

Guard against double clicks, overlapping requests, stale responses, navigation, unmount, retry while active, and out-of-order completion. When only the newest result is valid, older results must not overwrite it.

Cancellation semantics must be exact. Hiding a dialog or ignoring a result is not cancellation of backend work unless communicated as such.

## Failure and recovery

On failure:

1. stop the busy state;
2. preserve input and completed work;
3. explain the affected action in user language;
4. place the message in the task context;
5. offer the next real action: Retry, Reconnect, Back, fix a field, choose another file, or save locally.

Do not represent failure only in logs, a rejected promise, a stopped spinner, or “Something went wrong” when a useful cause is known.

Offline queueing may be promised only when work is actually persisted. Permission denial should not cause repeated prompts; explain the limitation and recovery route.

## Focused verification

Test slow success, server failure, timeout, offline, cancellation, repeated activation, stale completion, unmount/navigation, recovery, and accessible status announcements.
