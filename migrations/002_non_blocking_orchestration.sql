-- Kiokuko memory-first, non-blocking orchestration state.
-- This migration is additive except for rebuilding the execution lease table so
-- leases can be owned independently by WorkUnit.

ALTER TABLE enno_execution_leases RENAME TO enno_execution_leases_v1;

CREATE TABLE enno_execution_leases (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (typeof(contract_revision) = 'integer' AND contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (typeof(mutation_revision) = 'integer' AND mutation_revision >= 0),
    work_unit_id TEXT NOT NULL CHECK (length(work_unit_id) BETWEEN 1 AND 256),
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (typeof(attempt) = 'integer' AND attempt BETWEEN 1 AND 20),
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    input_manifest_digest TEXT CHECK (
        input_manifest_digest IS NULL OR (
            length(input_manifest_digest) = 64
            AND input_manifest_digest NOT GLOB '*[^0-9a-f]*'
        )
    ),
    owner_client_kind TEXT NOT NULL CHECK (owner_client_kind = 'opencode'),
    owner_session_id TEXT NOT NULL CHECK (length(owner_session_id) BETWEEN 1 AND 256),
    lease_token_hash TEXT NOT NULL UNIQUE CHECK (
        length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_revision, work_unit_id),
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id)
);

INSERT INTO enno_execution_leases (
    run_id, contract_revision, mutation_revision, work_unit_id, attempt,
    route_epoch, input_manifest_digest, owner_client_kind, owner_session_id,
    lease_token_hash, lease_expires_at, heartbeat_at, created_at, updated_at
)
SELECT
    run_id, contract_revision, mutation_revision, work_unit_id, 1,
    route_epoch, NULL, owner_client_kind, owner_session_id,
    lease_token_hash, lease_expires_at, heartbeat_at, created_at, updated_at
FROM enno_execution_leases_v1;

DROP TABLE enno_execution_leases_v1;

CREATE INDEX idx_enno_execution_leases_owner
    ON enno_execution_leases(run_id, owner_session_id, lease_expires_at);

CREATE TABLE orchestration_jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'semantic_context', 'skill_discovery', 'compaction_meditation',
        'plan_publish', 'memory_promotion'
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

CREATE INDEX idx_orchestration_jobs_ready
    ON orchestration_jobs(state, available_at, created_at);

CREATE TABLE task_context_revisions (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    context_revision INTEGER NOT NULL CHECK (typeof(context_revision) = 'integer' AND context_revision >= 1),
    selection_state_hash TEXT NOT NULL CHECK (
        length(selection_state_hash) = 64 AND selection_state_hash NOT GLOB '*[^0-9a-f]*'
    ),
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, context_revision),
    UNIQUE (run_id, selection_state_hash)
);

CREATE TABLE compaction_cycles (
    cycle_id TEXT PRIMARY KEY,
    client_session_id TEXT NOT NULL CHECK (length(client_session_id) BETWEEN 1 AND 256),
    run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL,
    workspace TEXT,
    contract_revision INTEGER CHECK (contract_revision IS NULL OR contract_revision >= 1),
    context_revision INTEGER CHECK (context_revision IS NULL OR context_revision >= 1),
    route_epoch INTEGER CHECK (route_epoch IS NULL OR route_epoch >= 0),
    through_sequence INTEGER CHECK (through_sequence IS NULL OR through_sequence >= 0),
    terminal_message_id TEXT CHECK (terminal_message_id IS NULL OR length(terminal_message_id) BETWEEN 1 AND 256),
    repository_digest TEXT CHECK (
        repository_digest IS NULL OR (
            length(repository_digest) = 64 AND repository_digest NOT GLOB '*[^0-9a-f]*'
        )
    ),
    boundary_digest TEXT NOT NULL CHECK (
        length(boundary_digest) = 64 AND boundary_digest NOT GLOB '*[^0-9a-f]*'
    ),
    summary_message_id TEXT CHECK (summary_message_id IS NULL OR length(summary_message_id) BETWEEN 1 AND 256),
    summary_digest TEXT CHECK (
        summary_digest IS NULL OR (
            length(summary_digest) = 64 AND summary_digest NOT GLOB '*[^0-9a-f]*'
        )
    ),
    state TEXT NOT NULL CHECK (state IN ('captured', 'compacted', 'queued', 'completed', 'failed')),
    created_at TEXT NOT NULL,
    compacted_at TEXT,
    completed_at TEXT,
    UNIQUE (client_session_id, boundary_digest)
);

CREATE INDEX idx_compaction_cycles_session
    ON compaction_cycles(client_session_id, created_at DESC);

-- Some hosts can deliver the post-compaction event before the pre-compaction
-- hook is observed. Keep only the redacted claim projection and its digest so
-- the later boundary capture can coalesce the pair without retaining a
-- transcript or summary body.
CREATE TABLE compaction_post_events (
    client_session_id TEXT NOT NULL CHECK (length(client_session_id) BETWEEN 1 AND 256),
    summary_digest TEXT NOT NULL CHECK (
        length(summary_digest) = 64 AND summary_digest NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    summary_message_id TEXT CHECK (summary_message_id IS NULL OR length(summary_message_id) BETWEEN 1 AND 256),
    claims_json TEXT NOT NULL CHECK (json_valid(claims_json)),
    bound_cycle_id TEXT REFERENCES compaction_cycles(cycle_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (client_session_id, summary_digest)
);

CREATE INDEX idx_compaction_post_events_pending
    ON compaction_post_events(client_session_id, bound_cycle_id, created_at DESC);

CREATE TABLE meditation_claims (
    claim_id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL REFERENCES compaction_cycles(cycle_id) ON DELETE CASCADE,
    claim_index INTEGER NOT NULL CHECK (typeof(claim_index) = 'integer' AND claim_index >= 0),
    classification TEXT NOT NULL CHECK (classification IN ('supported', 'contradicted', 'unknown')),
    claim_json TEXT NOT NULL CHECK (json_valid(claim_json)),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    claim_digest TEXT NOT NULL CHECK (
        length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    UNIQUE (cycle_id, claim_index),
    UNIQUE (cycle_id, claim_digest)
);

CREATE TABLE meditation_memory_links (
    claim_id TEXT NOT NULL REFERENCES meditation_claims(claim_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    entry_revision INTEGER NOT NULL CHECK (entry_revision >= 1),
    promotion_state TEXT NOT NULL CHECK (promotion_state IN ('candidate', 'verified', 'rejected')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (claim_id, entry_id),
    FOREIGN KEY (entry_id, entry_revision)
        REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE
);

CREATE TABLE enno_plan_artifacts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    plan_digest TEXT NOT NULL CHECK (
        length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
    ),
    relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'failed')),
    error_code TEXT,
    created_at TEXT NOT NULL,
    published_at TEXT,
    PRIMARY KEY (run_id, contract_revision),
    UNIQUE (relative_path)
);

CREATE TABLE enno_work_unit_resources (
    run_id TEXT NOT NULL,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    work_unit_id TEXT NOT NULL,
    resource_key TEXT NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 4096),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('read', 'write', 'quota')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_revision, work_unit_id, resource_key),
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id) ON DELETE CASCADE
);

CREATE INDEX idx_enno_work_unit_resources_key
    ON enno_work_unit_resources(run_id, contract_revision, resource_key, access_mode);

CREATE TABLE enno_work_claim_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, idempotency_key)
);

PRAGMA user_version = 2;
