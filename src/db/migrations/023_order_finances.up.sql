-- What eBay's Finances API says each order made: the price the fees were
-- worked on, the fees (ad fees apart), what reached the seller and any
-- refunds. Read in bulk per account (a few calls for 90 days of orders), so
-- the Overview's sales, fees, earnings and profit add up locally instead of
-- asking eBay once per order as the order page does.
CREATE TABLE ebay_order_finances (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  currency TEXT,
  gross NUMERIC(12, 2) NOT NULL DEFAULT 0,
  fees NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ad_fees NUMERIC(12, 2) NOT NULL DEFAULT 0,
  refunds NUMERIC(12, 2) NOT NULL DEFAULT 0,
  earnings NUMERIC(12, 2) NOT NULL DEFAULT 0,
  funds_status TEXT,
  sale_date TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, order_id)
);
CREATE INDEX idx_ebay_order_finances_date ON ebay_order_finances(connection_id, sale_date);
