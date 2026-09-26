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

test('order money rows are stored per order, updated in place, and read back with supplier costs', async () => {
  const connectionId = await fixtureConnection();
  const orderRepository = require('../../src/modules/orders/order.repository');
  const row = { orderId: 'O-1', currency: 'GBP', gross: 5.69, fees: 2.33, adFees: 1.28, refunds: 0, earnings: 3.36, fundsStatus: 'Pending', saleDate: '2026-09-24T18:49:21.717Z' };
  await mirror.upsertOrderFinances(connectionId, [row, { ...row, orderId: 'O-2', earnings: 1 }]);
  await mirror.upsertOrderFinances(connectionId, [{ ...row, refunds: 3.36, earnings: 0, fundsStatus: 'Available' }]);
  const money = await mirror.loadOrderFinances(connectionId, ['O-1', 'O-2', 'O-3']);
  assert.deepStrictEqual(money.get('O-1'), { currency: 'GBP', gross: 5.69, fees: 2.33, adFees: 1.28, refunds: 3.36, earnings: 0, fundsStatus: 'Available' });
  assert.strictEqual(money.get('O-2').earnings, 1);
  assert.strictEqual(money.has('O-3'), false);

  // Two supplier orders for one eBay order add up; a line with no cost doesn't count.
  await pool.query(
    `INSERT INTO order_sourcing (connection_id, order_id, line_item_id, cost_value, cost_currency) VALUES ($1, 'O-1', 'L1', 1.5, 'GBP'), ($1, 'O-1', 'L2', 2.25, 'GBP'), ($1, 'O-2', 'L3', NULL, NULL)`,
    [connectionId]
  );
  const costs = await orderRepository.sourceCostsByOrder(connectionId, ['O-1', 'O-2']);
  assert.deepStrictEqual(costs.get('O-1'), { value: 3.75, currency: 'GBP' });
  assert.strictEqual(costs.has('O-2'), false);
});

test("an account's charges are read back by currency and dates, a charge its older sibling connection also saw counts there only, and old ones are let go", async () => {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const link = (label) => connectionService.createConnection(user.id, { platformKey: 'ebay', label, credentials: { accessToken: 'a', refreshToken: 'r' } });
  const uk = (await link('Charges UK')).id;
  const au = (await link('Charges AU')).id;
  const otherOwner = await fixtureConnection();
  const row = (transactionId, kind, amount, currency, chargedAt) => ({ transactionId, kind, feeType: null, amount, currency, itemId: null, memo: null, chargedAt });
  const subscription = row('T-SUB', 'store', 27.99, 'GBP', '2026-09-20T09:00:00Z');
  await mirror.upsertAccountCharges(uk, [subscription, row('T-INS', 'listing', 0.35, 'GBP', '2026-09-21T09:00:00Z'), row('T-OLD', 'listing', 1, 'GBP', '2026-05-01T09:00:00Z')]);
  // eBay bills the account, so its Australian connection reads the same charges.
  await mirror.upsertAccountCharges(au, [subscription, row('T-AUD', 'listing', 0.5, 'AUD', '2026-09-21T09:00:00Z')]);
  await mirror.upsertAccountCharges(otherOwner, [subscription]);
  // Read again with a credit back: updated in place.
  await mirror.upsertAccountCharges(uk, [{ ...row('T-INS', 'listing', -0.35, 'GBP', '2026-09-21T09:00:00Z'), feeType: 'INSERTION_FEE' }]);

  const window = [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T23:59:59.999Z')];
  const ofUk = await mirror.loadAccountCharges(uk, 'GBP', ...window);
  assert.deepStrictEqual(ofUk.map((c) => [c.kind, c.amount]).sort(), [['listing', -0.35], ['store', 27.99]]);
  assert.deepStrictEqual(await mirror.loadAccountCharges(au, 'GBP', ...window), [], 'the shop subscription counts on the older UK connection only');
  assert.deepStrictEqual((await mirror.loadAccountCharges(au, 'AUD', ...window)).map((c) => c.amount), [0.5]);
  assert.strictEqual((await mirror.loadAccountCharges(otherOwner, 'GBP', ...window)).length, 1, "another owner's connection keeps its own");
  assert.deepStrictEqual(await mirror.loadAccountCharges(uk, 'GBP', new Date('2026-09-20T09:00:01Z'), new Date('2026-09-20T23:00:00Z')), [], 'outside the dates');

  await mirror.pruneAccountChargesBefore(uk, new Date('2026-06-01T00:00:00Z'));
  const left = await pool.query('SELECT transaction_id FROM ebay_account_charges WHERE connection_id = $1 ORDER BY transaction_id', [uk]);
  assert.deepStrictEqual(left.rows.map((r) => r.transaction_id), ['T-INS', 'T-SUB']);
});

test('an account\'s listing work counts drafts made and listings published in the dates, and drafts waiting now', async () => {
  const connectionId = await fixtureConnection();
  const listingRepository = require('../../src/modules/listings/listing.repository');
  const add = (status, createdAt, updatedAt, editOf = null) =>
    pool.query(`INSERT INTO listings (connection_id, status, created_at, updated_at, edit_of_item_id) VALUES ($1, $2, $3, $4, $5)`, [connectionId, status, createdAt, updatedAt, editOf]);
  await add('pending_review', '2026-09-10T10:00:00Z', '2026-09-10T10:00:00Z'); // drafted in range, waiting
  await add('published', '2026-09-05T10:00:00Z', '2026-09-12T10:00:00Z'); // drafted and published in range
  await add('published', '2026-08-01T10:00:00Z', '2026-08-02T10:00:00Z'); // both before the range
  await add('pending_review', '2026-09-11T10:00:00Z', '2026-09-11T10:00:00Z', '406000000001'); // an edit of a live listing: not new
  const work = await listingRepository.countListingWork(connectionId, new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  assert.deepStrictEqual(work, { drafted: 2, published: 1, waiting: 1 });
});
