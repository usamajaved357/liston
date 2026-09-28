-- Discover's daily readings carry each listing's brand (from the same
-- Trading GetItem read, its Brand item specific), so products can be
-- filtered to unbranded ones — what a dropshipper can actually source.
ALTER TABLE discover_listing_reads ADD COLUMN brand TEXT;
