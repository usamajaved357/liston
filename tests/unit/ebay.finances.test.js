const test = require('node:test');
const assert = require('node:assert');

const { mapOrderEarnings } = require('../../src/modules/ebay/api/ebay.finances');

// Shaped like a real getTransactions answer for a £4.74 sale on EBAY_GB
// that Seller Hub showed as "Transaction fees −£1.00, Ad fee general −£1.07,
// Order earnings £2.67, Funds status Pending".
const RESPONSE = {
  transactions: [
    {
      transactionType: 'SALE',
      transactionStatus: 'FUNDS_PROCESSING',
      amount: { value: '4.74', currency: 'GBP' },
      totalFeeAmount: { value: '2.07', currency: 'GBP' },
      orderLineItems: [
        {
          marketplaceFees: [
            { feeType: 'FINAL_VALUE_FEE', amount: { value: '0.70', currency: 'GBP' } },
            { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.30', currency: 'GBP' } },
            { feeType: 'AD_FEE', amount: { value: '1.07', currency: 'GBP' } },
          ],
        },
      ],
    },
    { transactionType: 'NON_SALE_CHARGE', amount: { value: '0.10', currency: 'GBP' } },
  ],
};

test("mapOrderEarnings groups eBay's fee types under Seller Hub's names and nets the earnings", () => {
  const out = mapOrderEarnings(RESPONSE);
  assert.strictEqual(out.fundsStatus, 'Pending');
  assert.strictEqual(out.fundsStatusCode, 'FUNDS_PROCESSING');
  assert.deepStrictEqual(out.fees, [
    { code: 'FINAL_VALUE_FEE', label: 'Transaction fees', amount: { value: 1, currency: 'GBP' } },
    { code: 'AD_FEE', label: 'Ad fee general', amount: { value: 1.07, currency: 'GBP' } },
  ]);
  assert.deepStrictEqual(out.totalFees, { value: 2.07, currency: 'GBP' });
  assert.deepStrictEqual(out.gross, { value: 4.74, currency: 'GBP' });
  assert.deepStrictEqual(out.earnings, { value: 2.67, currency: 'GBP' });
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
