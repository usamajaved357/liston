-- Orders the team has put away (Seller Hub's "Archive"): hidden from the
-- order list until unarchived. Liston-side only; eBay has no such state.
CREATE TABLE archived_orders (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  archived_by UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, order_id)
);
