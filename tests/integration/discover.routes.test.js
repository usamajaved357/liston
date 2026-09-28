const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { mock } = require('node:test');
require('dotenv').config();

const createApp = require('../../src/app');
const { pool } = require('../../src/db/client');
const config = require('../../src/config');
const connectionService = require('../../src/modules/connections/connection.service');
const browseResearch = require('../../src/modules/ebay/browse-research');
const trading = require('../../src/modules/ebay/api/ebay.trading');
const taxonomy = require('../../src/modules/ebay/api/ebay.taxonomy');
const ebayService = require('../../src/modules/ebay/ebay.service');
const researchService = require('../../src/modules/research/research.service');
const analyticsService = require('../../src/modules/analytics/analytics.service');
const discoverBudget = require('../../src/modules/discover/discover-budget');
const discoverService = require('../../src/modules/discover/discover.service');
const advisor = require('../../src/modules/ai-generation/research-advisor.service');

// Discover end to end against the local database: scans kept a day and
// shared, each listing's sold count read once a day, subcategories ranked
// in the background, watches, and who may use it. eBay is replaced at its
// readers (Browse search, Trading GetItem, Taxonomy).

const app = createApp();
let server;
let baseUrl;
const run = crypto.randomInt(100000, 999999);
const PARENT = `9${run}`;
const CHILDREN = [`8${run}1`, `8${run}2`];
const KEYWORD = `fountain ${run}`;
const calls = { search: 0, sold: 0 };

// A subject's listings: 30 of them, the first ones selling fastest, all from
// different sellers; the keyword ones have "cat water fountain" in their titles.
function listingsFor({ categoryId, q }) {
  const base = categoryId || `7${run}`;
  return Array.from({ length: 30 }, (_, i) => ({
    itemId: `v1|${base}${String(i).padStart(2, '0')}|0`,
    legacyItemId: `${base}${String(i).padStart(2, '0')}`,
    // The last one names a restricted item: Discover hides it and doesn't read it.
    title: i === 29 ? `Pocket knife night light ${i}` : q ? `Cat water fountain ${i % 3 === 0 ? 'stainless steel' : 'led light'} ${i}` : `Night light plug in ${i % 2 ? 'warm white' : 'motion sensor'} ${i}`,
    price: { value: 12 + i, currency: 'GBP' },
    shipping: { cost: 0, free: true },
    deliveryDates: null,
    seller: { username: `seller${i}` },
    location: { country: i % 4 === 0 ? 'CN' : 'GB' },
    categoryId: categoryId || CHILDREN[0],
    createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    hasVariations: i === 0,
  }));
}

test.before(async () => {
  mock.method(browseResearch, 'searchListings', async (input) => {
    calls.search += 1;
    const items = listingsFor(input);
    return {
      total: input.categoryId === CHILDREN[1] ? 90000 : 1200,
      items,
      breakdown: { brands: [], categories: CHILDREN.map((id, i) => ({ id, name: `Child ${i}`, count: 500 - i * 100 })), categoryId: null },
      calls: 1,
    };
  });
  mock.method(trading, 'getItemSales', async (token, itemId) => {
    calls.sold += 1;
    const i = Number(String(itemId).slice(-2));
    // The first listings sell fastest; the second child's hardly sell.
    const slow = String(itemId).startsWith(CHILDREN[1]);
    return {
      itemId,
      sold: slow ? 0 : Math.max(0, 120 - i * 4),
      brand: i % 7 === 0 ? 'Lumineo' : 'Unbranded',
      options: i === 0 ? [{ label: 'Warm white', sold: 20, price: 12 }, { label: 'Motion sensor', sold: 100, price: 14 }] : null,
      categoryId: CHILDREN[0],
      startedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    };
  });
  mock.method(taxonomy, 'getCategoryPath', async (site, id) => {
    if (String(id) === PARENT) return [{ id: PARENT, name: 'Test Lighting' }];
    const at = CHILDREN.indexOf(String(id));
    return at >= 0 ? [{ id: PARENT, name: 'Test Lighting' }, { id: CHILDREN[at], name: `Child ${at}` }] : [];
  });
  mock.method(taxonomy, 'getCategoryChildren', async (site, id) => {
    if (!id) return [{ id: PARENT, name: 'Test Lighting', leaf: false, childCount: 2 }];
    return String(id) === PARENT ? CHILDREN.map((c, i) => ({ id: c, name: `Child ${i}`, leaf: true, childCount: 0 })) : [];
  });
  mock.method(ebayService, 'ensureValidAccessToken', async (credentials) => ({ accessToken: 'x', credentials, credentialsChanged: false }));
  mock.method(researchService, 'accountDelivery', async () => ({ min: 7, max: 9, policyName: 'AliExpress', serviceName: 'Courier' }));
  discoverBudget._reset();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  mock.restoreAll();
  await new Promise((resolve) => server.close(resolve));
  await pool.query(`DELETE FROM discover_scans WHERE subject = ANY($1)`, [[`c:${PARENT}`, ...CHILDREN.map((c) => `c:${c}`), `q:${KEYWORD}`, `q:parrot cage ${run}`, 'q:night light motion sensor']]);
  await pool.query(`DELETE FROM discover_listing_reads WHERE item_id LIKE $1 OR item_id LIKE $2 OR item_id LIKE $3`, [`9${run}%`, `8${run}%`, `7${run}%`]);
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

async function team() {
  const email = `discover-owner-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  await pool.query("UPDATE users SET access_status = 'active' WHERE id = $1", [data.user.id]);
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Discover Store', credentials: { accessToken: 'x' } });
  const member = async (name, features) => {
    const memberEmail = `discover-${name}-${crypto.randomUUID()}@example.com`;
    const added = await request('POST', '/api/team/members', { email: memberEmail, password: 'memberpassword123', name }, data.token);
    await request('PUT', `/api/team/members/${added.data.member.id}/permissions`, { permissions: features.map((feature) => ({ connectionId: null, feature, allowed: true })) }, data.token);
    const login = await request('POST', '/api/auth/login', { email: memberEmail, password: 'memberpassword123' });
    return login.data.token;
  };
  return { ownerId: data.user.id, ownerToken: data.token, connectionId: connection.id, hunter: await member('hunter', ['hunting']), lister: await member('lister', ['listings']) };
}

test('Discover explores a category: its leading listings, their sold counts read once a day, the figures, keywords and subcategories; hunters only', async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  assert.strictEqual((await request('GET', base, undefined, t.lister.token ?? t.lister)).status, 403, 'drafting alone is not hunting');

  const start = await request('GET', base, undefined, t.hunter);
  assert.strictEqual(start.status, 200);
  assert.deepStrictEqual(start.data.topCategories.map((c) => c.id), [PARENT]);
  assert.deepStrictEqual(start.data.account, { min: 7, max: 9, policyName: 'AliExpress', serviceName: 'Courier' });

  assert.strictEqual((await request('GET', `${base}/explore`, undefined, t.hunter)).status, 400);
  // Two opening it at once share the work: one search, each listing read once.
  const [first, twin] = await Promise.all([
    request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter),
    request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter),
  ]);
  assert.strictEqual(first.status, 200, JSON.stringify(first.data));
  assert.strictEqual(twin.data.reads.read, 25);
  assert.strictEqual(calls.search, 1);
  const d = first.data;
  assert.strictEqual(d.subject.name, 'Test Lighting');
  assert.strictEqual(d.figures.total, 1200);
  assert.deepStrictEqual(d.reads, { asked: 25, read: 25, more: true, stopped: false, signInFailed: false, step: 25 });
  assert.strictEqual(calls.sold, 25, 'the first 25 listings read');
  // Fastest first, with its best-selling option first.
  assert.strictEqual(d.listings[0].itemId, `${PARENT}00`);
  assert.deepStrictEqual(d.listings[0].options.map((o) => o.label), ['Motion sensor', 'Warm white']);
  assert.strictEqual(d.listings[0].soldPerMonth, 60);
  assert.ok(d.listings.some((l) => l.overseas), 'where each ships from');
  assert.strictEqual(d.opportunity.score, d.opportunity.parts.reduce((sum, p) => sum + p.points, 0));
  assert.ok(d.keywords.some((k) => k.term === 'motion sensor'), JSON.stringify(d.keywords.map((k) => k.term)));
  assert.ok(d.keywords.every((k) => typeof k.sold === 'number'), 'each keyword with what its listings sold');
  // A listing that would break eBay's rules is hidden, never pointed at, and counted in Before you hunt.
  assert.ok(!d.listings.some((l) => /knife/i.test(l.title)));
  assert.deepStrictEqual([d.compliance.hidden.count, d.compliance.hidden.restricted], [1, 1]);
  assert.ok(d.products.length > 0 && d.products[0].reasons.length >= 3, 'the products here, best to hunt first, with why');
  assert.ok(d.products[0].perMonth > 0 && d.products[0].itemIds.length >= 1);

  // Winners: the best products across everything explored on the site, with a hunter's filters.
  const winners = await request('GET', `${base}/winners?sort=sales&minSales=10`, undefined, t.hunter);
  assert.strictEqual(winners.status, 200, JSON.stringify(winners.data));
  assert.ok(winners.data.pool.subjects >= 1 && winners.data.products.length > 0);
  assert.ok(winners.data.products.every((p) => p.perMonth >= 10 && p.from && p.from.name));
  assert.ok(winners.data.products.some((p) => p.from.name === 'Test Lighting'));
  const priced = await request('GET', `${base}/winners?priceMin=25&brand=unbranded`, undefined, t.hunter);
  assert.ok(priced.data.products.every((p) => p.price.median >= 25 && p.branded === false), JSON.stringify(priced.data.products.map((p) => [p.price.median, p.branded])));
  // The pool is the whole site's (other subjects too), so: nothing 60 days old passes "this month", and the test listings pass "3 months".
  const lately = await request('GET', `${base}/winners?listedWithin=30`, undefined, t.hunter);
  assert.ok(lately.data.products.every((p) => p.newestDays !== null && p.newestDays <= 30 && p.from.name !== 'Test Lighting'));
  assert.ok((await request('GET', `${base}/winners?listedWithin=90`, undefined, t.hunter)).data.products.some((p) => p.from.name === 'Test Lighting'));
  assert.strictEqual((await request('GET', `${base}/winners?sort=sideways`, undefined, t.hunter)).status, 400);
  // A page of Winners at a time: "Load more" asks for more.
  const page = await request('GET', `${base}/winners?limit=1`, undefined, t.hunter);
  assert.strictEqual(page.data.products.length, 1);
  assert.ok(page.data.matched >= 1);
  // The site's keywords: the terms of the titles that sell, best-selling first, each saying where it sells most.
  const kw = await request('GET', `${base}/keywords`, undefined, t.hunter);
  assert.strictEqual(kw.status, 200, JSON.stringify(kw.data));
  const sensor = kw.data.keywords.find((k) => k.term === 'motion sensor');
  assert.ok(sensor, JSON.stringify(kw.data.keywords.map((k) => k.term)));
  assert.ok(sensor.perMonth > 0 && sensor.from.name === 'Test Lighting' && sensor.subjects >= 1);
  const sales = kw.data.keywords.map((k) => k.perMonth);
  assert.deepStrictEqual(sales, [...sales].sort((a, b) => b - a));
  // Nothing restricted on eBay is ever pointed at.
  assert.ok(!kw.data.keywords.some((k) => /knife/i.test(k.term)));
  assert.ok((await request('GET', `${base}/keywords?q=sensor&limit=5`, undefined, t.hunter)).data.keywords.every((k) => k.term.includes('sensor')));
  assert.strictEqual((await request('GET', `${base}/keywords?sort=sideways`, undefined, t.hunter)).status, 400);
  // The Categories tab's best sellers: every category explored on the site, by what it sells a month.
  const bestSelling = (await request('GET', base, undefined, t.hunter)).data.bestCategories;
  const lighting = bestSelling.find((c) => c.id === PARENT);
  assert.ok(lighting, JSON.stringify(bestSelling.map((c) => c.name)));
  assert.deepStrictEqual([lighting.name, lighting.path], ['Test Lighting', []]);
  assert.ok(lighting.monthlySales > 0 && lighting.selling > 0 && lighting.products > 0 && lighting.total === 1200);
  assert.ok(Number.isInteger(lighting.rising) && lighting.rising <= lighting.products, 'its new or rising products: trending');
  assert.ok(lighting.keyword && !/knife/i.test(lighting.keyword));
  const monthly = bestSelling.map((c) => c.monthlySales);
  assert.deepStrictEqual(monthly, [...monthly].sort((a, b) => b - a), 'best-selling first');
  // Subcategories, busiest first, not ranked yet.
  assert.deepStrictEqual(d.children.map((c) => [c.id, c.listings, c.scanned]), [[CHILDREN[0], 500, null], [CHILDREN[1], 400, null]]);

  // Opening it again spends nothing: the scan and today's readings are kept.
  const searches = calls.search;
  await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter);
  assert.deepStrictEqual([calls.search, calls.sold], [searches, 25]);
  // Read more: the next listings only.
  const more = await request('GET', `${base}/explore?categoryId=${PARENT}&reads=50`, undefined, t.hunter);
  assert.deepStrictEqual([more.data.reads.read, calls.sold], [29, 29], 'every listing but the hidden one');

  // Ranking the subcategories answers at once and runs on; explore shows how far it has got.
  const rank = await request('POST', `${base}/rank`, { categoryId: PARENT }, t.hunter);
  assert.strictEqual(rank.status, 202);
  assert.strictEqual(rank.data.total, 2);
  let ranked;
  for (let i = 0; i < 50; i += 1) {
    ranked = (await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter)).data;
    if (!ranked.ranking) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.strictEqual(ranked.ranking, null);
  const [best, worst] = ranked.children;
  assert.deepStrictEqual([best.id, worst.id], CHILDREN, 'the one that sells ranks first');
  assert.ok(best.scanned.score > worst.scanned.score);
  assert.strictEqual(worst.scanned.selling, 0);
  assert.ok(best.scanned.monthlySales > 0 && Array.isArray(best.keywords), 'each with its sales a month and its keywords');
});

test('a keyword explores the same way, reads stop when the day’s share is used, and the team watches categories and keywords', async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;

  // The day's reads used up: the keyword is scanned but nothing is read.
  const limit = config.discover.tradingDailyCalls;
  config.discover.tradingDailyCalls = 0;
  const before = calls.sold;
  try {
    const empty = await request('GET', `${base}/explore?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual([empty.data.reads.read, empty.data.reads.stopped, calls.sold], [0, true, before]);
    assert.strictEqual(empty.data.opportunity.parts[0].value, 'Not read yet');
  } finally {
    config.discover.tradingDailyCalls = limit;
  }
  const kw = await request('GET', `${base}/explore?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter);
  assert.strictEqual(kw.data.reads.read, 29, 'a keyword reads more on opening (every listing here but the hidden one)');
  assert.strictEqual(kw.data.subject.kind, 'keyword');
  assert.ok(!kw.data.keywords.some((k) => k.term === 'fountain'), "the keyword's own words aren't news");

  // Before hunting: the checks come with it, and the AI's brand/VeRO reading on request (kept a day, shared).
  assert.strictEqual(kw.data.compliance.level, 'clear');
  assert.ok(kw.data.price && kw.data.price.maxCost > 0, 'the most a supplier may cost at the target return');
  const kept = mock.method(advisor, 'keptAdvice', async () => null);
  const asked = mock.method(advisor, 'advise', async () => ({ brandRisk: { level: 'high', brands: ['Catit'], reason: 'Catit enforces VeRO.' }, safetyRisk: { level: 'none', reason: 'Fine.' }, summary: 'x', title: 't', keywords: [] }));
  const reviewed = await request('GET', `${base}/review?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter);
  assert.strictEqual(reviewed.status, 200);
  assert.deepStrictEqual([reviewed.data.checked, reviewed.data.compliance.level, reviewed.data.compliance.ai.brand.brands], [true, 'risky', ['Catit']]);
  kept.mock.restore();
  asked.mock.restore();

  // The nightly shared refresh reads what was opened lately again, once its scan is a day old.
  await pool.query(`UPDATE discover_scans SET taken_at = now() - interval '2 days' WHERE subject = $1`, [`q:${KEYWORD}`]);
  const searchesBefore = calls.search;
  assert.ok((await discoverService.refreshRecent({ limit: 50 })) >= 1);
  assert.ok(calls.search > searchesBefore, 'scanned again');
  const { rows: fresh } = await pool.query(`SELECT taken_at > now() - interval '1 minute' AS fresh, opened_connection_id FROM discover_scans WHERE subject = $1`, [`q:${KEYWORD}`]);
  assert.deepStrictEqual([fresh[0].fresh, fresh[0].opened_connection_id], [true, t.connectionId]);

  const added = await request('POST', `${base}/watches`, { q: KEYWORD }, t.hunter);
  assert.strictEqual(added.status, 201);
  const cat = await request('POST', `${base}/watches`, { categoryId: PARENT }, t.hunter);
  assert.strictEqual(cat.data.label, 'Test Lighting');
  const list = await request('GET', `${base}/watches`, undefined, t.ownerToken);
  assert.deepStrictEqual(list.data.items.map((w) => w.kind).sort(), ['category', 'keyword']);
  const watchedKeyword = list.data.items.find((w) => w.kind === 'keyword');
  assert.strictEqual(watchedKeyword.figures.read, 29);
  assert.strictEqual(watchedKeyword.createdBy, 'hunter');
  assert.strictEqual((await request('GET', `${base}/explore?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter)).data.watch.id, added.data.id);
  assert.strictEqual((await request('DELETE', `${base}/watches/${added.data.id}`, undefined, t.hunter)).status, 204);
  assert.strictEqual((await request('DELETE', `${base}/watches/${added.data.id}`, undefined, t.hunter)).status, 404);
});

test("your keywords come from the account's own traffic, for whoever sees its analytics", async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  mock.method(analyticsService, 'getAnalytics', async () => ({
    data: {
      status: 'ok',
      range: { key: '30d' },
      listings: [
        { title: 'Night light motion sensor plug', impressions: 900, views: 40, sold: 6 },
        { title: 'Night light motion sensor battery', impressions: 500, views: 20, sold: 2 },
      ],
    },
  }));
  assert.strictEqual((await request('GET', `${base}/your-keywords`, undefined, t.hunter)).status, 403, 'hunting alone does not show the traffic');
  const mine = await request('GET', `${base}/your-keywords?range=30d`, undefined, t.ownerToken);
  assert.strictEqual(mine.status, 200);
  const top = mine.data.keywords.find((k) => k.term === 'night light motion');
  assert.deepStrictEqual([top.listings, top.impressions, top.sold], [2, 1400, 8]);

  // A keyword searched in Discover shows your own traffic and sales on it, to whoever sees the analytics.
  const searched = await request('GET', `${base}/explore?q=${encodeURIComponent(`parrot cage ${run}`)}`, undefined, t.ownerToken);
  assert.strictEqual(searched.status, 200);
  assert.strictEqual(searched.data.yourTraffic.listings, 0, 'none of your listings has it: a gap');
  const known = await request('GET', `${base}/explore?q=${encodeURIComponent('night light motion sensor')}`, undefined, t.ownerToken);
  assert.deepStrictEqual([known.data.yourTraffic.listings, known.data.yourTraffic.impressions, known.data.yourTraffic.sold, known.data.yourTraffic.conversion], [2, 1400, 8, 13.33]);
  assert.ok(known.data.charts.priceBands.length > 0 && known.data.charts.demandCurve.length === 25);
  const hunterView = await request('GET', `${base}/explore?q=${encodeURIComponent('night light motion sensor')}`, undefined, t.hunter);
  assert.strictEqual(hunterView.data.yourTraffic, null, "hunting alone doesn't show the account's traffic");

  // The search box suggests categories for what's typed.
  mock.method(taxonomy, 'searchCategories', async () => [{ id: '123', name: 'Night Lights', leaf: true, path: ['Home', 'Lighting', 'Night Lights'] }]);
  const suggested = await request('GET', `${base}/suggest?q=night`, undefined, t.hunter);
  assert.deepStrictEqual(suggested.data.categories, [{ id: '123', name: 'Night Lights', path: ['Home', 'Lighting'], leaf: true }]);
});

// A hunted product for `ownerId` on `connectionId`, from the competitor listing `itemId`.
async function huntedFixture(ownerId, connectionId, itemId, status = 'pending') {
  const huntingRepository = require('../../src/modules/hunting/hunting.repository');
  return huntingRepository.insert({
    ownerId,
    connectionId,
    hunterId: ownerId,
    status,
    competitorUrl: `https://www.ebay.co.uk/itm/${itemId}`,
    competitorItemId: String(itemId),
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567890.html',
    sourceProductId: '1005001234567890',
    title: 'Discover fixture',
    imageUrl: null,
    currency: 'GBP',
    checkResult: { summary: { verdict: 'strong', headline: {} }, options: [] },
    headlineProfit: 3,
    headlineRoi: 60,
    soldPerMonth: 10,
  });
}

async function otherOwner() {
  const email = `discover-other-${crypto.randomUUID()}@example.com`;
  const { data } = await request('POST', '/api/auth/signup', { email, password: 'testpassword123' });
  const connection = await connectionService.createConnection(data.user.id, { platformKey: 'ebay', label: 'Other Store', credentials: { accessToken: 'x' } });
  return { ownerId: data.user.id, connectionId: connection.id };
}

test("Discover says what the owner already has, how many other Liston sellers hunt a product (never who), and keeps each eBay site's market to itself", async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  const first = await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter);
  assert.strictEqual(first.status, 200, JSON.stringify(first.data));
  // The fixture's listings group into one product: it's both the owner's (hunted) and crowded.
  const mineProduct = first.data.products[0];
  const crowdedProduct = mineProduct;
  assert.ok(mineProduct, 'a product to mark');
  assert.ok(first.data.products.every((p) => p.mine === null && p.crowd === 0), 'nothing yours or crowded yet');

  // The owner hunted it; two other teams did too (a third team long ago doesn't count).
  await huntedFixture(t.ownerId, t.connectionId, mineProduct.itemIds[0], 'rejected');
  const others = [await otherOwner(), await otherOwner(), await otherOwner()];
  for (const o of others) await huntedFixture(o.ownerId, o.connectionId, crowdedProduct.itemIds[0]);
  await pool.query(`UPDATE hunted_products SET created_at = now() - interval '40 days' WHERE owner_user_id = $1`, [others[2].ownerId]);
  discoverService.forgetOwner(t.ownerId);

  const again = (await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter)).data;
  const byKey = new Map(again.products.map((p) => [p.key, p]));
  assert.deepStrictEqual(byKey.get(mineProduct.key).mine, { kind: 'rejected', text: 'Rejected before on Discover Store' });
  const crowded = byKey.get(crowdedProduct.key);
  assert.strictEqual(crowded.crowd, 2);
  assert.ok(crowded.reasons.some((r) => r.good === false && /Hunted by 2 other Liston sellers/.test(r.text)));
  assert.strictEqual(crowded.score, crowdedProduct.score - 4, 'a few points off, never who');
  assert.ok(!JSON.stringify(crowded).includes(others[0].ownerId));

  // Winners: marked by default, hidden when asked.
  const shownAll = await request('GET', `${base}/winners?mine=show&limit=300`, undefined, t.hunter);
  assert.strictEqual(shownAll.data.products.find((p) => p.key === mineProduct.key)?.mine?.kind, 'rejected');
  const hidden = await request('GET', `${base}/winners?mine=hide&limit=300`, undefined, t.hunter);
  assert.ok(!hidden.data.products.some((p) => p.key === mineProduct.key));
  assert.ok(hidden.data.mineHidden >= 1);

  // The same owner's eBay US account sees eBay US's market only: nothing explored on eBay UK.
  const us = await connectionService.createConnection(t.ownerId, { platformKey: 'ebay', label: 'US Store', credentials: { accessToken: 'x' }, settings: { ebay: { marketplaceId: 'EBAY_US' } } }, { planChecked: true });
  const usWinners = await request('GET', `/api/connections/${us.id}/discover/winners?limit=300`, undefined, t.ownerToken);
  assert.strictEqual(usWinners.status, 200, JSON.stringify(usWinners.data));
  assert.strictEqual(usWinners.data.market.id, 'EBAY_US');
  assert.ok(!usWinners.data.products.some((p) => p.from.name === 'Test Lighting'));
  const usKeywords = await request('GET', `/api/connections/${us.id}/discover/keywords?limit=400`, undefined, t.ownerToken);
  assert.ok(!usKeywords.data.keywords.some((k) => k.from?.name === 'Test Lighting'));
  assert.strictEqual(usKeywords.data.market.id, 'EBAY_US');
});

test("Discover keeps products at risk of a takedown out by default: one like a draft eBay refused the owner for, or their team rejected for brand risk; shown marked when asked", async () => {
  const listingRepository = require('../../src/modules/listings/listing.repository');
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  const first = (await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter)).data;
  const product = first.products[0];
  assert.ok(product && first.products.every((p) => p.risk === null), 'nothing at risk yet');

  // eBay refused one of the owner's drafts for this product, for VeRO.
  const draft = await listingRepository.createDraft({ connectionId: t.connectionId, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { title: product.name } });
  await pool.query("UPDATE listings SET error_message = $2 WHERE id = $1", [draft.id, 'eBay: This listing may be in violation of the VeRO programme (intellectual property).']);
  discoverService.forgetOwner(t.ownerId);

  const again = (await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter)).data;
  const risky = again.products.find((p) => p.key === product.key);
  assert.deepStrictEqual([risky.risk.kind, risky.risk.level], ['refused', 'bad']);
  assert.match(risky.risk.text, /brand or intellectual-property/);
  // Winners hides it unless asked, and says how many it hid.
  const safe = (await request('GET', `${base}/winners?limit=300`, undefined, t.hunter)).data;
  assert.ok(!safe.products.some((p) => p.key === product.key));
  assert.ok(safe.riskHidden >= 1);
  const all = (await request('GET', `${base}/winners?safety=all&limit=300`, undefined, t.hunter)).data;
  assert.strictEqual(all.products.find((p) => p.key === product.key)?.risk?.kind, 'refused');
  assert.strictEqual((await request('GET', `${base}/winners?safety=maybe`, undefined, t.hunter)).status, 400);
});
