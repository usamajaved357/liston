-- Listing health (see ARCHITECTURE.md §6, Analytics). Most of it is worked
-- out from stored traffic and sales with no table of its own; these keep the
-- two things that can't be recomputed:
--
-- A listing's deeper check, run on request (the full listing, the item
-- specifics its category recommends, optionally the cheapest similar
-- listings): kept so opening the listing again costs nothing.
CREATE TABLE listing_health_checks (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result JSONB NOT NULL,
  PRIMARY KEY (connection_id, item_id)
);

-- What a live edit made in Liston changed, and when, so the listing's
-- figures before and after can be compared ("title changed on 12 Sept:
-- click-through 0.8% → 1.9% since").
CREATE TABLE listing_changes (
  id BIGSERIAL PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fields TEXT[] NOT NULL,          -- title, photos, main_photo, price, specifics, description, quantity
  before JSONB NOT NULL DEFAULT '{}',
  after JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX listing_changes_item ON listing_changes (connection_id, item_id, changed_at DESC);
