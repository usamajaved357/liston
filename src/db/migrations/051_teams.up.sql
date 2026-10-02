-- Teams (Slack's workspaces): one login can work in several owners' teams.
-- A team is an owner's business, keyed by the owner's user id (everything
-- in it is already stored under that id), with a name only its owner
-- changes. A login's place in a team is a membership: owner access and
-- being removed are per team, so the same person can have owner access in
-- one team, plain access in another, and be removed from a third. Before,
-- a member login belonged to one owner (users.parent_user_id) and was
-- removed or given owner access on the login itself; those move here.

CREATE TABLE workspaces (
  owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every owner's team, named after them ("Usama's team"); renamed by the owner.
INSERT INTO workspaces (owner_user_id, name, created_at)
SELECT id,
       left(coalesce(nullif(split_part(btrim(coalesce(name, '')), ' ', 1), ''), split_part(email, '@', 1)), 50) || '''s team',
       created_at
  FROM users WHERE role = 'owner';

CREATE TABLE workspace_members (
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the team
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- the login
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_access_at TIMESTAMPTZ,       -- everything the owner has in this team, since when
  deactivated_at TIMESTAMPTZ,        -- removed from this team (history kept, restorable)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, user_id),
  CHECK (owner_user_id <> user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

INSERT INTO workspace_members (owner_user_id, user_id, owner_access_at, deactivated_at, created_at)
SELECT parent_user_id, id, owner_access_at, deactivated_at, created_at
  FROM users WHERE role = 'member' AND parent_user_id IS NOT NULL;

-- A member's access is per team: the default for every account (connection
-- NULL) is now one per team; a per-account row was already one team's.
ALTER TABLE member_permissions ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
UPDATE member_permissions p SET owner_user_id = u.parent_user_id FROM users u WHERE u.id = p.member_user_id;
UPDATE member_permissions p SET owner_user_id = c.user_id FROM connections c WHERE c.id = p.connection_id;
DELETE FROM member_permissions WHERE owner_user_id IS NULL;
ALTER TABLE member_permissions ALTER COLUMN owner_user_id SET NOT NULL;
DROP INDEX idx_member_perms_global;
CREATE UNIQUE INDEX idx_member_perms_global ON member_permissions(member_user_id, owner_user_id, feature) WHERE connection_id IS NULL;

-- The bell is per team (another team's show as a count in the team menu).
ALTER TABLE notifications ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
UPDATE notifications n SET owner_user_id = coalesce(u.parent_user_id, u.id) FROM users u WHERE u.id = n.user_id;
CREATE INDEX idx_notifications_team_unread ON notifications(user_id, owner_user_id) WHERE read_at IS NULL;

-- The team a login opens in when it doesn't say (its last).
ALTER TABLE users ADD COLUMN last_workspace_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users DROP CONSTRAINT users_owner_access_member;
ALTER TABLE users DROP COLUMN owner_access_at;
ALTER TABLE users DROP COLUMN deactivated_at;
ALTER TABLE users DROP COLUMN parent_user_id;
