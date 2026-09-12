const { query } = require('../../db/client');

async function countByUser(userId) {
  const result = await query('SELECT count(*) FROM connections WHERE user_id = $1', [userId]);
  return parseInt(result.rows[0].count, 10);
}

async function getMaxConnectionsForUser(userId) {
  const result = await query(
    `SELECT p.max_connections
     FROM users u JOIN plans p ON p.id = u.plan_id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] ? result.rows[0].max_connections : 0;
}

async function findPlatformByKey(key) {
  const result = await query('SELECT id, key, name, role, status FROM platforms WHERE key = $1', [key]);
  return result.rows[0] || null;
}

async function findAllPlatforms() {
  const result = await query(
    "SELECT id, key, name, role, status FROM platforms WHERE role IN ('destination', 'both') ORDER BY name"
  );
  return result.rows;
}

async function findAllByUser(userId) {
  const result = await query(
    `SELECT c.id, c.label, c.status, c.created_at, c.updated_at, p.key AS platform_key, p.name AS platform_name
     FROM connections c
     JOIN platforms p ON p.id = c.destination_platform_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function findByIdForUser(id, userId) {
  const result = await query(
    `SELECT c.id, c.user_id, c.label, c.status, c.credentials, c.created_at, c.updated_at,
            p.key AS platform_key, p.name AS platform_name
     FROM connections c
     JOIN platforms p ON p.id = c.destination_platform_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function create({ userId, destinationPlatformId, label, credentials }) {
  const result = await query(
    `INSERT INTO connections (user_id, destination_platform_id, label, credentials)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, status, created_at`,
    [userId, destinationPlatformId, label, credentials]
  );
  return result.rows[0];
}

async function updateCredentials(id, credentials) {
  await query(
    'UPDATE connections SET credentials = $1, updated_at = now() WHERE id = $2',
    [credentials, id]
  );
}

async function updateStatus(id, status) {
  await query('UPDATE connections SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
}

async function deleteByIdForUser(id, userId) {
  const result = await query('DELETE FROM connections WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rowCount > 0;
}

module.exports = {
  countByUser,
  getMaxConnectionsForUser,
  findPlatformByKey,
  findAllPlatforms,
  findAllByUser,
  findByIdForUser,
  create,
  updateCredentials,
  updateStatus,
  deleteByIdForUser,
};
