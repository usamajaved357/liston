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

test('the tabs: All, Waiting for review, Approved (drafted ones too), Rejected, and My hunts for each person', async () => {
  const t = await team();
  const { hunt: mine } = await hunt(t.connectionId, t.hunter.token);
  await hunt(t.connectionId, t.ownerToken); // the owner's: approved as added
  const list = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.hunter.token);
  assert.deepStrictEqual(list.data.views, ['all', 'review', 'approved', 'rejected', 'mine']);
  assert.strictEqual(list.data.view, 'mine');
  assert.deepStrictEqual(list.data.items.map((h) => h.id), [mine.id]);
  assert.strictEqual(list.data.counts.mine, 1);
  assert.strictEqual(list.data.counts.all, 2);
  // Approved holds a product once drafted too.
  await request('POST', `/api/hunting/${mine.id}/decision`, { decision: 'approve' }, t.reviewer.token);
  const draft = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: 'Earbuds' } });
  await huntingRepository.linkDraft(mine.id, draft.id, t.lister.id);
  const approved = await request('GET', `/api/connections/${t.connectionId}/hunting?view=approved`, undefined, t.reviewer.token);
  assert.strictEqual(approved.data.counts.approved, 2);
  assert.ok(approved.data.items.some((h) => h.id === mine.id && h.stage === 'drafted'));
  // The reviewer's own My hunts is empty; a sent-back tab is gone.
  const reviewerMine = await request('GET', `/api/connections/${t.connectionId}/hunting?view=mine`, undefined, t.reviewer.token);
  assert.strictEqual(reviewerMine.data.items.length, 0);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting?view=sent_back`, undefined, t.reviewer.token)).data.view, 'all');
  // Search finds a product by its eBay item number, the hunter's name or a note, not only its title.
  const search = async (q) => (await request('GET', `/api/connections/${t.connectionId}/hunting?view=all&q=${encodeURIComponent(q)}`, undefined, t.reviewer.token)).data.items.map((h) => h.id);
  assert.ok((await search('123456789012')).includes(mine.id));
  assert.deepStrictEqual(await search('hunter'), [mine.id]);
  assert.deepStrictEqual(await search('no such thing anywhere'), []);
  // The Overview's Hunted / Approved / Rejected for the dates, and what waits now.
  const hour = new Date(Date.now() - 3600 * 1000);
  const soon = new Date(Date.now() + 60 * 1000);
  const { hunt: third } = await hunt(t.connectionId, t.hunter.token);
  await request('POST', `/api/hunting/${third.id}/decision`, { decision: 'reject', reason: 'low_profit' }, t.reviewer.token);
  await hunt(t.connectionId, t.hunter.token);
  assert.deepStrictEqual(await huntingRepository.countForOverview(t.connectionId, hour, soon), { hunted: 4, approved: 2, rejected: 1, reviewing: 1 });
  assert.deepStrictEqual(await huntingRepository.countForOverview(t.connectionId, new Date(Date.now() - 7200 * 1000), hour), { hunted: 0, approved: 0, rejected: 0, reviewing: 1 });
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
  assert.deepStrictEqual(seen.data.views, ['approved']);
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
