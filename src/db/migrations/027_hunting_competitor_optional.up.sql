-- A product can be hunted from the supplier alone, as a draft can be made
-- without a competitor: it's then priced at the account's target return.
ALTER TABLE hunted_products ALTER COLUMN competitor_url DROP NOT NULL;
ALTER TABLE hunted_products ALTER COLUMN competitor_item_id DROP NOT NULL;
