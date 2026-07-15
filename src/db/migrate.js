#!/usr/bin/env node
/**
 * Minimal migration runner. No framework dependency, deliberately —
 * this project's migrations are simple enough that a heavier tool
 * (knex, node-pg-migrate) isn't worth the extra dependency yet.
 *
 * Usage:
 *   node src/db/migrate.js up      # apply all pending migrations
 *   node src/db/migrate.js down    # roll back the most recent migration
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
}

async function up(pool) {
  await ensureMigrationsTable(pool);
  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  const files = listMigrationFiles();
  let ranAny = false;

  for (const file of files) {
    const name = file.replace('.up.sql', '');
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`applied: ${name}`);
      ranAny = true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration failed: ${name} — ${err.message}`);
    } finally {
      client.release();
    }
  }

  if (!ranAny) console.log('nothing to apply, schema is up to date');
}

async function down(pool) {
  await ensureMigrationsTable(pool);
  const result = await pool.query(
    'SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1'
  );
  if (result.rows.length === 0) {
    console.log('no migrations to roll back');
    return;
  }
  const name = result.rows[0].name;
  const downFile = path.join(MIGRATIONS_DIR, `${name}.down.sql`);
  if (!fs.existsSync(downFile)) {
    throw new Error(`No down migration found for ${name} (expected ${downFile})`);
  }
  const sql = fs.readFileSync(downFile, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
    await client.query('COMMIT');
    console.log(`rolled back: ${name}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const direction = process.argv[2];
  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node src/db/migrate.js <up|down>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    if (direction === 'up') await up(pool);
    else await down(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
