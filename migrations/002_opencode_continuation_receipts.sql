-- One durable continuation receipt per OpenCode terminal and Enno run.
PRAGMA user_version = 2;

CREATE TABLE enno_client_continuation_receipts (
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

CREATE INDEX idx_enno_continuation_receipts_session
    ON enno_client_continuation_receipts(run_id, client_kind, source_session_id, created_at);
