-- Small durable key/value store for process-level state that must survive a
-- redeploy on an ephemeral filesystem (Railway, etc.). First use: the
-- AliExpress OAuth token, which rolls every few hours and used to live in
-- .cache/aliexpress-token.json.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
