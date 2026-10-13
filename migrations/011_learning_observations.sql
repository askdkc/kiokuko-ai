-- Public summaries only. Source revisions remain immutable, including retractions.
CREATE TABLE learning_observations (
 workspace TEXT NOT NULL REFERENCES repositories(workspace),
 producer TEXT NOT NULL,
 event_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
 session_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(CAST(observation_json AS BLOB)) <= 16384),
 tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
 entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(workspace, producer, event_id, source_revision)
);
CREATE INDEX learning_session ON learning_observations(workspace,session_id,created_at);
CREATE TABLE learning_principles (
 workspace TEXT NOT NULL,
 digest TEXT NOT NULL,
 entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 PRIMARY KEY(workspace,digest)
);
PRAGMA user_version = 11;
