const { query } = require('../../db/client');

async function createDraft({ connectionId, sku, platformOfferId, platformGroupKey, sourceData = null, generatedData, status = 'pending_review' }) {
  const result = await query(
    `INSERT INTO listings (connection_id, sku, platform_offer_id, platform_group_key, source_data, generated_data, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [connectionId, sku, platformOfferId, platformGroupKey, sourceData, generatedData, status]
  );
  return result.rows[0];
}

// Joined through connections so ownership is enforced at the query level —
// a listing id alone never leaks another user's draft.
async function findByIdForUser(id, userId) {
  const result = await query(
    `SELECT l.*
     FROM listings l
     JOIN connections c ON c.id = l.connection_id
     WHERE l.id = $1 AND c.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function findPendingByConnection(connectionId, userId) {
  const result = await query(
    `SELECT l.*
     FROM listings l
     JOIN connections c ON c.id = l.connection_id
     WHERE l.connection_id = $1 AND c.user_id = $2 AND l.status = 'pending_review' AND l.edit_of_item_id IS NULL
     ORDER BY l.created_at DESC`,
    [connectionId, userId]
  );
  return result.rows;
}

// The in-progress edit of a live listing, if there is one, so reopening
// Edit resumes it rather than starting a second copy.
async function findLiveEdit(connectionId, userId, itemId) {
  const result = await query(
    `SELECT l.* FROM listings l JOIN connections c ON c.id = l.connection_id
     WHERE l.connection_id = $1 AND c.user_id = $2 AND l.edit_of_item_id = $3 AND l.status = 'pending_review'
     ORDER BY l.created_at DESC LIMIT 1`,
    [connectionId, userId, itemId]
  );
  return result.rows[0] || null;
}

async function createLiveEdit({ connectionId, itemId, sku, generatedData, sourceData = null }) {
  const result = await query(
    `INSERT INTO listings (connection_id, sku, external_product_id, edit_of_item_id, generated_data, source_data, status)
     VALUES ($1, $2, $3, $3, $4, $5, 'pending_review') RETURNING *`,
    [connectionId, sku, itemId, generatedData, sourceData]
  );
  return result.rows[0];
}

// The most recent listing Liston itself published as this eBay item: its
// draft is the best possible starting point for an edit (plain description
// with formatting markers, clean specifics, per-variation images).
async function findPublishedByItemId(connectionId, itemId) {
  const result = await query(
    `SELECT * FROM listings WHERE connection_id = $1 AND external_product_id = $2 AND status = 'published' AND edit_of_item_id IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [connectionId, itemId]
  );
  return result.rows[0] || null;
}

async function findAllByItemId(connectionId, itemId) {
  const result = await query('SELECT * FROM listings WHERE connection_id = $1 AND external_product_id = $2', [connectionId, itemId]);
  return result.rows;
}

async function deleteByItemId(connectionId, itemId) {
  await query('DELETE FROM listings WHERE connection_id = $1 AND external_product_id = $2', [connectionId, itemId]);
}

async function deleteById(id) {
  await query('DELETE FROM listings WHERE id = $1', [id]);
}

async function updateStatus(id, status, { externalProductId, errorMessage } = {}) {
  const result = await query(
    `UPDATE listings
     SET status = $1, external_product_id = $2, error_message = $3, updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [status, externalProductId || null, errorMessage || null, id]
  );
  return result.rows[0];
}

// The edited draft, wholesale. `generated_data` is the single source of
// truth for a draft (eBay holds nothing until publish), so an edit is just a
// rewrite of this column.
// Another Liston record on this connection carrying the SKU — as its own
// custom label, or as the label a live edit / published listing was given.
async function findOtherWithSku(connectionId, sku, excludeId = null) {
  const result = await query(
    `SELECT id, status, external_product_id FROM listings
     WHERE connection_id = $1 AND ($3::uuid IS NULL OR id <> $3)
       AND (sku = $2 OR generated_data->>'sku' = $2)
     ORDER BY (status = 'published') DESC, created_at DESC
     LIMIT 1`,
    [connectionId, sku, excludeId]
  );
  return result.rows[0] || null;
}

async function updateGeneratedData(id, generatedData) {
  const result = await query(
    `UPDATE listings SET generated_data = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [generatedData, id]
  );
  return result.rows[0];
}

// Recorded only once publish has actually created the objects on eBay.
/** A working copy's notes (the live snapshot, whether the listing had ended). */
async function updateSourceData(id, sourceData) {
  const result = await query('UPDATE listings SET source_data = $1, updated_at = now() WHERE id = $2 RETURNING *', [sourceData, id]);
  return result.rows[0];
}

/** A published listing now lives under a new eBay item number (after a relist). */
async function setExternalProductId(id, itemId) {
  const result = await query('UPDATE listings SET external_product_id = $1, updated_at = now() WHERE id = $2 RETURNING *', [String(itemId), id]);
  return result.rows[0];
}

async function setPlatformIds(id, { platformOfferId, platformGroupKey }) {
  const result = await query(
    `UPDATE listings
     SET platform_offer_id = $1, platform_group_key = $2, updated_at = now()
     WHERE id = $3
     RETURNING *`,
    [platformOfferId || null, platformGroupKey || null, id]
  );
  return result.rows[0];
}

// Ownership is enforced in the statement itself (same join as
// findByIdForUser), so a listing id alone can never delete someone else's
// draft. Returns the deleted row, or undefined when nothing matched.
async function deleteDraft(id, userId) {
  const result = await query(
    `DELETE FROM listings l
     USING connections c
     WHERE l.connection_id = c.id AND l.id = $1 AND c.user_id = $2
     RETURNING l.*`,
    [id, userId]
  );
  return result.rows[0] || null;
}

/** Liston's drafts of these published eBay items: itemId -> generated_data. */
async function findPublishedDataByItemIds(connectionId, itemIds) {
  if (!itemIds.length) return new Map();
  const result = await query(
    `SELECT DISTINCT ON (external_product_id) external_product_id, generated_data FROM listings
     WHERE connection_id = $1 AND status = 'published' AND edit_of_item_id IS NULL AND external_product_id = ANY($2)
     ORDER BY external_product_id, updated_at DESC`,
    [connectionId, itemIds.map(String)]
  );
  return new Map(result.rows.map((r) => [r.external_product_id, r.generated_data]));
}

// ---- what live edits changed (migration 020) ---------------------------------

async function recordListingChange(connectionId, itemId, { fields, before, after }) {
  await query('INSERT INTO listing_changes (connection_id, item_id, fields, before, after) VALUES ($1, $2, $3, $4, $5)', [connectionId, String(itemId), fields, before, after]);
}

/** The most recent changes to a listing, newest first. */
async function listingChanges(connectionId, itemId, limit = 5) {
  const result = await query(
    'SELECT id, changed_at, fields, before, after FROM listing_changes WHERE connection_id = $1 AND item_id = $2 ORDER BY changed_at DESC LIMIT $3',
    [connectionId, String(itemId), limit]
  );
  return result.rows;
}

/** Each listing's latest change since a time: itemId -> { changed_at, fields }. */
async function latestChanges(connectionId, since) {
  const result = await query(
    'SELECT DISTINCT ON (item_id) item_id, changed_at, fields FROM listing_changes WHERE connection_id = $1 AND changed_at >= $2 ORDER BY item_id, changed_at DESC',
    [connectionId, since]
  );
  return new Map(result.rows.map((r) => [r.item_id, r]));
}

// An account's listing work for the Overview: drafts created and listings
// published from Liston between two times, and drafts waiting now. Edits of
// live listings (edit_of_item_id) aren't new listings and don't count.
async function countListingWork(connectionId, start, end) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS drafted,
       count(*) FILTER (WHERE status = 'published' AND updated_at >= $2 AND updated_at < $3)::int AS published,
       count(*) FILTER (WHERE status = 'pending_review')::int AS waiting
     FROM listings WHERE connection_id = $1 AND edit_of_item_id IS NULL`,
    [connectionId, start, end]
  );
  return rows[0] || { drafted: 0, published: 0, waiting: 0 };
}

module.exports = {
  countListingWork,
  latestChanges,
  findPublishedDataByItemIds,
  recordListingChange,
  listingChanges,
  findOtherWithSku,
  findLiveEdit,
  createLiveEdit,
  findPublishedByItemId,
  deleteById,
  findAllByItemId,
  deleteByItemId,
  createDraft,
  findByIdForUser,
  findPendingByConnection,
  updateStatus,
  updateGeneratedData,
  setPlatformIds,
  setExternalProductId,
  updateSourceData,
  deleteDraft,
};
