DELETE FROM member_activity WHERE subject_type = 'conversation';
ALTER TABLE member_activity DROP CONSTRAINT member_activity_subject_type_check;
ALTER TABLE member_activity ADD CONSTRAINT member_activity_subject_type_check CHECK (subject_type IN ('order', 'listing', 'draft', 'account', 'session', 'hunt'));
DROP TABLE ebay_inbox_sync;
DROP TABLE ebay_messages;
DROP TABLE ebay_conversations;
