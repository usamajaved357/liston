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
  assert.deepStrictEqual([shown.data.recent.last30.sent, shown.data.recent.last30.failed], [1, 0], 'once per order');
  assert.deepStrictEqual((await orderRepository.messagesForOrder(connection.id, 'O-1')).map((m) => m.status), ['sent']);

  // A member can't see or change it.
  const memberEmail = `messages-member-${crypto.randomUUID()}@example.com`;
  await request('POST', '/api/team/members', { email: memberEmail, password: 'memberpassword123', name: 'm' }, data.token);
  const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
  assert.strictEqual((await request('GET', base, undefined, login.data.token)).status, 403);
});

test('the order-placed welcome: switched on and worded on its own, signed with the store, the delivered one left as it was', async () => {
  const email = `messages-placed-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Duck Shop', credentials: { accessToken: 'x' } });
  const base = `/api/connections/${connection.id}/messages`;

  const first = await request('GET', base, undefined, data.token);
  assert.deepStrictEqual([first.data.placed.enabled, first.data.placed.text, first.data.placed.defaultText], [false, null, orderMessages.PLACED_DEFAULT]);
  assert.strictEqual(first.data.store, 'Duck Shop', "no store name typed or read from eBay: the account's name");
  assert.match(first.data.placed.defaultText, /Best regards,\n\{store\}$/);

  const on = await request('PUT', base, { placed: { enabled: true, text: 'Thanks {buyer}!\n\nBest regards,\n{store}' } }, data.token);
  assert.strictEqual(on.status, 200);
  assert.ok(on.data.placed.enabledAt, 'orders count from when it was switched on');
  assert.strictEqual(on.data.placed.text, 'Thanks {buyer}!\n\nBest regards,\n{store}');
  assert.deepStrictEqual([on.data.delivered.enabled, on.data.delivered.enabledAt], [false, null], 'the delivered message untouched');
  // Switching it off and on keeps no old start; leaving out the text keeps the wording.
  const off = await request('PUT', base, { placed: { enabled: false } }, data.token);
  assert.deepStrictEqual([off.data.placed.enabled, off.data.placed.enabledAt, off.data.placed.text], [false, null, 'Thanks {buyer}!\n\nBest regards,\n{store}']);
  assert.strictEqual((await request('PUT', base, {}, data.token)).status, 400, 'nothing to change');

  // The store name typed in the description template signs the messages.
  await connectionService.updateConnectionSettings(connection.id, data.user.id, { template: { storeName: 'Duck & Co' } });
  assert.strictEqual((await request('GET', base, undefined, data.token)).data.store, 'Duck & Co');
});

test('a message is claimed before it is sent: two runs at once send it once, a buyer is welcomed once a day, a send cut off is closed and never retried', async () => {
  const email = `messages-claim-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Claim Store', credentials: { accessToken: 'x' } });
  const claim = (orderId, buyer = 'kevin', kind = 'placed') => orderRepository.claimMessage({ connectionId: connection.id, orderId, kind, buyer, itemId: '1', text: 'hi', buyerGapHours: kind === 'placed' ? 24 : 0 });

  // The push and the hourly run reach the same order at the same moment: one sends.
  const same = await Promise.all([claim('O-1'), claim('O-1'), claim('O-1')]);
  assert.deepStrictEqual(same.sort(), ['claimed', 'taken', 'taken']);
  // The same buyer's second and third orders that day, at the same moment: noted, not messaged.
  const again = await Promise.all([claim('O-2'), claim('O-3')]);
  assert.deepStrictEqual(again, ['skipped', 'skipped']);
  const skipped = await pool.query("SELECT error FROM order_messages WHERE connection_id = $1 AND order_id = 'O-2'", [connection.id]);
  assert.match(skipped.rows[0].error, /order O-1/);
  // Two different buyers at once: both welcomed.
  assert.deepStrictEqual(await Promise.all([claim('O-4', 'sara'), claim('O-5', 'tom')]), ['claimed', 'claimed']);
  // The delivered thank-you has no daily limit per buyer, and is its own message.
  assert.strictEqual(await claim('O-1', 'kevin', 'delivered'), 'claimed');

  await orderRepository.finishMessage({ connectionId: connection.id, orderId: 'O-1', kind: 'placed', status: 'sent', conversationId: 'conv-1' });
  assert.strictEqual(await claim('O-1'), 'taken', 'sent: never again');
  await orderRepository.finishMessage({ connectionId: connection.id, orderId: 'O-4', kind: 'placed', status: 'failed', error: 'The buyer has blocked messages.' });
  assert.strictEqual(await claim('O-4', 'sara'), 'taken', 'refused: not retried');

  // O-5 was cut off mid-send: closed as failed after a while, and not sent again.
  await pool.query("UPDATE order_messages SET sent_at = now() - interval '20 minutes' WHERE connection_id = $1 AND order_id = 'O-5'", [connection.id]);
  assert.ok((await orderRepository.closeStaleClaims(15)) >= 1);
  const rows = await pool.query('SELECT order_id, kind, status FROM order_messages WHERE connection_id = $1 ORDER BY order_id, kind', [connection.id]);
  assert.deepStrictEqual(rows.rows.map((r) => `${r.order_id}:${r.kind}:${r.status}`), ['O-1:delivered:sending', 'O-1:placed:sent', 'O-2:placed:skipped', 'O-3:placed:skipped', 'O-4:placed:failed', 'O-5:placed:failed']);
  assert.strictEqual(await claim('O-5', 'tom'), 'taken');

  // Settings count what went, by message; a send in flight isn't listed.
  const recent = await orderRepository.recentMessages(connection.id);
  assert.deepStrictEqual(recent.last30.byKind.placed, { sent: 1, failed: 2, skipped: 2 });
  assert.ok(!recent.items.some((m) => m.status === 'sending'));
});
