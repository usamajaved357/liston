const crypto = require('crypto');
const logger = require('../../utils/logger');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const trading = require('../ebay/api/ebay.trading');
const taxonomy = require('../ebay/api/ebay.taxonomy');
const browseResearch = require('../ebay/browse-research');
const focusing = require('./discover-focus');
const browseUsage = require('../ebay/browse-usage');
const governor = require('../ebay/request-governor');
const marketplaces = require('../ebay/marketplaces');
const analyticsDays = require('../analytics/analytics-days');
const delivery = require('../research/delivery');
const researchService = require('../research/research.service');
const researchStats = require('../research/research-stats');
const repo = require('./discover.repository');
const budget = require('./discover-budget');
const scoring = require('./discover-scoring');
const keywords = require('./discover-keywords');
const trends = require('./discover-trends');
const compliance = require('./discover-compliance');
const products = require('./discover-products');
const personal = require('./discover-personal');
const mirror = require('../ebay/ebay-mirror.repository');
const advisor = require('../ai-generation/research-advisor.service');
const researchAnalysis = require('../research/research-analysis');

// Discover: finding what to hunt, on the Hunting page. A category or a
// keyword is scanned (one Browse search for its leading live listings,
// delivered to the account's country, kept a day and shared by every
// account on the site), and the leading listings' sold counts are read
// through Trading GetItem (the total and per option, one read per listing
// per day, stored, so the day's reads are shared and a watched listing's
// recent sales are the difference between two days). From those: how fast
// it sells, how crowded it is, what buyers pay, whether a seller delivering
// like this account can compete, the keywords of the titles that sell, and
// its subcategories ranked the same way. Watched categories and keywords
// are read again every night (discover.scheduler).

const SCAN_TTL_MS = 20 * 60 * 60 * 1000;
const SCAN_SIZE = 200; // eBay's page: one Browse call either way
const READS_FIRST = 50; // sold counts read when a top-level category opens
const READS_DEEP = 100; // a subcategory or a keyword: more, for more products
const READS_STEP = 50; // "Load more products"
const READS_MAX = 300; // 200 of the leading listings at most; the rest only for the hunter's filters (discover-focus)
// A reading this recent stands (sold counts barely move in a day; the nightly refresh reads opened ones again).
const READ_FRESH_DAYS = 1;
const CHILD_READS = 8; // per subcategory when ranking them (enough for its keywords)
const CHILD_KEYWORDS = 4; // shown under each ranked subcategory
const KEYWORDS_TOP = 24; // keywords on a top-level category or a keyword
const KEYWORDS_MAX = 48; // deeper in, more: a leaf category shows the most
const PRODUCTS_SHOWN = 150; // products on a subject's page (the page filters them)
const WINNERS_SCANS = 200; // scans in the Winners pool (newest first)
const WINNERS_DAYS = 30; // a scan older than this is out of the pool
const BEST_CATEGORIES_MAX = 100; // explored categories the Categories tab ranks
const WINNERS_PER_SCAN = 40; // products a subject adds to the pool: enough that a hunter's filters find the ones past its top few
const WINNERS_SHOWN = 60; // a page of Winners; "Load more" asks for more, up to WINNERS_MAX
const WINNERS_MAX = 300;
const POOL_KEYWORDS_SHOWN = 60; // a page of the site's keywords
const POOL_KEYWORDS_MAX = 400;
const WINNERS_CACHE_MS = 5 * 60 * 1000;
const MAX_CHILDREN = 12; // subcategories ranked at once, busiest first
const READ_CONCURRENCY = 6;
// A subject answers within this with what's known; the rest of its sold counts are read on, and the page asks again.
const QUICK_MS = 2500;
let quickMs = QUICK_MS;
const soldJobs = new Map(); // sold-count reads under way, by site, subject, reads asked and account

/**
 * The subject's sold counts, read in the background: the job's answer if
 * it's done within QUICK_MS, else what's been read so far ({ reads,
 * reading: true }) while the job reads on and saves each one. One job per
 * subject, reads asked and account, whoever asks.
 */
async function soldSoFar(ownerId, connectionId, ctx, listings, max, subjectKey) {
  const key = `${ctx.site.id}:${subjectKey}:${max}:${connectionId}`;
  let job = soldJobs.get(key);
  if (!job) {
    job = readSold(ownerId, connectionId, ctx, listings, { max }).finally(() => soldJobs.delete(key));
    soldJobs.set(key, job);
  }
  const done = await Promise.race([job, new Promise((resolve) => setTimeout(() => resolve(null), quickMs))]);
  if (done) return done;
  const reads = await repo.latestReads(ctx.site.id, listings.map(idOf), analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  return { reads, stopped: false, reading: true };
}
const LISTINGS_SHOWN = 60;
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
    throw new DiscoverError(`Discover has used today's ${left.limits.browse} eBay searches. They reset at ${resetText(left.resetAt)}.`, 429);
  }
  const found = await browseUsage.as('discover', () =>
    browseResearch.searchListings({ q: subject.q, categoryId: subject.categoryId, marketplaceId: site.id, country: site.country, limit: SCAN_SIZE })
  );
  await budget.spend('browse', found.calls);
  const value = { total: found.total, listings: found.items.map(slim), breakdown: found.breakdown };
  await repo.saveScan(site.id, subject.key, value);
  forgetWinners();
  return { ...value, taken_at: new Date().toISOString(), fresh: true };
}

// ---- sold counts ----------------------------------------------------------------------

const idOf = (l) => String(l.legacyItemId || l.itemId);
// Reads under way, by site, listing and day (their promise).
const pendingReads = new Map();

/**
 * The sold counts of the first `max` listings: today's reading where there
 * is one, else a Trading GetItem read with the account's token (background
 * priority, within Discover's share), else the latest reading of the last
 * week. Returns { reads: Map id -> reading, stopped } — stopped when the
 * day's reads ran out before every listing was read.
 */
async function readSold(ownerId, connectionId, ctx, listings, { max }) {
  const { site, day } = ctx;
  const wanted = listings.slice(0, max).map(idOf);
  const reads = await repo.latestReads(site.id, listings.map(idOf), analyticsDays.addDays(day, -READ_FALLBACK_DAYS));
  // Read today or yesterday: it stands, so opening more spends the day's reads on listings not read yet.
  const fresh = new Set([day, ...Array.from({ length: READ_FRESH_DAYS }, (_, i) => analyticsDays.addDays(day, -(i + 1)))]);
  const need = wanted.filter((id) => !fresh.has(reads.get(id)?.day));
  if (!need.length) return { reads, stopped: false };
  const left = await budget.left();
  if (left.trading <= 0 || left.tradingPaused) return { reads, stopped: true };

  let calls = 0;
  // Held back by the governor (the shared allowance needs the rest).
  let halted = false;
  const queue = need.slice(0, left.trading);
  // An account whose eBay sign-in fails (needs reconnecting) still shows the
  // listings, with the sold counts already read.
  let signInFailed = false;
  await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials) => {
    const token = await ebayService.ensureValidAccessToken(credentials);
    let next = 0;
    async function worker() {
      while (next < queue.length && !halted) {
        const id = queue[next++];
        // A listing another request is reading right now: wait for that read.
        const key = `${site.id}:${id}:${day}`;
        const mine = !pendingReads.has(key);
        if (mine) {
          const reading = governor
            .withContext({ priority: 'background', connectionId }, () => trading.getItemSales(token.accessToken, id, { siteId: site.siteId }))
            .then(async (read) => {
              await repo.saveRead(site.id, day, { itemId: id, sold: read.sold, options: read.options, categoryId: read.categoryId, startedAt: read.startedAt, brand: read.brand });
              return read;
            });
          pendingReads.set(key, reading);
          reading.catch(() => {}).finally(() => pendingReads.delete(key));
        }
        try {
          const read = await pendingReads.get(key);
          if (mine) calls += 1;
          reads.set(id, { item_id: id, day, sold: read.sold, options: read.options, category_id: read.categoryId, started_at: read.startedAt, brand: read.brand || null });
        } catch (err) {
          if (err instanceof governor.GovernorError) {
            // The shared allowance needs what's left for orders and listings.
            halted = true;
            return;
          }
          if (mine) {
            calls += 1;
            logger.warn('Discover: sold count not read', { itemId: id, error: err.message });
          }
        }
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    return { credentials: token.credentials, credentialsChanged: token.credentialsChanged };
  }).catch((err) => {
    signInFailed = true;
    logger.warn('Discover: sold counts not read with this account', { connectionId, error: err.message });
  });
  await budget.spend('trading', calls);
  if (calls) forgetWinners();
  return { reads, stopped: halted || signInFailed || queue.length < need.length, signInFailed };
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
      options: read?.options || null,
      readDay: read?.day || null,
      // Trading's start time is the listing's; Browse's creation date is the fallback.
      createdAt: read?.started_at ? new Date(read.started_at).toISOString() : l.createdAt,
    };
  });
}

const OPTIONS_SHOWN = 6;

function shown(l, country, now = Date.now()) {
  const options = Array.isArray(l.options) ? l.options : null;
  return {
    itemId: idOf(l),
    title: l.title,
    image: l.image,
    url: l.url,
    price: l.price,
    shipping: l.shipping,
    landed: l.landed ?? null,
    seller: l.seller,
    overseas: Boolean(l.location?.country && country && l.location.country !== country),
    country: l.location?.country || null,
    category: l.category,
    categoryId: l.categoryId,
    createdAt: l.createdAt,
    daysLive: researchStats.daysLive(l, now),
    delivery: l.delivery,
    sold: l.sold,
    soldPerMonth: l.soldPerMonth ?? null,
    options: options ? options.slice(0, OPTIONS_SHOWN) : null,
    optionCount: options ? options.length : 0,
    readDay: l.readDay,
    recent: l.recent || null,
  };
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
 * opportunity, listings (selling now: read ones fastest first), keywords,
 * children (subcategories, ranked once scanned), watch, account, budget }.
 * `reads`: how many leading listings' sold counts to read (25 a step).
 */
// `focus`: the hunter's filters when they loaded more (discover-focus): what's read beyond the first reads.
function explore(ownerId, connectionId, input, { reads: wantedReads = READS_FIRST, canSeeTraffic = false, focus = null } = {}) {
  const subject = subjectOf(input);
  const max = Math.min(READS_MAX, Math.max(READS_FIRST, Number(wantedReads) || READS_FIRST));
  return once(`explore:${connectionId}:${subject.key}:${max}:${canSeeTraffic}:${focusing.signature(focus)}`, () => exploreNow(ownerId, connectionId, subject, max, { canSeeTraffic, focus }));
}

// ---- more listings for the hunter's filters ------------------------------------------

// eBay searches narrowed to the filters, page by page, kept as scans of their own ("f:<subject>|<filters>",
// as long as a scan): the Winners pool takes their products (never the subject's figures), and a
// restart doesn't search again. A search costs one of Discover's day's searches.
const focusKey = (subject, focus) => `f:${subject.key}|${crypto.createHash('sha1').update(focusing.signature(focus)).digest('hex').slice(0, 12)}`;

/**
 * The listings eBay has for the subject within the filters, beyond its
 * leading ones: the pages searched so far, one more when `want` more are
 * needed and eBay has them (within Discover's searches). { listings,
 * takenAt, more }: more when eBay has further pages.
 */
async function focusListings(ctx, subject, focus, { exclude, want }) {
  const key = focusKey(subject, focus);
  const row = await repo.getScan(ctx.site.id, key);
  const fresh = row && Date.now() - new Date(row.taken_at).getTime() < SCAN_TTL_MS;
  const kept = fresh ? { listings: row.listings || [], pages: row.breakdown?.pages || 1, done: Boolean(row.breakdown?.done), takenAt: row.taken_at } : { listings: [], pages: 0, done: false, takenAt: new Date().toISOString() };
  const unseen = () => {
    const seen = new Set(exclude);
    return kept.listings.filter((l) => !seen.has(idOf(l)) && seen.add(idOf(l)));
  };
  if (want > 0 && !kept.done && unseen().length < want && (await budget.left()).browse > 0) {
    const search = focusing.searchOf(subject, focus, { currency: ctx.site.currency });
    const offset = kept.pages * SCAN_SIZE;
    const run = (aspectFilter) =>
      browseUsage.as('discover', () =>
        browseResearch.searchListings({ q: search.q, categoryId: subject.categoryId, marketplaceId: ctx.site.id, country: ctx.site.country, limit: SCAN_SIZE, offset, filter: search.filter, aspectFilter })
      );
    // eBay refusing the brand filter (a category without a Brand aspect): the same search without it.
    const found = await run(search.aspectFilter).catch((err) => (search.aspectFilter ? run(undefined) : Promise.reject(err)));
    await budget.spend('browse', found.calls);
    const had = new Set(kept.listings.map(idOf));
    kept.listings = [...kept.listings, ...found.items.map(slim).filter((l) => !had.has(idOf(l)))];
    kept.pages += 1;
    kept.done = found.items.length < SCAN_SIZE || offset + SCAN_SIZE >= found.total;
    kept.takenAt = new Date().toISOString();
    await repo.saveScan(ctx.site.id, key, { total: found.total, listings: kept.listings, breakdown: { pages: kept.pages, done: kept.done } });
    forgetWinners();
  }
  return { listings: unseen(), takenAt: kept.takenAt, more: !kept.done };
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
 * What a subject reads, in order, up to `max`: its leading listings (the
 * kept scan, searched again when it holds fewer than asked), the first
 * reads in eBay's order (the subject's figures stand on them), then, with
 * the hunter's filters (`focus`), only listings that can pass them: the
 * leading ones first, then more from eBay searched within the filters.
 * Without filters, the leading listings in order. Listings that would break
 * eBay's rules are hidden, never read.
 */
async function readPlan(ctx, subject, info, focus, max) {
  let scanRow = await scan(ctx.site, subject);
  // Asked for more than a kept scan holds (one taken before scans were 200): searched again, when eBay has more.
  if (max > scanRow.listings.length && scanRow.listings.length < SCAN_SIZE && scanRow.total > scanRow.listings.length) {
    scanRow = await scan(ctx.site, subject, { force: true }).catch(() => scanRow);
  }
  // The AI's brand/VeRO and restricted reading, when today's is kept (else the page asks for it).
  const advice = await advisor.keptAdvice(adviceKey(ctx.site, subject)).catch(() => null);
  // Listings that would break eBay's rules (a restricted item, a VeRO brand as the product) are
  // hidden, not read, and not counted: Discover never points anyone at them.
  const brandNames = veroBrands(advice);
  const { kept, hidden } = compliance.partition(scanRow.listings, brandNames);
  const first = firstReads(subject, info);
  const scanBrands = scanRow.breakdown?.brands || [];
  const scanBrandTotal = scanBrands.reduce((sum, b) => sum + b.count, 0) || scanRow.total || 1;
  const knownBrands = [...brandNames, ...scanBrands.filter((b) => !b.unbranded && b.count / scanBrandTotal >= 0.05).map((b) => b.name)];
  const fits = (takenAt) => (l) => focusing.passes(l, focus, { account: ctx.account, brands: knownBrands, takenAt: new Date(takenAt).getTime() });
  const rest = focus ? kept.slice(first).filter(fits(scanRow.taken_at)) : kept.slice(first);
  let readOrder = [...kept.slice(0, first), ...rest];
  let found = { listings: [], takenAt: null, more: false };
  if (focus) {
    found = await focusListings(ctx, subject, focus, { exclude: kept.map(idOf), want: max - readOrder.length }).catch((err) => {
      logger.warn('Discover: no more listings searched for the filters', { subject: subject.key, error: err.message });
      return found;
    });
    const extra = compliance.partition(found.listings, brandNames).kept.filter(fits(found.takenAt || Date.now()));
    found = { ...found, listings: extra };
    readOrder = [...readOrder, ...extra];
  }
  return { scanRow, advice, brandNames, kept, hidden, rest, readOrder, found, passes: (l) => fits(scanRow.taken_at)(l) };
}

// How many sold counts a subject reads on opening: the deeper (a keyword, a subcategory), the more products it's worth.
const firstReads = (subject, info) => (subject.kind === 'keyword' || info.path.length > 1 ? READS_DEEP : READS_FIRST);

async function exploreNow(ownerId, connectionId, subject, asked, { canSeeTraffic, focus = null }) {
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  const max = Math.max(asked, firstReads(subject, info));
  const traffic = canSeeTraffic && subject.kind === 'keyword' ? ownTraffic(ownerId, connectionId, subject.q) : Promise.resolve(null);
  const { scanRow, advice, brandNames, kept, hidden, rest, readOrder, found } = await readPlan(ctx, subject, info, focus, max);
  // Opened: it's in the nightly shared refresh for a few days, read with this account.
  await repo.touchScan(ctx.site.id, subject.key, connectionId).catch(() => {});
  // Answered within a moment with what's read; the rest read on while the page asks again.
  const sold = await soldSoFar(ownerId, connectionId, ctx, readOrder, max, `${subject.key}${focus ? `|${focusing.signature(focus)}` : ''}`);
  // Listings read before under other filters stay read: their products don't drop off the page.
  const others = [...kept, ...found.listings].map(idOf).filter((id) => !sold.reads.has(id));
  if (others.length) {
    const earlier = await repo.latestReads(ctx.site.id, others, analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
    for (const [id, read] of earlier) sold.reads.set(id, read);
  }
  const listings = scoring.withPace(placed({ ...scanRow, listings: kept }, ctx, sold.reads));
  // The listings found for the filters: products only, never the subject's figures.
  const extraListings = found.listings.length ? scoring.withPace(placed({ taken_at: found.takenAt, listings: found.listings }, ctx, sold.reads)) : [];
  const wantedIds = readOrder.slice(0, max).map(idOf);
  const readOf = wantedIds.filter((id) => sold.reads.get(id)?.day === ctx.day || sold.reads.get(id)?.day === analyticsDays.addDays(ctx.day, -1)).length;

  const f = scoring.figures(listings, { total: scanRow.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
  // Two weeks of readings: recent sales per listing, and the subject's sales day by day.
  const history = await repo.readsSince(ctx.site.id, [...listings, ...extraListings].map(idOf), analyticsDays.addDays(ctx.day, -15));
  const recent = trends.recentSales(history);
  const summary = trends.summarise(scoring.sellingNow(listings), recent);
  // Products from the leading listings and those found for the filters together.
  const productSource = extraListings.length ? trends.summarise(scoring.sellingNow([...listings, ...extraListings]), recent).listings : summary.listings;
  const [children, watch] = await Promise.all([childRows(ctx, info, scanRow, brandNames), repo.findWatch(connectionId, subject.kind, subject.value)]);
  const brands = scanRow.breakdown?.brands || [];
  // Brands worth flagging in a keyword: the VeRO ones, and brands on at least 5% of the listings
  // (sellers type all sorts into eBay's brand field, "Kitchen" included).
  const brandTotal = brands.reduce((sum, b) => sum + b.count, 0) || scanRow.total || 1;
  const flagNames = [...brandNames, ...brands.filter((b) => !b.unbranded && b.count / brandTotal >= 0.05).map((b) => b.name)];
  const flagged = (text) => compliance.flagOf(text, flagNames);
  const country = ctx.site.country;

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
    // A keyword: your own listings with it, their traffic and sales (Analytics, 30 days).
    yourTraffic: await traffic,
    recent: summary.recent,
    rising: summary.rising.map((l) => shown(l, country)),
    // Its products (the same product under several sellers grouped), best to hunt first, with why.
    products: await subjectProducts(ownerId, connectionId, ctx, products.productsOf(productSource, { subject: subject.q || info.name, currency: ctx.site.currency, accountKnown: Boolean(ctx.account), limit: PRODUCTS_SHOWN }).filter((p) => p.read > 0)),
    listings: summary.listings.slice(0, LISTINGS_SHOWN).map((l) => ({ ...shown(l, country), flag: flagged(l.title) })),
    // The subject's own words (its category name, or the keyword) aren't news. More the deeper in.
    keywords: keywords.fromListings(listings, { query: subject.q || info.name, limit: keywordLimit(info) }).map((k) => ({ ...k, flag: flagged(k.term) })),
    brands: brands.slice(0, 8),
    // Before hunting: eBay's word filter, restricted items, brands and VeRO — over every leading
    // listing, the hidden ones included, so it says what was hidden and why.
    compliance: compliance.check({ name: info.name, listings: scanRow.listings, brands, total: scanRow.total, advice, hidden }),
    // What you'd sell at and the most a supplier may cost for your target return (your pricing settings).
    price: researchAnalysis.priceAdvice(listings, { pricing: ctx.pricing }),
    // A keyword: the categories its listings sit in, to explore next.
    categories: subject.kind === 'keyword' ? (scanRow.breakdown?.categories || []).slice(0, 8) : [],
    children: children.map((c) => ({ ...c, flag: flagged(c.name) })),
    reads: {
      asked: max,
      read: f.demand.read,
      // The leading listings (the figures' own), and those read beyond them for the filters.
      of: kept.length,
      focused: focus ? extraListings.filter((l) => l.sold !== null).length + rest.filter((l) => sold.reads.has(idOf(l))).length : 0,
      more: max < READS_MAX && (readOrder.length > max || Boolean(focus && found.more) || (!focus && scanRow.listings.length < SCAN_SIZE && scanRow.total > scanRow.listings.length)),
      stopped: sold.stopped,
      signInFailed: Boolean(sold.signInFailed),
      step: READS_STEP,
      // Still reading sold counts in the background: how far it's got (the page asks again until done).
      reading: Boolean(sold.reading),
      progress: { done: readOf, of: wantedIds.length },
    },
    watch: watch ? { id: watch.id } : null,
    // Subcategories being ranked right now: the page asks again until done.
    ranking: subject.categoryId ? rankingOf(connectionId, subject.categoryId) : null,
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    budget: await budget.left(),
  };
}

// A subject's products scored for this account (its taste, how crowded each is) and marked with what
// the owner already has, best first.
async function subjectProducts(ownerId, connectionId, ctx, list) {
  const [taste, crowd, owned, safety] = await Promise.all([
    tasteFor(connectionId),
    repo.othersHunting(ownerId, list.flatMap((p) => p.itemIds), new Date(Date.now() - personal.CROWD_DAYS * 86400000)),
    ownedFor(ownerId),
    safetyFor(ownerId),
  ]);
  return list
    .map((p) => personal.personalise(p, { taste, crowd: personal.crowdOf(p, crowd), currency: ctx.site.currency }))
    .map((p) => ({ ...p, mine: personal.ownedOf(p, owned), risk: compliance.productRisk(p, safety) }))
    .sort((a, b) => b.score - a.score || b.perMonth - a.perMonth);
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
  // With the AI's brands known, more listings may be hidden: the page opens the subject again.
  const { hidden } = compliance.partition(scanRow.listings, veroBrands(advice));
  return { compliance: compliance.check({ name: info.name, listings: scanRow.listings, brands, total: scanRow.total, advice, hidden }), checked: Boolean(advice), hidden: hidden.count };
}

// ---- winners: the best products across everything explored on the site ----------------

const winnersCache = new Map(); // per site and account: the scored pool
const poolCache = new Map(); // per site: what's loaded and grouped, shared by every account
// New scans or readings change the pool: the next Winners request builds it again.
const forgetWinners = () => {
  winnersCache.clear();
  poolCache.clear();
};

/**
 * A site's product pool, shared by every Liston account on the site: every
 * scan from the last month (anyone's), its listings that may be shown, with
 * their readings and recent sales. Loaded once and kept five minutes; what
 * depends on the account (delivery fit, the score) is worked out per account
 * from it, so a second account costs no database reads.
 */
async function sitePool(site, day) {
  const hit = poolCache.get(site.id);
  if (hit && Date.now() - hit.at < WINNERS_CACHE_MS) return hit.value;
  const scans = await repo.scansForSite(site.id, new Date(Date.now() - WINNERS_DAYS * 86400000), WINNERS_SCANS);
  const ids = [...new Set(scans.flatMap((s) => s.listings.map(idOf)))];
  const [reads, history] = await Promise.all([
    repo.latestReads(site.id, ids, analyticsDays.addDays(day, -READ_FALLBACK_DAYS)),
    repo.readsSince(site.id, ids, analyticsDays.addDays(day, -(trends.WEEK + 1))),
  ]);
  const recent = trends.recentSales(history);
  const subjects = [];
  for (const s of scans) {
    // A search within a hunter's filters ("f:<subject>|<filters>", discover-focus): its products join
    // the pool under its subject, never the subject's figures or keywords.
    const focused = s.subject.startsWith('f:');
    const key = focused ? s.subject.slice(2, s.subject.lastIndexOf('|')) : s.subject;
    const isCategory = key.startsWith('c:');
    const value = key.slice(2);
    const path = isCategory ? await taxonomy.getCategoryPath(site.id, value).catch(() => []) : [];
    if (isCategory && !path.length) continue;
    const name = isCategory ? path[path.length - 1].name : value;
    // A restricted subject, or one under a restricted category (Electronic Smoking…): out.
    if (compliance.termsIn(isCategory ? path.map((p) => p.name).join(' ') : name).restricted.length) continue;
    const { kept } = compliance.partition(s.listings);
    subjects.push({ scan: { ...s, listings: kept }, focused, from: { kind: isCategory ? 'category' : 'keyword', value, name, path: isCategory ? path.slice(0, -1).map((p) => p.name) : [] } });
  }
  const value = { subjects, reads, recent, pool: { subjects: scans.filter((s) => !s.subject.startsWith('f:')).length, listings: ids.length } };
  poolCache.set(site.id, { at: Date.now(), value });
  return value;
}

// The account's taste (its categories and the prices it sells at) and the owner's things (what they
// already have), each read once a minute at most.
const TASTE_CACHE_MS = 60 * 1000;
const tasteCache = new Map();
const ownedCache = new Map();
async function tasteFor(connectionId) {
  const hit = tasteCache.get(connectionId);
  if (hit && Date.now() - hit.at < TASTE_CACHE_MS) return hit.value;
  const [categories, prices] = await Promise.all([repo.ownCategories(connectionId, 50).catch(() => []), repo.livePrices(connectionId).catch(() => [])]);
  const value = personal.tasteOf({ categoryIds: categories.map((c) => c.id), prices });
  tasteCache.set(connectionId, { at: Date.now(), value });
  return value;
}
async function ownedFor(ownerId) {
  const hit = ownedCache.get(ownerId);
  if (hit && Date.now() - hit.at < TASTE_CACHE_MS) return hit.value;
  const [live, hunts, listings] = await Promise.all([mirror.ownerLiveListings(ownerId).catch(() => []), repo.ownerHunts(ownerId), repo.ownerListonCompetitors(ownerId)]);
  const value = personal.ownedIndex({ live, hunts, listings });
  ownedCache.set(ownerId, { at: Date.now(), value });
  return value;
}
// The owner's takedown history for productRisk: eBay's refusals of their drafts and their team's brand-risk rejections.
const safetyCache = new Map();
async function safetyFor(ownerId) {
  const hit = safetyCache.get(ownerId);
  if (hit && Date.now() - hit.at < TASTE_CACHE_MS) return hit.value;
  // Required here: listings reads Discover's neighbours, and this is the only use.
  const listingRepository = require('../listings/listing.repository');
  const [refusals, rejected] = await Promise.all([listingRepository.findPolicyRefusals(ownerId).catch(() => []), repo.ownerBrandRejections(ownerId).catch(() => [])]);
  const value = { refusals, rejected };
  safetyCache.set(ownerId, { at: Date.now(), value });
  return value;
}
/** Forgets what's kept about an owner (after they hunt or list something, so Discover says so at once). */
function forgetOwner(ownerId) {
  ownedCache.delete(ownerId);
  safetyCache.delete(ownerId);
}

/**
 * The product pool for an account: the site's pool grouped into products
 * and scored for this account (its delivery), best first. Kept five minutes.
 */
async function winnersPool(ownerId, connectionId) {
  const ctx = await context(ownerId, connectionId);
  const cacheKey = `${ctx.site.id}:${connectionId}`;
  const hit = winnersCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WINNERS_CACHE_MS) return hit.value;
  const site = await sitePool(ctx.site, ctx.day);
  const seen = new Set();
  const pool = [];
  // The keywords of the titles that sell under each subject, and each keyword searched with its own market.
  const found = [];
  const searched = [];
  // Every category explored at any depth, with what its leading listings sell a month: the best-selling ones.
  const categoryRows = [];
  let read = 0;
  for (const { scan: s, from, focused } of site.subjects) {
    const listings = trends.summarise(scoring.withPace(placed(s, ctx, site.reads)), site.recent).listings;
    read += listings.filter((l) => l.soldPerMonth !== null).length;
    const where = { kind: from.kind, value: from.value, name: from.name };
    // A search within filters: its products only (below).
    const own = !focused;
    // Across the whole site a lone word ("white", "plus") means nothing without its category, so the
    // site's list keeps phrases of two words or more whose titles sell at least as well as the rest.
    const subjectKeywords = own ? keywords.fromListings(listings, { query: from.name, limit: KEYWORDS_TOP }) : [];
    for (const k of subjectKeywords) {
      if (k.words >= 2 && (k.lift ?? 0) >= 1) found.push({ term: k.term, perMonth: k.perMonth, sold: k.sold, salesShare: k.salesShare, lift: k.lift, listings: k.listings, from: where });
    }
    if (own && from.kind === 'category') {
      const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
      if (f.demand.read) {
        const o = scoring.opportunity(f, { currency: ctx.site.currency });
        const top = subjectKeywords.find((k) => k.words >= 2) || subjectKeywords[0] || null;
        categoryRows.push({
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
        });
      }
    }
    if (own && from.kind === 'keyword') {
      const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
      if (f.demand.read) {
        const o = scoring.opportunity(f, { currency: ctx.site.currency });
        searched.push({ term: from.value, monthlySales: Math.round(f.demand.monthlySales), live: s.total, score: o.score, band: o.band });
      }
    }
    for (const p of products.productsOf(listings, { subject: from.name, currency: ctx.site.currency, accountKnown: Boolean(ctx.account), limit: WINNERS_PER_SCAN })) {
      // The same product found under two subjects: once, where it scored best.
      if (p.read === 0 || p.itemIds.some((id) => seen.has(id))) continue;
      p.itemIds.forEach((id) => seen.add(id));
      pool.push({ ...p, from });
    }
  }
  // Scored for this account: its categories and usual prices, and how many other Liston sellers hunt each one lately.
  const [taste, crowd] = await Promise.all([tasteFor(connectionId), repo.othersHunting(ownerId, pool.flatMap((p) => p.itemIds), new Date(Date.now() - personal.CROWD_DAYS * 86400000))]);
  const scored = pool.map((p) => personal.personalise(p, { taste, crowd: personal.crowdOf(p, crowd), currency: ctx.site.currency }));
  scored.sort((a, b) => b.score - a.score || b.perMonth - a.perMonth);
  const blocked = (term) => compliance.termsIn(term).restricted.length > 0 || Boolean(compliance.veroBrandIn(term));
  const siteKeywords = keywords.poolKeywords(found, searched, { isBlocked: blocked }).sort((a, b) => b.perMonth - a.perMonth);
  // How many of the pool's products each category holds, and how many of those are new or rising
  // (trending: eBay doesn't share buyers' search volume, so momentum stands in); the best-selling first.
  const productCount = new Map();
  const risingCount = new Map();
  for (const p of pool) {
    if (p.from.kind !== 'category') continue;
    productCount.set(p.from.value, (productCount.get(p.from.value) || 0) + 1);
    if (p.momentum === 'rising' || p.momentum === 'new') risingCount.set(p.from.value, (risingCount.get(p.from.value) || 0) + 1);
  }
  const categories = categoryRows
    .map((c) => ({ ...c, products: productCount.get(c.id) || 0, rising: risingCount.get(c.id) || 0 }))
    .sort((a, b) => b.monthlySales - a.monthlySales || b.score - a.score);
  const value = { products: scored, keywords: siteKeywords, categories, pool: { ...site.pool, read }, market: marketplaces.summary(ctx.site.id), account: ctx.account ? { min: ctx.account.min, max: ctx.account.max } : null, at: new Date().toISOString() };
  winnersCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

const SELLER_SIZES = { small: [0, 1000], medium: [1000, 10000], large: [10000, Infinity] };

/**
 * Winners: the best products across everything explored on the site, for
 * this account, filtered the way a hunter filters — delivery it can match,
 * a price band, a minimum of sales a month, new lately — and sorted.
 */
async function winners(ownerId, connectionId, { q = '', fit = false, priceMin = null, priceMax = null, brand = 'any', rating = 'any', size = 'any', listedWithin = 0, minSales = 0, newOnly = false, sort = 'score', mine = 'show', safety = 'safe', limit = WINNERS_SHOWN } = {}) {
  const all = await winnersPool(ownerId, connectionId);
  const words = wordsOfQuery(q);
  const sizeBand = SELLER_SIZES[size] || null;
  // What the owner already has of each (a similar title is only marked: it may be another product).
  // And its takedown risk: a VeRO brand specific, eBay's refusals of the owner's drafts, the team's brand-risk rejections.
  const [owned, safetyHistory] = await Promise.all([ownedFor(ownerId), safetyFor(ownerId)]);
  const marked = all.products.map((p) => ({ ...p, mine: personal.ownedOf(p, owned), risk: compliance.productRisk(p, safetyHistory) }));
  const isMine = (p) => Boolean(p.mine && p.mine.kind !== 'similar');
  let mineHidden = 0;
  let riskHidden = 0;
  let list = marked.filter((p) => {
    if (words.length && !words.every((w) => p.name.toLowerCase().includes(w))) return false;
    if (fit && p.delivery.known && p.delivery.share < 40) return false;
    if (priceMin !== null && (!p.price || p.price.median < priceMin)) return false;
    if (priceMax !== null && (!p.price || p.price.median > priceMax)) return false;
    // Unbranded: no named brand on its listings (a brand not read yet counts as none; VeRO brands are hidden before this).
    if (brand === 'unbranded' && p.branded === true) return false;
    if (brand === 'branded' && p.branded !== true) return false;
    // Listed lately: its youngest listing with a sold count is this many days old at most.
    if (listedWithin && !(p.newestDays !== null && p.newestDays <= listedWithin)) return false;
    if (rating === 'top' && !(p.seller.percentage !== null && p.seller.percentage >= 99)) return false;
    if (rating === 'good' && !(p.seller.percentage !== null && p.seller.percentage >= 98)) return false;
    if (rating === 'weak' && !(p.seller.percentage !== null && p.seller.percentage < 98)) return false;
    if (sizeBand && !(p.smallestSellerScore !== null && p.smallestSellerScore >= sizeBand[0] && p.smallestSellerScore < sizeBand[1])) return false;
    if (minSales && p.perMonth < minSales) return false;
    if (newOnly && p.momentum !== 'new' && p.momentum !== 'rising') return false;
    // Last, so the hidden counts are only what the other filters would have shown.
    if (safety === 'safe' && p.risk) {
      riskHidden += 1;
      return false;
    }
    if (mine === 'hide' && isMine(p)) {
      mineHidden += 1;
      return false;
    }
    return true;
  });
  const by = {
    score: (a, b) => b.score - a.score || b.perMonth - a.perMonth,
    sales: (a, b) => b.perMonth - a.perMonth,
    rising: (a, b) => (b.lift ?? 0) - (a.lift ?? 0) || b.perMonth - a.perMonth,
    new: (a, b) => (a.newestDays ?? 1e9) - (b.newestDays ?? 1e9) || b.perMonth - a.perMonth,
    price: (a, b) => (b.price?.median ?? 0) - (a.price?.median ?? 0),
  };
  list = [...list].sort(by[sort] || by.score);
  return { products: list.slice(0, Math.min(WINNERS_MAX, Math.max(1, limit))), matched: list.length, mineHidden, riskHidden, pool: all.pool, market: all.market, account: all.account, at: all.at };
}

/**
 * The keywords worth hunting across everything explored on the site, for
 * this account: each with its sales a month, how much better its titles sell
 * than the rest (lift), and — once it's been searched — its own market (live
 * listings, opportunity). Searched by words, sorted by sales, lift,
 * opportunity or how many categories share it, a page at a time. eBay
 * doesn't share buyers' search volume, so demand is the sales themselves.
 */
// ---- more for the Products tab's filters ------------------------------------------------

const MORE_SUBJECTS = 3; // explored categories and keywords read further per "Find more"
// A subject with nothing left to read for some filters (its leading listings read, eBay's filtered
// search to its end): skipped for them until its scan is taken again.
const exhausted = new Map(); // `${site}:${subject}:${signature}` -> when

/**
 * "Find more products for these filters" on the Products tab: more
 * listings that can pass the hunter's filters, read in the explored
 * categories and keywords most likely to have them — where the matching
 * products come from, then the best-selling — the next READS_STEP of each
 * in up to MORE_SUBJECTS of them, eBay searched within the filters when
 * their leading listings run out (the same as a subject's Load more). Their
 * products join the pool. { read, subjects: [name], more, signInFailed,
 * stopped } (stopped: the day's sold-count reads used up).
 */
function findMore(ownerId, connectionId, filters = {}) {
  const focus = focusing.focusOf({ ...filters, fq: filters.q });
  return once(`more:${connectionId}:${focusing.signature(focus)}`, () => findMoreNow(ownerId, connectionId, filters, focus));
}

async function findMoreNow(ownerId, connectionId, filters, focus) {
  const ctx = await context(ownerId, connectionId);
  const [pool, matching] = await Promise.all([winnersPool(ownerId, connectionId), winners(ownerId, connectionId, { ...filters, limit: WINNERS_MAX })]);
  // Where the products that match come from (most first), then the best-selling categories explored.
  const bySubject = new Map();
  for (const p of matching.products) {
    const k = `${p.from.kind}:${p.from.value}`;
    bySubject.set(k, { from: p.from, n: (bySubject.get(k)?.n || 0) + 1 });
  }
  const order = [...bySubject.values()].sort((a, b) => b.n - a.n).map((x) => x.from);
  for (const c of pool.categories) if (!bySubject.has(`category:${c.id}`)) order.push({ kind: 'category', value: c.id, name: c.name });
  const signature = focusing.signature(focus);
  const fresh = (read) => Boolean(read) && (read.day === ctx.day || read.day === analyticsDays.addDays(ctx.day, -1));
  const names = [];
  let read = 0;
  let more = false;
  // Why it stopped short: the account's eBay sign-in failing, or the day's sold-count reads used up.
  let signInFailed = false;
  let stopped = false;
  for (const from of order) {
    if (names.length >= MORE_SUBJECTS) {
      more = true;
      break;
    }
    const subject = subjectOf(from.kind === 'category' ? { categoryId: from.value } : { q: from.value });
    const doneKey = `${ctx.site.id}:${subject.key}:${signature}`;
    if (Date.now() - (exhausted.get(doneKey) || 0) < SCAN_TTL_MS) continue;
    try {
      const info = await subjectInfo(ctx.site, subject);
      const plan = await readPlan(ctx, subject, info, focus, READS_MAX);
      const reads = await repo.latestReads(ctx.site.id, plan.readOrder.map(idOf), analyticsDays.addDays(ctx.day, -1));
      // Only what can pass the filters, the subject's leading listings included (its figures aren't wanted here).
      const unread = plan.readOrder.filter((l) => !fresh(reads.get(idOf(l))) && plan.passes(l));
      if (!unread.length) {
        if (!plan.found.more) exhausted.set(doneKey, Date.now());
        continue;
      }
      const batch = unread.slice(0, READS_STEP);
      const sold = await readSold(ownerId, connectionId, ctx, batch, { max: batch.length });
      read += batch.filter((l) => fresh(sold.reads.get(idOf(l)))).length;
      names.push(from.name);
      if (unread.length > batch.length || plan.found.more) more = true;
      // The day's reads used up, or the account's eBay sign-in failing: stop here.
      if (sold.stopped) {
        signInFailed = Boolean(sold.signInFailed);
        stopped = !signInFailed;
        more = true;
        break;
      }
    } catch (err) {
      logger.warn('Discover: no more read for the filters', { subject: subject.key, error: err.message });
      if (err.statusCode === 429) break;
    }
  }
  forgetWinners();
  return { read, subjects: names, more, signInFailed, stopped };
}

async function siteKeywords(ownerId, connectionId, { q = '', sort = 'sales', searchedOnly = false, limit = POOL_KEYWORDS_SHOWN } = {}) {
  const all = await winnersPool(ownerId, connectionId);
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
    if (left.tradingPaused || left.trading < left.limits.trading / 3 || left.browse < left.limits.browse / 3) break;
    const subject = row.subject.startsWith('c:') ? { categoryId: row.subject.slice(2) } : { q: row.subject.slice(2) };
    try {
      await explore(row.owner_id, row.connection_id, subject);
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
        const sold = await readSold(ownerId, connectionId, ctx, kept, { max: CHILD_READS });
        // This account's eBay sign-in fails: no subcategory can be read today, so stop asking.
        if (sold.signInFailed) outOfSearches = true;
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
  if (left.tradingPaused || left.trading < left.limits.trading / 3 || left.browse < left.limits.browse / 3) return null;
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
        const sold = await readSold(ownerId, connectionId, ctx, kept, { max: CHILD_READS });
        // The account's eBay sign-in fails, or the day's reads are used up: no point asking again today.
        if (sold.signInFailed || sold.stopped) stop = true;
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
      forgetWinners();
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
  // The best products across everything explored, for the start screen (the Winners pool, cached).
  const pool = await winnersPool(ownerId, connectionId).catch(() => null);
  return {
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    winners: pool ? { products: pool.products.slice(0, 5), total: pool.products.length, keywords: pool.keywords.length, pool: pool.pool } : null,
    // Every category explored on the site (any depth), best-selling first, for the Categories tab.
    bestCategories: pool ? pool.categories.slice(0, BEST_CATEGORIES_MAX) : [],
    // Live listings from its search even before its sold counts are read.
    yourCategories: ownRows.map((c) => ({ ...c, scanned: badge(c.id), live: scans.get(`c:${c.id}`)?.total ?? null })),
    yourScoring,
    topCategories: top.map((c) => ({ id: c.id, name: c.name, leaf: c.leaf, scanned: badge(c.id) })),
    watches: watched,
    watchPreview: preview,
    recent,
    budget: await budget.left(),
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
        rising: summary.rising.slice(0, 3).map((l) => shown(l, ctx.site.country)),
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
    if ((left.trading <= 0 || left.tradingPaused) && left.browse <= 0) break;
    try {
      await explore(w.owner_user_id, w.connection_id, watchSubject(w));
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
  findMore,
  _quickMs,
  _soldSettled,
  explore,
  forgetOwner,
  winners,
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
  READS_STEP,
  READS_MAX,
};
