const test = require('node:test');
const assert = require('node:assert');
const rules = require('../../src/modules/inbox/order-issues');

// Which open case (or cancellation request) marks a buyer's conversation.

const orders = [
  { orderId: '17-1', itemIds: ['111'], cancelRequested: false },
  { orderId: '17-2', itemIds: ['222'], cancelRequested: true },
];

test("a conversation is marked with an open case on the buyer's order for its item, or naming the buyer and item", () => {
  const conv = { otherParty: 'Haks_MM2', referenceId: '111' };
  assert.strictEqual(rules.issueFor(conv, { orders, cases: [] }), null, 'nothing open');
  assert.deepStrictEqual(rules.issueFor(conv, { orders, cases: [{ id: 'r1', kind: 'return', orderId: '17-1', respondBy: '2026-10-03T00:00:00Z' }] }), { kind: 'return', label: 'Return open', respondBy: '2026-10-03T00:00:00Z', orderId: '17-1' });
  assert.deepStrictEqual(rules.issueFor(conv, { orders, cases: [{ id: 'i1', kind: 'inquiry', buyer: 'haks_mm2', itemId: '111' }] }), { kind: 'inquiry', label: 'Item not received', respondBy: null, orderId: '17-1' }, 'by buyer and item, the order found');
  assert.strictEqual(rules.issueFor(conv, { orders, cases: [{ id: 'r2', kind: 'return', buyer: 'someone_else', itemId: '111' }] }), null, "another buyer's return on the same item");
  assert.strictEqual(rules.issueFor(conv, { orders, cases: [{ id: 'r3', kind: 'return', orderId: '17-2' }] }), null, "the buyer's other order (another item)");
});

test('several open: a payment dispute first, then item not received, a return, a cancellation request', () => {
  const conv = { otherParty: 'haks_mm2', referenceId: '222' };
  assert.strictEqual(rules.issueFor(conv, { orders, cases: [] }).kind, 'cancel', 'the cancellation they asked for');
  assert.strictEqual(rules.issueFor(conv, { orders, cases: [{ id: 'r', kind: 'return', orderId: '17-2' }, { id: 'd', kind: 'dispute', orderId: '17-2' }] }).label, 'Payment dispute');
});

test("an order's cases read afresh replace what the snapshot had for it", () => {
  const before = [
    { id: 'r1', kind: 'return', orderId: '17-1', buyer: 'haks_mm2', itemId: '111' },
    { id: 'x9', kind: 'return', orderId: '17-9', buyer: 'other', itemId: '999' },
  ];
  const closed = rules.withOrderCases(before, { orderIds: ['17-1'], buyer: 'haks_mm2', itemIds: ['111'], cases: [{ id: 'r1', kind: 'return', closed: true }] });
  assert.deepStrictEqual(closed.map((c) => c.id), ['x9'], 'the return closed on the order page: its mark goes');
  const opened = rules.withOrderCases(before, { orderIds: ['17-1'], buyer: 'haks_mm2', itemIds: ['111'], cases: [{ id: 'i7', kind: 'inquiry', itemId: '111', respondBy: '2026-10-05', closed: false }] });
  assert.deepStrictEqual(opened.map((c) => [c.id, c.kind, c.orderId, c.buyer]), [['x9', 'return', '17-9', 'other'], ['i7', 'inquiry', '17-1', 'haks_mm2']]);
});

test("a case on an order the seller has refunded is handled: its mark goes, even before eBay closes it", () => {
  const conv = { otherParty: 'haks_mm2', referenceId: '111' };
  const refunded = [{ orderId: '17-1', itemIds: ['111'], cancelRequested: false, refunded: true }];
  assert.strictEqual(rules.issueFor(conv, { orders: refunded, cases: [{ id: 'r1', kind: 'return', orderId: '17-1' }] }), null, 'the return on the refunded order');
  assert.strictEqual(rules.issueFor(conv, { orders: refunded, cases: [{ id: 'i1', kind: 'inquiry', buyer: 'haks_mm2', itemId: '111' }] }), null, 'an inquiry found by buyer and item');
  const twice = [...refunded, { orderId: '17-3', itemIds: ['111'], cancelRequested: false, refunded: false }];
  assert.strictEqual(rules.issueFor(conv, { orders: twice, cases: [{ id: 'i2', kind: 'inquiry', buyer: 'haks_mm2', itemId: '111' }] }).kind, 'inquiry', 'bought twice, one order not refunded: still open');
  const fresh = rules.withOrderCases([], { orderIds: ['17-1'], buyer: 'haks_mm2', itemIds: ['111'], cases: [{ id: 'r1', kind: 'return', closed: false, refunded: true }] });
  assert.deepStrictEqual(fresh, [], 'a return eBay shows refunded, read on the order page');
});

test("the account's open cases are read as eBay states them: inquiries by their status, refunded returns left out", async (t) => {
  const { mock } = require('node:test');
  const ebayService = require('../../src/modules/ebay/ebay.service');
  const ebayOauth = require('../../src/modules/ebay/api/ebay.oauth');
  const ebayPostOrder = require('../../src/modules/ebay/api/ebay.postorder');
  const ebayFulfillment = require('../../src/modules/ebay/api/ebay.fulfillment');
  t.after(() => mock.restoreAll());
  mock.method(ebayOauth, 'hasScope', () => true);
  let asked = null;
  mock.method(ebayPostOrder, 'searchReturns', async (token, filters) => {
    asked = filters;
    return {
      members: [
        { returnId: 1, orderId: '17-1', buyerLoginName: 'a', state: 'RETURN_REQUESTED', status: 'RETURN_REQUESTED' },
        { returnId: 2, orderId: '17-2', buyerLoginName: 'b', state: 'ITEM_KEPT', status: 'LESS_THAN_A_FULL_REFUND_ISSUED' },
        { returnId: 3, orderId: '17-3', buyerLoginName: 'c', state: 'RETURN_REQUESTED', status: 'RETURN_REQUESTED', sellerTotalRefund: { actualRefundAmount: { value: '4.50', currency: 'GBP' } } },
      ],
    };
  });
  mock.method(ebayPostOrder, 'searchInquiries', async () => ({
    members: [
      { inquiryId: 10, buyer: 'd', itemId: 111, inquiryStatusEnum: 'WAITING_SELLER_RESPONSE', respondByDate: { value: '2026-10-04T00:00:00Z' } },
      { inquiryId: 11, buyer: 'e', itemId: 222, inquiryStatusEnum: 'CLOSED' },
      { inquiryId: 12, buyer: 'f', itemId: 333, inquiryStatusEnum: 'CS_CLOSED' },
    ],
  }));
  mock.method(ebayFulfillment, 'getPaymentDisputeSummaries', async () => ({ paymentDisputeSummaries: [{ paymentDisputeId: 'p1', orderId: '17-9', buyerUsername: 'g', paymentDisputeStatus: 'CLOSED' }] }));
  const out = await ebayService.getOpenCases({ accessToken: 't', accessTokenExpiresAt: Date.now() + 3600000, refreshToken: 'r', marketplaceId: 'EBAY_GB' });
  assert.strictEqual(asked.states, 'ALL_OPEN', 'eBay asked for its open returns only');
  assert.deepStrictEqual(out.cases.map((c) => `${c.kind}:${c.id}`), ['return:1', 'inquiry:10'], 'refunded returns and closed inquiries and disputes left out');
  assert.strictEqual(out.cases[1].respondBy, '2026-10-04T00:00:00Z');
});
