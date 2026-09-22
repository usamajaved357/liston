-- Listing analytics, second shape (see ARCHITECTURE.md §6):
--  - days now follow the seller's own time zone (Europe/London for eBay UK),
--    as Seller Hub does, instead of eBay's default Pacific day — the stored
--    Pacific-day history can't be converted, so it is cleared and re-read
--    (a couple of calls per account);
--  - per-listing figures for a date range come from one LISTING report for
--    that exact range (ebay_traffic_listing_reports) rather than summing a
--    day-by-day history of every listing, which eBay's ~100 calls a day
--    can't afford for large stores. Day-by-day rows per listing are kept
--    only for the busiest 200 listings ("detail"), going forward.
DELETE FROM ebay_traffic_days;
DELETE FROM ebay_traffic_sync;
ALTER TABLE ebay_traffic_sync ADD COLUMN time_zone TEXT;
ALTER TABLE ebay_traffic_sync RENAME COLUMN listing_days TO detail_days;

-- One LISTING traffic report per account and date range.
--   scope    'top'  the 200 listings with the most impressions (1 call)
--            'all'  every live listing, in batches of 200
--            'item:<id>'  one listing asked for on its own
--   rows     [{ listingId, <traffic counts> }]
--   cutoff   impressions of the 200th listing when eBay's 200 were full
--            (every listing not in `rows` had fewer); null = complete
--   final    false for a range that includes today (replaced on refresh)
CREATE TABLE ebay_traffic_listing_reports (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  from_day DATE NOT NULL,
  to_day DATE NOT NULL,
  scope TEXT NOT NULL,
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  cutoff INTEGER,
  final BOOLEAN NOT NULL DEFAULT true,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, from_day, to_day, scope)
);
CREATE INDEX idx_ebay_traffic_listing_reports_fetched ON ebay_traffic_listing_reports(connection_id, fetched_at);
