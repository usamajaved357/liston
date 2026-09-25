const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
require('dotenv').config();

const ebayFinances = require('../../src/modules/ebay/api/ebay.finances');
const moneySummary = require('../../src/modules/overview/money-summary');
const ebayService = require('../../src/modules/ebay/ebay.service');
const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');
const mirror = require('../../src/modules/ebay/ebay-mirror.repository');

test.afterEach(() => mock.restoreAll());

const gbp = (value) => ({ value: String(value), currency: 'GBP' });

// Shapes as eBay's getTransactions returns them (EBAY_GB, Sept 2026): the
// ad fee names its order only among its references.
const sale = (orderId, { basis, fees, net, date = '2026-09-20T10:00:00.000Z' }) => ({
  transactionType: 'SALE',
  transactionStatus: 'FUNDS_AVAILABLE_FOR_PAYOUT',
  bookingEntry: 'CREDIT',
  orderId,
  transactionDate: date,
  amount: gbp(net),
  totalFeeBasisAmount: gbp(basis),
  totalFeeAmount: gbp(fees),
  orderLineItems: [{ marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: gbp(fees) }] }],
});
const adFee = (orderId, value) => ({
  transactionType: 'NON_SALE_CHARGE',
  feeType: 'AD_FEE',
  bookingEntry: 'DEBIT',
  amount: gbp(value),
  references: [
    { referenceId: '198617135072', referenceType: 'ITEM_ID' },
    { referenceId: orderId, referenceType: 'ORDER_ID' },
  ],
});
const refund = (orderId, value) => ({ transactionType: 'REFUND', bookingEntry: 'DEBIT', orderId, amount: gbp(value) });

test('bulk transactions become one money row per order: ad fees by their order reference, refunds off the earnings', () => {
  const rows = ebayFinances.orderFinancesFrom([
    sale('27-1', { basis: 5.69, fees: 1.05, net: 4.64 }),
    adFee('27-1', 1.28),
    sale('19-2', { basis: 15.99, fees: 2.83, net: 13.16 }),
    refund('19-2', 13.16),
    // A withdrawal names no order; an ad fee for an order sold earlier has no sale here.
    { transactionType: 'WITHDRAWAL', amount: gbp(100) },
    adFee('old-3', 0.5),
  ]);
  assert.deepStrictEqual(
    rows.map((r) => [r.orderId, r.gross, r.fees, r.adFees, r.refunds, r.earnings]),
    [
      ['27-1', 5.69, 2.33, 1.28, 0, 3.36], // what the order page shows for it
      ['19-2', 15.99, 2.83, 0, 13.16, 0],
    ]
  );
});

const order = (orderId, total, extra = {}) => ({ orderId, total: { amount: total, currency: 'GBP' }, ...extra });

test('an account\'s money: sales from order totals, fees and earnings from eBay, profit after source cost', () => {
  const orders = [order('A', 20), order('B', 10), order('C', 8), order('X', 15, { cancelled: true })];
  const finances = new Map([
    ['A', { fees: 3, adFees: 1, refunds: 0, earnings: 17 }],
    ['B', { fees: 1.5, adFees: 0, refunds: 0, earnings: 8.5 }],
    ['X', { fees: 0.3, adFees: 0, refunds: 15, earnings: -0.3 }],
  ]);
  const costs = new Map([['A', { value: 6, currency: 'GBP' }], ['C', { value: 3, currency: 'GBP' }], ['B', { value: 2, currency: 'USD' }]]);
  const m = moneySummary.summarise(orders, finances, costs, { currency: 'GBP', isCancelled: (o) => o.cancelled });
  assert.strictEqual(m.sales, 38, 'cancelled order out of sales');
  assert.strictEqual(m.orders, 3);
  assert.strictEqual(m.cancelled, 1);
  assert.strictEqual(m.fees, 4.8);
  assert.strictEqual(m.adFees, 1);
  assert.strictEqual(m.earnings, 25.2);
  // C isn't settled yet but its cost counts; B's cost is in another currency and doesn't.
  assert.strictEqual(m.sourceCost, 9);
  assert.strictEqual(m.awaitingEbay, 1);
  // Profit covers settled orders only: (17 − 6) + 8.5 + (−0.3).
  assert.strictEqual(m.profit, 19.2);
  assert.strictEqual(m.margin, 64, 'profit over the sales it covers (A + B)');

  const total = moneySummary.addUp([m, m], 'GBP');
  assert.strictEqual(total.sales, 76);
  assert.strictEqual(total.profit, 38.4);
  assert.strictEqual(total.margin, 64);
});

test('an account with no finances permission is skipped, not read', async () => {
  const reads = mock.method(ebayFinances, 'getTransactions', async () => ({ transactions: [] }));
  mock.method(ebayOauth, 'hasScope', () => false);
  const result = await ebayService.syncOrderFinances({ accessToken: 't', accessTokenExpiresAt: Date.now() + 3600e3 }, 'fin-noscope');
  assert.strictEqual(result.skipped, 'scope');
  assert.strictEqual(reads.mock.calls.length, 0);
});

test('the first finance read covers 90 days in parallel pages; the next only what changed since, fetching late orders whole', async () => {
  mock.method(ebayOauth, 'hasScope', () => true);
  const credentials = { accessToken: 't', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB', signingKey: { jwe: 'j', privateKey: 'k' } };
  let snapshot = null;
  const stored = [];
  mock.method(mirror, 'loadSnapshot', async () => snapshot);
  mock.method(mirror, 'saveSnapshot', async (id, kind, value, meta) => {
    snapshot = { value, meta, syncedAt: 0 }; // stale at once, so the next call reads again
  });
  mock.method(mirror, 'upsertOrderFinances', async (id, rows) => stored.push(...rows));

  const windows = [];
  mock.method(ebayFinances, 'getTransactions', async (token, { from, offset }) => {
    windows.push({ from, offset });
    if (offset === 0) return { total: 3, transactions: [sale('P1', { basis: 10, fees: 1, net: 9 }), sale('P2', { basis: 8, fees: 1, net: 7 })] };
    return { total: 3, transactions: [sale('P3', { basis: 5, fees: 1, net: 4 })] };
  });
  const first = await ebayService.syncOrderFinances(credentials, 'fin-full');
  assert.strictEqual(first.orders, 3);
  assert.deepStrictEqual(windows.map((w) => w.offset), [0, 2]);
  const days = (Date.now() - new Date(windows[0].from).getTime()) / 864e5;
  assert.ok(days > 89 && days < 91, `first read reaches back 90 days (${days})`);

  // Next time: from the last read (less a few days), and an order sold
  // earlier that got a refund is read whole.
  windows.length = 0;
  mock.method(ebayFinances, 'getTransactions', async (token, { from, offset }) => {
    windows.push({ from, offset });
    return { total: 1, transactions: [refund('OLD', 3)] };
  });
  const history = mock.method(ebayFinances, 'getOrderTransactions', async () => ({ transactions: [sale('OLD', { basis: 12, fees: 2, net: 10 }), refund('OLD', 3)] }));
  const next = await ebayService.syncOrderFinances(credentials, 'fin-full');
  assert.strictEqual(windows.length, 1);
  const back = (Date.now() - new Date(windows[0].from).getTime()) / 864e5;
  assert.ok(back > 2.9 && back < 3.1, `then only since the last read, with overlap (${back})`);
  assert.strictEqual(history.mock.calls[0].arguments[1], 'OLD');
  assert.strictEqual(next.orders, 1);
  assert.deepStrictEqual(stored.at(-1), { orderId: 'OLD', currency: 'GBP', gross: 12, fees: 2, adFees: 0, refunds: 3, earnings: 7, fundsStatus: 'Available', saleDate: '2026-09-20T10:00:00.000Z' });
});
