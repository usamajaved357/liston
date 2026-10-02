-- The Drafts tab says who drafted each draft and who last worked on it,
-- read from member_activity by the draft's id: an index on just the draft
-- rows keeps that one indexed lookup per draft however long the log grows.
CREATE INDEX idx_member_activity_draft ON member_activity(subject_id, kind, created_at DESC) WHERE subject_type = 'draft';
