DROP INDEX IF EXISTS idx_listings_platform_offer_id;
DROP INDEX IF EXISTS idx_listings_connection_id;

ALTER TABLE listings
  DROP CONSTRAINT IF EXISTS listings_source_check;

ALTER TABLE listings
  DROP COLUMN sku,
  DROP COLUMN platform_group_key,
  DROP COLUMN platform_offer_id,
  DROP COLUMN connection_id;

ALTER TABLE listings
  ALTER COLUMN tracked_store_id SET NOT NULL;
