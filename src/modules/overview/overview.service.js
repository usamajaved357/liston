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
  const orderIds = orders.map((o) => o.orderId);
  const [moneyByOrder, costs] = await Promise.all([mirror.loadOrderFinances(connection.id, orderIds), orderRepository.sourceCostsByOrder(connection.id, orderIds)]);
  return {
    activeListings: listings,
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
        return { ...base, ok: false, error: err.message, activeListings: 0, money: null, financesPending: false, financesAccess: true };
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
        money: moneySummary.addUp(accounts.map((a) => a.money).filter(Boolean), summary.currency),
      };
    })
    .sort((a, b) => b.accounts - a.accounts || b.money.sales - a.money.sales);

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
    // Some accounts' fees and earnings were still being read from eBay.
    financesPending: perAccount.some((a) => a.financesPending),
    perAccount,
  };
}

module.exports = { getOverview };
