# Database

The first public release is `v0.1.0`. It has one schema migration:
`migrations/001_initial.sql`.

An absent path or an empty SQLite file is initialized with that migration.
Running setup again against the same database verifies the recorded migration
checksum and makes no changes. A pending future migration uses a private
backup, an immediate transaction, and the recorded checksum before committing.

A non-empty file without the current migration history, or with unsupported,
corrupt, or mismatched history, is rejected with `DATABASE_ERROR`. The source
database bytes and OpenCode configuration are left unchanged. Kiokuko does not
recognize, convert, reset, delete, or recover databases from earlier projects.

The SQLite database is the durable source for memory, ledger, Enno-Oduno, and
local embedding state. Workspace JSONL archives and ledger archives accept only
their current `v0.1.0` record contracts; a full SQLite backup is required when
revision history or derived embedding state must be preserved.
