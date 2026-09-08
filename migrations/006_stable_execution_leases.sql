-- Operation receipts already retain issued credentials in this same database.
-- Make the current lease recoverable without revoking its active holder.
ALTER TABLE enno_execution_leases ADD COLUMN lease_token TEXT
    CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 256);

PRAGMA user_version = 6;
