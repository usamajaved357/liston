const { query } = require('../../db/client');

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

const SOURCING_FIELDS = ['status', 'source_platform', 'source_account_id', 'source_order_no', 'placed_at', 'placed_by', 'card_label', 'cost_value', 'cost_currency', 'tracking_number', 'carrier', 'notes', 'dispatched_at', 'dispatched_by', 'ebay_fulfillment_id'];

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

module.exports = {
  listSourceAccounts,
  findSourceAccount,
  createSourceAccount,
  updateSourceAccount,
  listSourcingForOrder,
  listSourcingForOrders,
  upsertSourcing,
  findSourcing,
  addEvent,
  listEvents,
};
