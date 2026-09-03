# Database

`v0.2.0-alpha.1` intentionally resets the alpha database contract. It has one
fresh schema migration: `migrations/001_initial.sql`, with `user_version = 1`.

An absent path or an empty SQLite file is initialized with that migration.
Running setup again against the same database verifies the recorded migration
checksum and makes no changes. This release has no in-place upgrade path and
does not create an upgrade backup.

A non-empty file without the current migration history, or with unsupported,
corrupt, or mismatched history, is rejected with `DATABASE_ERROR`. The source
database bytes and OpenCode configuration are left unchanged. Kiokuko does not
recognize, convert, reset, delete, or recover databases from earlier projects.

The SQLite database is the durable source for memory, ledger, Enno-Oduno, and
local embedding state. Workspace JSONL archives and ledger archives accept only
their current record contracts. Use the explicit `kiokuko-ai backup` command
when revision history or derived embedding state must be preserved.
