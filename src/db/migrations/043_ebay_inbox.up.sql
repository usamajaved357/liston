-- The Inbox's eBay messages: each account's conversations with buyers and
-- with eBay, read from eBay's Message API and kept here (with their text,
-- the owner's decision: search, reply timers, assignment and AI need it) so
-- the Inbox opens at once and eBay is only asked what changed. Deleted with
-- the account, and a buyer's when eBay says they closed their eBay account.
CREATE TABLE ebay_conversations (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FROM_MEMBERS', 'FROM_EBAY')),
  -- eBay's folder: ACTIVE (the inbox), ARCHIVE, DELETE.
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  title TEXT,
  reference_type TEXT,
  reference_id TEXT,
  -- The buyer (or other member) it's with; 'eBay' for eBay's own.
  other_party TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  latest_message_id TEXT,
  latest_preview TEXT,
  latest_subject TEXT,
  latest_at TIMESTAMPTZ,
  latest_from_seller BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  -- Liston's own, for the team: who has it, where it stands, labels (eBay's API has no folders).
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  work_status TEXT NOT NULL DEFAULT 'open' CHECK (work_status IN ('open', 'waiting', 'done')),
  labels TEXT[] NOT NULL DEFAULT '{}',
  messages_synced_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, conversation_id)
);
CREATE INDEX idx_ebay_conversations_list ON ebay_conversations(connection_id, type, status, latest_at DESC NULLS LAST);
CREATE INDEX idx_ebay_conversations_party ON ebay_conversations(connection_id, lower(other_party));

CREATE TABLE ebay_messages (
  connection_id UUID NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  from_seller BOOLEAN NOT NULL DEFAULT false,
  subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  read BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL,
  search TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, ''))) STORED,
  PRIMARY KEY (connection_id, message_id),
  FOREIGN KEY (connection_id, conversation_id) REFERENCES ebay_conversations(connection_id, conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_ebay_messages_thread ON ebay_messages(connection_id, conversation_id, created_at);
CREATE INDEX idx_ebay_messages_search ON ebay_messages USING gin(search);

-- How far each account's Inbox is read from eBay.
CREATE TABLE ebay_inbox_sync (
  connection_id UUID PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  last_full_sync_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  subscription_id TEXT,
  subscribed_at TIMESTAMPTZ
);

-- A buyer answered from the Inbox is team work (activity kind 'inbox.replied').
ALTER TABLE member_activity DROP CONSTRAINT member_activity_subject_type_check;
ALTER TABLE member_activity ADD CONSTRAINT member_activity_subject_type_check CHECK (subject_type IN ('order', 'listing', 'draft', 'account', 'session', 'hunt', 'conversation'));
