-- A notification's parts for the bell to lay out (the product, who did it,
-- the reason and the note), beside its ready-made title and text.
ALTER TABLE notifications ADD COLUMN detail JSONB NOT NULL DEFAULT '{}'::jsonb;
