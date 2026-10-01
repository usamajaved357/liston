-- Team chat, round two: Slack-style threads and voice notes.
--
-- A thread is a message's replies, kept beside the conversation rather than
-- in it: each reply names its thread's first message (thread_id); a reply
-- also sent to the conversation (also_in_conversation) shows there too. The
-- first message keeps how many replies it has and when the last came, for
-- the line under it. Who follows a thread (whoever started it, replied in it
-- or was mentioned in it, until they stop) is told of new replies and has
-- its own read mark, apart from the conversation's.
--
-- A voice note is an audio file on a message with its length and the shape
-- of its sound (detail.voice: { fileId, durationMs, peaks }); no column.
ALTER TABLE chat_messages ADD COLUMN thread_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN also_in_conversation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_messages ADD COLUMN reply_count INT NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN last_reply_at TIMESTAMPTZ;
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at) WHERE thread_id IS NOT NULL;

CREATE TABLE chat_thread_members (
  root_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Every reply before this has been read.
  last_read_at TIMESTAMPTZ,
  -- Told of new replies; off when they stop following it.
  following BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (root_id, user_id)
);
CREATE INDEX idx_chat_thread_members_user ON chat_thread_members(user_id) WHERE following;
