ALTER TABLE task_request_receipts
ADD COLUMN run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL;

ALTER TABLE task_request_receipts
ADD COLUMN purged_at TEXT;

UPDATE task_request_receipts
SET response_json = 'null', purged_at = created_at
WHERE scope IN ('opencode.task.create', 'opencode.task.answer')
  AND json_valid(response_json)
  AND json_type(response_json, '$.runId') = 'text'
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_runs
    WHERE ledger_runs.run_id = json_extract(task_request_receipts.response_json, '$.runId')
  );

UPDATE task_request_receipts
SET run_id = json_extract(response_json, '$.runId')
WHERE scope IN ('opencode.task.create', 'opencode.task.answer')
  AND json_valid(response_json)
  AND json_type(response_json, '$.runId') = 'text'
  AND EXISTS (
    SELECT 1
    FROM ledger_runs
    WHERE ledger_runs.run_id = json_extract(task_request_receipts.response_json, '$.runId')
  );

CREATE INDEX idx_task_request_receipts_run_id
ON task_request_receipts(run_id);

CREATE TRIGGER task_request_receipts_run_deleted
BEFORE DELETE ON ledger_runs
BEGIN
  UPDATE task_request_receipts
     SET response_json = 'null',
         run_id = NULL,
         purged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE run_id = OLD.run_id;
END;

PRAGMA user_version = 9;
