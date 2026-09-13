-- Rebuildable profile search projection; authoritative profiles remain in run_intakes/sessions.
CREATE TABLE akinator_profile_documents (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    profile_hash TEXT NOT NULL,
    sources_hash TEXT NOT NULL,
    task_text TEXT NOT NULL,
    target_text TEXT NOT NULL,
    projected_at TEXT NOT NULL,
    projection_version INTEGER NOT NULL CHECK (projection_version = 1)
);
CREATE INDEX idx_akinator_profile_scope ON akinator_profile_documents(workspace, repository_id, run_id);
CREATE TABLE akinator_profile_signals (
    document_id INTEGER NOT NULL REFERENCES akinator_profile_documents(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (document_id, value)
);
CREATE INDEX idx_akinator_profile_signal ON akinator_profile_signals(workspace, repository_id, value, document_id);
CREATE VIRTUAL TABLE akinator_profile_fts USING fts5(task_text, target_text, content='akinator_profile_documents', content_rowid='id');
CREATE VIRTUAL TABLE akinator_profile_trigram USING fts5(task_text, target_text, content='akinator_profile_documents', content_rowid='id', tokenize='trigram');
CREATE TRIGGER akinator_profile_insert AFTER INSERT ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(rowid, task_text, target_text) VALUES (new.id, new.task_text, new.target_text);
    INSERT INTO akinator_profile_trigram(rowid, task_text, target_text) VALUES (new.id, new.task_text, new.target_text);
END;
CREATE TRIGGER akinator_profile_delete AFTER DELETE ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target_text) VALUES ('delete', old.id, old.task_text, old.target_text);
    INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target_text) VALUES ('delete', old.id, old.task_text, old.target_text);
END;
CREATE TRIGGER akinator_profile_update AFTER UPDATE ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target_text) VALUES ('delete', old.id, old.task_text, old.target_text);
    INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target_text) VALUES ('delete', old.id, old.task_text, old.target_text);
    INSERT INTO akinator_profile_fts(rowid, task_text, target_text) VALUES (new.id, new.task_text, new.target_text);
    INSERT INTO akinator_profile_trigram(rowid, task_text, target_text) VALUES (new.id, new.task_text, new.target_text);
END;
CREATE TABLE akinator_profile_backfill (
    workspace TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1))
);
-- No profile text is copied into resolutions: candidates are revision-bound references.
CREATE TABLE akinator_memory_resolutions (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json) AND length(resolution_json) <= 65536),
    created_at TEXT NOT NULL
);
CREATE TRIGGER akinator_profile_session_changed AFTER UPDATE OF profile_json, task_text, status ON akinator_sessions BEGIN
    DELETE FROM akinator_profile_documents WHERE session_id = new.id;
    DELETE FROM akinator_profile_backfill WHERE workspace = new.workspace;
END;
CREATE TRIGGER akinator_profile_sources_changed AFTER UPDATE OF profile_sources_json, finalized_at ON run_intakes BEGIN
    DELETE FROM akinator_profile_documents WHERE run_id = new.run_id;
    DELETE FROM akinator_profile_backfill WHERE workspace = (SELECT workspace FROM ledger_runs WHERE run_id = new.run_id);
END;
-- Retire copied hints when their source is purged. Initial audit hashes remain, candidate references do not.
CREATE TRIGGER akinator_memory_source_deleted BEFORE DELETE ON ledger_runs BEGIN
    UPDATE akinator_memory_resolutions
    SET resolution_json = json_set(resolution_json, '$.candidates', json('[]'), '$.adopted', NULL, '$.shadowAdoption', NULL, '$.status', 'incomplete')
    WHERE EXISTS (SELECT 1 FROM json_each(resolution_json, '$.candidates') WHERE json_extract(value, '$.runId') = old.run_id);
END;

PRAGMA user_version = 7;
