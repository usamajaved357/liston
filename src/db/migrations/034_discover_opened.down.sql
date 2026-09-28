DROP INDEX IF EXISTS idx_discover_scans_opened;
ALTER TABLE discover_scans DROP COLUMN IF EXISTS opened_connection_id;
ALTER TABLE discover_scans DROP COLUMN IF EXISTS opened_at;
