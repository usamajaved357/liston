const { query } = require('../../db/client');

// notifications and push_subscriptions (migration 031). A notification is
// about one team (owner_user_id, migration 051; none for a test): the bell
// lists the team the person is in, and those with none.

// The person's notifications in a team: that team's, and those of no team.
const IN_TEAM = `(owner_user_id = $2 OR owner_user_id IS NULL)`;

async function insert({ userId, ownerId = null, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId = null, detail = {} }) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, actor_user_id, kind, title, body, url, subject_type, subject_id, detail, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, actorUserId, kind, title, body, url, subjectType, subjectId === null || subjectId === undefined ? null : String(subjectId), JSON.stringify(detail || {}), ownerId]
  );
  return rows[0];
}

/**
 * One unread notification per subject (a chat conversation): a new one
 * replaces the unread one there, counting up in detail.count, moved to the
 * top; after it's read the next starts a new one.
 */
async function upsertGrouped({ userId, ownerId = null, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId, detail = {} }) {
  const { rows } = await query(
    `UPDATE notifications
        SET actor_user_id = $2, title = $4, body = $5, url = $6,
            detail = $8::jsonb || jsonb_build_object('count', coalesce((detail->>'count')::int, 1) + 1), created_at = now()
      WHERE id = (SELECT id FROM notifications WHERE user_id = $1 AND kind = $3 AND subject_id = $7 AND read_at IS NULL ORDER BY created_at DESC LIMIT 1)
      RETURNING *`,
    [userId, actorUserId, kind, title, body, url, String(subjectId), JSON.stringify(detail || {})]
  );
  if (rows[0]) return rows[0];
  return insert({ userId, ownerId, actorUserId, kind, title, body, url, subjectType, subjectId, detail: { ...detail, count: 1 } });
}

/** Marks a person's notifications about one subject read (they opened the conversation). */
async function markReadBySubject(userId, kind, subjectId) {
  const { rowCount } = await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND kind = $2 AND subject_id = $3 AND read_at IS NULL`, [userId, kind, String(subjectId)]);
  return rowCount;
}

/** A person's latest notifications in a team, newest first, and how many are unread. */
async function listFor(userId, ownerId, { limit = 30 } = {}) {
  const [list, unread] = await Promise.all([
    query(
      `SELECT n.id, n.kind, n.title, n.body, n.url, n.subject_type, n.subject_id, n.detail, n.read_at, n.created_at,
              u.name AS actor_name, u.email AS actor_email
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_user_id
        WHERE n.user_id = $1 AND (n.owner_user_id = $2 OR n.owner_user_id IS NULL) ORDER BY n.created_at DESC LIMIT $3`,
      [userId, ownerId, limit]
    ),
    query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND ${IN_TEAM} AND read_at IS NULL`, [userId, ownerId]),
  ]);
  return { rows: list.rows, unread: unread.rows[0].n };
}

/** Marks some (or, with no ids, all in the team) of a person's notifications read. */
async function markRead(userId, ownerId, ids = null) {
  if (ids && !ids.length) return 0;
  const { rowCount } = ids
    ? await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND ${IN_TEAM} AND id = ANY($3::uuid[]) AND read_at IS NULL`, [userId, ownerId, ids])
    : await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND ${IN_TEAM} AND read_at IS NULL`, [userId, ownerId]);
  return rowCount;
}

/** Clears some (or, with no ids, all in the team) of a person's notifications. */
async function deleteFor(userId, ownerId, ids = null) {
  if (ids && !ids.length) return 0;
  const { rowCount } = ids
    ? await query(`DELETE FROM notifications WHERE user_id = $1 AND ${IN_TEAM} AND id = ANY($3::uuid[])`, [userId, ownerId, ids])
    : await query(`DELETE FROM notifications WHERE user_id = $1 AND ${IN_TEAM}`, [userId, ownerId]);
  return rowCount;
}

/** A browser's push subscription, for this person (a browser moves to whoever signs in on it). */
async function saveSubscription(userId, { endpoint, p256dh, auth, userAgent = null }) {
  await query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [endpoint, userId, p256dh, auth, userAgent]
  );
}

async function deleteSubscription(userId, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/** A subscription the push service says is gone (the browser unsubscribed or was reset). */
async function forgetEndpoint(endpoint) {
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function subscriptionsFor(userId) {
  const { rows } = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  return rows;
}

async function touchSubscription(endpoint) {
  await query('UPDATE push_subscriptions SET last_sent_at = now() WHERE endpoint = $1', [endpoint]);
}

module.exports = { insert, upsertGrouped, markReadBySubject, listFor, markRead, deleteFor, saveSubscription, deleteSubscription, forgetEndpoint, subscriptionsFor, touchSubscription };
