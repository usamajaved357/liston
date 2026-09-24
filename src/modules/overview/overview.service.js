// The Overview page's numbers: everything across every connected account,
// summed. Each account costs a couple of eBay calls, run in parallel; one
// account failing (expired token, eBay hiccup) degrades to a partial total
// with the account named, rather than blanking the whole page.
const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const { query } = require('../../db/client');
const logger = require('../../utils/logger');
const money = require('../../utils/money');

const RANGES = new Set(['today', '7d', '30d', '90d', 'this_month', 'last_month']);

async function getOverview(ownerId, viewer, { range = 'today', timeZone = null } = {}) {
  const effectiveRange = RANGES.has(range) ? range : 'today';
  const { connections } = await connectionService.listConnections(ownerId, viewer);
  const ebayConnections = connections.filter((c) => c.platform_key === 'ebay');

  const perAccount = await Promise.all(
    ebayConnections.map(async (connection) => {
      try {
        const result = await connectionService.withDecryptedCredentials(connection.id, ownerId, async (credentials) => {
          const [listings, earnings] = await Promise.all([
            ebayService.countActiveListings(credentials, connection.id, { push: ebayService.pushEnabled(connection) }),
            ebayService.getEarningsSummary(credentials, { connectionId: connection.id, range: effectiveRange, timeZone, push: ebayService.pushEnabled(connection) }),
          ]);
          return {
            activeListings: listings.totalEntries || 0,
            earnings: earnings.earnings,
            otherEarnings: earnings.otherEarnings || [],
            orders: earnings.orderCount,
            // Whichever call refreshed the token wins; both would carry the same new token.
            credentialsChanged: listings.credentialsChanged || earnings.credentialsChanged,
            credentials: earnings.credentialsChanged ? earnings.credentials : listings.credentials,
          };
        });
        return { id: connection.id, label: connection.label, status: connection.status, ok: true, ...result };
      } catch (err) {
        logger.warn('Overview: account could not be read', { connectionId: connection.id, error: err.message });
        return { id: connection.id, label: connection.label, status: connection.status, ok: false, error: err.message, activeListings: 0, earnings: null, otherEarnings: [], orders: 0 };
      }
    })
  );

  const connectionIds = connections.map((c) => c.id);
  const { rows } = connectionIds.length
    ? await query(`SELECT status, count(*)::int AS n FROM listings WHERE connection_id = ANY($1) GROUP BY status`, [connectionIds])
    : { rows: [] };
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));

  // Accounts on different eBay sites earn in different currencies: the
  // total is in the currency most accounts use, the rest beside it.
  const byCurrency = perAccount.reduce((acc, a) => (a.earnings ? { ...acc, [a.earnings.currency]: (acc[a.earnings.currency] || 0) + 1 } : acc), {});
  const currency = Object.entries(byCurrency).sort((a, b) => b[1] - a[1])[0]?.[0] || 'GBP';
  const totals = money.splitByCurrency(perAccount.flatMap((a) => [a.earnings, ...(a.otherEarnings || [])]), currency);

  return {
    range: effectiveRange,
    accounts: {
      total: connections.length,
      active: connections.filter((c) => c.status === 'active').length,
      needsAttention: connections.filter((c) => c.status !== 'active').length,
    },
    activeListings: perAccount.reduce((sum, a) => sum + a.activeListings, 0),
    earnings: totals.main,
    otherEarnings: totals.others,
    orders: perAccount.reduce((sum, a) => sum + a.orders, 0),
    drafts: byStatus.pending_review || 0,
    publishedViaListon: byStatus.published || 0,
    perAccount: perAccount.map(({ credentials, credentialsChanged, ...safe }) => safe),
  };
}

module.exports = { getOverview };
