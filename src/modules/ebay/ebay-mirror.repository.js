const { query } = require('../../db/client');

// The only file that touches the mirror tables (see migration 011). Every
// read here is a plain indexed lookup, which is what makes pages instant:
// the eBay round trip happens in the background, if at all.

// ---- whole-dataset snapshots (listings, active count) --------------------

async function loadSnapshot(connectionId, kind) {
  const result = await query(`SELECT data, meta, synced_at FROM ebay_snapshots WHERE connection_id = $1 AND kind = $2`, [
    connectionId,
    kind,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return { value: row.data, meta: row.meta, syncedAt: new Date(row.synced_at).getTime() };
}

async function saveSnapshot(connectionId, kind, value, meta = {}) {
  await query(
    `INSERT INTO ebay_snapshots (connection_id, kind, data, meta, synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connection_id, kind)
     DO UPDATE SET data = EXCLUDED.data, meta = EXCLUDED.meta, synced_at = now()`,
    [connectionId, kind, JSON.stringify(value), JSON.stringify(meta || {})]
  );
}

// ---- orders, one row each ------------------------------------------------

async function loadOrders(connectionId, since) {
  const result = await query(
    `SELECT data FROM ebay_orders WHERE connection_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [connectionId, since]
  );
  return result.rows.map((row) => row.data);
}

// Upserts in one statement per batch of 200 — a 90-day initial sync of a
// busy account is a few thousand orders, and one round trip per order would
// be the slow part.
async function upsertOrders(connectionId, orders) {
  const BATCH = 200;
  for (let i = 0; i < orders.length; i += BATCH) {
    const batch = orders.slice(i, i + BATCH);
    const values = [];
    const params = [connectionId];
    for (const order of batch) {
      params.push(order.orderId, order.createdAt, JSON.stringify(order));
      const n = params.length;
      values.push(`($1, $${n - 2}, $${n - 1}, $${n}, now())`);
    }
    await query(
      `INSERT INTO ebay_orders (connection_id, order_id, created_at, data, synced_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (connection_id, order_id)
       DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, synced_at = now()`,
      params
    );
  }
}

async function pruneOrdersBefore(connectionId, before) {
  await query(`DELETE FROM ebay_orders WHERE connection_id = $1 AND created_at < $2`, [connectionId, before]);
}

async function deleteOrders(connectionId) {
  await query(`DELETE FROM ebay_orders WHERE connection_id = $1`, [connectionId]);
}

// ---- order money (Finances API), one row per order -------------------------

async function upsertOrderFinances(connectionId, rows) {
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const params = [connectionId];
    for (const r of batch) {
      params.push(r.orderId, r.currency, r.gross, r.fees, r.adFees, r.refunds, r.earnings, r.fundsStatus, r.saleDate);
      const n = params.length;
      values.push(`($1, ${Array.from({ length: 9 }, (_, k) => `$${n - 8 + k}`).join(', ')}, now())`);
    }
    await query(
      `INSERT INTO ebay_order_finances (connection_id, order_id, currency, gross, fees, ad_fees, refunds, earnings, funds_status, sale_date, synced_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (connection_id, order_id) DO UPDATE SET
         currency = EXCLUDED.currency, gross = EXCLUDED.gross, fees = EXCLUDED.fees, ad_fees = EXCLUDED.ad_fees,
         refunds = EXCLUDED.refunds, earnings = EXCLUDED.earnings, funds_status = EXCLUDED.funds_status,
         sale_date = EXCLUDED.sale_date, synced_at = now()`,
      params
    );
  }
}

/** orderId -> { currency, gross, fees, adFees, refunds, earnings, fundsStatus } */
async function loadOrderFinances(connectionId, orderIds) {
  if (!orderIds.length) return new Map();
  const result = await query(
    `SELECT order_id, currency, gross, fees, ad_fees, refunds, earnings, funds_status FROM ebay_order_finances
     WHERE connection_id = $1 AND order_id = ANY($2)`,
    [connectionId, orderIds]
  );
  return new Map(
    result.rows.map((r) => [
      r.order_id,
      { currency: r.currency, gross: Number(r.gross), fees: Number(r.fees), adFees: Number(r.ad_fees), refunds: Number(r.refunds), earnings: Number(r.earnings), fundsStatus: r.funds_status },
    ])
  );
}

// ---- item summaries --------------------------------------------------------

async function loadItemSummaries(itemIds) {
  if (!itemIds.length) return new Map();
  const result = await query(`SELECT item_id, data, fetched_at FROM ebay_item_summaries WHERE item_id = ANY($1)`, [itemIds]);
  return new Map(result.rows.map((row) => [row.item_id, { summary: row.data, fetchedAt: new Date(row.fetched_at).getTime() }]));
}

async function saveItemSummary(itemId, summary) {
  await query(
    `INSERT INTO ebay_item_summaries (item_id, data, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (item_id) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
    [itemId, JSON.stringify(summary)]
  );
}

module.exports = {
  loadSnapshot,
  saveSnapshot,
  loadOrders,
  upsertOrders,
  pruneOrdersBefore,
  deleteOrders,
  loadItemSummaries,
  saveItemSummary,
  upsertOrderFinances,
  loadOrderFinances,
};
