DROP INDEX IF EXISTS idx_ebay_image_uploads_url;
DELETE FROM ebay_image_uploads WHERE account <> '';
ALTER TABLE ebay_image_uploads DROP CONSTRAINT ebay_image_uploads_pkey;
ALTER TABLE ebay_image_uploads DROP COLUMN account;
ALTER TABLE ebay_image_uploads ADD PRIMARY KEY (content_hash);
