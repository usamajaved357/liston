const { pool, query } = require('../../db/client');
const userRepository = require('../users/user.repository');

// Teams and who's in them (migration 051): `workspaces` (one per owner, its
// name) and `workspace_members` (a login's place in another owner's team:
// owner access, removed). A team is keyed by its owner's user id.

/**
 * A signed-in login and the teams it can open now: its own (an owner's)
 * and every team it's an active member of. One query, on every request.
 * { user: { id, email, role, access_status, last_workspace_id }, teams: [{ ownerId, own, ownerAccessAt, accessStatus }] } or null.
 */
async function sessionFor(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.access_status, u.last_workspace_id, u.session_version,
            coalesce(json_agg(json_build_object('ownerId', m.owner_user_id, 'ownerAccessAt', m.owner_access_at, 'accessStatus', o.access_status) ORDER BY m.created_at)
                     FILTER (WHERE m.owner_user_id IS NOT NULL), '[]') AS memberships
       FROM users u
       LEFT JOIN workspace_members m ON m.user_id = u.id AND m.deactivated_at IS NULL
       LEFT JOIN users o ON o.id = m.owner_user_id
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  const own = row.role === 'owner' ? [{ ownerId: row.id, own: true, ownerAccessAt: null, accessStatus: row.access_status }] : [];
  const { memberships, ...user } = row;
  return { user, teams: [...own, ...memberships.map((m) => ({ ...m, own: false }))] };
}

/**
 * The teams a login can open, for its team menu: each one's name, owner,
 * what the login is there and its unread notifications. Own team first.
 */
async function teamsFor(userId) {
  const { rows } = await query(
    `SELECT w.owner_user_id AS id, w.name, o.name AS owner_name, o.email AS owner_email,
            (w.owner_user_id = $1) AS own, m.owner_access_at,
            (SELECT count(*)::int FROM notifications n WHERE n.user_id = $1 AND n.owner_user_id = w.owner_user_id AND n.read_at IS NULL) AS unread
       FROM workspaces w
       JOIN users o ON o.id = w.owner_user_id
       LEFT JOIN workspace_members m ON m.owner_user_id = w.owner_user_id AND m.user_id = $1
      WHERE w.owner_user_id = $1 OR (m.user_id IS NOT NULL AND m.deactivated_at IS NULL)
      ORDER BY (w.owner_user_id = $1) DESC, m.created_at`,
    [userId]
  );
  return rows;
}

async function create(ownerId, name, client = null) {
  await (client || { query }).query(`INSERT INTO workspaces (owner_user_id, name) VALUES ($1, $2) ON CONFLICT (owner_user_id) DO NOTHING`, [ownerId, name]);
}

async function rename(ownerId, name) {
  const { rows } = await query(`UPDATE workspaces SET name = $2, updated_at = now() WHERE owner_user_id = $1 RETURNING owner_user_id AS id, name`, [ownerId, name]);
  return rows[0] || null;
}

async function nameOf(ownerId) {
  const { rows } = await query(`SELECT name FROM workspaces WHERE owner_user_id = $1`, [ownerId]);
  return rows[0]?.name || null;
}

/** The team a login opens in next time it doesn't say. */
async function setLast(userId, ownerId) {
  await query(`UPDATE users SET last_workspace_id = $2 WHERE id = $1 AND last_workspace_id IS DISTINCT FROM $2`, [userId, ownerId]);
}

/** Which of this login's teams an eBay account is in (a link from another team), or null. */
async function teamOfConnection(userId, connectionId) {
  const { rows } = await query(
    `SELECT c.user_id AS owner_id FROM connections c
      WHERE c.id = $2
        AND (c.user_id = $1 OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.owner_user_id = c.user_id AND m.user_id = $1 AND m.deactivated_at IS NULL))`,
    [userId, connectionId]
  );
  return rows[0]?.owner_id || null;
}

// Everything kept under a workspace's owner's id, in the order it goes: the
// people's places and records in it, its chat, files, hunting, Discover
// watches and supplier logins, its eBay accounts (their listings, orders,
// messages and the rest go with them, ON DELETE CASCADE), then the workspace.
const OWNED = [
  ['workspace_members', 'owner_user_id'],
  ['member_permissions', 'owner_user_id'],
  ['member_minutes', 'owner_user_id'],
  ['member_activity', 'owner_user_id'],
  ['notifications', 'owner_user_id'],
  ['chat_conversations', 'owner_user_id'],
  ['files', 'owner_user_id'],
  ['hunted_products', 'owner_user_id'],
  ['discover_watches', 'owner_user_id'],
  ['source_accounts', 'owner_user_id'],
  ['connections', 'user_id'],
  ['workspaces', 'owner_user_id'],
];

/**
 * A workspace deleted while its owner's login stays (it's in other
 * workspaces): the member logins in no other workspace go, then everything
 * kept under the owner's id, and the login is a member's from then on, of
 * the workspaces it's still in. One transaction.
 */
async function removeKeepingLogin(ownerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await userRepository.deleteLoginsOnlyIn(ownerId, client);
    for (const [table, column] of OWNED) await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [ownerId]);
    await client.query(`UPDATE users SET role = 'member', last_workspace_id = NULL, updated_at = now() WHERE id = $1`, [ownerId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { sessionFor, teamsFor, create, rename, nameOf, setLast, teamOfConnection, removeKeepingLogin };
