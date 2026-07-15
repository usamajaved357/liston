ALTER TABLE users
  ADD COLUMN email_verification_token_hash TEXT,
  ADD COLUMN email_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN password_reset_token_hash TEXT,
  ADD COLUMN password_reset_expires_at TIMESTAMPTZ;

CREATE INDEX idx_users_email_verification_token_hash ON users(email_verification_token_hash);
CREATE INDEX idx_users_password_reset_token_hash ON users(password_reset_token_hash);
