const { query } = require('../../db/client');

// Quick replies (migration 044): an account's own, in the owner's order,
// and whether it has had Liston's starter set.

const COLUMNS = 'id, name, body, position, created_at, updated_at';

/** Marks the account as started: true the first time only (it gets the starter set then). */
async function startOnce(connectionId) {
  const { rows } = await query(`INSERT INTO quick_reply_accounts (connection_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING connection_id`, [connectionId]);
  return rows.length > 0;
}

async function list(connectionId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM quick_replies WHERE connection_id = $1 ORDER BY position, created_at, id`, [connectionId]);
  return rows;
}

async function count(connectionId) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM quick_replies WHERE connection_id = $1`, [connectionId]);
  return rows[0].n;
}

/** Adds replies at the end of the account's list, in the order given. */
async function add(connectionId, replies, userId = null) {
  const out = [];
  for (const r of replies) {
    const { rows } = await query(
      `INSERT INTO quick_replies (connection_id, name, body, position, created_by)
       VALUES ($1, $2, $3, (SELECT coalesce(max(position), -1) + 1 FROM quick_replies WHERE connection_id = $1), $4)
       RETURNING ${COLUMNS}`,
      [connectionId, r.name, r.body, userId]
    );
    out.push(rows[0]);
  }
  return out;
}

async function update(connectionId, id, { name, body }) {
  const { rows } = await query(`UPDATE quick_replies SET name = $3, body = $4, updated_at = now() WHERE connection_id = $1 AND id = $2 RETURNING ${COLUMNS}`, [connectionId, id, name, body]);
  return rows[0] || null;
}

async function remove(connectionId, id) {
  const { rowCount } = await query(`DELETE FROM quick_replies WHERE connection_id = $1 AND id = $2`, [connectionId, id]);
  return rowCount > 0;
}

module.exports = { startOnce, list, count, add, update, remove };
