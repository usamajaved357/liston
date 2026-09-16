DROP INDEX IF EXISTS idx_users_access_status;
ALTER TABLE users DROP COLUMN IF EXISTS access_reviewed_at;
ALTER TABLE users DROP COLUMN IF EXISTS access_note;
ALTER TABLE users DROP COLUMN IF EXISTS access_status;
