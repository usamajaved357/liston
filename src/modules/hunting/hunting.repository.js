const { query } = require('../../db/client');

// hunted_products (migration 026). Every read is scoped to the owner, so a
// hunt id alone never reaches another team's product.

// Where a product stands, in SQL (hunt-rules.stageOf): listed once it has
// an eBay item, drafted while it has a draft, else its review decision.
const STAGE_SQL = `CASE WHEN cardinality(h.item_ids) > 0 THEN 'listed' WHEN h.listing_id IS NOT NULL THEN 'drafted' ELSE h.status END`;

// The list's tabs. Every product stays on the page for good, whatever
// happens to it: Approved holds the ones still to be drafted (drafting now,
// or a failed draft), Drafted the ones with a draft, Listed the ones live on
// eBay. A sent-back product is under All (and My hunts, the person's own,
// filtered by hunter).
const VIEW_SQL = {
  all: 'TRUE',
  review: `${STAGE_SQL} = 'pending'`,
  approved: `${STAGE_SQL} = 'approved'`,
  drafted: `${STAGE_SQL} = 'drafted'`,
  listed: `${STAGE_SQL} = 'listed'`,
  rejected: `${STAGE_SQL} = 'rejected'`,
  mine: 'TRUE',
};
const VIEWS = Object.keys(VIEW_SQL);

const SORT_SQL = {
  newest: 'h.created_at DESC',
  waiting: 'h.submitted_at ASC',
  profit: 'h.headline_profit DESC NULLS LAST, h.created_at DESC',
  roi: 'h.headline_roi DESC NULLS LAST, h.created_at DESC',
  demand: 'h.sold_per_month DESC NULLS LAST, h.created_at DESC',
  sales: 'h.sales_score DESC NULLS LAST, h.created_at DESC',
};
const SORTS = Object.keys(SORT_SQL);

const SELECT = `
  SELECT h.*, ${STAGE_SQL} AS stage, c.label AS connection_label,
    hu.name AS hunter_name, hu.email AS hunter_email,
    ru.name AS reviewer_name, ru.email AS reviewer_email,
    du.name AS drafted_by_name, du.email AS drafted_by_email,
    l.status AS listing_status
  FROM hunted_products h
  JOIN connections c ON c.id = h.connection_id
  LEFT JOIN users hu ON hu.id = h.hunter_user_id
  LEFT JOIN users ru ON ru.id = h.reviewer_user_id
  LEFT JOIN users du ON du.id = h.drafted_by
  LEFT JOIN listings l ON l.id = h.listing_id`;

async function insert(fields) {
  const { rows } = await query(
    `INSERT INTO hunted_products (owner_user_id, connection_id, hunter_user_id, status, competitor_url, competitor_item_id, source_url, source_product_id,
       title, image_url, currency, check_result, headline_profit, headline_roi, sold_per_month, hunter_note, reviewer_user_id, decided_at, sales_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      fields.ownerId,
      fields.connectionId,
      fields.hunterId,
      fields.status,
      fields.competitorUrl,
      fields.competitorItemId,
      fields.sourceUrl,
      fields.sourceProductId,
      fields.title,
      fields.imageUrl,
      fields.currency,
      JSON.stringify(fields.checkResult),
      fields.headlineProfit,
      fields.headlineRoi,
      fields.soldPerMonth,
      fields.note || null,
      fields.reviewerId || null,
      fields.decidedAt || null,
      fields.salesScore ?? null,
    ]
  );
  return rows[0].id;
}

async function findForOwner(id, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const { rows } = await query(`${SELECT} WHERE h.id = $1 AND h.owner_user_id = $2`, [id, ownerId]);
  return rows[0] || null;
}

// The list's filters, beyond the tab and search: one hunter's; a profit a
// sale of at least `minProfit`; at least `minDemand` sold a month by the
// competitor; added in the last `addedDays`; `unique` leaves out a product
// already hunted, drafted or live elsewhere on the owner's accounts (a
// similar title alone doesn't count). Applied to the tab counts too, so a
// tab's number is what it shows.
function filterSql({ hunterId = null, minProfit = null, minDemand = null, addedDays = null, unique = false } = {}, params) {
  let where = '';
  if (hunterId) {
    params.push(hunterId);
    where += ` AND h.hunter_user_id = $${params.length}`;
  }
  if (Number(minProfit) > 0) {
    params.push(Number(minProfit));
    where += ` AND h.headline_profit >= $${params.length}`;
  }
  if (Number(minDemand) > 0) {
    params.push(Number(minDemand));
    where += ` AND h.sold_per_month >= $${params.length}`;
  }
  if (Number(addedDays) > 0) {
    params.push(Number(addedDays));
    where += ` AND h.created_at >= now() - make_interval(days => $${params.length}::int)`;
  }
  if (unique) {
    where += ` AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.check_result->'duplicates') = 'array' THEN h.check_result->'duplicates' ELSE '[]'::jsonb END) d WHERE d->>'type' IS DISTINCT FROM 'similar')`;
  }
  return where;
}

/**
 * A page of an account's hunted products for a view (all | review |
 * approved | drafted | listed | rejected | mine), filtered (filterSql),
 * searched by title, item or product number, link, hunter or note; sorted
 * newest | waiting (longest waiting first) | profit | roi | demand | sales.
 */
async function list(connectionId, { view = 'all', q = '', sort = 'newest', limit = 50, offset = 0, ...filters } = {}) {
  const params = [connectionId];
  let where = `h.connection_id = $1 AND ${VIEW_SQL[view] || 'TRUE'}`;
  where += filterSql(filters, params);
  if (q) {
    // Title, eBay item number, AliExpress product number, either link, the hunter, or a note.
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where += ` AND (h.title ILIKE ${p} OR h.competitor_item_id ILIKE ${p} OR h.source_product_id ILIKE ${p} OR h.competitor_url ILIKE ${p} OR h.source_url ILIKE ${p}
      OR hu.name ILIKE ${p} OR hu.email ILIKE ${p} OR h.hunter_note ILIKE ${p} OR h.decision_note ILIKE ${p} OR array_to_string(h.item_ids, ' ') ILIKE ${p})`;
  }
  params.push(limit + 1, offset);
  const { rows } = await query(`${SELECT} WHERE ${where} ORDER BY ${SORT_SQL[sort] || SORT_SQL.newest} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** How many products each view holds on an account, with the same filters (filterSql); mine: the viewer's own. */
async function counts(connectionId, { viewerId = null, ...filters } = {}) {
  const params = [connectionId, viewerId];
  const where = `h.connection_id = $1${filterSql(filters, params)}`;
  const { rows } = await query(
    `SELECT ${VIEWS.map((v) => (v === 'mine' ? `count(*) FILTER (WHERE h.hunter_user_id = $2)::int AS mine` : `count(*) FILTER (WHERE ${VIEW_SQL[v]})::int AS ${v}`)).join(', ')}
       FROM hunted_products h WHERE ${where}`,
    params
  );
  return rows[0];
}

/**
 * An account's hunting in [start, end) for the Overview: products hunted,
 * approved (drafted or listed since included) and rejected in those dates,
 * and how many wait for review now.
 */
async function countForOverview(connectionId, start, end) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS hunted,
       count(*) FILTER (WHERE status = 'approved' AND decided_at >= $2 AND decided_at < $3)::int AS approved,
       count(*) FILTER (WHERE status = 'rejected' AND decided_at >= $2 AND decided_at < $3)::int AS rejected,
       count(*) FILTER (WHERE status = 'pending')::int AS reviewing
     FROM hunted_products WHERE connection_id = $1`,
    [connectionId, start, end]
  );
  return rows[0] || { hunted: 0, approved: 0, rejected: 0, reviewing: 0 };
}

/** The badge: products waiting that this person may review, their own sent back, and approved ones ready to draft. */
async function badgeCounts(connectionId, viewerId) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE ${STAGE_SQL} = 'pending' AND h.hunter_user_id IS DISTINCT FROM $2)::int AS review,
       count(*) FILTER (WHERE ${STAGE_SQL} = 'sent_back' AND h.hunter_user_id = $2)::int AS sent_back,
       count(*) FILTER (WHERE ${STAGE_SQL} = 'approved')::int AS approved
     FROM hunted_products h WHERE h.connection_id = $1`,
    [connectionId, viewerId]
  );
  return rows[0];
}

/** Everyone who has hunted on an account (for the hunter filter). */
async function huntersOn(connectionId) {
  const { rows } = await query(
    `SELECT DISTINCT u.id, u.name, u.email FROM hunted_products h JOIN users u ON u.id = h.hunter_user_id WHERE h.connection_id = $1 ORDER BY u.name NULLS LAST, u.email`,
    [connectionId]
  );
  return rows;
}

async function setDecision(id, { status, reject_reason: rejectReason, decision_note: note }, reviewerId) {
  await query(
    `UPDATE hunted_products SET status = $2, reject_reason = $3, decision_note = $4, reviewer_user_id = $5, decided_at = now(), updated_at = now() WHERE id = $1`,
    [id, status, rejectReason, note, reviewerId]
  );
}

async function setCheck(id, { competitorUrl, competitorItemId, sourceUrl, sourceProductId, title, imageUrl, currency, checkResult, headlineProfit, headlineRoi, soldPerMonth, salesScore }) {
  await query(
    `UPDATE hunted_products SET competitor_url = $2, competitor_item_id = $3, source_url = $4, source_product_id = $5, title = $6, image_url = $7, currency = $8,
       check_result = $9, headline_profit = $10, headline_roi = $11, sold_per_month = $12, sales_score = $13, checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, competitorUrl, competitorItemId, sourceUrl, sourceProductId, title, imageUrl, currency, JSON.stringify(checkResult), headlineProfit, headlineRoi, soldPerMonth, salesScore ?? null]
  );
}

async function setNote(id, note) {
  await query('UPDATE hunted_products SET hunter_note = $2, updated_at = now() WHERE id = $1', [id, note || null]);
}

/** Back in for review: the last decision is cleared (its note stays in the history). */
async function resubmit(id) {
  await query(
    `UPDATE hunted_products SET status = 'pending', reviewer_user_id = NULL, decided_at = NULL, reject_reason = NULL, decision_note = NULL,
       submitted_at = now(), resubmits = resubmits + 1, updated_at = now() WHERE id = $1`,
    [id]
  );
}

async function deleteById(id) {
  await query('DELETE FROM hunted_products WHERE id = $1', [id]);
}

/** A draft made from the product (a second draft takes over from the first). */
async function linkDraft(id, listingId, userId) {
  await query(
    'UPDATE hunted_products SET listing_id = $2, drafted_by = $3, drafted_at = now(), draft_status = NULL, draft_error = NULL, updated_at = now() WHERE id = $1',
    [id, listingId, userId || null]
  );
}

/**
 * Claims a product for its automatic draft: only one at a time, and only an
 * approved one with no draft yet (not while another claim is fresh).
 * True when this call claimed it.
 */
async function claimDraft(id, staleBefore) {
  const { rowCount } = await query(
    `UPDATE hunted_products SET draft_status = 'drafting', draft_error = NULL, draft_attempted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'approved' AND listing_id IS NULL
        AND (draft_status IS DISTINCT FROM 'drafting' OR draft_attempted_at < $2)`,
    [id, staleBefore]
  );
  return rowCount > 0;
}

/** The automatic draft failed: why, kept until it's tried again. */
async function draftFailed(id, error) {
  await query(`UPDATE hunted_products SET draft_status = 'failed', draft_error = $2, updated_at = now() WHERE id = $1 AND listing_id IS NULL`, [id, String(error || '').slice(0, 500)]);
}

/** The draft made from a product went live (or was relisted) as this eBay item. */
async function addItemForListing(listingId, itemId) {
  if (!listingId || !itemId) return;
  await query(
    `UPDATE hunted_products SET item_ids = CASE WHEN $2 = ANY(item_ids) THEN item_ids ELSE array_append(item_ids, $2) END,
       listed_at = COALESCE(listed_at, now()), updated_at = now()
     WHERE listing_id = $1`,
    [listingId, String(itemId)]
  );
}

// ---- the same product elsewhere (warnings, never a block) ------------------------------

/** The owner's hunted products (any account) of this supplier product or competitor listing. */
async function huntsMatching(ownerId, { productId, itemId, excludeId = null }) {
  const { rows } = await query(
    `${SELECT} WHERE h.owner_user_id = $1 AND (h.source_product_id = $2 OR h.competitor_item_id = $3) AND ($4::uuid IS NULL OR h.id <> $4)
     ORDER BY h.created_at DESC LIMIT 20`,
    [ownerId, productId || '', itemId || '', excludeId]
  );
  return rows;
}

/** The owner's drafts and Liston listings (any account) made from this supplier product or competitor listing. */
async function listingsMatching(ownerId, { productId, itemId }) {
  const { rows } = await query(
    `SELECT l.id, l.status, l.external_product_id, l.connection_id, c.label AS account, l.created_at,
       COALESCE(l.generated_data->>'commonTitle', l.generated_data->>'title') AS title,
       (length($2) > 5 AND position($2 in COALESCE(l.source_data->'source'->>'sourceUrl', '')) > 0) AS same_supplier,
       (length($3) > 5 AND position('/' || $3 in COALESCE(l.source_data->'competitor'->>'sourceUrl', '')) > 0) AS same_competitor
     FROM listings l JOIN connections c ON c.id = l.connection_id
     WHERE c.user_id = $1 AND l.edit_of_item_id IS NULL AND l.status IN ('pending_review', 'published')
       AND ((length($2) > 5 AND position($2 in COALESCE(l.source_data->'source'->>'sourceUrl', '')) > 0)
         OR (length($3) > 5 AND position('/' || $3 in COALESCE(l.source_data->'competitor'->>'sourceUrl', '')) > 0))
     ORDER BY l.created_at DESC LIMIT 20`,
    [ownerId, productId || '', itemId || '']
  );
  return rows;
}

// ---- figures ------------------------------------------------------------------------

/** Products hunted in [start, end) on the owner's accounts (one account, or one hunter's, if given). */
async function huntedBetween(ownerId, { start, end, connectionId = null, hunterId = null }) {
  const { rows } = await query(
    `SELECT h.id, h.connection_id, h.hunter_user_id, h.status, h.listing_id, h.item_ids, h.reject_reason, h.created_at
       FROM hunted_products h
      WHERE h.owner_user_id = $1 AND h.created_at >= $2 AND h.created_at < $3
        AND ($4::uuid IS NULL OR h.connection_id = $4) AND ($5::uuid IS NULL OR h.hunter_user_id = $5)`,
    [ownerId, start, end, connectionId, hunterId]
  );
  return rows;
}

/** An account's hunting since a moment, for the Overview's chart: when each was hunted, and decided (with the decision). */
async function eventsSince(connectionId, since) {
  const { rows } = await query(
    `SELECT created_at, status, decided_at FROM hunted_products WHERE connection_id = $1 AND (created_at >= $2 OR decided_at >= $2)`,
    [connectionId, since]
  );
  return rows;
}

/** One hunter's products approved or rejected in [start, end), by when decided (for their chart). */
async function outcomesBetween(ownerId, { start, end, hunterId, connectionId = null }) {
  const { rows } = await query(
    `SELECT status, decided_at FROM hunted_products
      WHERE owner_user_id = $1 AND hunter_user_id = $4 AND status IN ('approved', 'rejected') AND decided_at >= $2 AND decided_at < $3
        AND ($5::uuid IS NULL OR connection_id = $5)`,
    [ownerId, start, end, hunterId, connectionId]
  );
  return rows;
}

/** Products last decided in [start, end) (one account, or one reviewer's, if given), for time to decide. */
async function decidedBetween(ownerId, { start, end, connectionId = null, reviewerId = null }) {
  const { rows } = await query(
    `SELECT h.id, h.reviewer_user_id, h.hunter_user_id, h.submitted_at, h.decided_at
       FROM hunted_products h
      WHERE h.owner_user_id = $1 AND h.decided_at >= $2 AND h.decided_at < $3
        AND ($4::uuid IS NULL OR h.connection_id = $4) AND ($5::uuid IS NULL OR h.reviewer_user_id = $5)`,
    [ownerId, start, end, connectionId, reviewerId]
  );
  return rows;
}

/** Review decisions recorded in [start, end) (member_activity), one account's or one person's. */
async function decisionsBetween(ownerId, { start, end, connectionId = null, actorId = null }) {
  const { rows } = await query(
    `SELECT actor_user_id, kind, subject_id, created_at FROM member_activity
      WHERE owner_user_id = $1 AND kind IN ('hunt.approved', 'hunt.rejected', 'hunt.sent_back') AND created_at >= $2 AND created_at < $3
        AND ($4::uuid IS NULL OR connection_id = $4) AND ($5::uuid IS NULL OR actor_user_id = $5)`,
    [ownerId, start, end, connectionId, actorId]
  );
  return rows;
}

/** Products that went live (their eBay items), one account's or one hunter's. */
async function listedHunts(ownerId, { connectionId = null, hunterId = null } = {}) {
  const { rows } = await query(
    `SELECT h.id, h.connection_id, h.hunter_user_id, h.item_ids FROM hunted_products h
      WHERE h.owner_user_id = $1 AND cardinality(h.item_ids) > 0
        AND ($2::uuid IS NULL OR h.connection_id = $2) AND ($3::uuid IS NULL OR h.hunter_user_id = $3)`,
    [ownerId, connectionId, hunterId]
  );
  return rows;
}

/** What to call someone in a notification: their name, or their email's name part. */
async function personName(userId) {
  if (!userId) return null;
  const { rows } = await query('SELECT name, email FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  return u ? u.name || (u.email ? u.email.split('@')[0] : null) : null;
}

/** A product's history from the activity record, oldest first. */
async function history(ownerId, huntId) {
  const { rows } = await query(
    `SELECT a.kind, a.detail, a.created_at, a.actor_user_id, u.name AS actor_name, u.email AS actor_email
       FROM member_activity a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.owner_user_id = $1 AND a.subject_type = 'hunt' AND a.subject_id = $2
      ORDER BY a.created_at ASC, a.id ASC`,
    [ownerId, String(huntId)]
  );
  return rows;
}

// ---- the competitor's sales over time (migration 028) -------------------------------

async function addReading(huntId, { sold, available, variations }) {
  await query('INSERT INTO hunt_sales_snapshots (hunt_id, sold, available, variations) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [huntId, sold, available, JSON.stringify(variations || [])]);
}

/** A product's readings, oldest first. */
async function readings(huntId) {
  const { rows } = await query('SELECT taken_at, sold, available, variations FROM hunt_sales_snapshots WHERE hunt_id = $1 ORDER BY taken_at ASC', [huntId]);
  return rows;
}

async function setSalesScore(huntId, score) {
  await query('UPDATE hunted_products SET sales_score = $2 WHERE id = $1', [huntId, score]);
}

/**
 * Products whose competitor is due a reading: hunted in the last `days`,
 * with a competitor, not rejected, last read over `hours` ago; oldest
 * reading first.
 */
async function dueForReading({ limit = 20, hours = 20, days = 90, ownerId = null } = {}) {
  const { rows } = await query(
    `SELECT h.id, h.owner_user_id, h.connection_id, h.competitor_url, h.competitor_item_id, h.check_result->'demand' AS demand, last.taken_at AS last_read
       FROM hunted_products h
       LEFT JOIN LATERAL (SELECT max(taken_at) AS taken_at FROM hunt_sales_snapshots s WHERE s.hunt_id = h.id) last ON TRUE
      WHERE h.competitor_url IS NOT NULL AND h.status <> 'rejected' AND h.created_at > now() - make_interval(days => $3)
        AND (last.taken_at IS NULL OR last.taken_at < now() - make_interval(hours => $2))
        AND ($4::uuid IS NULL OR h.owner_user_id = $4)
      ORDER BY last.taken_at ASC NULLS FIRST
      LIMIT $1`,
    [limit, hours, days, ownerId]
  );
  return rows;
}

// ---- a competitor's dated sales, pasted from eBay (migration 029) -------------------

module.exports = {
  claimDraft,
  draftFailed,
  eventsSince,
  outcomesBetween,
  countForOverview,
  personName,
  addReading,
  readings,
  setSalesScore,
  dueForReading,
  VIEWS,
  SORTS,
  insert,
  findForOwner,
  list,
  counts,
  badgeCounts,
  huntersOn,
  setDecision,
  setCheck,
  setNote,
  resubmit,
  deleteById,
  linkDraft,
  addItemForListing,
  huntsMatching,
  listingsMatching,
  huntedBetween,
  decidedBetween,
  decisionsBetween,
  listedHunts,
  history,
};
