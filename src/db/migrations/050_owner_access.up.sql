-- Owner access: the owner can give a team member everything the owner has
-- (every eBay account and area, connecting accounts, settings, and running
-- the rest of the team). The login stays a member (its own email and
-- password, on the owner's data); owner_access_at says since when it has
-- owner access. Only the owner gives or takes it away, and only the owner
-- manages a login that has it.
ALTER TABLE users ADD COLUMN owner_access_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT users_owner_access_member CHECK (owner_access_at IS NULL OR role = 'member');
