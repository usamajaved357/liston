// eBay's legacy Trading API (XML). Used alongside the newer Sell Inventory
// API because it's the only way to read listings/orders that already exist
// on a seller's account from outside Liston (e.g. Walexo's existing catalog,
// created years ago through eBay's own tools) — the Inventory API only sees
// inventory items it created itself. Auth reuses the same OAuth access token
// via the X-EBAY-API-IAF-TOKEN header, which eBay accepts for this API too.
const { XMLParser } = require('fast-xml-parser');
const governor = require('../request-governor');
const logger = require('../../../utils/logger');

// eBay escapes a listing's HTML description inside the XML, so one GetItem
// carries thousands of &lt;/&gt; entities — over fast-xml-parser's default
// "entity expansion" safety cap (1000), which is aimed at billion-laughs
// DOCTYPE bombs, not ordinary escaped text. Lifted for eBay's responses.
const PROCESS_ENTITIES = { maxTotalExpansions: Infinity, maxExpandedLength: 50_000_000 };
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: PROCESS_ENTITIES });

class EbayTradingError extends Error {
  constructor(message, statusCode = 502, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const COMPATIBILITY_LEVEL = '1193';

// `siteId` is the Trading site the seller lives on (0 US, 3 UK ...): revises
// and store reads fail or come back in the wrong currency on another site.
// Every call goes through the governor: budget check and flow control
// first, one count against the allowance after.
function tradingRequest(accessToken, callName, bodyXml, siteId = 0) {
  return governor.run(callName, () => tradingRequestNow(accessToken, callName, bodyXml, siteId));
}

async function tradingRequestNow(accessToken, callName, bodyXml, siteId = 0) {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>` +
    bodyXml +
    `</${callName}Request>`;

  const res = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-SITEID': String(siteId),
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
  } catch (err) {
    logger.warn('eBay Trading response unparseable', { callName, status: res.status, reason: err.message, head: text.slice(0, 300) });
    throw new EbayTradingError(`Couldn't parse eBay's response for ${callName}`, 502);
  }

  const body = parsed[`${callName}Response`];
  if (!body) {
    throw new EbayTradingError(`Unexpected eBay response shape for ${callName}`, 502);
  }
  if (body.Ack === 'Failure' || body.Ack === 'PartialFailure') {
    const errors = toArray(body.Errors);
    const raw = errors[0]?.LongMessage || errors[0]?.ShortMessage || `${callName} failed`;
    // eBay's daily Trading allowance for the app is spent. Nothing here is
    // wrong on the account; the figures come back when eBay resets it.
    const message = /exceeded usage limit/i.test(raw)
      ? "eBay's daily API allowance for Liston is used up for today. Live figures return when eBay resets it (midnight Pacific time)."
      : raw;
    const err = new EbayTradingError(message, /exceeded usage limit/i.test(raw) ? 429 : 502, errors);
    // eBay's own answer (why it refused), safe and useful to show — never
    // hidden behind "Internal server error" (errorHandler.middleware).
    err.expose = true;
    throw err;
  }
  // Ack=Warning is a success that did LESS than asked — eBay keeps parts of
  // a revision it refuses (a description on a listing with sales, say) and
  // only says so here. Logged, and handed to callers that can tell the
  // seller.
  if (body.Ack === 'Warning') {
    const all = toArray(body.Errors).map((e) => e.LongMessage || e.ShortMessage).filter(Boolean);
    const warnings = all.filter((w) => !NOTICE_ONLY.some((re) => re.test(w)));
    if (all.length) logger.warn(`eBay ${callName} completed with warnings`, { warnings: all });
    if (warnings.length) body._warnings = warnings;
  }
  return body;
}

// Warnings eBay attaches to a call that did everything asked: kept in the
// log, never shown to the seller as if part of an edit was dropped. eBay
// sends the business-policies one on every revise of a listing that still
// carries old-style postage/payment/returns fields from when it was listed
// (Liston's revise sends none of those; the policies stay as they were).
const NOTICE_ONLY = [/opted into business policies/i];

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
    // A purely numeric custom label ("10023") parses as a number.
    sku: item.SKU !== undefined && item.SKU !== null && item.SKU !== '' ? String(item.SKU) : null,
    title: String(item.Title ?? ''),
    price: money(item.SellingStatus?.CurrentPrice),
    convertedPrice: money(item.SellingStatus?.ConvertedCurrentPrice),
    quantity: Number(item.Quantity ?? 0),
    quantityAvailable: Number(item.QuantityAvailable ?? 0),
    quantitySold: Number(item.SellingStatus?.QuantitySold ?? 0),
    imageUrl: item.PictureDetails?.GalleryURL || null,
    viewItemUrl: item.ListingDetails?.ViewItemURL || null,
    startTime: item.ListingDetails?.StartTime || null,
    endTime: item.ListingDetails?.EndTime || null,
    // Buyers watching it now: GetMyeBaySelling returns it with the listing
    // (so listing analytics gets it without a traffic call) and leaves it
    // out when nobody is watching.
    watchCount: Number(item.WatchCount ?? 0),
  };
}

function paginationOf(container) {
  return {
    totalEntries: Number(container?.PaginationResult?.TotalNumberOfEntries ?? 0),
    totalPages: Number(container?.PaginationResult?.TotalNumberOfPages ?? 1),
  };
}

async function getActiveListings(accessToken, { pageNumber = 1, entriesPerPage = 25, siteId } = {}) {
  const body = `<ActiveList><Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnSummary</DetailLevel>`;
  const res = await tradingRequest(accessToken, 'GetMyeBaySelling', body, siteId);
  const list = res.ActiveList;
  return {
    items: toArray(list?.ItemArray?.Item).map(mapListingItem),
    ...paginationOf(list),
  };
}

// One listing in the Listings tab's shape (mapListingItem), for a change
// eBay pushed: GetItem trimmed to those fields, instead of re-reading every
// listing. `active` is false once it has ended.
const LISTING_ITEM_FIELDS = [
  'Item.ItemID',
  'Item.SKU',
  'Item.Title',
  'Item.Quantity',
  'Item.QuantityAvailable',
  'Item.SellingStatus.CurrentPrice',
  'Item.SellingStatus.ConvertedCurrentPrice',
  'Item.SellingStatus.QuantitySold',
  'Item.SellingStatus.ListingStatus',
  'Item.PictureDetails.GalleryURL',
  'Item.ListingDetails.ViewItemURL',
  'Item.ListingDetails.StartTime',
  'Item.ListingDetails.EndTime',
  'Item.WatchCount',
];
async function getListingItem(accessToken, itemId, { siteId } = {}) {
  const body = `<ItemID>${itemId}</ItemID><IncludeWatchCount>true</IncludeWatchCount>` + LISTING_ITEM_FIELDS.map((f) => `<OutputSelector>${f}</OutputSelector>`).join('');
  const res = await tradingRequest(accessToken, 'GetItem', body, siteId);
  const item = res.Item || {};
  const mapped = mapListingItem(item);
  // GetItem leaves QuantityAvailable out on some listings; it's what's left.
  if (item.QuantityAvailable === undefined) mapped.quantityAvailable = Math.max(0, mapped.quantity - mapped.quantitySold);
  return { item: mapped, active: (item.SellingStatus?.ListingStatus || 'Active') === 'Active' };
}

async function getUnsoldListings(accessToken, { pageNumber = 1, entriesPerPage = 25, siteId } = {}) {
  const body = `<UnsoldList><Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></UnsoldList><DetailLevel>ReturnSummary</DetailLevel>`;
  const res = await tradingRequest(accessToken, 'GetMyeBaySelling', body, siteId);
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
    // The delivery window eBay showed the buyer at checkout.
    estimatedDeliveryMin: transaction.ShippingServiceSelected?.ShippingPackageInfo?.EstimatedDeliveryTimeMin || null,
    estimatedDeliveryMax: transaction.ShippingServiceSelected?.ShippingPackageInfo?.EstimatedDeliveryTimeMax || null,
    // When the carrier confirmed delivery; eBay leaves it out until then.
    deliveredAt: transaction.ShippingServiceSelected?.ShippingPackageInfo?.ActualDeliveryTime || null,
    shippingService: transaction.ShippingServiceSelected?.ShippingService || null,
  };
}

// Where the order ships: the name eBay holds for the buyer, the address as
// lines, and the phone number when the buyer gave one. eBay's "Invalid
// Request" placeholder values are treated as absent.
function mapShippingAddress(a) {
  if (!a) return null;
  const text = (v) => (v === undefined || v === null ? '' : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim());
  const clean = (v) => {
    const t = text(v);
    return t && !/invalid request/i.test(t) ? t : '';
  };
  const address = {
    name: clean(a.Name),
    street1: clean(a.Street1),
    street2: clean(a.Street2),
    city: clean(a.CityName),
    state: clean(a.StateOrProvince),
    postalCode: clean(a.PostalCode),
    country: clean(a.CountryName) || clean(a.Country),
    phone: clean(a.Phone),
  };
  return Object.values(address).some(Boolean) ? address : null;
}

function mapOrder(order) {
  const transactions = toArray(order.TransactionArray?.Transaction);
  const firstItem = transactions[0]?.Item;
  const buyer = transactions[0]?.Buyer;
  const lineItems = transactions.map(mapLineItem);
  const dispatchByTime = lineItems.map((li) => li.handleByTime).filter(Boolean).sort()[0] || null;
  // Delivered once every item has arrived: the last arrival.
  const deliveredAt = lineItems.length && lineItems.every((li) => li.deliveredAt) ? lineItems.map((li) => li.deliveredAt).sort().slice(-1)[0] : null;

  return {
    orderId: order.OrderID,
    status: order.OrderStatus,
    createdAt: order.CreatedTime,
    total: money(order.Total),
    subtotal: money(order.Subtotal),
    buyerName: [buyer?.UserFirstName, buyer?.UserLastName].filter(Boolean).join(' ') || null,
    buyerUserId: order.BuyerUserID || null,
    // eBay's relay address for the buyer, and Seller Hub's sales record no.
    buyerEmail: buyer?.Email && !/invalid request/i.test(String(buyer.Email)) ? String(buyer.Email) : null,
    salesRecordNumber: order.ShippingDetails?.SellingManagerSalesRecordNumber ? String(order.ShippingDetails.SellingManagerSalesRecordNumber) : null,
    shippingAddress: mapShippingAddress(order.ShippingAddress),
    itemTitle: firstItem?.Title || null,
    itemId: firstItem?.ItemID ? String(firstItem.ItemID) : null,
    itemCount: transactions.length,
    checkoutStatus: order.CheckoutStatus?.Status || null,
    paidTime: order.PaidTime || null,
    shippedTime: order.ShippedTime || null,
    cancelStatus: order.CancelStatus || null,
    dispatchByTime,
    deliveredAt,
    lineItems,
  };
}

// Used to enrich an order's line items with an image + live quantity —
// GetOrders itself carries neither. OutputSelector trims the response to
// just what we need.
async function getItemSummary(accessToken, itemId, { siteId } = {}) {
  const body =
    `<ItemID>${itemId}</ItemID>` +
    `<OutputSelector>Item.PictureDetails</OutputSelector>` +
    `<OutputSelector>Item.Quantity</OutputSelector>` +
    `<OutputSelector>Item.QuantityAvailable</OutputSelector>` +
    `<OutputSelector>Item.SellingStatus.QuantitySold</OutputSelector>` +
    `<OutputSelector>Item.ListingDetails.ViewItemURL</OutputSelector>` +
    `<OutputSelector>Item.Variations.Pictures</OutputSelector>` +
    `<OutputSelector>Item.ItemSpecifics</OutputSelector>` +
    `<IncludeItemSpecifics>true</IncludeItemSpecifics>`;
  const res = await tradingRequest(accessToken, 'GetItem', body, siteId);
  const item = res.Item || {};
  const pictures = toArray(item.PictureDetails?.PictureURL);
  // A multi-variation listing's per-option photos (Colour → picture), so an
  // order line can show the exact variation the buyer chose, as Seller Hub
  // does, instead of the listing's main photo.
  const variationPictures = toArray(item.Variations?.Pictures).map((p) => ({
    specificName: String(p.VariationSpecificName || ''),
    byValue: Object.fromEntries(
      toArray(p.VariationSpecificPictureSet).map((set) => [String(set.VariationSpecificValue ?? ''), toArray(set.PictureURL)[0] || null]).filter(([, url]) => url)
    ),
  }));
  return {
    itemId: String(itemId),
    imageUrl: pictures[0] || item.PictureDetails?.GalleryURL || null,
    variationPictures,
    // The listing's item specifics, as Seller Hub's "See more item
    // specifics" lists them under an order line.
    specifics: specificsFrom(item.ItemSpecifics),
    quantity: item.Quantity !== undefined ? Number(item.Quantity) : null,
    quantityAvailable: item.QuantityAvailable !== undefined ? Number(item.QuantityAvailable) : null,
    quantitySold: item.SellingStatus?.QuantitySold !== undefined ? Number(item.SellingStatus.QuantitySold) : null,
    viewItemUrl: item.ListingDetails?.ViewItemURL || null,
  };
}

// Only the fields mapOrder/mapLineItem read. A full GetOrders response is
// several times larger (shipping addresses, fee breakdowns, monetary
// details) and the parse time was most of what the dashboard waited on.
const GET_ORDERS_FIELDS = [
  'PaginationResult',
  'HasMoreOrders',
  'OrderArray.Order.OrderID',
  'OrderArray.Order.OrderStatus',
  'OrderArray.Order.CreatedTime',
  'OrderArray.Order.Total',
  'OrderArray.Order.Subtotal',
  'OrderArray.Order.BuyerUserID',
  'OrderArray.Order.CheckoutStatus.Status',
  'OrderArray.Order.PaidTime',
  'OrderArray.Order.ShippedTime',
  'OrderArray.Order.CancelStatus',
  'OrderArray.Order.ShippingAddress',
  'OrderArray.Order.TransactionArray.Transaction.Item.ItemID',
  'OrderArray.Order.TransactionArray.Transaction.Item.Title',
  'OrderArray.Order.TransactionArray.Transaction.QuantityPurchased',
  'OrderArray.Order.TransactionArray.Transaction.TransactionPrice',
  'OrderArray.Order.TransactionArray.Transaction.Variation.VariationSpecifics',
  'OrderArray.Order.TransactionArray.Transaction.Buyer.UserFirstName',
  'OrderArray.Order.TransactionArray.Transaction.Buyer.UserLastName',
  'OrderArray.Order.TransactionArray.Transaction.Buyer.Email',
  'OrderArray.Order.ShippingDetails.SellingManagerSalesRecordNumber',
  'OrderArray.Order.TransactionArray.Transaction.ShippingDetails.ShipmentTrackingDetails',
  'OrderArray.Order.TransactionArray.Transaction.ShippingServiceSelected.ShippingPackageInfo.HandleByTime',
  'OrderArray.Order.TransactionArray.Transaction.ShippingServiceSelected.ShippingPackageInfo.EstimatedDeliveryTimeMin',
  'OrderArray.Order.TransactionArray.Transaction.ShippingServiceSelected.ShippingPackageInfo.EstimatedDeliveryTimeMax',
  'OrderArray.Order.TransactionArray.Transaction.ShippingServiceSelected.ShippingPackageInfo.ActualDeliveryTime',
  'OrderArray.Order.TransactionArray.Transaction.ShippingServiceSelected.ShippingService',
];

// createTimeFrom/createTimeTo are ISO 8601 strings; eBay caps this range at
// 90 days per request. Alternatively modTimeFrom/modTimeTo (≤30 days apart)
// select orders CHANGED in the window, which is how a refresh picks up only
// what moved since the last sync instead of re-reading 90 days. `orderIds`
// reads those orders alone (eBay then ignores any time window).
async function getOrders(accessToken, { createTimeFrom, createTimeTo, modTimeFrom, modTimeTo, orderIds, pageNumber = 1, entriesPerPage = 50, siteId } = {}) {
  const window = orderIds?.length
    ? `<OrderIDArray>${orderIds.map((id) => `<OrderID>${xmlEscape(String(id))}</OrderID>`).join('')}</OrderIDArray>`
    : modTimeFrom
      ? `<ModTimeFrom>${modTimeFrom}</ModTimeFrom><ModTimeTo>${modTimeTo}</ModTimeTo>`
      : `<CreateTimeFrom>${createTimeFrom}</CreateTimeFrom><CreateTimeTo>${createTimeTo}</CreateTimeTo>`;
  const body =
    window +
    `<OrderStatus>All</OrderStatus>` +
    `<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>` +
    GET_ORDERS_FIELDS.map((f) => `<OutputSelector>${f}</OutputSelector>`).join('');
  const res = await tradingRequest(accessToken, 'GetOrders', body, siteId);
  return {
    orders: toArray(res.OrderArray?.Order).map(mapOrder),
    ...paginationOf(res),
  };
}

// The seller's own store profile, straight from eBay: the store's name and
// the logo they uploaded to it, plus the account's real feedback figures.
// This is what fills the description template's branding without the seller
// typing any of it — and it can't drift from what eBay shows, because it IS
// what eBay shows.
async function getStoreProfile(accessToken, { siteId } = {}) {
  const [store, user] = await Promise.all([
    tradingRequest(accessToken, 'GetStore', '', siteId).catch(() => null),
    tradingRequest(accessToken, 'GetUser', '', siteId),
  ]);

  return {
    // Not every seller has an eBay Store subscription; those fall back to
    // their username below.
    storeName: store?.Store?.Name || null,
    logoUrl: store?.Store?.Logo?.URL || null,
    storeDescription: store?.Store?.Description || null,
    storeUrl: user.User?.SellerInfo?.StoreURL || null,
    username: user.User?.UserID || null,
    feedbackScore: user.User?.FeedbackScore != null ? Number(user.User.FeedbackScore) : null,
    feedbackPercent: user.User?.PositiveFeedbackPercent != null ? String(user.User.PositiveFeedbackPercent) : null,
  };
}

// Replaces the description of a LIVE listing. Republishing an inventory
// item group doesn't revise the description of an already-live listing
// (confirmed live), so a description change has to go through Trading's
// Ends a live listing now. EndItem covers every listing type; the reason is
// what eBay shows the seller in their own history.
async function endListing(accessToken, itemId, { siteId, reason = 'NotAvailable' } = {}) {
  const res = await tradingRequest(accessToken, 'EndItem', `<ItemID>${xmlEscape(String(itemId))}</ItemID><EndingReason>${reason}</EndingReason>`, siteId);
  return { itemId: String(itemId), endTime: res.EndTime ? String(res.EndTime) : null, warnings: res._warnings || [] };
}

// ReviseFixedPriceItem. Also the only way to repair a listing that went up
// with the plain text.
async function reviseDescription(accessToken, itemId, descriptionHtml, { siteId } = {}) {
  const body = await tradingRequest(
    accessToken,
    'ReviseFixedPriceItem',
    `<Item><ItemID>${itemId}</ItemID><Description><![CDATA[${descriptionHtml}]]></Description></Item>`,
    siteId
  );
  return { itemId: String(body.ItemID || itemId) };
}

// The seller's Shop categories (only sellers with an eBay Shop subscription
// have any): the custom departments a listing can be filed under, two levels
// deep. Returned as a tree of { id, name, children }.
// eBay's answer to GetStore for an account without a Shop subscription.
function isNoStoreError(err) {
  const texts = [err?.message, ...((err?.details || []).flatMap((e) => [e.LongMessage, e.ShortMessage, String(e.ErrorCode ?? '')]))];
  return texts.some((t) => /not (a )?store subscriber|no (ebay )?(store|shop) subscription|store subscription|not subscribed to (an )?(ebay )?(store|shop)/i.test(String(t || '')));
}

function mapStoreCategory(node) {
  return {
    id: String(node.CategoryID),
    name: String(node.Name),
    children: toArray(node.ChildCategory).map(mapStoreCategory),
  };
}

// Returns { categories, hasStore }. A seller without a Shop subscription
// has no departments (hasStore false) — a plain no. Any other failure is
// thrown, so it is never mistaken for "no departments".
async function getStoreCategories(accessToken, { siteId } = {}) {
  let res;
  try {
    res = await tradingRequest(accessToken, 'GetStore', '<CategoryStructureOnly>true</CategoryStructureOnly>', siteId);
  } catch (err) {
    if (isNoStoreError(err)) return { categories: [], hasStore: false };
    throw err;
  }
  return { categories: toArray(res?.Store?.CustomCategories?.CustomCategory).map(mapStoreCategory), hasStore: true };
}

// Adds a department to the seller's Shop (top level, or under `parentId`).
// eBay may run this as a background task; the caller re-reads the tree.
async function addStoreCategory(accessToken, { name, parentId }, { siteId } = {}) {
  const body =
    `<Action>Add</Action>` +
    (parentId ? `<DestinationParentCategoryID>${xmlEscape(parentId)}</DestinationParentCategoryID>` : '') +
    `<StoreCategories><CustomCategory><Name>${xmlEscape(name)}</Name></CustomCategory></StoreCategories>`;
  const res = await tradingRequest(accessToken, 'SetStoreCategories', body, siteId);
  const created = toArray(res.CustomCategory)[0];
  return { status: String(res.Status || 'Complete'), category: created ? mapStoreCategory(created) : null, warnings: res._warnings || [] };
}

// Feedback buyers left for this seller: the genuine reviews a description
// template may quote. Positive comments only, most recent first.
async function getSellerFeedback(accessToken, { siteId, entriesPerPage = 100 } = {}) {
  const res = await tradingRequest(
    accessToken,
    'GetFeedback',
    `<FeedbackType>FeedbackReceivedAsSeller</FeedbackType><DetailLevel>ReturnAll</DetailLevel>` +
      `<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`,
    siteId
  );
  return toArray(res.FeedbackDetailArray?.FeedbackDetail).map((f) => ({
    text: String(f.CommentText || '').trim(),
    type: String(f.CommentType || ''),
    buyer: f.CommentingUser ? String(f.CommentingUser) : '',
    date: f.CommentTime ? String(f.CommentTime) : '',
    itemTitle: f.ItemTitle ? String(f.ItemTitle) : '',
  }));
}

// Subscribes the token's account to Platform Notifications (see
// ebay.notifications.js for the events and the delivery URL).
async function setNotificationPreferences(accessToken, bodyXml, { siteId } = {}) {
  await tradingRequest(accessToken, 'SetNotificationPreferences', bodyXml, siteId);
}

// Trading's numeric condition ids <-> the Inventory API enum the drafts use.
const CONDITION_IDS = {
  NEW: 1000,
  NEW_OTHER: 1500,
  NEW_WITH_DEFECTS: 1750,
  CERTIFIED_REFURBISHED: 2000,
  SELLER_REFURBISHED: 2500,
  USED_EXCELLENT: 3000,
  USED_VERY_GOOD: 4000,
  USED_GOOD: 5000,
  USED_ACCEPTABLE: 6000,
  FOR_PARTS_OR_NOT_WORKING: 7000,
};
function conditionFromId(id) {
  const n = Number(id);
  return Object.keys(CONDITION_IDS).find((k) => CONDITION_IDS[k] === n) || null;
}
function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function nameValueList(specifics) {
  return Object.entries(specifics || {})
    .filter(([, values]) => (Array.isArray(values) ? values.length : values))
    .map(
      ([name, values]) =>
        `<NameValueList><Name>${xmlEscape(name)}</Name>${(Array.isArray(values) ? values : [values]).map((v) => `<Value>${xmlEscape(v)}</Value>`).join('')}</NameValueList>`
    )
    .join('');
}
function specificsFrom(node) {
  const out = {};
  for (const nv of toArray(node?.NameValueList)) {
    const values = toArray(nv.Value).map((v) => (typeof v === 'object' ? v['#text'] : v)).filter((v) => v !== undefined && v !== '');
    if (nv.Name && values.length) out[String(nv.Name)] = values.map(String);
  }
  return out;
}

// Everything the editor needs to load a live listing: text, pictures,
// price, stock, condition, specifics and (if any) the variation matrix.
async function getItem(accessToken, itemId, { siteId } = {}) {
  const res = await tradingRequest(accessToken, 'GetItem', `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`, siteId);
  const item = res.Item || {};
  const variationsNode = item.Variations;
  const variations = toArray(variationsNode?.Variation).map((v) => ({
    sku: v.SKU ? String(v.SKU) : null,
    price: money(v.StartPrice),
    quantity: Number(v.Quantity ?? 0),
    quantitySold: Number(v.SellingStatus?.QuantitySold ?? 0),
    specifics: specificsFrom(v.VariationSpecifics),
  }));
  const variationPictures = toArray(variationsNode?.Pictures).map((p) => ({
    specificName: p.VariationSpecificName,
    byValue: Object.fromEntries(toArray(p.VariationSpecificPictureSet).map((set) => [String(set.VariationSpecificValue), toArray(set.PictureURL).map(String)])),
  }));
  return {
    itemId: String(item.ItemID || itemId),
    sku: item.SKU ? String(item.SKU) : null,
    title: item.Title || '',
    description: item.Description || '',
    imageUrls: toArray(item.PictureDetails?.PictureURL).map(String),
    price: money(item.StartPrice),
    quantity: Number(item.Quantity ?? 0),
    quantitySold: Number(item.SellingStatus?.QuantitySold ?? 0),
    condition: conditionFromId(item.ConditionID),
    conditionId: item.ConditionID ? Number(item.ConditionID) : null,
    categoryId: item.PrimaryCategory?.CategoryID ? String(item.PrimaryCategory.CategoryID) : null,
    categoryPath: item.PrimaryCategory?.CategoryName ? String(item.PrimaryCategory.CategoryName).split(':') : [],
    specifics: specificsFrom(item.ItemSpecifics),
    currency: item.StartPrice?.['@_currencyID'] || item.Currency || null,
    viewItemUrl: item.ListingDetails?.ViewItemURL || null,
    listingType: item.ListingType || null,
    // 'Active', or 'Completed'/'Ended' once it has come off eBay.
    listingStatus: item.SellingStatus?.ListingStatus || null,
    variationSpecificsSet: specificsFrom(variationsNode?.VariationSpecificsSet),
    variations,
    variationPictures,
    // What a buyer pays and waits for, for the listing health check.
    shipping: shippingFrom(item),
    returnsAccepted: item.ReturnPolicy?.ReturnsAcceptedOption ? item.ReturnPolicy.ReturnsAcceptedOption === 'ReturnsAccepted' : null,
  };
}

// The first (cheapest, as eBay lists them) domestic postage option and the
// dispatch time.
function shippingFrom(item) {
  const first = toArray(item.ShippingDetails?.ShippingServiceOptions)[0];
  const cost = first ? (first.FreeShipping === true || first.FreeShipping === 'true' ? 0 : Number(first.ShippingServiceCost?.['#text'] ?? first.ShippingServiceCost ?? NaN)) : NaN;
  const dispatch = Number(item.DispatchTimeMax);
  return { cost: Number.isFinite(cost) ? cost : null, dispatchDays: Number.isFinite(dispatch) ? dispatch : null };
}

// Revises a live fixed-price listing in place. Only the fields given are
// sent; eBay leaves the rest as they were. For a variation listing the
// whole matrix goes up together, because eBay treats <Variations> as a
// replacement set.
async function reviseListing(accessToken, itemId, fields, { siteId } = {}) {
  const res = await tradingRequest(accessToken, 'ReviseFixedPriceItem', itemChangesXml(itemId, fields), siteId);
  return { itemId: String(res.ItemID || itemId), warnings: res._warnings || [] };
}

// Puts an ended fixed-price listing back on eBay with the same fields as a
// revision (RelistFixedPriceItem takes the same <Item> changes). eBay gives
// it a new item number; the ended one stays ended.
async function relistListing(accessToken, itemId, fields, { siteId } = {}) {
  const res = await tradingRequest(accessToken, 'RelistFixedPriceItem', itemChangesXml(itemId, fields), siteId);
  return { itemId: String(res.ItemID), relistedFrom: String(itemId), warnings: res._warnings || [] };
}

// The <Item> with only the fields given: shared by revise and relist.
function itemChangesXml(itemId, { title, descriptionHtml, price, quantity, conditionId, imageUrls, specifics, variations, variationSpecificsSet, variationPictures }) {
  let body = `<Item><ItemID>${itemId}</ItemID>`;
  if (title !== undefined) body += `<Title>${xmlEscape(title)}</Title>`;
  if (descriptionHtml !== undefined) body += `<Description><![CDATA[${descriptionHtml}]]></Description>`;
  if (conditionId) body += `<ConditionID>${conditionId}</ConditionID>`;
  if (imageUrls && imageUrls.length) body += `<PictureDetails>${imageUrls.map((u) => `<PictureURL>${xmlEscape(u)}</PictureURL>`).join('')}</PictureDetails>`;
  if (specifics) body += `<ItemSpecifics>${nameValueList(specifics)}</ItemSpecifics>`;
  if (variations && variations.length) {
    body += '<Variations>';
    if (variationSpecificsSet) body += `<VariationSpecificsSet>${nameValueList(variationSpecificsSet)}</VariationSpecificsSet>`;
    for (const v of variations) {
      body += '<Variation>';
      if (v.sku) body += `<SKU>${xmlEscape(v.sku)}</SKU>`;
      if (v.price) body += `<StartPrice currencyID="${xmlEscape(v.price.currency)}">${Number(v.price.amount).toFixed(2)}</StartPrice>`;
      if (v.quantity !== undefined) body += `<Quantity>${Math.max(0, Number(v.quantity) || 0)}</Quantity>`;
      body += `<VariationSpecifics>${nameValueList(v.specifics)}</VariationSpecifics>`;
      body += '</Variation>';
    }
    if (variationPictures && variationPictures.length) {
      for (const p of variationPictures) {
        const sets = Object.entries(p.byValue || {}).filter(([, urls]) => urls && urls.length);
        if (!sets.length) continue;
        body += `<Pictures><VariationSpecificName>${xmlEscape(p.specificName)}</VariationSpecificName>`;
        for (const [value, urls] of sets) {
          body += `<VariationSpecificPictureSet><VariationSpecificValue>${xmlEscape(value)}</VariationSpecificValue>${urls.map((u) => `<PictureURL>${xmlEscape(u)}</PictureURL>`).join('')}</VariationSpecificPictureSet>`;
        }
        body += '</Pictures>';
      }
    }
    body += '</Variations>';
  } else {
    if (price) body += `<StartPrice currencyID="${xmlEscape(price.currency)}">${Number(price.amount).toFixed(2)}</StartPrice>`;
    if (quantity !== undefined) body += `<Quantity>${Math.max(0, Number(quantity) || 0)}</Quantity>`;
  }
  body += '</Item>';
  return body;
}

// Which eBay site the seller registered on, and the address eBay holds for
// them: the two things needed to set a connection up for the right market.
async function getUserProfile(accessToken) {
  const res = await tradingRequest(accessToken, 'GetUser', '<DetailLevel>ReturnAll</DetailLevel>');
  const user = res.User || {};
  const a = user.RegistrationAddress || {};
  return {
    username: user.UserID || null,
    site: user.Site || null,
    storeSite: user.SellerInfo?.StoreSite || null,
    registrationAddress: {
      name: a.Name ? String(a.Name) : '',
      company: a.CompanyName ? String(a.CompanyName) : '',
      addressLine1: a.Street1 ? String(a.Street1) : a.Street ? String(a.Street) : '',
      addressLine2: a.Street2 ? String(a.Street2) : '',
      city: a.CityName ? String(a.CityName) : '',
      stateOrProvince: a.StateOrProvince ? String(a.StateOrProvince) : '',
      postalCode: a.PostalCode !== undefined ? String(a.PostalCode) : '',
      country: a.Country ? String(a.Country) : '',
      phone: a.Phone !== undefined ? String(a.Phone) : '',
    },
  };
}

// Another member's public feedback, as Seller Hub shows beside a buyer's
// name ("gramoug0 (64)"). GetUser on a user other than the caller returns
// only public fields; the score is what's wanted.
async function getMemberFeedback(accessToken, userId, siteId = 0) {
  const res = await tradingRequest(accessToken, 'GetUser', `<UserID>${xmlEscape(String(userId))}</UserID>`, siteId);
  const user = res.User || {};
  return {
    username: user.UserID || userId,
    feedbackScore: user.FeedbackScore != null ? Number(user.FeedbackScore) : null,
    feedbackPercent: user.PositiveFeedbackPercent != null ? String(user.PositiveFeedbackPercent) : null,
    registeredAt: user.RegistrationDate || null,
  };
}

module.exports = {
  EbayTradingError,
  relistListing,
  getUserProfile,
  getMemberFeedback,
  getStoreCategories,
  addStoreCategory,
  isNoStoreError,
  getSellerFeedback,
  setNotificationPreferences,
  CONDITION_IDS,
  getActiveListings,
  getUnsoldListings,
  getOrders,
  getListingItem,
  getItemSummary,
  getItem,
  getStoreProfile,
  reviseDescription,
  endListing,
  reviseListing,
};
