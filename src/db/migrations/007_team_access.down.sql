DROP TABLE IF EXISTS member_permissions;
DROP INDEX IF EXISTS idx_users_parent_user_id;
ALTER TABLE users DROP COLUMN IF EXISTS parent_user_id;
ALTER TABLE users DROP COLUMN IF EXISTS role;
ALTER TABLE users DROP COLUMN IF EXISTS name;
