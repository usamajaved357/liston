-- Team/child access: a "member" row is a real login (own email/password, own
-- JWT) that operates on its parent owner's data instead of its own. `name`
-- is added for everyone (nullable) since members need a human-readable label
-- beyond email; owners can leave it blank.
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member'));
ALTER TABLE users ADD COLUMN parent_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX idx_users_parent_user_id ON users(parent_user_id);

-- One row per (member, feature[, connection]) grant. `feature` is free-text,
-- not a CHECK-constrained enum, so a new feature module registers a new
-- string here with zero migration. connection_id NULL = the member's global
-- default for that feature, applied to every connection the owner has unless
-- a connection-scoped row overrides it (deny-by-default: no row = no access).
CREATE TABLE member_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES connections(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A plain UNIQUE across a nullable column doesn't dedupe NULLs in Postgres,
-- so two partial indexes: at most one global-default row and at most one
-- scoped-override row per (member, connection, feature).
CREATE UNIQUE INDEX idx_member_perms_global ON member_permissions(member_user_id, feature) WHERE connection_id IS NULL;
CREATE UNIQUE INDEX idx_member_perms_scoped ON member_permissions(member_user_id, connection_id, feature) WHERE connection_id IS NOT NULL;
CREATE INDEX idx_member_perms_member ON member_permissions(member_user_id);
CREATE INDEX idx_member_perms_connection ON member_permissions(connection_id);
