-- When someone last read an eBay conversation in Liston: up to its latest
-- message then (that message's time, not the clock's). eBay's list can go
-- on saying a conversation is unread after Liston has marked it read there
-- (seen with one whose last word was the seller's), so a conversation read
-- here stays read until the buyer writes again; marking it unread clears it.
ALTER TABLE ebay_conversations ADD COLUMN read_at TIMESTAMPTZ;
