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
