const test = require('node:test');
const assert = require('node:assert');

const { mapOrderEarnings } = require('../../src/modules/ebay/api/ebay.finances');

// Real getTransactions answers (EBAY_GB, Sept 2026). A SALE's `amount` is
// already net of its fees; `totalFeeBasisAmount` is the order total.
// Seller Hub for the first: order total £10.75, transaction fees −£1.93,
// order earnings £8.82 (Liston once showed £8.82 as the total and £6.89).
const SELVORA = {
  transactions: [
    {
      transactionType: 'SALE',
      transactionStatus: 'FUNDS_ON_HOLD',
      bookingEntry: 'CREDIT',
      amount: { value: '8.82', currency: 'GBP' },
      totalFeeBasisAmount: { value: '10.75', currency: 'GBP' },
      totalFeeAmount: { value: '1.93', currency: 'GBP' },
      orderLineItems: [
        {
          marketplaceFees: [
            { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.48', currency: 'GBP' } },
            { feeType: 'REGULATORY_OPERATING_FEE', amount: { value: '0.05', currency: 'GBP' } },
            { feeType: 'FINAL_VALUE_FEE', amount: { value: '1.4', currency: 'GBP' } },
          ],
        },
      ],
    },
  ],
};

// A promoted listing's sale: the ad fee is a separate charge on the order.
const WALEXO_PROMOTED = {
  transactions: [
    { transactionType: 'NON_SALE_CHARGE', transactionStatus: 'FUNDS_AVAILABLE_FOR_PAYOUT', bookingEntry: 'DEBIT', feeType: 'AD_FEE', amount: { value: '1.57', currency: 'GBP' } },
    {
      transactionType: 'SALE',
      transactionStatus: 'FUNDS_PROCESSING',
      bookingEntry: 'CREDIT',
      amount: { value: '5.53', currency: 'GBP' },
      totalFeeBasisAmount: { value: '6.99', currency: 'GBP' },
      totalFeeAmount: { value: '1.46', currency: 'GBP' },
      orderLineItems: [
        {
          marketplaceFees: [
            { feeType: 'REGULATORY_OPERATING_FEE', amount: { value: '0.02', currency: 'GBP' } },
            { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.36', currency: 'GBP' } },
            { feeType: 'FINAL_VALUE_FEE', amount: { value: '1.08', currency: 'GBP' } },
          ],
        },
      ],
    },
  ],
};

test('mapOrderEarnings matches Seller Hub: the order total, its fees, and earnings net of them once', () => {
  const out = mapOrderEarnings(SELVORA);
  assert.strictEqual(out.fundsStatus, 'On hold');
  assert.deepStrictEqual(out.fees, [
    { code: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', label: 'Transaction fees', amount: { value: 1.88, currency: 'GBP' } },
    { code: 'REGULATORY_OPERATING_FEE', label: 'Regulatory operating fee', amount: { value: 0.05, currency: 'GBP' } },
  ]);
  assert.deepStrictEqual(out.gross, { value: 10.75, currency: 'GBP' });
  assert.deepStrictEqual(out.totalFees, { value: 1.93, currency: 'GBP' });
  assert.deepStrictEqual(out.earnings, { value: 8.82, currency: 'GBP' }, "eBay's own net amount");
});

test('mapOrderEarnings takes the ad fee eBay charges separately off the earnings, fees in Seller Hub order', () => {
  const out = mapOrderEarnings(WALEXO_PROMOTED);
  assert.deepStrictEqual(out.gross, { value: 6.99, currency: 'GBP' });
  assert.deepStrictEqual(
    out.fees.map((f) => [f.label, f.amount.value]),
    [
      ['Transaction fees', 1.44],
      ['Regulatory operating fee', 0.02],
      ['Ad fee general', 1.57],
    ]
  );
  assert.deepStrictEqual(out.earnings, { value: 3.96, currency: 'GBP' });
});

test('mapOrderEarnings works out the order total from net + fees when eBay leaves the basis out, and counts a fee credit back', () => {
  const sale = { ...SELVORA.transactions[0], totalFeeBasisAmount: undefined };
  const out = mapOrderEarnings({
    transactions: [sale, { transactionType: 'NON_SALE_CHARGE', bookingEntry: 'CREDIT', feeType: 'FINAL_VALUE_FEE', amount: { value: '0.48', currency: 'GBP' } }],
  });
  assert.deepStrictEqual(out.gross, { value: 10.75, currency: 'GBP' });
  assert.deepStrictEqual(out.earnings, { value: 9.3, currency: 'GBP' });
});

test('mapOrderEarnings is null until eBay has recorded the sale', () => {
  assert.strictEqual(mapOrderEarnings({ transactions: [] }), null);
  assert.strictEqual(mapOrderEarnings(null), null);
});

test('mapOrderEarnings humanises a fee type it has no name for', () => {
  const out = mapOrderEarnings({
    transactions: [{ transactionType: 'SALE', transactionStatus: 'PAYOUT', amount: { value: '10', currency: 'GBP' }, orderLineItems: [{ marketplaceFees: [{ feeType: 'SOME_NEW_FEE', amount: { value: '1', currency: 'GBP' } }] }] }],
  });
  assert.strictEqual(out.fundsStatus, 'Paid out');
  assert.strictEqual(out.fees[0].label, 'Some new fee');
});
