-- A local mirror of each connected eBay account's listings and orders.
--
-- eBay's Trading API gives an app a fixed daily call allowance shared by
-- every seller on Liston, and every page view used to re-read the account
-- from eBay. Pages now render from these tables (instantly, on every
-- server restart, for every user) and eBay is only asked to bring the
-- mirror up to date, incrementally where the API allows it.

-- One row per (account, dataset): the listings sets are held whole (they
-- are re-read whole from eBay anyway); the orders row holds only sync
-- bookkeeping, its data lives per order below.
CREATE TABLE ebay_snapshots (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, kind)
);

-- The last 90 days of orders (all eBay will serve), kept per order so a
-- refresh can upsert just what changed since the last sync.
CREATE TABLE ebay_orders (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, order_id)
);
CREATE INDEX idx_ebay_orders_created ON ebay_orders(connection_id, created_at DESC);

-- Per-item photo/quantity/URL used to decorate order rows. Shared across
-- accounts (an item id is global) and slow to change.
CREATE TABLE ebay_item_summaries (
  item_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
