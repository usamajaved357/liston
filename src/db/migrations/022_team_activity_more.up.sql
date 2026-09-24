-- Team activity also records work that isn't on one order or listing:
-- logins (attendance), Shop categories and supplier accounts ('account').
ALTER TABLE member_activity DROP CONSTRAINT member_activity_subject_type_check;
ALTER TABLE member_activity ADD CONSTRAINT member_activity_subject_type_check CHECK (subject_type IN ('order', 'listing', 'draft', 'account', 'session'));
-- Draft work is recorded at most once per person and draft per few hours;
-- this finds the last one quickly.
CREATE INDEX idx_member_activity_subject ON member_activity(actor_user_id, kind, subject_id, created_at DESC);
