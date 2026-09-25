const { query } = require('../../db/client');

// One eBay account connected on several sites (UK and Australia) is one
// account for the plan: connections count once per seller.
async function countByUser(userId) {
  const result = await query(
    `SELECT count(DISTINCT COALESCE(settings->'ebay'->>'userId', settings->'ebay'->>'username', id::text)) FROM connections WHERE user_id = $1`,
    [userId]
  );
  return parseInt(result.rows[0].count, 10);
}

async function getMaxConnectionsForUser(userId) {
  const result = await query(
    `SELECT p.max_connections
     FROM users u JOIN plans p ON p.id = u.plan_id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] ? result.rows[0].max_connections : 0;
}

async function findPlatformByKey(key) {
  const result = await query('SELECT id, key, name, role, status FROM platforms WHERE key = $1', [key]);
  return result.rows[0] || null;
}

// Amazon is dropped from the product scope for now (eBay is the only active
// platform; TikTok Shop is a later, already-partially-built destination) —
// excluded here rather than deleted from the `platforms` table, so the row
// (and any historical data referencing it) stays intact if it's ever revived.
async function findAllPlatforms() {
  const result = await query(
    "SELECT id, key, name, role, status FROM platforms WHERE role IN ('destination', 'both') AND key != 'amazon' ORDER BY name"
  );
  return result.rows;
}

async function findAllByUser(userId) {
  const result = await query(
    `SELECT c.id, c.label, c.status, c.created_at, c.updated_at, c.settings, p.key AS platform_key, p.name AS platform_name
     FROM connections c
     JOIN platforms p ON p.id = c.destination_platform_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function findByIdForUser(id, userId) {
  const result = await query(
    `SELECT c.id, c.user_id, c.label, c.status, c.credentials, c.settings, c.created_at, c.updated_at,
            p.key AS platform_key, p.name AS platform_name
     FROM connections c
     JOIN platforms p ON p.id = c.destination_platform_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

// eBay's notifications name the seller, not the connection. Each eBay
// connection records its username in settings once it's known.
async function findIdsByEbayUsername(username) {
  const result = await query(`SELECT id, user_id FROM connections WHERE settings->'ebay'->>'username' = $1`, [username]);
  return result.rows;
}

// eBay's REST notifications name the seller by immutable user id (and,
// outside the US, username). Either matches.
async function findIdsByEbayUser({ userId, username }) {
  if (!userId && !username) return [];
  const result = await query(
    `SELECT id, user_id FROM connections
     WHERE ($1::text IS NOT NULL AND settings->'ebay'->>'userId' = $1) OR ($2::text IS NOT NULL AND settings->'ebay'->>'username' = $2)`,
    [userId || null, username || null]
  );
  return result.rows;
}

// One owner's connections of the same eBay account (by immutable user id or
// username), each on its own site. `exceptId` leaves one out.
async function findOwnerEbayAccount(ownerId, { userId, username }, exceptId = null) {
  if (!userId && !username) return [];
  const result = await query(
    `SELECT id, label, settings FROM connections
     WHERE user_id = $1 AND ($4::uuid IS NULL OR id <> $4)
       AND (($2::text IS NOT NULL AND settings->'ebay'->>'userId' = $2) OR ($3::text IS NOT NULL AND settings->'ebay'->>'username' = $3))`,
    [ownerId, userId || null, username || null, exceptId]
  );
  return result.rows;
}

// A connection's site and the sites the other connections of its eBay
// account hold: { own, claimed }, or null when the connection is gone.
async function findMarketScope(connectionId) {
  const result = await query(
    `SELECT c.settings->'ebay'->>'marketplaceId' AS own,
            COALESCE(array_agg(DISTINCT o.settings->'ebay'->>'marketplaceId')
              FILTER (WHERE o.settings->'ebay'->>'marketplaceId' IS NOT NULL), '{}') AS claimed
     FROM connections c
     LEFT JOIN connections o ON o.user_id = c.user_id AND o.id <> c.id
      AND ((c.settings->'ebay'->>'userId' IS NOT NULL AND o.settings->'ebay'->>'userId' = c.settings->'ebay'->>'userId')
        OR (c.settings->'ebay'->>'username' IS NOT NULL AND o.settings->'ebay'->>'username' = c.settings->'ebay'->>'username'))
     WHERE c.id = $1
     GROUP BY c.id`,
    [connectionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { own: row.own || null, claimed: row.claimed.filter((id) => id && id !== row.own) };
}

/**
 * Merges fields into settings.ebay in place (one statement, no read first),
 * for bookkeeping written from eBay's callbacks. The push records
 * (`orderPush`, `listingPush`) are merged one level deeper, so a receipt
 * doesn't drop the subscription it belongs to.
 */
async function mergeEbaySettings(id, patch) {
  const { orderPush, listingPush, ...rest } = patch;
  const deeper = (name, n) =>
    `CASE WHEN $${n}::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('${name}', COALESCE(settings->'ebay'->'${name}', '{}'::jsonb) || $${n}::jsonb) END`;
  await query(
    `UPDATE connections SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb), '{ebay}',
       COALESCE(settings->'ebay', '{}'::jsonb) || $2::jsonb || ${deeper('orderPush', 3)} || ${deeper('listingPush', 4)}
     ), updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(rest), orderPush ? JSON.stringify(orderPush) : null, listingPush ? JSON.stringify(listingPush) : null]
  );
}

// All eBay connections, for one-off maintenance (e.g. subscribing every
// account to notifications). Credentials come back encrypted.
async function findAllEbay() {
  const result = await query(
    `SELECT c.id, c.user_id, c.label, c.settings
     FROM connections c JOIN platforms p ON p.id = c.destination_platform_id
     WHERE p.key = 'ebay'`
  );
  return result.rows;
}

async function create({ userId, destinationPlatformId, label, credentials }) {
  const result = await query(
    `INSERT INTO connections (user_id, destination_platform_id, label, credentials)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, status, created_at`,
    [userId, destinationPlatformId, label, credentials]
  );
  return result.rows[0];
}

async function updateCredentials(id, credentials) {
  await query(
    'UPDATE connections SET credentials = $1, updated_at = now() WHERE id = $2',
    [credentials, id]
  );
}

async function updateSettings(id, settings) {
  await query(
    'UPDATE connections SET settings = $1, updated_at = now() WHERE id = $2',
    [settings, id]
  );
}

async function updateStatus(id, status) {
  await query('UPDATE connections SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
}

async function deleteByIdForUser(id, userId) {
  const result = await query('DELETE FROM connections WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rowCount > 0;
}

module.exports = {
  findIdsByEbayUsername,
  findAllEbay,
  countByUser,
  findOwnerEbayAccount,
  findMarketScope,
  getMaxConnectionsForUser,
  findPlatformByKey,
  findAllPlatforms,
  findAllByUser,
  findByIdForUser,
  create,
  updateCredentials,
  updateSettings,
  findIdsByEbayUser,
  mergeEbaySettings,
  updateStatus,
  deleteByIdForUser,
};
