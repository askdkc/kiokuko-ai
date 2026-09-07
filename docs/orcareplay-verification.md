# OrcaReplay pipeline verification

Implementation and verification date: 2026-09-07 (JST).

The starting checkout was clean and exactly matched PLAN.md's baseline,
`e7388345c7ffb14d649de4c16a7e8757ab6fef09`. The implementation is an uncommitted
working-tree change, not a published version. Migrations 001–003 and the lockfile
were left unchanged; migration 004 is added with the reader that consumes it.

## Environment and isolation

- macOS, Node 26.5.0; local package identity `kiokuko-ai@0.1.15`.
- Installed OrcaReplay: `/opt/homebrew/bin/orca`, version 0.2.1.
- Installed OpenCode version probe: 1.18.29. This is not evidence of a TUI test.
- Existing dependencies were reused. `npm ci` and dependency installation were
  not run; no package version or dependency change was required.
- Test databases, HOME, capture stores and fake executables were temporary.
  `KIOKUKO_DATA_DIR` redirected tests that otherwise consult the real data folder.
- HTTP integration tests and the actual Orca local proxy needed permission to
  bind loopback ports. The restricted first run's permission errors were not
  treated as product regressions. No paid model request or real API credential
  was used. No user `.orca` data or shell startup file was changed.
- The default npm cache was not writable in the sandbox. Pack verification used
  a temporary npm cache; no cache ownership or permissions were changed.

## Reproduced failures and coverage

Before implementing the fixes, all three new tests in
`tests/integration/trace-worker-result.test.ts` failed against the baseline:
worker completion returned `VALIDATION_ERROR` after successful persistence,
strict canonical hashing rejected an undefined result field, and incremental
context counted 2 events instead of the cumulative 6. All three now pass without
weakening the shared strict JSON or secret validators.

| Contract | Executed evidence |
| --- | --- |
| F00 | `trace-worker-result.test.ts`: real orchestration worker completion, canonical JSON result, repeated no-op ingestion |
| F01 | Same regression plus `trace-pipeline-boundaries.test.ts`: partition equivalence, retained early details, final replay and bounded overflow |
| F02 | `orcareplay-pipeline.test.ts`: actual CLI wrapper with fake Orca/OpenCode, child-exit finalization, task preparation and immutable revision delivery, concurrent recordings, exit codes and signals |
| F03 | `trace-pipeline-boundaries.test.ts`: manifest-only finalization, unsupported recovery and interrupted final verification |
| F04 | `orca-replay-setup.test.ts`: HOME/ZDOTDIR, old alias upgrade, conflicts, refusal/noninteractive/dry-run, concurrent setup, symlink protection and version-probe timeout |
| F05 | Store registration and advisory tests: canonical aliases, capture subdirectories, canonical repository isolation and pending stores |
| F06 | Boundary tests: 11 changing/backlogged runs, retained enumeration past 200 entries and multiple-store round robin |
| F07 | Plugin tests and OpenCode boundary verification; runtime-owner lifecycle and discovery shutdown tests |
| F08 | Boundary tests: 80 MiB stream, saved offsets and reopen, incomplete/Unicode lines, oversized and malformed JSON, blobs, symlinks/FIFOs and file replacement |
| Atomicity | Two independent SQLite connections, stale revision rejection, expired owner lease, failure before commit, deadline with another owner still active |
| Migration | Populated normal entry/revision and historical task snapshot preserved byte-for-byte, old trace quarantined, migration rollback and foreign-key check |
| Delivery | Corrupt/secret-bearing/mismatched contexts excluded, ordinary tasks continue, no-trace behavior, deterministic candidates and optional enrichment failure/off |

These are combined contract scenarios, not a claim that each numbered example in
PLAN.md has its own independent test. The test runner includes all new files.

## Large log and end-to-end results

The large-log fixture contains **83,927,982 bytes**. Normal ingestion reaches
byte offset **83,927,982** and last sequence **1278** in **20 batches**; the final
aggregate contains **1,279 events** with `finalization=finalized` and
`integrity=verified`. Each ordinary batch is bounded by 4 MiB or 2,000 valid events,
with completion of the current bounded line. Final verification uses a separate
streaming replay with a 64 KiB read buffer. Peak RSS and total filesystem syscall
counts were not measured; no bounded-memory claim is inferred from elapsed time.

A finite directory test observes 200 then 5 entries using one retained handle.
Scheduling and lease tests assert the pending/completed records and progress
rather than treating the scan's enqueue count as completion.

E2E-A uses real CLI dispatch, fake executables on a temporary PATH, a temporary
Git repository and the actual database/worker/task-preparation implementations.
It does not insert a finished trace context directly into the database. Early
errors, tool calls and notes survive the final events written after child exit;
repeated synchronization does not duplicate candidates. Two recordings in one
store both reach verified finalization.

E2E-B was run against the installed OrcaReplay **0.2.1**, using a fake OpenCode
that exits with 7. Orca wrote its real manifest and events, returned exit **7**,
and the reader imported **3 events**, through sequence **2**, with verified final
integrity. The fake OpenCode performed no model request. The opt-in test rejects
other versions and explicitly skips when `KIOKUKO_TEST_ORCA` is absent.

E2E-C, actual OpenCode TUI operation under a PTY, was **not run**. Neither real
foreground process-group Ctrl-C behavior nor Windows signal behavior is established
by the passing fake-child SIGINT/SIGTERM tests. Real model API interaction and
hostile concurrent directory substitution under OS isolation were also not tested.

## Reproduction commands

From the repository root, with the existing dependencies available:

```sh
npm run typecheck
npm run build
KIOKUKO_DATA_DIR=/tmp/kiokuko-plan-unit npm run test:unit
KIOKUKO_DATA_DIR=/tmp/kiokuko-plan-integration npm run test:integration
npm run verify:opencode-boundary
npm_config_cache=/tmp/kiokuko-plan-pack-cache npm run pack:check
git diff --check
KIOKUKO_TEST_ORCA=/opt/homebrew/bin/orca node scripts/run-tests.mjs tests/integration/orcareplay-real-cli.test.ts
```

The two `/tmp` data directories must be disposable test locations. Full integration
and the opt-in Orca test need loopback network access. Pack checking is a dry run;
these commands do not publish or commit changes.

## Final results

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | Passed, including the final import/format cleanup |
| `npm run build` | 0 | Distribution compiled successfully |
| `npm run test:unit` with isolated data directory | 0 | 715 passed, 0 failed |
| `npm run test:integration` with isolated data directory and loopback access | 0 | 891 passed, 0 failed, 1 explicit opt-in skip |
| Opt-in actual OrcaReplay contract test | 0 | 1 passed against 0.2.1 |
| `npm run verify:opencode-boundary` | 0 | Public OpenCode-only boundary passed |
| `npm run pack:check` with temporary npm cache | 0 | Dry-run package contains 949 files, including migration 004 and this record |
| `git diff --check` | 0 | No whitespace errors |

The final full suites were followed only by removal of obsolete unused imports,
formatting of changed lines, and this results record; type checking was repeated.
Kiokuko MCP enrichment was unavailable in this host; implementation and verification
used current repository files and the bundled local guidance.
