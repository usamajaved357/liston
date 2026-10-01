-- Files people share in the Inbox: team chat files (private to the team,
-- served by short-lived signed links) and attachments sent to eBay buyers
-- (an unguessable public link eBay fetches, expiring after 30 days). The
-- bytes live in lib/storage.js (Cloudflare R2, or a local folder); this is
-- what Liston knows about each.
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('chat', 'ebay')),
  storage_key TEXT NOT NULL,
  -- A small preview of an image (webp, 480px), for lists and bubbles.
  thumb_key TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  -- eBay attachments only: the link eBay reads the file from.
  public_token TEXT UNIQUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_files_owner ON files(owner_user_id, created_at DESC);
CREATE INDEX idx_files_expires ON files(expires_at) WHERE expires_at IS NOT NULL;
