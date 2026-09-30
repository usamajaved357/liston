const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');
const ebayFinances = require('../../src/modules/ebay/api/ebay.finances');
const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');

// What one order made, for the Inbox's details panel: eBay's figures from
// the copy Liston keeps (eBay's Finances API read once, and kept, when
// there's none or it's stale and not yet paid out), the supplier cost from
// the order page, profit. Orders access only. eBay's Finances API is stood in for.

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
test.afterEach(() => mock.restoreAll());

async function request(method, url, body, token) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function setup({ scopes = [ebayOauth.SCOPE_FINANCES] } = {}) {
  const email = `order-money-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, {
    platformKey: 'ebay',
    label: 'Walexo',
    credentials: {
      accessToken: 'token',
      refreshToken: 'refresh',
      accessTokenExpiresAt: Date.now() + 3600e3,
      scopes,
      marketplaceId: 'EBAY_GB',
      // A signing key in hand, so none is asked of eBay.
      signingKey: { id: 'k1', jwe: 'jwe', privateKey: 'private', expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString() },
    },
  });
  return { owner: { id: data.user.id, token: data.token }, connection };
}

// eBay's Finances API for one order: a sale with its fees, and an ad fee charged apart.
function stubFinances(orderId, { fail = false } = {}) {
  const calls = [];
  mock.method(ebayFinances, 'getOrderTransactions', async (token, id) => {
    calls.push(id);
    if (fail) throw new Error('eBay Finances API error (500)');
    return {
      transactions: [
        {
          transactionType: 'SALE',
          orderId,
          transactionStatus: 'FUNDS_AVAILABLE_FOR_PAYOUT',
          transactionDate: new Date().toISOString(),
          amount: { value: '8.65', currency: 'GBP' },
          totalFeeBasisAmount: { value: '10.23', currency: 'GBP' },
          totalFeeAmount: { value: '1.58', currency: 'GBP' },
          orderLineItems: [{ marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '1.28', currency: 'GBP' } }, { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.30', currency: 'GBP' } }] }],
        },
        { transactionType: 'NON_SALE_CHARGE', feeType: 'AD_FEE', bookingEntry: 'DEBIT', amount: { value: '0.52', currency: 'GBP' }, references: [{ referenceType: 'ORDER_ID', referenceId: orderId }] },
      ],
    };
  });
  return calls;
}

const url = (t, orderId) => `/api/connections/${t.connection.id}/orders/${encodeURIComponent(orderId)}/money`;

test("the figures Liston keeps answer at once, with the supplier cost and profit, and eBay isn't asked", async () => {
  const t = await setup();
  const calls = stubFinances('17-1');
  await mirror.upsertOrderFinances(t.connection.id, [{ orderId: '17-1', currency: 'GBP', gross: 10.23, fees: 2.1, adFees: 0.52, refunds: 0, earnings: 8.13, fundsStatus: 'Available', saleDate: null }]);
  await pool.query(`INSERT INTO order_sourcing (connection_id, order_id, line_item_id, cost_value, cost_currency) VALUES ($1, '17-1', 'L1', 4.2, 'GBP')`, [t.connection.id]);

  const res = await request('GET', url(t, '17-1'), null, t.owner.token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data, {
    currency: 'GBP',
    gross: 10.23,
    fees: 1.58,
    adFees: 0.52,
    refunds: 0,
    earnings: 8.13,
    fundsStatus: 'Available',
    cost: { value: 4.2, currency: 'GBP' },
    profit: 3.93,
    margin: 38.4,
    unavailable: null,
  });
  assert.deepStrictEqual(calls, []);
});

test("an order Liston has no figures for is read from eBay once, and kept for the next look", async () => {
  const t = await setup();
  const calls = stubFinances('17-2');
  const first = await request('GET', url(t, '17-2'), null, t.owner.token);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.data.gross, 10.23);
  assert.strictEqual(first.data.fees, 1.58, "eBay's own fees");
  assert.strictEqual(first.data.adFees, 0.52, 'the ad fee charged apart');
  assert.strictEqual(first.data.earnings, 8.13);
  assert.strictEqual(first.data.fundsStatus, 'Available');
  assert.strictEqual(first.data.profit, null, 'no supplier cost entered');
  assert.deepStrictEqual(calls, ['17-2']);

  const kept = await mirror.loadOrderFinances(t.connection.id, ['17-2']);
  assert.strictEqual(kept.get('17-2').earnings, 8.13, 'kept with the rest of the account’s figures');
  await request('GET', url(t, '17-2'), null, t.owner.token);
  assert.strictEqual(calls.length, 1, 'the next look needs no eBay call');
});

test('two looks at once share one eBay read', async () => {
  const t = await setup();
  const calls = stubFinances('17-8');
  const [a, b] = await Promise.all([request('GET', url(t, '17-8'), null, t.owner.token), request('GET', url(t, '17-8'), null, t.owner.token)]);
  assert.strictEqual(a.data.earnings, 8.13);
  assert.strictEqual(b.data.earnings, 8.13);
  assert.deepStrictEqual(calls, ['17-8']);
});

test("figures not yet paid out are read again once they're old; if eBay fails, the kept ones still show", async () => {
  const t = await setup();
  const row = { orderId: '17-3', currency: 'GBP', gross: 10.23, fees: 2.1, adFees: 0.52, refunds: 0, earnings: 8.13, fundsStatus: 'Pending', saleDate: null };
  await mirror.upsertOrderFinances(t.connection.id, [row, { ...row, orderId: '17-4', fundsStatus: 'Paid out' }]);
  await pool.query(`UPDATE ebay_order_finances SET synced_at = now() - interval '1 day' WHERE connection_id = $1`, [t.connection.id]);

  const calls = stubFinances('17-3', { fail: true });
  const stale = await request('GET', url(t, '17-3'), null, t.owner.token);
  assert.strictEqual(stale.status, 200);
  assert.deepStrictEqual(calls, ['17-3']);
  assert.strictEqual(stale.data.earnings, 8.13);
  assert.strictEqual(stale.data.fundsStatus, 'Pending');
  assert.strictEqual(stale.data.unavailable, null);

  const settled = await request('GET', url(t, '17-4'), null, t.owner.token);
  assert.strictEqual(settled.data.fundsStatus, 'Paid out');
  assert.deepStrictEqual(calls, ['17-3'], 'paid out: final, never read again');

  mock.restoreAll();
  const fresh = stubFinances('17-3');
  const again = await request('GET', url(t, '17-3'), null, t.owner.token);
  assert.deepStrictEqual(fresh, ['17-3']);
  assert.strictEqual(again.data.fundsStatus, 'Available', "eBay's newer word replaces the kept one");
});

test("an account linked without the finances permission says so, and eBay isn't asked", async () => {
  const t = await setup({ scopes: [] });
  const calls = stubFinances('17-5');
  await pool.query(`INSERT INTO order_sourcing (connection_id, order_id, line_item_id, cost_value, cost_currency) VALUES ($1, '17-5', 'L1', 3, 'GBP')`, [t.connection.id]);
  const res = await request('GET', url(t, '17-5'), null, t.owner.token);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.unavailable, 'scope');
  assert.strictEqual(res.data.earnings, null);
  assert.deepStrictEqual(res.data.cost, { value: 3, currency: 'GBP' }, 'the supplier cost still shows');
  assert.deepStrictEqual(calls, []);
});

test('a sale eBay has not posted yet says so', async () => {
  const t = await setup();
  mock.method(ebayFinances, 'getOrderTransactions', async () => ({ transactions: [] }));
  const res = await request('GET', url(t, '17-6'), null, t.owner.token);
  assert.strictEqual(res.data.unavailable, 'pending');
  const kept = await mirror.loadOrderFinances(t.connection.id, ['17-6']);
  assert.strictEqual(kept.has('17-6'), false, 'nothing kept');
});

test("a member sees an order's money only with Orders access there", async () => {
  const t = await setup();
  stubFinances('17-7');
  await mirror.upsertOrderFinances(t.connection.id, [{ orderId: '17-7', currency: 'GBP', gross: 5, fees: 1, adFees: 0, refunds: 0, earnings: 4, fundsStatus: 'Paid out', saleDate: null }]);
  const email = `order-money-member-${crypto.randomUUID()}@example.com`;
  const added = await request('POST', '/api/team/members', { email, password: 'memberpassword123', name: 'Sara' }, t.owner.token);
  const memberId = added.data.id || added.data.member?.id;
  await request('PUT', `/api/team/members/${memberId}/permissions`, { permissions: [{ connectionId: t.connection.id, feature: 'inbox', allowed: true }] }, t.owner.token);
  const login = await request('POST', '/api/auth/login', { email, password: 'memberpassword123' });

  const denied = await request('GET', url(t, '17-7'), null, login.data.token);
  assert.strictEqual(denied.status, 403);

  await request('PUT', `/api/team/members/${memberId}/permissions`, { permissions: [{ connectionId: t.connection.id, feature: 'orders', allowed: true }] }, t.owner.token);
  const allowed = await request('GET', url(t, '17-7'), null, login.data.token);
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.data.earnings, 4);
});
