const browseResearch = require('../ebay/browse-research');
const connectionService = require('../connections/connection.service');
const marketplaces = require('../ebay/marketplaces');
const researchStats = require('./research-stats');
const analysis = require('./research-analysis');
const advisor = require('../ai-generation/research-advisor.service');
const listingRepository = require('../listings/listing.repository');
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

const usage = { day: null, used: 0, loaded: false };
const today = () => new Date().toISOString().slice(0, 10);

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
  return { used: usage.used, limit, remaining: Math.max(0, limit - usage.used) };
}

// ---- research ---------------------------------------------------------------------

async function accountOf(ownerId, connectionId) {
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  if (connection.platform_key !== 'ebay') throw new ResearchError('Research needs an eBay account.', 400);
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(marketplaces.DEFAULT_ID);
  return { site, pricing: connection.settings?.pricing || {} };
}
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
        const res = await browseResearch.soldCount(item, marketplaceId);
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

// A search, its top sold counts read (and any others read earlier the same
// day, free), each listing with what its sales came to and its age.
async function gather(ownerId, connectionId, { q, condition = 'any', minPrice, maxPrice }) {
  const query = String(q || '').trim();
  if (query.length < 2) throw new ResearchError('Type what you want to research.', 400);
  const { site, pricing } = await accountOf(ownerId, connectionId);
  const left = await budget();
  if (left.remaining <= 0) {
    throw new ResearchError(`Research has used today's ${left.limit} eBay reads. It resets at midnight (UTC).`, 429);
  }
  const found = await browseResearch.search({ q: query, marketplaceId: site.id, condition, minPrice: clean(minPrice), maxPrice: clean(maxPrice) });
  await spend(found.calls);
  const top = await withSoldCounts(found.items.slice(0, SOLD_READS), site.id);
  const rest = found.items.slice(SOLD_READS).map((item) => ({ ...item, sold: browseResearch.keptSold(item.itemId, site.id) }));
  const items = [...top.items, ...rest].map((item) => ({
    ...item,
    soldPerMonth: researchStats.soldPerMonth(item),
    revenue: researchStats.revenueOf(item),
    daysLive: researchStats.daysLive(item),
  }));
  const summary = researchStats.summarise(items, { country: site.country, total: found.total });
  return { query, site, pricing, found, items, summary, soldLimited: top.stopped };
}

const adviceKey = (site, query, condition, minPrice, maxPrice) => JSON.stringify([site.id, query.toLowerCase(), condition, clean(minPrice), clean(maxPrice)]);

// Everything the page shows beyond the raw figures; `advice` is the AI's
// reading when there is one.
async function analyse(ownerId, { query, site, pricing, found, items, summary }, advice = null) {
  const refusals = await listingRepository.findPolicyRefusals(ownerId).catch(() => []);
  const price = analysis.priceAdvice(items, { pricing });
  const risks = analysis.riskChecks({ query, items, breakdown: found.breakdown, refusals, advice });
  return {
    price,
    keywords: analysis.keywordsFrom(items, query),
    breakdown: found.breakdown || null,
    risks,
    verdict: analysis.verdict({ summary, price, risks, currency: site.currency }),
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
  const kept = advisor.keptAdvice(adviceKey(found.site, found.query, input.condition || 'any', input.minPrice, input.maxPrice));
  return {
    query: found.query,
    market: marketplaces.summary(found.site.id),
    total: found.found.total,
    summary: found.summary,
    analysis: await analyse(ownerId, found, kept),
    advice: kept,
    items: found.items,
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
  const found = await gather(ownerId, connectionId, input);
  const base = await analyse(ownerId, found);
  const ai = await advisor.advise(adviceKey(found.site, found.query, input.condition || 'any', input.minPrice, input.maxPrice), {
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
}

module.exports = { search, advice, soldCounts, budget, resetUsage, SOLD_READS, ResearchError };
