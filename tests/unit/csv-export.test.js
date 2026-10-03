const test = require('node:test');
const assert = require('node:assert');
const { toCsv, cell } = require('../../src/utils/csv');
const { orderRows, listingRows, stamp } = require('../../src/modules/exports/export-rows');

// The CSV downloads: a file a spreadsheet opens safely, and the columns of
// an order and a listing (never a supplier login).

test('cells: quoted when they must be, formulas defused, empties empty', () => {
  assert.strictEqual(cell('plain'), 'plain');
  assert.strictEqual(cell('a, b'), '"a, b"');
  assert.strictEqual(cell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(cell('line\nbreak'), '"line\nbreak"');
  assert.strictEqual(cell('=SUM(A1)'), "'=SUM(A1)");
  assert.strictEqual(cell('@cmd'), "'@cmd");
  assert.strictEqual(cell(-4.5), '-4.5');
  assert.strictEqual(cell(null), '');
  assert.strictEqual(cell(undefined), '');
  assert.strictEqual(cell(NaN), '');
  const csv = toCsv(['A', 'B'], [[1, 'x']]);
  assert.ok(csv.startsWith('﻿A,B\r\n1,x\r\n'));
});

test('times in the account time zone', () => {
  assert.strictEqual(stamp('2026-07-01T12:30:00Z', 'Europe/London'), '2026-07-01 13:30');
  assert.strictEqual(stamp('2026-07-01T12:30:00Z', 'Australia/Sydney'), '2026-07-01 22:30');
  assert.strictEqual(stamp(null, 'Europe/London'), '');
});

const order = {
  orderId: '12-34',
  salesRecordNumber: '1001',
  derivedStatus: 'dispatched',
  createdAt: '2026-09-30T09:00:00Z',
  shippedTime: '2026-10-01T10:00:00Z',
  buyerUserId: 'buyer_1',
  buyerName: 'Jo Buyer',
  shippingAddress: { name: 'Jo Buyer', street1: '1 High St', city: 'Leeds', postalCode: 'LS1 1AA', country: 'GB' },
  total: { amount: '24.99', currency: 'GBP' },
  markedDispatched: { by: 'Sara', at: '2026-10-01T10:00:00Z' },
  lineItems: [
    { itemId: '111', title: 'Red mug', quantityPurchased: 1, price: { amount: '9.99' }, variation: [{ name: 'Colour', value: 'Red' }], trackingNumber: 'TRK1', trackingCarrier: 'Royal Mail' },
    { itemId: '222', title: 'Blue plate', quantityPurchased: 2, price: { amount: '7.50' }, variation: [], trackingNumber: null },
  ],
};

const sourcing = {
  '12-34': [
    {
      status: 'shipped',
      sourcePlatform: 'aliexpress',
      sourceAccountLabel: 'Main AliExpress',
      sourceAccountEmail: 'buyer-login@example.com',
      sourceEmail: 'raw-login@example.com',
      sourcePassword: 'SECRET-PASSWORD',
      cardLabel: 'Visa 4242',
      sourceOrderNo: 'AE-900',
      placedAt: '2026-09-30',
      placedBy: { name: 'Sara' },
      cost: { value: 6.2, currency: 'USD' },
      carrier: 'Cainiao',
      trackingNumber: 'LP123',
      notes: 'Gift wrap',
    },
  ],
};

test('an order: one row, its items side by side, eBay and supplier tracking, no supplier login', () => {
  const money = new Map([['12-34', { currency: 'GBP', gross: 24.99, fees: 3.1, adFees: 0.5, refunds: 0, earnings: 21.39, fundsStatus: 'Available', cost: { value: 6.2, currency: 'USD' }, profit: null, margin: null }]]);
  const { header, rows } = orderRows([order], { sourcingByOrder: sourcing, moneyByOrder: money, supplierUrls: new Map([['111', 'https://aliexpress.com/item/1.html']]), timeZone: 'Europe/London', itemHost: 'www.ebay.co.uk' });
  assert.strictEqual(rows.length, 1);
  const row = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
  assert.strictEqual(row['Order ID'], '12-34');
  assert.strictEqual(row.Status, 'Dispatched');
  assert.strictEqual(row['Ordered (Europe/London)'], '2026-09-30 10:00');
  assert.strictEqual(row.Titles, 'Red mug | Blue plate');
  assert.strictEqual(row.Variations, 'Colour: Red | —');
  assert.strictEqual(row.Quantities, '1 | 2');
  assert.strictEqual(row.Units, 3);
  assert.strictEqual(row['eBay tracking'], 'TRK1 | —');
  assert.strictEqual(row['Item links'], 'https://www.ebay.co.uk/itm/111 | https://www.ebay.co.uk/itm/222');
  assert.strictEqual(row['Marked dispatched by'], 'Sara, 2026-10-01 11:00');
  assert.strictEqual(row['Order total'], 24.99);
  assert.strictEqual(row.Earnings, 21.39);
  assert.strictEqual(row['Supplier status'], 'Shipped');
  assert.strictEqual(row['Supplier account'], 'Main AliExpress');
  assert.strictEqual(row['Supplier order no.'], 'AE-900');
  assert.strictEqual(row['Supplier tracking'], 'LP123');
  assert.strictEqual(row['Supplier links'], 'https://aliexpress.com/item/1.html | —');

  const csv = toCsv(header, rows);
  for (const secret of ['SECRET-PASSWORD', 'buyer-login@example.com', 'raw-login@example.com', 'Visa 4242']) assert.ok(!csv.includes(secret), `${secret} must not be in the file`);
  assert.ok(!header.some((h) => /password|login|card/i.test(h)));
});

test('a listing: its figures, links and dates', () => {
  const { header, rows } = listingRows(
    [{ itemId: '111', sku: 'MUG-R', title: 'Red mug', price: { amount: '9.99', currency: 'GBP' }, quantity: 10, quantityAvailable: 7, quantitySold: 3, watchCount: 4, startTime: '2026-09-01T08:00:00Z', viewItemUrl: 'https://www.ebay.co.uk/itm/111' }],
    { status: 'active', supplierUrls: new Map([['111', 'https://aliexpress.com/item/1.html']]), timeZone: 'Europe/London' }
  );
  const row = Object.fromEntries(header.map((h, i) => [h, rows[0][i]]));
  assert.deepStrictEqual([row['Item ID'], row.SKU, row.Status, row.Price, row.Available, row.Sold, row.Watchers], ['111', 'MUG-R', 'Active', 9.99, 7, 3, 4]);
  assert.strictEqual(row['Supplier link'], 'https://aliexpress.com/item/1.html');
  assert.strictEqual(row['Listed (Europe/London)'], '2026-09-01 09:00');
});
