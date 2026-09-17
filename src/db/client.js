const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

// Railway's public proxy (rlwy.net) serves a self-signed chain; the private
// network and local Postgres don't use TLS. DATABASE_SSL=true forces it on.
function sslFor(url) {
  if (process.env.DATABASE_SSL === 'true' || /rlwy\.net|railway\.app/.test(url || '')) return { rejectUnauthorized: false };
  return undefined;
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslFor(config.databaseUrl),
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Errors on idle clients — log, don't crash the process
  logger.error('Unexpected error on idle Postgres client', { error: err.message });
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const durationMs = Date.now() - start;
  if (durationMs > 200) {
    logger.warn('Slow query', { text, durationMs });
  }
  return result;
}

module.exports = { pool, query, sslFor };
