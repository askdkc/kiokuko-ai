# Agent file management

`kiokuko-ai setup` configures OpenCode's global MCP/plugin settings and global
`AGENTS.md` with a Kiokuko global-memory block. `kiokuko-ai use` optionally creates
or updates the repository's `AGENTS.md` with a project-specific block.

If setup creates a missing project binding for a registered project, it also
adds `.kiokuko.json` to that project's root `.gitignore` when neither the plain
nor root-anchored entry is already present. This setup-only addition participates
in the same compare-and-swap and rollback boundary as the binding and project
agent file.

Existing bytes outside the block are preserved, including the human-authored
header/footer, line-ending style, and file mode. Missing markers are appended;
imbalanced, duplicated, nested, or reversed markers cause a validation error
and are not repaired automatically. Symlinks are rejected.

Repeated `setup` or `use` with unchanged content does not rewrite its target
files. `setup --dry-run` validates all target content without creating the
database, config, or instruction files.

When `kiokuko-ai use --agent-file` changes an existing repository binding, the
new target is installed and only the exact marked block is removed from the
old target. Human bytes and file mode outside that block are preserved; a file
is deleted only when the managed block was its entire content. Malformed
markers, symlinks, concurrent file changes, or a later database-registration
failure abort the transition and conditionally restore every Kiokuko-owned
file mutation. Cleanup and restoration failures are reported rather than
ignored.

The generated instructions describe the high-level `task_prepare`,
`task_answer`, Curator, and `memory_checkpoint` MCP lifecycle. The first two are
the only model-facing task-memory entry points. Human/operator CLI and Web
inspection remain management-only and are not a fallback for a client that
cannot satisfy the task capability gate. When Enno-Oduno is enabled, setup
installs the bounded OpenCode `session.idle` plugin. It only gates the existing
run-bound continuation; it does not recall memory, launch advisors, bypass
planning or confirmation, or select a latest run. A client session is routing
metadata, not authorization ownership. Continuation prefers the exact
short-lived opaque resume token bound to the route epoch; otherwise the plugin
may atomically reroute the single unambiguous active run in the canonical
repository. Rerouting increments the epoch and invalidates old tokens. An
active WorkUnit execution lease blocks rerouting and only its holder may report.
Multiple candidates remain unchanged.

Template version 23 also documents bounded `ENNO_INPUT_INVALID` diagnostics,
the explicit advisory lifecycle and dynamic report schema, WorkUnit-local
`code`/`ui`/`test`/`docs`/`operations` routes, repository-relative verifier
directories, continuation-pausing plan recovery, pre-persistence sanitization,
crash-recoverable receipts, and repository-state-bound Final Review evidence.

The instructions require one new bounded opaque `requestId` per logical user
request and permit reusing it only for an exact transport retry. Identical task
text in a later request still gets a new ID. Reusing an ID with changed bound
input conflicts, and `client.sessionId` is not accepted as a substitute.
The normalized context budget is also bound at preparation and must be repeated
unchanged by `task_answer`.

Default setup installs the exact local `memory-reasoning` Skill, but installation
is not proof that a model loaded or followed it. For actionable build/debug
memory, generated instructions treat catalog
availability as only the gate, not proof of compliance. The client must read the
available local `memory-reasoning` Skill before modifying code and convert
recalled claims that affect the task into verified premises, falsifiable
invariants, concrete counterexamples, and regression tests. Missing or unknown
availability is explicit in `memoryPolicy.contextWithheld` and
`memoryPolicy.withheldReason`; `nextAction` remains `proceed`.
