const { query } = require('../../db/client');

// notifications and push_subscriptions (migration 031).

async function insert({ userId, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId = null, detail = {} }) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, actor_user_id, kind, title, body, url, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, actorUserId, kind, title, body, url, subjectType, subjectId === null || subjectId === undefined ? null : String(subjectId), JSON.stringify(detail || {})]
  );
  return rows[0];
}

/** A person's latest notifications, newest first, and how many are unread. */
async function listFor(userId, { limit = 30 } = {}) {
  const [list, unread] = await Promise.all([
    query(
      `SELECT n.id, n.kind, n.title, n.body, n.url, n.subject_type, n.subject_id, n.detail, n.read_at, n.created_at,
              u.name AS actor_name, u.email AS actor_email
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_user_id
        WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT $2`,
      [userId, limit]
    ),
    query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
  ]);
  return { rows: list.rows, unread: unread.rows[0].n };
}

/** Marks some (or, with no ids, all) of a person's notifications read. */
async function markRead(userId, ids = null) {
  if (ids && !ids.length) return 0;
  const { rowCount } = ids
    ? await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [userId, ids])
    : await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return rowCount;
}

/** Clears some (or, with no ids, all) of a person's notifications. */
async function deleteFor(userId, ids = null) {
  if (ids && !ids.length) return 0;
  const { rowCount } = ids
    ? await query('DELETE FROM notifications WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, ids])
    : await query('DELETE FROM notifications WHERE user_id = $1', [userId]);
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

module.exports = { insert, listFor, markRead, deleteFor, saveSubscription, deleteSubscription, forgetEndpoint, subscriptionsFor, touchSubscription };
