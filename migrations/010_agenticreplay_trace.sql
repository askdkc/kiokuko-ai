-- AgenticReplay uses an independent store. Preserve historical OrcaReplay rows and migration checksums.
CREATE TABLE agenticreplay_trace_cursors (
 directory TEXT NOT NULL CHECK(length(directory) BETWEEN 1 AND 4096),
 trace_run_id TEXT NOT NULL,
 last_seq INTEGER NOT NULL DEFAULT -1 CHECK(typeof(last_seq)='integer' AND last_seq >= -1),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','unsupported')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 reader_policy_version INTEGER NOT NULL DEFAULT 2,
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 next_byte_offset INTEGER NOT NULL DEFAULT 0 CHECK(next_byte_offset >= 0),
 file_identity_json TEXT CHECK(file_identity_json IS NULL OR json_valid(file_identity_json)),
 manifest_fingerprint TEXT,
 aggregate_json TEXT CHECK(aggregate_json IS NULL OR (json_valid(aggregate_json) AND length(CAST(aggregate_json AS BLOB)) <= 65536)),
 aggregate_digest TEXT,
 finalization TEXT NOT NULL DEFAULT 'recording' CHECK(finalization IN ('recording','ended_pending_manifest','ended_unverified','finalized','blocked','unsupported','source_missing')),
 integrity TEXT NOT NULL DEFAULT 'unavailable' CHECK(integrity IN ('verified','mismatch','unavailable')),
 diagnostic_code TEXT,
 input_fingerprint TEXT,
 last_checked_at TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(directory,trace_run_id)
);

CREATE TABLE agenticreplay_trace_context (
    directory TEXT NOT NULL CHECK (length(directory) BETWEEN 1 AND 4096),
    trace_run_id TEXT NOT NULL CHECK (length(trace_run_id) BETWEEN 4 AND 256),
    digest TEXT NOT NULL CHECK (
        length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    context_json TEXT NOT NULL CHECK (
        json_valid(context_json) AND length(context_json) <= 4096
    ),
    source TEXT NOT NULL CHECK (source = 'agenticreplay'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reader_policy_version INTEGER NOT NULL DEFAULT 2,
    generation INTEGER NOT NULL DEFAULT 1,
    trace_created_at TEXT NOT NULL DEFAULT '',
    finalization TEXT NOT NULL DEFAULT 'recording',
    PRIMARY KEY (directory, trace_run_id),
    UNIQUE (directory, trace_run_id, digest)
);

CREATE TABLE agenticreplay_trace_stores (
 directory TEXT PRIMARY KEY, repository_root TEXT NOT NULL, capture_cwd TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','present','missing','blocked')),
 diagnostic_code TEXT, last_scan_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE agenticreplay_trace_enrichment (
 directory TEXT NOT NULL, trace_run_id TEXT NOT NULL, generation INTEGER NOT NULL, source_digest TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=4096),
 PRIMARY KEY(directory,trace_run_id,generation,source_digest)
);
CREATE INDEX agenticreplay_trace_repository ON agenticreplay_trace_stores(repository_root);
CREATE INDEX agenticreplay_trace_backlog ON agenticreplay_trace_cursors(directory,last_checked_at,trace_run_id);
CREATE TRIGGER agenticreplay_context_byte_insert BEFORE INSERT ON agenticreplay_trace_context
 WHEN length(CAST(NEW.context_json AS BLOB)) > 4096 BEGIN SELECT RAISE(ABORT, 'trace_context_too_large'); END;
CREATE TRIGGER agenticreplay_context_byte_update BEFORE UPDATE ON agenticreplay_trace_context
 WHEN length(CAST(NEW.context_json AS BLOB)) > 4096 BEGIN SELECT RAISE(ABORT, 'trace_context_too_large'); END;
-- Retire unexecuted legacy work; leave completed jobs, user memory and immutable snapshots intact.
UPDATE orchestration_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,
 error_code='trace_recorder_superseded',completed_at=updated_at
 WHERE state IN ('pending','leased','failed','abandoned')
 AND ((kind='trace_ingestion' AND json_extract(payload_json,'$.directory') IN (SELECT directory FROM orcareplay_trace_cursors))
 OR (kind IN ('memory_promotion','skill_discovery') AND json_extract(payload_json,'$.source')='orcareplay'));
PRAGMA user_version = 10;
