-- Claims remain model reports. No historical run is promoted by this migration.
CREATE TABLE task_memory_reviews (
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  entry_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  review_json TEXT NOT NULL,
  PRIMARY KEY (run_id, delivery_id, entry_id),
  FOREIGN KEY (entry_id, entry_revision) REFERENCES entry_revisions(entry_id, revision)
);
CREATE TABLE task_memory_operations (
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (run_id, request_id)
);
CREATE TABLE task_memory_evidence (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL
);

PRAGMA user_version = 8;
