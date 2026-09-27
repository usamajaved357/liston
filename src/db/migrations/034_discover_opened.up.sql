-- Discover's shared nightly refresh: when a site's category or keyword was
-- last opened, and through which account (whose eBay sign-in reads its
-- sold counts at night). Subjects opened in the last few days are read
-- again once a night for everyone on the site.
ALTER TABLE discover_scans ADD COLUMN opened_at TIMESTAMPTZ;
ALTER TABLE discover_scans ADD COLUMN opened_connection_id UUID REFERENCES connections(id) ON DELETE SET NULL;
CREATE INDEX idx_discover_scans_opened ON discover_scans(opened_at DESC);
