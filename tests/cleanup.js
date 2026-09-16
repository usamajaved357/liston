#!/usr/bin/env node
// Runs after the whole suite (see package.json "test"). Every fixture
// account uses an @example.com address; removing them keeps a dev database
// — and the admin's Access requests page — free of thousands of test users.
// Done here rather than per file because test files run concurrently and
// would delete each other's fixtures mid-run.
process.env.NODE_ENV = 'test';
require('dotenv').config();
const { pool } = require('../src/db/client');

(async () => {
  const { rowCount } = await pool.query("DELETE FROM users WHERE email LIKE '%@example.com'");
  console.log(`cleanup: removed ${rowCount} fixture user(s)`);
  await pool.end();
})().catch(async (err) => {
  console.error('cleanup failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
