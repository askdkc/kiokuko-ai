-- Only derived trace state is superseded. Memory and task revision snapshots remain intact.
ALTER TABLE orcareplay_trace_cursors RENAME TO orcareplay_trace_cursors_v1;
CREATE TABLE orcareplay_trace_cursors (
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
INSERT INTO orcareplay_trace_cursors(directory,trace_run_id,last_seq,state,created_at,updated_at,generation)
 SELECT directory,trace_run_id,-1,'active',created_at,updated_at,2 FROM orcareplay_trace_cursors_v1;
DROP TABLE orcareplay_trace_cursors_v1;
ALTER TABLE orcareplay_trace_context ADD COLUMN reader_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orcareplay_trace_context ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orcareplay_trace_context ADD COLUMN trace_created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE orcareplay_trace_context ADD COLUMN finalization TEXT NOT NULL DEFAULT 'recording';
CREATE TRIGGER trace_context_byte_insert BEFORE INSERT ON orcareplay_trace_context
 WHEN length(CAST(NEW.context_json AS BLOB)) > 4096 BEGIN SELECT RAISE(ABORT, 'trace_context_too_large'); END;
CREATE TRIGGER trace_context_byte_update BEFORE UPDATE ON orcareplay_trace_context
 WHEN length(CAST(NEW.context_json AS BLOB)) > 4096 BEGIN SELECT RAISE(ABORT, 'trace_context_too_large'); END;
CREATE TABLE orcareplay_trace_stores (
 directory TEXT PRIMARY KEY, repository_root TEXT NOT NULL, capture_cwd TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','present','missing','blocked')),
 diagnostic_code TEXT, last_scan_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX trace_store_repository ON orcareplay_trace_stores(repository_root);
CREATE INDEX trace_backlog ON orcareplay_trace_cursors(directory,last_checked_at,trace_run_id);
-- Old candidate approvals cannot be reused as current-generation evidence.
UPDATE orchestration_jobs SET state='completed', lease_owner=NULL, lease_expires_at=NULL,
 error_code='trace_policy_superseded', completed_at=updated_at
 WHERE kind='trace_ingestion' OR (kind='memory_promotion' AND json_extract(payload_json,'$.source')='orcareplay');
CREATE TABLE orcareplay_trace_enrichment (
 directory TEXT NOT NULL, trace_run_id TEXT NOT NULL, generation INTEGER NOT NULL, source_digest TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=4096),
 PRIMARY KEY(directory,trace_run_id,generation,source_digest)
);
PRAGMA user_version = 4;
