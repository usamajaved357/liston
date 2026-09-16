ALTER TABLE listings
  ALTER COLUMN tracked_store_id DROP NOT NULL;

ALTER TABLE listings
  ADD COLUMN connection_id UUID REFERENCES connections(id) ON DELETE CASCADE,
  ADD COLUMN platform_offer_id TEXT,
  ADD COLUMN platform_group_key TEXT,
  ADD COLUMN sku TEXT;

ALTER TABLE listings
  ADD CONSTRAINT listings_source_check CHECK (tracked_store_id IS NOT NULL OR connection_id IS NOT NULL);

CREATE INDEX idx_listings_connection_id ON listings(connection_id);
CREATE INDEX idx_listings_platform_offer_id ON listings(platform_offer_id);
