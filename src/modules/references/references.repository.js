const { query } = require('../../db/client');

// What a Liston card shows, read from the mirrors Liston already keeps:
// orders (ebay_orders), live listings (the listings:active snapshot),
// drafts (listings) and hunted products. Every read is limited to the
// accounts it's given, which the service has checked the viewer may open.

/** Orders by eBay order number: [{ connectionId, data }]. */
async function ordersByIds(connectionIds, orderIds) {
  if (!connectionIds.length || !orderIds.length) return [];
  const { rows } = await query(`SELECT connection_id, data FROM ebay_orders WHERE connection_id = ANY($1::uuid[]) AND order_id = ANY($2)`, [connectionIds, orderIds]);
  return rows.map((r) => ({ connectionId: r.connection_id, data: r.data }));
}

/** Live listings by eBay item number: [{ connectionId, item }]. */
async function listingsByItemIds(connectionIds, itemIds) {
  if (!connectionIds.length || !itemIds.length) return [];
  const { rows } = await query(
    `SELECT s.connection_id, item FROM ebay_snapshots s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'items', '[]'::jsonb)) item
      WHERE s.connection_id = ANY($1::uuid[]) AND s.kind = 'listings:active' AND item->>'itemId' = ANY($2)`,
    [connectionIds, itemIds]
  );
  return rows.map((r) => ({ connectionId: r.connection_id, item: r.item }));
}

/** Drafts (not yet live) by id: [{ connectionId, id, data, status, createdAt }]. */
async function draftsByIds(connectionIds, ids) {
  if (!connectionIds.length || !ids.length) return [];
  const { rows } = await query(
    `SELECT id, connection_id, generated_data, status, created_at FROM listings
      WHERE connection_id = ANY($1::uuid[]) AND id = ANY($2::uuid[]) AND edit_of_item_id IS NULL`,
    [connectionIds, ids]
  );
  return rows.map((r) => ({ connectionId: r.connection_id, id: r.id, data: r.generated_data || {}, status: r.status, createdAt: r.created_at }));
}

const HUNT_COLUMNS = `h.id, h.connection_id, h.title, h.image_url, h.currency, h.headline_profit, h.headline_roi, h.competitor_item_id, h.created_at,
  CASE WHEN cardinality(h.item_ids) > 0 THEN 'listed' WHEN h.listing_id IS NOT NULL THEN 'drafted' ELSE h.status END AS stage`;

/** Hunted products by id. */
async function huntsByIds(connectionIds, ids) {
  if (!connectionIds.length || !ids.length) return [];
  const { rows } = await query(`SELECT ${HUNT_COLUMNS} FROM hunted_products h WHERE h.connection_id = ANY($1::uuid[]) AND h.id = ANY($2::uuid[])`, [connectionIds, ids]);
  return rows;
}

/** Item photos Liston has read before (order rows' pictures), by item number. */
async function itemImages(itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await query(`SELECT item_id, data->>'imageUrl' AS image FROM ebay_item_summaries WHERE item_id = ANY($1)`, [itemIds]);
  return new Map(rows.filter((r) => r.image).map((r) => [r.item_id, r.image]));
}

/** Which of the owner's accounts has something with this id, when the viewer can't see it (a card that says so). */
async function existsIn(connectionIds, kind, id) {
  if (!connectionIds.length) return false;
  const sql = {
    order: `SELECT 1 FROM ebay_orders WHERE connection_id = ANY($1::uuid[]) AND order_id = $2 LIMIT 1`,
    listing: `SELECT 1 FROM ebay_snapshots s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'items', '[]'::jsonb)) item
               WHERE s.connection_id = ANY($1::uuid[]) AND s.kind = 'listings:active' AND item->>'itemId' = $2 LIMIT 1`,
    draft: `SELECT 1 FROM listings WHERE connection_id = ANY($1::uuid[]) AND id::text = $2 LIMIT 1`,
    hunt: `SELECT 1 FROM hunted_products WHERE connection_id = ANY($1::uuid[]) AND id::text = $2 LIMIT 1`,
  }[kind];
  if (!sql) return false;
  const { rows } = await query(sql, [connectionIds, String(id)]);
  return rows.length > 0;
}

// ---- the "/" picker: things found by words ------------------------------------------

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function searchOrders(connectionIds, q, limit = 5) {
  if (!connectionIds.length) return [];
  const { rows } = await query(
    `SELECT connection_id, data FROM ebay_orders
      WHERE connection_id = ANY($1::uuid[])
        AND (order_id ILIKE $2 OR data->>'buyerUserId' ILIKE $2 OR data->>'buyerName' ILIKE $2 OR data->>'salesRecordNumber' = $3
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'lineItems', '[]'::jsonb)) line WHERE line->>'title' ILIKE $2 OR line->>'itemId' = $3))
      ORDER BY created_at DESC LIMIT $4`,
    [connectionIds, like(q), String(q).trim(), limit]
  );
  return rows.map((r) => ({ connectionId: r.connection_id, data: r.data }));
}

async function searchListings(connectionIds, q, limit = 5) {
  if (!connectionIds.length) return [];
  const { rows } = await query(
    `SELECT s.connection_id, item FROM ebay_snapshots s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'items', '[]'::jsonb)) item
      WHERE s.connection_id = ANY($1::uuid[]) AND s.kind = 'listings:active'
        AND (item->>'title' ILIKE $2 OR item->>'sku' ILIKE $2 OR item->>'itemId' = $3)
      LIMIT $4`,
    [connectionIds, like(q), String(q).trim(), limit]
  );
  return rows.map((r) => ({ connectionId: r.connection_id, item: r.item }));
}

async function searchDrafts(connectionIds, q, limit = 5) {
  if (!connectionIds.length) return [];
  const { rows } = await query(
    `SELECT id, connection_id, generated_data, status, created_at FROM listings
      WHERE connection_id = ANY($1::uuid[]) AND status = 'pending_review' AND edit_of_item_id IS NULL
        AND (generated_data->>'title' ILIKE $2 OR generated_data->>'sku' ILIKE $2)
      ORDER BY created_at DESC LIMIT $3`,
    [connectionIds, like(q), limit]
  );
  return rows.map((r) => ({ connectionId: r.connection_id, id: r.id, data: r.generated_data || {}, status: r.status, createdAt: r.created_at }));
}

async function searchHunts(connectionIds, q, limit = 5) {
  if (!connectionIds.length) return [];
  const { rows } = await query(
    `SELECT ${HUNT_COLUMNS} FROM hunted_products h
      WHERE h.connection_id = ANY($1::uuid[]) AND (h.title ILIKE $2 OR h.competitor_item_id = $3)
      ORDER BY h.created_at DESC LIMIT $4`,
    [connectionIds, like(q), String(q).trim(), limit]
  );
  return rows;
}

module.exports = { ordersByIds, listingsByItemIds, draftsByIds, huntsByIds, itemImages, existsIn, searchOrders, searchListings, searchDrafts, searchHunts };
