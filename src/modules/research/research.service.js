const browseResearch = require('../ebay/browse-research');
const browseUsage = require('../ebay/browse-usage');
const connectionService = require('../connections/connection.service');
const marketplaces = require('../ebay/marketplaces');
const researchStats = require('./research-stats');
const analysis = require('./research-analysis');
const advisor = require('../ai-generation/research-advisor.service');
const listingRepository = require('../listings/listing.repository');
const ebayService = require('../ebay/ebay.service');
const delivery = require('./delivery');
const salesHistory = require('../ebay/sales-history');
const appState = require('../../db/app-state.repository');
const config = require('../../config');
const logger = require('../../utils/logger');

// Product research on an account's eBay site: what's live for a search, at
// what prices, from whom and from where, and how well the leading listings
// sell. Built on eBay's Browse API (see ebay/browse-research.js): a search
// is one call for up to 200 listings, and each listing's sold count is one
// more, so a search reads the sold counts of its top SOLD_READS listings
// and more on request. Every call is counted against research's share of
// the app's daily allowance, so drafting (which reads competitor listings
// through the same API) always has calls left.

const SOLD_READS = 20;
const SOLD_CONCURRENCY = 5;
const STATE_KEY = 'research-browse-usage';

class ResearchError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ---- the daily allowance --------------------------------------------------------

// Research's day is the Browse allowance's own (it resets when eBay's does,
// 07:00 UTC), so its share and the admin's Browse figures move together.
const usage = { day: null, used: 0, loaded: false };
const today = () => browseUsage.snapshot().resetAt;
const resetText = () => `${today().slice(11, 16)} UTC`;

async function loadUsage() {
  if (!usage.loaded) {
    usage.loaded = true;
    const kept = await appState.get(STATE_KEY).catch(() => null);
    if (kept?.day === today()) Object.assign(usage, { day: kept.day, used: Number(kept.used) || 0 });
  }
  if (usage.day !== today()) Object.assign(usage, { day: today(), used: 0 });
}

async function spend(calls) {
  if (!calls) return;
  usage.used += calls;
  await appState.set(STATE_KEY, { day: usage.day, used: usage.used }).catch(() => {});
}

async function budget() {
  await loadUsage();
  const limit = config.research.dailyCalls;
  return { used: usage.used, limit, remaining: Math.max(0, limit - usage.used), resetAt: today() };
}

// ---- research ---------------------------------------------------------------------

async function accountOf(ownerId, connectionId) {
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  if (connection.platform_key !== 'ebay') throw new ResearchError('Research needs an eBay account.', 400);
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(marketplaces.DEFAULT_ID);
  return { site, pricing: connection.settings?.pricing || {}, fulfillmentPolicyId: connection.settings?.ebay?.fulfillmentPolicyId || null };
}

// How fast this account delivers, from its postage policy: { min, max } in
// working days with the policy and service behind it, or null when the
// policy can't be read (research then compares with every listing).
async function accountDelivery(ownerId, connectionId, site, fulfillmentPolicyId) {
  try {
    const details = await connectionService.withDecryptedCredentials(connectionId, ownerId, (credentials) =>
      ebayService.postagePolicyDetails(credentials, { connectionId, marketplaceId: site.id, fulfillmentPolicyId })
    );
    return delivery.accountWindow(details.policy, details.services);
  } catch (err) {
    logger.warn('Research: postage policy not read', { connectionId, error: err.message });
    return null;
  }
}

const DELIVERY_FILTERS = ['similar', 'faster', 'slower', 'all'];
const siteOf = async (ownerId, connectionId) => (await accountOf(ownerId, connectionId)).site;

// Sold counts for these listings, as many as the allowance lets; the rest
// keep sold: null. Reads run a few at a time.
async function withSoldCounts(items, marketplaceId) {
  const out = items.map((item) => ({ ...item }));
  let next = 0;
  let calls = 0;
  let stopped = false;
  async function worker() {
    while (next < out.length && !stopped) {
      const item = out[next++];
      await loadUsage();
      if (usage.used + calls >= config.research.dailyCalls) {
        stopped = true;
        return;
      }
      try {
        const res = await browseUsage.as('research', () => browseResearch.soldCount(item, marketplaceId));
        item.sold = res.sold;
        calls += res.calls;
      } catch (err) {
        logger.warn('Research: sold count not read', { itemId: item.itemId, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: SOLD_CONCURRENCY }, worker));
  await spend(calls);
  return { items: out, stopped };
}

const clean = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ---- what sold, and what eBay removed ------------------------------------------------

// eBay's sales history for the search (Marketplace Insights, last 90 days)
// is where listings eBay took down still show: they sold before eBay
// removed them. The history doesn't say why a listing is gone, so each
// sold listing that isn't live any more is read once with the account's
// token (Trading GetItem, read-only): ended the normal way, or deleted,
// which is what eBay does when it removes a listing for a policy
// violation. Those answers are kept in memory for 12 hours; nothing is
// stored. While eBay hasn't granted the app the API, sales are
// { available: false } and research says so.
const STATE_CHECKS = 25;
const STATE_TTL_MS = 12 * 60 * 60 * 1000;
const states = new Map(); // `${site}:${legacyItemId}` -> { at, state }
const keptState = (siteId, id) => {
  const hit = states.get(`${siteId}:${id}`);
  return hit && Date.now() - hit.at < STATE_TTL_MS ? hit.state : null;
};

async function salesOf(ownerId, connectionId, site, { query, condition, minPrice, maxPrice }, liveItems) {
  let found;
  try {
    found = await salesHistory.soldListings({ q: query, marketplaceId: site.id, condition, minPrice: clean(minPrice), maxPrice: clean(maxPrice) });
  } catch (err) {
    logger.warn('Research: sales history not read', { connectionId, error: err.message });
    return { available: true, failed: true, days: 90, total: 0, items: [], summary: researchStats.summariseSales([]) };
  }
  if (!found.available) return { available: false };
  const live = new Set(liveItems.map((i) => i.legacyItemId).filter(Boolean));
  const unknown = found.items.filter((i) => i.legacyItemId && !live.has(i.legacyItemId) && !keptState(site.id, i.legacyItemId));
  const toRead = [...unknown].sort((x, y) => (y.sold || 0) - (x.sold || 0)).slice(0, STATE_CHECKS).map((i) => i.legacyItemId);
  if (toRead.length) {
    try {
      const read = await connectionService.withDecryptedCredentials(connectionId, ownerId, (credentials) => ebayService.listingStates(credentials, toRead, site.id));
      for (const [id, state] of Object.entries(read.states || {})) states.set(`${site.id}:${id}`, { at: Date.now(), state });
    } catch (err) {
      logger.warn('Research: sold listings not checked', { connectionId, error: err.message });
    }
  }
  const items = found.items.map((i) => ({ ...i, state: live.has(i.legacyItemId) ? 'live' : keptState(site.id, i.legacyItemId) }));
  return { available: true, days: 90, total: found.total, items, summary: researchStats.summariseSales(items) };
}

// A search, its top sold counts read (and any others read earlier the same
// day, free), each listing with what its sales came to, its age, and how
// its delivery compares with the account's. `delivery` keeps only the
// listings that deliver like the account ('similar', the default when the
// account's postage policy is known), faster, slower, or 'all'; the
// figures, price and verdict are worked out from what's kept.
async function gather(ownerId, connectionId, { q, condition = 'any', minPrice, maxPrice, delivery: wanted }) {
  const query = String(q || '').trim();
  if (query.length < 2) throw new ResearchError('Type what you want to research.', 400);
  const { site, pricing, fulfillmentPolicyId } = await accountOf(ownerId, connectionId);
  const left = await budget();
  if (left.remaining <= 0) {
    throw new ResearchError(`Research has used today's ${left.limit} eBay reads. It resets at ${resetText()}.`, 429);
  }
  const [found, account] = await Promise.all([
    browseUsage.as('research', () => browseResearch.search({ q: query, marketplaceId: site.id, condition, minPrice: clean(minPrice), maxPrice: clean(maxPrice), country: site.country })),
    accountDelivery(ownerId, connectionId, site, fulfillmentPolicyId),
  ]);
  await spend(found.calls);

  const now = Date.now();
  const placed = found.items.map((item) => {
    const window = delivery.listingWindow(item, now);
    return { ...item, delivery: window ? { ...window, compared: delivery.compare(window, account) } : { min: null, max: null, compared: 'unknown' } };
  });
  const counts = { similar: 0, faster: 0, slower: 0, unknown: 0, all: placed.length };
  for (const item of placed) counts[item.delivery.compared] += 1;
  const filter = DELIVERY_FILTERS.includes(wanted) ? wanted : account ? 'similar' : 'all';
  const chosen = filter === 'all' || !account ? placed : placed.filter((item) => item.delivery.compared === filter);

  // What sold (and what eBay removed) is read alongside the sold counts.
  const [top, sales] = await Promise.all([
    withSoldCounts(chosen.slice(0, SOLD_READS), site.id),
    salesOf(ownerId, connectionId, site, { query, condition, minPrice, maxPrice }, found.items),
  ]);
  const rest = chosen.slice(SOLD_READS).map((item) => ({ ...item, sold: browseResearch.keptSold(item.itemId, site.id) }));
  const items = [...top.items, ...rest].map((item) => ({
    ...item,
    soldPerMonth: researchStats.soldPerMonth(item),
    revenue: researchStats.revenueOf(item),
    daysLive: researchStats.daysLive(item),
  }));
  const summary = researchStats.summarise(items, { country: site.country, total: found.total });
  const deliveryInfo = {
    filter: account ? filter : 'all',
    counts,
    account: account ? { min: account.min, max: account.max, handling: account.handling, service: account.service, serviceName: account.serviceName, policyName: account.policyName } : null,
  };
  return { query, site, pricing, found, items, summary, sales, soldLimited: top.stopped, delivery: deliveryInfo };
}

// The AI's judgement is about the product (its brand, whether it's
// restricted, what to call it), not about which listings are compared: one
// per site, search and condition, whatever the delivery filter or prices.
const adviceKey = (site, query, condition) => JSON.stringify([site.id, query.toLowerCase().replace(/\s+/g, ' '), condition]);

// Everything the page shows beyond the raw figures; `advice` is the AI's
// reading when there is one.
async function analyse(ownerId, { query, site, pricing, found, items, summary, sales = null }, advice = null) {
  const refusals = await listingRepository.findPolicyRefusals(ownerId).catch(() => []);
  const price = analysis.priceAdvice(items, { pricing });
  const risks = analysis.riskChecks({ query, items, breakdown: found.breakdown, refusals, advice, sales });
  return {
    price,
    keywords: analysis.keywordsFrom(items, query),
    breakdown: found.breakdown || null,
    risks,
    verdict: analysis.verdict({ summary, price, risks, currency: site.currency }),
    // Whether the brand and safety check has been read into this verdict;
    // until then the page holds the verdict back rather than show one that
    // may flip.
    checked: Boolean(advice),
  };
}

/**
 * One search on the account's site: { query, market, total, summary,
 * analysis (price to sell at, keywords, risks, verdict), items (up to 200,
 * best match first, the top ones with their sold counts), budget }. `q` is
 * required; condition 'new' | 'used' | 'any'; prices in the site's currency.
 * The AI's reading comes separately (advice), so the figures show at once.
 */
async function search(ownerId, connectionId, input) {
  const found = await gather(ownerId, connectionId, input);
  const kept = await advisor.keptAdvice(adviceKey(found.site, found.query, input.condition || 'any'));
  return {
    query: found.query,
    market: marketplaces.summary(found.site.id),
    total: found.found.total,
    summary: found.summary,
    analysis: await analyse(ownerId, found, kept),
    advice: kept,
    items: found.items,
    // What sold in the last 90 days and what eBay removed (eBay's sales
    // history), or { available: false } until eBay grants the API.
    sales: found.sales,
    delivery: found.delivery,
    soldLimited: found.soldLimited,
    budget: await budget(),
  };
}

/**
 * The AI's reading of a search (title, keywords, brand and safety risk) and
 * the analysis redone with it. The search and its sold counts come from the
 * copies kept when it ran, so this spends no eBay reads while they last.
 */
async function advice(ownerId, connectionId, input) {
  // The sales and their checks come from the copies the search kept.
  const found = await gather(ownerId, connectionId, input);
  const base = await analyse(ownerId, found);
  const ai = await advisor.advise(adviceKey(found.site, found.query, input.condition || 'any'), {
    query: found.query,
    market: found.site.name,
    currency: found.site.currency,
    items: found.items,
    breakdown: found.found.breakdown,
    keywords: base.keywords.words,
  });
  return { advice: ai, analysis: ai ? await analyse(ownerId, found, ai) : base, budget: await budget() };
}

/** Sold counts for more listings from a search (by their ids). */
async function soldCounts(ownerId, connectionId, items) {
  const site = await siteOf(ownerId, connectionId);
  const wanted = (items || []).slice(0, SOLD_READS).map((i) => ({ itemId: String(i.itemId), legacyItemId: i.legacyItemId ? String(i.legacyItemId) : null, hasVariations: Boolean(i.hasVariations), createdAt: i.createdAt || null }));
  const read = await withSoldCounts(wanted, site.id);
  return {
    items: read.items.map((i) => ({ itemId: i.itemId, sold: i.sold, soldPerMonth: researchStats.soldPerMonth(i) })),
    soldLimited: read.stopped,
    budget: await budget(),
  };
}

function resetUsage() {
  Object.assign(usage, { day: null, used: 0, loaded: true });
  states.clear();
}

module.exports = { search, advice, soldCounts, budget, resetUsage, SOLD_READS, ResearchError };
