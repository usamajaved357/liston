const { query } = require('../../db/client');

async function findByIdWithPlan(userId) {
  const result = await query(
    `SELECT
       u.id, u.email, u.plan_id, u.listings_used_this_month, u.billing_cycle_start,
       u.email_verified_at, u.created_at, u.avatar_url,
       p.name AS plan_name, p.max_connections, p.listings_included_per_month,
       (SELECT count(*) FROM connections c WHERE c.user_id = u.id) AS connections_used
     FROM users u
     LEFT JOIN plans p ON p.id = u.plan_id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function deleteById(userId) {
  // connections/tracked_stores/listings cascade via ON DELETE CASCADE
  // (see migration 002); jobs_log rows are kept with connection_id set to NULL.
  await query('DELETE FROM users WHERE id = $1', [userId]);
}

async function findAuthById(userId) {
  const result = await query('SELECT id, email, password_hash FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function emailTakenByAnotherUser(email, excludingUserId) {
  const result = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, excludingUserId]);
  return result.rows.length > 0;
}

// Changing email re-triggers verification — the new address hasn't been proven yet.
async function updateEmail(userId, newEmail) {
  await query(
    'UPDATE users SET email = $1, email_verified_at = NULL, updated_at = now() WHERE id = $2',
    [newEmail, userId]
  );
}

async function updatePasswordHash(userId, passwordHash) {
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, userId]);
}

async function updateAvatar(userId, avatarUrl) {
  await query('UPDATE users SET avatar_url = $1, updated_at = now() WHERE id = $2', [avatarUrl, userId]);
}

module.exports = {
  findByIdWithPlan,
  deleteById,
  findAuthById,
  emailTakenByAnotherUser,
  updateEmail,
  updatePasswordHash,
  updateAvatar,
};
