-- The Inbox as team work (ARCHITECTURE.md §9.1 phase 7) and time in Liston.
--
-- Notes on an eBay conversation that only the team sees, never the buyer:
-- written from the composer's Note switch, shown in the thread among the
-- messages. Deleting one keeps the row (who wrote what stays on record).
CREATE TABLE ebay_conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  connection_id UUID NOT NULL,
  conversation_id TEXT NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (connection_id, conversation_id) REFERENCES ebay_conversations(connection_id, conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_ebay_notes_thread ON ebay_conversation_notes(connection_id, conversation_id, created_at);

-- Who put an eBay conversation in its state, and when (the list's "Done by
-- Sara"); the work itself is in member_activity.
ALTER TABLE ebay_conversations ADD COLUMN assigned_at TIMESTAMPTZ;
ALTER TABLE ebay_conversations ADD COLUMN work_status_at TIMESTAMPTZ;
ALTER TABLE ebay_conversations ADD COLUMN work_status_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- A team member's time in Liston, one row per minute a Liston tab of theirs
-- was open: working (a click, key or scroll in the last couple of minutes)
-- or idle (open, nothing done; counted for at most half an hour, then
-- they're away and nothing is kept), and where they were (the area and the
-- eBay account). Several tabs in one minute make one row, working if any
-- was. Members only: the owner's own time isn't kept.
CREATE TABLE member_minutes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute TIMESTAMPTZ NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  working BOOLEAN NOT NULL,
  area TEXT NOT NULL,
  connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, minute)
);
CREATE INDEX idx_member_minutes_owner ON member_minutes(owner_user_id, minute);
