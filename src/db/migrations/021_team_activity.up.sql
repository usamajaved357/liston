-- What each person on a team did in Liston, one row per action: the
-- source for a member's page (performance by day/week/month, the activity
-- log) and, later, salaries. Append-only; rows are never edited.
--
-- Members are no longer deleted: removing one sets `deactivated_at` (login
-- refused, access kept for a restore), so their history keeps its name.
ALTER TABLE users ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;

CREATE TABLE member_activity (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
  -- Kept with the row so a disconnected account still reads by name.
  connection_label TEXT,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('order', 'listing', 'draft')),
  subject_id TEXT NOT NULL,
  -- An order's line item (one supplier order per line), else null.
  subject_part TEXT,
  title TEXT,
  amount NUMERIC(12, 2),
  currency TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_member_activity_actor ON member_activity(owner_user_id, actor_user_id, created_at DESC);
CREATE INDEX idx_member_activity_connection ON member_activity(connection_id, created_at DESC);

-- History from before this table: every order action someone made in
-- Liston is already in order_events with its actor.
INSERT INTO member_activity (owner_user_id, actor_user_id, connection_id, connection_label, kind, subject_type, subject_id, subject_part, title, amount, currency, detail, created_at)
SELECT c.user_id, e.actor_user_id, e.connection_id, c.label,
  CASE
    WHEN e.kind = 'sourcing.ordered' THEN 'order.supplier_ordered'
    WHEN e.kind = 'ebay.dispatched_by_liston' THEN 'order.dispatched'
    WHEN e.kind = 'ebay.refunded_by_liston' THEN 'order.refunded'
    WHEN e.kind IN ('ebay.cancelled_by_liston', 'ebay.cancel_approved_by_liston') THEN 'order.cancelled'
    WHEN e.kind = 'ebay.cancel_declined_by_liston' THEN 'order.cancel_declined'
    WHEN e.kind LIKE 'ebay.return\_%\_by_liston' THEN 'order.return_handled'
    WHEN e.kind LIKE 'ebay.inquiry\_%\_by_liston' THEN 'order.inquiry_handled'
    WHEN e.kind LIKE 'ebay.dispute\_%\_by_liston' THEN 'order.dispute_handled'
    WHEN e.kind = 'archived' THEN 'order.archived'
    WHEN e.kind = 'unarchived' THEN 'order.unarchived'
    WHEN e.kind = 'note' THEN 'order.note'
  END,
  'order', e.order_id, e.line_item_id,
  o.data->'lineItems'->0->>'title',
  NULLIF(o.data->'total'->>'amount', '')::numeric,
  o.data->'total'->>'currency',
  e.detail || jsonb_build_object('event', e.kind),
  e.created_at
FROM order_events e
JOIN connections c ON c.id = e.connection_id
LEFT JOIN ebay_orders o ON o.connection_id = e.connection_id AND o.order_id = e.order_id
WHERE e.actor_user_id IS NOT NULL
  AND (e.kind IN ('sourcing.ordered', 'ebay.dispatched_by_liston', 'ebay.refunded_by_liston', 'ebay.cancelled_by_liston', 'ebay.cancel_approved_by_liston', 'ebay.cancel_declined_by_liston', 'archived', 'unarchived', 'note')
    OR e.kind LIKE 'ebay.return\_%\_by_liston' OR e.kind LIKE 'ebay.inquiry\_%\_by_liston' OR e.kind LIKE 'ebay.dispute\_%\_by_liston');
