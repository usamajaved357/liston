DROP INDEX IF EXISTS idx_member_activity_subject;
DELETE FROM member_activity WHERE subject_type IN ('account', 'session');
ALTER TABLE member_activity DROP CONSTRAINT member_activity_subject_type_check;
ALTER TABLE member_activity ADD CONSTRAINT member_activity_subject_type_check CHECK (subject_type IN ('order', 'listing', 'draft'));
