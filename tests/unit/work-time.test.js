const test = require('node:test');
const assert = require('node:assert');
const workTime = require('../../src/modules/team/work-time');
const activity = require('../../src/modules/team/activity');

// Time in Liston: minutes add up by day in the owner's time zone, unbroken
// stretches of the same state and area make one span, areas by working time.

const at = (iso) => new Date(iso);
const run = (startIso, count, working, area) => Array.from({ length: count }, (_, i) => ({ minute: new Date(at(startIso).getTime() + i * 60000), working, area, connection_id: null }));

test("a period's minutes: working and idle by day, the day's stretches after its midnight, where the working time went", () => {
  // London is on BST (UTC+1) on 1 Oct 2026: 08:00Z is 09:00 there.
  const minutes = [...run('2026-10-01T08:00:00Z', 30, true, 'inbox'), ...run('2026-10-01T08:30:00Z', 10, false, 'inbox'), ...run('2026-10-01T08:40:00Z', 20, true, 'orders'), ...run('2026-10-02T13:00:00Z', 5, true, 'nowhere-known')];
  const out = workTime.summarize(minutes, { from: '2026-09-30', to: '2026-10-02', timeZone: 'Europe/London' });
  assert.deepStrictEqual(out.totals, { working: 55, idle: 10 });
  assert.deepStrictEqual(out.days.map((d) => [d.day, d.working, d.idle]), [
    ['2026-09-30', 0, 0],
    ['2026-10-01', 50, 10],
    ['2026-10-02', 5, 0],
  ], 'every day of the range, worked or not');
  const day = out.days[1];
  assert.deepStrictEqual(day.spans, [
    { from: 540, to: 570, working: true, area: 'inbox' },
    { from: 570, to: 580, working: false, area: 'inbox' },
    { from: 580, to: 600, working: true, area: 'orders' },
  ], '09:00–09:30 working in the Inbox, 10 idle, then 20 in Orders');
  assert.deepStrictEqual([day.first, day.last], ['2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z']);
  assert.deepStrictEqual(out.areas.map((a) => [a.area, a.working, a.idle]), [['inbox', 30, 10], ['orders', 20, 0], ['other', 5, 0]], 'an unknown area counts as elsewhere');
  assert.deepStrictEqual(workTime.totalsOf(minutes), { working: 55, idle: 10 });
});

test('a gap breaks a stretch; each kind of work belongs to its area', () => {
  const out = workTime.summarize([...run('2026-10-01T08:00:00Z', 3, true, 'inbox'), ...run('2026-10-01T08:05:00Z', 2, true, 'inbox')], { from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC' });
  assert.deepStrictEqual(out.days[0].spans.map((s) => [s.from, s.to]), [[480, 483], [485, 487]]);
  assert.deepStrictEqual(['order.dispatched', 'listing.published', 'hunt.added', 'inbox.replied', 'account.store_category_added', 'session.login'].map(workTime.areaOfKind), ['orders', 'listings', 'hunting', 'inbox', 'settings', null]);
  assert.strictEqual(workTime.areaKey('inbox'), 'inbox');
  assert.strictEqual(workTime.areaKey('constructor'), 'other', 'only real areas');
});

test("buyers answered once per conversation, every message sent, and the median reply time", () => {
  const rows = [
    { kind: 'inbox.replied', subject_id: 'c1', detail: { waitedMinutes: 30 }, created_at: '2026-10-01T09:00:00Z' },
    { kind: 'inbox.replied', subject_id: 'c1', detail: { waitedMinutes: null }, created_at: '2026-10-01T09:05:00Z' },
    { kind: 'inbox.replied', subject_id: 'c2', detail: { waitedMinutes: 90 }, created_at: '2026-10-01T10:00:00Z' },
    { kind: 'inbox.messaged', subject_id: 'c3', detail: {}, created_at: '2026-10-01T11:00:00Z' },
  ];
  const m = activity.metricsFrom(rows, 'UTC');
  assert.deepStrictEqual([m.inbox_answered, m.inbox_sent, m.active_days], [3, 4, 1]);
  assert.deepStrictEqual(activity.replyTime(rows), { median: 60, count: 2 }, 'only replies to a waiting buyer, (30 + 90) / 2');
  assert.deepStrictEqual(activity.replyTime([]), { median: null, count: 0 });
  assert.strictEqual(activity.KINDS['inbox.resolved'], 'Resolved a buyer query', 'no longer recorded; earlier entries still read');
});
