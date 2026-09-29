-- Hunting with its suppliers added by hand. Discover's Hunt adds the eBay
-- listing alone: the product waits in 'sourcing' (needs a supplier) with no
-- supplier until someone adds a link, then goes in for review. A product can
-- have several supplier links: the main one stays on hunted_products (its
-- profit check, the draft), the others sit in hunt_sources with their own
-- check, to compare and to switch to.
ALTER TABLE hunted_products DROP CONSTRAINT hunted_products_status_check;
ALTER TABLE hunted_products ADD CONSTRAINT hunted_products_status_check CHECK (status IN ('sourcing', 'pending', 'approved', 'rejected', 'sent_back'));
ALTER TABLE hunted_products ALTER COLUMN source_url DROP NOT NULL;
ALTER TABLE hunted_products ALTER COLUMN source_product_id DROP NOT NULL;

CREATE TABLE hunt_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunted_products(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  -- The profit check against the product's eBay listing (hunting/hunt-profit.js), as last read.
  check_result JSONB NOT NULL,
  headline_profit NUMERIC(12, 2),
  headline_roi NUMERIC(10, 2),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, source_product_id)
);
CREATE INDEX idx_hunt_sources_hunt ON hunt_sources(hunt_id, created_at);
