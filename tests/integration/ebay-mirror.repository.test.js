const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');

// Against the real local DB, per tests/integration/auth.test.js. The
// fixture user is an @example.com address, removed by tests/cleanup.js.

test.after(async () => {
  await pool.end();
});

async function fixtureConnection() {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Mirror test',
    credentials: { accessToken: 'a', refreshToken: 'r' },
  });
  return connection.id;
}

test('snapshots round-trip with their meta and sync time', async () => {
  const connectionId = await fixtureConnection();
  assert.strictEqual(await mirror.loadSnapshot(connectionId, 'listings:active'), null);

  await mirror.saveSnapshot(connectionId, 'listings:active', { items: [{ itemId: '1' }] }, { totalPages: 1 });
  const loaded = await mirror.loadSnapshot(connectionId, 'listings:active');
  assert.deepStrictEqual(loaded.value, { items: [{ itemId: '1' }] });
  assert.deepStrictEqual(loaded.meta, { totalPages: 1 });
  assert.ok(Date.now() - loaded.syncedAt < 5000);

  await mirror.saveSnapshot(connectionId, 'listings:active', { items: [] }, { totalPages: 0 });
  assert.deepStrictEqual((await mirror.loadSnapshot(connectionId, 'listings:active')).value, { items: [] });
});

test('orders upsert in place, load newest first within the horizon, and prune', async () => {
  const connectionId = await fixtureConnection();
  const day = 24 * 60 * 60 * 1000;
  const recent = { orderId: 'A', createdAt: new Date(Date.now() - 1 * day).toISOString(), status: 'Active' };
  const older = { orderId: 'B', createdAt: new Date(Date.now() - 10 * day).toISOString(), status: 'Active' };
  const ancient = { orderId: 'C', createdAt: new Date(Date.now() - 100 * day).toISOString(), status: 'Active' };

  await mirror.upsertOrders(connectionId, [older, recent, ancient]);
  await mirror.upsertOrders(connectionId, [{ ...recent, status: 'Completed' }]);

  const loaded = await mirror.loadOrders(connectionId, new Date(Date.now() - 90 * day));
  assert.deepStrictEqual(loaded.map((o) => o.orderId), ['A', 'B']);
  assert.strictEqual(loaded[0].status, 'Completed');

  await mirror.pruneOrdersBefore(connectionId, new Date(Date.now() - 5 * day));
  const after = await mirror.loadOrders(connectionId, new Date(0));
  assert.deepStrictEqual(after.map((o) => o.orderId), ['A']);
});

test('item summaries are shared by item id', async () => {
  const itemId = `test-${Date.now()}`;
  await mirror.saveItemSummary(itemId, { itemId, imageUrl: 'https://i.ebayimg.com/x.jpg' });
  const loaded = await mirror.loadItemSummaries([itemId, 'missing']);
  assert.strictEqual(loaded.size, 1);
  assert.strictEqual(loaded.get(itemId).summary.imageUrl, 'https://i.ebayimg.com/x.jpg');
  await pool.query('DELETE FROM ebay_item_summaries WHERE item_id = $1', [itemId]);
});
