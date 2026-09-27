-- A hunted product's competitor sales over time. eBay gives a listing's sold
-- count per variation (lifetime) but no dated history to this app, so Liston
-- reads the counts when a product is checked and again once a day while it's
-- in the pipeline; the differences between readings are its sales history.
CREATE TABLE hunt_sales_snapshots (
  hunt_id UUID NOT NULL REFERENCES hunted_products(id) ON DELETE CASCADE,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold INT,                                  -- the competitor listing's total sold, eBay's figure
  available INT,                             -- what it has left
  variations JSONB NOT NULL DEFAULT '[]',    -- [{ label, sold, available, price }]
  PRIMARY KEY (hunt_id, taken_at)
);

-- The product's sales score (hunting/hunt-sales.js salesScore), for sorting.
ALTER TABLE hunted_products ADD COLUMN sales_score INT;
