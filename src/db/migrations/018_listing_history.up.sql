-- Listing analytics, third shape (see ARCHITECTURE.md §6): each listing's
-- figures are stored day by day (one LISTING report per day, naming every
-- live listing), so any date range is added up from the database and
-- switching ranges reads nothing from eBay. Yesterday is read each night;
-- older days are filled from allowance that would otherwise go unused
-- before eBay's daily reset.
--
-- A day's report (from_day = to_day, scope 'day') keeps no rows of its own
-- (they live in ebay_traffic_days) — just which listings it covered:
--   listing_ids  the listings named in the read; null = eBay's busiest 200
--                unfiltered, complete when cutoff is null
ALTER TABLE ebay_traffic_listing_reports ADD COLUMN listing_ids TEXT[];
-- The earliest day worth reading: nothing live now was listed before it.
ALTER TABLE ebay_traffic_sync ADD COLUMN history_from DATE;

-- Per-listing days read so far named no listings; read them again.
DELETE FROM ebay_traffic_listing_reports WHERE from_day = to_day;
DELETE FROM ebay_traffic_days WHERE listing_id <> '';
UPDATE ebay_traffic_sync SET detail_days = '{}', today_day = NULL, today_fetched_at = NULL;
