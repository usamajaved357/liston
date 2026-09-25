// The Overview page's numbers: every connected account's money for a range
// (sales, eBay and ad fees, earnings, supplier cost, profit) and its live
// listings, grouped by eBay site, since each site has its own currency and
// money is never added across currencies.
//
// Everything is read from Liston's own copies: orders from the order mirror,
// each order's fees and earnings from ebay_order_finances (read from eBay's
// Finances API in bulk, in the background, at most every half hour), supplier
// costs from order_sourcing. One account failing (expired token, eBay hiccup)
// degrades to a partial total with the account named, rather than blanking
// the page.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const mirror = require('../ebay/ebay-mirror.repository');
const orderRepository = require('../orders/order.repository');
const marketplaces = require('../ebay/marketplaces');
const moneySummary = require('./money-summary');
const exchangeRates = require('../rates/exchange-rates');
const listingRepository = require('../listings/listing.repository');
const { query } = require('../../db/client');
const logger = require('../../utils/logger');

const RANGES = new Set(['today', '7d', '30d', '90d', 'this_month', 'last_month']);
// How long the page waits for a finance read before answering with what's
// stored; the read carries on and the page asks again.
const FINANCES_WAIT_MS = 6000;

const isCancelled = (order) => ebayService.classifyOrderStatus(order) === 'cancelled';

async function accountFigures(connection, ownerId, { range, timeZone }) {
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

  const { listings, orders } = await connectionService.withDecryptedCredentials(connection.id, ownerId, async (credentials) => {
    const [count, inRange] = await Promise.all([
      ebayService.countActiveListings(credentials, connection.id, { push }),
      ebayService.ordersInRange(credentials, { connectionId: connection.id, range, timeZone, push }),
    ]);
    return { listings: count.totalEntries || 0, orders: inRange, credentialsChanged: count.credentialsChanged, credentials: count.credentials };
  });
  // Listing work in the same dates, in the same time zone as the orders.
  const [start, end] = ebayService.resolveRangeWindow(range, null, null, timeZone || marketplaces.timeZoneOf(connection.marketplace?.id || marketplaces.DEFAULT_ID));
  const work = await listingRepository.countListingWork(connection.id, start, end);
  const orderIds = orders.map((o) => o.orderId);
  const [moneyByOrder, costs] = await Promise.all([mirror.loadOrderFinances(connection.id, orderIds), orderRepository.sourceCostsByOrder(connection.id, orderIds)]);
  return {
    activeListings: listings,
    listings: { live: listings, drafted: work.drafted, published: work.published, waiting: work.waiting },
    money: moneySummary.summarise(orders, moneyByOrder, costs, { currency, isCancelled }),
    financesPending: !settled,
    // Linked before Liston asked eBay for its finances permission: fees and
    // earnings need the account reconnected once.
    financesAccess: settled?.skipped !== 'scope',
  };
}

async function getOverview(ownerId, viewer, { range = 'today', timeZone = null } = {}) {
  const effectiveRange = RANGES.has(range) ? range : 'today';
  const { connections } = await connectionService.listConnections(ownerId, viewer);
  const ebayConnections = connections.filter((c) => c.platform_key === 'ebay');

  const perAccount = await Promise.all(
    ebayConnections.map(async (connection) => {
      const base = { id: connection.id, label: connection.label, status: connection.status, marketplace: connection.marketplace || null };
      try {
        return { ...base, ok: true, ...(await accountFigures(connection, ownerId, { range: effectiveRange, timeZone })) };
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
        listings: ['live', 'drafted', 'published', 'waiting'].reduce(
          (acc, key) => ({ ...acc, [key]: accounts.reduce((sum, a) => sum + (a.listings?.[key] || 0), 0) }),
          {}
        ),
        money: moneySummary.addUp(accounts.map((a) => a.money).filter(Boolean), summary.currency),
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
      combined = {
        money: moneySummary.addUp(converted, base),
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
