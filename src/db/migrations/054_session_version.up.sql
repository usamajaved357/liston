-- A login's sign-ins are of one version: every sign-in token carries the
-- version it was issued under, and a changed password (from Settings, a
-- reset link, or an email confirmed with a new one) bumps it, so every
-- sign-in from before, on every device, stops working at its next request.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
