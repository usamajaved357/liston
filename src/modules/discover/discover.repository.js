const { query } = require('../../db/client');

// Discover's tables (migration 033): a site's scans of a category or
// keyword, each listing's daily sold count, and the watched subjects.

// ---- scans ----------------------------------------------------------------------

async function getScan(marketplaceId, subject) {
  const { rows } = await query(`SELECT total, listings, breakdown, taken_at FROM discover_scans WHERE marketplace_id = $1 AND subject = $2`, [marketplaceId, subject]);
  return rows[0] || null;
}

async function getScans(marketplaceId, subjects) {
  if (!subjects.length) return new Map();
  const { rows } = await query(`SELECT subject, total, listings, breakdown, taken_at FROM discover_scans WHERE marketplace_id = $1 AND subject = ANY($2)`, [marketplaceId, subjects]);
  return new Map(rows.map((r) => [r.subject, r]));
}

async function saveScan(marketplaceId, subject, { total, listings, breakdown }) {
  await query(
    `INSERT INTO discover_scans (marketplace_id, subject, total, listings, breakdown, taken_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (marketplace_id, subject) DO UPDATE SET total = EXCLUDED.total, listings = EXCLUDED.listings, breakdown = EXCLUDED.breakdown, taken_at = now()`,
    [marketplaceId, subject, total, JSON.stringify(listings), breakdown ? JSON.stringify(breakdown) : null]
  );
}

/** A subject was opened through this account: it's in the nightly shared refresh for a few days. */
async function touchScan(marketplaceId, subject, connectionId) {
  await query(`UPDATE discover_scans SET opened_at = now(), opened_connection_id = $3 WHERE marketplace_id = $1 AND subject = $2`, [marketplaceId, subject, connectionId]);
}

/** Every scan on a site taken since `since`, newest first: the pool for Winners. */
async function scansForSite(marketplaceId, since, limit) {
  const { rows } = await query(`SELECT subject, total, listings, taken_at FROM discover_scans WHERE marketplace_id = $1 AND taken_at >= $2 ORDER BY taken_at DESC LIMIT $3`, [marketplaceId, since, limit]);
  return rows;
}

/** A subject eBay no longer knows: out of the nightly shared refresh. */
async function forgetOpened(marketplaceId, subject) {
  await query(`UPDATE discover_scans SET opened_at = NULL, opened_connection_id = NULL WHERE marketplace_id = $1 AND subject = $2`, [marketplaceId, subject]);
}

/** A site's subjects opened since `since`, most recent first (shared: anyone on the site). */
async function recentlyOpened(marketplaceId, since, limit) {
  const { rows } = await query(
    `SELECT subject, total, listings, breakdown, taken_at, opened_at FROM discover_scans
      WHERE marketplace_id = $1 AND opened_at >= $2 ORDER BY opened_at DESC LIMIT $3`,
    [marketplaceId, since, limit]
  );
  return rows;
}

/** Subjects opened since `since` whose scan is older than `before`, most recently opened first, with the account that opened them. */
async function dueForRefresh(since, before, limit) {
  const { rows } = await query(
    `SELECT s.marketplace_id, s.subject, s.opened_connection_id AS connection_id, c.user_id AS owner_id
       FROM discover_scans s JOIN connections c ON c.id = s.opened_connection_id
      WHERE s.opened_at >= $1 AND s.taken_at < $2 AND c.status = 'active'
      ORDER BY s.opened_at DESC LIMIT $3`,
    [since, before, limit]
  );
  return rows;
}

// ---- listing reads -----------------------------------------------------------------

/** Each listing's latest reading on or after `since` (a day), by item id. */
async function latestReads(marketplaceId, itemIds, since) {
  if (!itemIds.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (item_id) item_id, to_char(day, 'YYYY-MM-DD') AS day, sold, options, category_id, started_at, brand, read_at
       FROM discover_listing_reads
      WHERE marketplace_id = $1 AND item_id = ANY($2) AND day >= $3
      ORDER BY item_id, day DESC`,
    [marketplaceId, itemIds, since]
  );
  return new Map(rows.map((r) => [r.item_id, r]));
}

/** Every reading of these listings since a day (for their recent sales). */
async function readsSince(marketplaceId, itemIds, since) {
  if (!itemIds.length) return [];
  const { rows } = await query(
    `SELECT item_id, to_char(day, 'YYYY-MM-DD') AS day, sold FROM discover_listing_reads
      WHERE marketplace_id = $1 AND item_id = ANY($2) AND day >= $3`,
    [marketplaceId, itemIds, since]
  );
  return rows;
}

async function saveRead(marketplaceId, day, { itemId, sold, options, categoryId, startedAt, brand }) {
  await query(
    `INSERT INTO discover_listing_reads (marketplace_id, item_id, day, sold, options, category_id, started_at, brand, read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (marketplace_id, item_id, day) DO UPDATE
       SET sold = EXCLUDED.sold, options = EXCLUDED.options, category_id = EXCLUDED.category_id, started_at = EXCLUDED.started_at, brand = EXCLUDED.brand, read_at = now()`,
    [marketplaceId, String(itemId), day, sold, options ? JSON.stringify(options) : null, categoryId || null, startedAt || null, brand || null]
  );
}

async function pruneReadsBefore(day) {
  const { rowCount } = await query(`DELETE FROM discover_listing_reads WHERE day < $1`, [day]);
  return rowCount;
}

// ---- watches ------------------------------------------------------------------------

async function watchesFor(connectionId) {
  const { rows } = await query(
    `SELECT w.id, w.kind, w.value, w.label, w.created_at, w.last_read_at, u.name AS created_by_name, u.email AS created_by_email
       FROM discover_watches w LEFT JOIN users u ON u.id = w.created_by
      WHERE w.connection_id = $1 ORDER BY w.created_at DESC`,
    [connectionId]
  );
  return rows;
}

async function findWatch(connectionId, kind, value) {
  const { rows } = await query(`SELECT id FROM discover_watches WHERE connection_id = $1 AND kind = $2 AND value = $3`, [connectionId, kind, value]);
  return rows[0] || null;
}

async function addWatch({ ownerId, connectionId, kind, value, label, createdBy }) {
  const { rows } = await query(
    `INSERT INTO discover_watches (owner_user_id, connection_id, kind, value, label, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, kind, value) DO UPDATE SET label = EXCLUDED.label
     RETURNING id, kind, value, label, created_at, last_read_at`,
    [ownerId, connectionId, kind, value, label, createdBy || null]
  );
  return rows[0];
}

async function removeWatch(connectionId, id) {
  const { rowCount } = await query(`DELETE FROM discover_watches WHERE connection_id = $1 AND id = $2`, [connectionId, id]);
  return rowCount > 0;
}

async function countWatches(connectionId) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM discover_watches WHERE connection_id = $1`, [connectionId]);
  return rows[0].n;
}

/** Watches not read since `before`, oldest first, with their account's owner. */
async function dueWatches(before, limit) {
  const { rows } = await query(
    `SELECT w.id, w.owner_user_id, w.connection_id, w.kind, w.value, w.label
       FROM discover_watches w JOIN connections c ON c.id = w.connection_id
      WHERE c.status = 'active' AND (w.last_read_at IS NULL OR w.last_read_at < $1)
      ORDER BY w.last_read_at NULLS FIRST LIMIT $2`,
    [before, limit]
  );
  return rows;
}

async function markWatchRead(id) {
  await query(`UPDATE discover_watches SET last_read_at = now() WHERE id = $1`, [id]);
}

// ---- the account's own categories ---------------------------------------------------

/** The categories of the listings Liston made for this account, busiest first. */
async function ownCategories(connectionId, limit = 12) {
  const { rows } = await query(
    `SELECT generated_data->>'categoryId' AS id, max(generated_data->>'categoryPath') AS path, count(*)::int AS listings
       FROM listings WHERE connection_id = $1 AND generated_data->>'categoryId' IS NOT NULL
      GROUP BY 1 ORDER BY 3 DESC LIMIT $2`,
    [connectionId, limit]
  );
  return rows;
}

// ---- the owner's takedown history (product research's marks) ------------------------

/** The owner's hunted products a reviewer rejected for brand or VeRO risk: { itemId, title }. */
async function ownerBrandRejections(ownerId) {
  const { rows } = await query(
    `SELECT competitor_item_id AS item_id, title FROM hunted_products
      WHERE owner_user_id = $1 AND status = 'rejected' AND reject_reason = 'brand_risk'`,
    [ownerId]
  );
  return rows.map((r) => ({ itemId: r.item_id, title: r.title }));
}

module.exports = {
  ownerBrandRejections,
  getScan,
  touchScan,
  forgetOpened,
  scansForSite,
  dueForRefresh,
  recentlyOpened,
  getScans,
  saveScan,
  latestReads,
  readsSince,
  saveRead,
  pruneReadsBefore,
  watchesFor,
  findWatch,
  addWatch,
  removeWatch,
  countWatches,
  dueWatches,
  markWatchRead,
  ownCategories,
};
