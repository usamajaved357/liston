const marketplaces = require('./marketplaces');

// One eBay account can sell on several eBay sites (UK and Australia, say),
// and Liston connects it once per site. eBay's seller calls don't split by
// site: GetMyeBaySelling and GetOrders return the account's listings and
// orders from every site, whichever site id is sent. So each connection
// keeps what belongs to its own site, and gives up what belongs to a site
// another connection of the same eBay account holds. An account connected
// on one site only keeps everything, as before.
//
// A scope is { own: 'EBAY_GB', claimed: ['EBAY_AU'] }: the connection's
// marketplace and the ones its sibling connections hold.

// Currencies only one site uses; euro sites are told apart by URL or site.
const SOLE_CURRENCY = Object.fromEntries(
  Object.entries(
    marketplaces.MARKETPLACES.reduce((acc, m) => ({ ...acc, [m.currency]: [...(acc[m.currency] || []), m.id] }), {})
  )
    .filter(([, ids]) => ids.length === 1)
    .map(([currency, [id]]) => [currency, id])
);

function fromItemUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).host.toLowerCase();
    return marketplaces.MARKETPLACES.find((m) => m.itemHost === host || m.itemHost.replace(/^www\./, '') === host)?.id || null;
  } catch {
    return null;
  }
}

function fromCurrency(currency) {
  return SOLE_CURRENCY[String(currency || '').toUpperCase()] || null;
}

/** The eBay site a listing (Trading's listing summary) is on, or null. */
function marketOfListing(item) {
  if (!item) return null;
  return fromItemUrl(item.viewItemUrl) || fromCurrency(item.price?.currency) || null;
}

/** The eBay site an order was placed on: its listing's site, or null. */
function marketOfOrder(order) {
  if (!order) return null;
  if (order.marketplaceId && marketplaces.byId(order.marketplaceId)) return order.marketplaceId;
  const line = (order.lineItems || []).find((li) => li.site || li.marketplaceId);
  const fromLine = line ? marketplaces.byId(line.marketplaceId)?.id || marketplaces.fromSite(line.site)?.id : null;
  return fromLine || fromCurrency(order.total?.currency) || fromCurrency(order.lineItems?.[0]?.price?.currency) || null;
}

/** Whether a connection with this scope keeps something on `market`. */
function keeps(scope, market) {
  if (!scope || !scope.claimed?.length) return true;
  if (!market || market === scope.own) return true;
  return !scope.claimed.includes(market);
}

function listingsIn(scope, items) {
  if (!scope?.claimed?.length || !Array.isArray(items)) return items;
  return items.filter((item) => keeps(scope, marketOfListing(item)));
}

function ordersIn(scope, orders) {
  if (!scope?.claimed?.length || !Array.isArray(orders)) return orders;
  return orders.filter((order) => keeps(scope, marketOfOrder(order)));
}

module.exports = { fromItemUrl, fromCurrency, marketOfListing, marketOfOrder, keeps, listingsIn, ordersIn };
