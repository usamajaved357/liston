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

test('the tabs: All, Waiting for review, Approved, Drafted, Listed, Rejected, and My hunts for each person; a drafted product stays on the page', async () => {
  const t = await team();
  const { hunt: mine } = await hunt(t.connectionId, t.hunter.token);
  await hunt(t.connectionId, t.ownerToken); // the owner's: approved as added
  const list = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.hunter.token);
  assert.deepStrictEqual(list.data.views, ['all', 'review', 'approved', 'drafted', 'listed', 'rejected', 'mine']);
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

test("Discover's Hunt finds the supplier itself: the best AliExpress product rated 4+ at the target return is added for review; otherwise nothing is added and it says why", async () => {
  const t = await team();
  const url = `/api/connections/${t.connectionId}/hunting/auto-source`;
  const real = aliexpressSource.findSuppliers;
  const realShipping = aliexpressSource.fetchShipping;
  // Discover's Hunt adds a listing to an account once: each case hunts a listing of its own.
  const listing = (n) => `https://www.ebay.co.uk/itm/5550000000${String(n).padStart(2, '0')}`;
  const alike = (id, via, over = {}) => ({ productId: id, title: 'TWS Wireless Earbuds Bluetooth 5.3 Headphones', imageUrl: null, price: 3, rating: 4.7, orders: '1000+', url: `https://www.aliexpress.com/item/100500${id}.html`, via, ...over });
  // The photos are compared by the AI (tested in unit/product-match): here it says whatever `looks` says.
  const productMatch = require('../../src/modules/ai-generation/product-match.service');
  const realLooks = productMatch.sameAsListing;
  const realFetchPhoto = aliexpressSource.fetchPhoto;
  const realReadPhoto = aliexpressSource.readPhoto;
  let looks = () => ({ same: true, why: 'Same earbuds and case' });
  const compared = [];
  const compare = async ({ candidates }) => {
    compared.push(candidates.map((c) => c.title));
    return candidates.map((c) => looks(c));
  };
  productMatch.sameAsListing = compare;
  aliexpressSource.fetchPhoto = async () => Buffer.from('photo');
  try {
    // Nothing that looks like it: nothing checked, nothing added.
    // (And the photo couldn't be fetched: it says it searched by the title only.)
    aliexpressSource.findSuppliers = async () => ({ image: [], text: [alike('0000001', 'text', { title: 'Silicone phone case' })], errors: ["Image search: the eBay photo couldn't be read (timed out)"] });
    const none = await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.strictEqual(none.status, 200, JSON.stringify(none.data));
    assert.deepStrictEqual([none.data.found, /none looks like the same product/.test(none.data.reason)], [false, true]);
    assert.match(none.data.note, /Photo search wasn't available just now/);
    assert.strictEqual(none.data.tried[0].ok, false);

    // Alike, but rated under 4 stars on AliExpress: checked, turned down with why.
    aliexpressSource.findSuppliers = async () => ({ image: [alike('0000002', 'image')], text: [], errors: [] });
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, supplier: { ...SOURCE.supplier, rating: 3.6 }, sourceUrl: u });
    const low = await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.deepStrictEqual([low.data.found, low.data.tried[0].why], [false, 'Rated 3.6 stars, under 4']);
    assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.hunter.token)).data.items.length, 0, 'nothing added');

    // Rated 4.8 and earning the target, but postage isn't free: turned down.
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });
    aliexpressSource.findSuppliers = async () => ({ image: [alike('0000003', 'image')], text: [alike('0000004', 'text')], errors: [] });
    const paid = await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.deepStrictEqual([paid.data.found, paid.data.tried[0].why], [false, "Postage isn't free (0.99 a parcel)"]);

    // Free over £8 (AliExpress's Choice): found. From the add form, kept as a check for the hunter to add.
    aliexpressSource.fetchShipping = async () => ({ cost: 0.99, freeOver: 8, minDays: 5, maxDays: 8, company: 'AliExpress Standard', tracking: true, currency: 'GBP' });

    // The photos are only compared for ones that pass everything else, best first: both here, and
    // neither is the same product, so nothing is offered.
    looks = () => ({ same: false, why: 'Over-ear headphones, not earbuds' });
    compared.length = 0;
    const unlike = await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.strictEqual(unlike.status, 200, JSON.stringify(unlike.data));
    assert.deepStrictEqual([unlike.data.found, compared.length], [false, 2]);
    assert.match(unlike.data.reason, /is the same product in the photos/);
    assert.deepStrictEqual(unlike.data.tried.map((r) => r.why), ['Not the same product in the photos: Over-ear headphones, not earbuds', 'Not the same product in the photos: Over-ear headphones, not earbuds']);
    // One failing the other checks is never compared: rated under 4, it isn't asked about.
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, supplier: { ...SOURCE.supplier, rating: 3.6 }, sourceUrl: u });
    compared.length = 0;
    await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.strictEqual(compared.length, 0, 'no AI call for a supplier that fails anyway');
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });
    // The AI can't answer just now: nothing is picked unseen.
    productMatch.sameAsListing = async () => {
      throw new Error("the photos couldn't be compared (overloaded)");
    };
    const down = await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.hunter.token);
    assert.strictEqual(down.data.found, false);
    assert.match(down.data.reason, /couldn't compare the supplier's photos with the eBay listing's just now/);
    // Two of the listing's photos are the supplier's own: the same product, no AI asked.
    const sharp = require('sharp');
    const picture = (shapes) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fafafa"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient>` +
            `<radialGradient id="r"><stop offset="0" stop-color="#eee"/><stop offset="1" stop-color="#222"/></radialGradient></defs><rect width="400" height="400" fill="url(#g)"/>${shapes}</svg>`
        )
      )
        .png()
        .toBuffer();
    const pictures = {
      'https://i.ebayimg.com/1/s-l500.jpg': await picture('<circle cx="140" cy="200" r="90" fill="url(#r)"/><rect x="250" y="80" width="90" height="240" fill="url(#r)"/>'),
      'https://i.ebayimg.com/2/s-l500.jpg': await picture('<rect x="60" y="60" width="120" height="120" fill="url(#r)"/><circle cx="280" cy="290" r="70" fill="url(#r)"/>'),
    };
    COMPETITOR.referenceImages = Object.keys(pictures);
    aliexpressSource.readPhoto = async (u) => pictures[u];
    // The supplier's copies: smaller, as JPEGs.
    const copies = await Promise.all(Object.values(pictures).map((b) => sharp(b).resize(300).jpeg({ quality: 70 }).toBuffer()));
    const theirs = { 'https://ae01.alicdn.com/1.jpg': copies[0], 'https://ae01.alicdn.com/2.jpg': copies[1] };
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, imageUrls: Object.keys(theirs), sourceUrl: u });
    aliexpressSource.fetchPhoto = async (u) => theirs[u] || null;
    productMatch.sameAsListing = compare;
    compared.length = 0;
    const own = await request('POST', url, { competitorUrl: COMPETITOR_URL, add: false }, t.hunter.token);
    assert.deepStrictEqual([own.data.found, compared.length], [true, 0]);
    COMPETITOR.referenceImages = [];
    aliexpressSource.readPhoto = realReadPhoto;
    aliexpressSource.fetchPhoto = async () => Buffer.from('photo');
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });
    looks = () => ({ same: true, why: 'Same earbuds and case' });
    const kept = await request('POST', url, { competitorUrl: COMPETITOR_URL, add: false }, t.hunter.token);
    assert.strictEqual(kept.status, 200, JSON.stringify(kept.data));
    assert.deepStrictEqual([kept.data.found, typeof kept.data.checkId, kept.data.autoApproves], [true, 'string', false]);
    assert.match(kept.data.sourceUrl, /\/item\/1005000000003\.html$/, 'alike on every figure: the photo match');
    assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.hunter.token)).data.items.length, 0, 'not added yet');
    const fromForm = await request('POST', `/api/connections/${t.connectionId}/hunting`, { checkId: kept.data.checkId, note: 'Liston found it' }, t.hunter.token);
    assert.deepStrictEqual([fromForm.status, fromForm.data.stage, fromForm.data.sourceUrl], [201, 'pending', kept.data.sourceUrl]);

    // From Discover: added for review at once, the hunter's, with a note saying Liston found it.
    const found = await request('POST', url, { competitorUrl: listing(1) }, t.hunter.token);
    assert.strictEqual(found.status, 201, JSON.stringify(found.data));
    assert.strictEqual(found.data.found, true);
    assert.deepStrictEqual([found.data.hunt.stage, found.data.hunt.hunter.id], ['pending', t.hunter.id]);
    assert.match(found.data.hunt.hunterNote, /Supplier found by Liston \(AliExpress image search\): rated 4.8 stars/);
    assert.strictEqual(found.data.tried.length, 2);
    assert.ok(found.data.supplier.roi >= 60);
    assert.strictEqual(found.data.hunt.foundByListon, true);
    // Hunting the same listing again (a second click, a retried request, a teammate): nothing added, a link to it.
    const count = async () => (await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.hunter.token)).data.items.length;
    const listed = await count();
    const again = await request('POST', url, { competitorUrl: listing(1) }, t.reviewer.token);
    assert.strictEqual(again.status, 200, JSON.stringify(again.data));
    assert.deepStrictEqual([again.data.found, again.data.alreadyHunted.id, again.data.alreadyHunted.stage, again.data.alreadyHunted.hunter.id], [false, found.data.hunt.id, 'pending', t.hunter.id]);
    assert.strictEqual(await count(), listed);
    // Two at the same moment: one search, one product, both told of it.
    const [one, two] = await Promise.all([listing(6), listing(6)].map((u) => request('POST', url, { competitorUrl: u }, t.hunter.token)));
    assert.deepStrictEqual([one.data.hunt?.id, await count()], [two.data.hunt?.id, listed + 1]);

    // Never approved as added, the owner's included: it waits until someone opens it and approves it.
    const byOwner = await request('POST', url, { competitorUrl: listing(2) }, t.ownerToken);
    assert.strictEqual(byOwner.status, 201, JSON.stringify(byOwner.data));
    assert.deepStrictEqual([byOwner.data.hunt.stage, byOwner.data.hunt.autoApproved, byOwner.data.hunt.foundByListon, byOwner.data.hunt.permissions.canDecide], ['pending', false, true, true]);
    assert.strictEqual((await request('POST', url, { competitorUrl: COMPETITOR_URL, add: false }, t.ownerToken)).data.autoApproves, false, 'the add form adds it for review too');
    const ownerApproves = await request('POST', `/api/hunting/${byOwner.data.hunt.id}/decision`, { decision: 'approve' }, t.ownerToken);
    assert.deepStrictEqual([ownerApproves.status, ownerApproves.data.stage], [200, 'approved']);
    // A reviewer's Liston find waits too, and they may decide on it (Liston found it, not they).
    const byReviewer = await request('POST', url, { competitorUrl: listing(3) }, t.reviewer.token);
    assert.deepStrictEqual([byReviewer.data.hunt.stage, byReviewer.data.hunt.permissions.canDecide], ['pending', true]);
    const reviewerRejects = await request('POST', `/api/hunting/${byReviewer.data.hunt.id}/decision`, { decision: 'reject', reason: 'low_demand' }, t.reviewer.token);
    assert.deepStrictEqual([reviewerRejects.status, reviewerRejects.data.stage], [200, 'rejected']);

    // Matches and earns, but under the account's target return: shown with its figures, never added
    // by itself; the hunter adds it with a click. A loss is still no match.
    const target = Math.ceil(found.data.supplier.roi) + 20;
    await pool.query(
      `UPDATE connections SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('pricing', COALESCE(settings->'pricing', '{}'::jsonb) || jsonb_build_object('targetRoiPercent', $2::int)) WHERE id = $1`,
      [t.connectionId, target]
    );
    const before = (await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.hunter.token)).data.items.length;
    const under = await request('POST', url, { competitorUrl: listing(4) }, t.hunter.token);
    assert.strictEqual(under.status, 200, JSON.stringify(under.data));
    assert.deepStrictEqual([under.data.found, under.data.belowTarget, under.data.targetRoi, typeof under.data.checkId, under.data.hunt], [true, true, target, 'string', undefined]);
    assert.ok(under.data.supplier.profit > 0 && under.data.supplier.roi < target);
    assert.deepStrictEqual([under.data.supplier.ok, under.data.supplier.belowTarget], [false, true]);
    assert.match(under.data.addNote, new RegExp(`under the ${target}% target`));
    assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting?view=all`, undefined, t.hunter.token)).data.items.length, before, 'not added by itself');
    const addedUnder = await request('POST', `/api/connections/${t.connectionId}/hunting`, { checkId: under.data.checkId, note: under.data.addNote }, t.hunter.token);
    assert.deepStrictEqual([addedUnder.status, addedUnder.data.stage], [201, 'pending']);
    // Dearer than the eBay price: a loss, not a match.
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, variants: SOURCE.variants.map((v) => ({ ...v, priceText: 'GBP 99.00' })), sourceUrl: u });
    const loss = await request('POST', url, { competitorUrl: listing(5) }, t.hunter.token);
    assert.deepStrictEqual([loss.data.found, loss.data.tried[0].belowTarget, loss.data.tried[0].why], [false, false, "Loses money at the competitor's price"]);
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });

    // Only for people who hunt; an eBay link is needed.
    assert.strictEqual((await request('POST', url, { competitorUrl: COMPETITOR_URL }, t.nobody.token)).status, 403);
    assert.strictEqual((await request('POST', url, { competitorUrl: 'https://example.com/x' }, t.hunter.token)).status, 400);
  } finally {
    COMPETITOR.referenceImages = [];
    productMatch.sameAsListing = realLooks;
    aliexpressSource.fetchPhoto = realFetchPhoto;
    aliexpressSource.readPhoto = realReadPhoto;
    aliexpressSource.findSuppliers = real;
    aliexpressSource.fetchShipping = realShipping;
    aliexpressSource.fetchProduct = async (u) => ({ ...SOURCE, sourceUrl: u });
  }
});
