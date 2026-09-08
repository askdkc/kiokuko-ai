CREATE TABLE task_execution_selections (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    choice TEXT NOT NULL CHECK (choice IN ('legacy', 'pending', 'ordinary', 'enno', 'cancelled')),
    catalog_json TEXT NOT NULL CHECK (json_valid(catalog_json)),
    selected_json TEXT CHECK (selected_json IS NULL OR json_valid(selected_json)),
    prepared_json TEXT NOT NULL CHECK (json_valid(prepared_json))
) STRICT;

-- Preserve the pre-selection contract for every run already present at upgrade.
INSERT INTO task_execution_selections(run_id, choice, catalog_json, prepared_json)
SELECT run_id, 'legacy', '{"mode":"ask","candidates":[]}', '{}' FROM ledger_runs;

CREATE TABLE task_execution_receipts (
    run_id TEXT NOT NULL REFERENCES task_execution_selections(run_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (run_id, operation_id)
) STRICT;

-- A failed or interrupted call remains reserved until the user selects again.
CREATE TABLE task_execution_dispatches (
    run_id TEXT NOT NULL REFERENCES task_execution_selections(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    role TEXT NOT NULL,
    prompt_digest TEXT NOT NULL,
    call_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    PRIMARY KEY (run_id, revision, role, prompt_digest)
) STRICT;

PRAGMA user_version = 5;
