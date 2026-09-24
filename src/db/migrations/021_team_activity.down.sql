DROP TABLE IF EXISTS member_activity;
ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;
