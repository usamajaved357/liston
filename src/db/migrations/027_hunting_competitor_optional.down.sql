DELETE FROM hunted_products WHERE competitor_url IS NULL OR competitor_item_id IS NULL;
ALTER TABLE hunted_products ALTER COLUMN competitor_item_id SET NOT NULL;
ALTER TABLE hunted_products ALTER COLUMN competitor_url SET NOT NULL;
