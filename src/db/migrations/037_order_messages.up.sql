-- Messages Liston sends buyers by itself: today, one after an order is
-- delivered, asking for feedback and inviting them to write if anything's
-- wrong (the account's Settings turn it on and word it). One row per order
-- and kind, so a buyer is never sent the same message twice; a failure is
-- kept with eBay's reason and not retried.
CREATE TABLE order_messages (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delivered')),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  buyer TEXT,
  item_id TEXT,
  text TEXT,
  error TEXT,
  conversation_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, order_id, kind)
);
CREATE INDEX idx_order_messages_sent ON order_messages(connection_id, sent_at DESC);
