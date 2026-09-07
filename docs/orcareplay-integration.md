# OrcaReplay integration

Kiokuko treats `.orca` as untrusted, read-only input.

Use the Kiokuko wrapper to record OpenCode and import the final events after
OrcaReplay exits:

```sh
kiokuko-ai trace record --
kiokuko-ai trace record -- run 'Review the changes'
kiokuko-ai trace record --sync-timeout-ms 120000 -- run 'Run the tests'
```

The wrapper preserves the capture working directory, passes arguments as an
array to `orca record opencode -- ...`, and inherits the terminal streams.
The ordinary recording has no time limit; the timeout applies to synchronization
after Orca exits. No model configuration is changed by Kiokuko.

## Setup

Interactive `kiokuko-ai setup` offers OrcaReplay installation and separately asks
before editing the displayed absolute shell configuration path. The shorthand is:

```sh
alias orca-opencode='kiokuko-ai trace record --'
```

For zsh, the target is `$ZDOTDIR/.zshrc` when ZDOTDIR is set to an absolute path,
otherwise `$HOME/.zshrc`. Bash uses `$HOME/.bashrc`. Empty, relative or ambiguous
values, unsupported shells and Windows require manual setup. Unexported shell
variables cannot be inferred. Kiokuko does not execute shell startup files.

The managed marker and exact old managed alias can be upgraded under the shared
file lock. Human content, mode and line endings are preserved. User aliases and
functions are conflicts; symlink rc files require manual editing. The old bug's
CWD rc file is never deleted or moved. A detected managed marker there is reported.
Dry-run, noninteractive execution and refusal do not install or edit the rc.
Installation uses ordinary npm on all platforms; a permission failure produces
manual instructions rather than automatically acquiring root. Detection has a
three-second deadline, and the installed executable is checked again.

## Ownership and locations

The existing MCP runtime owns an asynchronous discovery coordinator and the
orchestration worker. OpenCode's plugin does no trace directory scanning and
launches no periodic scan subprocess. Idle and compaction handling remain intact.
The coordinator closes its timers and directory handles before the worker and DB.

A store belongs to a canonical repository location and a canonical capture CWD.
The default root store and explicitly registered subdirectory stores are checked.
A pending registration can precede Orca creating `.orca/runs`. No recursive search
for stores is performed, and a manifest's `cwd` does not authorize registration.
Other worktrees do not inherit trace references through a shared repository ID.

Live ingestion starts once the MCP database runtime has initialized. Direct
`orca record opencode` also works, but its final events are collected by a later
MCP scan or explicit sync; an OpenCode shutdown hook cannot collect writes that
Orca performs after OpenCode exits.

## Scan, sync and status

```sh
kiokuko-ai trace scan --project-root /absolute/capture/cwd --max-runs 8 --json
kiokuko-ai trace sync --capture-cwd /absolute/capture/cwd --timeout-ms 120000 --json
kiokuko-ai trace sync --capture-cwd /absolute/capture/cwd --run run_abcdef123456 --json
kiokuko-ai trace sync --capture-cwd /absolute/capture/cwd --rebuild --json
kiokuko-ai trace status --capture-cwd /absolute/capture/cwd --json
```

`scan` discovers and schedules work. Its `discovered`, `scanned`, `enqueued`,
`skippedUnsupported`, `storesVisited`, `scanComplete`, `hasMore` and `warningCodes`
fields do not assert ingestion completion. A one-shot scan enumerates at most
200 directory entries and checks at most `maxRuns` known runs. A live coordinator
retains its enumeration handle across steps. Known runs receive processing
opportunities by oldest check, independently of display recency.

`sync` continues one enumeration session and drains only trace ingestion jobs
for that store (or the explicit run). It does not claim other projects' jobs,
plan publication, semantic retrieval or memory approval jobs. It handles currently
available live data without waiting for a running recording to end. An explicit
missing run is an error; a missing ordinary store is a zero-work result.

`status` shows the registered location, job counts, generation, next byte offset,
last sequence, finalization, integrity and constant diagnostic codes. It does not
print event bodies or blob content. A completed memory-candidate job means that
Curator/user approval is still required, never automatic global promotion.

Sync exits with 0 for completion (including a live snapshot), 3 for partial
completion, interruption or rejected input. Argument/configuration failures use
the CLI error envelope. The wrapper preserves Orca's nonzero exit code. POSIX
SIGINT/SIGTERM are forwarded and map to 130/143 when the child exits successfully
after interception. A further interruption during sync aborts it. Windows has no
POSIX foreground-group guarantee.

## Progress, limits and integrity

Normal ingestion reads complete LF-terminated lines from a saved byte offset.
A trailing incomplete line remains at its starting offset. Unicode is decoded
only after a complete line is assembled. Stable final processing may consume a
last line without LF. Sequence gaps, invalid lines, unknown events and unresolved
blob descriptors remain distinct parse warnings; they never become trusted data.

| Budget | Limit |
| --- | ---: |
| Manifest | 256 KiB |
| Event line | 1 MiB |
| JSON depth / token budget | 64 / 20,000 |
| Read buffer | 64 KiB |
| Ingestion batch | 4 MiB or 2,000 valid events, ending on a line boundary |
| Aggregate | 64 KiB |
| Tool identities | Up to 256 within a 32 KiB identity budget |
| Public reference including wrapper | 4,096 UTF-8 bytes |
| Warning samples | 32; total count is retained separately |
| Explicit blob expansion | 4 KiB |
| Default sync deadline | 120 seconds |

A batch limit does not truncate the run: subsequent jobs resume from the saved
byte offset. The first observed tool identities retain their exact counts;
additional identities contribute to `otherToolCalls`. Early bounded error, file
and note details are retained deterministically. Overflow and parse completeness
are explicit. The displayed list is not a claim of exact top tools after overflow.

The ordinary reader validates blob references but never opens their bodies.
The optional small-blob API checks actual bytes and digest under its limit.
Manifest/events and all `.orca` components reject symlinks and nonregular files,
including FIFOs. Reads bind file descriptors to checked identities and reject
observed replacement, truncation and mutation. Filesystem syscalls on a stalled
mount cannot be forcibly cancelled by a JavaScript timer. Portable Node checks do
not provide complete protection against a same-user adversary continuously
replacing directories; that threat requires OS isolation.

Finalization states are `recording`, `ended_pending_manifest`,
`ended_unverified`, `finalized`, `blocked`, `unsupported` and `source_missing`.
Final processing rebuilds the complete aggregate and computes SHA-256 over the
same raw-byte stream, then checks the file identity and manifest again. Hash
verification alone never promotes trust. A mismatch is isolated from advisory
delivery and candidate generation. Interrupted final verification can be retried
with a longer sync deadline; hash state is not serialized across processes.

## Persistence and advisory delivery

Progress, aggregate, context and successor jobs commit together under a revision
and generation check. A worker lease is checked before progress is published;
long final verification renews its lease. Retry keys include location, run,
policy, generation and progress/input identity. Completed work is not re-enqueued
without a new input or explicit rebuild.

Only attributes used by the projection are eligible for persistence. Their full
values are secret-checked before Unicode-safe shortening. Unused environments and
raw payloads are discarded. Stored summaries, candidate jobs and delivery are
checked again. Diagnostics contain constant codes, not excerpts of rejected data.

A final verified aggregate with no parse warnings can produce memory candidates.
Their identity excludes optional external search results and current time.
Optional skill discovery runs in a separate job, uses the existing query allowlist,
and respects `KIOKUKO_SKILL_DISCOVERY=off`. Failure cannot roll back ingestion.
Its bounded reference result is included only when it fits the delivery budget.

Task preparation selects current-policy contexts from registered stores for the
same canonical repository location. Finalized contexts are preferred, then the
same capture CWD; trace creation time and run ID break ties. Derived/fork contexts
are excluded. Schema, identity, digest, byte size, integrity and secrets are
validated before returning `referenceOnly: true`, `autoInstall: false`,
`autoExecute: false`. A locally corrupt reference produces
`TRACE_CONTEXT_REJECTED` while ordinary preparation continues. Database failures
are not hidden. With no trace there is no extra field, warning or network request.
Delivered references remain immutable snapshots in task-context revisions.

Migration 004 preserves normal memory and task history. Old trace contexts stay
at policy 1 and are excluded from new delivery; their progress restarts at byte 0
in a new generation. Missing originals are not reconstructed from old summaries.
`--rebuild` only resets derived progress and starts a generation; neither migration
nor recovery deletes, repairs or writes the `.orca` original.

## Verification

See [the implementation verification record](orcareplay-verification.md) for
commands, regressions and the tested executable versions. The opt-in real Orca
contract test uses a fake OpenCode executable and no paid model API:

```sh
KIOKUKO_TEST_ORCA=/absolute/path/to/orca node scripts/run-tests.mjs tests/integration/orcareplay-real-cli.test.ts
```

That test pins OrcaReplay 0.2.1 and otherwise reports an explicit skip. Actual
OpenCode TUI behavior and foreground process-group Ctrl-C require a separate PTY
check; a fake child signal test does not establish that behavior.
