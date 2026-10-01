const { query } = require('../../db/client');

// member_minutes (migration 046): one row per minute a team member had
// Liston open, working or idle, and where (work-time.js says how it's judged).

/**
 * Keeps this minute for a member. Several tabs in one minute make one row:
 * working if any tab was, in the area and account of a working one.
 */
async function recordMinute({ userId, ownerId, working, area, connectionId = null }) {
  await query(
    `INSERT INTO member_minutes (user_id, minute, owner_user_id, working, area, connection_id)
     VALUES ($1, date_trunc('minute', now()), $2, $3, $4, $5)
     ON CONFLICT (user_id, minute) DO UPDATE SET
       working = member_minutes.working OR EXCLUDED.working,
       area = CASE WHEN EXCLUDED.working AND NOT member_minutes.working THEN EXCLUDED.area ELSE member_minutes.area END,
       connection_id = CASE WHEN EXCLUDED.working AND NOT member_minutes.working THEN EXCLUDED.connection_id ELSE member_minutes.connection_id END`,
    [userId, ownerId, Boolean(working), area, connectionId]
  );
}

/** A member's minutes between two instants. */
async function minutesFor(ownerId, userId, startsAt, endsAt) {
  const { rows } = await query(
    `SELECT minute, working, area, connection_id FROM member_minutes
      WHERE owner_user_id = $1 AND user_id = $2 AND minute >= $3 AND minute < $4 ORDER BY minute`,
    [ownerId, userId, startsAt, endsAt]
  );
  return rows;
}

/** Each member's working and idle minutes since `since`, and their latest minute (for the Team page). */
async function teamSince(ownerId, since) {
  const { rows } = await query(
    `SELECT user_id, count(*) FILTER (WHERE working)::int AS working, count(*) FILTER (WHERE NOT working)::int AS idle, max(minute) AS last_minute
       FROM member_minutes WHERE owner_user_id = $1 AND minute >= $2 GROUP BY user_id`,
    [ownerId, since]
  );
  return rows;
}

/** When Liston first kept a minute of this member's (null: never). */
async function firstMinute(ownerId, userId) {
  const { rows } = await query(`SELECT min(minute) AS at FROM member_minutes WHERE owner_user_id = $1 AND user_id = $2`, [ownerId, userId]);
  return rows[0]?.at || null;
}

module.exports = { recordMinute, minutesFor, teamSince, firstMinute };
