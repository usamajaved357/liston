const connectionService = require('../connections/connection.service');
const ebayService = require('../ebay/ebay.service');
const listingService = require('../listings/listing.service');
const listingRepository = require('../listings/listing.repository');
const orderService = require('../orders/order.service');
const orderRepository = require('../orders/order.repository');
const mirror = require('../ebay/ebay-mirror.repository');
const marketplaces = require('../ebay/marketplaces');
const { orderMoney } = require('../orders/order-money');
const { orderRows, listingRows } = require('./export-rows');
const { toCsv } = require('../../utils/csv');

// CSV downloads of an account's orders and listings: exactly what the page's
// filters show (the same reading of eBay's copy the page makes, every page of
// it), or only the ticked rows. Orders carry their buyer, items, eBay's
// tracking, the money and the supplier orders (never the supplier logins,
// see export-rows); no extra eBay calls are made for a download.

function siteOf(connection) {
  const market = marketplaces.byId(connection.settings?.ebay?.marketplaceId) || marketplaces.byId(marketplaces.DEFAULT_ID);
  return { timeZone: marketplaces.timeZoneOf(market.id), itemHost: market.itemHost };
}

const slug = (text) =>
  String(text || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';

const today = () => new Date().toISOString().slice(0, 10);

function notEbay(connection, what) {
  return new connectionService.ConnectionError(`${what} aren't available for ${connection.platform_name} yet`, 400);
}

/** { filename, csv, count } of the account's orders under these filters (or only `ids`). */
async function ordersCsv(ownerId, connectionId, query, ids = null) {
  const [archivedOrderIds, supplierStateOf, dispatches] = await Promise.all([
    orderService.archivedOrderIds(connectionId).catch(() => []),
    orderService.supplierStateLookup(connectionId).catch(() => null),
    orderService.dispatchLookup(connectionId).catch(() => null),
  ]);
  const result = await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    if (connection.platform_key !== 'ebay') throw notEbay(connection, 'Orders');
    const listed = await ebayService.listOrdersDetailed(credentials, {
      connectionId,
      range: query.range,
      status: query.status,
      search: query.search,
      sort: query.sort,
      archived: query.archived,
      supplier: query.supplier,
      page: 1,
      perPage: Number.MAX_SAFE_INTEGER,
      push: ebayService.pushEnabled(connection),
      archivedOrderIds,
      supplierStateOf,
      dispatches,
      enrich: false,
    });
    return { ...listed, account: { label: connection.label, settings: connection.settings } };
  });

  const wanted = ids ? new Set(ids) : null;
  const orders = wanted ? result.orders.filter((o) => wanted.has(o.orderId)) : result.orders;
  const orderIds = orders.map((o) => o.orderId);
  const [sourcingByOrder, finances, costs, supplierUrls] = await Promise.all([
    orderService.sourcingForOrders(connectionId, orderIds),
    mirror.loadOrderFinances(connectionId, orderIds),
    orderRepository.sourceCostsByOrder(connectionId, orderIds),
    listingRepository.supplierUrlsByItem(connectionId, orders.flatMap((o) => (o.lineItems || []).map((li) => li.itemId))),
  ]);
  const moneyByOrder = new Map(orderIds.map((id) => [id, orderMoney(finances.get(id) || null, costs.get(id) || null)]));
  const { header, rows } = orderRows(orders, { sourcingByOrder, moneyByOrder, supplierUrls, ...siteOf(result.account) });
  const filename = `orders-${slug(result.account.label)}-${query.status}-${query.range}${ids ? '-selected' : ''}-${today()}.csv`;
  return { filename, csv: toCsv(header, rows), count: rows.length };
}

/** { filename, csv, count } of the account's live or ended listings under these filters (or only `ids`). */
async function listingsCsv(ownerId, connectionId, query, ids = null) {
  const result = await connectionService.withDecryptedCredentials(connectionId, ownerId, async (credentials, connection) => {
    if (connection.platform_key !== 'ebay') throw notEbay(connection, 'Listings');
    const listed = await listingService.pageOfListings(credentials, {
      connectionId,
      status: query.status,
      search: query.search,
      sort: query.sort,
      page: 1,
      perPage: 0,
      hiddenItemIds: query.status === 'inactive' ? connection.settings?.hiddenItemIds || [] : [],
      push: ebayService.pushEnabled(connection),
    });
    return { ...listed, account: { label: connection.label, settings: connection.settings } };
  });

  const wanted = ids ? new Set(ids.map(String)) : null;
  const items = wanted ? result.items.filter((l) => wanted.has(String(l.itemId))) : result.items;
  const supplierUrls = await listingRepository.supplierUrlsByItem(connectionId, items.map((l) => l.itemId));
  const { header, rows } = listingRows(items, { status: query.status, supplierUrls, timeZone: siteOf(result.account).timeZone });
  const filename = `listings-${slug(result.account.label)}-${query.status === 'inactive' ? 'ended' : 'active'}${ids ? '-selected' : ''}-${today()}.csv`;
  return { filename, csv: toCsv(header, rows), count: rows.length };
}

module.exports = { ordersCsv, listingsCsv };
