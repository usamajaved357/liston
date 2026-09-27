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
  // Once decided, the hunter can no longer withdraw it.
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
  assert.deepStrictEqual(seen.data.views, ['approved', 'listed']);
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

  const figures = await request('GET', `/api/connections/${t.connectionId}/hunting/team?range=7d`, undefined, t.reviewer.token);
  assert.strictEqual(figures.status, 200);
  const hunterRow = figures.data.people.find((p) => p.person.id === t.hunter.id);
  assert.deepStrictEqual({ hunted: hunterRow.hunter.hunted, approved: hunterRow.hunter.approved, waiting: hunterRow.hunter.waiting, listed: hunterRow.hunter.listed }, { hunted: 2, approved: 1, waiting: 1, listed: 1 });
  assert.strictEqual(hunterRow.sales.sales, 25.98);
  const reviewerRow = figures.data.people.find((p) => p.person.id === t.reviewer.id);
  assert.strictEqual(reviewerRow.reviewer.approved, 1);
  assert.strictEqual((await request('GET', `/api/connections/${t.connectionId}/hunting/team`, undefined, t.hunter.token)).status, 403);

  const page = await request('GET', `/api/team/members/${t.hunter.id}/overview?range=7d`, undefined, t.ownerToken);
  assert.strictEqual(page.data.totals.hunted, 2);
  assert.strictEqual(page.data.hunting.hunter.approved, 1);
  assert.strictEqual(page.data.hunting.sales[0].sales, 25.98);
});

test('the hunter withdraws a product still waiting; the list and counts follow', async () => {
  const t = await team();
  const { hunt: added } = await hunt(t.connectionId, t.hunter.token);
  const before = await request('GET', `/api/connections/${t.connectionId}/hunting?view=review`, undefined, t.reviewer.token);
  assert.strictEqual(before.data.counts.review, 1);
  assert.strictEqual((await request('DELETE', `/api/hunting/${added.id}`, undefined, t.reviewer.token)).status, 403);
  assert.strictEqual((await request('DELETE', `/api/hunting/${added.id}`, undefined, t.hunter.token)).status, 204);
  const after = await request('GET', `/api/connections/${t.connectionId}/hunting?view=review`, undefined, t.reviewer.token);
  assert.strictEqual(after.data.counts.review, 0);
});
