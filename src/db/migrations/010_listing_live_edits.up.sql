-- A live listing being edited in Liston is a transient row: loaded from
-- eBay, edited, then either revised on eBay (and the row deleted) or
-- discarded. It is never a draft, so the Drafts tab leaves these out.
ALTER TABLE listings ADD COLUMN edit_of_item_id TEXT;
CREATE INDEX idx_listings_edit_of_item_id ON listings(edit_of_item_id);
