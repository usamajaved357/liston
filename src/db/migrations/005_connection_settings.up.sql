ALTER TABLE connections
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;
