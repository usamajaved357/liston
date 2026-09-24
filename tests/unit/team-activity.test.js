const test = require('node:test');
const assert = require('node:assert');

const activity = require('../../src/modules/team/activity');

test('order-timeline events become activity kinds; eBay\'s own events are no one\'s work', () => {
  assert.strictEqual(activity.kindForOrderEvent('sourcing.ordered'), 'order.supplier_ordered');
  assert.strictEqual(activity.kindForOrderEvent('ebay.cancel_approved_by_liston'), 'order.cancelled');
  assert.strictEqual(activity.kindForOrderEvent('ebay.return_refund_by_liston'), 'order.return_handled');
  assert.strictEqual(activity.kindForOrderEvent('ebay.dispatched'), null);
  assert.strictEqual(activity.kindForOrderEvent('ebay.paid'), null);
});

test('figures count an order line or listing once per range, however often it was touched', () => {
  const rows = [
    { kind: 'order.supplier_ordered', subject_id: '11-1', subject_part: 'L1' },
    { kind: 'order.supplier_ordered', subject_id: '11-1', subject_part: 'L1' }, // number re-saved
    { kind: 'order.supplier_ordered', subject_id: '11-1', subject_part: 'L2' }, // second item, second supplier order
    { kind: 'order.refunded', subject_id: '22-2' },
    { kind: 'order.return_handled', subject_id: '22-2' },
    { kind: 'listing.edited', subject_id: '4071' },
    { kind: 'listing.edited', subject_id: '4071' }, // each edit is work
    { kind: 'order.note', subject_id: '11-1' },
  ];
  const m = activity.metricsFrom(rows);
  assert.deepStrictEqual([m.supplier_orders, m.cases, m.edited, m.dispatched], [2, 2, 2, 0]);
});

test('ranges are the owner\'s days, run up to now, and compare with the period before', () => {
  const now = new Date('2026-09-24T10:30:00Z'); // 11:30 in London (BST)
  const tz = 'Europe/London';
  const today = activity.rangeWindow('today', { timeZone: tz, now });
  assert.deepStrictEqual([today.from, today.to, today.startsAt.toISOString(), today.endsAt.toISOString()], ['2026-09-24', '2026-09-24', '2026-09-23T23:00:00.000Z', now.toISOString()]);
  assert.deepStrictEqual([today.previous.from, today.previous.endsAt.toISOString()], ['2026-09-23', '2026-09-23T10:30:00.000Z'], 'today so far against yesterday up to the same time');

  const week = activity.rangeWindow('7d', { timeZone: tz, now });
  assert.deepStrictEqual([week.from, week.days, week.previous.from, week.previous.to], ['2026-09-18', 7, '2026-09-11', '2026-09-17']);

  const month = activity.rangeWindow('this_month', { timeZone: tz, now });
  assert.deepStrictEqual([month.from, month.previous.from, month.previous.to], ['2026-09-01', '2026-08-01', '2026-08-24'], 'the same days of last month');

  const last = activity.rangeWindow('last_month', { timeZone: tz, now });
  assert.deepStrictEqual([last.from, last.to, last.endsAt.toISOString(), last.previous.from, last.previous.to], ['2026-08-01', '2026-08-31', '2026-08-31T23:00:00.000Z', '2026-07-01', '2026-07-31']);

  const custom = activity.rangeWindow('custom', { from: '2026-09-01', to: '2026-09-10', timeZone: tz, now });
  assert.deepStrictEqual([custom.days, custom.previous.from, custom.previous.to], [10, '2026-08-22', '2026-08-31']);
});

test('a custom range must be real dates, in order, within a year and not in the future', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  const opts = (from, to) => ({ from, to, timeZone: 'Europe/London', now });
  assert.throws(() => activity.rangeWindow('custom', opts('2026-09-10', '2026-09-01')), /after the end/);
  assert.throws(() => activity.rangeWindow('custom', opts('2025-01-01', '2026-09-01')), /at most a year/);
  assert.throws(() => activity.rangeWindow('custom', opts('2026-10-01', '2026-10-05')), /future/);
  assert.throws(() => activity.rangeWindow('custom', opts('nope', '2026-10-05')), /start and an end/);
  assert.strictEqual(activity.rangeWindow('custom', opts('2026-09-20', '2026-12-01')).to, '2026-09-24', 'cut at today');
});

const { mock } = require('node:test');
const listingService = require('../../src/modules/listings/listing.service');
const activityRepository = require('../../src/modules/team/activity.repository');
const listingController = require('../../src/modules/listings/listing.controller');

test('publishing is recorded as the person\'s work: a new listing, an edit or a relist', async () => {
  const recorded = mock.method(activityRepository, 'record', async () => null);
  const res = { status: () => res, json: () => res, send: () => res };
  const publishAs = async (row) => {
    mock.method(listingService, 'publish', async () => row);
    await listingController.publish({ params: { listingId: 'x' }, ownerId: 'owner', userId: 'member-1' }, res, (err) => {
      throw err;
    });
  };
  const draft = { title: 'Lamp', price: { value: '9.99', currency: 'GBP' } };
  await publishAs({ connection_id: 'c1', external_product_id: '407001', generated_data: draft });
  await publishAs({ connection_id: 'c1', edit_of_item_id: '407002', external_product_id: '407002', changedFields: ['price'], generated_data: draft });
  await publishAs({ connection_id: 'c1', edit_of_item_id: '407003', external_product_id: '407999', relisted: true, relistedFrom: '407003', generated_data: draft });
  const calls = recorded.mock.calls.map((c) => c.arguments[0]);
  assert.deepStrictEqual(
    calls.map((c) => [c.kind, c.subjectId, c.actorUserId]),
    [
      ['listing.published', '407001', 'member-1'],
      ['listing.edited', '407002', 'member-1'],
      ['listing.relisted', '407999', 'member-1'],
    ]
  );
  assert.deepStrictEqual([calls[0].title, calls[0].amount, calls[1].detail.fields], ['Lamp', 9.99, ['price']]);
  mock.restoreAll();
});

test('days worked are the owner\'s days with any work; a login alone is not a day worked', () => {
  const rows = [
    { kind: 'session.login', subject_id: 'u', created_at: '2026-09-20T08:00:00Z' },
    { kind: 'listing.draft_edited', subject_id: 'd1', created_at: '2026-09-21T08:00:00Z' },
    { kind: 'listing.draft_edited', subject_id: 'd1', created_at: '2026-09-21T15:00:00Z' },
    { kind: 'listing.published', subject_id: '4071', created_at: '2026-09-21T23:30:00Z' }, // 00:30 on the 22nd in London
  ];
  const m = activity.metricsFrom(rows, 'Europe/London');
  assert.deepStrictEqual([m.active_days, m.draft_work, m.published], [2, 1, 1]);
});
