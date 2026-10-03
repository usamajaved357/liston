// The columns of an account's Orders and Listings CSV downloads. Pure: the
// rows already found (exports.service) in, header and rows out.
//
// Orders: one row per order. An order of several items lists each item's
// values in the same place, joined " | " in the order's own order (a
// missing one shown as "—"), the same for its supplier orders. Money is the
// order's (eBay's finances, the supplier cost and the profit), once.
//
// What a supplier order carries is named field by field below. The login
// saved for buying from the supplier (its email and password, the account's
// email) and the payment card's label are never read here, so they can't
// reach a file.

const ORDER_STATUS = {
  awaiting_payment: 'Awaiting payment',
  awaiting_dispatch: 'Awaiting dispatch',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const SUPPLIER_STATUS = {
  to_order: 'To order',
  ordered: 'Ordered',
  shipped: 'Shipped',
  delivered: 'Delivered',
  problem: 'Problem',
};

/** "2026-10-03 14:05" in the account's time zone, or "" without a time. */
function stamp(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const present = (v) => v !== null && v !== undefined && v !== '';
const amount = (v) => (present(v) && Number.isFinite(Number(v)) ? Number(v) : null);

// One value per item (or supplier order): the value alone for one, joined " | " for several.
function each(list, pick) {
  const values = list.map((x) => {
    const v = pick(x);
    return present(v) ? String(v) : '';
  });
  if (!values.some(Boolean)) return '';
  return values.length === 1 ? values[0] : values.map((v) => v || '—').join(' | ');
}

function orderRows(orders, { sourcingByOrder = {}, moneyByOrder = new Map(), supplierUrls = new Map(), timeZone = 'Europe/London', itemHost = null } = {}) {
  const at = (iso) => stamp(iso, timeZone);
  const t = (label) => `${label} (${timeZone})`;
  const header = [
    'Order ID',
    'Sales record',
    'Status',
    t('Ordered'),
    t('Paid'),
    t('Dispatch by'),
    t('Dispatched'),
    t('Delivered'),
    'Marked dispatched by',
    'Archived',
    'Buyer username',
    'Buyer name',
    'Buyer email',
    'Ship to',
    'Address line 1',
    'Address line 2',
    'City',
    'County / state',
    'Postcode',
    'Country',
    'Phone',
    'Units',
    'Item IDs',
    'Titles',
    'Variations',
    'Quantities',
    'Item prices',
    'Item links',
    'Postage service',
    'eBay carrier',
    'eBay tracking',
    'Currency',
    'Order total',
    'eBay fees',
    'Ad fees',
    'Refunds',
    'Earnings',
    'Funds',
    'Supplier status',
    'Supplier',
    'Supplier account',
    'Supplier order no.',
    t('Ordered from supplier'),
    'Ordered by',
    'Supplier cost',
    'Supplier carrier',
    'Supplier tracking',
    t('Supplier dispatched'),
    'Dispatched by',
    'Supplier notes',
    'Supplier links',
    'Profit',
    'Margin %',
  ];

  const rows = orders.map((o) => {
    const lines = o.lineItems || [];
    const address = o.shippingAddress || {};
    const money = moneyByOrder.get(o.orderId) || null;
    // Each supplier order, by the fields a file may carry, and nothing else.
    const sourcing = (sourcingByOrder[o.orderId] || []).map((s) => ({
      status: SUPPLIER_STATUS[s.status] || s.status,
      platform: s.sourcePlatform,
      account: s.sourceAccountLabel,
      orderNo: s.sourceOrderNo,
      placedAt: at(s.placedAt),
      placedBy: s.placedBy?.name,
      cost: s.cost && present(s.cost.value) ? `${Number(s.cost.value).toFixed(2)}${s.cost.currency ? ` ${s.cost.currency}` : ''}` : '',
      carrier: s.carrier,
      tracking: s.trackingNumber,
      dispatchedAt: at(s.dispatchedAt),
      dispatchedBy: s.dispatchedBy?.name,
      notes: s.notes,
    }));
    const marked = o.markedDispatched;
    const services = [...new Set(lines.map((li) => li.shippingService).filter(Boolean))];
    return [
      o.orderId,
      o.salesRecordNumber,
      ORDER_STATUS[o.derivedStatus] || o.derivedStatus || o.status,
      at(o.createdAt),
      at(o.paidTime),
      at(o.dispatchByTime),
      at(o.shippedTime),
      at(o.deliveredAt),
      marked ? [marked.by, at(marked.at)].filter(Boolean).join(', ') : '',
      o.archived ? 'Yes' : '',
      o.buyerUserId,
      o.buyerName,
      o.buyerEmail,
      address.name,
      address.street1,
      address.street2,
      address.city,
      address.state,
      address.postalCode,
      address.country,
      address.phone,
      lines.reduce((n, li) => n + (Number(li.quantityPurchased) || 0), 0),
      each(lines, (li) => li.itemId),
      each(lines, (li) => li.title),
      each(lines, (li) => (li.variation || []).map((v) => `${v.name}: ${v.value}`).join(', ')),
      each(lines, (li) => li.quantityPurchased),
      each(lines, (li) => (present(li.price?.amount) ? Number(li.price.amount).toFixed(2) : '')),
      each(lines, (li) => li.viewItemUrl || (li.itemId && itemHost ? `https://${itemHost}/itm/${li.itemId}` : '')),
      services.join(' | '),
      each(lines, (li) => li.trackingCarrier),
      each(lines, (li) => li.trackingNumber),
      money?.currency || o.total?.currency || '',
      amount(o.total?.amount),
      money?.fees ?? null,
      money?.adFees ?? null,
      money?.refunds ?? null,
      money?.earnings ?? null,
      money?.fundsStatus || '',
      each(sourcing, (s) => s.status),
      each(sourcing, (s) => s.platform),
      each(sourcing, (s) => s.account),
      each(sourcing, (s) => s.orderNo),
      each(sourcing, (s) => s.placedAt),
      each(sourcing, (s) => s.placedBy),
      money?.cost ? money.cost.value : each(sourcing, (s) => s.cost),
      each(sourcing, (s) => s.carrier),
      each(sourcing, (s) => s.tracking),
      each(sourcing, (s) => s.dispatchedAt),
      each(sourcing, (s) => s.dispatchedBy),
      each(sourcing, (s) => s.notes),
      each(lines, (li) => supplierUrls.get(String(li.itemId))),
      money?.profit ?? null,
      money?.margin ?? null,
    ];
  });

  return { header, rows };
}

function listingRows(items, { status = 'active', supplierUrls = new Map(), timeZone = 'Europe/London' } = {}) {
  const at = (iso) => stamp(iso, timeZone);
  const t = (label) => `${label} (${timeZone})`;
  const header = [
    'Item ID',
    'SKU',
    'Title',
    'Status',
    'Price',
    'Currency',
    'Quantity',
    'Available',
    'Sold',
    'Watchers',
    t('Listed'),
    t(status === 'inactive' ? 'Ended' : 'Ends'),
    t('Last sold'),
    t('Last edited'),
    'eBay link',
    'Supplier link',
    'Photo',
  ];
  const rows = items.map((l) => [
    l.itemId,
    l.sku,
    l.title,
    status === 'inactive' ? 'Ended' : 'Active',
    amount(l.price?.amount),
    l.price?.currency || '',
    amount(l.quantity),
    amount(l.quantityAvailable),
    amount(l.quantitySold),
    amount(l.watchCount),
    at(l.startTime),
    at(l.endTime),
    at(l.lastSoldAt),
    at(l.lastEditedAt),
    l.viewItemUrl,
    supplierUrls.get(String(l.itemId)) || '',
    l.imageUrl,
  ]);
  return { header, rows };
}

module.exports = { orderRows, listingRows, stamp };
