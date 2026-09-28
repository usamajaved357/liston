const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const orderRepository = require('../../src/modules/orders/order.repository');
const orderMessages = require('../../src/modules/orders/order-messages');

// The delivered thank-you's settings: off until the owner switches it on,
// worded by them (or the default), and what it has sent lately.

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

test('the owner switches the delivered message on and words it; members cannot; the page shows what it sent', async () => {
  const email = `messages-owner-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Messages Store', credentials: { accessToken: 'x' } });
  const base = `/api/connections/${connection.id}/messages`;

  const first = await request('GET', base, undefined, data.token);
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual([first.data.delivered.enabled, first.data.delivered.text, first.data.delivered.enabledAt], [false, null, null], 'off until switched on');
  assert.strictEqual(first.data.delivered.defaultText, orderMessages.DELIVERED_DEFAULT);
  assert.strictEqual(first.data.canMessage, false, 'a token from before the messaging scope needs a reconnect');

  const on = await request('PUT', base, { delivered: { enabled: true, text: 'Thanks {buyer}! Any problem, just reply.' } }, data.token);
  assert.strictEqual(on.status, 200);
  assert.strictEqual(on.data.delivered.enabled, true);
  assert.strictEqual(on.data.delivered.text, 'Thanks {buyer}! Any problem, just reply.');
  const since = on.data.delivered.enabledAt;
  assert.ok(since, 'deliveries count from when it was switched on');
  // Saving again keeps when it was switched on; the default wording is stored as none.
  const again = await request('PUT', base, { delivered: { enabled: true, text: orderMessages.DELIVERED_DEFAULT } }, data.token);
  assert.deepStrictEqual([again.data.delivered.enabledAt, again.data.delivered.text], [since, null]);
  const off = await request('PUT', base, { delivered: { enabled: false } }, data.token);
  assert.deepStrictEqual([off.data.delivered.enabled, off.data.delivered.enabledAt], [false, null]);
  assert.strictEqual((await request('PUT', base, { delivered: { enabled: true, text: 'x'.repeat(2001) } }, data.token)).status, 400);

  // What it sent shows on the page, and on the order.
  await orderRepository.saveMessage({ connectionId: connection.id, orderId: 'O-1', kind: 'delivered', status: 'sent', buyer: 'jane', itemId: '1', text: 'hi' });
  await orderRepository.saveMessage({ connectionId: connection.id, orderId: 'O-1', kind: 'delivered', status: 'sent', buyer: 'jane', itemId: '1', text: 'twice' });
  const shown = await request('GET', base, undefined, data.token);
  assert.deepStrictEqual(shown.data.recent.last30, { sent: 1, failed: 0 }, 'once per order');
  assert.deepStrictEqual((await orderRepository.messagesForOrder(connection.id, 'O-1')).map((m) => m.status), ['sent']);

  // A member can't see or change it.
  const memberEmail = `messages-member-${crypto.randomUUID()}@example.com`;
  await request('POST', '/api/team/members', { email: memberEmail, password: 'memberpassword123', name: 'm' }, data.token);
  const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual((await request('GET', base, undefined, login.data.token)).status, 403);
});
