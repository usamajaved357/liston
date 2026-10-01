-- Quick replies: an account's own ready-written messages to buyers, picked
-- with "/" in the Inbox's reply box and loaded into it (filled in with the
-- buyer's name, the item, the order and its tracking) to check before
-- sending; kept and edited in Settings → Messages. Each account starts with
-- Liston's set once (quick_reply_accounts marks that it has), so replies
-- the owner deletes never come back on their own.
CREATE TABLE quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quick_replies_account ON quick_replies(connection_id, position, created_at);

CREATE TABLE quick_reply_accounts (
  connection_id UUID PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
