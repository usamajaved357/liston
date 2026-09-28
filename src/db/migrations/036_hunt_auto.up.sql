-- Hunting runs itself: an approved product is drafted automatically, and
-- where that draft stands is kept on the product — drafting now, or failed
-- with eBay's or the drafting step's reason (a failed one keeps its place
-- on the Hunting page with a button to try again). A product whose supplier
-- doesn't match its eBay listing is rejected by Liston itself
-- (reject_reason 'mismatch', no reviewer).
ALTER TABLE hunted_products ADD COLUMN draft_status TEXT CHECK (draft_status IN ('drafting', 'failed'));
ALTER TABLE hunted_products ADD COLUMN draft_error TEXT;
ALTER TABLE hunted_products ADD COLUMN draft_attempted_at TIMESTAMPTZ;
