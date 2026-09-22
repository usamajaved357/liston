DROP TABLE IF EXISTS ebay_traffic_listing_reports;
ALTER TABLE ebay_traffic_sync RENAME COLUMN detail_days TO listing_days;
ALTER TABLE ebay_traffic_sync DROP COLUMN IF EXISTS time_zone;
