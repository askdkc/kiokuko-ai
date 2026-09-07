# Managed File Concurrency

Managed configuration updates use a separate `node:sqlite` rollback-journal database and an in-process queue. The lock database is not the memory database and does not contain edit intent, sessions, prompts, or leases. A process crash releases its SQLite transaction; the next explicit operation can proceed without replaying the interrupted edit.

`use` coordinates the physical repository group containing the binding, agent files, and project ignore file. `setup` coordinates the physical OpenCode configuration group. Independent repositories and configuration groups do not share these locks. Dry runs do not create a lock database, target files, directories, or the primary database.

Existing files are published with one replacement operation after the temporary has been fully written, synced, and checked. New files use a no-clobber hard link. Existing atomic-write checks for regular files, containment, parent identity, UTF-8, modes, and owned cleanup remain in force.

Managed regions are rebased against the latest bytes. Unmanaged bytes are taken from that latest input. An already identical managed result converges without a write; a different concurrent managed region is reported as a conflict. This does not provide compare-and-swap against writers that bypass the coordinator, and it cannot guarantee durability across power loss without filesystem-specific synchronization.

The lock wait limit is two seconds with bounded asynchronous retry. The lock is never stolen by timeout. A caller aborts before entering the critical section and does not begin a new publication.

## Crash and failure behavior

Verified by `tests/integration/managed-file-crash.test.ts` with real child processes:

- A force-terminated (`SIGKILL`) lock holder releases the lock through the operating system. The next explicit operation acquires it without any stale-TTL wait, and the lock database contains no tables or rows, so no interrupted edit intent is ever replayed.
- A zero-length lock database left by an interrupted initialization is treated as an empty database; the next operation proceeds safely.
- A crash before publication leaves the target at its previous complete version. Leftover managed temporaries are never adopted and are not bulk-deleted.
- A crash after publication leaves the target at the complete new version, and the lock is immediately reusable.

## Guarantees and limits

- Coordinated writers (`setup` / `use` through the coordinator) serialize per physical resource. Path aliases (symlinked parents, case variants on case-insensitive platforms) converge on one lock key through `realpath` resolution.
- Readers never observe a missing or partial target during coordinated replacement: existing targets publish with a single `rename`, new targets with a no-clobber `link`. Verified by the reader-visibility test in `tests/integration/managed-file-concurrency.test.ts`.
- Writers that bypass the coordinator can still interleave after the final pre-publication check. The pre-publication re-check is a detection aid, not compare-and-swap.
- Durability across power loss is not guaranteed without filesystem-specific synchronization.
- Windows real-host behavior (share modes, permission failures, rename-over-open-file) has not been verified on a Windows host. Resource-key normalization is `path.win32`- and case-insensitive-based, but runtime behavior remains unverified.
- NFS, SMB, and special sync folders are not covered by these guarantees.

## Worktree operation

Lock keys are derived from physical paths, not workspace or repository IDs. Separate worktrees of one repository therefore do not contend with each other, even when they share a workspace ID. The global OpenCode configuration group is shared across worktrees of the same user.

## After a partial application or conflict

- `owned_region_conflict`: the managed region changed concurrently. Inspect the target, reconcile manually, and re-run the command.
- `target_deleted`: a previously existing target was removed by another party. Recreate or re-run deliberately; the command does not resurrect it.
- `rollback_conflict` in command results: the command failed after publishing some files. The result lists updated and failed paths. Resolve the conflict and re-run; files whose content already matches the desired result converge to a no-op.
- Leftover `*.managed.tmp` files are owned artifacts of an interrupted publication. They are safe to inspect and delete manually while no managed command is running.

## Measured performance

Micro-benchmark of the coordinator lock and guarded replacement only (no model calls, no primary database). macOS, APFS, Node v26.5.0, 2026-09-07:

| Scenario | Result |
|---|---|
| Lock acquire + release, n=500 sequential | p50 0.21 ms, p95 0.33 ms |
| Lock + guarded replacement of an existing ~4 KiB target, n=200 sequential | p50 6.0 ms, p95 6.5 ms |
| 8 processes, same target, 25 operations each | wall 1.33 s, 0 failures |
| 8 processes, independent roots, 25 operations each | wall 0.93 s, 0 failures |

Regular lock acquisition performs no DML; the lock database holds no business records. These numbers are machine-specific order-of-magnitude references, not guarantees.
