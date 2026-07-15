const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
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

module.exports = { pool, query };
