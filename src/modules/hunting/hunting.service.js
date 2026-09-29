const crypto = require('crypto');
const huntingRepository = require('./hunting.repository');
const huntProfit = require('./hunt-profit');
const huntDuplicates = require('./hunt-duplicates');
const huntSales = require('./hunt-sales');
const salesHistory = require('../ebay/sales-history');
const logger = require('../../utils/logger');
const { REJECT_REASONS, reasonLabel, stageOf, permissionsFor, decisionFields, HuntError, rules, autoRejected, draftStateOf, DRAFT_STUCK_MS } = require('./hunt-rules');
const stats = require('./hunting-stats');
const { noticeFor } = require('./hunt-notice');
const analyticsDays = require('../analytics/analytics-days');
const notificationsService = require('../notifications/notifications.service');
const connectionService = require('../connections/connection.service');
const teamRepository = require('../team/team.repository');
const activityRepository = require('../team/activity.repository');
const listingRepository = require('../listings/listing.repository');
const ebaySource = require('../sourcing/ebay-listing.source');
const aliexpressSource = require('../sourcing/aliexpress');
const browseUsage = require('../ebay/browse-usage');
const mirror = require('../ebay/ebay-mirror.repository');
const ebayService = require('../ebay/ebay.service');
const marketplaces = require('../ebay/marketplaces');
const config = require('../../config');

// Product hunting: a team member checks a product (a competitor's eBay
// listing and the AliExpress product to supply it), adds it, and it waits
// for a reviewer. Approved products are drafted from the hunt; the draft,
// the eBay listing it becomes and its sales stay tied to the hunter.
//
// A check reads the competitor through eBay's Browse API (one or two
// calls, within hunting's share of the daily allowance), the supplier
// through the AliExpress API (product, then postage for one option), and
// no AI. It's held for half an hour so Add doesn't read it all again.

const CHECK_TTL_MS = 30 * 60 * 1000;
const FEE_DAYS = 90;
const ORDERS_KEPT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 50;
const checks = new Map();

function pruneChecks() {
  const now = Date.now();
  for (const [id, kept] of checks) if (kept.expiresAt <= now) checks.delete(id);
}

const isCancelled = (order) => ebayService.classifyOrderStatus(order) === 'cancelled';
const personOf = (id, name, email) => (id ? { id, name: name || (email ? String(email).split('@')[0] : 'Someone') } : null);

// ---- who's asking --------------------------------------------------------------------

/**
 * What this person may do with hunting on this account: the owner
 * everything; a member what their access says ("Review hunted products"
 * includes hunting; drafting needs Listings).
 */
async function viewerFor({ userId, ownerId, role }, connectionId) {
  if (role === 'owner') return { userId, ownerId, isOwner: true, canHunt: true, canReview: true, canDraft: true };
  const [hunting, review, listings] = await Promise.all(['hunting', 'hunting_review', 'listings'].map((f) => teamRepository.resolvePermission(userId, connectionId, f)));
  return { userId, ownerId, isOwner: false, canHunt: Boolean(hunting || review), canReview: Boolean(review), canDraft: Boolean(listings) };
}

// Someone with Listings access but no part in hunting sees the approved
// products (to draft them) and what became of them, nothing earlier.
const LISTER_VIEWS = ['approved', 'drafted', 'listed'];
const listerOnly = (viewer) => !viewer.canHunt && !viewer.canReview && viewer.canDraft;

async function loadHunt(auth, huntId) {
  const hunt = await huntingRepository.findForOwner(huntId, auth.ownerId);
  if (!hunt) throw new HuntError('That hunted product was not found.', 404);
  const viewer = await viewerFor(auth, hunt.connection_id);
  if (!viewer.canHunt && !viewer.canReview && !viewer.canDraft) throw new HuntError("You don't have access to hunting on this account.", 403);
  if (listerOnly(viewer) && !['approved', 'drafted', 'listed'].includes(stageOf(hunt))) throw new HuntError('That hunted product was not found.', 404);
  return { hunt, viewer };
}

function refuse(message) {
  throw new HuntError(message, 403);
}

// ---- reading a product --------------------------------------------------------------------

async function ensureAllowance() {
  const usage = browseUsage.snapshot();
  const used = usage.byKind.hunting || 0;
  if (used >= config.hunting.dailyCalls) {
    throw new HuntError(`Product hunting has used today's ${config.hunting.dailyCalls} eBay reads. It starts again at ${String(usage.resetAt || '').slice(11, 16)} UTC.`, 429);
  }
}

/** Every warning about where this product already is on the owner's accounts. */
async function duplicatesFor(ownerId, { productId, itemId, title, titles, connectionId, excludeId = null }) {
  const [hunts, listings, live, allLive] = await Promise.all([
    huntingRepository.huntsMatching(ownerId, { productId, itemId, excludeId }),
    huntingRepository.listingsMatching(ownerId, { productId, itemId }),
    mirror.ownerLiveListings(ownerId, { productId, itemId }),
    mirror.ownerLiveListings(ownerId),
  ]);
  return huntDuplicates.describe({ hunts, listings, live, allLive }, { productId, itemId, title, titles: titles || [title], connectionId });
}

/**
 * Reads both listings and works out the profit check for this account:
 * { competitorUrl, sourceUrl, itemId, productId, result } (result is
 * hunt-profit's, with the duplicates found).
 */
// `known`: the competitor already read ({ competitor, ebaySales }), so checking several suppliers against one listing reads it once.
async function readProduct(ownerId, connectionId, { competitorUrl, sourceUrl }, { excludeId = null, known = null } = {}) {
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  if (connection.platform_key !== 'ebay') throw new HuntError('Product hunting needs an eBay account.');
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(connection.settings?.ebay?.marketplaceId) || marketplaces.byId(marketplaces.DEFAULT_ID);
  // The competitor is optional, as in drafting: without one nothing is read
  // from eBay and each option is priced at the account's target return.
  const itemId = competitorUrl ? ebaySource.legacyItemIdFromUrl(competitorUrl) : null;
  // No supplier yet (hunted from Discover): the eBay listing alone, its demand, price and risks.
  const productId = sourceUrl ? aliexpressSource.productIdFromUrl(sourceUrl) : null;
  if (competitorUrl && !known) await ensureAllowance();

  // AliExpress is the slower read: started first, awaited after eBay's.
  const sourcePromise = sourceUrl ? aliexpressSource.fetchProduct(sourceUrl, { shipTo: site.country, currency: site.currency }) : Promise.resolve(null);
  sourcePromise.catch(() => {});
  const competitor = known ? known.competitor : competitorUrl ? await browseUsage.as('hunting', () => ebaySource.fetchListing(competitorUrl, site.id)) : null;
  const source = await sourcePromise;

  const pricing = { ...(connection.settings?.pricing || {}), currency: site.currency };
  const anchor = huntProfit.shippingAnchor(source, competitor, site.currency);
  const [shipping, totals, refusals] = await Promise.all([
    anchor?.skuId ? aliexpressSource.fetchShipping(sourceUrl, anchor.skuId, { shipTo: site.country, currency: site.currency }) : null,
    mirror.financeTotals(connectionId, new Date(Date.now() - FEE_DAYS * DAY_MS)).catch(() => null),
    listingRepository.findPolicyRefusals(ownerId).catch(() => []),
  ]);
  // A postage quote in another currency can't be added to a price.
  const postage = shipping && (!shipping.currency || shipping.currency === site.currency) ? shipping : null;
  const result = huntProfit.analyse({ competitor, source, pricing, fees: huntProfit.feeRates(pricing, totals, FEE_DAYS), shipping: postage, site, refusals });
  if (result.source) result.source.productId = productId;
  if (result.competitor) result.competitor.itemId = result.competitor.itemId || itemId;
  if (postage) result.shipping.forOption = anchor.label;
  // eBay's dated sales for the listing, once eBay grants Liston its sales
  // history (Marketplace Insights): sold in the last 90 days and when last.
  result.sales.ebay = known ? known.ebaySales : competitor ? await ebaySoldHistory(competitor, itemId, site.id) : null;
  result.salesScore = huntSales.salesScore({ demand: result.demand, variations: result.sales.variations });
  result.market = { id: site.id, name: site.name, country: site.country };
  result.duplicates = await duplicatesFor(ownerId, { productId, itemId, title: competitor?.title || source?.title, titles: [competitor?.title, source?.title], connectionId, excludeId });
  // `competitor` and `ebaySales`: the listing as read, so checking its other suppliers reads it once (`known`).
  return { competitorUrl: competitorUrl || null, sourceUrl: sourceUrl || null, itemId, productId, result, reading: huntProfit.salesReading(competitor, site.currency), competitor, ebaySales: result.sales.ebay };
}

// The listing in eBay's sales history for its title, or { available: false }
// while eBay hasn't granted the API (asked again hourly, see sales-history).
async function ebaySoldHistory(competitor, itemId, marketplaceId) {
  try {
    const found = await salesHistory.soldListings({ q: String(competitor.title || '').slice(0, 100), marketplaceId });
    if (!found.available) return { available: false };
    const item = (found.items || []).find((i) => String(i.legacyItemId) === String(itemId));
    return { available: true, days: 90, sold: item?.sold ?? 0, lastSoldAt: item?.lastSoldAt || null, lastPrice: item?.price ?? null, found: Boolean(item) };
  } catch (err) {
    logger.warn('Hunting: eBay sales history not read', { error: err.message });
    return { available: false };
  }
}

/** A product's readings as history, and its sales score with them. */
async function salesWithHistory(huntId, result) {
  const readings = await huntingRepository.readings(huntId);
  const spm = result?.demand?.soldPerMonth;
  const h = huntSales.history(readings, { lifetimePerDay: spm === null || spm === undefined ? null : spm / 30 });
  return { history: h, score: huntSales.salesScore({ demand: result?.demand, variations: result?.sales?.variations || [], history: h }) };
}

/** Keeps a reading of the competitor's sales and the score it gives. */
async function recordReading(huntId, read) {
  if (!read.reading) return;
  await huntingRepository.addReading(huntId, read.reading);
  const { score } = await salesWithHistory(huntId, read.result);
  await huntingRepository.setSalesScore(huntId, score ? score.score : null);
}

function checkColumns(read) {
  const { result } = read;
  return {
    competitorUrl: read.competitorUrl,
    competitorItemId: read.itemId,
    sourceUrl: read.sourceUrl,
    sourceProductId: read.productId,
    title: result.competitor?.title || result.source?.title || 'Untitled product',
    imageUrl: result.source?.imageUrl || result.competitor?.imageUrl || null,
    currency: result.currency,
    checkResult: result,
    headlineProfit: result.summary.headline.profit,
    headlineRoi: result.summary.headline.roi,
    soldPerMonth: result.demand.soldPerMonth,
    salesScore: result.salesScore ? result.salesScore.score : null,
  };
}

// ---- shaping for the page --------------------------------------------------------------------

function bandOf(score) {
  const [, band, label] = huntSales.BANDS.find(([min]) => score >= min);
  return { band, label };
}

function levelCount(result) {
  return (result?.checks || []).filter((c) => c.level === 'warn' || c.level === 'bad').length;
}

function summaryOf(row, viewer, sales = []) {
  const result = row.check_result || {};
  const head = result.summary?.headline || {};
  const bestSeller = result.summary?.bestSeller || null;
  const stage = row.stage || stageOf(row);
  return {
    id: row.id,
    connectionId: row.connection_id,
    title: row.title,
    imageUrl: row.image_url,
    stage,
    status: row.status,
    currency: row.currency,
    headline: { profit: head.profit ?? null, roi: head.roi ?? null, basis: head.basis ?? null, label: head.optionIndex !== null && head.optionIndex !== undefined ? result.options?.[head.optionIndex]?.label || null : null },
    bestSeller: bestSeller ? { label: bestSeller.label, sold: bestSeller.sold } : null,
    verdict: result.summary?.verdict || 'unknown',
    targetRoiPercent: result.targetRoiPercent ?? null,
    soldPerMonth: row.sold_per_month === null ? null : Number(row.sold_per_month),
    salesScore: row.sales_score === null || row.sales_score === undefined ? null : { score: row.sales_score, ...bandOf(row.sales_score) },
    competitorSold: result.demand?.sold ?? null,
    // The supplier's record, for the list at a glance.
    supplier: result.source?.supplier ? { rating: result.source.supplier.rating ?? null, reviews: result.source.supplier.reviews ?? null, orders: result.source.supplier.orders ?? null } : null,
    options: result.summary?.total ?? null,
    hunter: personOf(row.hunter_user_id, row.hunter_name, row.hunter_email),
    reviewer: personOf(row.reviewer_user_id, row.reviewer_name, row.reviewer_email),
    // Added as its eBay listing alone (or, earlier, with Liston's old supplier search): never approved as added.
    foundByListon: Boolean(row.found_by_liston),
    // Which tool it was hunted from as its listing alone: 'discover', 'research', or null (added with a supplier).
    addedFrom: row.added_from || null,
    autoApproved: Boolean(!row.found_by_liston && row.reviewer_user_id && row.reviewer_user_id === row.hunter_user_id),
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    checkedAt: row.checked_at,
    resubmits: row.resubmits,
    rejectReason: row.reject_reason,
    rejectReasonLabel: reasonLabel(row.reject_reason),
    // Rejected by Liston itself (the supplier doesn't match the eBay listing), not by a reviewer.
    autoRejected: autoRejected(row),
    // The automatic draft: 'drafting', 'failed' (with why) or null.
    draftState: draftStateOf(row),
    draftError: draftStateOf(row) === 'failed' ? row.draft_error || 'Drafting stopped before it finished.' : null,
    decisionNote: row.decision_note,
    hunterNote: row.hunter_note,
    warnings: levelCount(result),
    duplicates: (result.duplicates || []).filter((d) => d.type !== 'similar').length,
    similar: (result.duplicates || []).filter((d) => d.type === 'similar').length,
    competitorUrl: row.competitor_url,
    sourceUrl: row.source_url,
    listingId: row.listing_id,
    itemIds: row.item_ids || [],
    draftedBy: personOf(row.drafted_by, row.drafted_by_name, row.drafted_by_email),
    draftedAt: row.drafted_at,
    listedAt: row.listed_at,
    sales: sales[0] || null,
    permissions: permissionsFor(row, viewer),
  };
}

// The product's story, oldest first: from the activity record, plus the
// draft and the listing it became.
const HISTORY_KINDS = {
  'hunt.added': 'hunted',
  'hunt.approved': 'approved',
  'hunt.rejected': 'rejected',
  'hunt.sent_back': 'sent_back',
  'hunt.resubmitted': 'resubmitted',
  'hunt.updated': 'updated',
};
function timelineOf(row, events) {
  const out = events
    .filter((e) => HISTORY_KINDS[e.kind])
    .map((e) => ({
      kind: HISTORY_KINDS[e.kind],
      at: e.created_at,
      by: personOf(e.actor_user_id, e.actor_name, e.actor_email),
      reason: reasonLabel(e.detail?.reason),
      note: e.detail?.note || null,
      auto: Boolean(e.detail?.autoApproved),
      // Added from Liston's old supplier search (kept for products added that way).
      byListon: Boolean(e.detail?.foundByListon),
      // Hunted as the eBay listing alone, from Discover or Product research: 'discover' | 'research' | null.
      // (A resubmission's detail has its own `from`, the stage it left: not a tool.)
      from: e.kind === 'hunt.added' ? (['discover', 'research'].includes(e.detail?.from) ? e.detail.from : e.detail?.fromDiscover ? 'discover' : null) : null,
      // A change to its supplier links: 'added' (main: the first), 'main', 'removed'.
      supplier: e.detail?.supplier || null,
      main: Boolean(e.detail?.main),
    }));
  // Liston's own rejection isn't a member's action, so it isn't in the activity record.
  if (autoRejected(row) && row.decided_at) out.push({ kind: 'rejected', at: row.decided_at, by: null, system: true, reason: reasonLabel(row.reject_reason), note: row.decision_note || null, auto: false });
  if (row.drafted_at) out.push({ kind: 'drafted', at: row.drafted_at, by: personOf(row.drafted_by, row.drafted_by_name, row.drafted_by_email) });
  if (row.listed_at) out.push({ kind: 'listed', at: row.listed_at, by: null, itemId: (row.item_ids || [])[0] || null });
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

async function salesOf(rows) {
  const listed = rows.filter((r) => (r.item_ids || []).length);
  if (!listed.length) return new Map();
  const since = new Date(Date.now() - ORDERS_KEPT_DAYS * DAY_MS);
  const orders = await mirror.ordersForItems([...new Set(listed.map((r) => r.connection_id))], listed.flatMap((r) => r.item_ids), since, new Date(Date.now() + DAY_MS));
  const byItem = stats.salesByItem(orders, { isCancelled });
  return new Map(listed.map((r) => [r.id, stats.salesFor(r.item_ids, byItem)]));
}

function viewerSummary(viewer) {
  return { userId: viewer.userId, isOwner: viewer.isOwner, canHunt: viewer.canHunt, canReview: viewer.canReview, canDraft: viewer.canDraft };
}

// ---- the page's calls --------------------------------------------------------------------

/** Checks a product without saving it: { checkId, result }. */
async function check(auth, connectionId, { competitorUrl, sourceUrl }) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt) refuse("You don't have access to hunting on this account.");
  pruneChecks();
  const read = await readProduct(auth.ownerId, connectionId, { competitorUrl, sourceUrl });
  const checkId = crypto.randomUUID();
  checks.set(checkId, { read, userId: auth.userId, connectionId: String(connectionId), expiresAt: Date.now() + CHECK_TTL_MS });
  return { checkId, result: read.result, autoApproves: viewer.isOwner };
}

/**
 * Hunt from Discover or Product research (`from`): the eBay listing added to
 * the account's hunting list on its own, read from eBay (its demand, price
 * and risks), waiting in 'sourcing' for someone to add a supplier link on its
 * page. A listing already on the account's list isn't added again: the
 * answer links to it ({ added: false, alreadyHunted }). It's never approved
 * as it's added (`found_by_liston`), and `added_from` says which tool it
 * came from. { added, hunt }.
 */
// Hunts running now, by account and eBay listing: a second click (a retried request, a teammate) waits
// for the first and gets the same answer, so a listing is never added twice.
const hunting = new Map();
function huntListing(auth, connectionId, { competitorUrl, from = 'discover' }) {
  const key = `${connectionId}:${ebaySource.legacyItemIdFromUrl(competitorUrl)}`;
  if (hunting.has(key)) return hunting.get(key);
  const run = huntListingNow(auth, connectionId, competitorUrl, from === 'research' ? 'research' : 'discover').finally(() => hunting.delete(key));
  hunting.set(key, run);
  return run;
}

async function huntListingNow(auth, connectionId, competitorUrl, from) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt) refuse("You don't have access to hunting on this account.");
  const itemId = ebaySource.legacyItemIdFromUrl(competitorUrl);
  const existing = await huntingRepository.huntOnAccount(connectionId, itemId);
  if (existing) {
    const hunt = summaryOf(existing, viewer);
    return { added: false, alreadyHunted: { id: hunt.id, stage: hunt.stage, title: hunt.title, hunter: hunt.hunter, createdAt: hunt.createdAt } };
  }
  const read = await readProduct(auth.ownerId, connectionId, { competitorUrl, sourceUrl: null });
  const columns = checkColumns(read);
  const id = await huntingRepository.insert({ ...columns, ownerId: auth.ownerId, connectionId, hunterId: auth.userId, status: 'sourcing', foundByListon: true, addedFrom: from });
  await recordReading(id, read).catch((err) => logger.warn('Hunting: sales reading not kept', { error: err.message }));
  await activityRepository.record({
    actorUserId: auth.userId,
    connectionId,
    kind: 'hunt.added',
    subjectType: 'hunt',
    subjectId: id,
    title: columns.title,
    detail: { from, fromDiscover: from === 'discover', needsSupplier: true },
  });
  // Discover marks it as the owner's at once. Required here: Discover's module reads this one's tables.
  require('../discover/discover.service').forgetOwner(auth.ownerId);
  return { added: true, hunt: await detail(auth, id) };
}

/** Adds a checked product to the account's hunting list. The owner's own are approved as they're added. */
async function add(auth, connectionId, { checkId, note }) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt) refuse("You don't have access to hunting on this account.");
  pruneChecks();
  const kept = checks.get(checkId);
  if (!kept || kept.userId !== auth.userId || kept.connectionId !== String(connectionId)) throw new HuntError('That check has expired. Check the product again.');
  const columns = checkColumns(kept.read);
  // A supplier that doesn't sell what the eBay listing sells is rejected by Liston, whoever adds it.
  const mismatch = kept.read.result?.mismatch || null;
  const approved = viewer.isOwner && !mismatch;
  const id = await huntingRepository.insert({
    ...columns,
    ownerId: auth.ownerId,
    connectionId,
    hunterId: auth.userId,
    status: approved ? 'approved' : 'pending',
    reviewerId: approved ? auth.userId : null,
    decidedAt: approved ? new Date() : null,
    note: typeof note === 'string' ? note.trim().slice(0, 1000) : null,
  });
  checks.delete(checkId);
  if (mismatch) await rejectMismatch(auth.ownerId, id, mismatch);
  await recordReading(id, kept.read).catch((err) => logger.warn('Hunting: sales reading not kept', { error: err.message }));
  await activityRepository.record({
    actorUserId: auth.userId,
    connectionId,
    kind: 'hunt.added',
    subjectType: 'hunt',
    subjectId: id,
    title: columns.title,
    detail: { profit: columns.headlineProfit, roi: columns.headlineRoi, autoApproved: approved, autoRejected: Boolean(mismatch) },
  });
  if (approved && config.hunting.autoDraft) startDraft(auth.ownerId, id, auth.userId);
  // Discover marks it as the owner's at once. Required here: Discover's module reads this one's tables.
  require('../discover/discover.service').forgetOwner(auth.ownerId);
  return detail(auth, id);
}

/**
 * Liston rejects a product whose supplier doesn't sell what its eBay
 * listing sells (hunt-profit.matchCheck), with the reason spelled out, and
 * tells the hunter. It stays under Rejected: a reviewer can still approve
 * it, and the hunter can remove it.
 */
async function rejectMismatch(ownerId, huntId, mismatch, { actorId = null } = {}) {
  await huntingRepository.setDecision(huntId, { status: 'rejected', reject_reason: 'mismatch', decision_note: mismatch.reason }, null);
  const hunt = await huntingRepository.findForOwner(huntId, ownerId);
  // Not the hunter who's just saved it: the page tells them.
  if (!hunt?.hunter_user_id || hunt.hunter_user_id === actorId) return;
  const notice = noticeFor('hunt.rejected', { title: hunt.title, reason: reasonLabel('mismatch'), note: mismatch.reason, system: true });
  await notificationsService.notify({ userId: hunt.hunter_user_id, actorUserId: null, kind: 'hunt.rejected', ...notice, url: `/accounts/${hunt.connection_id}/hunting?open=${hunt.id}`, subjectType: 'hunt', subjectId: hunt.id });
}

// ---- drafting approved products by themselves ------------------------------------------

// Drafting runs the AI and uploads photos (up to a minute each), so a few at a time.
const DRAFT_CONCURRENCY = 2;
const draftQueue = [];
let drafting = 0;

/**
 * Drafts an approved product in the background, the way the draft screen
 * would: both listings read again, the options matched to a variation of
 * the competitor's that has sold and that earn (hunt-profit's draftSelection:
 * unsold variations are dropped), else every option, every supplier photo. The product
 * follows its draft to the Drafts page; a failure keeps it on the Hunting
 * page with the reason and a button to try again. Never throws.
 */
function startDraft(ownerId, huntId, actorId) {
  draftQueue.push({ ownerId, huntId, actorId });
  pumpDrafts();
}

/** Resolves once no automatic draft is queued or running (for tests and shutdown). */
async function draftsSettled() {
  while (drafting || draftQueue.length) await new Promise((resolve) => setTimeout(resolve, 20));
}

function pumpDrafts() {
  while (drafting < DRAFT_CONCURRENCY && draftQueue.length) {
    const job = draftQueue.shift();
    drafting += 1;
    draftNow(job)
      .catch((err) => logger.warn('Hunting: automatic draft failed', { huntId: job.huntId, error: err.message }))
      .finally(() => {
        drafting -= 1;
        pumpDrafts();
      });
  }
}

async function draftNow({ ownerId, huntId, actorId }) {
  if (!(await huntingRepository.claimDraft(huntId, new Date(Date.now() - DRAFT_STUCK_MS)))) return null;
  const hunt = await huntingRepository.findForOwner(huntId, ownerId);
  if (!hunt) return null;
  try {
    // Required here, not at the top: listing.service marks hunts drafted and listed through this module's repository.
    const listingService = require('../listings/listing.service');
    const preview = await listingService.previewDraftSources(hunt.connection_id, ownerId, { competitorUrl: hunt.competitor_url || undefined, sourceUrl: hunt.source_url });
    const suggested = huntProfit.draftSelection(hunt.check_result?.options || [], preview.source?.axes || []);
    const variantSelection = {};
    for (const axis of preview.source?.axes || []) {
      const values = axis.values.map((v) => v.value);
      const keep = (suggested?.[axis.name] || []).filter((v) => values.includes(v));
      variantSelection[axis.name] = keep.length ? keep : values;
    }
    const listing = await listingService.generateEbayDraftFromUrls(hunt.connection_id, ownerId, {
      previewId: preview.previewId,
      variantSelection,
      imageUrls: preview.source?.imageUrls?.length ? preview.source.imageUrls : undefined,
      huntId,
      actorUserId: actorId,
    });
    // Counted as a draft made, like one drafted on the draft screen, for whoever approved it.
    const { listingFacts } = require('../listings/listing.controller');
    await activityRepository
      .record({ actorUserId: actorId, connectionId: hunt.connection_id, kind: 'listing.drafted', subjectType: 'draft', subjectId: listing.id, ...listingFacts(listing.generated_data), detail: { huntId, automatic: true } })
      .catch(() => {});
    return listing;
  } catch (err) {
    await huntingRepository.draftFailed(huntId, err.statusCode && err.statusCode < 500 ? err.message : `Drafting stopped: ${err.message}`);
    throw err;
  }
}

/** Drafts an approved product by hand: when its automatic draft failed, or never ran. Answers at once. */
async function draftAgain(auth, huntId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canDraft(hunt, viewer)) refuse(stageOf(hunt) === 'approved' ? 'It is being drafted already.' : 'Only an approved product can be drafted.');
  startDraft(auth.ownerId, hunt.id, auth.userId);
  return detail(auth, huntId);
}

/** An account's hunted products for one view, with each view's count. */
async function list(auth, connectionId, { view, mine, hunter, q, sort, page, minProfit = null, minDemand = null, addedDays = null, unique = false } = {}) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt && !viewer.canReview && !viewer.canDraft) refuse("You don't have access to hunting on this account.");
  // My hunts (their own finds) for anyone who hunts; someone who only drafts sees what's approved.
  const allowed = listerOnly(viewer) ? LISTER_VIEWS : huntingRepository.VIEWS.filter((v) => v !== 'mine' || viewer.canHunt);
  const chosen = allowed.includes(view) ? view : allowed.includes('all') ? 'all' : 'approved';
  const hunterId = mine || chosen === 'mine' ? auth.userId : /^[0-9a-f-]{36}$/i.test(String(hunter || '')) ? hunter : null;
  const offset = Math.max(0, (Number(page) || 1) - 1) * PAGE;
  const filters = { minProfit, minDemand, addedDays, unique };
  const [{ rows, more }, counts, hunters] = await Promise.all([
    huntingRepository.list(connectionId, { view: chosen, hunterId, ...filters, q: String(q || '').trim().slice(0, 100), sort: huntingRepository.SORTS.includes(sort) ? sort : chosen === 'review' ? 'waiting' : 'newest', limit: PAGE, offset }),
    huntingRepository.counts(connectionId, { hunterId: chosen === 'mine' ? null : hunterId, ...filters, viewerId: auth.userId }),
    huntingRepository.huntersOn(connectionId),
  ]);
  const sales = await salesOf(rows).catch(() => new Map());
  return {
    view: chosen,
    views: allowed,
    items: rows.map((r) => summaryOf(r, viewer, sales.get(r.id))),
    counts: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, allowed.includes(k) ? n : 0])),
    more,
    viewer: viewerSummary(viewer),
    hunters: hunters.map((h) => personOf(h.id, h.name, h.email)),
    reasons: REJECT_REASONS,
  };
}

/** One product in full: its check, history, where else it is, its sales and what this person may do. */
async function detail(auth, huntId) {
  const loaded = await loadHunt(auth, huntId);
  const { viewer } = loaded;
  let { hunt } = loaded;
  // Keep its sales history current for whoever's looking.
  await readIfStale(hunt);
  if (hunt.competitor_url) hunt = (await huntingRepository.findForOwner(huntId, auth.ownerId)) || hunt;
  const checkResult = hunt.check_result || {};
  const variations = checkResult.sales?.variations?.length ? checkResult.sales.variations : variationsFromReading(checkResult, await huntingRepository.readings(hunt.id));
  const [events, duplicates, sales, withHistory] = await Promise.all([
    huntingRepository.history(auth.ownerId, hunt.id),
    duplicatesFor(auth.ownerId, { productId: hunt.source_product_id, itemId: hunt.competitor_item_id, title: hunt.title, titles: [hunt.check_result?.competitor?.title, hunt.check_result?.source?.title, hunt.title], connectionId: hunt.connection_id, excludeId: hunt.id }).catch(() => hunt.check_result?.duplicates || []),
    salesOf([hunt]).catch(() => new Map()),
    salesWithHistory(hunt.id, { ...checkResult, sales: { variations } }).catch(() => ({ history: null, score: checkResult.salesScore || null })),
  ]);
  const others = await huntingRepository.sourcesOf(hunt.id);
  return {
    ...summaryOf(hunt, viewer, sales.get(hunt.id)),
    connectionLabel: hunt.connection_label,
    // Every supplier link: the main one (its check is the product's, and the draft's), then the others.
    sources: [
      ...(hunt.source_url ? [sourceOf({ main: true, url: hunt.source_url, productId: hunt.source_product_id, checkResult: hunt.check_result, checkedAt: hunt.checked_at })] : []),
      ...others.map((o) => sourceOf({ id: o.id, main: false, url: o.source_url, productId: o.source_product_id, checkResult: o.check_result, checkedAt: o.checked_at, addedBy: personOf(o.added_by, o.added_by_name, o.added_by_email) })),
    ],
    result: { ...checkResult, duplicates, salesScore: withHistory.score, sales: { ...(checkResult.sales || {}), exact: undefined, variations, history: withHistory.history } },
    timeline: timelineOf(hunt, events),
    viewer: viewerSummary(viewer),
    reasons: REJECT_REASONS,
  };
}

/** Reads the product again and updates its figures (its review stays as it is). */
async function recheck(auth, huntId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canRecheck(hunt, viewer)) refuse('This product is already listed.');
  const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: hunt.competitor_url, sourceUrl: hunt.source_url }, { excludeId: hunt.id });
  await huntingRepository.setCheck(hunt.id, checkColumns(read));
  await recordReading(hunt.id, read);
  await recheckOthers(auth.ownerId, hunt, read);
  await rejudgeMatch(auth.ownerId, hunt, read.result?.mismatch || null);
  const previous = hunt.check_result?.summary?.headline || {};
  return { ...(await detail(auth, huntId)), previous: { profit: previous.profit ?? null, roi: previous.roi ?? null } };
}

/**
 * After a fresh read: a product that no longer matches its eBay listing is
 * rejected by Liston (before it's drafted); one Liston rejected that now
 * matches goes back in for review.
 */
async function rejudgeMatch(ownerId, hunt, mismatch) {
  const stage = stageOf(hunt);
  if (mismatch && ['pending', 'sent_back', 'approved'].includes(stage) && draftStateOf(hunt) !== 'drafting') return rejectMismatch(ownerId, hunt.id, mismatch);
  if (!mismatch && autoRejected(hunt)) return huntingRepository.resubmit(hunt.id);
  return null;
}

/**
 * The hunter changes a waiting (or sent back) product: other links, which
 * re-reads it, or their note. `competitorUrl: null` takes the competitor
 * away (undefined leaves it as it is). A rejected product (its hunter or a
 * reviewer fixing it) is always read again and goes back in for review,
 * unless the supplier still doesn't match its eBay listing, when Liston
 * rejects it again with the reason.
 */
async function update(auth, huntId, { competitorUrl, sourceUrl, note }) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canEdit(hunt, viewer)) refuse("Its hunter changes it while it waits; a reviewer changes it until it's drafted.");
  const wasRejected = stageOf(hunt) === 'rejected';
  const nextCompetitor = competitorUrl === undefined ? hunt.competitor_url : competitorUrl || null;
  const nextSource = sourceUrl || hunt.source_url;
  const links = nextCompetitor !== hunt.competitor_url || nextSource !== hunt.source_url;
  let mismatch = null;
  if (links || wasRejected) {
    const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: nextCompetitor, sourceUrl: nextSource }, { excludeId: hunt.id });
    await huntingRepository.setCheck(hunt.id, checkColumns(read));
    await recordReading(hunt.id, read);
    // A new eBay link: every other supplier's figures are against it now too.
    if (nextCompetitor !== hunt.competitor_url) await recheckOthers(auth.ownerId, { ...hunt, competitor_url: nextCompetitor }, read);
    mismatch = read.result?.mismatch || null;
    if (!wasRejected) await rejudgeMatch(auth.ownerId, hunt, mismatch);
  }
  if (typeof note === 'string') await huntingRepository.setNote(hunt.id, note.trim().slice(0, 1000));
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.updated', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { links: Boolean(links) } });
  if (wasRejected) {
    if (mismatch) {
      await rejectMismatch(auth.ownerId, hunt.id, mismatch, { actorId: auth.userId });
    } else {
      await huntingRepository.resubmit(hunt.id);
      await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.resubmitted', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { from: 'rejected' } });
    }
  }
  return detail(auth, huntId);
}

/**
 * The hunter sends their product in for review again: one sent back, or one
 * rejected. One Liston rejected is read again first, so it can't skip the
 * match: while the supplier still lacks what sells, it stays rejected.
 */
// ---- supplier links ----------------------------------------------------------------------

/** A supplier link as the product page shows it, from its check. */
function sourceOf({ id = null, main, url, productId, checkResult, checkedAt, addedBy = null }) {
  const r = checkResult || {};
  const head = r.summary?.headline || {};
  const supplier = r.source?.supplier || {};
  return {
    id,
    main,
    url,
    productId,
    title: r.source?.title || null,
    imageUrl: r.source?.imageUrl || null,
    rating: supplier.rating ?? null,
    orders: supplier.orders ?? null,
    onSale: supplier.onSale !== false,
    profit: head.profit ?? null,
    roi: head.roi ?? null,
    basis: head.basis ?? null,
    verdict: r.summary?.verdict || 'unknown',
    options: r.summary?.total ?? null,
    inStock: r.summary?.inStock ?? null,
    postage: r.shipping ? { basis: r.shipping.basis, cost: r.shipping.cost ?? null, freeOver: r.shipping.freeOver ?? null, maxDays: r.shipping.maxDays ?? null } : null,
    // It doesn't sell what the eBay listing sells (as the main supplier, Liston would reject the product).
    mismatch: r.mismatch?.reason || null,
    checkedAt,
    addedBy,
  };
}

/** A supplier's check, as hunt_sources keeps it. */
function sourceColumns(read) {
  const { result } = read;
  return {
    sourceUrl: read.sourceUrl,
    sourceProductId: read.productId,
    title: result.source?.title || null,
    imageUrl: result.source?.imageUrl || null,
    checkResult: result,
    headlineProfit: result.summary.headline.profit,
    headlineRoi: result.summary.headline.roi,
  };
}

/** Every other supplier checked again against the product's eBay listing, read once (`read`: the main one's). */
async function recheckOthers(ownerId, hunt, read) {
  const others = await huntingRepository.sourcesOf(hunt.id);
  const known = read.competitor ? { competitor: read.competitor, ebaySales: read.ebaySales } : null;
  for (const other of others) {
    try {
      const again = await readProduct(ownerId, hunt.connection_id, { competitorUrl: hunt.competitor_url, sourceUrl: other.source_url }, { excludeId: hunt.id, known });
      await huntingRepository.saveSource(hunt.id, sourceColumns(again), other.added_by);
    } catch (err) {
      logger.warn('Hunting: a supplier not checked again', { huntId: hunt.id, sourceId: other.id, error: err.message });
    }
  }
}

const recordEdit = (auth, hunt, detail) =>
  activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.updated', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail });

/**
 * Adds a supplier link to a product, checked against its eBay listing. The
 * first one becomes its main supplier: a product hunted from Discover goes
 * in for review with it (rejected by Liston instead when it doesn't sell
 * what the listing sells). Any after that are kept beside it, with their
 * own figures, to compare and to switch to.
 */
async function addSource(auth, huntId, { sourceUrl }) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canEdit(hunt, viewer)) refuse("Its hunter adds suppliers while it waits; a reviewer adds them until it's drafted.");
  const productId = aliexpressSource.productIdFromUrl(sourceUrl);
  if (hunt.source_product_id === productId) throw new HuntError("That's already its main supplier.");
  const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: hunt.competitor_url, sourceUrl }, { excludeId: hunt.id });
  if (!hunt.source_url) {
    await huntingRepository.setCheck(hunt.id, checkColumns(read));
    await recordReading(hunt.id, read);
    await recordEdit(auth, hunt, { supplier: 'added', main: true });
    const mismatch = read.result?.mismatch || null;
    if (mismatch) await rejectMismatch(auth.ownerId, hunt.id, mismatch, { actorId: auth.userId });
    else if (stageOf(hunt) === 'sourcing') await huntingRepository.setStatus(hunt.id, 'pending');
  } else {
    await huntingRepository.saveSource(hunt.id, sourceColumns(read), auth.userId);
    await recordEdit(auth, hunt, { supplier: 'added', main: false });
  }
  return detail(auth, huntId);
}

/**
 * Makes another supplier link the main one: checked again now (its figures
 * become the product's, and the draft's), the old main one kept beside it.
 * One that doesn't sell what the listing sells gets the product rejected by
 * Liston, as any main supplier would.
 */
async function makeMainSource(auth, huntId, sourceId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canEdit(hunt, viewer)) refuse("Its hunter changes its suppliers while it waits; a reviewer changes them until it's drafted.");
  const other = await huntingRepository.findSource(hunt.id, sourceId);
  if (!other) throw new HuntError('That supplier link is no longer on this product.', 404);
  const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: hunt.competitor_url, sourceUrl: other.source_url }, { excludeId: hunt.id });
  if (hunt.source_url) {
    const old = hunt.check_result || {};
    await huntingRepository.saveSource(
      hunt.id,
      { sourceUrl: hunt.source_url, sourceProductId: hunt.source_product_id, title: old.source?.title || null, imageUrl: old.source?.imageUrl || null, checkResult: old, headlineProfit: hunt.headline_profit, headlineRoi: hunt.headline_roi },
      hunt.hunter_user_id
    );
  }
  await huntingRepository.deleteSource(hunt.id, other.id);
  await huntingRepository.setCheck(hunt.id, checkColumns(read));
  await recordReading(hunt.id, read);
  await recordEdit(auth, hunt, { supplier: 'main' });
  const mismatch = read.result?.mismatch || null;
  if (stageOf(hunt) === 'sourcing') {
    if (mismatch) await rejectMismatch(auth.ownerId, hunt.id, mismatch, { actorId: auth.userId });
    else await huntingRepository.setStatus(hunt.id, 'pending');
  } else {
    await rejudgeMatch(auth.ownerId, hunt, mismatch);
  }
  return detail(auth, huntId);
}

/** Takes a supplier link off a product (never its main one: make another main first). */
async function removeSource(auth, huntId, sourceId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canEdit(hunt, viewer)) refuse("Its hunter changes its suppliers while it waits; a reviewer changes them until it's drafted.");
  const other = await huntingRepository.findSource(hunt.id, sourceId);
  if (!other) throw new HuntError('That supplier link is no longer on this product.', 404);
  await huntingRepository.deleteSource(hunt.id, other.id);
  await recordEdit(auth, hunt, { supplier: 'removed' });
  return detail(auth, huntId);
}

async function resubmit(auth, huntId, { note } = {}) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canResubmit(hunt, viewer)) refuse('Only your own product that was sent back or rejected can be resubmitted.');
  if (typeof note === 'string') await huntingRepository.setNote(hunt.id, note.trim().slice(0, 1000));
  if (autoRejected(hunt)) {
    const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: hunt.competitor_url, sourceUrl: hunt.source_url }, { excludeId: hunt.id });
    await huntingRepository.setCheck(hunt.id, checkColumns(read));
    await recordReading(hunt.id, read);
    if (read.result?.mismatch) {
      await rejectMismatch(auth.ownerId, hunt.id, read.result.mismatch, { actorId: auth.userId });
      return detail(auth, huntId);
    }
  }
  await huntingRepository.resubmit(hunt.id);
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.resubmitted', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { from: stageOf(hunt) } });
  return detail(auth, huntId);
}

/** A reviewer approves it, rejects it (with a reason) or sends it back (with what to change). */
async function decide(auth, huntId, input) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canDecide(hunt, viewer)) {
    if (!viewer.canReview) refuse("You don't review hunted products on this account.");
    if (!['pending', 'sent_back', 'approved', 'rejected'].includes(stageOf(hunt))) refuse('It has been drafted already, so its review is settled.');
    refuse("You can't review a product you hunted. The owner or another reviewer decides on it.");
  }
  const fields = decisionFields(input);
  await huntingRepository.setDecision(hunt.id, fields, auth.userId);
  const kind = { approved: 'hunt.approved', rejected: 'hunt.rejected', sent_back: 'hunt.sent_back' }[fields.status];
  await activityRepository.record({
    actorUserId: auth.userId,
    connectionId: hunt.connection_id,
    kind,
    subjectType: 'hunt',
    subjectId: hunt.id,
    title: hunt.title,
    detail: { reason: fields.reject_reason, note: fields.decision_note, from: stageOf(hunt) },
  });
  await tellHunter(auth, hunt, kind, { reason: reasonLabel(fields.reject_reason), note: fields.decision_note, url: `/accounts/${hunt.connection_id}/hunting?open=${hunt.id}` });
  // Approved: drafted straight away, in the background.
  if (fields.status === 'approved' && config.hunting.autoDraft) startDraft(auth.ownerId, hunt.id, auth.userId);
  return detail(auth, huntId);
}

/** Tells the hunter what a reviewer did to their product (never themselves: the owner's own finds). */
async function tellHunter(auth, hunt, kind, { reason = null, note = null, url }) {
  if (!hunt.hunter_user_id || hunt.hunter_user_id === auth.userId) return;
  const notice = noticeFor(kind, { title: hunt.title, by: await huntingRepository.personName(auth.userId).catch(() => null), reason, note });
  if (!notice) return;
  await notificationsService.notify({ userId: hunt.hunter_user_id, actorUserId: auth.userId, kind, ...notice, url, subjectType: 'hunt', subjectId: hunt.id });
}

/** Only a reviewer (the owner included) removes a hunted product, whatever its stage; hunters edit theirs instead. */
async function remove(auth, huntId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canRemove(hunt, viewer)) refuse('Only a reviewer can remove a hunted product (or its hunter, once Liston rejected it). You can edit and improve yours instead.');
  await huntingRepository.deleteById(hunt.id);
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.removed', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { stage: stageOf(hunt) } });
  await tellHunter(auth, hunt, 'hunt.removed', { url: `/accounts/${hunt.connection_id}/hunting` });
}

/** The side menu's badge. */
async function badge(auth, connectionId) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt && !viewer.canReview && !viewer.canDraft) return { review: 0, sentBack: 0, approved: 0, sourcing: 0, access: false };
  const counts = await huntingRepository.badgeCounts(connectionId, auth.userId);
  // `sourcing`: their own hunted from Discover, waiting for a supplier link.
  return { review: viewer.canReview ? counts.review : 0, sentBack: counts.sent_back, approved: viewer.canDraft ? counts.approved : 0, sourcing: viewer.canHunt ? counts.sourcing : 0, access: true };
}

/**
 * Step one of drafting an approved product: both listings read again (the
 * draft screen's own preview), what the supplier's prices did since the
 * hunt, and which options to start with (the ones that earn).
 */
async function draftStart(auth, huntId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canDraft(hunt, viewer)) refuse(viewer.canDraft ? 'Only an approved product can be drafted.' : 'Drafting needs Listings access on this account.');
  // Required here, not at the top: listing.service marks hunts drafted and listed through this module's repository.
  const listingService = require('../listings/listing.service');
  const { readSource, ...preview } = await listingService.previewDraftSources(hunt.connection_id, auth.ownerId, { competitorUrl: hunt.competitor_url || undefined, sourceUrl: hunt.source_url }, { withSource: true });
  const rows = hunt.check_result?.options || [];
  return {
    preview,
    hunt: {
      id: hunt.id,
      title: hunt.title,
      currency: hunt.currency,
      competitorUrl: hunt.competitor_url,
      sourceUrl: hunt.source_url,
      hunter: personOf(hunt.hunter_user_id, hunt.hunter_name, hunt.hunter_email),
      headline: hunt.check_result?.summary?.headline || null,
      priceChanges: readSource ? huntProfit.priceChanges(rows, readSource, hunt.currency).slice(0, 8) : [],
      selection: huntProfit.draftSelection(rows, preview.source?.axes || []),
      selectionBasis: huntProfit.draftBasis(rows),
    },
  };
}

// ---- figures ---------------------------------------------------------------------------

/**
 * A member's hunting for their page, across the owner's accounts, for a
 * range window and the one before it (team/activity.rangeWindow).
 */
async function memberFigures(ownerId, memberId, win, { connectionId = null } = {}) {
  const span = (w) => ({ start: w.startsAt, end: w.endsAt, connectionId });
  const [hunted, prevHunted, decisions, prevDecisions, decided, prevDecided, listed] = await Promise.all([
    huntingRepository.huntedBetween(ownerId, { ...span(win), hunterId: memberId }),
    huntingRepository.huntedBetween(ownerId, { ...span(win.previous), hunterId: memberId }),
    huntingRepository.decisionsBetween(ownerId, { ...span(win), actorId: memberId }),
    huntingRepository.decisionsBetween(ownerId, { ...span(win.previous), actorId: memberId }),
    huntingRepository.decidedBetween(ownerId, { ...span(win), reviewerId: memberId }),
    huntingRepository.decidedBetween(ownerId, { ...span(win.previous), reviewerId: memberId }),
    huntingRepository.listedHunts(ownerId, { hunterId: memberId, connectionId }),
  ]);
  const accounts = [...new Set(listed.map((h) => h.connection_id))];
  const items = listed.flatMap((h) => h.item_ids);
  const [orders, prevOrders] = await Promise.all([
    mirror.ordersForItems(accounts, items, win.startsAt, win.endsAt),
    mirror.ordersForItems(accounts, items, win.previous.startsAt, win.previous.endsAt),
  ]);
  return {
    hunter: stats.hunterFigures(hunted),
    previousHunter: stats.hunterFigures(prevHunted),
    reviewer: stats.reviewerFigures(decisions, decided),
    previousReviewer: stats.reviewerFigures(prevDecisions, prevDecided),
    sales: stats.salesFor(items, stats.salesByItem(orders, { isCancelled })),
    previousSales: stats.salesFor(items, stats.salesByItem(prevOrders, { isCancelled })),
    reasons: stats.reasonCounts(hunted),
  };
}

/**
 * A hunter's products that sold, day by day in the owner's days: how many
 * different products from their finds had an order that day (cancelled
 * orders left out), and how many in the whole window.
 */
async function convertingByDay(ownerId, hunterId, { startsAt, endsAt, timeZone, connectionId = null }) {
  const listed = await huntingRepository.listedHunts(ownerId, { hunterId, connectionId });
  const huntOf = new Map();
  for (const h of listed) for (const id of h.item_ids || []) huntOf.set(String(id), h.id);
  if (!huntOf.size) return { byDay: new Map(), total: 0 };
  const orders = await mirror.ordersForItems([...new Set(listed.map((h) => h.connection_id))], [...huntOf.keys()], startsAt, endsAt);
  const byDay = new Map();
  const all = new Set();
  for (const order of orders) {
    if (isCancelled(order)) continue;
    const day = analyticsDays.dayOf(order.createdAt, timeZone);
    for (const line of order.lineItems || []) {
      const huntId = huntOf.get(String(line.itemId));
      if (!huntId || !day) continue;
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(huntId);
      all.add(huntId);
    }
  }
  return { byDay: new Map([...byDay].map(([day, set]) => [day, set.size])), total: all.size };
}

/**
 * The daily reading of hunted products' competitors (hunting.scheduler):
 * each due product's listing read once more through Browse, within
 * `HUNT_TRACK_DAILY_CALLS`, its sold counts kept and its score redone.
 * Returns how many were read.
 */
const trackAllowanceLeft = () => (browseUsage.snapshot().byKind['hunting-track'] || 0) < config.hunting.trackCalls;

/** Reads one product's competitor now: its sold counts kept, its score redone. */
async function readSalesNow(hunt) {
  const connection = await connectionService.getConnectionSummary(hunt.connection_id, hunt.owner_user_id);
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(connection.settings?.ebay?.marketplaceId) || marketplaces.byId(marketplaces.DEFAULT_ID);
  const competitor = await browseUsage.as('hunting-track', () => ebaySource.fetchListing(hunt.competitor_url, site.id));
  const reading = huntProfit.salesReading(competitor, site.currency);
  await huntingRepository.addReading(hunt.id, reading);
  const demand = { ...(hunt.demand || hunt.check_result?.demand || {}), sold: competitor.sold ?? null };
  const { score } = await salesWithHistory(hunt.id, { demand, sales: { variations: reading.variations } });
  await huntingRepository.setSalesScore(hunt.id, score ? score.score : null);
}

async function readDueSales({ limit = 20, ownerId = null } = {}) {
  const due = await huntingRepository.dueForReading({ limit, ownerId });
  let read = 0;
  for (const hunt of due) {
    if (!trackAllowanceLeft()) break;
    try {
      await readSalesNow(hunt);
      read += 1;
    } catch (err) {
      logger.warn('Hunting: competitor sales not read', { huntId: hunt.id, error: err.message });
    }
  }
  return read;
}

// Opening a product reads its competitor when the last reading is over this
// old (or there's none), whatever stage it's at: the daily reading skips
// rejected products, and ones hunted before readings existed have none.
const READ_ON_OPEN_HOURS = 20;
async function readIfStale(hunt) {
  if (!hunt.competitor_url || !trackAllowanceLeft()) return;
  const readings = await huntingRepository.readings(hunt.id);
  const last = readings[readings.length - 1];
  if (last && Date.now() - new Date(last.taken_at).getTime() < READ_ON_OPEN_HOURS * 3600000) return;
  await readSalesNow(hunt).catch((err) => logger.warn('Hunting: competitor sales not read on open', { huntId: hunt.id, error: err.message }));
}

/**
 * Sold by variation for a product checked before the check kept it: from its
 * latest reading, with the supplier options the check matched to each.
 */
function variationsFromReading(checkResult, readings) {
  const last = readings[readings.length - 1];
  if (!last || !Array.isArray(last.variations) || !last.variations.length) return [];
  const total = last.variations.reduce((sum, v) => sum + (v.sold || 0), 0);
  return last.variations
    .map((v) => ({
      label: v.label,
      sold: v.sold ?? null,
      share: total && v.sold !== null && v.sold !== undefined ? Math.round((v.sold / total) * 1000) / 10 : null,
      price: v.price ?? null,
      available: v.available ?? null,
      supplier: (checkResult?.options || []).filter((r) => r.match && r.match.quality !== 'lowest' && r.match.label === v.label).map((r) => r.label || 'The product').slice(0, 4),
    }))
    .sort((a, b) => (b.sold ?? -1) - (a.sold ?? -1));
}

/** Test hook. */
function forgetChecks() {
  checks.clear();
}

module.exports = {
  huntListing,
  addSource,
  makeMainSource,
  removeSource,
  draftAgain,
  draftsSettled,
  startDraft,
  draftNow,
  rejectMismatch, convertingByDay, readDueSales, check, add, list, detail, recheck, update, resubmit, decide, remove, badge, draftStart, memberFigures, viewerFor, readProduct, forgetChecks, HuntError };
