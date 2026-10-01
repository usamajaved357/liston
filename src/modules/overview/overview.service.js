// The Overview page's numbers: every connected account's money for a range
// (sales, eBay and ad fees, earnings, supplier cost, profit) and its live
// listings, grouped by eBay site, since each site has its own currency and
// money is never added across currencies.
//
// Everything is read from Liston's own copies: orders from the order mirror,
// each order's fees and earnings from ebay_order_finances and the account's
// own charges (listing fees, subscriptions; the shop's spread over the days
// it pays for, store-fee-days) from ebay_account_charges (both
// read from eBay's Finances API in bulk, in the background, at most every
// half hour), supplier
// costs from order_sourcing. One account failing (expired token, eBay hiccup)
// degrades to a partial total with the account named, rather than blanking
// the page.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const mirror = require('../ebay/ebay-mirror.repository');
const orderRepository = require('../orders/order.repository');
const marketplaces = require('../ebay/marketplaces');
const moneySummary = require('./money-summary');
const { countQueue } = require('./order-queue');
const salesTrend = require('./sales-trend');
const analyticsDays = require('../analytics/analytics-days');
const exchangeRates = require('../rates/exchange-rates');
const listingRepository = require('../listings/listing.repository');
const { query } = require('../../db/client');
const logger = require('../../utils/logger');
const huntingRepository = require('../hunting/hunting.repository');
const listingTrend = require('./listing-trend');
const storeFeeDays = require('./store-fee-days');

const RANGES = new Set(['today', '7d', '30d', '90d', 'this_month', 'last_month']);
// Every listing figure an account has, added up per market.
const LISTING_KEYS = ['live', 'drafted', 'draftedFromHunts', 'published', 'publishedFromHunts', 'waiting', ...Object.keys(huntingRepository.EMPTY_OVERVIEW)];
// How long the page waits for a finance read before answering with what's
// stored; the read carries on and the page asks again.
const FINANCES_WAIT_MS = 6000;

const isCancelled = (order) => ebayService.classifyOrderStatus(order) === 'cancelled';

// `extras`: the business Overview also shows sales by day and best sellers.
async function accountFigures(connection, ownerId, { range, timeZone, extras = false }) {
  const currency = marketplaces.currencyFor(connection.marketplace?.id || marketplaces.DEFAULT_ID);
  const push = ebayService.pushEnabled(connection);

  // Fees and earnings, fresh from eBay if they're due; the page doesn't wait
  // long for it.
  const finances = connectionService
    .withDecryptedCredentials(connection.id, ownerId, (credentials) => ebayService.syncOrderFinances(credentials, connection.id))
    .catch((err) => {
      logger.warn('Overview: order earnings not read from eBay', { connectionId: connection.id, error: err.message });
      return { failed: true };
    });
  const settled = await Promise.race([finances.then((r) => r), new Promise((resolve) => setTimeout(() => resolve(null), FINANCES_WAIT_MS))]);

  const { listings, orders, recent } = await connectionService.withDecryptedCredentials(connection.id, ownerId, async (credentials) => {
    const [count, inRange, sales] = await Promise.all([
      ebayService.countActiveListings(credentials, connection.id, { push }),
      ebayService.ordersInRange(credentials, { connectionId: connection.id, range, timeZone, push }),
      extras ? ebayService.overviewSales(credentials, connection.id, { push }) : null,
    ]);
    return { listings: count.totalEntries || 0, orders: inRange, recent: sales, credentialsChanged: count.credentialsChanged, credentials: count.credentials };
  });
  // Listing work in the same dates, in the same time zone as the orders.
  const tz = timeZone || marketplaces.timeZoneOf(connection.marketplace?.id || marketplaces.DEFAULT_ID);
  const [start, end] = ebayService.resolveRangeWindow(range, null, null, tz);
  const [work, hunting] = await Promise.all([
    listingRepository.countListingWork(connection.id, start, end),
    huntingRepository.countForOverview(connection.id, start, end).catch(() => ({ ...huntingRepository.EMPTY_OVERVIEW })),
  ]);
  const orderIds = orders.map((o) => o.orderId);
  const [moneyByOrder, costs, archived, charges] = await Promise.all([
    mirror.loadOrderFinances(connection.id, orderIds),
    orderRepository.sourceCostsByOrder(connection.id, orderIds),
    orderRepository.listArchivedOrderIds(connection.id).catch(() => []),
    // The shop subscription billed before the dates may pay for days in them (store-fee-days).
    mirror.loadAccountCharges(connection.id, currency, storeFeeDays.readFrom(start), new Date()),
  ]);
  // The Listings tab's chart and its newest listings, from Liston's own records (no eBay call).
  const listingWork = await listingExtras(connection, { range, timeZone, start, end, orders }).catch((err) => {
    logger.warn('Overview: listing trend not worked out', { connectionId: connection.id, error: err.message });
    return { listingTrend: null, recentListings: [] };
  });
  return {
    activeListings: listings,
    ...listingWork,
    // The listing pipeline: hunting (products hunted, approved, rejected, each with what's behind it;
    // what waits now), then drafts and what went live (of them, from hunted products).
    listings: { live: listings, ...work, ...hunting },
    ...(extras ? await salesExtras(connection, { range, timeZone, orders, recent }) : {}),
    money: moneySummary.summarise(orders, moneyByOrder, costs, { currency, isCancelled, charges: storeFeeDays.chargesInDates(charges, { start, end, timeZone: tz }) }),
    // The same dates' orders by state, for the account Overview's queue.
    queue: countQueue(orders, ebayService.classifyOrderStatus, archived),
    financesPending: !settled,
    // Linked before Liston asked eBay for its finances permission: fees and
    // earnings need the account reconnected once.
    financesAccess: settled?.skipped !== 'scope',
  };
}

// The listing pipeline day by day (with the stretch before) and the newest
// listings put live from Liston in the dates, each with what it has sold in
// them (from the same orders the Sales tab counts).
async function listingExtras(connection, { range, timeZone, start, end, orders }) {
  const siteId = connection.marketplace?.id || marketplaces.DEFAULT_ID;
  const tz = timeZone || marketplaces.timeZoneOf(siteId);
  const today = analyticsDays.today(tz);
  const { previousDays } = listingTrend.listingDays(range, today);
  // A day's margin either side of the first day drawn, for the time zone.
  const since = new Date(new Date(`${previousDays[0]}T00:00:00Z`).getTime() - 86400000);
  const [hunts, drafts, recent] = await Promise.all([
    huntingRepository.eventsSince(connection.id, since),
    listingRepository.listingEventsSince(connection.id, since),
    listingRepository.recentlyPublished(connection.id, start, end, 6),
  ]);
  const sold = new Map();
  for (const order of orders || []) {
    if (isCancelled(order)) continue;
    for (const line of order.lineItems || []) {
      if (line.itemId) sold.set(String(line.itemId), (sold.get(String(line.itemId)) || 0) + (Number(line.quantityPurchased) || 1));
    }
  }
  const host = marketplaces.summary(siteId).itemHost;
  return {
    listingTrend: listingTrend.listingTrend(listingTrend.eventsFrom(hunts, drafts), { timeZone: tz, range, today }),
    recentListings: recent.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      title: r.title,
      image: r.image,
      price: r.price === null ? null : Number(r.price),
      currency: r.currency,
      publishedAt: r.published_at,
      units: r.item_id ? sold.get(String(r.item_id)) || 0 : 0,
      url: r.item_id ? `https://${host}/itm/${r.item_id}` : null,
      account: connection.label,
      marketplaceId: siteId,
      timeZone: tz,
    })),
  };
}

// Sales by day over the chosen dates (orders, units, fees, earnings and
// profit too) and the account's best sellers in them,
// each with its photo and link: from the live listings Liston keeps, else a
// listing's saved summary (one that has ended), never a new eBay read.
async function salesExtras(connection, { range, timeZone, orders, recent }) {
  const siteId = connection.marketplace?.id || marketplaces.DEFAULT_ID;
  const tz = timeZone || marketplaces.timeZoneOf(siteId);
  const currency = marketplaces.currencyFor(siteId);
  // The chart's money measures: eBay's figures and the supplier cost of
  // every order drawn (the previous stretch too), and the account's charges
  // since the first day drawn (a day's margin for the time zone).
  const today = analyticsDays.today(tz);
  const { days, previousDays } = salesTrend.trendDays(range, today);
  const since = new Date(new Date(`${(previousDays || days)[0]}T00:00:00Z`).getTime() - 86400000);
  const recentIds = (recent?.orders || []).map((o) => o.orderId);
  const [finances, costs, charges] = await Promise.all([
    mirror.loadOrderFinances(connection.id, recentIds),
    orderRepository.sourceCostsByOrder(connection.id, recentIds),
    mirror.loadAccountCharges(connection.id, currency, storeFeeDays.readFrom(since), new Date()),
  ]);
  const charged = storeFeeDays.chargesInDates(charges, { start: since, end: new Date(), timeZone: tz });
  const trend = salesTrend.salesTrend(recent?.orders || [], { timeZone: tz, range, today, isCancelled, finances, costs, charges: charged, currency });
  const top = salesTrend.bestSellers(orders, { isCancelled, limit: 6 });
  const live = recent?.listings || new Map();
  const ended = top.filter((b) => !live.has(b.itemId)).map((b) => b.itemId);
  const saved = ended.length ? await mirror.loadItemSummaries(ended).catch(() => new Map()) : new Map();
  const host = marketplaces.summary(siteId).itemHost;
  const bestSellers = top.map((b) => ({
    ...b,
    image: live.get(b.itemId)?.imageUrl || saved.get(b.itemId)?.summary?.imageUrl || null,
    url: live.get(b.itemId)?.url || `https://${host}/itm/${b.itemId}`,
    live: live.has(b.itemId),
    account: connection.label,
    marketplaceId: siteId,
  }));
  return { trend, bestSellers };
}

// Every account's day is its own eBay site's (Europe/London for eBay UK),
// as eBay's Seller Hub and the account's own Overview count it — never the
// viewer's: an owner in Pakistan opening Today at 04:00 would otherwise see
// the UK's evening before as "today". The viewer's time zone (`timeZone`)
// is taken but not used for counting.
async function getOverview(ownerId, viewer, { range = 'today', timeZone = null } = {}) {
  void timeZone;
  const effectiveRange = RANGES.has(range) ? range : 'today';
  const { connections } = await connectionService.listConnections(ownerId, viewer);
  const ebayConnections = connections.filter((c) => c.platform_key === 'ebay');

  const perAccount = await Promise.all(
    ebayConnections.map(async (connection) => {
      const base = { id: connection.id, label: connection.label, status: connection.status, marketplace: connection.marketplace || null };
      try {
        return { ...base, ok: true, ...(await accountFigures(connection, ownerId, { range: effectiveRange, timeZone: null, extras: true })) };
      } catch (err) {
        logger.warn('Overview: account could not be read', { connectionId: connection.id, error: err.message });
        return { ...base, ok: false, error: err.message, activeListings: 0, listings: null, money: null, financesPending: false, financesAccess: true };
      }
    })
  );

  // One entry per eBay site, busiest first: its accounts' money added up in
  // its own currency.
  const bySite = new Map();
  for (const account of perAccount) {
    const site = account.marketplace?.id || marketplaces.DEFAULT_ID;
    bySite.set(site, [...(bySite.get(site) || []), account]);
  }
  const markets = [...bySite]
    .map(([id, accounts]) => {
      const summary = marketplaces.summary(id);
      return {
        id,
        label: summary.label,
        name: summary.name,
        flag: summary.flag,
        currency: summary.currency,
        accounts: accounts.length,
        activeListings: accounts.reduce((sum, a) => sum + a.activeListings, 0),
        listings: LISTING_KEYS.reduce((acc, key) => ({ ...acc, [key]: accounts.reduce((sum, a) => sum + (a.listings?.[key] || 0), 0) }), {}),
        money: moneySummary.addUp(accounts.map((a) => a.money).filter(Boolean), summary.currency),
        // Its accounts' sales by day added up, and its best sellers.
        trend: salesTrend.addTrends(accounts.map((a) => a.trend)),
        bestSellers: salesTrend.mergeBestSellers(accounts.map((a) => a.bestSellers || [])),
        // The Listings tab: the pipeline by day added up, and the newest listings across its accounts.
        listingTrend: listingTrend.addListingTrends(accounts.map((a) => a.listingTrend)),
        recentListings: accounts
          .flatMap((a) => a.recentListings || [])
          .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt))
          .slice(0, 6),
      };
    })
    .sort((a, b) => b.accounts - a.accounts || b.money.sales - a.money.sales);

  // Every market as one figure, in the currency most accounts sell in, the
  // others converted at the day's ECB reference rate. Without a rate there
  // is no combined figure (the page shows each currency apart instead).
  let combined = null;
  if (markets.length) {
    const base = markets[0].currency;
    const fx = await exchangeRates.ratesFor(base, markets.map((m) => m.currency));
    if (fx) {
      const converted = markets.map((m) => (m.currency === base ? m.money : moneySummary.convert(m.money, fx.rates[m.currency], base)));
      const rateOf = (currency) => (currency === base ? 1 : fx.rates[currency]);
      combined = {
        money: moneySummary.addUp(converted, base),
        trend: salesTrend.addTrends(markets.map((m) => (m.currency === base ? m.trend : salesTrend.convertTrend(m.trend, rateOf(m.currency))))),
        // Each keeps its own currency; they're compared in the main one.
        bestSellers: salesTrend.mergeBestSellers(
          markets.map((m) => m.bestSellers),
          { rateOf: (item) => rateOf(item.currency) }
        ),
        // What was converted, and at what: { USD: 1.322, … } per 1 of base.
        rates: fx.rates,
        ratesDate: fx.date,
      };
    }
  }

  const connectionIds = connections.map((c) => c.id);
  const { rows } = connectionIds.length
    ? await query(`SELECT status, count(*)::int AS n FROM listings WHERE connection_id = ANY($1) GROUP BY status`, [connectionIds])
    : { rows: [] };
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));

  return {
    range: effectiveRange,
    accounts: {
      total: connections.length,
      active: connections.filter((c) => c.status === 'active').length,
      needsAttention: connections.filter((c) => c.status !== 'active').length,
    },
    activeListings: perAccount.reduce((sum, a) => sum + a.activeListings, 0),
    orders: perAccount.reduce((sum, a) => sum + (a.money?.orders || 0), 0),
    drafts: byStatus.pending_review || 0,
    publishedViaListon: byStatus.published || 0,
    markets,
    combined,
    // Some accounts' fees and earnings were still being read from eBay.
    financesPending: perAccount.some((a) => a.financesPending),
    perAccount,
  };
}

/**
 * One account's Overview: its money and listing work for a range, the same
 * figures as the business Overview, counted in the account's own site's
 * time zone and currency (account pages follow the account's site).
 */
async function getAccountOverview(ownerId, connectionId, { range = 'today' } = {}) {
  const effectiveRange = RANGES.has(range) ? range : 'today';
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  const figures = await accountFigures(connection, ownerId, { range: effectiveRange, timeZone: null });
  return { range: effectiveRange, ...figures };
}

module.exports = { getOverview, getAccountOverview };
