const { query } = require('../../db/client');

async function findByIdWithPlan(userId) {
  const result = await query(
    `SELECT
       u.id, u.email, u.plan_id, u.listings_used_this_month, u.billing_cycle_start,
       u.created_at,
       p.name AS plan_name, p.max_connections, p.listings_included_per_month,
       (SELECT count(*) FROM connections c WHERE c.user_id = u.id) AS connections_used
     FROM users u
     LEFT JOIN plans p ON p.id = u.plan_id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { findByIdWithPlan };
