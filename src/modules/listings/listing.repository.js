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

async function createLiveEdit({ connectionId, itemId, sku, generatedData }) {
  const result = await query(
    `INSERT INTO listings (connection_id, sku, external_product_id, edit_of_item_id, generated_data, status)
     VALUES ($1, $2, $3, $3, $4, 'pending_review') RETURNING *`,
    [connectionId, sku, itemId, generatedData]
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
async function updateGeneratedData(id, generatedData) {
  const result = await query(
    `UPDATE listings SET generated_data = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [generatedData, id]
  );
  return result.rows[0];
}

// Recorded only once publish has actually created the objects on eBay.
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

module.exports = {
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
  deleteDraft,
};
