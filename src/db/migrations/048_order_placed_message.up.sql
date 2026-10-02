-- The order-placed welcome joins the delivered thank-you. A message is
-- claimed ('sending') in the same step that checks it hasn't been, before
-- eBay is asked, so two runs (eBay's new-order push and the hourly sweep,
-- or two servers) can never both send it; it then becomes 'sent' or
-- 'failed', and neither is tried again. A buyer's second order within a day
-- is noted 'skipped' rather than messaged (one welcome a day per buyer).
ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check;
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('placed', 'delivered'));
ALTER TABLE order_messages DROP CONSTRAINT order_messages_status_check;
ALTER TABLE order_messages ADD CONSTRAINT order_messages_status_check CHECK (status IN ('sending', 'sent', 'failed', 'skipped'));
CREATE INDEX idx_order_messages_buyer ON order_messages(connection_id, kind, buyer, sent_at DESC);
