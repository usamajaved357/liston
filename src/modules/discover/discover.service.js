const logger = require('../../utils/logger');
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const trading = require('../ebay/api/ebay.trading');
const taxonomy = require('../ebay/api/ebay.taxonomy');
const browseResearch = require('../ebay/browse-research');
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
const SCAN_SIZE = 100;
const READS_FIRST = 25; // sold counts read when a subject opens
const READS_STEP = 25; // "Read more"
const READS_MAX = 100;
const CHILD_READS = 5; // per subcategory when ranking them
const MAX_CHILDREN = 12; // subcategories ranked at once, busiest first
const READ_CONCURRENCY = 4;
const LISTINGS_SHOWN = 60;
const WATCH_LIMIT = 30;
const READ_FALLBACK_DAYS = 7; // an older read stands in when today's can't be made
const READS_KEPT_DAYS = 40;

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
  return { site, account, timeZone, day: analyticsDays.today(timeZone) };
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
  const need = wanted.filter((id) => reads.get(id)?.day !== day);
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
              await repo.saveRead(site.id, day, { itemId: id, sold: read.sold, options: read.options, categoryId: read.categoryId, startedAt: read.startedAt });
              return read;
            });
          pendingReads.set(key, reading);
          reading.catch(() => {}).finally(() => pendingReads.delete(key));
        }
        try {
          const read = await pendingReads.get(key);
          if (mine) calls += 1;
          reads.set(id, { item_id: id, day, sold: read.sold, options: read.options, category_id: read.categoryId, started_at: read.startedAt });
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

// A subcategory's row: its listing count from the parent's breakdown, and
// its figures when it has been scanned.
async function childRows(ctx, info, parentScan) {
  if (!info.children.length) return [];
  const counts = new Map((parentScan.breakdown?.categories || []).map((c) => [String(c.id), c.count]));
  const scans = await repo.getScans(ctx.site.id, info.children.map((c) => `c:${c.id}`));
  const ids = [...scans.values()].flatMap((s) => s.listings.map(idOf));
  const reads = await repo.latestReads(ctx.site.id, ids, analyticsDays.addDays(ctx.day, -READ_FALLBACK_DAYS));
  const rows = info.children.map((c) => {
    const s = scans.get(`c:${c.id}`);
    const row = { id: c.id, name: c.name, leaf: c.leaf, listings: s ? s.total : counts.get(String(c.id)) ?? null, scanned: null };
    if (s) {
      const listings = placed(s, ctx, reads);
      const f = scoring.figures(listings, { total: s.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
      if (f.demand.read) {
        const o = scoring.opportunity(f, { currency: ctx.site.currency });
        row.scanned = {
          score: o.score,
          band: o.band,
          medianPerMonth: f.demand.medianPerMonth,
          selling: f.demand.selling,
          read: f.demand.read,
          price: f.price?.median ?? null,
          fit: f.fit?.share ?? null,
          topSeller: f.competition.topSeller?.share ?? null,
          takenAt: s.taken_at,
        };
      }
    }
    return row;
  });
  return rows.sort((a, b) => (b.scanned?.score ?? -1) - (a.scanned?.score ?? -1) || (b.listings ?? -1) - (a.listings ?? -1));
}

/**
 * One category or keyword, for the account: { subject, figures,
 * opportunity, listings (selling now: read ones fastest first), keywords,
 * children (subcategories, ranked once scanned), watch, account, budget }.
 * `reads`: how many leading listings' sold counts to read (25 a step).
 */
function explore(ownerId, connectionId, input, { reads: wantedReads = READS_FIRST, canSeeTraffic = false } = {}) {
  const subject = subjectOf(input);
  const max = Math.min(READS_MAX, Math.max(READS_FIRST, Number(wantedReads) || READS_FIRST));
  return once(`explore:${connectionId}:${subject.key}:${max}:${canSeeTraffic}`, () => exploreNow(ownerId, connectionId, subject, max, { canSeeTraffic }));
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

async function exploreNow(ownerId, connectionId, subject, max, { canSeeTraffic }) {
  const ctx = await context(ownerId, connectionId);
  const info = await subjectInfo(ctx.site, subject);
  const traffic = canSeeTraffic && subject.kind === 'keyword' ? ownTraffic(ownerId, connectionId, subject.q) : Promise.resolve(null);
  const scanRow = await scan(ctx.site, subject);
  const sold = await readSold(ownerId, connectionId, ctx, scanRow.listings, { max });
  const listings = scoring.withPace(placed(scanRow, ctx, sold.reads));

  const f = scoring.figures(listings, { total: scanRow.total, country: ctx.site.country, accountKnown: Boolean(ctx.account) });
  // Two weeks of readings: recent sales per listing, and the subject's sales day by day.
  const history = await repo.readsSince(ctx.site.id, listings.map(idOf), analyticsDays.addDays(ctx.day, -15));
  const recent = trends.recentSales(history);
  const summary = trends.summarise(scoring.sellingNow(listings), recent);
  const [children, watch] = await Promise.all([childRows(ctx, info, scanRow), repo.findWatch(connectionId, subject.kind, subject.value)]);

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
    rising: summary.rising.map((l) => shown(l, ctx.site.country)),
    listings: summary.listings.slice(0, LISTINGS_SHOWN).map((l) => shown(l, ctx.site.country)),
    // The subject's own words (its category name, or the keyword) aren't news.
    keywords: keywords.fromListings(listings, { query: subject.q || info.name }),
    brands: (scanRow.breakdown?.brands || []).slice(0, 8),
    // A keyword: the categories its listings sit in, to explore next.
    categories: subject.kind === 'keyword' ? (scanRow.breakdown?.categories || []).slice(0, 8) : [],
    children,
    reads: { asked: max, read: f.demand.read, more: max < READS_MAX && listings.length > max, stopped: sold.stopped, signInFailed: Boolean(sold.signInFailed) },
    watch: watch ? { id: watch.id } : null,
    // Subcategories being ranked right now: the page asks again until done.
    ranking: subject.categoryId ? rankingOf(connectionId, subject.categoryId) : null,
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    budget: await budget.left(),
  };
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
  const chosen = [...info.children].sort((a, b) => (counts.get(String(b.id)) ?? 0) - (counts.get(String(a.id)) ?? 0)).slice(0, MAX_CHILDREN);
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
        await readSold(ownerId, connectionId, ctx, s.listings, { max: CHILD_READS });
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
  // The first few watches with their figures, for the start screen.
  const preview = watched ? (await watches(ownerId, connectionId)).items.slice(0, 4) : [];
  return {
    market: marketplaces.summary(ctx.site.id),
    account: ctx.account ? { min: ctx.account.min, max: ctx.account.max, policyName: ctx.account.policyName, serviceName: ctx.account.serviceName } : null,
    yourCategories: ownRows.map((c) => ({ ...c, scanned: badge(c.id) })),
    topCategories: top.map((c) => ({ id: c.id, name: c.name, leaf: c.leaf, scanned: badge(c.id) })),
    watches: watched,
    watchPreview: preview,
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

module.exports = {
  explore,
  rankChildren,
  rankingOf,
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
