CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_platform_id UUID NOT NULL REFERENCES platforms(id),
  label TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'error', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tracked_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source_platform_id UUID NOT NULL REFERENCES platforms(id),
  source_url TEXT NOT NULL,
  last_scraped_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_store_id UUID NOT NULL REFERENCES tracked_stores(id) ON DELETE CASCADE,
  source_data JSONB,
  generated_data JSONB,
  status TEXT NOT NULL DEFAULT 'scraped' CHECK (
    status IN ('scraped', 'generated', 'pending_review', 'approved', 'published', 'rejected', 'failed')
  ),
  external_product_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('scrape', 'generate', 'publish', 'sheet_sync')),
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_connections_user_id ON connections(user_id);
CREATE INDEX idx_tracked_stores_connection_id ON tracked_stores(connection_id);
CREATE INDEX idx_listings_tracked_store_id ON listings(tracked_store_id);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_jobs_log_connection_id ON jobs_log(connection_id);
