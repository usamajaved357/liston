-- Product hunting: a team member finds a product (a competitor's eBay
-- listing and the AliExpress product to supply it), Liston works out the
-- profit on every option, and the product waits for a reviewer before
-- anyone may draft it. Approved products are drafted from the hunt, and
-- the listing it becomes (and its sales) stay tied to whoever found it.
CREATE TABLE hunted_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  -- Who found it. Kept (null) if their login row is ever deleted outright.
  hunter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The review decision. Drafted and listed are read from listing_id and
  -- item_ids, so deleting a draft puts the product back to approved.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent_back')),
  competitor_url TEXT NOT NULL,
  competitor_item_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  currency TEXT NOT NULL,
  -- The profit check as last read (hunting/hunt-profit.js): every option
  -- with its cost, shipping, matched competitor price, fees and profit,
  -- the best seller, demand, the supplier and the risk checks.
  check_result JSONB NOT NULL,
  -- From check_result, for sorting the list.
  headline_profit NUMERIC(12, 2),
  headline_roi NUMERIC(10, 2),
  sold_per_month NUMERIC(10, 1),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hunter_note TEXT,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  -- A rejection's reason (hunting/hunt-rules.js REJECT_REASONS); the note
  -- is the reviewer's words on a rejection or a send-back.
  reject_reason TEXT,
  decision_note TEXT,
  -- When it last went in for review (a resubmitted product starts again).
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resubmits INT NOT NULL DEFAULT 0,
  -- The draft made from it, and every eBay item it has been listed as
  -- (a relist adds the new number), so its sales can be followed.
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  drafted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  drafted_at TIMESTAMPTZ,
  item_ids TEXT[] NOT NULL DEFAULT '{}',
  listed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hunted_products_connection ON hunted_products(connection_id, status, created_at DESC);
CREATE INDEX idx_hunted_products_hunter ON hunted_products(owner_user_id, hunter_user_id, created_at DESC);
CREATE INDEX idx_hunted_products_reviewer ON hunted_products(owner_user_id, reviewer_user_id, decided_at DESC);
CREATE INDEX idx_hunted_products_source ON hunted_products(owner_user_id, source_product_id);
CREATE INDEX idx_hunted_products_competitor ON hunted_products(owner_user_id, competitor_item_id);
CREATE INDEX idx_hunted_products_listing ON hunted_products(listing_id);

-- Hunting and reviewing are team work, recorded like the rest.
ALTER TABLE member_activity DROP CONSTRAINT member_activity_subject_type_check;
ALTER TABLE member_activity ADD CONSTRAINT member_activity_subject_type_check CHECK (subject_type IN ('order', 'listing', 'draft', 'account', 'session', 'hunt'));
