DROP TABLE chat_thread_members;
DROP INDEX idx_chat_messages_thread;
ALTER TABLE chat_messages DROP COLUMN last_reply_at;
ALTER TABLE chat_messages DROP COLUMN reply_count;
ALTER TABLE chat_messages DROP COLUMN also_in_conversation;
ALTER TABLE chat_messages DROP COLUMN thread_id;
