const connectionRepository = require('../connections/connection.repository');
const teamRepository = require('../team/team.repository');
const ebayService = require('../ebay/ebay.service');
const referencesRepository = require('./references.repository');
const { detect } = require('./reference-detect');

// Liston cards: a reference (an order, a live listing, a draft, a hunted
// product, a buyer's eBay conversation: "Discuss with team") turned into a
// preview anyone in the team can click, whichever
// account it's in: the card names the account and links to that page there,
// so the click opens it in that account whatever account the viewer was
// working in. Only what the viewer may open is shown: something in an
// account (or area) they can't reach is a locked card that says so, with
// none of its details. Read from Liston's own mirrors: no eBay call.

// The access each kind needs on its account (any one of them).
const FEATURES = {
  order: ['orders'],
  listing: ['listings'],
  draft: ['listings'],
  hunt: ['hunting', 'hunting_review', 'listings'],
  conversation: ['inbox'],
};
const KINDS = Object.keys(FEATURES);

const ORDER_STATUS = {
  awaiting_payment: { label: 'Awaiting payment', tone: 'warn' },
  awaiting_dispatch: { label: 'To dispatch', tone: 'warn' },
  dispatched: { label: 'Dispatched', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};
const HUNT_STAGE = {
  sourcing: { label: 'Needs a supplier', tone: 'info' },
  pending: { label: 'Waiting for review', tone: 'info' },
  sent_back: { label: 'Sent back', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  drafted: { label: 'Drafted', tone: 'good' },
  listed: { label: 'Listed', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' },
};

const money = (amount, currency) => (amount === null || amount === undefined || amount === '' || !Number.isFinite(Number(amount)) ? null : { kind: 'money', amount: Number(amount), currency: currency || 'GBP' });
const text = (t) => (t ? { kind: 'text', text: String(t) } : null);

/**
 * The viewer's accounts for a kind: every account of the owner, and the ids
 * of those the viewer may open for it (all of them for the owner).
 */
async function accountsFor(auth) {
  const all = (await connectionRepository.findAllByUser(auth.ownerId)).map((c) => ({ id: c.id, label: c.label, platform: c.platform_key }));
  const byId = new Map(all.map((c) => [c.id, c]));
  const allowed = {};
  for (const kind of KINDS) {
    if (auth.role === 'owner') {
      allowed[kind] = all.map((c) => c.id);
      continue;
    }
    const ok = await Promise.all(all.map((c) => teamRepository.resolveAnyPermission(auth.userId, c.id, FEATURES[kind])));
    allowed[kind] = all.filter((c, i) => ok[i]).map((c) => c.id);
  }
  return { all, byId, allowed };
}

const account = (accounts, id) => {
  const c = accounts.byId.get(id);
  return c ? { id: c.id, label: c.label } : { id, label: null };
};

function orderCard(accounts, row, images) {
  const o = row.data || {};
  const lines = o.lineItems || [];
  const first = lines[0] || {};
  const more = Math.max(lines.length, 1) - 1;
  const status = ORDER_STATUS[ebayService.classifyOrderStatus(o)] || null;
  return {
    kind: 'order',
    id: o.orderId,
    key: `order:${row.connectionId}:${o.orderId}`,
    account: account(accounts, row.connectionId),
    title: `${first.title || o.itemTitle || 'Order'}${more > 0 ? ` (+${more} more)` : ''}`,
    image: images.get(String(first.itemId || o.itemId || '')) || null,
    status,
    facts: [text(`Order ${o.orderId}`), money(o.total?.amount, o.total?.currency), text(o.buyerUserId ? `Buyer ${o.buyerUserId}` : null), o.createdAt ? { kind: 'date', at: o.createdAt } : null].filter(Boolean),
    url: `/accounts/${row.connectionId}/orders/${encodeURIComponent(o.orderId)}`,
    locked: false,
  };
}

function listingCard(accounts, row) {
  const i = row.item || {};
  const available = i.quantityAvailable ?? (i.quantity !== undefined && i.quantitySold !== undefined ? i.quantity - i.quantitySold : null);
  return {
    kind: 'listing',
    id: String(i.itemId),
    key: `listing:${row.connectionId}:${i.itemId}`,
    account: account(accounts, row.connectionId),
    title: i.title || `Listing ${i.itemId}`,
    image: i.imageUrl ? String(i.imageUrl).replace(/s-l\d+\./, 's-l500.') : null,
    status: { label: 'Live', tone: 'good' },
    facts: [money(i.price?.amount, i.price?.currency), available !== null && available !== undefined ? text(`${available} available`) : null, i.quantitySold ? text(`${i.quantitySold} sold`) : null, text(i.sku ? `SKU ${i.sku}` : null)].filter(Boolean),
    url: `/accounts/${row.connectionId}/listings?q=${encodeURIComponent(i.itemId)}`,
    locked: false,
  };
}

function draftCard(accounts, row) {
  const d = row.data || {};
  const status = row.status === 'pending_review' ? { label: 'Draft', tone: 'info' } : row.status === 'published' ? { label: 'Published', tone: 'good' } : row.status === 'failed' ? { label: 'Failed', tone: 'bad' } : { label: 'Draft', tone: 'info' };
  const variants = Array.isArray(d.variants) ? d.variants.length : 0;
  return {
    kind: 'draft',
    id: row.id,
    key: `draft:${row.connectionId}:${row.id}`,
    account: account(accounts, row.connectionId),
    title: d.title || d.commonTitle || 'Untitled draft',
    image: (Array.isArray(d.imageUrls) && d.imageUrls[0]) || null,
    status,
    facts: [money(d.price?.value, d.price?.currency), variants ? text(`${variants} variations`) : null, text(d.sku ? `SKU ${d.sku}` : null)].filter(Boolean),
    url: `/accounts/${row.connectionId}/listings/draft/${row.id}`,
    locked: false,
  };
}

function huntCard(accounts, row) {
  const profit = row.headline_profit === null || row.headline_profit === undefined ? null : Number(row.headline_profit);
  return {
    kind: 'hunt',
    id: row.id,
    key: `hunt:${row.connection_id}:${row.id}`,
    account: account(accounts, row.connection_id),
    title: row.title || 'Hunted product',
    image: row.image_url || null,
    status: HUNT_STAGE[row.stage] || null,
    facts: [profit !== null ? { kind: 'money', amount: profit, currency: row.currency || 'GBP', label: 'profit' } : null, row.headline_roi !== null && row.headline_roi !== undefined ? text(`${Math.round(Number(row.headline_roi))}% return`) : null].filter(Boolean),
    url: `/accounts/${row.connection_id}/hunting?open=${row.id}`,
    locked: false,
  };
}

function conversationCard(accounts, row, images) {
  const buyer = row.type === 'FROM_EBAY' ? 'eBay' : row.other_party || 'a buyer';
  return {
    kind: 'conversation',
    id: String(row.conversation_id),
    key: `conversation:${row.connection_id}:${row.conversation_id}`,
    account: account(accounts, row.connection_id),
    title: `Conversation with ${buyer}`,
    image: (row.reference_id && images.get(String(row.reference_id))) || null,
    status: null,
    facts: [text(row.title), text(row.latest_preview ? `${row.latest_from_seller ? 'You: ' : ''}${row.latest_preview}` : null), row.latest_at ? { kind: 'date', at: row.latest_at } : null].filter(Boolean),
    url: `/accounts/${row.connection_id}/inbox?e=${row.connection_id}~${encodeURIComponent(row.conversation_id)}`,
    locked: false,
  };
}

const locked = (ref) => ({ kind: ref.kind, id: String(ref.id), key: `${ref.kind}:locked:${ref.id}`, locked: true });

/** Cards for references ([{ kind, id, connectionId? }]), in the same order; null where nothing matches. */
async function resolve(auth, refs, accounts = null) {
  const wanted = (refs || []).filter((r) => r && KINDS.includes(r.kind) && r.id);
  if (!wanted.length) return (refs || []).map(() => null);
  accounts = accounts || (await accountsFor(auth));
  const ids = (kind) => [...new Set(wanted.filter((r) => r.kind === kind).map((r) => String(r.id)))];
  const uuid = (id) => /^[0-9a-f-]{36}$/i.test(id);
  const [orders, listings, drafts, hunts, conversations] = await Promise.all([
    referencesRepository.ordersByIds(accounts.allowed.order, ids('order')),
    referencesRepository.listingsByItemIds(accounts.allowed.listing, ids('listing')),
    referencesRepository.draftsByIds(accounts.allowed.draft, ids('draft').filter(uuid)),
    referencesRepository.huntsByIds(accounts.allowed.hunt, ids('hunt').filter(uuid)),
    referencesRepository.conversationsByIds(accounts.allowed.conversation, ids('conversation')),
  ]);
  const images = await referencesRepository.itemImages([
    ...new Set([...orders.flatMap((o) => (o.data.lineItems || []).map((l) => String(l.itemId || ''))), ...conversations.map((c) => String(c.reference_id || ''))].filter(Boolean)),
  ]);
  // A listing's own photo stands in for an order's when Liston hasn't read the item's picture.
  const orderItems = [...new Set(orders.map((o) => String(o.data.lineItems?.[0]?.itemId || '')).filter((id) => id && !images.has(id)))];
  if (orderItems.length) {
    for (const l of await referencesRepository.listingsByItemIds(accounts.allowed.order, orderItems)) {
      if (l.item.imageUrl) images.set(String(l.item.itemId), String(l.item.imageUrl).replace(/s-l\d+\./, 's-l500.'));
    }
  }
  const pick = (rows, ref, idOf, connOf) => rows.find((r) => String(idOf(r)).toLowerCase() === String(ref.id).toLowerCase() && (!ref.connectionId || connOf(r) === ref.connectionId));
  const out = [];
  for (const ref of refs || []) {
    if (!ref || !KINDS.includes(ref.kind) || !ref.id) {
      out.push(null);
      continue;
    }
    let card = null;
    if (ref.kind === 'order') {
      const row = pick(orders, ref, (r) => r.data.orderId, (r) => r.connectionId);
      card = row ? orderCard(accounts, row, images) : null;
    } else if (ref.kind === 'listing') {
      const row = pick(listings, ref, (r) => r.item.itemId, (r) => r.connectionId);
      card = row ? listingCard(accounts, row) : null;
    } else if (ref.kind === 'draft') {
      const row = pick(drafts, ref, (r) => r.id, (r) => r.connectionId);
      card = row ? draftCard(accounts, row) : null;
    } else if (ref.kind === 'conversation') {
      const row = pick(conversations, ref, (r) => r.conversation_id, (r) => r.connection_id);
      card = row ? conversationCard(accounts, row, images) : null;
    } else {
      const row = pick(hunts, ref, (r) => r.id, (r) => r.connection_id);
      card = row ? huntCard(accounts, row) : null;
    }
    if (!card) {
      // In one of the owner's accounts the viewer can't open: say it's there, show nothing of it.
      const hidden = accounts.all.map((c) => c.id).filter((id) => !accounts.allowed[ref.kind].includes(id));
      if (hidden.length && (await referencesRepository.existsIn(hidden, ref.kind, ref.id))) card = locked(ref);
    }
    out.push(card);
  }
  return out;
}

/** The cards for whatever a piece of text points at (pasted in a message). */
async function fromText(auth, text) {
  const refs = detect(text);
  if (!refs.length) return [];
  return (await resolve(auth, refs)).filter(Boolean);
}

/**
 * The "/" picker: orders, live listings, drafts, hunted products and buyer
 * conversations whose words, number, buyer or SKU match, across the
 * accounts the viewer can open: [card].
 */
async function search(auth, q, { kinds = KINDS, limit = 5 } = {}) {
  const words = String(q || '').trim();
  if (words.length < 2) return [];
  const accounts = await accountsFor(auth);
  const want = (k) => kinds.includes(k);
  const [orders, listings, drafts, hunts, conversations] = await Promise.all([
    want('order') ? referencesRepository.searchOrders(accounts.allowed.order, words, limit) : [],
    want('listing') ? referencesRepository.searchListings(accounts.allowed.listing, words, limit) : [],
    want('draft') ? referencesRepository.searchDrafts(accounts.allowed.draft, words, limit) : [],
    want('hunt') ? referencesRepository.searchHunts(accounts.allowed.hunt, words, limit) : [],
    want('conversation') ? referencesRepository.searchConversations(accounts.allowed.conversation, words, limit) : [],
  ]);
  const images = await referencesRepository.itemImages([
    ...new Set([...orders.map((o) => String(o.data.lineItems?.[0]?.itemId || '')), ...conversations.map((c) => String(c.reference_id || ''))].filter(Boolean)),
  ]);
  return [
    ...orders.map((r) => orderCard(accounts, r, images)),
    ...listings.map((r) => listingCard(accounts, r)),
    ...drafts.map((r) => draftCard(accounts, r)),
    ...hunts.map((r) => huntCard(accounts, r)),
    ...conversations.map((r) => conversationCard(accounts, r, images)),
  ];
}

module.exports = { resolve, fromText, search, accountsFor, KINDS, FEATURES };
