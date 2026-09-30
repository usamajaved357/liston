-- Team chat, the Inbox's first mode: the owner and their team talking in
-- direct messages (one per pair), small groups and channels (run by the
-- owner, or members given "Manage channels"). A message's Liston cards are
-- only references ([{ kind, id, connectionId }]) resolved for each viewer
-- when shown, so nobody sees an order or listing their access doesn't
-- reach; its files are rows in `files`.
CREATE TABLE chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'channel')),
  name TEXT,
  topic TEXT,
  -- A channel only its members see (a public one anyone in the team can join).
  private BOOLEAN NOT NULL DEFAULT false,
  -- A channel about one eBay account (#flipx-orders).
  connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
  -- A direct message's two people, sorted: one conversation per pair.
  dm_key TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_chat_dm_pair ON chat_conversations(owner_user_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX idx_chat_channel_name ON chat_conversations(owner_user_id, lower(name)) WHERE kind = 'channel';
CREATE INDEX idx_chat_conversations_owner ON chat_conversations(owner_user_id, last_message_at DESC NULLS LAST);

CREATE TABLE chat_members (
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  -- Everything before this has been read (unread counts, "Seen by").
  last_read_at TIMESTAMPTZ,
  -- This conversation's notifications: every message, @mentions only, or none (muted).
  notify TEXT NOT NULL DEFAULT 'all' CHECK (notify IN ('all', 'mentions', 'none')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_chat_members_user ON chat_members(user_id);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- 'system': "Sara added Tom", "Channel renamed".
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  body TEXT NOT NULL DEFAULT '',
  reply_to_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_ids UUID[] NOT NULL DEFAULT '{}',
  -- Link previews for other sites: [{ url, title, description, image, site }].
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentions UUID[] NOT NULL DEFAULT '{}',
  mention_all BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED
);
CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id, created_at DESC);
CREATE INDEX idx_chat_messages_search ON chat_messages USING gin(search);
CREATE INDEX idx_chat_messages_files ON chat_messages USING gin(file_ids);

-- What each person wants pushed to their devices (Inbox, both modes).
CREATE TABLE notification_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Team chat: every message, direct messages and @mentions only, or none.
  chat TEXT NOT NULL DEFAULT 'all' CHECK (chat IN ('all', 'mentions', 'none')),
  -- eBay messages: every account they can see, the chosen ones, or none.
  ebay TEXT NOT NULL DEFAULT 'all' CHECK (ebay IN ('all', 'chosen', 'none')),
  ebay_accounts UUID[] NOT NULL DEFAULT '{}',
  -- Quiet hours, minutes after midnight in `time_zone` (both null: none).
  quiet_from SMALLINT,
  quiet_to SMALLINT,
  time_zone TEXT,
  -- Show only "New message from Sara", never the text, on the lock screen.
  hide_text BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
