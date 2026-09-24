const { query } = require('../../db/client');
const activity = require('../team/activity');
const activityRepository = require('../team/activity.repository');

// --- supplier buying accounts ---------------------------------------------

async function listSourceAccounts(ownerId, { includeArchived = false } = {}) {
  const result = await query(
    `SELECT * FROM source_accounts WHERE owner_user_id = $1 ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY label ASC`,
    [ownerId]
  );
  return result.rows;
}

async function findSourceAccount(id, ownerId) {
  const result = await query(`SELECT * FROM source_accounts WHERE id = $1 AND owner_user_id = $2`, [id, ownerId]);
  return result.rows[0] || null;
}

async function createSourceAccount({ ownerId, platform = 'aliexpress', label, email, password = null, notes = null }) {
  const result = await query(
    `INSERT INTO source_accounts (owner_user_id, platform, label, email, password, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ownerId, platform, label, email, password, notes]
  );
  return result.rows[0];
}

async function updateSourceAccount(id, ownerId, patch) {
  const fields = [];
  const values = [];
  for (const key of ['label', 'email', 'password', 'notes', 'platform']) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      fields.push(`${key} = $${values.length}`);
    }
  }
  if (patch.archived !== undefined) {
    fields.push(`archived_at = ${patch.archived ? 'now()' : 'NULL'}`);
  }
  if (!fields.length) return findSourceAccount(id, ownerId);
  values.push(id, ownerId);
  const result = await query(
    `UPDATE source_accounts SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length - 1} AND owner_user_id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

// --- per-line sourcing -----------------------------------------------------

const SOURCING_SELECT = `
  s.*,
  a.label AS source_account_label, a.email AS source_account_email,
  pb.name AS placed_by_name, pb.email AS placed_by_email,
  db.name AS dispatched_by_name`;

async function listSourcingForOrder(connectionId, orderId) {
  const result = await query(
    `SELECT ${SOURCING_SELECT} FROM order_sourcing s
     LEFT JOIN source_accounts a ON a.id = s.source_account_id
     LEFT JOIN users pb ON pb.id = s.placed_by
     LEFT JOIN users db ON db.id = s.dispatched_by
     WHERE s.connection_id = $1 AND s.order_id = $2
     ORDER BY s.created_at ASC`,
    [connectionId, orderId]
  );
  return result.rows;
}

/** Every order's line statuses on an account: orderId → ['ordered', …]. */
async function sourcingStatusesByOrder(connectionId) {
  const result = await query(
    `SELECT order_id, array_agg(status) AS statuses FROM order_sourcing WHERE connection_id = $1 GROUP BY order_id`,
    [connectionId]
  );
  return new Map(result.rows.map((r) => [r.order_id, r.statuses]));
}

async function listSourcingForOrders(connectionId, orderIds) {
  if (!orderIds.length) return [];
  const result = await query(
    `SELECT ${SOURCING_SELECT} FROM order_sourcing s
     LEFT JOIN source_accounts a ON a.id = s.source_account_id
     LEFT JOIN users pb ON pb.id = s.placed_by
     LEFT JOIN users db ON db.id = s.dispatched_by
     WHERE s.connection_id = $1 AND s.order_id = ANY($2)`,
    [connectionId, orderIds]
  );
  return result.rows;
}

const SOURCING_FIELDS = ['status', 'source_platform', 'source_account_id', 'source_email', 'source_password', 'source_order_no', 'placed_at', 'placed_by', 'card_label', 'cost_value', 'cost_currency', 'tracking_number', 'carrier', 'notes', 'dispatched_at', 'dispatched_by', 'ebay_fulfillment_id'];

// Creates or updates the one row for this line item.
async function upsertSourcing({ connectionId, orderId, lineItemId, ...patch }) {
  const cols = ['connection_id', 'order_id', 'line_item_id'];
  const values = [connectionId, orderId, lineItemId];
  const updates = [];
  for (const key of SOURCING_FIELDS) {
    if (patch[key] !== undefined) {
      cols.push(key);
      values.push(patch[key]);
      updates.push(`${key} = EXCLUDED.${key}`);
    }
  }
  const placeholders = values.map((_, i) => `$${i + 1}`);
  const result = await query(
    `INSERT INTO order_sourcing (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (connection_id, order_id, line_item_id)
     DO UPDATE SET ${[...updates, 'updated_at = now()'].join(', ')}
     RETURNING *`,
    values
  );
  return result.rows[0];
}

async function findSourcing(connectionId, orderId, lineItemId) {
  const result = await query(`SELECT * FROM order_sourcing WHERE connection_id = $1 AND order_id = $2 AND line_item_id = $3`, [connectionId, orderId, lineItemId]);
  return result.rows[0] || null;
}

// --- timeline --------------------------------------------------------------

async function addEvent({ connectionId, orderId, lineItemId = null, kind, detail = {}, actorUserId = null }) {
  const result = await query(
    `INSERT INTO order_events (connection_id, order_id, line_item_id, kind, detail, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [connectionId, orderId, lineItemId, kind, JSON.stringify(detail), actorUserId]
  );
  // Someone's work on an order also goes on their team activity record.
  const activityKind = actorUserId ? activity.kindForOrderEvent(kind) : null;
  if (activityKind) {
    await activityRepository.record({
      actorUserId,
      connectionId,
      kind: activityKind,
      subjectType: 'order',
      subjectId: orderId,
      subjectPart: lineItemId,
      detail: { ...detail, event: kind },
    });
  }
  return result.rows[0];
}

async function listEvents(connectionId, orderId) {
  const result = await query(
    `SELECT e.*, u.name AS actor_name, u.email AS actor_email FROM order_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.connection_id = $1 AND e.order_id = $2 ORDER BY e.created_at DESC`,
    [connectionId, orderId]
  );
  return result.rows;
}

// --- archive ---------------------------------------------------------------

async function archiveOrder(connectionId, orderId, actorUserId) {
  await query(
    `INSERT INTO archived_orders (connection_id, order_id, archived_by) VALUES ($1, $2, $3)
     ON CONFLICT (connection_id, order_id) DO UPDATE SET archived_by = EXCLUDED.archived_by, archived_at = now()`,
    [connectionId, orderId, actorUserId]
  );
}

async function unarchiveOrder(connectionId, orderId) {
  await query(`DELETE FROM archived_orders WHERE connection_id = $1 AND order_id = $2`, [connectionId, orderId]);
}

async function findArchived(connectionId, orderId) {
  const result = await query(`SELECT * FROM archived_orders WHERE connection_id = $1 AND order_id = $2`, [connectionId, orderId]);
  return result.rows[0] || null;
}

async function listArchivedOrderIds(connectionId) {
  const result = await query(`SELECT order_id FROM archived_orders WHERE connection_id = $1`, [connectionId]);
  return result.rows.map((r) => r.order_id);
}

// What the supplier orders for these eBay orders cost, summed per order:
// orderId -> { value, currency }. Lines with no cost entered don't count.
async function sourceCostsByOrder(connectionId, orderIds) {
  if (!orderIds.length) return new Map();
  const result = await query(
    `SELECT order_id, cost_currency, sum(cost_value)::float AS cost FROM order_sourcing
     WHERE connection_id = $1 AND order_id = ANY($2) AND cost_value IS NOT NULL
     GROUP BY order_id, cost_currency`,
    [connectionId, orderIds]
  );
  return new Map(result.rows.map((r) => [r.order_id, { value: Number(r.cost), currency: r.cost_currency }]));
}

module.exports = {
  sourceCostsByOrder,
  archiveOrder,
  unarchiveOrder,
  findArchived,
  listArchivedOrderIds,
  listSourceAccounts,
  findSourceAccount,
  createSourceAccount,
  updateSourceAccount,
  listSourcingForOrder,
  listSourcingForOrders, sourcingStatusesByOrder,
  upsertSourcing,
  findSourcing,
  addEvent,
  listEvents,
};
