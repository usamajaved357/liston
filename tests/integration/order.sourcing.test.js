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
