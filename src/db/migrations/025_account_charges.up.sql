-- What eBay charged an account apart from its orders: listing and upgrade
-- fees, store and other subscriptions, ads billed per click, and any of
-- them credited back (a credit is a negative amount). eBay's Finances API
-- books them as NON_SALE_CHARGE transactions naming no order; they come
-- in the same bulk read as ebay_order_finances, so the Overview's fees,
-- earnings and profit include them without asking eBay again.
CREATE TABLE ebay_account_charges (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fee_type TEXT,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT,
  item_id TEXT,
  memo TEXT,
  charged_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, transaction_id)
);
CREATE INDEX idx_ebay_account_charges_date ON ebay_account_charges(connection_id, charged_at);
CREATE INDEX idx_ebay_account_charges_transaction ON ebay_account_charges(transaction_id);
