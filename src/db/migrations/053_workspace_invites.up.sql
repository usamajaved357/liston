-- Invitations to a workspace by email. The person opens the emailed link and
-- joins: someone new creates their own login there, someone already on
-- Liston joins with the one they have. With member_user_id it is instead a
-- member's login moving to a real email: the login takes the address (and a
-- password of their own) once they confirm it from there. Open while neither
-- accepted nor withdrawn, until expires_at; resending pushes that on.

CREATE TABLE workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  member_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  -- Their access on joining copied from this member's here.
  same_as_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ
);

-- One open invitation per email in a workspace, and one email change per login.
CREATE UNIQUE INDEX workspace_invites_open_email ON workspace_invites (owner_user_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND member_user_id IS NULL;
CREATE UNIQUE INDEX workspace_invites_open_change ON workspace_invites (member_user_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND member_user_id IS NOT NULL;
