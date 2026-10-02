DROP INDEX idx_order_messages_buyer;
DELETE FROM order_messages WHERE kind = 'placed' OR status = 'skipped';
UPDATE order_messages SET status = 'failed' WHERE status = 'sending';
ALTER TABLE order_messages DROP CONSTRAINT order_messages_status_check;
ALTER TABLE order_messages ADD CONSTRAINT order_messages_status_check CHECK (status IN ('sent', 'failed'));
ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check;
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('delivered'));
