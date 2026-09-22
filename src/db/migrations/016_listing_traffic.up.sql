-- eBay's traffic report (Analytics API), kept as a daily history so any date
-- range is a sum in our own database and changing a filter costs no eBay
-- call. eBay allows the whole app only ~100 traffic calls a day, so each
-- completed day is fetched once and kept.
--   day         eBay's reporting day, which runs on US Pacific time
--   listing_id  the eBay item id; '' is the whole account (DAY dimension)
--   final       false while the day is still running ("so far today")
-- Raw counts only; rates (click-through, conversion) are computed from sums
-- so they stay correct over any range.
CREATE TABLE ebay_traffic_days (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  listing_id TEXT NOT NULL DEFAULT '',
  impressions INTEGER NOT NULL DEFAULT 0,
  impressions_search INTEGER NOT NULL DEFAULT 0,
  impressions_store INTEGER NOT NULL DEFAULT 0,
  total_impressions INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  views_search INTEGER NOT NULL DEFAULT 0,
  views_store INTEGER NOT NULL DEFAULT 0,
  views_direct INTEGER NOT NULL DEFAULT 0,
  views_off_ebay INTEGER NOT NULL DEFAULT 0,
  views_other_ebay INTEGER NOT NULL DEFAULT 0,
  transactions INTEGER NOT NULL DEFAULT 0,
  final BOOLEAN NOT NULL DEFAULT true,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, listing_id, day)
);
CREATE INDEX idx_ebay_traffic_days_day ON ebay_traffic_days(connection_id, day);

-- Which days have been fetched per listing (a day with no traffic has no
-- rows, so "fetched" can't be read from the rows themselves), plus the
-- per-account sync bookkeeping (last run, "Refresh today" presses).
CREATE TABLE ebay_traffic_sync (
  connection_id UUID PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  account_through DATE,                 -- last final day of account totals
  listing_days DATE[] NOT NULL DEFAULT '{}', -- final days fetched per listing
  today_day DATE,                       -- the day "so far today" refers to
  today_fetched_at TIMESTAMPTZ,
  refresh_day DATE,                     -- the eBay day refresh_count counts
  refresh_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
