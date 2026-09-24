const { query } = require('../../db/client');
const logger = require('../../utils/logger');

// member_activity (migration 021): one row per action someone took in
// Liston. The owner and the account's name come from the connection at the
// moment of the action, so a row stays readable after the account goes.

/**
 * Records an action. The owner comes from the eBay account (`connectionId`),
 * or is given (`ownerUserId`) for work on no one account — a login, a
 * supplier account. `amount`/`title` default, for an order, to what the
 * order mirror holds (order total, first item's title). `onceWithinHours`:
 * skip it if the same person already has this kind on this subject that
 * recently (draft work is many small saves, counted as one sitting). Never
 * throws: a failure to record must not undo the work itself.
 */
async function record({
  actorUserId,
  connectionId = null,
  ownerUserId = null,
  kind,
  subjectType,
  subjectId,
  subjectPart = null,
  title = null,
  amount = null,
  currency = null,
  detail = {},
  onceWithinHours = null,
}) {
  if (!actorUserId || (!connectionId && !ownerUserId) || !kind || !subjectId) return null;
  try {
    const result = await query(
      `INSERT INTO member_activity (owner_user_id, actor_user_id, connection_id, connection_label, kind, subject_type, subject_id, subject_part, title, amount, currency, detail)
       SELECT COALESCE(c.user_id, $11::uuid), $2, c.id, c.label, $3, $4, $5, $6,
         COALESCE($7, o.data->'lineItems'->0->>'title'),
         COALESCE($8::numeric, NULLIF(o.data->'total'->>'amount', '')::numeric),
         COALESCE($9, o.data->'total'->>'currency'),
         $10
       FROM (SELECT 1) one
       LEFT JOIN connections c ON c.id = $1::uuid
       LEFT JOIN ebay_orders o ON $4 = 'order' AND o.connection_id = c.id AND o.order_id = $5
       WHERE (c.id IS NOT NULL OR ($1::uuid IS NULL AND $11::uuid IS NOT NULL))
         AND ($12::int IS NULL OR NOT EXISTS (
           SELECT 1 FROM member_activity p
           WHERE p.actor_user_id = $2 AND p.kind = $3 AND p.subject_id = $5 AND p.created_at > now() - make_interval(hours => $12::int)))
       RETURNING *`,
      [connectionId, actorUserId, kind, subjectType, String(subjectId), subjectPart, title, amount, currency, JSON.stringify(detail || {}), ownerUserId, onceWithinHours]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.warn('Team activity not recorded', { kind, connectionId, error: err.message });
    return null;
  }
}

/** Every row a member made between two instants (the figures are worked out from these). */
async function rowsFor(ownerId, actorId, startsAt, endsAt) {
  const result = await query(
    `SELECT kind, subject_id, subject_part, connection_id, connection_label, amount, currency, created_at
     FROM member_activity
     WHERE owner_user_id = $1 AND actor_user_id = $2 AND created_at >= $3 AND created_at < $4`,
    [ownerId, actorId, startsAt, endsAt]
  );
  return result.rows;
}

/**
 * A page of a member's activity, newest first by when it happened (history
 * filled in from order events isn't in id order). `before` is the previous
 * page's cursor ("<ISO time>|<id>"); `kinds`/`connectionId` narrow it.
 */
async function feed(ownerId, actorId, { startsAt, endsAt, kinds = null, connectionId = null, before = null, limit = 50 }) {
  const params = [ownerId, actorId, startsAt, endsAt];
  let where = 'owner_user_id = $1 AND actor_user_id = $2 AND created_at >= $3 AND created_at < $4';
  if (kinds && kinds.length) {
    params.push(kinds);
    where += ` AND kind = ANY($${params.length})`;
  }
  if (connectionId) {
    params.push(connectionId);
    where += ` AND connection_id = $${params.length}`;
  }
  const cursor = before && /^[^|]+\|\d+$/.test(before) ? before.split('|') : null;
  if (cursor && !Number.isNaN(Date.parse(cursor[0]))) {
    params.push(cursor[0], cursor[1]);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  params.push(limit);
  const result = await query(
    `SELECT id, kind, subject_type, subject_id, subject_part, title, amount, currency, detail, connection_id, connection_label, created_at
     FROM member_activity WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/** A row's place in the feed, for the next page. */
const cursorOf = (row) => `${new Date(row.created_at).toISOString()}|${row.id}`;

/** When a member last did any work (a login alone isn't work). */
async function lastActiveAt(ownerId, actorId) {
  const result = await query(`SELECT max(created_at) AS at FROM member_activity WHERE owner_user_id = $1 AND actor_user_id = $2 AND subject_type <> 'session'`, [ownerId, actorId]);
  return result.rows[0]?.at || null;
}

/** Per member of an owner: their last action, and what they did since `since` (for the Team cards). */
async function teamSince(ownerId, since) {
  const [last, recent] = await Promise.all([
    query(`SELECT actor_user_id, max(created_at) AS last_active_at FROM member_activity WHERE owner_user_id = $1 AND subject_type <> 'session' GROUP BY actor_user_id`, [ownerId]),
    query(`SELECT actor_user_id, kind, subject_id, subject_part, created_at FROM member_activity WHERE owner_user_id = $1 AND created_at >= $2`, [ownerId, since]),
  ]);
  return { last: last.rows, recent: recent.rows };
}

/**
 * When Liston started noting who did what (migration 021): listing work
 * before it isn't anyone's on record; order work before it was filled in
 * from the order timeline.
 */
async function recordingSince() {
  const result = await query(`SELECT applied_at FROM schema_migrations WHERE name = '021_team_activity'`);
  return result.rows[0]?.applied_at || null;
}

module.exports = { record, rowsFor, feed, cursorOf, lastActiveAt, teamSince, recordingSince };
