-- Discover (the Hunting page's tab for finding what to hunt): what eBay has
-- live for a category or a keyword on a site, each leading listing's sold
-- count as Discover read it day by day, and the categories and keywords a
-- team watches.

-- A category's or keyword's live listings on a site, as Browse returned them
-- (best match first), kept until read again (a day). Shared by every account
-- on the site: which listings fit an account is worked out when shown.
CREATE TABLE discover_scans (
  marketplace_id TEXT NOT NULL,
  subject TEXT NOT NULL,                  -- 'c:<categoryId>' | 'q:<keyword, lower case>'
  total INTEGER NOT NULL,                 -- every live listing eBay has for it
  listings JSONB NOT NULL,                -- up to 100 listing summaries, without sold counts
  breakdown JSONB,                        -- how eBay splits them: categories, brands
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace_id, subject)
);

-- One listing's sold count (Trading GetItem: the total and per option) on a
-- day: read at most once a day, whoever asked, so the reads are shared and a
-- watched listing's recent sales are the difference between two days.
CREATE TABLE discover_listing_reads (
  marketplace_id TEXT NOT NULL,
  item_id TEXT NOT NULL,                  -- the listing's eBay item number
  day DATE NOT NULL,                      -- the site's calendar day
  sold INTEGER NOT NULL,
  options JSONB,                          -- [{ label, sold, price }] for a listing with options
  category_id TEXT,
  started_at TIMESTAMPTZ,                 -- when the listing went live
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace_id, item_id, day)
);
CREATE INDEX idx_discover_reads_day ON discover_listing_reads(day);

-- A category or keyword a team keeps an eye on, on one eBay account: read
-- again every night.
CREATE TABLE discover_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'keyword')),
  value TEXT NOT NULL,                    -- the category id, or the keyword
  label TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ,
  UNIQUE (connection_id, kind, value)
);
CREATE INDEX idx_discover_watches_due ON discover_watches(last_read_at NULLS FIRST);
