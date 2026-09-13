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
     WHERE l.connection_id = $1 AND c.user_id = $2 AND l.status = 'pending_review'
     ORDER BY l.created_at DESC`,
    [connectionId, userId]
  );
  return result.rows;
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

module.exports = {
  createDraft,
  findByIdForUser,
  findPendingByConnection,
  updateStatus,
};
