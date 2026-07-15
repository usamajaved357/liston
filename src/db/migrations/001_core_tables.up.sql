CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  max_connections INTEGER NOT NULL,
  listings_included_per_month INTEGER NOT NULL,
  overage_price_cents INTEGER NOT NULL,
  stripe_price_id TEXT,
  price_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  plan_id UUID REFERENCES plans(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  google_sheet_id TEXT,
  email_verified_at TIMESTAMPTZ,
  listings_used_this_month INTEGER NOT NULL DEFAULT 0,
  billing_cycle_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'destination', 'both')),
  status TEXT NOT NULL DEFAULT 'coming_soon' CHECK (status IN ('active', 'coming_soon')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plan_platform_access (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  platform_id UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, platform_id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_plan_id ON users(plan_id);
