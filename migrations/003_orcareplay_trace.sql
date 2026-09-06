-- OrcaReplay trace ingestion state (Orca trace format v0).
-- This migration is additive except for mechanically rebuilding the
-- orchestration job table so its kind CHECK can accept 'trace_ingestion'
-- while preserving every existing row unchanged.

CREATE TABLE orcareplay_trace_cursors (
    directory TEXT NOT NULL CHECK (length(directory) BETWEEN 1 AND 4096),
    trace_run_id TEXT NOT NULL CHECK (length(trace_run_id) BETWEEN 4 AND 256),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_seq) = 'integer' AND last_seq >= 0),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'unsupported')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (directory, trace_run_id)
);

CREATE TABLE orcareplay_trace_context (
    directory TEXT NOT NULL CHECK (length(directory) BETWEEN 1 AND 4096),
    trace_run_id TEXT NOT NULL CHECK (length(trace_run_id) BETWEEN 4 AND 256),
    digest TEXT NOT NULL CHECK (
        length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    context_json TEXT NOT NULL CHECK (
        json_valid(context_json) AND length(context_json) <= 4096
    ),
    source TEXT NOT NULL CHECK (source = 'orcareplay'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (directory, trace_run_id),
    UNIQUE (directory, trace_run_id, digest)
);

ALTER TABLE orchestration_jobs RENAME TO orchestration_jobs_v2;

CREATE TABLE orchestration_jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'semantic_context', 'skill_discovery', 'compaction_meditation',
        'plan_publish', 'memory_promotion', 'trace_ingestion'
    )),
    run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    input_digest TEXT NOT NULL CHECK (
        length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed', 'failed', 'abandoned')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 20),
    available_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    result_digest TEXT CHECK (
        result_digest IS NULL OR (
            length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
        )
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (kind, input_digest),
    CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
);

INSERT INTO orchestration_jobs (
    job_id, kind, run_id, input_digest, payload_json, state, attempts,
    available_at, lease_owner, lease_expires_at, result_digest, error_code,
    created_at, updated_at, completed_at
)
SELECT
    job_id, kind, run_id, input_digest, payload_json, state, attempts,
    available_at, lease_owner, lease_expires_at, result_digest, error_code,
    created_at, updated_at, completed_at
FROM orchestration_jobs_v2;

DROP TABLE orchestration_jobs_v2;

CREATE INDEX idx_orchestration_jobs_ready
    ON orchestration_jobs(state, available_at, created_at);

PRAGMA user_version = 3;
