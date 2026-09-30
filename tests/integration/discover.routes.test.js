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
const browseUsage = require('../../src/modules/ebay/browse-usage');
const advisor = require('../../src/modules/ai-generation/research-advisor.service');

// Discover end to end against the local database: categories and keywords
// only, scans kept a day and shared, each listing's sold count read once a
// day through Browse, subcategories ranked in the background, watches, the
// day's and each account's share of reads, and who may use it. eBay is
// replaced at its readers (Browse search, Browse item reads, Taxonomy);
// Trading is watched, to prove Discover never calls it.

const app = createApp();
let server;
let baseUrl;
const run = crypto.randomInt(100000, 999999);
const PARENT = `9${run}`;
const CHILDREN = [`8${run}1`, `8${run}2`];
const KEYWORD = `fountain ${run}`;
const calls = { search: 0, sold: 0, trading: 0 };

// A subject's listings: 30 of them, the first ones selling fastest, all from
// different sellers; the keyword ones have "cat water fountain" in their titles.
function listingsFor({ categoryId, q }) {
  // A lamp keyword's listings are its own (the per-account test reads them fresh); other keywords share one set.
  const base = categoryId || (q && /lamp/.test(q) ? `3${run}` : `7${run}`);
  return Array.from({ length: 80 }, (_, i) => ({
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
  mock.method(browseResearch, 'listingRead', async (listing) => {
    calls.sold += 1;
    const itemId = String(listing.legacyItemId);
    const i = Number(itemId.slice(-2));
    // The first listings sell fastest; the second child's hardly sell.
    const slow = itemId.startsWith(CHILDREN[1]);
    return { sold: slow ? 0 : Math.max(0, 120 - i * 4), brand: i % 7 === 0 ? 'Lumineo' : 'Unbranded', categoryId: CHILDREN[0], startedAt: new Date(Date.now() - 60 * 86400000).toISOString(), calls: 1 };
  });
  // Discover never reads Trading (orders and listings keep that pool): counted, to prove it stays at none.
  mock.method(trading, 'getItemSales', async () => {
    calls.trading += 1;
    throw new Error('Discover must not call Trading');
  });
  mock.method(taxonomy, 'getCategoryPath', async (site, id) => {
    if (String(id) === PARENT) return [{ id: PARENT, name: 'Test Lighting' }];
    if (String(id) === `6${run}`) return [{ id: `6${run}`, name: 'Test Lamps' }];
    if (String(id) === `4${run}`) return [{ id: `4${run}`, name: 'Test Shades' }];
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
  browseUsage._reset();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  assert.strictEqual(calls.trading, 0, 'no Trading call from Discover, ever');
  mock.restoreAll();
  await new Promise((resolve) => server.close(resolve));
  await pool.query(`DELETE FROM discover_scans WHERE subject = ANY($1)`, [[`c:${PARENT}`, ...CHILDREN.map((c) => `c:${c}`), `q:${KEYWORD}`, `q:parrot cage ${run}`, 'q:night light motion sensor', `q:desk lamp ${run}`, `q:floor lamp ${run}`]]);
  await pool.query(`DELETE FROM discover_listing_reads WHERE item_id LIKE $1 OR item_id LIKE $2 OR item_id LIKE $3 OR item_id LIKE $4 OR item_id LIKE $5`, [`9${run}%`, `8${run}%`, `7${run}%`, `6${run}%`, `5${run}%`]);
  await pool.query(`DELETE FROM discover_scans WHERE subject = ANY($1)`, [[`c:6${run}`, `c:4${run}`]]);
  await pool.query(`DELETE FROM discover_listing_reads WHERE item_id LIKE $1 OR item_id LIKE $2`, [`4${run}%`, `3${run}%`]);
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
  assert.strictEqual(twin.data.reads.read, 50);
  assert.strictEqual(calls.search, 1);
  const d = first.data;
  assert.strictEqual(d.subject.name, 'Test Lighting');
  assert.strictEqual(d.figures.total, 1200);
  assert.deepStrictEqual(d.reads, { asked: 50, read: 50, of: 79, stopped: false, reading: false, progress: { done: 50, of: 50 } });
  assert.strictEqual(calls.sold, 50, 'the first 50 listings read');
  // Categories and keywords only: no products, no listings to hunt from here.
  assert.ok(!('products' in d) && !('listings' in d) && !('rising' in d), Object.keys(d).join(','));
  assert.deepStrictEqual(d.momentum, { rising: d.momentum.rising, read: 50 });
  assert.ok(d.charts.countries.some((c) => c.key === 'CN'), 'where the sales ship from');
  assert.strictEqual(d.opportunity.score, d.opportunity.parts.reduce((sum, p) => sum + p.points, 0));
  assert.ok(d.keywords.some((k) => k.term === 'motion sensor'), JSON.stringify(d.keywords.map((k) => k.term)));
  assert.ok(d.keywords.every((k) => typeof k.sold === 'number'), 'each keyword with what its listings sold');
  // A listing that would break eBay's rules is hidden, never read, and counted in Before you hunt.
  assert.deepStrictEqual([d.compliance.hidden.count, d.compliance.hidden.restricted], [1, 1]);
  assert.ok(!d.keywords.some((k) => /knife/i.test(k.term)));
  // The products finder and its "find more" are gone.
  assert.strictEqual((await request('GET', `${base}/winners`, undefined, t.hunter)).status, 404);
  assert.strictEqual((await request('POST', `${base}/winners/more`, {}, t.hunter)).status, 404);
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
  assert.ok(lighting.monthlySales > 0 && lighting.selling > 0 && lighting.total === 1200);
  assert.ok(Number.isInteger(lighting.rising) && lighting.rising <= lighting.read, 'its new or rising leading listings: trending');
  const hero = (await request('GET', base, undefined, t.hunter)).data.pool;
  assert.ok(hero.categories >= 1 && hero.keywords >= 1 && !('winners' in (await request('GET', base, undefined, t.hunter)).data), JSON.stringify(hero));
  assert.ok(lighting.keyword && !/knife/i.test(lighting.keyword));
  const monthly = bestSelling.map((c) => c.monthlySales);
  assert.deepStrictEqual(monthly, [...monthly].sort((a, b) => b - a), 'best-selling first');
  // Subcategories, busiest first, not ranked yet.
  assert.deepStrictEqual(d.children.map((c) => [c.id, c.listings, c.scanned]), [[CHILDREN[0], 500, null], [CHILDREN[1], 400, null]]);

  // Opening it again spends nothing: the scan and today's readings are kept.
  const searches = calls.search;
  await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter);
  assert.deepStrictEqual([calls.search, calls.sold], [searches, 50]);
  // Asking for more reads changes nothing: every subject reads its first 50, no more.
  const more = await request('GET', `${base}/explore?categoryId=${PARENT}&reads=100`, undefined, t.hunter);
  assert.deepStrictEqual([more.data.reads.read, calls.sold], [50, 50]);
  // Yesterday's readings stand: opening it again the next day reads nothing new.
  await pool.query(`UPDATE discover_listing_reads SET day = day - 1 WHERE item_id LIKE $1`, [`${PARENT}%`]);
  const soldBefore = calls.sold;
  const nextDay = await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter);
  assert.deepStrictEqual([nextDay.data.reads.read, calls.sold], [50, soldBefore], "yesterday's readings are used, not bought again");

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
  const limit = config.discover.readsDailyCalls;
  config.discover.readsDailyCalls = 0;
  const before = calls.sold;
  try {
    const empty = await request('GET', `${base}/explore?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual([empty.data.reads.read, empty.data.reads.stopped, calls.sold], [0, true, before]);
    assert.strictEqual(empty.data.opportunity.parts[0].value, 'Not read yet');
  } finally {
    config.discover.readsDailyCalls = limit;
  }
  const kw = await request('GET', `${base}/explore?q=${encodeURIComponent(KEYWORD)}`, undefined, t.hunter);
  assert.strictEqual(kw.data.reads.read, 50, 'a keyword reads its first 50, like every subject');
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
  assert.strictEqual(watchedKeyword.figures.read, 50);
  assert.ok(watchedKeyword.momentum && !('rising' in watchedKeyword), 'its momentum, no listing rows');
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

test("each eBay site's keywords and categories are its own: an eBay US account sees nothing explored on eBay UK", async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  assert.strictEqual((await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter)).status, 200);
  const us = await connectionService.createConnection(t.ownerId, { platformKey: 'ebay', label: 'US Store', credentials: { accessToken: 'x' }, settings: { ebay: { marketplaceId: 'EBAY_US' } } }, { planChecked: true });
  const usKeywords = await request('GET', `/api/connections/${us.id}/discover/keywords?limit=400`, undefined, t.ownerToken);
  assert.strictEqual(usKeywords.status, 200, JSON.stringify(usKeywords.data));
  assert.strictEqual(usKeywords.data.market.id, 'EBAY_US');
  assert.ok(!usKeywords.data.keywords.some((k) => k.from?.name === 'Test Lighting'));
  const usStart = await request('GET', `/api/connections/${us.id}/discover`, undefined, t.ownerToken);
  assert.ok(!usStart.data.bestCategories.some((c) => c.id === PARENT));
});

test("each account has its own day of reads, so one busy hunter can't spend everyone's; past Discover's share of eBay's Browse pool nothing is read", async () => {
  const a = await team();
  const b = await team();
  const lamp = `desk lamp ${run}`;
  const perAccount = config.discover.accountDailyReads;
  config.discover.accountDailyReads = 10;
  try {
    const first = await request('GET', `/api/connections/${a.connectionId}/discover/explore?q=${encodeURIComponent(lamp)}`, undefined, a.hunter);
    assert.strictEqual(first.status, 200, JSON.stringify(first.data));
    assert.deepStrictEqual([first.data.reads.read, first.data.reads.stopped, first.data.budget.used.account], [10, true, 10], "this account's 10 for the day");
    // Asked again the same day: this account has nothing left, so nothing more is read.
    const soldAfterA = calls.sold;
    const again = await request('GET', `/api/connections/${a.connectionId}/discover/explore?q=${encodeURIComponent(lamp)}`, undefined, a.hunter);
    assert.deepStrictEqual([again.data.reads.read, calls.sold], [10, soldAfterA]);
    // Another account on the site uses its own day: the 10 already read are shared, it reads the next 10.
    const other = await request('GET', `/api/connections/${b.connectionId}/discover/explore?q=${encodeURIComponent(lamp)}`, undefined, b.hunter);
    assert.deepStrictEqual([other.data.reads.read, calls.sold - soldAfterA], [20, 10]);
  } finally {
    config.discover.accountDailyReads = perAccount;
  }

  // eBay says the Browse pool is 80% used (every server on Liston's keys, research and drafting too): past
  // Discover's 60%, a new keyword is searched from the kept scans only, and nothing is read.
  browseUsage.applyEbayFigure({ rateLimits: [{ apiName: 'Browse', resources: [{ name: 'buy.browse', rates: [{ limit: 5000, remaining: 1000, reset: new Date(Date.now() + 3600e3).toISOString() }] }] }] });
  try {
    const soldBefore = calls.sold;
    // A subcategory with most of its leading listings not read yet (its ranking read 8).
    const paused = await request('GET', `/api/connections/${b.connectionId}/discover/explore?categoryId=${CHILDREN[0]}`, undefined, b.hunter);
    assert.strictEqual(paused.status, 200, JSON.stringify(paused.data));
    assert.strictEqual(paused.data.budget.paused, true);
    assert.strictEqual(paused.data.budget.reads, 0);
    assert.strictEqual(calls.sold, soldBefore, 'no read while the pool is past its share');
    const unseen = await request('GET', `/api/connections/${b.connectionId}/discover/explore?q=${encodeURIComponent(`floor lamp ${run}`)}`, undefined, b.hunter);
    assert.strictEqual(unseen.status, 429, 'a subject never searched waits for tomorrow');
  } finally {
    browseUsage._reset();
  }
});

test('a subject answers at once with what is read, reads the rest in the background, and fills in when asked again', async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  // A subcategory, only its few ranking reads made so far.
  const sub = CHILDREN[1];
  const real = browseResearch.listingRead;
  discoverService._quickMs(50);
  // Slow reads: 50 listings at 30ms each, six at a time, take longer than the page waits.
  const slow = mock.method(browseResearch, 'listingRead', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { sold: 40, brand: 'Unbranded', categoryId: CHILDREN[1], startedAt: new Date(Date.now() - 60 * 86400000).toISOString(), calls: 1 };
  });
  try {
    const first = await request('GET', `${base}/explore?categoryId=${sub}`, undefined, t.hunter);
    assert.strictEqual(first.status, 200, JSON.stringify(first.data));
    assert.strictEqual(first.data.reads.reading, true, 'still reading when it answers');
    assert.ok(first.data.reads.progress.done < first.data.reads.progress.of);
    await discoverService._soldSettled();
    const again = await request('GET', `${base}/explore?categoryId=${sub}`, undefined, t.hunter);
    assert.strictEqual(again.data.reads.reading, false);
    assert.strictEqual(again.data.reads.progress.done, again.data.reads.progress.of);
    assert.ok(again.data.reads.read > first.data.reads.read, 'filled in');
    const reads = slow.mock.callCount();
    assert.ok(reads <= again.data.reads.progress.of, 'each listing read once, not again for the second ask');
  } finally {
    slow.mock.restore();
    browseResearch.listingRead = real;
    discoverService._quickMs();
  }
});

test("Your categories not explored yet are scored in the background: searched, their top sold counts read, the tab filling in; not again for hours", async () => {
  const t = await team();
  const base = `/api/connections/${t.connectionId}/discover`;
  const CATEGORY = `4${run}`;
  // Two listings Liston made for the account in a category nobody has explored.
  for (let i = 0; i < 2; i += 1) {
    await pool.query(`INSERT INTO listings (connection_id, status, generated_data) VALUES ($1, 'published', $2)`, [t.connectionId, JSON.stringify({ categoryId: CATEGORY, title: `Shade ${i}` })]);
  }
  const soldBefore = calls.sold;
  const first = await request('GET', base, undefined, t.hunter);
  assert.strictEqual(first.status, 200, JSON.stringify(first.data));
  const mine = () => first.data.yourCategories.find((c) => c.id === CATEGORY);
  assert.deepStrictEqual([mine().listings, mine().scanned, first.data.yourScoring.total], [2, null, 1]);
  let now = first.data;
  for (let i = 0; i < 50 && now.yourScoring; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    now = (await request('GET', base, undefined, t.hunter)).data;
  }
  const row = now.yourCategories.find((c) => c.id === CATEGORY);
  assert.strictEqual(now.yourScoring, null);
  assert.ok(row.scanned && row.scanned.score > 0 && row.scanned.total === 1200, JSON.stringify(row));
  assert.strictEqual(row.live, 1200);
  assert.strictEqual(calls.sold - soldBefore, 8, 'its leading listings, 8 read');
  // Asked again: nothing left to score, nothing read.
  const again = await request('GET', base, undefined, t.hunter);
  assert.deepStrictEqual([again.data.yourScoring, calls.sold - soldBefore], [null, 8]);
});
