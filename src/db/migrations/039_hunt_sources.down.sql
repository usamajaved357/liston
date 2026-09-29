DROP TABLE IF EXISTS hunt_sources;
-- Products still waiting for a supplier can't exist without one.
DELETE FROM hunted_products WHERE status = 'sourcing' OR source_url IS NULL OR source_product_id IS NULL;
ALTER TABLE hunted_products ALTER COLUMN source_url SET NOT NULL;
ALTER TABLE hunted_products ALTER COLUMN source_product_id SET NOT NULL;
ALTER TABLE hunted_products DROP CONSTRAINT hunted_products_status_check;
ALTER TABLE hunted_products ADD CONSTRAINT hunted_products_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'sent_back'));
