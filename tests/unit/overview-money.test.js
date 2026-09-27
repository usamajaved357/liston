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
  // ROI only over orders with eBay's figures and a cost in the currency: A, (17 − 6) ÷ 6.
  assert.strictEqual(m.roi, 183.3);

  const total = moneySummary.addUp([m, m], 'GBP');
  assert.strictEqual(total.sales, 76);
  assert.strictEqual(total.profit, 38.4);
  assert.strictEqual(total.margin, 64);
  assert.strictEqual(total.roi, 183.3);
  assert.strictEqual(moneySummary.summarise([order('A', 20)], finances, new Map(), { currency: 'GBP' }).roi, null, 'no costs, no ROI');
});

// Charges eBay bills the account apart from its orders, as getTransactions
// books them (NON_SALE_CHARGE, no order among the references).
const charge = (feeType, value, extra = {}) => ({
  transactionId: `T-${feeType}-${value}`,
  transactionType: 'NON_SALE_CHARGE',
  feeType,
  bookingEntry: 'DEBIT',
  transactionDate: '2026-09-21T08:00:00.000Z',
  amount: gbp(value),
  ...extra,
});

test("the account's own charges are kept by kind: listing fees, the eBay Store subscription, ads billed per click and the rest; credits back count against them", () => {
  const rows = ebayFinances.accountChargesFrom([
    charge('INSERTION_FEE', 0.35, { references: [{ referenceId: '198617135072', referenceType: 'ITEM_ID' }] }),
    charge('SUBTITLE_FEE', 0.4),
    charge('EBAY_STORE_SUBSCRIPTION_FEE', 27.99, { transactionMemo: 'Basic Store' }),
    // eBay UK's shop subscription, as it came live: OTHER_FEES, its memo the period paid for.
    charge('OTHER_FEES', 32.4, { transactionMemo: '2026-08-31 - 2026-09-29' }),
    charge('AD_FEE', 3.1),
    charge('BELOW_STANDARD_FEE', 1.2),
    charge('INSERTION_FEE', 0.35, { transactionId: 'T-back', bookingEntry: 'CREDIT' }),
    { transactionId: 'T-credit', transactionType: 'CREDIT', feeType: 'PROMOTIONAL_CREDIT', bookingEntry: 'CREDIT', transactionDate: '2026-09-22T08:00:00.000Z', amount: gbp(5) },
    // Not the account's: an ad fee on an order belongs to that order; tax isn't a fee; a sale isn't a charge.
    adFee('27-1', 1.28),
    charge('VAT_WITHHOLDING', 2),
    sale('27-2', { basis: 5, fees: 1, net: 4 }),
  ]);
  assert.deepStrictEqual(
    rows.map((r) => [r.kind, r.feeType, r.amount]),
    [
      ['listing', 'INSERTION_FEE', 0.35],
      ['listing', 'SUBTITLE_FEE', 0.4],
      ['store', 'EBAY_STORE_SUBSCRIPTION_FEE', 27.99],
      ['store', 'OTHER_FEES', 32.4],
      ['ads', 'AD_FEE', 3.1],
      ['other', 'BELOW_STANDARD_FEE', 1.2],
      ['listing', 'INSERTION_FEE', -0.35],
      ['other', 'PROMOTIONAL_CREDIT', -5],
    ]
  );
  assert.deepStrictEqual(rows[0], {
    transactionId: 'T-INSERTION_FEE-0.35',
    kind: 'listing',
    feeType: 'INSERTION_FEE',
    amount: 0.35,
    currency: 'GBP',
    itemId: '198617135072',
    memo: null,
    chargedAt: '2026-09-21T08:00:00.000Z',
  });
  assert.strictEqual(rows[2].memo, 'Basic Store');
  assert.strictEqual(ebayFinances.chargeKind('MARKETPLACE_RESEARCH_PRO_SUBSCRIPTION_FEE'), 'other', 'Terapeak Pro is a subscription, not the shop');
  assert.strictEqual(ebayFinances.chargeKind('AD_FEE_PROMOTED_LISTINGS_ADVANCED'), 'ads');
  assert.strictEqual(ebayFinances.chargeKind('CHARITY_DONATION'), null);
  assert.strictEqual(ebayFinances.chargeKind('OTHER_FEES', { memo: 'Seller fee adjustment' }), 'other');
  assert.strictEqual(ebayFinances.chargeKind('OTHER_FEES', { memo: '2026-08-31 - 2026-09-29', itemId: '1986' }), 'other', 'a charge on a listing is not the shop subscription');
});

test("the account's charges are fees: they add to the fees, come off the earnings and profit, and ROI's orders carry their share by sales", () => {
  const orders = [order('A', 30), order('B', 10)];
  const finances = new Map([
    ['A', { fees: 4, adFees: 1, refunds: 0, earnings: 26 }],
    ['B', { fees: 2, adFees: 0, refunds: 0, earnings: 8 }],
  ]);
  const costs = new Map([['A', { value: 10, currency: 'GBP' }]]);
  const charges = [
    { kind: 'store', amount: 27.99 },
    { kind: 'listing', amount: 0.75 },
    { kind: 'listing', amount: -0.35 },
    { kind: 'ads', amount: 3.1 },
    { kind: 'other', amount: 0.51 },
  ];
  const m = moneySummary.summarise(orders, finances, costs, { currency: 'GBP', charges });
  assert.strictEqual(m.fees, 38, '6 on the orders + 32 charged to the account');
  assert.strictEqual(m.adFees, 4.1, "the order's ad fee and the ones billed per click");
  assert.deepStrictEqual([m.accountFees, m.listingFees, m.storeFees, m.otherFees], [28.9, 0.4, 27.99, 0.51]);
  assert.strictEqual(m.earnings, 2, '34 on the orders less the 32 charged');
  assert.strictEqual(m.profit, -8, 'earnings less the 10 paid to the supplier');
  // A sold 30 of the 40: it carries 24 of the 32. (26 − 10 − 24) ÷ 10.
  assert.strictEqual(m.roi, -80);
  assert.strictEqual(m.sales, 40, 'sales are what buyers paid, charges or not');

  const both = moneySummary.addUp([m, m], 'GBP');
  assert.deepStrictEqual([both.fees, both.accountFees, both.storeFees, both.roi], [76, 57.8, 55.98, -80]);
  const inUsd = moneySummary.convert(m, 2, 'USD');
  assert.deepStrictEqual([inUsd.storeFees, inUsd.accountFees, inUsd.currency], [14, 14.45, 'USD']);

  // A day with no orders still shows what eBay charged that day.
  const quiet = moneySummary.summarise([], new Map(), new Map(), { currency: 'GBP', charges: [{ kind: 'store', amount: 27.99 }] });
  assert.deepStrictEqual([quiet.fees, quiet.earnings, quiet.profit, quiet.roi], [27.99, -27.99, -27.99, null]);
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
  mock.method(mirror, 'upsertAccountCharges', async () => {});
  mock.method(mirror, 'pruneAccountChargesBefore', async () => {});

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

test("the finance read keeps the account's charges, and an account read before charges were kept is read in full once more", async () => {
  mock.method(ebayOauth, 'hasScope', () => true);
  const credentials = { accessToken: 't', accessTokenExpiresAt: Date.now() + 3600e3, marketplaceId: 'EBAY_GB', signingKey: { jwe: 'j', privateKey: 'k' } };
  // Read ten minutes ago, when charges were sorted the older way: not fresh enough to skip.
  let snapshot = { value: { count: 3 }, meta: { lastSyncAt: new Date(Date.now() - 10 * 60e3).toISOString(), charges: 2 }, syncedAt: new Date(Date.now() - 10 * 60e3) };
  mock.method(mirror, 'loadSnapshot', async () => snapshot);
  mock.method(mirror, 'saveSnapshot', async (id, kind, value, meta) => {
    snapshot = { value, meta, syncedAt: new Date() };
  });
  mock.method(mirror, 'upsertOrderFinances', async () => {});
  const kept = [];
  mock.method(mirror, 'upsertAccountCharges', async (id, rows) => kept.push(...rows));
  const pruned = mock.method(mirror, 'pruneAccountChargesBefore', async () => {});
  const windows = [];
  mock.method(ebayFinances, 'getTransactions', async (token, { from }) => {
    windows.push(from);
    return { total: 3, transactions: [sale('P1', { basis: 10, fees: 1, net: 9 }), charge('EBAY_STORE_SUBSCRIPTION_FEE', 27.99), charge('INSERTION_FEE', 0.35)] };
  });
  const history = mock.method(ebayFinances, 'getOrderTransactions', async () => ({ transactions: [] }));

  const result = await ebayService.syncOrderFinances(credentials, 'fin-charges');
  const days = (Date.now() - new Date(windows[0]).getTime()) / 864e5;
  assert.ok(days > 89 && days < 91, `read in full again (${days})`);
  assert.strictEqual(history.mock.calls.length, 0, 'a full read fetches no late orders');
  assert.deepStrictEqual([result.orders, result.charges], [1, 2]);
  assert.deepStrictEqual(kept.map((c) => [c.kind, c.amount]), [['store', 27.99], ['listing', 0.35]]);
  assert.strictEqual(snapshot.meta.charges, 3);
  const keptDays = (Date.now() - pruned.mock.calls[0].arguments[1].getTime()) / 864e5;
  assert.ok(keptDays > 99 && keptDays < 101, 'charges older than 100 days are let go');

  // Now fresh, with charges kept: skipped.
  const again = await ebayService.syncOrderFinances(credentials, 'fin-charges');
  assert.strictEqual(again.skipped, 'fresh');
});
