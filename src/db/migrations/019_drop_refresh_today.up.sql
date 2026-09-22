-- "Refresh today" is gone (two traffic_report calls a press, from an
-- allowance of ~100 a day shared by every account): today's account totals
-- come with the nightly read, so its bookkeeping goes too.
ALTER TABLE ebay_traffic_sync
  DROP COLUMN IF EXISTS today_day,
  DROP COLUMN IF EXISTS today_fetched_at,
  DROP COLUMN IF EXISTS refresh_day,
  DROP COLUMN IF EXISTS refresh_count;
