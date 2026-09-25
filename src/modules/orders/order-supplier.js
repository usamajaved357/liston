// Where an order's supplier order stands, as one state for the Orders
// page's Supplier filter. Liston keeps a sourcing row per order line
// (order_sourcing); the order is only as far along as its least advanced
// line, and a line with no row hasn't been ordered yet.
//
//   pending   some line is still to be ordered from the supplier
//   problem   a line is flagged with a problem (shown before pending)
//   ordered / shipped / delivered   every line is at least that far
//   untracked already dispatched or cancelled on eBay with no supplier
//             order recorded in Liston (handled elsewhere): not "to order",
//             so it never crowds the pending list; counted under Any only

const STATES = ['pending', 'ordered', 'shipped', 'delivered', 'problem'];
const FILTERS = ['any', ...STATES];
const STAGE = ['ordered', 'shipped', 'delivered'];

/**
 * One order's state from its lines' statuses (`statuses` may be shorter
 * than `lineCount`). `settled`: the order is already dispatched or
 * cancelled on eBay.
 */
function supplierState(statuses = [], lineCount = 1, { settled = false } = {}) {
  if (!statuses.length && settled) return 'untracked';
  if (statuses.includes('problem')) return 'problem';
  if (statuses.length < Math.max(1, lineCount) || statuses.some((s) => !STAGE.includes(s))) return 'pending';
  return statuses.reduce((lowest, s) => (STAGE.indexOf(s) < STAGE.indexOf(lowest) ? s : lowest), 'delivered');
}

module.exports = { STATES, FILTERS, supplierState };
