-- Each sale on a competitor's listing, with its date: read from eBay's
-- purchase history page, which a team member opens and pastes into Liston
-- (Liston never fetches eBay pages itself). Kept per owner and eBay item, so
-- every hunt of that listing uses them; pasting again adds only new sales.
CREATE TABLE competitor_sales (
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,                 -- the competitor listing's eBay item number
  sold_at TIMESTAMPTZ NOT NULL,
  variation TEXT NOT NULL DEFAULT '',     -- "Colour: Pink", '' for a listing without variations
  price NUMERIC(12, 2),
  currency TEXT,
  quantity INT NOT NULL DEFAULT 1,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (owner_user_id, item_id, sold_at, variation, quantity)
);
CREATE INDEX idx_competitor_sales_item ON competitor_sales(owner_user_id, item_id, sold_at DESC);
