const logger = require('../../utils/logger');
const connectionService = require('../connections/connection.service');
const taxonomy = require('../ebay/api/ebay.taxonomy');
const browseResearch = require('../ebay/browse-research');
const browseUsage = require('../ebay/browse-usage');
const marketplaces = require('../ebay/marketplaces');
const analyticsDays = require('../analytics/analytics-days');
const delivery = require('../research/delivery');
const researchService = require('../research/research.service');
const repo = require('./discover.repository');
const budget = require('./discover-budget');
const scoring = require('./discover-scoring');
const keywords = require('./discover-keywords');
const trends = require('./discover-trends');
const compliance = require('./discover-compliance');
const advisor = require('../ai-generation/research-advisor.service');
const researchAnalysis = require('../research/research-analysis');

// Discover: judging categories and keywords, on the Hunting page — every
// level alike (a top-level category, each subcategory down to a leaf, a
// keyword). A subject is scanned (one Browse search for its leading live
// listings, delivered to the account's country, kept a day and shared by
// every account on the site), and its first 50 leading listings' sold
// counts are read through Browse item reads (one per listing per day,
// stored, so the day's reads are shared and recent sales are the difference
// between two days). From those: how fast it sells, how crowded it is, what
// buyers pay, whether a seller delivering like this account can compete,
// the keywords of the titles that sell, and its subcategories ranked the
// same way. It lists no products: it says where to hunt, the hunter finds
// the product. Everything is Browse, within Discover's share of it
// (discover-budget); no Trading call, so orders and listings keep that pool.
// Watched categories and keywords are read again every night
// (discover.scheduler).

const SCAN_TTL_MS = 20 * 60 * 60 * 1000;
const SCAN_SIZE = 200; // eBay's page: one Browse call either way
const READS_FIRST = 50; // sold counts read when any subject opens: its figures stand on them
// A reading this recent stands (sold counts barely move in a day; the nightly refresh reads opened ones again).
const READ_FRESH_DAYS = 1;
const CHILD_READS = 8; // per subcategory when ranking them (enough for its keywords)
const CHILD_KEYWORDS = 4; // shown under each ranked subcategory
const KEYWORDS_TOP = 24; // keywords on a top-level category or a keyword
const KEYWORDS_MAX = 48; // deeper in, more: a leaf category shows the most
const POOL_SCANS = 200; // scans in the site's pool (newest first): its keywords and categories
const POOL_DAYS = 30; // a scan older than this is out of the pool
const BEST_CATEGORIES_MAX = 100; // explored categories the Categories tab ranks
const POOL_KEYWORDS_SHOWN = 60; // a page of the site's keywords
const POOL_KEYWORDS_MAX = 400;
const POOL_CACHE_MS = 5 * 60 * 1000;
const MAX_CHILDREN = 12; // subcategories ranked at once, busiest first
const READ_CONCURRENCY = 6;
// A subject answers within this with what's known; the rest of its sold counts are read on, and the page asks again.
const QUICK_MS = 2500;
let quickMs = QUICK_MS;
const soldJobs = new Map(); // sold-count reads under way, by site, subject and account

/**
 * The subject's sold counts, read in the background: the job's answer if
 * it's done within QUICK_MS, else what's been read so far ({ reads,
 * reading: true }) while the job reads on and saves each one. One job per
 * subject and account, whoever asks. `countAs`: the account whose day of
 * reads they come out of (null: only Discover's day, for its own nightly work).
 */
async function soldSoFar(connectionId, countAs, ctx, listings, max, subjectKey) {
  const key = `${ctx.site.id}:${subjectKey}:${connectionId}`;
  let job = soldJobs.get(key);
  if (!job) {
    job = readSold(countAs, ctx, listings, { max }).finally(() => soldJobs.delete(key));
    soldJobs.set(key, job);
  }
  const done = await Promise.race([job, new Promise((resolve) => setTimeout(() => resolve(null), quickMs))]);
  if (done) return done;
  const reads = await repo.latestReads(ctx.site.id, listings.map(idOf), analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  return { reads, stopped: false, reading: true };
}
const WATCH_LIMIT = 30;
const READ_FALLBACK_DAYS = 7; // an older read stands in when today's can't be made
const READS_KEPT_DAYS = 40;
const REFRESH_DAYS = 3; // opened this recently: read again nightly, shown as recently explored

class DiscoverError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

// Work already under way for the same thing (two people opening the same
// category, or a page asking twice) is shared, not done again.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

const resetText = (resetAt) => `${String(resetAt || '').slice(11, 16) || '07:00'} UTC`;

// ---- the account ------------------------------------------------------------------

async function context(ownerId, connectionId) {
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  if (connection.platform_key !== 'ebay') throw new DiscoverError('Discover needs an eBay account.', 400);
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(connection.settings?.ebay?.marketplaceId) || marketplaces.byId(marketplaces.DEFAULT_ID);
  const account = await researchService.accountDelivery(ownerId, connectionId, site, connection.settings?.ebay?.fulfillmentPolicyId || null);
  const timeZone = marketplaces.timeZoneOf(site.id);
  return { site, account, timeZone, day: analyticsDays.today(timeZone), pricing: connection.settings?.pricing || {} };
}

// ---- subjects -----------------------------------------------------------------------

function subjectOf({ categoryId, q }) {
  const id = categoryId === undefined || categoryId === null ? '' : String(categoryId).trim();
  if (id) {
    if (!/^\d{1,12}$/.test(id)) throw new DiscoverError('That category isn’t one eBay knows.', 400);
    return { kind: 'category', value: id, key: `c:${id}`, categoryId: id, q: null };
  }
  const text = String(q || '').trim().replace(/\s+/g, ' ');
  if (text.length < 2) throw new DiscoverError('Pick a category or type a keyword.', 400);
  if (text.length > 80) throw new DiscoverError('Keep the keyword under 80 characters.', 400);
  return { kind: 'keyword', value: text.toLowerCase(), key: `q:${text.toLowerCase()}`, categoryId: null, q: text };
}

const slim = (l) => ({
  itemId: l.itemId,
  legacyItemId: l.legacyItemId,
  title: l.title,
  image: l.image,
  url: l.url,
  price: l.price,
  shipping: l.shipping,
  deliveryDates: l.deliveryDates,
  seller: l.seller ? { username: l.seller.username, feedbackScore: l.seller.feedbackScore, feedbackPercentage: l.seller.feedbackPercentage } : null,
  location: l.location ? { country: l.location.country } : null,
  condition: l.condition,
  categoryId: l.categoryId,
  category: l.category,
  createdAt: l.createdAt,
  hasVariations: l.hasVariations,
});

/**
 * A subject's leading listings on the site: the kept scan while it's under
 * a day old, else a fresh Browse search (within Discover's share). An older
 * scan stands in when today's searches are used up.
 */
function scan(site, subject, { force = false } = {}) {
  return once(`scan:${site.id}:${subject.key}:${force}`, () => scanNow(site, subject, { force }));
}

async function scanNow(site, subject, { force }) {
  const kept = await repo.getScan(site.id, subject.key);
  const age = kept ? Date.now() - new Date(kept.taken_at).getTime() : Infinity;
  if (kept && age < SCAN_TTL_MS && !force) return { ...kept, fresh: true };
  const left = await budget.left();
  if (left.browse <= 0) {
    if (kept) return { ...kept, fresh: false };
    throw new DiscoverError(
      left.paused
        ? `eBay's Browse allowance is mostly used today, so Discover waits for it to reset at ${resetText(left.resetAt)} (research and drafting keep the rest).`
        : `Discover has used today's ${left.limits.browse} eBay searches. They reset at ${resetText(left.resetAt)}.`,
      429
    );
  }
  const found = await browseUsage.as('discover', () =>
    browseResearch.searchListings({ q: subject.q, categoryId: subject.categoryId, marketplaceId: site.id, country: site.country, limit: SCAN_SIZE })
  );
  await budget.spend('browse', found.calls);
  const value = { total: found.total, listings: found.items.map(slim), breakdown: found.breakdown };
  await repo.saveScan(site.id, subject.key, value);
  forgetPool();
  return { ...value, taken_at: new Date().toISOString(), fresh: true };
}

// ---- sold counts ----------------------------------------------------------------------

const idOf = (l) => String(l.legacyItemId || l.itemId);
// Reads under way, by site, listing and day (their promise).
const pendingReads = new Map();

/**
 * The sold counts of the first `max` listings: today's or yesterday's
 * reading where there is one, else a Browse item read (Discover's share of
 * the Browse pool, out of the day of the account `countAs` when given), else
 * the latest reading of the last week. Returns { reads: Map id -> reading,
 * stopped } — stopped when the day's reads (the account's, or Discover's)
 * ran out, or the Browse pool is past Discover's share, before every
 * listing was read.
 */
async function readSold(countAs, ctx, listings, { max }) {
  const { site, day } = ctx;
  const wanted = listings.slice(0, max);
  const reads = await repo.latestReads(site.id, listings.map(idOf), analyticsDays.addDays(day, -READ_FALLBACK_DAYS));
  // Read today or yesterday: it stands, so opening more spends the day's reads on listings not read yet.
  const fresh = new Set([day, ...Array.from({ length: READ_FRESH_DAYS }, (_, i) => analyticsDays.addDays(day, -(i + 1)))]);
  const need = wanted.filter((l) => !fresh.has(reads.get(idOf(l))?.day));
  if (!need.length) return { reads, stopped: false };
  const left = await budget.left(countAs);
  if (left.reads <= 0) return { reads, stopped: true };

  let calls = 0;
  const queue = need.slice(0, left.reads);
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const listing = queue[next++];
      const id = idOf(listing);
      // A listing another request is reading right now: wait for that read.
      const key = `${site.id}:${id}:${day}`;
      const mine = !pendingReads.has(key);
      if (mine) {
        const reading = browseUsage
          .as('discover', () => browseResearch.listingRead(listing, site.id))
          .then(async (read) => {
            await repo.saveRead(site.id, day, { itemId: id, sold: read.sold, options: null, categoryId: read.categoryId, startedAt: read.startedAt, brand: read.brand });
            return read;
          });
        pendingReads.set(key, reading);
        reading.catch(() => {}).finally(() => pendingReads.delete(key));
      }
      try {
        const read = await pendingReads.get(key);
        if (mine) calls += 1;
        reads.set(id, { item_id: id, day, sold: read.sold, options: null, category_id: read.categoryId, started_at: read.startedAt, brand: read.brand || null });
      } catch (err) {
        if (mine) {
          calls += 1;
          logger.warn('Discover: sold count not read', { itemId: id, error: err.message });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  await budget.spend('reads', calls, countAs);
  if (calls) forgetPool();
  return { reads, stopped: queue.length < need.length };
}

// ---- one subject ----------------------------------------------------------------------

function placed(scanRow, ctx, reads) {
  const takenAt = new Date(scanRow.taken_at).getTime();
  return scanRow.listings.map((l) => {
    const window = delivery.listingWindow(l, takenAt);
    const read = reads.get(idOf(l));
    return {
      ...l,
      delivery: window ? { ...window, compared: delivery.compare(window, ctx.account) } : { min: null, max: null, compared: 'unknown' },
      sold: read ? Number(read.sold) : null,
      brand: read?.brand ?? null,
      readDay: read?.day || null,
      // The start time kept with the reading, else the search's creation date.
      createdAt: read?.started_at ? new Date(read.started_at).toISOString() : l.createdAt,
    };
  });
}

async function subjectInfo(site, subject) {
  if (subject.kind === 'keyword') return { name: subject.q, path: [], children: [], leaf: true };
  const [path, children] = await Promise.all([taxonomy.getCategoryPath(site.id, subject.categoryId), taxonomy.getCategoryChildren(site.id, subject.categoryId)]);
  if (!path.length) throw new DiscoverError('That category isn’t one eBay knows on this site.', 404);
  return { name: path[path.length - 1].name, path, children, leaf: children.length === 0 };
}

// The brands worth hiding a listing for: the ones the AI names as a VeRO
// risk (on top of the known ones in discover-compliance).
const veroBrands = (advice) => (advice?.brandRisk && advice.brandRisk.level !== 'none' ? advice.brandRisk.brands || [] : []);

// A category or keyword whose own name is a restricted item: nothing in it is worth hunting.
const restrictedName = (name) => compliance.termsIn(name).restricted[0] || null;

// How many keywords a subject shows: more the deeper the category (a leaf
// category is one kind of product, so its phrases are the most useful).
function keywordLimit(info) {
  if (info.leaf) return KEYWORDS_MAX;
  return Math.min(KEYWORDS_MAX, KEYWORDS_TOP + 8 * Math.max(0, (info.path?.length || 1) - 1));
}

// A subcategory's row: its listing count from the parent's breakdown, and
// its figures and the keywords of its titles that sell once it has been
// scanned. Listings that would break eBay's rules don't count, and a
// subcategory that is itself a restricted item sorts last.
async function childRows(ctx, info, parentScan, brandNames = []) {
  if (!info.children.length) return [];
  const counts = new Map((parentScan.breakdown?.categories || []).map((c) => [String(c.id), c.count]));
  const scans = await repo.getScans(ctx.site.id, info.children.map((c) => `c:${c.id}`));
  const ids = [...scans.values()].flatMap((s) => s.listings.map(idOf));
  const reads = await repo.latestReads(ctx.site.id, ids, analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  const rows = info.children.map((c) => {
    const s = scans.get(`c:${c.id}`);
    const restricted = restrictedName(c.name);
    const row = { id: c.id, name: c.name, leaf: c.leaf, listings: s ? s.total : counts.get(String(c.id)) ?? null, scanned: null, keywords: [], restricted: restricted ? { kind: restricted.kind, label: restricted.label } : null };
    if (s && !restricted) {
      const { kept, hidden } = compliance.partition(s.listings, brandNames);
      const listings = scoring.withPace(placed({ ...s, listings: kept }, ctx, reads));
      const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
      if (f.demand.read) {
        const o = scoring.opportunity(f, { currency: ctx.site.currency });
        row.scanned = {
          score: o.score,
          band: o.band,
          medianPerMonth: f.demand.medianPerMonth,
          monthlySales: f.demand.monthlySales,
          soldTotal: f.demand.soldTotal,
          selling: f.demand.selling,
          read: f.demand.read,
          price: f.price?.median ?? null,
          fit: f.fit?.share ?? null,
          topSeller: f.competition.topSeller?.share ?? null,
          hidden: hidden.count,
          takenAt: s.taken_at,
        };
        row.keywords = keywords.fromListings(listings, { query: c.name, limit: CHILD_KEYWORDS }).map((k) => ({ term: k.term, perMonth: k.perMonth, sold: k.sold }));
      }
    }
    return row;
  });
  return rows.sort((a, b) => Number(Boolean(a.restricted)) - Number(Boolean(b.restricted)) || (b.scanned?.score ?? -1) - (a.scanned?.score ?? -1) || (b.listings ?? -1) - (a.listings ?? -1));
}

/**
 * One category or keyword, for the account: { subject, figures,
 * opportunity, charts, trend, keywords, brands, compliance, price,
 * children (subcategories, ranked once fetched), watch, account, budget }.
 * Every subject reads the sold counts of its first READS_FIRST leading
 * listings, the same at every level.
 */
// `background`: Discover's own nightly work (the shared refresh, watches), read out of Discover's
// day, never an account's.
function explore(ownerId, connectionId, input, { canSeeTraffic = false, background = false } = {}) {
  const subject = subjectOf(input);
  return once(`explore:${connectionId}:${subject.key}:${canSeeTraffic}:${background}`, () => exploreNow(ownerId, connectionId, subject, { canSeeTraffic, background }));
}

// The account's own traffic and sales on a keyword (its Analytics figures,
// last 30 days), for whoever sees its analytics; null when there's none or
// it takes too long (the rest of the page doesn't wait on it).
const TRAFFIC_WAIT_MS = 8000;
async function ownTraffic(ownerId, connectionId, keyword) {
  try {
    const read = require('../analytics/analytics.service')
      .getAnalytics(connectionId, ownerId, { range: '30d' })
      .then(({ data }) => (data.status === 'ok' ? { ...keywords.trafficFor(data.listings || [], keyword), range: data.range } : null));
    const result = await Promise.race([read, new Promise((resolve) => setTimeout(() => resolve(null), TRAFFIC_WAIT_MS))]);
    return result && result.listings ? result : result ? { listings: 0, range: result.range } : null;
  } catch (err) {
    logger.warn('Discover: own traffic not read', { connectionId, error: err.message });
    return null;
  }
}

/**
 * What a subject stands on: its leading listings (the kept scan), the ones
 * that would break eBay's rules hidden and never read, and today's AI
 * brand/VeRO reading when there is one.
 */
async function readPlan(ctx, subject) {
  const scanRow = await scan(ctx.site, subject);
  // The AI's brand/VeRO and restricted reading, when today's is kept (else the page asks for it).
  const advice = await advisor.keptAdvice(adviceKey(ctx.site, subject)).catch(() => null);
  // A restricted item is hidden, not read and not counted: Discover never points anyone at it. A
  // listing naming a VeRO brand (Liston's list, or the AI's guess) is kept, marked, for the hunter to judge.
  const brandNames = veroBrands(advice);
  const { kept, hidden, vero } = compliance.partition(scanRow.listings, brandNames);
  return { scanRow, advice, brandNames, kept, hidden, vero };
}

async function exploreNow(ownerId, connectionId, subject, { canSeeTraffic, background }) {
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  const max = READS_FIRST;
  const traffic = canSeeTraffic && subject.kind === 'keyword' ? ownTraffic(ownerId, connectionId, subject.q) : Promise.resolve(null);
  const { scanRow, advice, brandNames, kept, hidden, vero } = await readPlan(ctx, subject);
  // Opened: it's in the nightly shared refresh for a few days, read with this account.
  await repo.touchScan(ctx.site.id, subject.key, connectionId).catch(() => {});
  // Answered within a moment with what's read; the rest read on while the page asks again.
  const sold = await soldSoFar(connectionId, background ? null : connectionId, ctx, kept, max, subject.key);
  const listings = scoring.withPace(placed({ ...scanRow, listings: kept }, ctx, sold.reads));
  const wantedIds = kept.slice(0, max).map(idOf);
  const readOf = wantedIds.filter((id) => sold.reads.get(id)?.day === ctx.day || sold.reads.get(id)?.day === analyticsDays.addDays(ctx.day, -1)).length;

  const f = scoring.figures(listings, { total: scanRow.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
  // Two weeks of readings: the subject's sales day by day.
  const history = await repo.readsSince(ctx.site.id, listings.map(idOf), analyticsDays.addDays(ctx.day, -15));
  const summary = trends.summarise(scoring.sellingNow(listings), trends.recentSales(history));
  const [children, watch] = await Promise.all([childRows(ctx, info, scanRow, brandNames), repo.findWatch(connectionId, subject.kind, subject.value)]);
  const brands = scanRow.breakdown?.brands || [];
  // Brands worth flagging in a keyword: the VeRO ones, and brands on at least 5% of the listings
  // (sellers type all sorts into eBay's brand field, "Kitchen" included).
  const brandTotal = brands.reduce((sum, b) => sum + b.count, 0) || scanRow.total || 1;
  const flagNames = [...brandNames, ...brands.filter((b) => !b.unbranded && b.count / brandTotal >= 0.05).map((b) => b.name)];
  const flagged = (text) => compliance.flagOf(text, flagNames);

  return {
    subject: {
      kind: subject.kind,
      categoryId: subject.categoryId,
      q: subject.q,
      name: info.name,
      path: info.path,
      leaf: info.leaf,
      takenAt: scanRow.taken_at,
      stale: !scanRow.fresh,
    },
    figures: f,
    opportunity: scoring.opportunity(f, { currency: ctx.site.currency }),
    charts: scoring.charts(listings, { country: ctx.site.country }),
    // Sales day by day from Discover's daily readings (null until two days are known).
    trend: trends.dailySales(history, { today: ctx.day, days: 14 }),
    // New or selling faster lately: how many of its leading listings.
    momentum: trends.momentumOf(summary.listings),
    // A keyword: your own listings with it, their traffic and sales (Analytics, 30 days).
    yourTraffic: await traffic,
    recent: summary.recent,
    // The subject's own words (its category name, or the keyword) aren't news. More the deeper in.
    keywords: keywords.fromListings(listings, { query: subject.q || info.name, limit: keywordLimit(info) }).map((k) => ({ ...k, flag: flagged(k.term) })),
    brands: brands.slice(0, 8),
    // Before hunting: eBay's word filter, restricted items, brands and VeRO — over every leading
    // listing, the hidden ones included, so it says what was hidden (restricted) and what's marked (VeRO).
    compliance: compliance.check({ name: info.name, listings: scanRow.listings, brands, total: scanRow.total, advice, hidden, vero }),
    // What you'd sell at and the most a supplier may cost for your target return (your pricing settings).
    price: researchAnalysis.priceAdvice(listings, { pricing: ctx.pricing }),
    // A keyword: the categories its listings sit in, to explore next.
    categories: subject.kind === 'keyword' ? (scanRow.breakdown?.categories || []).slice(0, 8) : [],
    children: children.map((c) => ({ ...c, flag: flagged(c.name) })),
    reads: {
      asked: max,
      read: f.demand.read,
      of: kept.length,
      stopped: sold.stopped,
      // Still reading sold counts in the background: how far it's got (the page asks again until done).
      reading: Boolean(sold.reading),
      progress: { done: readOf, of: wantedIds.length },
    },
    watch: watch ? { id: watch.id } : null,
    // Subcategories being ranked right now: the page asks again until done.
    ranking: subject.categoryId ? rankingOf(connectionId, subject.categoryId) : null,
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    budget: await budget.left(connectionId),
  };
}

// One AI reading a day per site and subject, shared by every account on the site.
const adviceKey = (site, subject) => `discover:${site.id}:${subject.key}`;

/**
 * The AI's brand/VeRO and restricted-product reading of a subject (one
 * model call, kept a day for everyone on the site), with the checks redone:
 * { compliance }. From the kept scan and readings: no eBay call.
 */
async function review(ownerId, connectionId, input) {
  const subject = subjectOf(input);
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  const scanRow = await repo.getScan(ctx.site.id, subject.key);
  if (!scanRow) throw new DiscoverError('Open it first.', 400);
  const reads = await repo.latestReads(ctx.site.id, scanRow.listings.map(idOf), analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  const listings = scoring.withPace(placed(scanRow, ctx, reads));
  const brands = scanRow.breakdown?.brands || [];
  const advice = await advisor.advise(adviceKey(ctx.site, subject), {
    query: info.name,
    market: ctx.site.name,
    currency: ctx.site.currency,
    items: listings,
    breakdown: scanRow.breakdown,
    keywords: keywords.fromListings(listings, { query: subject.q || info.name }),
  });
  // With the AI's brands known, more listings are marked: the page opens the subject again.
  const { hidden, vero } = compliance.partition(scanRow.listings, veroBrands(advice));
  return { compliance: compliance.check({ name: info.name, listings: scanRow.listings, brands, total: scanRow.total, advice, hidden, vero }), checked: Boolean(advice), hidden: hidden.count, marked: vero.count };
}

// ---- the site's pool: keywords and categories across everything explored ----------------

const accountPools = new Map(); // per site and account: what the pool says for this account
const poolCache = new Map(); // per site: what's loaded, shared by every account
// New scans or readings change the pool: the next request builds it again.
const forgetPool = () => {
  accountPools.clear();
  poolCache.clear();
};

/**
 * A site's pool, shared by every Liston account on the site: every scan
 * from the last month (anyone's), its listings that may be shown, with their
 * readings and recent sales. Loaded once and kept five minutes; what depends
 * on the account (delivery fit, the score) is worked out per account from
 * it, so a second account costs no database reads.
 */
async function sitePool(site, day) {
  const hit = poolCache.get(site.id);
  if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.value;
  // Searches Discover made for a hunter's filters before it stopped listing products ("f:…") aren't subjects.
  const scans = (await repo.scansForSite(site.id, new Date(Date.now() - POOL_DAYS * 86400000), POOL_SCANS)).filter((s) => !s.subject.startsWith('f:'));
  const ids = [...new Set(scans.flatMap((s) => s.listings.map(idOf)))];
  const [reads, history] = await Promise.all([
    repo.latestReads(site.id, ids, analyticsDays.addDays(day, -READ_FALLBACK_DAYS)),
    repo.readsSince(site.id, ids, analyticsDays.addDays(day, -(trends.WEEK + 1))),
  ]);
  const recent = trends.recentSales(history);
  const subjects = [];
  for (const s of scans) {
    const isCategory = s.subject.startsWith('c:');
    const value = s.subject.slice(2);
    const path = isCategory ? await taxonomy.getCategoryPath(site.id, value).catch(() => []) : [];
    if (isCategory && !path.length) continue;
    const name = isCategory ? path[path.length - 1].name : value;
    // A restricted subject, or one under a restricted category (Electronic Smoking…): out.
    if (compliance.termsIn(isCategory ? path.map((p) => p.name).join(' ') : name).restricted.length) continue;
    const { kept } = compliance.partition(s.listings);
    subjects.push({ scan: { ...s, listings: kept }, from: { kind: isCategory ? 'category' : 'keyword', value, name, path: isCategory ? path.slice(0, -1).map((p) => p.name) : [] } });
  }
  const value = { subjects, reads, recent, pool: { subjects: scans.length, listings: ids.length } };
  poolCache.set(site.id, { at: Date.now(), value });
  return value;
}

/**
 * The site's pool for an account: the keywords of the titles that sell
 * under every subject explored (each searched keyword with its own market),
 * and every category explored at any depth with its figures, scored for
 * this account (its delivery). Kept five minutes.
 */
async function sitePoolFor(ownerId, connectionId) {
  const ctx = await context(ownerId, connectionId);
  const cacheKey = `${ctx.site.id}:${connectionId}`;
  const hit = accountPools.get(cacheKey);
  if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.value;
  const site = await sitePool(ctx.site, ctx.day);
  const found = [];
  const searched = [];
  const categories = [];
  let read = 0;
  for (const { scan: s, from } of site.subjects) {
    const listings = trends.summarise(scoring.withPace(placed(s, ctx, site.reads)), site.recent).listings;
    read += listings.filter((l) => l.soldPerMonth !== null).length;
    const where = { kind: from.kind, value: from.value, name: from.name };
    // Across the whole site a lone word ("white", "plus") means nothing without its category, so the
    // site's list keeps phrases of two words or more whose titles sell at least as well as the rest.
    const subjectKeywords = keywords.fromListings(listings, { query: from.name, limit: KEYWORDS_TOP });
    for (const k of subjectKeywords) {
      if (k.words >= 2 && (k.lift ?? 0) >= 1) found.push({ term: k.term, perMonth: k.perMonth, sold: k.sold, salesShare: k.salesShare, lift: k.lift, listings: k.listings, from: where });
    }
    const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
    if (!f.demand.read) continue;
    const o = scoring.opportunity(f, { currency: ctx.site.currency });
    if (from.kind === 'keyword') {
      searched.push({ term: from.value, monthlySales: Math.round(f.demand.monthlySales), live: s.total, score: o.score, band: o.band });
      continue;
    }
    const top = subjectKeywords.find((k) => k.words >= 2) || subjectKeywords[0] || null;
    // Trending: how many of its leading listings are new or selling faster lately (eBay doesn't
    // share buyers' search volume, so momentum stands in).
    const momentum = trends.momentumOf(listings);
    categories.push({
      id: from.value,
      name: from.name,
      path: from.path || [],
      monthlySales: Math.round(f.demand.monthlySales),
      selling: f.demand.selling,
      read: f.demand.read,
      total: s.total,
      price: f.price?.median ?? null,
      score: o.score,
      band: o.band,
      keyword: top ? top.term : null,
      rising: momentum.rising,
    });
  }
  const blocked = (term) => compliance.termsIn(term).restricted.length > 0 || Boolean(compliance.veroBrandIn(term));
  const siteKeywords = keywords.poolKeywords(found, searched, { isBlocked: blocked }).sort((a, b) => b.perMonth - a.perMonth);
  categories.sort((a, b) => b.monthlySales - a.monthlySales || b.score - a.score);
  const value = { keywords: siteKeywords, categories, pool: { ...site.pool, read }, market: marketplaces.summary(ctx.site.id), at: new Date().toISOString() };
  accountPools.set(cacheKey, { at: Date.now(), value });
  return value;
}

/**
 * The keywords worth hunting across everything explored on the site, for
 * this account: each with its sales a month, how much better its titles sell
 * than the rest (lift), and — once it's been searched — its own market (live
 * listings, opportunity). Searched by words, sorted by sales, lift,
 * opportunity or how many categories share it, a page at a time. eBay
 * doesn't share buyers' search volume, so demand is the sales themselves.
 */
async function siteKeywords(ownerId, connectionId, { q = '', sort = 'sales', searchedOnly = false, limit = POOL_KEYWORDS_SHOWN } = {}) {
  const all = await sitePoolFor(ownerId, connectionId);
  const words = wordsOfQuery(q);
  let list = all.keywords.filter((k) => (!words.length || words.every((w) => k.term.toLowerCase().includes(w))) && (!searchedOnly || k.searched));
  const by = {
    sales: (a, b) => b.perMonth - a.perMonth,
    lift: (a, b) => (b.lift ?? 0) - (a.lift ?? 0) || b.perMonth - a.perMonth,
    opportunity: (a, b) => (b.searched?.score ?? -1) - (a.searched?.score ?? -1) || b.perMonth - a.perMonth,
    spread: (a, b) => b.subjects - a.subjects || b.perMonth - a.perMonth,
  };
  list = [...list].sort(by[sort] || by.sales);
  return { keywords: list.slice(0, Math.min(POOL_KEYWORDS_MAX, Math.max(1, limit))), matched: list.length, searched: all.keywords.filter((k) => k.searched).length, pool: all.pool, market: all.market, at: all.at };
}

const wordsOfQuery = (q) =>
  String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1)
    .slice(0, 6);

/**
 * The nightly shared refresh (discover.scheduler): subjects anyone opened in
 * the last 3 days whose scan is a day old are scanned again and their top
 * listings read, through the account that last opened each — as long as
 * Discover keeps a third of its day for people using it. Returns how many.
 */
async function refreshRecent({ limit = 10 } = {}) {
  const due = await repo.dueForRefresh(new Date(Date.now() - REFRESH_DAYS * 86400000), new Date(Date.now() - SCAN_TTL_MS), limit);
  let done = 0;
  for (const row of due) {
    const left = await budget.left();
    if (left.paused || left.reads < left.limits.reads / 3 || left.browse < left.limits.browse / 3) break;
    const subject = row.subject.startsWith('c:') ? { categoryId: row.subject.slice(2) } : { q: row.subject.slice(2) };
    try {
      await explore(row.owner_id, row.connection_id, subject, { background: true });
      done += 1;
    } catch (err) {
      logger.warn('Discover: shared refresh skipped a subject', { subject: row.subject, error: err.message });
      // A category eBay no longer has: out of the refresh, not tried again every hour.
      if (err.statusCode === 404) await repo.forgetOpened(row.marketplace_id, row.subject).catch(() => {});
      if (err.statusCode === 429) break;
    }
  }
  return done;
}

// Subcategory rankings under way, by account and category: { total, done, startedAt }.
const rankings = new Map();
const RANK_CONCURRENCY = 3;
const rankingKey = (connectionId, categoryId) => `${connectionId}:${categoryId}`;

/** How far a ranking has got, or null when none is running. */
function rankingOf(connectionId, categoryId) {
  const job = rankings.get(rankingKey(connectionId, categoryId));
  return job ? { total: job.total, done: job.done } : null;
}

/**
 * Ranks a category's subcategories: each busiest one (up to 12) scanned and
 * its top listings' sold counts read (5 each), a few at a time, within the
 * day's shares. Runs on after answering (explore() says how far it has got,
 * and each subcategory shows as soon as it's read): { total, done }.
 */
async function rankChildren(ownerId, connectionId, categoryId) {
  const subject = subjectOf({ categoryId });
  const running = rankingOf(connectionId, subject.categoryId);
  if (running) return running;
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  if (!info.children.length) throw new DiscoverError('This category has no subcategories to rank.', 400);
  const parent = await scan(ctx.site, subject);
  const counts = new Map((parent.breakdown?.categories || []).map((c) => [String(c.id), c.count]));
  // Restricted subcategories (knives, vapes…) aren't worth the reads: nothing in them is hunted.
  const chosen = info.children
    .filter((c) => !restrictedName(c.name))
    .sort((a, b) => (counts.get(String(b.id)) ?? 0) - (counts.get(String(a.id)) ?? 0))
    .slice(0, MAX_CHILDREN);
  if (!chosen.length) throw new DiscoverError('Every subcategory here is a restricted item on eBay: nothing to rank.', 400);
  const key = rankingKey(connectionId, subject.categoryId);
  const job = { total: chosen.length, done: 0, startedAt: Date.now() };
  rankings.set(key, job);

  let next = 0;
  let outOfSearches = false;
  async function worker() {
    while (next < chosen.length && !outOfSearches) {
      const child = chosen[next++];
      try {
        const s = await scan(ctx.site, subjectOf({ categoryId: child.id }));
        const { kept } = compliance.partition(s.listings);
        const sold = await readSold(connectionId, ctx, kept, { max: CHILD_READS });
        // The day's reads (the account's, or Discover's) are used up: no point asking for the rest.
        if (sold.stopped) outOfSearches = true;
      } catch (err) {
        if (err.statusCode === 429) outOfSearches = true; // the day's searches are used up
        else logger.warn('Discover: subcategory not scanned', { categoryId: child.id, error: err.message });
      } finally {
        job.done += 1;
      }
    }
  }
  Promise.all(Array.from({ length: RANK_CONCURRENCY }, worker))
    .catch((err) => logger.warn('Discover: ranking stopped', { categoryId, error: err.message }))
    .finally(() => rankings.delete(key));
  return { total: job.total, done: job.done };
}

// ---- the account's own categories, scored ----------------------------------------------

const OWN_MAX = 20; // own categories scored per run, most listings first
const OWN_AGAIN_MS = 6 * 60 * 60 * 1000; // a run at most this often per account
const ownScoring = new Map(); // connectionId -> { total, done, finishedAt }

/**
 * The Categories tab's "Yours": each of the account's categories nobody has
 * explored yet is searched and its leading listings' sold counts read
 * (CHILD_READS each, as a ranked subcategory), a few at a time, in the
 * background — at most every six hours, and only while more than a third of
 * Discover's day is left (the rest is for people exploring). { total, done }
 * while it runs, else null.
 */
async function scoreOwn(ownerId, connectionId, ctx, ids) {
  const key = String(connectionId);
  const job = ownScoring.get(key);
  if (job && !job.finishedAt) return { total: job.total, done: job.done };
  if (!ids.length || (job && Date.now() - job.finishedAt < OWN_AGAIN_MS)) return null;
  const left = await budget.left();
  if (left.paused || left.reads < left.limits.reads / 3 || left.browse < left.limits.browse / 3) return null;
  const chosen = ids.slice(0, OWN_MAX);
  const run = { total: chosen.length, done: 0, finishedAt: null };
  ownScoring.set(key, run);
  let next = 0;
  let stop = false;
  async function worker() {
    while (next < chosen.length && !stop) {
      const id = chosen[next++];
      try {
        const s = await scan(ctx.site, subjectOf({ categoryId: id }));
        const { kept } = compliance.partition(s.listings);
        const sold = await readSold(null, ctx, kept, { max: CHILD_READS });
        // The day's reads are used up: no point asking again today.
        if (sold.stopped) stop = true;
      } catch (err) {
        if (err.statusCode === 429) stop = true;
        else logger.warn('Discover: your category not scored', { categoryId: id, error: err.message });
      } finally {
        run.done += 1;
      }
    }
  }
  Promise.all(Array.from({ length: RANK_CONCURRENCY }, worker))
    .catch((err) => logger.warn('Discover: scoring your categories stopped', { connectionId, error: err.message }))
    .finally(() => {
      run.finishedAt = Date.now();
      forgetPool();
    });
  return { total: run.total, done: run.done };
}

/** Categories matching what's typed in Discover's search box, with their paths. */
async function suggest(ownerId, connectionId, q) {
  const text = String(q || '').trim();
  if (text.length < 2) return { categories: [] };
  const ctx = await context(ownerId, connectionId);
  const found = await taxonomy.searchCategories(ctx.site.id, text).catch(() => []);
  return { categories: found.slice(0, 6).map((c) => ({ id: String(c.id), name: c.name, path: (c.path || []).slice(0, -1), leaf: c.leaf })) };
}

// ---- where to start ------------------------------------------------------------------

/**
 * The starting points: the account's own categories (from the listings
 * Liston made for it) and eBay's top-level categories, each with its
 * opportunity once scanned; the watch count; what's left of the day.
 */
async function start(ownerId, connectionId) {
  const ctx = await context(ownerId, connectionId);
  const [own, top, watched] = await Promise.all([repo.ownCategories(connectionId), taxonomy.getCategoryChildren(ctx.site.id), repo.countWatches(connectionId)]);
  const ownRows = (
    await Promise.all(
      own.map(async (c) => {
        const path = await taxonomy.getCategoryPath(ctx.site.id, c.id).catch(() => []);
        return path.length ? { id: String(c.id), name: path[path.length - 1].name, path: path.slice(0, -1).map((p) => p.name), listings: c.listings } : null;
      })
    )
  ).filter(Boolean);
  const scans = await repo.getScans(ctx.site.id, [...ownRows, ...top].map((c) => `c:${c.id}`));
  const ids = [...scans.values()].flatMap((s) => s.listings.map(idOf));
  const reads = await repo.latestReads(ctx.site.id, ids, analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  const badge = (id) => {
    const s = scans.get(`c:${id}`);
    if (!s) return null;
    const f = scoring.figures(placed(s, ctx, reads), { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
    return f.demand.read ? { ...scoring.opportunity(f, { currency: ctx.site.currency }), parts: undefined, total: s.total } : null;
  };
  // The account's own categories not scored yet: scored in the background (the page asks again until done).
  const unscored = ownRows.filter((c) => !badge(c.id) && !restrictedName(c.name)).map((c) => c.id);
  const yourScoring = await scoreOwn(ownerId, connectionId, ctx, unscored).catch((err) => {
    logger.warn('Discover: your categories not scored', { connectionId, error: err.message });
    return null;
  });
  // The first few watches with their figures, for the start screen.
  const preview = watched ? (await watches(ownerId, connectionId)).items.slice(0, 4) : [];
  // What anyone on the site explored lately (shared, refreshed nightly), with its opportunity.
  const opened = await repo.recentlyOpened(ctx.site.id, new Date(Date.now() - REFRESH_DAYS * 86400000), 8);
  const openedReads = await repo.latestReads(ctx.site.id, opened.flatMap((s) => s.listings.map(idOf)), analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  const recent = (
    await Promise.all(
      opened.map(async (s) => {
        const isCategory = s.subject.startsWith('c:');
        const value = s.subject.slice(2);
        const path = isCategory ? await taxonomy.getCategoryPath(ctx.site.id, value).catch(() => []) : [];
        if (isCategory && !path.length) return null;
        const f = scoring.figures(placed(s, ctx, openedReads), { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
        const o = f.demand.read ? scoring.opportunity(f, { currency: ctx.site.currency }) : null;
        return {
          kind: isCategory ? 'category' : 'keyword',
          value,
          name: isCategory ? path[path.length - 1].name : value,
          path: isCategory ? path.slice(0, -1).map((p) => p.name) : [],
          openedAt: s.opened_at,
          flag: compliance.flagOf(isCategory ? path[path.length - 1].name : value),
          scanned: o ? { score: o.score, band: o.band, total: s.total, monthlySales: f.demand.monthlySales } : null,
        };
      })
    )
  ).filter(Boolean);
  // The keywords and categories across everything explored, for the start screen (the site's pool, cached).
  const pool = await sitePoolFor(ownerId, connectionId).catch(() => null);
  return {
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    pool: pool ? { keywords: pool.keywords.length, categories: pool.categories.length, subjects: pool.pool.subjects, listings: pool.pool.listings, read: pool.pool.read } : null,
    // Every category explored on the site (any depth), best-selling first, for the Categories tab.
    bestCategories: pool ? pool.categories.slice(0, BEST_CATEGORIES_MAX) : [],
    // Live listings from its search even before its sold counts are read.
    yourCategories: ownRows.map((c) => ({ ...c, scanned: badge(c.id), live: scans.get(`c:${c.id}`)?.total ?? null })),
    yourScoring,
    topCategories: top.map((c) => ({ id: c.id, name: c.name, leaf: c.leaf, scanned: badge(c.id) })),
    watches: watched,
    watchPreview: preview,
    recent,
    budget: await budget.left(connectionId),
  };
}

// ---- the watchlist ---------------------------------------------------------------------

const watchSubject = (w) => (w.kind === 'category' ? { categoryId: w.value } : { q: w.value });

/** The account's watched categories and keywords, each with its latest figures and recent sales. */
async function watches(ownerId, connectionId) {
  const ctx = await context(ownerId, connectionId);
  const rows = await repo.watchesFor(connectionId);
  const subjects = rows.map((w) => subjectOf(watchSubject(w)));
  const scans = await repo.getScans(ctx.site.id, subjects.map((s) => s.key));
  const ids = [...scans.values()].flatMap((s) => s.listings.map(idOf));
  const [reads, history] = await Promise.all([
    repo.latestReads(ctx.site.id, ids, analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS)),
    repo.readsSince(ctx.site.id, ids, analyticsDays.addDays(ctx.day, -(trends.WEEK + 1))),
  ]);
  const recent = trends.recentSales(history);
  return {
    items: rows.map((w, i) => {
      const s = scans.get(subjects[i].key);
      const base = {
        id: w.id,
        kind: w.kind,
        value: w.value,
        label: w.label,
        createdAt: w.created_at,
        createdBy: w.created_by_name || (w.created_by_email ? w.created_by_email.split('@')[0] : null),
        lastReadAt: w.last_read_at,
      };
      if (!s) return { ...base, figures: null };
      const listings = scoring.withPace(placed(s, ctx, reads));
      const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
      const summary = trends.summarise(scoring.sellingNow(listings), recent);
      const o = scoring.opportunity(f, { currency: ctx.site.currency });
      return {
        ...base,
        takenAt: s.taken_at,
        figures: { total: s.total, medianPerMonth: f.demand.medianPerMonth, selling: f.demand.selling, read: f.demand.read, price: f.price?.median ?? null },
        opportunity: { score: o.score, band: o.band },
        recent: summary.recent,
        momentum: trends.momentumOf(summary.listings),
      };
    }),
    limit: WATCH_LIMIT,
    market: marketplaces.summary(ctx.site.id),
  };
}

async function addWatch(ownerId, connectionId, userId, input) {
  const subject = subjectOf(input);
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  const existing = await repo.findWatch(connectionId, subject.kind, subject.value);
  if (!existing && (await repo.countWatches(connectionId)) >= WATCH_LIMIT) {
    throw new DiscoverError(`An account can watch up to ${WATCH_LIMIT} categories and keywords. Remove one first.`, 400);
  }
  const label = subject.kind === 'category' ? info.path.map((p) => p.name).join(' › ') : subject.q;
  return repo.addWatch({ ownerId, connectionId, kind: subject.kind, value: subject.value, label, createdBy: userId });
}

async function removeWatch(connectionId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new DiscoverError('Watch not found', 404);
  const removed = await repo.removeWatch(connectionId, id);
  if (!removed) throw new DiscoverError('Watch not found', 404);
}

/**
 * The nightly reading (discover.scheduler): each watch not read in 20
 * hours gets a fresh scan when its kept one is a day old and today's sold
 * counts of its leading listings, as long as the day's shares last.
 * Returns how many were read.
 */
async function readDueWatches({ limit = 5 } = {}) {
  const due = await repo.dueWatches(new Date(Date.now() - SCAN_TTL_MS), limit);
  let read = 0;
  for (const w of due) {
    const left = await budget.left();
    if (left.paused || (left.reads <= 0 && left.browse <= 0)) break;
    try {
      await explore(w.owner_user_id, w.connection_id, watchSubject(w), { background: true });
      await repo.markWatchRead(w.id);
      read += 1;
    } catch (err) {
      logger.warn('Discover: watch not read', { watchId: w.id, error: err.message });
      // A category eBay no longer has: counted as read, so it's tried once a day, not every hour.
      if (err.statusCode === 404) await repo.markWatchRead(w.id).catch(() => {});
      if (err.statusCode === 429) break;
    }
  }
  return read;
}

async function pruneReads(day = analyticsDays.today('Europe/London')) {
  return repo.pruneReadsBefore(analyticsDays.addDays(day, -READS_KEPT_DAYS));
}

// ---- the account's own keywords ------------------------------------------------------

const TRAFFIC_RANGES = ['7d', '30d', '90d'];

/**
 * Which words in the account's own titles bring impressions, clicks and
 * sales (its stored traffic and orders, the Analytics tab's figures):
 * { status, range, listings, measured, keywords }. No eBay search.
 */
async function yourKeywords(ownerId, connectionId, { range = '30d' } = {}) {
  const key = TRAFFIC_RANGES.includes(range) ? range : '30d';
  const { data } = await require('../analytics/analytics.service').getAnalytics(connectionId, ownerId, { range: key });
  const listings = data.listings || [];
  return {
    status: data.status,
    range: data.range,
    listings: listings.length,
    measured: listings.filter((l) => l.impressions !== null && l.impressions !== undefined).length,
    keywords: data.status === 'ok' ? keywords.fromTraffic(listings) : [],
  };
}

/** Test hook: how long a subject waits for its sold counts before answering with what's read. */
function _quickMs(ms = QUICK_MS) {
  quickMs = ms;
}
/** Test hook: resolves once no sold-count job is running. */
async function _soldSettled() {
  while (soldJobs.size) await Promise.all([...soldJobs.values()]).catch(() => {});
}

module.exports = {
  _quickMs,
  _soldSettled,
  explore,
  siteKeywords,
  rankChildren,
  rankingOf,
  review,
  refreshRecent,
  suggest,
  start,
  watches,
  addWatch,
  removeWatch,
  readDueWatches,
  pruneReads,
  yourKeywords,
  subjectOf,
  DiscoverError,
  READS_FIRST,
};
