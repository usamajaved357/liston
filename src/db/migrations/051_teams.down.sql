-- Back to one team per member login: each keeps its first team only.
ALTER TABLE users ADD COLUMN parent_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN owner_access_at TIMESTAMPTZ;
CREATE INDEX idx_users_parent_user_id ON users(parent_user_id);
UPDATE users u SET parent_user_id = m.owner_user_id, deactivated_at = m.deactivated_at, owner_access_at = m.owner_access_at
  FROM (SELECT DISTINCT ON (user_id) * FROM workspace_members ORDER BY user_id, created_at) m
 WHERE m.user_id = u.id AND u.role = 'member';
ALTER TABLE users ADD CONSTRAINT users_owner_access_member CHECK (owner_access_at IS NULL OR role = 'member');
ALTER TABLE users DROP COLUMN last_workspace_id;

DROP INDEX idx_notifications_team_unread;
ALTER TABLE notifications DROP COLUMN owner_user_id;

DELETE FROM member_permissions p USING users u WHERE u.id = p.member_user_id AND p.owner_user_id IS DISTINCT FROM u.parent_user_id;
DROP INDEX idx_member_perms_global;
CREATE UNIQUE INDEX idx_member_perms_global ON member_permissions(member_user_id, feature) WHERE connection_id IS NULL;
ALTER TABLE member_permissions DROP COLUMN owner_user_id;

DROP TABLE workspace_members;
DROP TABLE workspaces;
