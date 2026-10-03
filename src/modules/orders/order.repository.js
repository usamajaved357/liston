const { pool, query } = require('../../db/client');
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

/**
 * The orders on an account Liston marked dispatched: orderId → { lines, at,
 * by, tracked } — how many lines, when the last was, who did it (their name,
 * else email), and whether any went with a tracking number.
 */
async function dispatchesByOrder(connectionId) {
  const result = await query(
    `SELECT s.order_id,
            count(*)::int AS lines,
            max(s.dispatched_at) AS at,
            bool_or(s.tracking_number IS NOT NULL) AS tracked,
            (array_agg(COALESCE(u.name, u.email) ORDER BY s.dispatched_at DESC))[1] AS by_name
       FROM order_sourcing s LEFT JOIN users u ON u.id = s.dispatched_by
      WHERE s.connection_id = $1 AND s.dispatched_at IS NOT NULL
      GROUP BY s.order_id`,
    [connectionId]
  );
  return new Map(result.rows.map((r) => [r.order_id, { lines: r.lines, at: new Date(r.at).toISOString(), by: r.by_name || null, tracked: Boolean(r.tracked) }]));
}

// ---- messages Liston sent buyers by itself (migrations 037, 048) ----------------

/** The orders on an account already sent (or claimed, refused or skipped for) a message of this kind. */
async function messagedOrderIds(connectionId, kind) {
  const result = await query('SELECT order_id FROM order_messages WHERE connection_id = $1 AND kind = $2', [connectionId, kind]);
  return new Set(result.rows.map((r) => r.order_id));
}

/** Records a message sent (or refused): once per order and kind, whatever happens later. */
async function saveMessage({ connectionId, orderId, kind, status, buyer, itemId, text, error = null, conversationId = null }) {
  await query(
    `INSERT INTO order_messages (connection_id, order_id, kind, status, buyer, item_id, text, error, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (connection_id, order_id, kind) DO NOTHING`,
    [connectionId, orderId, kind, status, buyer || null, itemId || null, text || null, error ? String(error).slice(0, 500) : null, conversationId]
  );
}

/**
 * Claims the right to send one order its message, before eBay is asked:
 * resolves to 'claimed' (send it, then finishMessage), 'taken' (another run
 * has it, or it was dealt with before) or 'skipped' (with `buyerGapHours`,
 * this buyer was sent this message on another order that recently; noted
 * with that order). An eBay order number is eBay's alone, so an order
 * claimed by any connection is taken for all of them: an eBay account
 * connected once per site, or in two workspaces, messages it once. The
 * check and the claim happen under a lock on the kind and the buyer (the
 * same whichever connection asks), so two runs at once can't both pass.
 */
async function claimMessage({ connectionId, orderId, kind, buyer, itemId, text, buyerGapHours = 0 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`order-message:${kind}:${buyer || orderId}`]);
    const known = await client.query('SELECT 1 FROM order_messages WHERE order_id = $1 AND kind = $2', [orderId, kind]);
    if (known.rowCount) {
      await client.query('COMMIT');
      return 'taken';
    }
    let status = 'sending';
    let error = null;
    if (buyerGapHours > 0 && buyer) {
      const recent = await client.query(
        `SELECT order_id FROM order_messages
          WHERE connection_id = $1 AND kind = $2 AND buyer = $3 AND status IN ('sending', 'sent') AND sent_at > now() - make_interval(hours => $4)
          ORDER BY sent_at DESC LIMIT 1`,
        [connectionId, kind, buyer, buyerGapHours]
      );
      if (recent.rowCount) {
        status = 'skipped';
        error = `Already sent to this buyer for order ${recent.rows[0].order_id} in the last ${buyerGapHours} hours`;
      }
    }
    await client.query(
      `INSERT INTO order_messages (connection_id, order_id, kind, status, buyer, item_id, text, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (connection_id, order_id, kind) DO NOTHING`,
      [connectionId, orderId, kind, status, buyer || null, itemId || null, status === 'skipped' ? null : text || null, error]
    );
    await client.query('COMMIT');
    return status === 'skipped' ? 'skipped' : 'claimed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** How a claimed message went: 'sent' (with eBay's conversation) or 'failed' (with eBay's reason). Never tried again. */
async function finishMessage({ connectionId, orderId, kind, status, error = null, conversationId = null }) {
  await query(
    `UPDATE order_messages SET status = $4, error = $5, conversation_id = $6, sent_at = now()
      WHERE connection_id = $1 AND order_id = $2 AND kind = $3 AND status = 'sending'`,
    [connectionId, orderId, kind, status, error ? String(error).slice(0, 500) : null, conversationId]
  );
}

/**
 * A claim left 'sending' (the server stopped while eBay was being asked) is
 * closed as failed after a while: eBay may or may not have taken it, and
 * sending again could message the buyer twice, so it isn't.
 */
async function closeStaleClaims(minutes = 15) {
  const result = await query(
    `UPDATE order_messages SET status = 'failed', error = 'Interrupted while eBay was being asked, so not sent again in case it arrived'
      WHERE status = 'sending' AND sent_at < now() - make_interval(mins => $1)`,
    [minutes]
  );
  return result.rowCount;
}

async function messagesForOrder(connectionId, orderId) {
  const result = await query('SELECT kind, status, error, sent_at FROM order_messages WHERE connection_id = $1 AND order_id = $2 ORDER BY sent_at', [connectionId, orderId]);
  return result.rows.map((r) => ({ kind: r.kind, status: r.status, error: r.error, sentAt: new Date(r.sent_at).toISOString() }));
}

/** An account's latest messages, and how many of each kind went, failed or were skipped in the last 30 days (for Settings). */
async function recentMessages(connectionId, limit = 10) {
  const [rows, counts] = await Promise.all([
    query("SELECT order_id, kind, status, buyer, error, sent_at FROM order_messages WHERE connection_id = $1 AND status <> 'sending' ORDER BY sent_at DESC LIMIT $2", [connectionId, limit]),
    query(
      `SELECT kind, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'skipped')::int AS skipped
         FROM order_messages WHERE connection_id = $1 AND sent_at > now() - interval '30 days' GROUP BY kind`,
      [connectionId]
    ),
  ]);
  const byKind = {};
  for (const r of counts.rows) byKind[r.kind] = { sent: r.sent, failed: r.failed, skipped: r.skipped };
  const total = (key) => counts.rows.reduce((n, r) => n + r[key], 0);
  return {
    items: rows.rows.map((r) => ({ orderId: r.order_id, kind: r.kind, status: r.status, buyer: r.buyer, error: r.error, sentAt: new Date(r.sent_at).toISOString() })),
    last30: { sent: total('sent'), failed: total('failed'), byKind },
  };
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
  messagedOrderIds,
  saveMessage,
  claimMessage,
  finishMessage,
  closeStaleClaims,
  messagesForOrder,
  recentMessages,
  dispatchesByOrder,
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
