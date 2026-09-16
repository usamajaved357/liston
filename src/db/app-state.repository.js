const { query } = require('./client');

// Durable process state (see migration 008). JSON in, JSON out.
async function get(key) {
  const { rows } = await query('SELECT value FROM app_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function set(key, value) {
  await query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

module.exports = { get, set };
