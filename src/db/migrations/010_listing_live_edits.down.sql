DROP INDEX IF EXISTS idx_listings_edit_of_item_id;
ALTER TABLE listings DROP COLUMN IF EXISTS edit_of_item_id;
