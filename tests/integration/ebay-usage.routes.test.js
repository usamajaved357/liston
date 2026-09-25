const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const config = require('../../src/config');
const browseUsage = require('../../src/modules/ebay/browse-usage');

const app = createApp();
let server;
let baseUrl;
const admins = config.adminEmails;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  config.adminEmails = admins;
  browseUsage._reset();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function signUp(email) {
  const res = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'testpassword123' }) });
  const data = await res.json();
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return data.token;
}

test("the admin's eBay usage includes the Browse allowance: who used it, which calls, and research's share", async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  config.adminEmails = [...admins, email];
  const auth = await signUp(email);
  browseUsage._reset();
  browseUsage.record('getItemByLegacyId');
  await browseUsage.as('research', async () => {
    browseUsage.record('search');
    browseUsage.record('getItem');
    browseUsage.record('getItem');
  });

  const res = await fetch(`${baseUrl}/api/ebay/usage`, { headers: { Authorization: `Bearer ${auth}` } });
  assert.strictEqual(res.status, 200);
  const { browse, claude } = await res.json();
  assert.strictEqual(claude.days.length, 14);
  assert.ok(claude.purposes['draft.write']);
  assert.strictEqual(browse.used, 4);
  assert.strictEqual(browse.limit, 5000);
  assert.deepStrictEqual(browse.byKind, [
    { name: 'research', count: 3 },
    { name: 'drafting', count: 1 },
  ]);
  assert.deepStrictEqual(browse.byCall[0], { name: 'getItem', count: 2 });
  assert.strictEqual(browse.research.limit, config.research.dailyCalls);
  assert.strictEqual(browse.research.resetAt, browse.resetAt, 'research resets with the allowance');

  const someone = await signUp(`test-${crypto.randomUUID()}@example.com`);
  const refused = await fetch(`${baseUrl}/api/ebay/usage`, { headers: { Authorization: `Bearer ${someone}` } });
  assert.strictEqual(refused.status, 403);
});
