-- An eBay picture belongs to the seller account that uploaded it. The cache
-- was keyed by the picture's bytes alone, so a second account drafting the
-- same supplier product was handed the first account's picture URLs, and
-- eBay refused the listing ("A mixture of Self Hosted and EPS pictures are
-- not allowed"). Keyed by bytes AND account from here on; rows from before
-- have no account ('') and are never reused.
ALTER TABLE ebay_image_uploads ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE ebay_image_uploads DROP CONSTRAINT ebay_image_uploads_pkey;
ALTER TABLE ebay_image_uploads ADD PRIMARY KEY (content_hash, account);
CREATE INDEX idx_ebay_image_uploads_url ON ebay_image_uploads (url);
