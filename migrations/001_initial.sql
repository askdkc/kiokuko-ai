-- Kiokuko v0.2.0-alpha.1 initial schema; migration metadata is created by the runtime.

PRAGMA application_id = 0x4B494F4B;
PRAGMA user_version = 1;

-- table task_skill_discovery_attempts
CREATE TABLE task_skill_discovery_attempts (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('intake', 'zenki')),
    request_digest TEXT NOT NULL CHECK (
        typeof(request_digest) = 'text'
        AND length(request_digest) = 64
        AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    reserved_query_count INTEGER NOT NULL CHECK (typeof(reserved_query_count) = 'integer' AND reserved_query_count BETWEEN 0 AND 3),
    reserved_selection_count INTEGER NOT NULL CHECK (typeof(reserved_selection_count) = 'integer' AND reserved_selection_count BETWEEN 0 AND 2),
    consumed_query_count INTEGER NOT NULL CHECK (typeof(consumed_query_count) = 'integer' AND consumed_query_count BETWEEN 0 AND 3),
    consumed_selection_count INTEGER NOT NULL CHECK (typeof(consumed_selection_count) = 'integer' AND consumed_selection_count BETWEEN 0 AND 2),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
    summary_json TEXT,
    failure_json TEXT,
    started_at TEXT NOT NULL CHECK (typeof(started_at) = 'text' AND length(started_at) > 0),
    finished_at TEXT,
    PRIMARY KEY (run_id, phase, request_digest),
    CHECK (consumed_query_count <= reserved_query_count),
    CHECK (consumed_selection_count <= reserved_selection_count),
    CHECK (
        finished_at IS NULL
        OR (typeof(finished_at) = 'text' AND length(finished_at) > 0 AND finished_at >= started_at)
    ),
    CHECK (
        (state = 'started'
            AND consumed_query_count = 0
            AND consumed_selection_count = 0
            AND summary_json IS NULL
            AND failure_json IS NULL
            AND finished_at IS NULL)
        OR (state = 'completed' AND typeof(summary_json) = 'text' AND failure_json IS NULL AND finished_at IS NOT NULL)
        OR (state = 'failed' AND summary_json IS NULL AND typeof(failure_json) = 'text' AND finished_at IS NOT NULL)
    )
);

-- table akinator_answers
CREATE TABLE akinator_answers (
    session_id TEXT NOT NULL REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, question_id)
);

-- table akinator_reasoning_paths
CREATE TABLE akinator_reasoning_paths (
    path_id TEXT PRIMARY KEY,
    concept_key TEXT NOT NULL CHECK (
        length(concept_key) = 64
        AND concept_key NOT GLOB '*[^0-9a-f]*'
    ),
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    intake_session_id TEXT NOT NULL REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    task_type TEXT NOT NULL,
    intent TEXT NOT NULL,
    hypotheses_json TEXT NOT NULL,
    question_path_json TEXT NOT NULL,
    selected_action TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    stop_conditions_json TEXT NOT NULL,
    silo_completeness REAL NOT NULL CHECK (silo_completeness >= 0 AND silo_completeness <= 1),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'interrupted')),
    qualified INTEGER NOT NULL CHECK (qualified IN (0, 1)),
    disqualification_reasons_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, entry_id, entry_revision)
);

-- table akinator_sessions
CREATE TABLE akinator_sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    task_text TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ready', 'exhausted')),
    question_count INTEGER NOT NULL DEFAULT 0 CHECK (question_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- table audit_events
CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entries(id),
    workspace TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (
        operation IN ('record', 'promote', 'supersede', 'link', 'import', 'purge')
    ),
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

-- table context_deliveries
CREATE TABLE context_deliveries (
    delivery_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
    intake_session_id TEXT REFERENCES akinator_sessions(id),
    task_profile_hash TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    external_sync_summary_json TEXT NOT NULL,
    char_budget INTEGER NOT NULL CHECK (char_budget >= 0),
    char_count INTEGER NOT NULL CHECK (char_count >= 0 AND char_count <= char_budget),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    created_at TEXT NOT NULL,
    score_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (score_schema_version IN (1, 2))
);

-- table context_delivery_entries
CREATE TABLE "context_delivery_entries" (
    delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    rank INTEGER NOT NULL CHECK (rank > 0),
    score_components_json TEXT NOT NULL,
    selection_reason_json TEXT NOT NULL,
    origin_scope TEXT NOT NULL DEFAULT 'project' CHECK (origin_scope IN ('project', 'ecosystem', 'global')),
    PRIMARY KEY (delivery_id, entry_id),
    FOREIGN KEY (entry_id, entry_revision)
        REFERENCES entry_revisions(entry_id, revision)
);

-- table context_feedback
CREATE TABLE context_feedback (
    feedback_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN ('helpful', 'irrelevant', 'stale', 'conflicting')),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key)
);

-- table embedding_jobs
CREATE TABLE "embedding_jobs" (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES "embedding_profiles"(profile_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'failed', 'blocked')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    lease_id TEXT,
    lease_expires_at TEXT,
    error_code TEXT CHECK (error_code IS NULL OR error_code IN (
        'timeout', 'rate_limited', 'provider_unavailable', 'invalid_response',
        'dimension_mismatch', 'secret_blocked', 'profile_changed', 'entry_changed'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, profile_id),
    FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE,
    CHECK (
        (state = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_id IS NULL AND lease_expires_at IS NULL)
    )
);

-- table embedding_model_installations
CREATE TABLE embedding_model_installations (
    installation_id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    artifact_manifest_hash TEXT NOT NULL CHECK (length(artifact_manifest_hash) = 64 AND artifact_manifest_hash NOT GLOB '*[^0-9a-f]*'),
    relative_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staging', 'verified', 'corrupt', 'missing')),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    installed_at TEXT NOT NULL,
    verified_at TEXT,
    last_checked_at TEXT NOT NULL
);

-- table embedding_profiles
CREATE TABLE "embedding_profiles" (
    profile_id TEXT PRIMARY KEY
        CHECK (length(profile_id) = 64 AND profile_id NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    provider_kind TEXT NOT NULL
        CHECK (provider_kind = 'local-transformers'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
    distance_ceiling REAL NOT NULL CHECK (distance_ceiling > 0.0 AND distance_ceiling < 2.0),
    document_template_version INTEGER NOT NULL CHECK (document_template_version > 0),
    query_template_version INTEGER NOT NULL CHECK (query_template_version > 0),
    preset_id TEXT,
    source_model TEXT,
    artifact_repository TEXT,
    model_revision TEXT,
    artifact_manifest_hash TEXT
        CHECK (artifact_manifest_hash IS NULL OR (length(artifact_manifest_hash) = 64 AND artifact_manifest_hash NOT GLOB '*[^0-9a-f]*')),
    inference_engine TEXT,
    inference_engine_version TEXT,
    dtype TEXT,
    pooling TEXT,
    normalize INTEGER CHECK (normalize IS NULL OR normalize IN (0, 1)),
    maximum_tokens INTEGER CHECK (maximum_tokens IS NULL OR maximum_tokens > 0),
    input_contract TEXT,
    query_prefix TEXT,
    document_prefix TEXT,
    created_at TEXT NOT NULL,
    CHECK (
        (schema_version = 1 AND provider_kind = 'local-transformers'
            AND preset_id IS NOT NULL AND source_model IS NOT NULL
            AND artifact_repository IS NOT NULL AND model_revision IS NOT NULL
            AND artifact_manifest_hash IS NOT NULL AND inference_engine IS NOT NULL
            AND inference_engine_version IS NOT NULL AND dtype IS NOT NULL
            AND pooling IS NOT NULL AND normalize IS NOT NULL
            AND maximum_tokens IS NOT NULL AND input_contract IS NOT NULL
            AND query_prefix IS NOT NULL AND document_prefix IS NOT NULL)
    )
);

-- table embedding_runtime
CREATE TABLE "embedding_runtime" (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_profile_id TEXT REFERENCES "embedding_profiles"(profile_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    activated_at TEXT
);

-- table embedding_settings
CREATE TABLE embedding_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    mode TEXT NOT NULL CHECK (mode IN ('off', 'optional', 'required')),
    provider_kind TEXT CHECK (provider_kind IS NULL OR provider_kind = 'local-transformers'),
    preset_id TEXT,
    model_installation_id TEXT REFERENCES embedding_model_installations(installation_id),
    vector_backend TEXT NOT NULL CHECK (vector_backend IN ('auto', 'javascript', 'sqlite-vec')),
    batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 64),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 120000),
    setup_state TEXT NOT NULL CHECK (setup_state IN ('disabled', 'requires_setup', 'installing', 'ready', 'degraded')),
    updated_at TEXT NOT NULL
);

-- table embedding_setup_runs
CREATE TABLE embedding_setup_runs (
    setup_id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('planned', 'downloading', 'verifying', 'probing', 'activating', 'embedding', 'completed', 'failed')),
    model_installation_id TEXT REFERENCES embedding_model_installations(installation_id),
    active_profile_id TEXT REFERENCES embedding_profiles(profile_id),
    initial_entry_count INTEGER NOT NULL CHECK (initial_entry_count >= 0),
    processed_entry_count INTEGER NOT NULL CHECK (processed_entry_count >= 0),
    failure_code TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

-- table enno_advisory_contributions
CREATE TABLE "enno_advisory_contributions" (
    round_id TEXT NOT NULL REFERENCES "enno_advisory_rounds"(round_id) ON DELETE CASCADE,
    slot_id TEXT NOT NULL CHECK (length(slot_id) BETWEEN 1 AND 100),
    slot_rank INTEGER NOT NULL CHECK (
        typeof(slot_rank) = 'integer' AND slot_rank BETWEEN 0 AND 2
    ),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'timeout', 'unavailable')),
    contribution_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (round_id, slot_id),
    UNIQUE (round_id, slot_rank)
);

-- table enno_advisory_rounds
CREATE TABLE "enno_advisory_rounds" (
    round_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (
        typeof(contract_revision) = 'integer' AND contract_revision >= 1
    ),
    mutation_revision INTEGER NOT NULL CHECK (
        typeof(mutation_revision) = 'integer' AND mutation_revision >= 0
    ),
    phase TEXT NOT NULL CHECK (phase IN ('ideal', 'planning', 'final_review')),
    input_digest TEXT NOT NULL CHECK (
        length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
    ),
    policy_version INTEGER NOT NULL CHECK (
        typeof(policy_version) = 'integer' AND policy_version = 1
    ),
    source TEXT NOT NULL CHECK (source = 'host_reported'),
    state TEXT NOT NULL CHECK (state IN ('advice_submitted', 'aggregated', 'consumed')),
    degraded INTEGER NOT NULL CHECK (typeof(degraded) = 'integer' AND degraded IN (0, 1)),
    aggregate_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, contract_revision, mutation_revision, phase, input_digest)
);

-- table enno_opencode_continuations
CREATE TABLE enno_opencode_continuations (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    client_kind TEXT NOT NULL CHECK (client_kind = 'opencode'),
    source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 256),
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (mutation_revision >= 0),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 20),
    directive_digest TEXT NOT NULL CHECK (
        length(directive_digest) = 64 AND directive_digest NOT GLOB '*[^0-9a-f]*'
    ),
    continuation_count INTEGER NOT NULL CHECK (continuation_count BETWEEN 0 AND 20),
    total_count INTEGER NOT NULL CHECK (total_count BETWEEN 0 AND 20),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, client_kind, source_session_id)
);

-- table enno_opencode_continuation_receipts
CREATE TABLE enno_opencode_continuation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    client_kind TEXT NOT NULL CHECK (client_kind = 'opencode'),
    source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 256),
    source_terminal_hash TEXT NOT NULL CHECK (
        length(source_terminal_hash) = 64
        AND source_terminal_hash NOT GLOB '*[^0-9a-f]*'
    ),
    contract_revision INTEGER NOT NULL CHECK (typeof(contract_revision) = 'integer' AND contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (typeof(mutation_revision) = 'integer' AND mutation_revision >= 0),
    attempts INTEGER NOT NULL CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 20),
    directive_digest TEXT NOT NULL CHECK (
        length(directive_digest) = 64
        AND directive_digest NOT GLOB '*[^0-9a-f]*'
    ),
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, client_kind, source_session_id, source_terminal_hash)
);

-- table enno_contracts
CREATE TABLE enno_contracts (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    orchestration_session_id TEXT NOT NULL CHECK (length(orchestration_session_id) BETWEEN 1 AND 256),
    client_kind TEXT CHECK (client_kind IS NULL OR client_kind = 'opencode'),
    client_version TEXT CHECK (client_version IS NULL OR length(client_version) BETWEEN 1 AND 100),
    client_session_id TEXT CHECK (client_session_id IS NULL OR length(client_session_id) BETWEEN 1 AND 256),
    repository_root TEXT NOT NULL CHECK (length(repository_root) BETWEEN 1 AND 4096),
    task_type TEXT NOT NULL CHECK (task_type IN ('build', 'debug', 'review', 'devops')),
    status TEXT NOT NULL CHECK (status IN (
        'intake', 'zenki_planning', 'needs_confirmation', 'goki_executing',
        'enno_verifying', 'completed', 'blocked', 'cancelled'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    confirmation_state TEXT NOT NULL CHECK (confirmation_state IN (
        'not_required', 'pending', 'approved', 'revision_requested', 'cancelled'
    )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
    mutation_revision INTEGER NOT NULL DEFAULT 0 CHECK (mutation_revision >= 0),
    contract_json TEXT NOT NULL,
    handoff_json TEXT NOT NULL,
    intake_discovery_json TEXT NOT NULL,
    plan_digest TEXT,
    blocker TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, phase TEXT CHECK (phase IS NULL OR phase IN ('oduno_ideal', 'oduno_meditation')), ideal_json TEXT, meditation_json TEXT, route_epoch INTEGER NOT NULL DEFAULT 0
CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    UNIQUE (run_id, workspace, orchestration_session_id),
    CHECK ((client_version IS NULL AND client_session_id IS NULL) OR client_kind IS NOT NULL)
);

-- table enno_execution_leases
CREATE TABLE enno_execution_leases (
    run_id TEXT PRIMARY KEY REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (typeof(contract_revision) = 'integer' AND contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (typeof(mutation_revision) = 'integer' AND mutation_revision >= 0),
    work_unit_id TEXT NOT NULL CHECK (length(work_unit_id) BETWEEN 1 AND 256),
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    owner_client_kind TEXT NOT NULL CHECK (owner_client_kind = 'opencode'),
    owner_session_id TEXT NOT NULL CHECK (length(owner_session_id) BETWEEN 1 AND 256),
    lease_token_hash TEXT NOT NULL UNIQUE CHECK (
        length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id)
);

-- table enno_operation_receipts
CREATE TABLE enno_operation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN (
        'ideal_submit', 'advice_submit', 'plan_submit', 'answer', 'work_report',
        'finish', 'meditation_submit', 'verify_prepare'
    )),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed', 'abandoned')),
    response_json TEXT,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK (
        (state = 'started' AND response_json IS NULL AND finished_at IS NULL
          AND typeof(owner_nonce) = 'text' AND typeof(lease_expires_at) = 'text' AND typeof(heartbeat_at) = 'text')
        OR (state = 'completed' AND typeof(response_json) = 'text' AND finished_at IS NOT NULL)
        OR (state IN ('failed', 'abandoned') AND response_json IS NULL AND finished_at IS NOT NULL
          AND typeof(failure_code) = 'text')
    ),
    PRIMARY KEY (run_id, operation, idempotency_key)
);

-- table enno_resume_tokens
CREATE TABLE enno_resume_tokens (
    token_hash TEXT PRIMARY KEY CHECK (
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    repository_root TEXT NOT NULL,
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    client_kind TEXT NOT NULL CHECK (client_kind = 'opencode'),
    client_session_id TEXT NOT NULL CHECK (length(client_session_id) BETWEEN 1 AND 256),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- table enno_verifier_runs
CREATE TABLE enno_verifier_runs (
    verifier_run_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    work_unit_id TEXT,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (mutation_revision >= 0),
    verifier_id TEXT NOT NULL CHECK (length(verifier_id) BETWEEN 1 AND 256),
    verifier_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'passed', 'failed', 'timeout', 'spawn_failed', 'abandoned')),
    exit_code INTEGER,
    signal TEXT,
    duration_ms INTEGER,
    stdout_preview TEXT,
    stderr_preview TEXT,
    stdout_digest TEXT,
    stderr_digest TEXT,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    failure_code TEXT,
    repository_state_policy_version INTEGER,
    pre_repository_digest TEXT,
    post_repository_digest TEXT,
    verifier_spec_digest TEXT,
    changed_during_verification INTEGER CHECK (changed_during_verification IS NULL OR changed_during_verification IN (0, 1)),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id),
    CHECK (
        (status = 'started' AND finished_at IS NULL AND duration_ms IS NULL
          AND typeof(owner_nonce) = 'text' AND typeof(lease_expires_at) = 'text' AND typeof(heartbeat_at) = 'text')
        OR (status = 'abandoned' AND finished_at IS NOT NULL AND typeof(failure_code) = 'text')
        OR (status NOT IN ('started', 'abandoned') AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms >= 0)
    )
);

-- table enno_work_units
CREATE TABLE enno_work_units (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    work_unit_id TEXT NOT NULL CHECK (length(work_unit_id) BETWEEN 1 AND 256),
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    order_index INTEGER NOT NULL CHECK (order_index >= 0),
    work_unit_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_revision, work_unit_id),
    UNIQUE (run_id, contract_revision, order_index)
);

-- table entries
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('candidate', 'verified', 'superseded')
    ),
    trust_level TEXT NOT NULL DEFAULT 'user_asserted' CHECK (
        trust_level IN ('untrusted', 'user_asserted', 'source_verified', 'system_verified')
    ),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    current_revision INTEGER NOT NULL CHECK (current_revision > 0),
    superseded_by TEXT REFERENCES entries(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT,
    CHECK (status != 'superseded' OR superseded_by IS NOT NULL)
);

-- table entries_fts
CREATE VIRTUAL TABLE entries_fts USING fts5(
    title,
    body,
    summary,
    tags_text,
    content='entry_search_documents',
    content_rowid='entry_rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- table entries_trigram
CREATE VIRTUAL TABLE entries_trigram USING fts5(
    title,
    body,
    summary,
    tags_text,
    content='entry_search_documents',
    content_rowid='entry_rowid',
    tokenize='trigram'
);

-- table entry_embeddings
CREATE TABLE "entry_embeddings" (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES "embedding_profiles"(profile_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL CHECK (length(document_hash) = 64 AND document_hash NOT GLOB '*[^0-9a-f]*'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    embedding BLOB NOT NULL,
    vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64 AND vector_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, profile_id),
    FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE,
    CHECK (length(embedding) = dimensions * 4)
);

-- table entry_links
CREATE TABLE entry_links (
    from_entry_id TEXT NOT NULL REFERENCES entries(id),
    to_entry_id TEXT NOT NULL REFERENCES entries(id),
    relation TEXT NOT NULL CHECK (
        relation IN ('supports', 'contradicts', 'derived_from', 'related_to')
    ),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (from_entry_id, to_entry_id, relation)
);

-- table entry_revision_hash_format
CREATE TABLE entry_revision_hash_format (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    algorithm TEXT NOT NULL CHECK (algorithm = 'canonical-json-utf16-tags-v1')
);

-- table entry_revision_tags
CREATE TABLE entry_revision_tags (
    entry_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, revision, tag),
    FOREIGN KEY (entry_id, revision)
        REFERENCES entry_revisions(entry_id, revision)
        ON DELETE CASCADE
);

-- table entry_revisions
CREATE TABLE entry_revisions (
    entry_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (
        kind IN ('fact', 'decision', 'lesson', 'preference', 'reference')
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT,
    scope_json TEXT NOT NULL DEFAULT '{}',
    provenance_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, revision),
    FOREIGN KEY (entry_id, workspace)
        REFERENCES entries(id, workspace)
        ON DELETE CASCADE
);

-- table entry_search_documents
CREATE TABLE entry_search_documents (
    entry_rowid INTEGER PRIMARY KEY CHECK (entry_rowid > 0),
    entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_text TEXT NOT NULL
);

-- table entry_search_signals
CREATE TABLE entry_search_signals (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (
        signal_type IN ('language', 'framework', 'runtime', 'database', 'tool',
                        'platform', 'package', 'symbol', 'path', 'error', 'command', 'tag')
    ),
    normalized_value TEXT NOT NULL,
    PRIMARY KEY (entry_id, signal_type, normalized_value)
);

-- table external_skill_entries
CREATE TABLE external_skill_entries (
    skill_id TEXT NOT NULL REFERENCES external_skills(skill_id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    entry_id TEXT NOT NULL REFERENCES entries(id),
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    content_hash TEXT NOT NULL,
    primary_document INTEGER NOT NULL DEFAULT 0 CHECK (primary_document IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    imported_at TEXT NOT NULL,
    PRIMARY KEY(skill_id, source_path, chunk_index),
    FOREIGN KEY(entry_id, entry_revision) REFERENCES entry_revisions(entry_id, revision)
);

-- table external_skill_generation_clock
CREATE TABLE external_skill_generation_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN 0 AND 9007199254740991)
);

-- table external_skill_generation_tokens
CREATE TABLE external_skill_generation_tokens (
    generation INTEGER PRIMARY KEY AUTOINCREMENT
        CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991)
);

-- table external_skills
CREATE TABLE external_skills (
    skill_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL REFERENCES external_skill_generation_tokens(generation)
        CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    install_url TEXT,
    official_status TEXT NOT NULL CHECK (official_status IN ('curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown')),
    duplicate INTEGER NOT NULL DEFAULT 0 CHECK (duplicate IN (0, 1)),
    installs INTEGER NOT NULL DEFAULT 0 CHECK (installs >= 0),
    state TEXT NOT NULL CHECK (state IN ('discovered', 'imported', 'blocked', 'stale', 'disabled')),
    source_workspace TEXT NOT NULL,
    source_commit TEXT,
    snapshot_hash TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    disabled_at TEXT,
    UNIQUE(generation),
    UNIQUE(source_type, source_locator, slug)
);

-- table task_request_receipts
CREATE TABLE task_request_receipts (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (
        length(key_hash) = 64
        AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64
        AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, key_hash)
);

-- table intake_feedback
CREATE TABLE intake_feedback (
    feedback_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES akinator_sessions(id),
    question_id TEXT,
    profile_field TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('helpful', 'unnecessary', 'corrected')),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key),
    CHECK ((question_id IS NOT NULL) <> (profile_field IS NOT NULL))
);

-- table knowledge_sources
CREATE TABLE knowledge_sources (
    source_id TEXT PRIMARY KEY,
    repository_url TEXT NOT NULL UNIQUE,
    ref_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL
);

-- table ledger_events
CREATE TABLE ledger_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    source_event_id TEXT,
    source_sequence INTEGER,
    event_type TEXT NOT NULL,
    source_type TEXT,
    actor TEXT NOT NULL,
    outcome TEXT,
    occurred_at TEXT,
    ingested_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    redaction_json TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    UNIQUE (run_id, sequence)
);

-- table ledger_evidence
CREATE TABLE ledger_evidence (
    evidence_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('command', 'test', 'file', 'diff', 'url', 'artifact')),
    locator TEXT NOT NULL,
    digest_algorithm TEXT,
    digest TEXT,
    byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
    summary TEXT,
    created_at TEXT NOT NULL
);

-- table ledger_memory_links
CREATE TABLE ledger_memory_links (
    link_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    delivery_id TEXT REFERENCES context_deliveries(delivery_id) ON DELETE SET NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    created_at TEXT NOT NULL,
    CHECK (event_id IS NOT NULL OR delivery_id IS NOT NULL)
);

-- table ledger_purge_audit
CREATE TABLE ledger_purge_audit (
    purge_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    delivery_id TEXT REFERENCES context_deliveries(delivery_id) ON DELETE SET NULL,
    entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('run', 'event', 'evidence', 'delivery', 'feedback', 'memory_link')),
    target_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
);

-- table ledger_runs
CREATE TABLE ledger_runs (
    run_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    client_kind TEXT NOT NULL CHECK (client_kind = 'opencode'),
    client_version TEXT,
    source_session_id TEXT,
    parent_run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL,
    protocol_version TEXT NOT NULL,
    capture_profile TEXT NOT NULL,
    coverage_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('intake', 'active', 'completed', 'failed', 'cancelled', 'interrupted')
    ),
    title TEXT,
    task_hash TEXT,
    metadata_json TEXT NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    last_source_sequence INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- table nudge_deliveries
CREATE TABLE nudge_deliveries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 100),
    code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
    occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
    checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) BETWEEN 1 AND 256),
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
    priority INTEGER NOT NULL CHECK (priority >= 1),
    evidence_event_ids_json TEXT NOT NULL CHECK (json_valid(evidence_event_ids_json)),
    reference_ids_json TEXT NOT NULL CHECK (json_valid(reference_ids_json)),
    delivered_at TEXT NOT NULL,

    FOREIGN KEY (run_id)
        REFERENCES ledger_runs(run_id)
        ON DELETE CASCADE,

    UNIQUE (
        run_id,
        policy_version,
        occurrence_id
    ),

    UNIQUE (
        run_id,
        policy_version,
        checkpoint_id
    )
);

-- table query_embeddings
CREATE TABLE "query_embeddings" (
    profile_id TEXT NOT NULL REFERENCES "embedding_profiles"(profile_id) ON DELETE CASCADE,
    query_hash TEXT NOT NULL CHECK (length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    embedding BLOB NOT NULL,
    vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64 AND vector_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, query_hash),
    CHECK (length(embedding) = dimensions * 4)
);

-- table repositories
CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    remote_fingerprint TEXT,
    binding_schema_version INTEGER NOT NULL,
    agent_template_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

-- table repository_fingerprints
CREATE TABLE repository_fingerprints (
    repository_id TEXT PRIMARY KEY
        REFERENCES repositories(repository_id)
        ON DELETE CASCADE,
    fingerprint_json TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- table repository_locations
CREATE TABLE repository_locations (
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    canonical_root TEXT NOT NULL UNIQUE,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (repository_id, canonical_root)
);

-- table run_feedback
CREATE TABLE run_feedback (
    feedback_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    outcome TEXT,
    recommendation_code TEXT,
    recommendation_verdict TEXT CHECK (recommendation_verdict IS NULL OR recommendation_verdict IN ('accepted', 'dismissed', 'resolved')),
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key)
);

-- table run_intakes
CREATE TABLE run_intakes (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES akinator_sessions(id),
    policy_version TEXT NOT NULL,
    profile_schema_version INTEGER NOT NULL CHECK (profile_schema_version > 0),
    profile_sources_json TEXT NOT NULL,
    initial_profile_hash TEXT,
    recommended_tags_json TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    finalized_at TEXT
);

-- table skill_audit_failure_cache
CREATE TABLE skill_audit_failure_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('registry_rate_limited', 'registry_unavailable')),
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- table skill_discovery_cache
CREATE TABLE skill_discovery_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    query_text TEXT NOT NULL,
    owner TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('official', 'community')),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'empty', 'rate_limited', 'unavailable')),
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- table skill_source_failure_cache
CREATE TABLE skill_source_failure_cache (
    cache_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('source_rate_limited', 'source_unavailable')),
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- index idx_akinator_reasoning_paths_concept
CREATE INDEX idx_akinator_reasoning_paths_concept
    ON akinator_reasoning_paths(concept_key, qualified, created_at DESC);

-- index idx_akinator_reasoning_paths_entry
CREATE INDEX idx_akinator_reasoning_paths_entry
    ON akinator_reasoning_paths(entry_id, entry_revision, created_at DESC);

-- index idx_akinator_sessions_workspace
CREATE INDEX idx_akinator_sessions_workspace
    ON akinator_sessions(workspace, updated_at DESC);

-- index idx_context_deliveries_run_created_at
CREATE INDEX idx_context_deliveries_run_created_at
    ON context_deliveries(run_id, created_at DESC);

-- index idx_context_delivery_entries_entry
CREATE INDEX idx_context_delivery_entries_entry
    ON context_delivery_entries(entry_id, entry_revision);

-- index idx_context_feedback_run
CREATE INDEX idx_context_feedback_run
    ON context_feedback(run_id, created_at DESC);

-- index idx_embedding_jobs_claim
CREATE INDEX idx_embedding_jobs_claim
    ON embedding_jobs(profile_id, state, available_at, entry_id);

-- index idx_enno_advisory_contributions_round
CREATE INDEX idx_enno_advisory_contributions_round
ON enno_advisory_contributions(round_id, slot_rank);

-- index idx_enno_advisory_rounds_current
CREATE INDEX idx_enno_advisory_rounds_current
ON enno_advisory_rounds(run_id, contract_revision, mutation_revision, phase, state);

-- index idx_enno_opencode_continuation_receipts_session
CREATE INDEX idx_enno_opencode_continuation_receipts_session
    ON enno_opencode_continuation_receipts(run_id, client_kind, source_session_id, created_at);

-- index idx_enno_contracts_session_status
CREATE INDEX idx_enno_contracts_session_status
ON enno_contracts(client_kind, client_session_id, status, updated_at DESC);

-- index idx_enno_resume_tokens_run_epoch
CREATE INDEX idx_enno_resume_tokens_run_epoch
ON enno_resume_tokens(run_id, route_epoch, expires_at);

-- index idx_enno_verifier_runs_freshness
CREATE INDEX idx_enno_verifier_runs_freshness
ON enno_verifier_runs(run_id, contract_revision, mutation_revision, status, finished_at DESC);

-- index idx_enno_verifier_runs_lease
CREATE INDEX idx_enno_verifier_runs_lease
ON enno_verifier_runs(run_id, status, lease_expires_at);

-- index idx_entries_id_workspace
CREATE UNIQUE INDEX idx_entries_id_workspace
    ON entries(id, workspace);

-- index idx_entries_workspace_status
CREATE INDEX idx_entries_workspace_status
    ON entries(workspace, status, updated_at DESC);

-- index idx_entry_embeddings_profile_revision
CREATE INDEX idx_entry_embeddings_profile_revision
    ON entry_embeddings(profile_id, entry_id, revision);

-- index idx_entry_revision_tags_tag
CREATE INDEX idx_entry_revision_tags_tag
    ON entry_revision_tags(tag, entry_id, revision);

-- index idx_entry_revisions_entry_created
CREATE INDEX idx_entry_revisions_entry_created
    ON entry_revisions(entry_id, revision DESC);

-- index idx_entry_revisions_workspace_hash
CREATE UNIQUE INDEX idx_entry_revisions_workspace_hash
    ON entry_revisions(workspace, content_hash);

-- index idx_entry_search_signals_lookup
CREATE INDEX idx_entry_search_signals_lookup
    ON entry_search_signals(signal_type, normalized_value);

-- index idx_entry_search_signals_type_value_entry
CREATE INDEX idx_entry_search_signals_type_value_entry
    ON entry_search_signals(signal_type, normalized_value, entry_id);

-- index idx_external_skill_entries_entry
CREATE INDEX idx_external_skill_entries_entry ON external_skill_entries(entry_id, entry_revision);

-- index idx_external_skills_source
CREATE INDEX idx_external_skills_source ON external_skills(source_locator, slug);

-- index idx_external_skills_state_checked
CREATE INDEX idx_external_skills_state_checked ON external_skills(state, last_checked_at DESC);

-- index idx_task_request_receipts_created_at
CREATE INDEX idx_task_request_receipts_created_at
    ON task_request_receipts(created_at);

-- index idx_intake_feedback_run_created_at
CREATE INDEX idx_intake_feedback_run_created_at
    ON intake_feedback(run_id, created_at DESC);

-- index idx_ledger_events_run_sequence
CREATE INDEX idx_ledger_events_run_sequence
    ON ledger_events(run_id, sequence);

-- index idx_ledger_events_run_source
CREATE UNIQUE INDEX idx_ledger_events_run_source
    ON ledger_events(run_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

-- index idx_ledger_evidence_run_created_at
CREATE INDEX idx_ledger_evidence_run_created_at
    ON ledger_evidence(run_id, created_at DESC);

-- index idx_ledger_memory_links_entry
CREATE INDEX idx_ledger_memory_links_entry
    ON ledger_memory_links(entry_id);

-- index idx_ledger_memory_links_run
CREATE INDEX idx_ledger_memory_links_run
    ON ledger_memory_links(run_id, created_at DESC);

-- index idx_ledger_purge_audit_target
CREATE INDEX idx_ledger_purge_audit_target
    ON ledger_purge_audit(target_type, target_id);

-- index idx_ledger_runs_parent
CREATE INDEX idx_ledger_runs_parent
    ON ledger_runs(parent_run_id);

-- index idx_ledger_runs_workspace_status_created_at
CREATE INDEX idx_ledger_runs_workspace_status_created_at
    ON ledger_runs(workspace, status, created_at DESC);

-- index idx_query_embeddings_lru
CREATE INDEX idx_query_embeddings_lru
    ON query_embeddings(profile_id, last_used_at, query_hash);

-- index idx_run_feedback_run_created_at
CREATE INDEX idx_run_feedback_run_created_at
    ON run_feedback(run_id, created_at DESC);

-- index idx_run_intakes_session
CREATE INDEX idx_run_intakes_session
    ON run_intakes(session_id);

-- index idx_skill_audit_failure_cache_expiry
CREATE INDEX idx_skill_audit_failure_cache_expiry ON skill_audit_failure_cache(expires_at);

-- index idx_skill_discovery_attempts_active
CREATE UNIQUE INDEX idx_skill_discovery_attempts_active
ON task_skill_discovery_attempts(run_id, phase)
WHERE state = 'started';

-- index idx_skill_discovery_cache_expiry
CREATE INDEX idx_skill_discovery_cache_expiry ON skill_discovery_cache(expires_at);

-- index idx_skill_source_failure_cache_expiry
CREATE INDEX idx_skill_source_failure_cache_expiry ON skill_source_failure_cache(expires_at);

-- index nudge_deliveries_run_checkpoint
CREATE INDEX nudge_deliveries_run_checkpoint
ON nudge_deliveries (
    run_id,
    policy_version,
    checkpoint_id
);

-- index nudge_deliveries_run_code_sequence
CREATE INDEX nudge_deliveries_run_code_sequence
ON nudge_deliveries (
    run_id,
    policy_version,
    code,
    through_sequence
);

-- index nudge_deliveries_run_sequence
CREATE INDEX nudge_deliveries_run_sequence
ON nudge_deliveries (
    run_id,
    through_sequence
);

-- trigger akinator_reasoning_paths_link_guard
CREATE TRIGGER akinator_reasoning_paths_link_guard
BEFORE INSERT ON akinator_reasoning_paths
BEGIN
    SELECT RAISE(ABORT, 'akinator reasoning path link mismatch')
    WHERE NOT EXISTS (
        SELECT 1
          FROM run_intakes AS ri
          JOIN ledger_runs AS lr ON lr.run_id = ri.run_id
          JOIN akinator_sessions AS a ON a.id = ri.session_id
         WHERE ri.run_id = NEW.run_id
           AND ri.session_id = NEW.intake_session_id
           AND lr.workspace = NEW.workspace
           AND a.workspace = NEW.workspace
    ) OR NOT EXISTS (
        SELECT 1
        FROM entries AS e
        JOIN entry_revisions AS er
          ON er.entry_id = e.id AND er.revision = NEW.entry_revision
         WHERE e.id = NEW.entry_id
           AND er.workspace IN (NEW.workspace, 'global')
    );
END;

-- trigger embedding_profiles_immutable_update
CREATE TRIGGER embedding_profiles_immutable_update
BEFORE UPDATE ON embedding_profiles
BEGIN
    SELECT RAISE(ABORT, 'embedding_profiles are immutable');
END;

-- trigger enno_contract_identity_insert_guard
CREATE TRIGGER enno_contract_identity_insert_guard
BEFORE INSERT ON enno_contracts
BEGIN
    SELECT RAISE(ABORT, 'enno contract run identity mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) <> NEW.workspace
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) <> NEW.orchestration_session_id;
END;

-- trigger enno_contract_identity_update_guard
CREATE TRIGGER enno_contract_identity_update_guard
BEFORE UPDATE OF run_id, workspace, orchestration_session_id ON enno_contracts
BEGIN
    SELECT RAISE(ABORT, 'enno contract run identity mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) <> NEW.workspace
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) <> NEW.orchestration_session_id;
END;

-- trigger entry_revision_tags_immutable_update
CREATE TRIGGER entry_revision_tags_immutable_update
BEFORE UPDATE ON entry_revision_tags
BEGIN
    SELECT RAISE(ABORT, 'entry_revision_tags are immutable');
END;

-- trigger entry_revisions_immutable_update
CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END;

-- trigger entry_search_documents_ad
CREATE TRIGGER entry_search_documents_ad
AFTER DELETE ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_trigram(entries_trigram, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
END;

-- trigger entry_search_documents_ai
CREATE TRIGGER entry_search_documents_ai
AFTER INSERT ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
END;

-- trigger entry_search_documents_au
CREATE TRIGGER entry_search_documents_au
AFTER UPDATE ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_trigram(entries_trigram, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
END;

-- trigger intake_feedback_link_guard
CREATE TRIGGER intake_feedback_link_guard
BEFORE INSERT ON intake_feedback
BEGIN
    SELECT RAISE(ABORT, 'intake_feedback requires the linked run and session')
    WHERE NOT EXISTS (
        SELECT 1 FROM run_intakes
        WHERE run_id = NEW.run_id AND session_id = NEW.session_id
    );
END;

-- trigger nudge_deliveries_integrity_insert
CREATE TRIGGER nudge_deliveries_integrity_insert
BEFORE INSERT ON nudge_deliveries
BEGIN
    SELECT RAISE(ABORT, 'invalid nudge delivery')
    WHERE NEW.policy_version <> 'nudges.v1'
       OR NEW.code NOT IN ('SIDE_EFFECT_OUTCOME_UNKNOWN', 'UNRESOLVED_FAILURE', 'VERIFY_AFTER_MUTATION')
       OR NOT (
           (NEW.code = 'SIDE_EFFECT_OUTCOME_UNKNOWN' AND NEW.priority = 2)
           OR (NEW.code = 'UNRESOLVED_FAILURE' AND NEW.priority = 3)
           OR (NEW.code = 'VERIFY_AFTER_MUTATION' AND NEW.priority = 4)
       )
       OR CASE
           WHEN json_valid(NEW.evidence_event_ids_json)
             THEN json_type(NEW.evidence_event_ids_json) = 'array'
               AND json_array_length(NEW.evidence_event_ids_json) <= 16
           ELSE 0
       END = 0
       OR CASE
           WHEN json_valid(NEW.reference_ids_json)
             THEN json_type(NEW.reference_ids_json) = 'array'
               AND json_array_length(NEW.reference_ids_json) <= 16
           ELSE 0
       END = 0;
END;

-- trigger nudge_deliveries_integrity_update
CREATE TRIGGER nudge_deliveries_integrity_update
BEFORE UPDATE OF policy_version, code, priority, evidence_event_ids_json, reference_ids_json ON nudge_deliveries
BEGIN
    SELECT RAISE(ABORT, 'invalid nudge delivery')
    WHERE NEW.policy_version <> 'nudges.v1'
       OR NEW.code NOT IN ('SIDE_EFFECT_OUTCOME_UNKNOWN', 'UNRESOLVED_FAILURE', 'VERIFY_AFTER_MUTATION')
       OR NOT (
           (NEW.code = 'SIDE_EFFECT_OUTCOME_UNKNOWN' AND NEW.priority = 2)
           OR (NEW.code = 'UNRESOLVED_FAILURE' AND NEW.priority = 3)
           OR (NEW.code = 'VERIFY_AFTER_MUTATION' AND NEW.priority = 4)
       )
       OR CASE
           WHEN json_valid(NEW.evidence_event_ids_json)
             THEN json_type(NEW.evidence_event_ids_json) = 'array'
               AND json_array_length(NEW.evidence_event_ids_json) <= 16
           ELSE 0
       END = 0
       OR CASE
           WHEN json_valid(NEW.reference_ids_json)
             THEN json_type(NEW.reference_ids_json) = 'array'
               AND json_array_length(NEW.reference_ids_json) <= 16
           ELSE 0
       END = 0;
END;

-- trigger run_intakes_parent_workspace_guard
CREATE TRIGGER run_intakes_parent_workspace_guard
BEFORE UPDATE OF workspace ON ledger_runs
WHEN EXISTS (SELECT 1 FROM run_intakes WHERE run_id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'workspace cannot change after run intake link');
END;

-- trigger run_intakes_session_workspace_guard
CREATE TRIGGER run_intakes_session_workspace_guard
BEFORE UPDATE OF workspace ON akinator_sessions
WHEN EXISTS (SELECT 1 FROM run_intakes WHERE session_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'workspace cannot change after run intake link');
END;

-- trigger run_intakes_workspace_guard
CREATE TRIGGER run_intakes_workspace_guard
BEFORE INSERT ON run_intakes
BEGIN
    SELECT RAISE(ABORT, 'run_intakes workspace mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id)
          <> (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id);
END;

-- trigger run_intakes_workspace_update_guard
CREATE TRIGGER run_intakes_workspace_update_guard
BEFORE UPDATE OF run_id, session_id ON run_intakes
BEGIN
    SELECT RAISE(ABORT, 'run_intakes workspace mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id)
          <> (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id);
END;

-- Initial singleton state for a fresh v0.2.0-alpha.1 installation.
INSERT INTO external_skill_generation_clock (singleton, value)
VALUES (1, 0);

INSERT INTO entry_revision_hash_format (singleton, algorithm)
VALUES (1, 'canonical-json-utf16-tags-v1');

INSERT INTO embedding_runtime (singleton, active_profile_id, generation, activated_at)
VALUES (1, NULL, 1, NULL);

INSERT INTO embedding_settings (
    singleton, mode, provider_kind, preset_id, model_installation_id,
    vector_backend, batch_size, timeout_ms, setup_state, updated_at
)
VALUES (
    1, 'off', NULL, NULL, NULL,
    'auto', 16, 30000, 'disabled', '1970-01-01T00:00:00.000Z'
);
