-- Owner accounts need approval before they can use the tool. Members are
-- created by an approved owner and are active from the start. When billing
-- arrives, "active" becomes "has an active subscription" behind the same gate.
ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'active'
  CHECK (access_status IN ('pending', 'active', 'rejected'));
ALTER TABLE users ADD COLUMN access_note TEXT;             -- what the applicant told us
ALTER TABLE users ADD COLUMN access_reviewed_at TIMESTAMPTZ;
CREATE INDEX idx_users_access_status ON users(access_status) WHERE access_status <> 'active';
