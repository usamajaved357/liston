const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const connectionService = require('../../src/modules/connections/connection.service');
const ebaySource = require('../../src/modules/sourcing/ebay-listing.source');
const aliexpressSource = require('../../src/modules/sourcing/aliexpress');
const huntingRepository = require('../../src/modules/hunting/hunting.repository');
const listingRepository = require('../../src/modules/listings/listing.repository');
const listingService = require('../../src/modules/listings/listing.service');

// Product hunting end to end against the local database: hunters add,
// reviewers decide, listers draft, and the figures follow. eBay and
// AliExpress are replaced at the sourcing readers.

const app = createApp();
let server;
let baseUrl;
const real = { fetchListing: ebaySource.fetchListing, fetchProduct: aliexpressSource.fetchProduct, fetchShipping: aliexpressSource.fetchShipping };

const COMPETITOR = {
  title: 'Wireless Earbuds Bluetooth 5.3 Headphones',
  legacyItemId: '123456789012',
  url: 'https://www.ebay.co.uk/itm/123456789012',
  priceText: 'GBP 12.99',
  postage: { cost: 0, service: 'Economy', minDate: null, maxDate: null },
  sold: 130,
  createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
  location: { country: 'GB' },
  specifics: { Brand: 'Unbranded' },
  referenceImages: [],
  variants: [
    { attributes: { Colour: 'Black' }, priceText: 'GBP 12.99', sold: 100, postageCost: 0 },
    { attributes: { Colour: 'White' }, priceText: 'GBP 13.99', sold: 30, postageCost: 0 },
  ],
};
const SOURCE = {
  title: 'TWS Earbuds',
  priceText: 'GBP 3.00',
  imageUrls: ['https://ae01.alicdn.com/a.jpg'],
  specifics: {},
  supplier: { orders: '1000+', rating: 4.8, reviews: 300, onSale: true, store: null, deliveryDays: 7 },
  variants: [
    { attributes: { Color: 'Black' }, priceText: 'GBP 3.00', stock: 40, skuId: '1' },
    { attributes: { Color: 'White' }, priceText: 'GBP 3.20', stock: 40, skuId: '2' },
  ],
};
const COMPETITOR_URL = 'https://www.ebay.co.uk/itm/123456789012';
const SOURCE_URL = 'https://www.aliexpress.com/item/1005001234567890.html';

test.before(async () => {
  ebaySource.fetchListing = async (url) => ({ ...COMPETITOR, sourceUrl: url });
  aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
  aliexpressSource.fetchShipping = async () => ({ cost: 0.99, freeOver: null, minDays: 5, maxDays: 8, company: 'AliExpress Standard', tracking: true, currency: 'GBP' });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  Object.assign(ebaySource, { fetchListing: real.fetchListing });
  Object.assign(aliexpressSource, { fetchProduct: real.fetchProduct, fetchShipping: real.fetchShipping });
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function request(method, path, body, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function signup() {
  const email = `hunt-owner-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  return { ownerId: data.user.id, ownerToken: data.token };
}

async function member(ownerToken, name, features) {
  const email = `hunt-${name}-${crypto.randomUUID()}@example.com`;
  const added = await request('POST', '/api/team/members', { email, password: 'memberpassword123', name }, ownerToken);
  assert.strictEqual(added.status, 201);
  const id = added.data.member.id;
  await request('PUT', `/api/team/members/${id}/permissions`, { permissions: features.map((feature) => ({ connectionId: null, feature, allowed: true })) }, ownerToken);
  const { data } = await request('POST', '/api/auth/login', { email, password: 'memberpassword123' });
  return { id, token: data.token };
}

async function team() {
  const { ownerId, ownerToken } = await signup();
  const connection = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Hunt Store', credentials: { accessToken: 'x' } });
  const other = await connectionService.createConnection(ownerId, { platformKey: 'ebay', label: 'Second Store', credentials: { accessToken: 'x' } });
  const hunter = await member(ownerToken, 'hunter', ['hunting']);
  const reviewer = await member(ownerToken, 'reviewer', ['hunting_review']);
  const lister = await member(ownerToken, 'lister', ['listings']);
  const nobody = await member(ownerToken, 'nobody', ['orders']);
  return { ownerId, ownerToken, connectionId: connection.id, otherId: other.id, hunter, reviewer, lister, nobody };
}

async function hunt(connectionId, token, note) {
  const checked = await request('POST', `/api/connections/${connectionId}/hunting/check`, { competitorUrl: COMPETITOR_URL, sourceUrl: SOURCE_URL }, token);
  assert.strictEqual(checked.status, 200, JSON.stringify(checked.data));
  const added = await request('POST', `/api/connections/${connectionId}/hunting`, { checkId: checked.data.checkId, note }, token);
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  return { checked: checked.data, hunt: added.data };
}

test('a check works out profit per option at the competitor price, with the real postage, and saves nothing', async () => {
  const t = await team();
  const { data, status } = await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: COMPETITOR_URL, sourceUrl: SOURCE_URL }, t.hunter.token);
  assert.strictEqual(status, 200);
  const black = data.result.options[0];
  // 12.99 − 3.00 − 0.99 postage − 30% fees (3.90) − 0.30 = 4.80
  assert.strictEqual(black.profit, 4.8);
  assert.strictEqual(data.result.summary.bestSeller.label, 'Black');
  assert.strictEqual(data.result.shipping.basis, 'aliexpress');
  assert.strictEqual(data.autoApproves, false);
  const listed = await request('GET', `/api/connections/${t.connectionId}/hunting`, undefined, t.hunter.token);
  assert.strictEqual(listed.data.items.length, 0);
});

test('the competitor is optional: without one nothing is read from eBay and options are priced at the target return', async () => {
  const t = await team();
  let ebayReads = 0;
  const counted = ebaySource.fetchListing;
  ebaySource.fetchListing = async (...args) => {
    ebayReads += 1;
    return counted(...args);
  };
  try {
    const { data, status } = await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: '', sourceUrl: SOURCE_URL }, t.hunter.token);
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(ebayReads, 0);
    assert.strictEqual(data.result.competitor, null);
    assert.strictEqual(data.result.summary.verdict, 'unpriced');
    assert.ok(data.result.options.every((o) => o.match.quality === 'target' && o.roi >= 60));
    const added = await request('POST', `/api/connections/${t.connectionId}/hunting`, { checkId: data.checkId }, t.hunter.token);
    assert.strictEqual(added.status, 201);
    assert.strictEqual(added.data.competitorUrl, null);
    assert.strictEqual(added.data.title, 'TWS Earbuds');

    // A competitor added later is read and judged against; taken away again, it's gone.
    const withOne = await request('PATCH', `/api/hunting/${added.data.id}`, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.strictEqual(withOne.data.competitorUrl, COMPETITOR_URL);
    assert.notStrictEqual(withOne.data.verdict, 'unpriced');
    const without = await request('PATCH', `/api/hunting/${added.data.id}`, { competitorUrl: '' }, t.hunter.token);
    assert.strictEqual(without.data.competitorUrl, null);
    assert.strictEqual(without.data.verdict, 'unpriced');
  } finally {
    ebaySource.fetchListing = counted;
  }
});

test("the competitor's sales are read when hunted and daily after, as history with a sales score", async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token);
  assert.ok(added.salesScore && added.salesScore.score > 0);
  // The first reading was kept; a day later the tracker reads the competitor again.
  await pool.query(`UPDATE hunt_sales_snapshots SET taken_at = taken_at - interval '1 day' WHERE hunt_id = $1`, [added.id]);
  const real = ebaySource.fetchListing;
  ebaySource.fetchListing = async (url) => ({ ...COMPETITOR, sourceUrl: url, sold: 140, variants: [{ ...COMPETITOR.variants[0], sold: 108 }, { ...COMPETITOR.variants[1], sold: 32 }] });
  try {
    const huntingService = require('../../src/modules/hunting/hunting.service');
    const read = await huntingService.readDueSales({ limit: 50, ownerId: t.ownerId });
    assert.ok(read >= 1);
  } finally {
    ebaySource.fetchListing = real;
  }
  const detail = await request('GET', `/api/hunting/${added.id}`, undefined, t.reviewer.token);
  const h = detail.data.result.sales.history;
  assert.strictEqual(h.readings, 2);
  assert.strictEqual(h.soldLast7, 10);
  assert.deepStrictEqual(h.byVariation, [{ label: 'Black', sold: 8 }, { label: 'White', sold: 2 }]);
  assert.deepStrictEqual(detail.data.result.sales.variations.map((v) => [v.label, v.sold]), [['Black', 100], ['White', 30]]);
  assert.ok(detail.data.result.salesScore.parts.length === 4);
  const byScore = await request('GET', `/api/connections/${t.connectionId}/hunting?view=all&sort=sales`, undefined, t.reviewer.token);
  assert.strictEqual(byScore.status, 200);
  assert.ok(byScore.data.items[0].salesScore.label);
});

test('opening a product with no readings (rejected, or hunted before readings) reads its competitor then and there', async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'reject', reason: 'low_demand' }, t.reviewer.token);
  // As a product hunted before sales were kept: no readings, no per-variation sales in its check.
  await pool.query('DELETE FROM hunt_sales_snapshots WHERE hunt_id = $1', [added.id]);
  await pool.query(`UPDATE hunted_products SET check_result = check_result - 'sales' - 'salesScore', sales_score = NULL WHERE id = $1`, [added.id]);
  const detail = await request('GET', `/api/hunting/${added.id}`, undefined, t.reviewer.token);
  assert.strictEqual(detail.data.result.sales.history.readings, 1);
  assert.deepStrictEqual(detail.data.result.sales.variations.map((v) => [v.label, v.sold, v.supplier]), [['Black', 100, ['Black']], ['White', 30, ['White']]]);
  assert.ok(detail.data.result.salesScore.score > 0);
  // Opened again straight away: no second reading.
  await request('GET', `/api/hunting/${added.id}`, undefined, t.reviewer.token);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM hunt_sales_snapshots WHERE hunt_id = $1', [added.id]);
  assert.strictEqual(rows[0].n, 1);
});

test('the filters: profit a sale, demand, when it was added and not already elsewhere, applied to the tab counts too', async () => {
  const t = await team();
  const { hunt: a } = await hunt(t.connectionId, t.hunter.token);
  const { hunt: b } = await hunt(t.connectionId, t.hunter.token);
  const { hunt: c } = await hunt(t.connectionId, t.hunter.token);
  await pool.query(`UPDATE hunted_products SET headline_profit = 6, sold_per_month = 40, check_result = check_result || '{"duplicates": []}'::jsonb WHERE id = $1`, [a.id]);
  await pool.query(`UPDATE hunted_products SET headline_profit = 2.5, sold_per_month = 8, check_result = check_result || '{"duplicates": [{"type": "similar"}]}'::jsonb WHERE id = $1`, [b.id]);
  await pool.query(`UPDATE hunted_products SET headline_profit = 1.2, sold_per_month = 150, created_at = now() - interval '40 days', check_result = check_result || '{"duplicates": [{"type": "hunted"}]}'::jsonb WHERE id = $1`, [c.id]);
  const ids = async (qs) => {
    const r = await request('GET', `/api/connections/${t.connectionId}/hunting?view=all&sort=newest&${qs}`, undefined, t.reviewer.token);
    return { ids: r.data.items.map((h) => h.id).sort(), all: r.data.counts.all, review: r.data.counts.review };
  };
  assert.deepStrictEqual(await ids('profit=5'), { ids: [a.id], all: 1, review: 1 });
  assert.deepStrictEqual(await ids('profit=2'), { ids: [a.id, b.id].sort(), all: 2, review: 2 });
  assert.deepStrictEqual(await ids('demand=30'), { ids: [a.id, c.id].sort(), all: 2, review: 2 });
  assert.deepStrictEqual(await ids('added=30'), { ids: [a.id, b.id].sort(), all: 2, review: 2 });
  // A similar title alone isn't a duplicate.
  assert.deepStrictEqual(await ids('unique=1'), { ids: [a.id, b.id].sort(), all: 2, review: 2 });
  // A value off the list is ignored.
  assert.strictEqual((await ids('profit=4')).all, 3);
});

test('the tabs: All, Needs a supplier, Waiting for review, Approved, Drafted, Listed, Rejected, and My hunts for each person; a drafted product stays on the page', async () => {
  const t = await team();
  const { hunt: mine } = await hunt(t.connectionId, t.hunter.token);
  await hunt(t.connectionId, t.ownerToken); // the owner's: approved as added
  const list = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.hunter.token);
  assert.deepStrictEqual(list.data.views, ['all', 'sourcing', 'review', 'approved', 'drafted', 'listed', 'rejected', 'mine']);
  assert.strictEqual(list.data.view, 'mine');
  assert.deepStrictEqual(list.data.items.map((h) => h.id), [mine.id]);
  assert.strictEqual(list.data.counts.mine, 1);
  assert.strictEqual(list.data.counts.all, 2);
  // Once drafted it leaves Approved for Drafted, and stays on the page (All and My hunts) with its stage.
  await request('POST', `/api/hunting/${mine.id}/decision`, { decision: 'approve' }, t.reviewer.token);
  const draft = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Earbuds' } });
  await huntingRepository.linkDraft(mine.id, draft.id, t.lister.id);
  const approved = await request('GET', `/api/connections/${t.connectionId}/hunting?view=approved`, undefined, t.reviewer.token);
  assert.strictEqual(approved.data.counts.approved, 1);
  assert.ok(!approved.data.items.some((h) => h.id === mine.id));
  const drafted = await request('GET', `/api/connections/${t.connectionId}/hunting?view=drafted`, undefined, t.reviewer.token);
  assert.deepStrictEqual([drafted.data.counts.drafted, drafted.data.items.map((h) => [h.id, h.stage])], [1, [[mine.id, 'drafted']]]);
  const kept = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.hunter.token);
  assert.deepStrictEqual([kept.data.counts.mine, kept.data.items.map((h) => h.stage)], [1, ['drafted']]);
  assert.strictEqual(kept.data.counts.all, 2);
  // Live on eBay: Listed.
  await pool.query(`UPDATE hunted_products SET item_ids = ARRAY['800700000009'] WHERE id = $1`, [mine.id]);
  const listedTab = await request('GET', `/api/connections/${t.connectionId}/hunting?view=listed`, undefined, t.reviewer.token);
  assert.deepStrictEqual([listedTab.data.counts.listed, listedTab.data.counts.drafted, listedTab.data.items.map((h) => h.stage)], [1, 0, ['listed']]);
  // Someone who only drafts sees Approved, Drafted and Listed.
  const lister = await request('GET', `/api/connections/${t.connectionId}/hunting`, undefined, t.lister.token);
  assert.deepStrictEqual(lister.data.views, ['approved', 'drafted', 'listed']);
  // The reviewer's own My hunts is empty; a sent-back tab is gone.
  const reviewerMine = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.reviewer.token);
  void reviewerMine;
  assert.strictEqual(reviewerMine.data.items.length, 0);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting?view=sent_back`, undefined, t.reviewer.token)).data.view, 'all');
  // Search finds a product by its eBay item number, the hunter's name or a note, not only its title.
  const search = async (q) => (await request('GET', `/api/connections/${t.connectionId}/hunting?view=all&q=${encodeURIComponent(q)}`, undefined, t.reviewer.token)).data.items.map((h) => h.id);
  const { hunt: found } = await hunt(t.connectionId, t.hunter.token);
  assert.ok((await search('123456789012')).includes(found.id));
  // The hunter's products, the drafted one included (it stays on the page).
  assert.deepStrictEqual((await search('hunter')).sort(), [found.id, mine.id].sort());
  assert.deepStrictEqual(await search('no such thing anywhere'), []);
  // The Overview's Hunted / Approved / Rejected for the dates, and what waits now.
  const hour = new Date(Date.now() - 3600 * 1000);
  const soon = new Date(Date.now() + 60 * 1000);
  const { hunt: third } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${third.id}/decision`, { decision: 'reject', reason: 'low_profit' }, t.reviewer.token);
  await hunt(t.connectionId, t.hunter.token);
  const none = huntingRepository.EMPTY_OVERVIEW;
  // Of the two approved, the owner's own was approved as it was added, and isn't drafted yet.
  assert.deepStrictEqual(await huntingRepository.countForOverview(t.connectionId, hour, soon), { ...none, hunted: 5, approved: 2, approvedAsAdded: 1, rejected: 1, reviewing: 2, toDraft: 1 });
  assert.deepStrictEqual(await huntingRepository.countForOverview(t.connectionId, new Date(Date.now() - 7200 * 1000), hour), { ...none, reviewing: 2, toDraft: 1 });
  // What's behind each: found by Liston, rejected by Liston (its supplier doesn't sell what sells), sent
  // back; and now, approved and still to be drafted, or its draft failed (stuck drafting counts).
  const { hunt: byListon } = await hunt(t.connectionId, t.hunter.token);
  await pool.query(`UPDATE hunted_products SET found_by_liston = true WHERE id = $1`, [byListon.id]);
  await request('POST', `/api/hunting/${byListon.id}/decision`, { decision: 'send_back', note: 'Check the white one' }, t.reviewer.token);
  const { hunt: mismatched } = await hunt(t.connectionId, t.hunter.token);
  await huntingRepository.setDecision(mismatched.id, { status: 'rejected', reject_reason: 'mismatch', decision_note: 'No White' }, null);
  const approve = async () => {
    const { hunt: h } = await hunt(t.connectionId, t.hunter.token);
    await request('POST', `/api/hunting/${h.id}/decision`, { decision: 'approve' }, t.reviewer.token);
    return h.id;
  };
  await approve();
  const failedId = await approve();
  const stuckId = await approve();
  await pool.query(`UPDATE hunted_products SET draft_status = 'failed', draft_error = 'eBay said no' WHERE id = $1`, [failedId]);
  await pool.query(`UPDATE hunted_products SET draft_status = 'drafting', draft_attempted_at = now() - interval '20 minutes' WHERE id = $1`, [stuckId]);
  assert.deepStrictEqual(await huntingRepository.countForOverview(t.connectionId, hour, soon), {
    ...none,
    hunted: 10,
    huntedByListon: 1,
    approved: 5,
    approvedAsAdded: 1,
    rejected: 2,
    rejectedByListon: 1,
    sentBack: 1,
    reviewing: 2,
    sentBackNow: 1,
    toDraft: 2,
    draftFailed: 2,
  });
});

test('a bad link is refused before anything is read', async () => {
  const t = await team();
  const { status, data } = await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: 'https://www.ebay.co.uk/sch/earbuds', sourceUrl: SOURCE_URL }, t.hunter.token);
  assert.strictEqual(status, 400);
  assert.match(data.error, /eBay listing link/);
});

test('without hunting access a member can neither see nor add hunted products', async () => {
  const t = await team();
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting`, undefined, t.nobody.token)).status, 403);
  assert.strictEqual((await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: COMPETITOR_URL, sourceUrl: SOURCE_URL }, t.nobody.token)).status, 403);
  const badge = await request('GET', `/api/connections/${t.connectionId}/hunting/badge`, undefined, t.nobody.token);
  assert.strictEqual(badge.status, 200);
  assert.strictEqual(badge.data.access, false);
});

test('a hunter adds a product for review; they cannot review it, a reviewer approves it, and both are recorded', async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token, 'Sells well in black');
  assert.strictEqual(added.stage, 'pending');
  assert.strictEqual(added.hunterNote, 'Sells well in black');
  assert.strictEqual(added.permissions.canDecide, false);
  assert.strictEqual(added.permissions.canEdit, true);

  const own = await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'approve' }, t.hunter.token);
  assert.strictEqual(own.status, 403);

  const badge = await request('GET', `/api/connections/${t.connectionId}/hunting/badge`, undefined, t.reviewer.token);
  assert.strictEqual(badge.data.review, 1);

  const approved = await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'approve', note: 'Good margin' }, t.reviewer.token);
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.data.stage, 'approved');
  assert.strictEqual(approved.data.reviewer.id, t.reviewer.id);
  assert.deepStrictEqual(approved.data.timeline.map((e) => e.kind), ['hunted', 'approved']);

  const { rows } = await pool.query(`SELECT actor_user_id, kind FROM member_activity WHERE subject_type = 'hunt' AND subject_id = $1 ORDER BY id`, [added.id]);
  assert.deepStrictEqual(rows.map((r) => [r.actor_user_id, r.kind]), [[t.hunter.id, 'hunt.added'], [t.reviewer.id, 'hunt.approved']]);
});

test("a reviewer's own find waits for the owner; the owner's own finds are approved as they're added", async () => {
  const t = await team();
  const { hunt: byReviewer } = await hunt(t.connectionId, t.reviewer.token);
  assert.strictEqual(byReviewer.stage, 'pending');
  assert.strictEqual((await request('POST', `/api/hunting/${byReviewer.id}/decision`, { decision: 'approve' }, t.reviewer.token)).status, 403);
  assert.strictEqual((await request('POST', `/api/hunting/${byReviewer.id}/decision`, { decision: 'approve' }, t.ownerToken)).status, 200);

  const { hunt: byOwner, checked } = await hunt(t.connectionId, t.ownerToken);
  assert.strictEqual(checked.autoApproves, true);
  assert.strictEqual(byOwner.stage, 'approved');
  assert.strictEqual(byOwner.autoApproved, true);
});

test('sent back with a note, the hunter changes it and resubmits; a rejection needs a reason', async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token);
  const noNote = await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'send_back' }, t.reviewer.token);
  assert.strictEqual(noNote.status, 400);
  const sent = await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'send_back', note: 'Find a cheaper supplier' }, t.reviewer.token);
  assert.strictEqual(sent.data.stage, 'sent_back');
  assert.strictEqual(sent.data.decisionNote, 'Find a cheaper supplier');

  const badge = await request('GET', `/api/connections/${t.connectionId}/hunting/badge`, undefined, t.hunter.token);
  assert.strictEqual(badge.data.sentBack, 1);

  const changed = await request('PATCH', `/api/hunting/${added.id}`, { sourceUrl: 'https://www.aliexpress.com/item/1005009999999999.html', note: 'Cheaper store' }, t.hunter.token);
  assert.strictEqual(changed.status, 200);
  assert.strictEqual(changed.data.sourceUrl, 'https://www.aliexpress.com/item/1005009999999999.html');
  const again = await request('POST', `/api/hunting/${added.id}/resubmit`, {}, t.hunter.token);
  assert.strictEqual(again.data.stage, 'pending');
  assert.strictEqual(again.data.resubmits, 1);
  assert.strictEqual(again.data.decisionNote, null);
  // The send-back and its note stay in the history.
  assert.deepStrictEqual(again.data.timeline.map((e) => e.kind), ['hunted', 'sent_back', 'updated', 'resubmitted']);
  assert.strictEqual(again.data.timeline[1].note, 'Find a cheaper supplier');

  assert.strictEqual((await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'reject' }, t.reviewer.token)).status, 400);
  const rejected = await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'reject', reason: 'low_demand', note: 'Too few sales' }, t.reviewer.token);
  assert.strictEqual(rejected.data.stage, 'rejected');
  assert.strictEqual(rejected.data.rejectReasonLabel, 'Low demand');
  // A hunter never removes a product, decided or not.
  assert.strictEqual((await request('DELETE', `/api/hunting/${added.id}`, undefined, t.hunter.token)).status, 403);
});

test('the same product elsewhere on the owner accounts is a warning, never a block', async () => {
  const t = await team();
  await hunt(t.otherId, t.ownerToken);
  const { checked, hunt: again } = await hunt(t.connectionId, t.hunter.token);
  const found = checked.result.duplicates.find((d) => d.type === 'hunt');
  assert.ok(found, 'the hunt on the other account is named');
  assert.strictEqual(found.account, 'Second Store');
  assert.strictEqual(found.same, 'both');
  assert.strictEqual(again.stage, 'pending');
  assert.strictEqual(again.duplicates, 1);
});

test('a lister sees only approved products, drafts them, and the listing and its sales follow the hunter', async () => {
  const t = await team();
  const { hunt: waiting } = await hunt(t.connectionId, t.hunter.token);
  const { hunt: approved } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${approved.id}/decision`, { decision: 'approve' }, t.reviewer.token);

  const seen = await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.lister.token);
  assert.strictEqual(seen.status, 200);
  assert.deepStrictEqual(seen.data.views, ['approved', 'drafted', 'listed']);
  assert.deepStrictEqual(seen.data.items.map((i) => i.id), [approved.id]);
  assert.strictEqual(seen.data.items[0].permissions.canDraft, true);
  assert.strictEqual((await request('GET', `/api/hunting/${waiting.id}`, undefined, t.lister.token)).status, 404);

  // Drafting an unapproved product is refused before anything is generated.
  await assert.rejects(listingService.generateEbayDraftFromUrls(t.connectionId, t.ownerId, { previewId: 'x', huntId: waiting.id }), /not been approved/);

  // The draft (made by the AI in real use) is tied to the hunt, then published as an eBay item.
  const draft = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Earbuds' } });
  await huntingRepository.linkDraft(approved.id, draft.id, t.lister.id);
  assert.strictEqual((await request('GET', `/api/hunting/${approved.id}`, undefined, t.lister.token)).data.stage, 'drafted');
  const itemId = String(Date.now()).slice(-12);
  await huntingRepository.addItemForListing(draft.id, itemId);
  await pool.query(`INSERT INTO ebay_orders (connection_id, order_id, created_at, data) VALUES ($1, $2, now(), $3)`, [
    t.connectionId,
    `hunt-order-${crypto.randomUUID()}`,
    JSON.stringify({ createdAt: new Date().toISOString(), status: 'Completed', total: { amount: 25.98, currency: 'GBP' }, lineItems: [{ itemId, quantityPurchased: 2, price: { amount: 12.99, currency: 'GBP' } }] }),
  ]);

  const detail = await request('GET', `/api/hunting/${approved.id}`, undefined, t.reviewer.token);
  assert.strictEqual(detail.data.stage, 'listed');
  assert.deepStrictEqual(detail.data.sales, { currency: 'GBP', orders: 1, units: 2, sales: 25.98, lastAt: detail.data.sales.lastAt });
  assert.deepStrictEqual(detail.data.timeline.map((e) => e.kind), ['hunted', 'approved', 'drafted', 'listed']);
  // A listed product's review is settled.
  assert.strictEqual((await request('POST', `/api/hunting/${approved.id}/decision`, { decision: 'reject', reason: 'other', note: 'late change' }, t.ownerToken)).status, 403);

  // Each member's figures live on their own page in the owner's Team area.
  const page = await request('GET', `/api/team/members/${t.hunter.id}/overview?range=7d`, undefined, t.ownerToken);
  assert.strictEqual(page.data.totals.hunted, 2);
  const h = page.data.hunting.hunter;
  assert.deepStrictEqual({ hunted: h.hunted, approved: h.approved, waiting: h.waiting, listed: h.listed }, { hunted: 2, approved: 1, waiting: 1, listed: 1 });
  assert.strictEqual(page.data.hunting.sales[0].sales, 25.98);
  // The sold product counts as converting, on the day of its order.
  assert.strictEqual(page.data.huntOutcomes.totals.converting, 1);
  assert.strictEqual(page.data.huntOutcomes.series.reduce((n, d) => n + d.converting, 0), 1);
  // Their products approved and rejected by day, for the chart.
  assert.strictEqual(page.data.huntOutcomes.totals.approved, 1);
  assert.strictEqual(page.data.huntOutcomes.series.reduce((n, d) => n + d.approved, 0), 1);
  assert.strictEqual(page.data.huntOutcomes.series.length, page.data.series.length);
  const reviewerPage = await request('GET', `/api/team/members/${t.reviewer.id}/overview?range=7d`, undefined, t.ownerToken);
  assert.strictEqual(reviewerPage.data.hunting.reviewer.approved, 1);
  // A member sees their own work on each account, on that account's Overview: that account only, and no money.
  await hunt(t.otherId, t.hunter.token);
  const own = await request('GET', `/api/connections/${t.connectionId}/my-work?range=7d`, undefined, t.hunter.token);
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.data.totals.hunted, 2, 'the other account\'s find is not counted here');
  assert.strictEqual(own.data.hunting.hunter.hunted, 2);
  assert.deepStrictEqual(own.data.hunting.sales, [{ orders: 1, units: 2, lastAt: own.data.hunting.sales[0].lastAt }]);
  assert.ok(!JSON.stringify(own.data).includes('25.98'), 'no sales amount anywhere');
  assert.strictEqual(own.data.huntOutcomes.totals.converting, 1);
  assert.deepStrictEqual(Object.fromEntries(own.data.permissions.map((x) => [x.feature, x.allowed])).hunting, true);
  assert.strictEqual(own.data.permissions.find((x) => x.feature === 'orders').allowed, false);
  const elsewhere = await request('GET', `/api/connections/${t.otherId}/my-work?range=7d`, undefined, t.hunter.token);
  assert.strictEqual(elsewhere.data.totals.hunted, 1);
  // Owners have the account Overview; a member without access to the account gets nothing.
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/my-work?range=7d`, undefined, t.ownerToken)).status, 403);
  await request('PUT', `/api/team/members/${t.nobody.id}/permissions`, { permissions: [{ connectionId: t.connectionId, feature: 'orders', allowed: false }] }, t.ownerToken);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/my-work?range=7d`, undefined, t.nobody.token)).status, 403);

  // Only the owner sees a member's page; the Hunting page has no team view any more.
  assert.strictEqual((await request('GET', `/api/team/members/${t.hunter.id}/overview?range=7d`, undefined, t.reviewer.token)).status, 403);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting/team`, undefined, t.reviewer.token)).status, 404);
});

test('only a reviewer removes a hunted product, at any stage; the hunter is told', async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token);
  const before = await request('GET', `/api/connections/${t.connectionId}/hunting?view=review`, undefined, t.reviewer.token);
  assert.strictEqual(before.data.counts.review, 1);
  // The hunter can't, even while it waits: they edit it instead.
  const refused = await request('DELETE', `/api/hunting/${added.id}`, undefined, t.hunter.token);
  assert.strictEqual(refused.status, 403);
  assert.match(refused.data.error, /Only a reviewer/);
  assert.strictEqual((await request('GET', `/api/hunting/${added.id}`, undefined, t.hunter.token)).data.permissions.canRemove, false);
  assert.strictEqual((await request('GET', `/api/hunting/${added.id}`, undefined, t.reviewer.token)).data.permissions.canRemove, true);
  // Approved, then removed by the reviewer.
  await request('POST', `/api/hunting/${added.id}/decision`, { decision: 'approve' }, t.reviewer.token);
  assert.strictEqual((await request('DELETE', `/api/hunting/${added.id}`, undefined, t.reviewer.token)).status, 204);
  const after = await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.reviewer.token);
  assert.strictEqual(after.data.items.length, 0);
  // The owner removes too.
  const { hunt: second } = await hunt(t.connectionId, t.hunter.token);
  assert.strictEqual((await request('DELETE', `/api/hunting/${second.id}`, undefined, t.ownerToken)).status, 204);

  const bell = await request('GET', '/api/notifications', undefined, t.hunter.token);
  assert.deepStrictEqual(bell.data.items.map((n) => n.kind), ['hunt.removed', 'hunt.removed', 'hunt.approved']);
  assert.match(bell.data.items[0].body, /removed your hunted product/);

  // The owner names themselves in their profile; the team sees that name, on older notifications too.
  assert.strictEqual((await request('PATCH', '/api/users/me/name', { name: 'Usama Javed' }, t.ownerToken)).status, 200);
  const renamed = await request('GET', '/api/notifications', undefined, t.hunter.token);
  assert.strictEqual(renamed.data.items[0].detail.by, 'Usama Javed');
  // A member names themselves too, and the owner's Team page shows it.
  assert.strictEqual((await request('PATCH', '/api/users/me/name', { name: 'Ali Hunter' }, t.hunter.token)).status, 200);
  assert.strictEqual((await request('GET', '/api/users/me', undefined, t.hunter.token)).data.user.name, 'Ali Hunter');
  const members = await request('GET', '/api/team/members', undefined, t.ownerToken);
  assert.ok(members.data.members.some((m) => m.name === 'Ali Hunter'));
  assert.strictEqual((await request('PATCH', '/api/users/me/name', { name: '   ' }, t.ownerToken)).status, 400);
});

test("the hunter is notified when a reviewer approves, rejects or sends back their product; the bell marks them read", async () => {
  const t = await team();
  const { hunt: one } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'send_back', note: 'Find a cheaper supplier' }, t.reviewer.token);
  await request('POST', `/api/hunting/${one.id}/resubmit`, {}, t.hunter.token);
  await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'reject', reason: 'low_demand', note: 'Too few sales' }, t.reviewer.token);
  const { hunt: two } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${two.id}/decision`, { decision: 'approve' }, t.reviewer.token);

  const bell = await request('GET', '/api/notifications', undefined, t.hunter.token);
  assert.strictEqual(bell.status, 200);
  assert.strictEqual(bell.data.unread, 3);
  assert.deepStrictEqual(bell.data.items.map((n) => n.kind), ['hunt.approved', 'hunt.rejected', 'hunt.sent_back']);
  const [approved, rejected, sentBack] = bell.data.items;
  assert.strictEqual(approved.url, `/accounts/${t.connectionId}/hunting?open=${two.id}`);
  assert.match(approved.title, /^Approved: /);
  assert.match(rejected.body, /rejected it: Low demand\. “Too few sales”/);
  assert.match(sentBack.body, /sent it back for you to improve\. “Find a cheaper supplier”/);
  // The reviewer isn't told about their own decisions, and nobody else sees the hunter's.
  assert.strictEqual((await request('GET', '/api/notifications', undefined, t.reviewer.token)).data.items.length, 0);
  // The owner's own finds are approved as added: nobody is told.
  await hunt(t.connectionId, t.ownerToken);
  assert.strictEqual((await request('GET', '/api/notifications', undefined, t.ownerToken)).data.items.length, 0);

  const one1 = await request('POST', '/api/notifications/read', { ids: [approved.id] }, t.hunter.token);
  assert.strictEqual(one1.data.unread, 2);
  const all = await request('POST', '/api/notifications/read', {}, t.hunter.token);
  assert.strictEqual(all.data.unread, 0);
  assert.ok(all.data.items.every((n) => n.readAt));

  // A browser turns push on and off (no push is sent here: nothing new happens while it's on).
  const sub = { endpoint: `https://push.example.com/${crypto.randomUUID()}`, keys: { p256dh: 'BExamplePublicKeyValue123', auth: 'exampleAuth1' } };
  if (bell.data.push.available) {
    assert.strictEqual((await request('POST', '/api/notifications/push', sub, t.hunter.token)).status, 204);
    const { rows } = await pool.query('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
    assert.strictEqual(rows[0].user_id, t.hunter.id);
    assert.strictEqual((await request('DELETE', '/api/notifications/push', { endpoint: sub.endpoint }, t.hunter.token)).status, 204);
    assert.strictEqual((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rowCount, 0);
  }
  assert.strictEqual((await request('POST', '/api/notifications/push', { endpoint: 'not a url', keys: {} }, t.hunter.token)).status, 400);
  assert.deepStrictEqual(rejected.detail, { product: rejected.detail.product, by: rejected.detail.by, reason: 'Low demand', note: 'Too few sales' });
  assert.ok(rejected.detail.product && rejected.detail.by);
  // Clearing one, then all.
  const cleared = await request('POST', '/api/notifications/clear', { ids: [sentBack.id] }, t.hunter.token);
  assert.deepStrictEqual(cleared.data.items.map((n) => n.kind), ['hunt.approved', 'hunt.rejected']);
  assert.strictEqual((await request('POST', '/api/notifications/clear', {}, t.hunter.token)).data.items.length, 0);
  // "Send a test" tells the person themselves, for checking their browser and computer.
  const tested = await request('POST', '/api/notifications/test', undefined, t.lister.token);
  assert.strictEqual(tested.status, 200);
  assert.strictEqual(tested.data.items[0].kind, 'test');
  assert.strictEqual(tested.data.unread, 1);
});

const huntingService = require('../../src/modules/hunting/hunting.service');
const notificationsRepo = { list: async (userId) => (await pool.query('SELECT kind, title, body, actor_user_id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows };

test("a supplier that doesn't sell the eBay listing's variations is rejected by Liston, with the reason, and the hunter is told and can remove it", async () => {
  const t = await team();
  // The supplier has Black only; the eBay listing sells Black and White.
  aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, variants: [SOURCE.variants[0]], sourceUrl: url });
  try {
    const checked = await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: COMPETITOR_URL, sourceUrl: SOURCE_URL }, t.hunter.token);
    assert.strictEqual(checked.data.result.mismatch.kind, 'variations', 'the check says so before it is added');
    assert.deepStrictEqual(checked.data.result.mismatch.missing, ['White']);
    const added = await request('POST', `/api/connections/${t.connectionId}/hunting`, { checkId: checked.data.checkId }, t.hunter.token);
    const h = added.data;
    assert.deepStrictEqual([h.stage, h.rejectReason, h.autoRejected, h.reviewer], ['rejected', 'mismatch', true, null]);
    assert.match(h.decisionNote, /White/);
    const rejected = await request('GET', `/api/connections/${t.connectionId}/hunting?view=rejected`, undefined, t.reviewer.token);
    assert.ok(rejected.data.items.some((i) => i.id === h.id && i.rejectReasonLabel === "Supplier doesn't match the eBay listing"));
    const told = await notificationsRepo.list(t.hunter.id);
    assert.strictEqual(told[0].kind, 'hunt.rejected');
    assert.match(told[0].title, /^Rejected by Liston: /);
    assert.match(told[0].body, /White/);
    assert.strictEqual(told[0].actor_user_id, null);
    // The owner's own find is rejected the same way, not approved.
    const ownerCheck = await request('POST', `/api/connections/${t.connectionId}/hunting/check`, { competitorUrl: COMPETITOR_URL, sourceUrl: SOURCE_URL }, t.ownerToken);
    const ownerAdded = await request('POST', `/api/connections/${t.connectionId}/hunting`, { checkId: ownerCheck.data.checkId }, t.ownerToken);
    assert.strictEqual(ownerAdded.data.stage, 'rejected');
    // Rechecked once the supplier has White too, it goes back in for review.
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
    const again = await request('POST', `/api/hunting/${h.id}/recheck`, {}, t.hunter.token);
    assert.strictEqual(again.data.stage, 'pending');
    // …and one rejected by Liston again, the hunter removes it themselves.
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, variants: [SOURCE.variants[0]], sourceUrl: url });
    await request('POST', `/api/hunting/${h.id}/recheck`, {}, t.hunter.token);
    assert.strictEqual((await request('DELETE', `/api/hunting/${h.id}`, undefined, t.hunter.token)).status, 204);
  } finally {
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
  }
});

test('an approved product drafts itself and moves to the Drafted tab; a failed draft stays in Approved with the reason and drafts again by hand', async () => {
  const t = await team();
  const { mock } = require('node:test');
  const config = require('../../src/config');
  config.hunting.autoDraft = true;
  let fail = true;
  const previews = mock.method(listingService, 'previewDraftSources', async () => ({ previewId: 'p1', source: { axes: [{ name: 'Color', values: [{ value: 'Black' }, { value: 'White' }] }], imageUrls: ['https://ae01.alicdn.com/a.jpg'] } }));
  const drafts = mock.method(listingService, 'generateEbayDraftFromUrls', async (connectionId, ownerId, input) => {
    if (fail) throw Object.assign(new Error('Choose your business policies in Settings before drafting a listing.'), { statusCode: 400 });
    const draft = await listingRepository.createDraft({ connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Earbuds' } });
    await huntingRepository.linkDraft(input.huntId, draft.id, input.actorUserId);
    return draft;
  });
  try {
    const { hunt: one } = await hunt(t.connectionId, t.hunter.token);
    const approved = await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'approve' }, t.reviewer.token);
    assert.strictEqual(approved.status, 200);
    await huntingService.draftsSettled();
    // It failed: it stays, approved, with why, and the button to try again.
    const failed = (await request('GET', `/api/hunting/${one.id}`, undefined, t.reviewer.token)).data;
    assert.deepStrictEqual([failed.stage, failed.draftState], ['approved', 'failed']);
    assert.match(failed.draftError, /business policies/);
    assert.strictEqual(failed.permissions.canDraft, true);
    const input = drafts.mock.calls[0].arguments[2];
    assert.deepStrictEqual([input.previewId, input.huntId, input.actorUserId], ['p1', one.id, t.reviewer.id]);
    assert.deepStrictEqual(input.variantSelection, { Color: ['Black', 'White'] }, 'the options that earn');
    assert.deepStrictEqual(input.imageUrls, ['https://ae01.alicdn.com/a.jpg']);
    // Drafted by hand (it runs in the background): it moves from Approved to Drafted, still on the page.
    fail = false;
    const retry = await request('POST', `/api/hunting/${one.id}/auto-draft`, {}, t.reviewer.token);
    assert.strictEqual(retry.status, 202);
    await huntingService.draftsSettled();
    const done = (await request('GET', `/api/hunting/${one.id}`, undefined, t.reviewer.token)).data;
    assert.deepStrictEqual([done.stage, done.draftState, done.draftError], ['drafted', null, null]);
    const page = await request('GET', `/api/connections/${t.connectionId}/hunting?view=approved`, undefined, t.reviewer.token);
    assert.ok(!page.data.items.some((i) => i.id === one.id));
    const draftedTab = await request('GET', `/api/connections/${t.connectionId}/hunting?view=drafted`, undefined, t.reviewer.token);
    assert.ok(draftedTab.data.items.some((i) => i.id === one.id && i.stage === 'drafted'));
    // A drafted product isn't drafted again.
    assert.strictEqual((await request('POST', `/api/hunting/${one.id}/auto-draft`, {}, t.reviewer.token)).status, 403);
    // The owner's own find drafts itself as it's added.
    fail = false;
    const { hunt: own } = await hunt(t.connectionId, t.ownerToken);
    await huntingService.draftsSettled();
    assert.strictEqual((await request('GET', `/api/hunting/${own.id}`, undefined, t.ownerToken)).data.stage, 'drafted');
    assert.strictEqual(previews.mock.calls.length, 3);
  } finally {
    config.hunting.autoDraft = false;
    previews.mock.restore();
    drafts.mock.restore();
  }
});

test('a rejected product can be fixed by its hunter or a reviewer and goes back in for review; Liston rejects it again while the supplier still lacks what sells', async () => {
  const t = await team();
  // Rejected by a reviewer: the hunter fixes it with a note, and it waits for review again.
  const { hunt: one } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'reject', reason: 'low_profit' }, t.reviewer.token);
  const rejected = (await request('GET', `/api/hunting/${one.id}`, undefined, t.hunter.token)).data;
  assert.deepStrictEqual([rejected.stage, rejected.permissions.canEdit], ['rejected', true]);
  assert.strictEqual((await request('GET', `/api/hunting/${one.id}`, undefined, t.lister.token)).status, 404, 'a lister never sees a rejected product');
  const fixed = await request('PATCH', `/api/hunting/${one.id}`, { note: 'Found a cheaper supplier price' }, t.hunter.token);
  assert.strictEqual(fixed.status, 200, JSON.stringify(fixed.data));
  assert.deepStrictEqual([fixed.data.stage, fixed.data.resubmits, fixed.data.rejectReason, fixed.data.hunterNote], ['pending', 1, null, 'Found a cheaper supplier price']);
  assert.deepStrictEqual(fixed.data.timeline.map((e) => e.kind), ['hunted', 'rejected', 'updated', 'resubmitted']);
  // A reviewer can fix one too.
  await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'reject', reason: 'supplier' }, t.reviewer.token);
  assert.strictEqual((await request('PATCH', `/api/hunting/${one.id}`, { sourceUrl: SOURCE_URL }, t.reviewer.token)).data.stage, 'pending');

  // Rejected by Liston: the rejection shows in its history, by Liston.
  aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, variants: [SOURCE.variants[0]], sourceUrl: url });
  try {
    const { hunt: two } = await hunt(t.connectionId, t.hunter.token);
    assert.strictEqual(two.stage, 'rejected');
    const listonEvent = two.timeline.find((e) => e.kind === 'rejected');
    assert.deepStrictEqual([listonEvent.system, listonEvent.by, listonEvent.reason], [true, null, "Supplier doesn't match the eBay listing"]);
    // Saved while the supplier still lacks White (which sells): still rejected, and the hunter isn't told what they just saw.
    const before = (await notificationsRepo.list(t.hunter.id)).length;
    const still = await request('PATCH', `/api/hunting/${two.id}`, { note: 'Tried again' }, t.hunter.token);
    assert.deepStrictEqual([still.data.stage, still.data.autoRejected], ['rejected', true]);
    assert.strictEqual((await notificationsRepo.list(t.hunter.id)).length, before);
    // With a supplier that has it, it goes in for review.
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
    const matched = await request('PATCH', `/api/hunting/${two.id}`, { sourceUrl: 'https://www.aliexpress.com/item/1005009999999999.html' }, t.hunter.token);
    assert.deepStrictEqual([matched.data.stage, matched.data.sourceUrl], ['pending', 'https://www.aliexpress.com/item/1005009999999999.html']);
  } finally {
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
  }
});

test('publishing a draft needs Publish listings access on top of Listings; changes to a live listing need Listings alone', async () => {
  const t = await team();
  const { mock } = require('node:test');
  const published = mock.method(listingService, 'publish', async (id) => ({ listing: { id, status: 'published' } }));
  try {
    const draft = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Earbuds' } });
    const seen = await request('GET', `/api/listings/${draft.id}`, undefined, t.lister.token);
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.data.canPublish, false, 'the editor hides Publish');
    const refused = await request('POST', `/api/listings/${draft.id}/publish`, {}, t.lister.token);
    assert.strictEqual(refused.status, 403);
    assert.match(refused.data.error, /Publish listings/);
    assert.strictEqual(published.mock.callCount(), 0);
    assert.strictEqual((await request('GET', `/api/listings/${draft.id}`, undefined, t.ownerToken)).data.canPublish, true, 'the owner always may');
    // A live listing's working copy: its changes go out with Listings access.
    const liveEdit = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Live' } });
    await pool.query('UPDATE listings SET edit_of_item_id = $2 WHERE id = $1', [liveEdit.id, '998877665544']);
    assert.strictEqual((await request('POST', `/api/listings/${liveEdit.id}/publish`, {}, t.lister.token)).status, 200);
    // Given the access, the lister publishes.
    const ownerToken = t.ownerToken;
    const grant = await request('PUT', `/api/team/members/${t.lister.id}/permissions`, { permissions: [{ connectionId: null, feature: 'listings_publish', allowed: true }] }, ownerToken);
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.data));
    assert.strictEqual((await request('GET', `/api/listings/${draft.id}`, undefined, t.lister.token)).data.canPublish, true);
    assert.strictEqual((await request('POST', `/api/listings/${draft.id}/publish`, {}, t.lister.token)).status, 200);
    assert.strictEqual(published.mock.callCount(), 2);
    // A member with Publish listings on one account only can't publish on another.
    const other = await listingRepository.createDraft({ connectionId: t.otherId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Other' } });
    await request('PUT', `/api/team/members/${t.lister.id}/permissions`, { permissions: [{ connectionId: t.otherId, feature: 'listings_publish', allowed: false }] }, ownerToken);
    assert.strictEqual((await request('POST', `/api/listings/${other.id}/publish`, {}, t.lister.token)).status, 403);
  } finally {
    published.mock.restore();
  }
});

test('the hunter resubmits a rejected product for review; one Liston rejected is checked again first and stays rejected while the supplier lacks what sells', async () => {
  const t = await team();
  const { hunt: one } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${one.id}/decision`, { decision: 'reject', reason: 'low_demand' }, t.reviewer.token);
  const rejected = (await request('GET', `/api/hunting/${one.id}`, undefined, t.hunter.token)).data;
  assert.strictEqual(rejected.permissions.canResubmit, true);
  assert.strictEqual((await request('GET', `/api/hunting/${one.id}`, undefined, t.reviewer.token)).data.permissions.canResubmit, false, "a reviewer fixes it or approves it, the hunter resubmits");
  assert.strictEqual((await request('POST', `/api/hunting/${one.id}/resubmit`, {}, t.reviewer.token)).status, 403);
  const again = await request('POST', `/api/hunting/${one.id}/resubmit`, { note: 'Sales picked up this week' }, t.hunter.token);
  assert.strictEqual(again.status, 200, JSON.stringify(again.data));
  assert.deepStrictEqual([again.data.stage, again.data.resubmits, again.data.rejectReason, again.data.hunterNote], ['pending', 1, null, 'Sales picked up this week']);
  assert.strictEqual(again.data.timeline.at(-1).kind, 'resubmitted');

  aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, variants: [SOURCE.variants[0]], sourceUrl: url });
  try {
    const { hunt: two } = await hunt(t.connectionId, t.hunter.token);
    const still = await request('POST', `/api/hunting/${two.id}/resubmit`, {}, t.hunter.token);
    assert.deepStrictEqual([still.status, still.data.stage, still.data.autoRejected], [200, 'rejected', true]);
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
    assert.strictEqual((await request('POST', `/api/hunting/${two.id}/resubmit`, {}, t.hunter.token)).data.stage, 'pending', 'the supplier has White now');
  } finally {
    aliexpressSource.fetchProduct = async (url) => ({ ...SOURCE, sourceUrl: url });
  }
});

test("Discover's Hunt adds the eBay listing alone, waiting for a supplier; the first supplier link sends it for review, more are kept beside it and one made main; a reviewer changes its eBay link and every figure follows", async () => {
  const t = await team();
  const fromListing = `/api/connections/${t.connectionId}/hunting/from-listing`;
  const listing = (n) => `https://www.ebay.co.uk/itm/5550000000${String(n).padStart(2, '0')}`;
  const supplier = (n) => `https://www.aliexpress.com/item/10050099999${String(n).padStart(2, '0')}.html`;
  const count = async () => (await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.reviewer.token)).data.items.length;

  // Hunted from Discover: the listing read from eBay, no supplier yet, waiting in "needs a supplier".
  const added = await request('POST', fromListing, { competitorUrl: listing(1) }, t.hunter.token);
  assert.strictEqual(added.status, 201, JSON.stringify(added.data));
  const h = added.data.hunt;
  assert.deepStrictEqual([added.data.added, h.stage, h.sources, h.result.source, h.foundByListon], [true, 'sourcing', [], null, true]);
  assert.ok(h.result.demand.soldPerMonth > 0 && h.result.competitor.lowestPrice > 0, 'its demand and price from eBay');
  assert.deepStrictEqual([h.permissions.canEdit, h.permissions.canDecide], [true, false]);
  const list = await request('GET', `/api/connections/${t.connectionId}/hunting?view=sourcing`, undefined, t.hunter.token);
  assert.deepStrictEqual([list.data.counts.sourcing, list.data.items.map((i) => i.id)], [1, [h.id]]);
  // Nothing to decide yet.
  assert.strictEqual((await request('POST', `/api/hunting/${h.id}/decision`, { decision: 'approve' }, t.reviewer.token)).status, 403);
  // Hunted again (a second click, a teammate): not added twice, a link to it; two at once make one.
  const again = await request('POST', fromListing, { competitorUrl: listing(1) }, t.reviewer.token);
  assert.deepStrictEqual([again.status, again.data.added, again.data.alreadyHunted.id, again.data.alreadyHunted.stage], [200, false, h.id, 'sourcing']);
  const before = await count();
  const [one, two] = await Promise.all([listing(2), listing(2)].map((u) => request('POST', fromListing, { competitorUrl: u }, t.hunter.token)));
  assert.deepStrictEqual([one.data.hunt?.id, await count()], [two.data.hunt?.id, before + 1]);

  // Its first supplier link: checked against the listing, its main supplier, in for review.
  const first = await request('POST', `/api/hunting/${h.id}/sources`, { sourceUrl: supplier(1) }, t.hunter.token);
  assert.strictEqual(first.status, 201, JSON.stringify(first.data));
  assert.deepStrictEqual([first.data.stage, first.data.sources.length, first.data.sources[0].main, first.data.sources[0].rating], ['pending', 1, true, 4.8]);
  assert.ok(first.data.headline.profit > 0);
  assert.strictEqual((await request('POST', `/api/hunting/${h.id}/sources`, { sourceUrl: supplier(1) }, t.hunter.token)).status, 400, 'already its main supplier');
  // More suppliers, kept beside it with their own figures (a reviewer adds one too).
  aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, priceText: 'GBP 2.00', variants: SOURCE.variants.map((v) => ({ ...v, priceText: 'GBP 2.00' })), sourceUrl: u });
  const second = await request('POST', `/api/hunting/${h.id}/sources`, { sourceUrl: supplier(2) }, t.reviewer.token);
  assert.strictEqual(second.status, 201, JSON.stringify(second.data));
  const [main, other] = second.data.sources;
  assert.deepStrictEqual([main.main, other.main, other.addedBy.id], [true, false, t.reviewer.id]);
  assert.ok(other.profit > main.profit, 'the cheaper supplier earns more');
  assert.strictEqual(second.data.headline.profit, main.profit, "the product's figures stay the main supplier's");
  // Made the main supplier: its figures become the product's, the old one kept beside it.
  const switched = await request('POST', `/api/hunting/${h.id}/sources/${other.id}/main`, undefined, t.reviewer.token);
  assert.strictEqual(switched.status, 200, JSON.stringify(switched.data));
  assert.deepStrictEqual([switched.data.sources[0].url, switched.data.sourceUrl, switched.data.sources.length], [supplier(2), supplier(2), 2]);
  assert.ok(switched.data.headline.profit > main.profit);
  // Taken off: the other one (the main one can't be).
  const kept = switched.data.sources.find((x) => !x.main);
  const removed = await request('DELETE', `/api/hunting/${h.id}/sources/${kept.id}`, undefined, t.reviewer.token);
  assert.deepStrictEqual([removed.status, removed.data.sources.length], [200, 1]);
  assert.strictEqual((await request('DELETE', `/api/hunting/${h.id}/sources/not-a-uuid`, undefined, t.reviewer.token)).status, 404);
  // Someone who only drafts can't change it (a product waiting for review isn't theirs to see).
  assert.strictEqual((await request('POST', `/api/hunting/${h.id}/sources`, { sourceUrl: supplier(3) }, t.lister.token)).status, 404);

  // A reviewer changes its eBay link while it waits: every supplier checked again against the new listing.
  await request('POST', `/api/hunting/${h.id}/sources`, { sourceUrl: supplier(3) }, t.reviewer.token);
  let reads = 0;
  aliexpressSource.fetchProduct = async (u) => {
    reads += 1;
    return { ...SOURCE, sourceUrl: u };
  };
  ebaySource.fetchListing = async (url) => ({ ...COMPETITOR, variants: COMPETITOR.variants.map((v) => ({ ...v, priceText: 'GBP 19.99' })), priceText: 'GBP 19.99', sourceUrl: url });
  const moved = await request('PATCH', `/api/hunting/${h.id}`, { competitorUrl: listing(3) }, t.reviewer.token);
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.data));
  assert.deepStrictEqual([moved.data.competitorUrl, moved.data.stage, reads], [listing(3), 'pending', 2], 'the main and the other supplier, each read once');
  assert.ok(moved.data.sources.every((x) => x.profit > 5), 'the figures at the new listing\'s price');
  ebaySource.fetchListing = async (url) => ({ ...COMPETITOR, sourceUrl: url });

  // The owner adding a supplier to one hunted from Discover: in for review all the same, never approved as added.
  const byOwner = (await request('POST', fromListing, { competitorUrl: listing(4) }, t.ownerToken)).data.hunt;
  const ownerSupplied = await request('POST', `/api/hunting/${byOwner.id}/sources`, { sourceUrl: supplier(4) }, t.ownerToken);
  assert.deepStrictEqual([ownerSupplied.data.stage, ownerSupplied.data.permissions.canDecide], ['pending', true]);
  // A first supplier that doesn't sell what sells: rejected by Liston, with why.
  aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, variants: [SOURCE.variants[0]], sourceUrl: u });
  const bad = await request('POST', `/api/hunting/${one.data.hunt.id}/sources`, { sourceUrl: supplier(5) }, t.hunter.token);
  assert.deepStrictEqual([bad.data.stage, bad.data.autoRejected], ['rejected', true]);
  aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });

  // Only for people who hunt; an eBay link is needed.
  assert.strictEqual((await request('POST', fromListing, { competitorUrl: listing(9) }, t.nobody.token)).status, 403);
  assert.strictEqual((await request('POST', fromListing, { competitorUrl: 'https://example.com/x' }, t.hunter.token)).status, 400);
});
