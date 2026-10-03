const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const listingService = require('../../src/modules/listings/listing.service');

// The Orders and Listings pages' CSV downloads, with eBay's copy of the
// account stood in for: the workspace owner and co-managers only, the page's
// filters passed through untouched (and no eBay reads for photos), only the
// ticked rows when some are, the supplier orders' tracking and numbers in
// and their logins never.

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

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const PASSWORD = 'exportpassword123';

async function setup() {
  const email = `exports-${crypto.randomUUID()}@example.com`;
  const signup = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, name: 'Usama' }) }).then((r) => r.json());
  const ownerId = signup.user.id;
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [ownerId]);
  const connection = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Walexo Store', credentials: { accessToken: 'fake', refreshToken: 'fake', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB' } });

  // A supplier login saved on Liston, and a supplier order on one of the orders that used it.
  const { rows } = await pool.query(`INSERT INTO source_accounts (owner_user_id, platform, label, email, password) VALUES ($1, 'aliexpress', 'Main AliExpress', 'supplier-login@example.com', 'SUPPLIER-PASSWORD') RETURNING id`, [ownerId]);
  await pool.query(
    `INSERT INTO order_sourcing (connection_id, order_id, line_item_id, status, source_account_id, source_order_no, cost_value, cost_currency, tracking_number, carrier, notes, card_label, source_email, source_password)
     VALUES ($1, 'ORDER-A', 'line-0', 'shipped', $2, 'AE-900', 6.20, 'GBP', 'LP123', 'Cainiao', 'Gift wrap', 'Visa 4242', 'raw-login@example.com', 'RAW-PASSWORD')`,
    [connection.id, rows[0].id]
  );
  // The draft listing 111 was published from, with its supplier link.
  await pool.query(`INSERT INTO listings (connection_id, status, external_product_id, source_data) VALUES ($1, 'published', '111', $2)`, [connection.id, JSON.stringify({ source: { sourceUrl: 'https://www.aliexpress.com/item/111.html' } })]);

  const member = async (name, perms) => {
    const memberEmail = `exports-${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
    const added = await fetch(`${baseUrl}/api/team/members`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signup.token}` }, body: JSON.stringify({ email: memberEmail, name, password: PASSWORD }) }).then((r) => r.json());
    if (perms) await request('PUT', `/api/team/members/${added.member.id}/permissions`, { permissions: perms }, signup.token);
    if (name === 'Bilal') await request('PUT', `/api/team/members/${added.member.id}/owner-access`, { ownerAccess: true }, signup.token);
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password: PASSWORD }) }).then((r) => r.json());
    return login.token;
  };
  return {
    owner: signup.token,
    connection,
    sara: await member('Sara', [
      { connectionId: connection.id, feature: 'orders', allowed: true },
      { connectionId: connection.id, feature: 'listings', allowed: true },
    ]),
    bilal: await member('Bilal'),
  };
}

const ORDERS = [
  {
    orderId: 'ORDER-A',
    derivedStatus: 'dispatched',
    createdAt: '2026-09-30T09:00:00Z',
    buyerUserId: 'buyer_a',
    shippingAddress: { name: 'Jo Buyer', street1: '1 High St', city: 'Leeds', postalCode: 'LS1 1AA', country: 'GB' },
    total: { amount: '24.99', currency: 'GBP' },
    lineItems: [{ itemId: '111', title: 'Red mug', quantityPurchased: 1, price: { amount: '24.99' }, variation: [], trackingNumber: 'TRK1', trackingCarrier: 'Royal Mail' }],
  },
  {
    orderId: 'ORDER-B',
    derivedStatus: 'dispatched',
    createdAt: '2026-09-29T09:00:00Z',
    buyerUserId: 'buyer_b',
    shippingAddress: { name: 'Sam Buyer', city: 'York', country: 'GB' },
    total: { amount: '9.99', currency: 'GBP' },
    lineItems: [{ itemId: '222', title: 'Blue plate', quantityPurchased: 1, price: { amount: '9.99' }, variation: [] }],
  },
];

function stubOrders() {
  const calls = [];
  mock.method(ebayService, 'listOrdersDetailed', async (_credentials, options) => {
    calls.push(options);
    return { orders: ORDERS, counts: {}, totalEntries: ORDERS.length, totalPages: 1, page: 1, perPage: options.perPage };
  });
  return calls;
}

test("orders: the page's filters, every page of them, supplier tracking in and supplier logins out", async () => {
  const { owner, connection } = await setup();
  const calls = stubOrders();
  const res = await request('GET', `/api/connections/${connection.id}/orders/export?range=30d&status=dispatched&search=mug&sort=oldest&supplier=shipped`, null, owner);
  assert.strictEqual(res.status, 200, res.text);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="orders-walexo-store-dispatched-30d-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.strictEqual(res.headers.get('x-liston-rows'), '2');

  // The same reading the page makes, all of it, without a photo lookup per item.
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(
    [calls[0].range, calls[0].status, calls[0].search, calls[0].sort, calls[0].supplier, calls[0].page, calls[0].enrich],
    ['30d', 'dispatched', 'mug', 'oldest', 'shipped', 1, false]
  );
  assert.ok(calls[0].perPage >= 1e6);

  const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 3, 'a header and two orders');
  assert.match(lines[0], /^Order ID,Sales record,Status/);
  const a = lines.find((l) => l.startsWith('ORDER-A'));
  for (const expected of ['Red mug', 'TRK1', 'Royal Mail', 'Main AliExpress', 'AE-900', 'LP123', 'Cainiao', 'Gift wrap', 'Leeds', 'https://www.ebay.co.uk/itm/111', 'https://www.aliexpress.com/item/111.html']) {
    assert.ok(a.includes(expected), `${expected} in the order's row`);
  }
  for (const secret of ['SUPPLIER-PASSWORD', 'supplier-login@example.com', 'RAW-PASSWORD', 'raw-login@example.com', 'Visa 4242']) {
    assert.ok(!res.text.includes(secret), `${secret} must never be in the file`);
  }
});

test('orders: only the ticked ones when some are', async () => {
  const { owner, connection } = await setup();
  stubOrders();
  const res = await request('GET', `/api/connections/${connection.id}/orders/export?status=dispatched&ids=ORDER-B`, null, owner);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /-selected-/);
  const lines = res.text.trim().split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[1].startsWith('ORDER-B'));
});

test('listings: every listing the filters show, with its supplier link; only the ticked ones when some are', async () => {
  const { owner, connection } = await setup();
  const calls = [];
  mock.method(listingService, 'pageOfListings', async (_credentials, options) => {
    calls.push(options);
    return {
      items: [
        { itemId: '111', sku: 'MUG-R', title: 'Red mug', price: { amount: '9.99', currency: 'GBP' }, quantity: 10, quantityAvailable: 7, quantitySold: 3, viewItemUrl: 'https://www.ebay.co.uk/itm/111' },
        { itemId: '222', sku: 'PLT-B', title: 'Blue plate', price: { amount: '7.50', currency: 'GBP' }, quantity: 5, quantityAvailable: 5, quantitySold: 0 },
      ],
      totalEntries: 2,
    };
  });
  const all = await request('GET', `/api/connections/${connection.id}/listings/export?status=inactive&q=mug&sort=price_high`, null, owner);
  assert.strictEqual(all.status, 200, all.text);
  assert.deepStrictEqual([calls[0].status, calls[0].search, calls[0].sort, calls[0].perPage, calls[0].page], ['inactive', 'mug', 'price_high', 0, 1]);
  assert.match(all.headers.get('content-disposition'), /listings-walexo-store-ended-/);
  const rows = all.text.trim().split('\r\n');
  assert.strictEqual(rows.length, 3);
  const mug = rows.find((l) => l.startsWith('111,MUG-R,Red mug,Ended'));
  assert.ok(mug && mug.includes('https://www.aliexpress.com/item/111.html'), "the listing's supplier link");

  const one = await request('GET', `/api/connections/${connection.id}/listings/export?ids=222`, null, owner);
  assert.deepStrictEqual(one.text.trim().split('\r\n').slice(1).map((l) => l.split(',')[0]), ['222']);
});

test('only the workspace owner and co-managers download; a member with Orders and Listings is refused', async () => {
  const { sara, bilal, connection } = await setup();
  stubOrders();
  mock.method(listingService, 'pageOfListings', async () => ({ items: [], totalEntries: 0 }));
  assert.strictEqual((await request('GET', `/api/connections/${connection.id}/orders/export`, null, sara)).status, 403);
  assert.strictEqual((await request('GET', `/api/connections/${connection.id}/listings/export`, null, sara)).status, 403);
  assert.strictEqual((await request('GET', `/api/connections/${connection.id}/orders/export`, null, bilal)).status, 200);
  assert.strictEqual((await request('GET', `/api/connections/${connection.id}/listings/export`, null, bilal)).status, 200);
});
