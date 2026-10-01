const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const ebayService = require('../../src/modules/ebay/ebay.service');
const orderRepository = require('../../src/modules/orders/order.repository');
const orderService = require('../../src/modules/orders/order.service');

// Against the real local DB (fixture users are @example.com, removed by
// tests/cleanup.js). eBay itself is mocked at the service boundary.

test.after(async () => {
  await pool.end();
});

async function fixture() {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const { user } = await authService.signup({ email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(user.id, {
    platformKey: 'ebay',
    label: 'Orders test',
    credentials: { accessToken: 'a', refreshToken: 'r', scopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment'] },
  });
  return { userId: user.id, connectionId: connection.id };
}

test('source accounts are created per owner and listed without archived ones', async () => {
  const { userId } = await fixture();
  const a = await orderService.createSourceAccount(userId, { label: 'AE main', email: 'buyer@example.com', password: 'Welcome123.' });
  assert.strictEqual(a.password, 'Welcome123.');
  await orderService.createSourceAccount(userId, { label: 'AE old', email: 'old@example.com' });
  const both = await orderService.listSourceAccounts(userId);
  assert.deepStrictEqual(both.map((x) => x.label), ['AE main', 'AE old']);
  await orderService.updateSourceAccount(userId, both[1].id, { archived: true });
  assert.deepStrictEqual((await orderService.listSourceAccounts(userId)).map((x) => x.label), ['AE main']);
  assert.strictEqual((await orderService.listSourceAccounts(userId, { includeArchived: true })).length, 2);
});

test('saving a supplier order number marks the line ordered and stamps who placed it', async () => {
  const { userId, connectionId } = await fixture();
  const { sourcing, dispatch } = await orderService.saveSourcing(connectionId, userId, userId, '14-15180-83196', '10012345678901', {
    sourceOrderNo: '3075828642684994',
    cardLabel: 'tide',
    cost: { value: '2.10', currency: 'GBP' },
  });
  assert.strictEqual(sourcing.status, 'ordered');
  assert.strictEqual(sourcing.sourceOrderNo, '3075828642684994');
  assert.strictEqual(sourcing.placedBy.id, userId);
  assert.ok(sourcing.placedAt);
  assert.deepStrictEqual(sourcing.cost, { value: 2.1, currency: 'GBP' });
  assert.strictEqual(dispatch, null);
  const events = await orderRepository.listEvents(connectionId, '14-15180-83196');
  assert.strictEqual(events[0].kind, 'sourcing.ordered');
});

test('a new tracking number dispatches the line on eBay with the detected carrier', async () => {
  const { userId, connectionId } = await fixture();
  const dispatchMock = mock.method(ebayService, 'dispatchOrder', async (credentials, input) => {
    assert.strictEqual(input.orderId, '06-15194-96822');
    assert.deepStrictEqual(input.lineItems, [{ lineItemId: '10012345678902', quantity: 1 }]);
    assert.strictEqual(input.carrier, 'Yodel');
    assert.strictEqual(input.trackingNumber, 'JJD0002235251158835');
    return { fulfillmentId: 'ful-1' };
  });
  try {
    const { sourcing, dispatch } = await orderService.saveSourcing(connectionId, userId, userId, '06-15194-96822', '10012345678902', {
      trackingNumber: 'JJD 0002 2352 5115 8835',
    });
    assert.strictEqual(dispatch.ok, true);
    assert.strictEqual(sourcing.status, 'shipped');
    assert.strictEqual(sourcing.carrier, 'Yodel');
    assert.strictEqual(sourcing.ebayFulfillmentId, 'ful-1');
    assert.strictEqual(sourcing.dispatchedBy.id, userId);

    // Saving the same number again does not dispatch twice.
    await orderService.saveSourcing(connectionId, userId, userId, '06-15194-96822', '10012345678902', { trackingNumber: 'JJD0002235251158835', notes: 'x' });
    assert.strictEqual(dispatchMock.mock.calls.length, 1);
  } finally {
    dispatchMock.mock.restore();
  }
});

test('a line without a Fulfillment id keeps the tracking but says why it was not dispatched', async () => {
  const { userId, connectionId } = await fixture();
  const dispatchMock = mock.method(ebayService, 'dispatchOrder', async () => {
    throw new Error('should not be called');
  });
  try {
    const { sourcing, dispatch } = await orderService.saveSourcing(connectionId, userId, userId, '12-1', 'line-0', { trackingNumber: 'H06R4A0218426976' });
    assert.strictEqual(sourcing.trackingNumber, 'H06R4A0218426976');
    assert.strictEqual(sourcing.carrier, 'Evri');
    assert.strictEqual(dispatch.ok, false);
    assert.match(dispatch.reason, /Reconnect/);
    assert.strictEqual(dispatchMock.mock.calls.length, 0);
  } finally {
    dispatchMock.mock.restore();
  }
});

test('an eBay dispatch failure is reported without losing the saved tracking', async () => {
  const { userId, connectionId } = await fixture();
  const dispatchMock = mock.method(ebayService, 'dispatchOrder', async () => {
    const err = new Error('Order actions need eBay permissions this connection was linked without.');
    err.code = 'EBAY_SCOPE_MISSING';
    throw err;
  });
  try {
    const { sourcing, dispatch } = await orderService.saveSourcing(connectionId, userId, userId, '12-2', '100999', { trackingNumber: 'RB123456789GB' });
    assert.strictEqual(sourcing.trackingNumber, 'RB123456789GB');
    assert.strictEqual(sourcing.status, 'shipped');
    assert.strictEqual(sourcing.ebayFulfillmentId, null);
    assert.strictEqual(dispatch.ok, false);
    assert.strictEqual(dispatch.code, 'EBAY_SCOPE_MISSING');
  } finally {
    dispatchMock.mock.restore();
  }
});

test('sourcing keeps the supplier login on the line itself', async () => {
  const { userId, connectionId } = await fixture();
  const { sourcing } = await orderService.saveSourcing(connectionId, userId, userId, '14-9', '10077', {
    sourceEmail: 'buyer@example.com',
    sourcePassword: 'Welcome123.',
    sourceOrderNo: '3075',
    cardLabel: 'tide',
  });
  assert.strictEqual(sourcing.sourceEmail, 'buyer@example.com');
  assert.strictEqual(sourcing.sourcePassword, 'Welcome123.');
  assert.strictEqual(sourcing.status, 'ordered');
});

test("the same item's other variations in the order take the supplier order saved on one (not its cost), and ship with it", async () => {
  const { userId, connectionId } = await fixture();
  const orderId = '14-15224-41553';
  const siblings = [
    { lineKey: '10022222222222', quantity: 1 },
    { lineKey: '10033333333333', quantity: 2 },
  ];
  // The third variation already went in its own parcel.
  await orderService.saveSourcing(connectionId, userId, userId, orderId, '10033333333333', { trackingNumber: 'LP00000000000001', dispatchOnEbay: false });

  const placed = await orderService.saveSourcing(connectionId, userId, userId, orderId, '10011111111111', {
    sourceEmail: 'flipx.ltd@example.com',
    sourcePassword: 'pw',
    sourceOrderNo: '3076965095733148',
    placedAt: '2026-10-01',
    cardLabel: 'Tide',
    notes: 'One AliExpress order',
    cost: { value: '2.63', currency: 'GBP' },
    trackingNumber: '',
    quantity: 1,
    alsoFor: siblings,
  });
  assert.deepStrictEqual(placed.siblings.map((x) => x.lineItemId).sort(), ['10022222222222', '10033333333333']);
  const second = placed.siblings.find((x) => x.lineItemId === '10022222222222');
  assert.deepStrictEqual([second.sourceEmail, second.sourcePassword, second.sourceOrderNo, second.cardLabel, second.notes, second.status, second.placedBy.id], ['flipx.ltd@example.com', 'pw', '3076965095733148', 'Tide', 'One AliExpress order', 'ordered', userId]);
  assert.strictEqual(second.cost, null, "each variation's own cost");
  const apart = placed.siblings.find((x) => x.lineItemId === '10033333333333');
  assert.deepStrictEqual([apart.sourceOrderNo, apart.trackingNumber, apart.status], ['3076965095733148', 'LP00000000000001', 'shipped'], 'its own parcel kept');

  // A tracking number saved on the second variation: the first ships with it, in one eBay dispatch; the split parcel doesn't.
  const dispatchMock = mock.method(ebayService, 'dispatchOrder', async (credentials, input) => ({ fulfillmentId: 'F-1', input }));
  try {
    const shipped = await orderService.saveSourcing(connectionId, userId, userId, orderId, '10022222222222', {
      sourceOrderNo: '3076965095733148',
      trackingNumber: 'YT2600000000000',
      quantity: 1,
      alsoFor: [{ lineKey: '10011111111111', quantity: 1 }, siblings[1]],
    });
    assert.strictEqual(dispatchMock.mock.callCount(), 1);
    assert.deepStrictEqual(dispatchMock.mock.calls[0].arguments[1].lineItems, [
      { lineItemId: '10022222222222', quantity: 1 },
      { lineItemId: '10011111111111', quantity: 1 },
    ]);
    assert.strictEqual(shipped.dispatch.ok, true);
    const first = shipped.siblings.find((x) => x.lineItemId === '10011111111111');
    assert.deepStrictEqual([first.trackingNumber, first.status, first.cost.value], ['YT2600000000000', 'shipped', 2.63]);
    assert.strictEqual(shipped.siblings.find((x) => x.lineItemId === '10033333333333').trackingNumber, 'LP00000000000001');
  } finally {
    dispatchMock.mock.restore();
  }
});

test('a sibling variation only shows shipped alongside a parcel it is in', () => {
  const patch = { source_email: 'a@example.com', status: 'shipped', cost_value: 3 };
  assert.deepStrictEqual(orderService.siblingPatch(patch, { existing: { tracking_number: 'X1' }, sibling: null, tracking: undefined, carrier: 'Yodel' }), { source_email: 'a@example.com' }, 'an email edited on a line shipped before: no parcel, no status');
  assert.deepStrictEqual(orderService.siblingPatch(patch, { existing: { tracking_number: 'X1' }, sibling: { tracking_number: 'X1' }, tracking: undefined, carrier: 'Yodel' }), { source_email: 'a@example.com', status: 'shipped' }, 'in the same parcel');
});
