-- Where an eBay order's stock actually comes from: the supplier order a team
-- member placed for it (AliExpress today), who placed it, with which buying
-- account and card, what it cost, and the supplier's tracking number — the
-- columns the team used to keep in a spreadsheet, per eBay order line.

-- The supplier buying accounts an owner's team orders from. The password is
-- kept in plain text at the owner's request: these are throwaway buyer
-- logins the whole team shares, not payment credentials.
CREATE TABLE source_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'aliexpress',
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT,
  notes TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_source_accounts_owner ON source_accounts(owner_user_id);

-- One row per eBay order line item (an order with two items is two supplier
-- orders). `status` walks to_order → ordered → shipped → delivered, or
-- problem.
CREATE TABLE order_sourcing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'to_order' CHECK (status IN ('to_order', 'ordered', 'shipped', 'delivered', 'problem')),
  source_platform TEXT NOT NULL DEFAULT 'aliexpress',
  source_account_id UUID REFERENCES source_accounts(id) ON DELETE SET NULL,
  source_order_no TEXT,
  placed_at DATE,
  placed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  card_label TEXT,
  cost_value NUMERIC(12, 2),
  cost_currency TEXT,
  tracking_number TEXT,
  carrier TEXT,
  notes TEXT,
  dispatched_at TIMESTAMPTZ,
  dispatched_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ebay_fulfillment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, order_id, line_item_id)
);
CREATE INDEX idx_order_sourcing_order ON order_sourcing(connection_id, order_id);
CREATE INDEX idx_order_sourcing_status ON order_sourcing(connection_id, status);

-- What happened to an order inside Liston (who placed the supplier order,
-- who dispatched, notes), shown on the order's timeline next to eBay's own
-- events.
CREATE TABLE order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  line_item_id TEXT,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order ON order_events(connection_id, order_id, created_at DESC);
