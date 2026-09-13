// eBay's legacy Trading API (XML). Used alongside the newer Sell Inventory
// API because it's the only way to read listings/orders that already exist
// on a seller's account from outside Liston (e.g. Walexo's existing catalog,
// created years ago through eBay's own tools) — the Inventory API only sees
// inventory items it created itself. Auth reuses the same OAuth access token
// via the X-EBAY-API-IAF-TOKEN header, which eBay accepts for this API too.
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

class EbayTradingError extends Error {
  constructor(message, statusCode = 502, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const COMPATIBILITY_LEVEL = '1193';

async function tradingRequest(accessToken, callName, bodyXml) {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>` +
    bodyXml +
    `</${callName}Request>`;

  const res = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': COMPATIBILITY_LEVEL,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml',
    },
    body: xml,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new EbayTradingError(`Couldn't parse eBay's response for ${callName}`, 502);
  }

  const body = parsed[`${callName}Response`];
  if (!body) {
    throw new EbayTradingError(`Unexpected eBay response shape for ${callName}`, 502);
  }
  if (body.Ack === 'Failure' || body.Ack === 'PartialFailure') {
    const errors = toArray(body.Errors);
    const message = errors[0]?.LongMessage || errors[0]?.ShortMessage || `${callName} failed`;
    throw new EbayTradingError(message, 502, errors);
  }
  return body;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function money(node) {
  if (node === undefined || node === null) return null;
  const amount = typeof node === 'object' ? node['#text'] : node;
  const currency = typeof node === 'object' ? node['@_currencyID'] : undefined;
  const parsedAmount = Number(amount);
  return Number.isFinite(parsedAmount) ? { amount: parsedAmount, currency } : null;
}

function mapListingItem(item) {
  return {
    itemId: String(item.ItemID),
    sku: item.SKU || null,
    title: item.Title,
    price: money(item.SellingStatus?.CurrentPrice),
    convertedPrice: money(item.SellingStatus?.ConvertedCurrentPrice),
    quantity: Number(item.Quantity ?? 0),
    quantityAvailable: Number(item.QuantityAvailable ?? 0),
    quantitySold: Number(item.SellingStatus?.QuantitySold ?? 0),
    imageUrl: item.PictureDetails?.GalleryURL || null,
    viewItemUrl: item.ListingDetails?.ViewItemURL || null,
    startTime: item.ListingDetails?.StartTime || null,
    endTime: item.ListingDetails?.EndTime || null,
  };
}

function paginationOf(container) {
  return {
    totalEntries: Number(container?.PaginationResult?.TotalNumberOfEntries ?? 0),
    totalPages: Number(container?.PaginationResult?.TotalNumberOfPages ?? 1),
  };
}

async function getActiveListings(accessToken, { pageNumber = 1, entriesPerPage = 25 } = {}) {
  const body = `<ActiveList><Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnSummary</DetailLevel>`;
  const res = await tradingRequest(accessToken, 'GetMyeBaySelling', body);
  const list = res.ActiveList;
  return {
    items: toArray(list?.ItemArray?.Item).map(mapListingItem),
    ...paginationOf(list),
  };
}

async function getUnsoldListings(accessToken, { pageNumber = 1, entriesPerPage = 25 } = {}) {
  const body = `<UnsoldList><Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></UnsoldList><DetailLevel>ReturnSummary</DetailLevel>`;
  const res = await tradingRequest(accessToken, 'GetMyeBaySelling', body);
  const list = res.UnsoldList;
  return {
    items: toArray(list?.ItemArray?.Item).map(mapListingItem),
    ...paginationOf(list),
  };
}

function mapLineItem(transaction) {
  const item = transaction.Item || {};
  const tracking = transaction.ShippingDetails?.ShipmentTrackingDetails;
  return {
    itemId: item.ItemID ? String(item.ItemID) : null,
    title: item.Title || null,
    quantityPurchased: Number(transaction.QuantityPurchased ?? 1),
    price: money(transaction.TransactionPrice),
    variation: toArray(transaction.Variation?.VariationSpecifics?.NameValueList).map((nv) => ({
      name: nv.Name,
      value: typeof nv.Value === 'object' ? nv.Value['#text'] : nv.Value,
    })),
    trackingCarrier: tracking?.ShippingCarrierUsed || null,
    trackingNumber: tracking?.ShipmentTrackingNumber || null,
    handleByTime: transaction.ShippingServiceSelected?.ShippingPackageInfo?.HandleByTime || null,
  };
}

function mapOrder(order) {
  const transactions = toArray(order.TransactionArray?.Transaction);
  const firstItem = transactions[0]?.Item;
  const buyer = transactions[0]?.Buyer;
  const lineItems = transactions.map(mapLineItem);
  const dispatchByTime = lineItems.map((li) => li.handleByTime).filter(Boolean).sort()[0] || null;

  return {
    orderId: order.OrderID,
    status: order.OrderStatus,
    createdAt: order.CreatedTime,
    total: money(order.Total),
    subtotal: money(order.Subtotal),
    buyerName: [buyer?.UserFirstName, buyer?.UserLastName].filter(Boolean).join(' ') || null,
    buyerUserId: order.BuyerUserID || null,
    itemTitle: firstItem?.Title || null,
    itemId: firstItem?.ItemID ? String(firstItem.ItemID) : null,
    itemCount: transactions.length,
    checkoutStatus: order.CheckoutStatus?.Status || null,
    paidTime: order.PaidTime || null,
    shippedTime: order.ShippedTime || null,
    cancelStatus: order.CancelStatus || null,
    dispatchByTime,
    lineItems,
  };
}

// Used to enrich an order's line items with an image + live quantity —
// GetOrders itself carries neither. OutputSelector trims the response to
// just what we need.
async function getItemSummary(accessToken, itemId) {
  const body =
    `<ItemID>${itemId}</ItemID>` +
    `<OutputSelector>Item.PictureDetails</OutputSelector>` +
    `<OutputSelector>Item.Quantity</OutputSelector>` +
    `<OutputSelector>Item.QuantityAvailable</OutputSelector>` +
    `<OutputSelector>Item.ListingDetails.ViewItemURL</OutputSelector>`;
  const res = await tradingRequest(accessToken, 'GetItem', body);
  const item = res.Item || {};
  const pictures = toArray(item.PictureDetails?.PictureURL);
  return {
    itemId: String(itemId),
    imageUrl: pictures[0] || item.PictureDetails?.GalleryURL || null,
    quantity: item.Quantity !== undefined ? Number(item.Quantity) : null,
    quantityAvailable: item.QuantityAvailable !== undefined ? Number(item.QuantityAvailable) : null,
    viewItemUrl: item.ListingDetails?.ViewItemURL || null,
  };
}

// createTimeFrom/createTimeTo are ISO 8601 strings; eBay caps this range at
// 90 days per request.
async function getOrders(accessToken, { createTimeFrom, createTimeTo, pageNumber = 1, entriesPerPage = 50 } = {}) {
  const body =
    `<CreateTimeFrom>${createTimeFrom}</CreateTimeFrom>` +
    `<CreateTimeTo>${createTimeTo}</CreateTimeTo>` +
    `<OrderStatus>All</OrderStatus>` +
    `<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>`;
  const res = await tradingRequest(accessToken, 'GetOrders', body);
  return {
    orders: toArray(res.OrderArray?.Order).map(mapOrder),
    ...paginationOf(res),
  };
}

module.exports = { EbayTradingError, getActiveListings, getUnsoldListings, getOrders, getItemSummary };
