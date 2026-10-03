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

// The Drafts tab: each draft with where it came from — the hunted product
// it was drafted from (who hunted it, who approved it, found in Discover or
// Product research), who drafted it (or that it drafted itself on
// approval), and who last worked on it and when (member_activity).
async function findPendingByConnection(connectionId, userId) {
  const result = await query(
    `SELECT l.*,
            h.id AS hunt_id, h.added_from AS hunt_added_from,
            hu.name AS hunter_name, hu.email AS hunter_email,
            rv.name AS reviewer_name, rv.email AS reviewer_email,
            d.actor_name AS drafted_by_name, d.actor_email AS drafted_by_email, d.automatic AS drafted_automatically,
            w.actor_name AS edited_by_name, w.actor_email AS edited_by_email, w.created_at AS edited_at
     FROM listings l
     JOIN connections c ON c.id = l.connection_id
     LEFT JOIN LATERAL (SELECT * FROM hunted_products hp WHERE hp.listing_id = l.id ORDER BY hp.created_at DESC LIMIT 1) h ON true
     LEFT JOIN users hu ON hu.id = h.hunter_user_id
     LEFT JOIN users rv ON rv.id = h.reviewer_user_id
     LEFT JOIN LATERAL (
       SELECT u.name AS actor_name, u.email AS actor_email, COALESCE((ma.detail->>'automatic')::boolean, false) AS automatic
       FROM member_activity ma LEFT JOIN users u ON u.id = ma.actor_user_id
       WHERE ma.subject_type = 'draft' AND ma.subject_id = l.id::text AND ma.kind = 'listing.drafted'
       ORDER BY ma.created_at LIMIT 1
     ) d ON true
     LEFT JOIN LATERAL (
       SELECT u.name AS actor_name, u.email AS actor_email, ma.created_at
       FROM member_activity ma LEFT JOIN users u ON u.id = ma.actor_user_id
       WHERE ma.subject_type = 'draft' AND ma.subject_id = l.id::text AND ma.kind = 'listing.draft_edited'
       ORDER BY ma.created_at DESC LIMIT 1
     ) w ON true
     WHERE l.connection_id = $1 AND c.user_id = $2 AND l.status = 'pending_review' AND l.edit_of_item_id IS NULL
     ORDER BY l.created_at DESC`,
    [connectionId, userId]
  );
  const person = (name, email) => (name || email ? { name: name || String(email).split('@')[0], email: email || null } : null);
  return result.rows.map((r) => {
    const { hunt_id, hunt_added_from, hunter_name, hunter_email, reviewer_name, reviewer_email, drafted_by_name, drafted_by_email, drafted_automatically, edited_by_name, edited_by_email, edited_at, ...listing } = r;
    return {
      ...listing,
      origin: {
        hunt: hunt_id ? { id: hunt_id, addedFrom: hunt_added_from || null, hunter: person(hunter_name, hunter_email), reviewer: person(reviewer_name, reviewer_email) } : null,
        draftedBy: person(drafted_by_name, drafted_by_email),
        draftedAutomatically: Boolean(drafted_automatically),
        lastEdit: edited_at ? { by: person(edited_by_name, edited_by_email), at: new Date(edited_at).toISOString() } : null,
      },
    };
  });
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
  // Of each, the ones made from a hunted product (its draft, drafted from the hunt).
  const fromHunt = 'EXISTS (SELECT 1 FROM hunted_products h WHERE h.listing_id = l.id)';
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE l.created_at >= $2 AND l.created_at < $3)::int AS drafted,
       count(*) FILTER (WHERE l.created_at >= $2 AND l.created_at < $3 AND ${fromHunt})::int AS "draftedFromHunts",
       count(*) FILTER (WHERE l.status = 'published' AND l.updated_at >= $2 AND l.updated_at < $3)::int AS published,
       count(*) FILTER (WHERE l.status = 'published' AND l.updated_at >= $2 AND l.updated_at < $3 AND ${fromHunt})::int AS "publishedFromHunts",
       count(*) FILTER (WHERE l.status = 'pending_review')::int AS waiting
     FROM listings l WHERE l.connection_id = $1 AND l.edit_of_item_id IS NULL`,
    [connectionId, start, end]
  );
  return rows[0] || { drafted: 0, draftedFromHunts: 0, published: 0, publishedFromHunts: 0, waiting: 0 };
}

/** An account's listing work since a moment, for the Overview's chart: when each draft was made, and published. */
async function listingEventsSince(connectionId, since) {
  const { rows } = await query(
    `SELECT created_at, status, updated_at FROM listings
      WHERE connection_id = $1 AND edit_of_item_id IS NULL AND (created_at >= $2 OR (status = 'published' AND updated_at >= $2))`,
    [connectionId, since]
  );
  return rows;
}

/** The newest listings put live from Liston in [start, end): title, photo, price, eBay item. */
async function recentlyPublished(connectionId, start, end, limit = 6) {
  const { rows } = await query(
    `SELECT id, external_product_id AS item_id, updated_at AS published_at,
            COALESCE(generated_data->>'commonTitle', generated_data->>'title') AS title,
            generated_data->'imageUrls'->>0 AS image,
            generated_data->'price'->>'value' AS price, generated_data->'price'->>'currency' AS currency
       FROM listings
      WHERE connection_id = $1 AND edit_of_item_id IS NULL AND status = 'published' AND updated_at >= $2 AND updated_at < $3
      ORDER BY updated_at DESC LIMIT $4`,
    [connectionId, start, end, limit]
  );
  return rows;
}

// Drafts on any of the owner's accounts that eBay refused for a policy
// reason (brand/VeRO, hazardous words, prohibited items), newest first:
// { title, message, account, at }. Product research checks a product
// against them.
const POLICY_REFUSAL = '(VeRO|intellectual property|trademark|counterfeit|replica|copyright|brand|Hazardous|PI_HAZ|improper words|policy|prohibited|restricted|not allowed)';
async function findPolicyRefusals(ownerId, limit = 500) {
  const { rows } = await query(
    `SELECT COALESCE(l.generated_data->>'commonTitle', l.generated_data->>'title') AS title, l.error_message AS message, c.label AS account, l.updated_at AS at
       FROM listings l JOIN connections c ON c.id = l.connection_id
      WHERE c.user_id = $1 AND l.error_message ~* $2
      ORDER BY l.updated_at DESC LIMIT $3`,
    [ownerId, POLICY_REFUSAL, limit]
  );
  return rows;
}

/**
 * Where each listing's product is bought, for many items at once (a CSV
 * download): the supplier link of the draft it was published from, else of
 * the hunted product it went live as, as supplierUrlFor does for one.
 * Map itemId -> url, items with none left out.
 */
async function supplierUrlsByItem(connectionId, itemIds) {
  const ids = [...new Set(itemIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (item_id) item_id, url FROM (
       SELECT external_product_id AS item_id, source_data->'source'->>'sourceUrl' AS url, 1 AS rank, updated_at FROM listings
        WHERE connection_id = $1 AND external_product_id = ANY($2) AND source_data->'source'->>'sourceUrl' IS NOT NULL
       UNION ALL
       SELECT unnest(item_ids) AS item_id, source_url, 2, updated_at FROM hunted_products
        WHERE connection_id = $1 AND item_ids && $2::text[] AND source_url IS NOT NULL
     ) found
     WHERE item_id = ANY($2)
     ORDER BY item_id, rank, updated_at DESC`,
    [connectionId, ids]
  );
  return new Map(rows.map((r) => [r.item_id, r.url]));
}

module.exports = {
  supplierUrlsByItem,
  findPolicyRefusals,
  countListingWork,
  listingEventsSince,
  recentlyPublished,
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
