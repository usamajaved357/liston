const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { addMember } = require('../helpers/members');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');

// The Listings tab's quick price and stock edit: who may use it and what it
// accepts (eBay itself is covered by the unit tests; nothing here reaches it).

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('price and stock: listings access needed, an eBay item number, and a change to make', async () => {
  const email = `stock-owner-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Stock Store', credentials: { accessToken: 'x' } });
  const base = `/api/connections/${connection.id}/listings`;

  assert.strictEqual((await request('GET', `${base}/not-a-number/stock`, undefined, data.token)).status, 400);
  assert.strictEqual((await request('POST', `${base}/400000000001/stock`, { changes: [] }, data.token)).status, 400, 'nothing to change');
  assert.strictEqual((await request('POST', `${base}/400000000001/stock`, { changes: [{ key: 'item', quantity: -1 }] }, data.token)).status, 400);
  assert.strictEqual((await request('POST', `${base}/400000000001/stock`, { changes: [{ key: 'item', quantity: 1.5 }] }, data.token)).status, 400);

  // A member without access to the account's listings can't read or change it.
  const memberEmail = `stock-member-${crypto.randomUUID()}@example.com`;
  await addMember(baseUrl, data.token, { email: memberEmail, password: 'memberpassword123', name: 'm' });
  const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual((await request('GET', `${base}/400000000001/stock`, undefined, login.data.token)).status, 403);
  assert.strictEqual((await request('POST', `${base}/400000000001/stock`, { changes: [{ key: 'item', quantity: 2 }] }, login.data.token)).status, 403);
});
