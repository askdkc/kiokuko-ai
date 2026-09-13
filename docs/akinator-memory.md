# Akinator profile memory

Profile memory supplies previous-profile examples when the current request lacks a target or success condition. Current inputs win. Questions remain advisory, and missing Skills do not prevent ordinary work.

## Enable

The default is `off`. Start a new OpenCode/MCP process with the desired environment setting:

```bash
KIOKUKO_AKINATOR_MEMORY_MODE=suggest opencode
```

| Mode | Behavior |
|---|---|
| `off` | No profile probe; state-only reads and indexed tag retrieval remain enabled. |
| `shadow` | Persist bounded candidate references and the hypothetical resolve decision for evaluation without changing the profile or visible hints. |
| `suggest` | Return up to three examples per missing field in `intake.memoryHints`. |
| `resolve` | Also fill a missing target only when an explicit current path, current repository location, completed source run, original user/client provenance, and complete non-conflicting search agree. |

Invalid mode values disable assistance with a structured warning. Path permission or resource failures report their reason and continue without adoption; database corruption and repository mismatches are not treated as empty results. Restart the process to apply an environment change. Switching off suppresses hints and new adoptions; it does not rewrite an existing run's audited profile. Requests opened in off/shadow retain their original setting when retried.

Initial automatic resolution accepts only short single-path directives such as `Fix src/alpha.ts` or `src/alpha.ts を修正`. Negation, examples, multiple targets, and extended prose remain suggestions. Filesystem checks run outside the write lock; repository binding and canonical profiles are revalidated inside the transaction.

Success conditions, constraints, task types, and past permissions are never adopted automatically. Targets outside the repository, absent paths, vague names, incomplete indexes, and truncated searches cannot be auto-adopted. A similarity score is a ranking signal, not a probability or authorization.

## Existing history

New ready intakes update their profile projection automatically. To include older history, run the following from this repository checkout, using an explicit test or backup database first:

```bash
npm run memory:backfill:akinator -- --database /absolute/path/to/test.sqlite3
```

Use `--workspace project:example` to limit the operation and `--batch-size 100` to set the batch size. The command requires an existing regular database file, applies current migrations, commits bounded batches, and resumes after interruption. It never implicitly selects the normal application database. Use Kiokuko's backup procedure for a running database; do not copy only the SQLite main file.

Search projections and FTS are rebuildable. Pass `--rebuild` to reset the selected workspaces' projections and cursors before backfilling; initial adoption audit records remain. Partial coverage is reported and cannot authorize target adoption. Profile text is not inserted into ordinary memory entries.

## Replay, restore, and deletion

A new request gets one initial resolution inside the existing run transaction. History or setting changes do not alter its request hash. Replays preserve later user answers. Source references are revalidated before hints are displayed, including through `task_context_read` after compaction.

Immutable context revisions store candidate references rather than copies of candidate text. Updated, missing, or purged sources are not hydrated. Purging a source run removes its search projection and clears referencing resolution candidates. An already adopted current profile remains part of that current run's audit; purge that run as well if its retained content must be removed. Backups are separate retention surfaces.

Migration 007 adds the projection and resolution tables. Ledger archive version 2 includes initial resolution records; the reader also accepts version 1. Restored projections require explicit backfill. Old binaries cannot read the new schema/archive merely because the mode is off. Keep a pre-upgrade backup for downgrade; do not relabel `memory` provenance as a user answer.

## Verification

```bash
npm run typecheck
node scripts/run-tests.mjs tests/unit/profile-memory-resolver.test.ts tests/integration/akinator-memory-probe.test.ts
npm run test:evaluation:akinator
npm run test:benchmark:akinator -- --entries 10000 --profiles 1000 --samples 10 --prepare-samples 1
```

Evaluation and benchmark reports are printed to standard output. Add `--output /tmp/akinator-report.json` to save a report explicitly; neither command creates report files by default. Fixtures contain no personal history. The benchmark reports SQL executions, body reads, local retrieval and synchronous prepare latency, and write-lock duration, including a reproduction of the previous full tag scan. It does not measure background enrichment completion, production correction rates, or task-total token savings.

Candidate IDs are limited to 64, lexical query stages to three, and hints to three per field. The probe makes no additional LLM, embedding, or network calls. SQLite remains synchronous: candidate budgets do not constitute a hard SQL timeout. Worker/Go deployment is not included.
