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
    title: q ? `Cat water fountain ${i % 3 === 0 ? 'stainless steel' : 'led light'} ${i}` : `Night light plug in ${i % 2 ? 'warm white' : 'motion sensor'} ${i}`,
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
  await pool.query(`DELETE FROM discover_scans WHERE subject = ANY($1)`, [[`c:${PARENT}`, ...CHILDREN.map((c) => `c:${c}`), `q:${KEYWORD}`]]);
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
  return { ownerToken: data.token, connectionId: connection.id, hunter: await member('hunter', ['hunting']), lister: await member('lister', ['listings']) };
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
  assert.deepStrictEqual(d.reads, { asked: 25, read: 25, more: true, stopped: false, signInFailed: false });
  assert.strictEqual(calls.sold, 25, 'the first 25 listings read');
  // Fastest first, with its best-selling option first.
  assert.strictEqual(d.listings[0].itemId, `${PARENT}00`);
  assert.deepStrictEqual(d.listings[0].options.map((o) => o.label), ['Motion sensor', 'Warm white']);
  assert.strictEqual(d.listings[0].soldPerMonth, 60);
  assert.ok(d.listings.some((l) => l.overseas), 'where each ships from');
  assert.strictEqual(d.opportunity.score, d.opportunity.parts.reduce((sum, p) => sum + p.points, 0));
  assert.ok(d.keywords.some((k) => k.term === 'motion sensor'), JSON.stringify(d.keywords.map((k) => k.term)));
  // Subcategories, busiest first, not ranked yet.
  assert.deepStrictEqual(d.children.map((c) => [c.id, c.listings, c.scanned]), [[CHILDREN[0], 500, null], [CHILDREN[1], 400, null]]);

  // Opening it again spends nothing: the scan and today's readings are kept.
  const searches = calls.search;
  await request('GET', `${base}/explore?categoryId=${PARENT}`, undefined, t.hunter);
  assert.deepStrictEqual([calls.search, calls.sold], [searches, 25]);
  // Read more: the next listings only.
  const more = await request('GET', `${base}/explore?categoryId=${PARENT}&reads=50`, undefined, t.hunter);
  assert.deepStrictEqual([more.data.reads.read, calls.sold], [30, 30]);

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
  assert.strictEqual(kw.data.reads.read, 25);
  assert.strictEqual(kw.data.subject.kind, 'keyword');
  assert.ok(!kw.data.keywords.some((k) => k.term === 'fountain'), "the keyword's own words aren't news");

  const added = await request('POST', `${base}/watches`, { q: KEYWORD }, t.hunter);
  assert.strictEqual(added.status, 201);
  const cat = await request('POST', `${base}/watches`, { categoryId: PARENT }, t.hunter);
  assert.strictEqual(cat.data.label, 'Test Lighting');
  const list = await request('GET', `${base}/watches`, undefined, t.ownerToken);
  assert.deepStrictEqual(list.data.items.map((w) => w.kind).sort(), ['category', 'keyword']);
  const watchedKeyword = list.data.items.find((w) => w.kind === 'keyword');
  assert.strictEqual(watchedKeyword.figures.read, 25);
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
});
