// Team activity rebuilt from the order timeline: every order_events row
// with an actor becomes its member_activity row (the same mapping as
// team/activity.js kindForOrderEvent and migration 021's first fill).
// Used by scripts/copy-account.js when a database's activity is missing
// for an account's order history (e.g. copied from before 021).
const BACKFILL_SQL = `
INSERT INTO member_activity (owner_user_id, actor_user_id, connection_id, connection_label, kind, subject_type, subject_id, subject_part, title, amount, currency, detail, created_at)
SELECT c.user_id, e.actor_user_id, e.connection_id, c.label,
  CASE
    WHEN e.kind = 'sourcing.ordered' THEN 'order.supplier_ordered'
    WHEN e.kind = 'ebay.dispatched_by_liston' THEN 'order.dispatched'
    WHEN e.kind = 'ebay.refunded_by_liston' THEN 'order.refunded'
    WHEN e.kind IN ('ebay.cancelled_by_liston', 'ebay.cancel_approved_by_liston') THEN 'order.cancelled'
    WHEN e.kind = 'ebay.cancel_declined_by_liston' THEN 'order.cancel_declined'
    WHEN e.kind LIKE 'ebay.return\\_%\\_by_liston' THEN 'order.return_handled'
    WHEN e.kind LIKE 'ebay.inquiry\\_%\\_by_liston' THEN 'order.inquiry_handled'
    WHEN e.kind LIKE 'ebay.dispute\\_%\\_by_liston' THEN 'order.dispute_handled'
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
WHERE e.connection_id = ANY($1) AND e.actor_user_id IS NOT NULL
  AND (e.kind IN ('sourcing.ordered', 'ebay.dispatched_by_liston', 'ebay.refunded_by_liston', 'ebay.cancelled_by_liston', 'ebay.cancel_approved_by_liston', 'ebay.cancel_declined_by_liston', 'archived', 'unarchived', 'note')
    OR e.kind LIKE 'ebay.return\\_%\\_by_liston' OR e.kind LIKE 'ebay.inquiry\\_%\\_by_liston' OR e.kind LIKE 'ebay.dispute\\_%\\_by_liston')`;

/** Replaces these accounts' order-derived activity with a fresh fill from order_events; returns rows added. */
async function rebuildOrderActivity(db, connectionIds) {
  if (!connectionIds.length) return 0;
  await db.query(`DELETE FROM member_activity WHERE connection_id = ANY($1) AND subject_type = 'order'`, [connectionIds]);
  const result = await db.query(BACKFILL_SQL, [connectionIds]);
  return result.rowCount;
}

module.exports = { BACKFILL_SQL, rebuildOrderActivity };
