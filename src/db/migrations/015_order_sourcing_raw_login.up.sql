-- The team keeps the supplier login on the order line itself (as their
-- sheet did), rather than picking from a list of accounts. Plain text by
-- decision: shared throwaway buyer logins, not payment data.
ALTER TABLE order_sourcing ADD COLUMN source_email TEXT;
ALTER TABLE order_sourcing ADD COLUMN source_password TEXT;
