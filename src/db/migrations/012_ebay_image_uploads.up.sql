-- Images already uploaded to eBay Picture Services, by content hash. An
-- upload is a Trading API call; the same bytes never need a second one.
CREATE TABLE ebay_image_uploads (
  content_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
