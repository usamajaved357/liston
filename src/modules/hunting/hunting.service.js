const crypto = require('crypto');
const huntingRepository = require('./hunting.repository');
const huntProfit = require('./hunt-profit');
const huntDuplicates = require('./hunt-duplicates');
const { REJECT_REASONS, reasonLabel, stageOf, permissionsFor, decisionFields, HuntError, rules } = require('./hunt-rules');
const stats = require('./hunting-stats');
const connectionService = require('../connections/connection.service');
const teamRepository = require('../team/team.repository');
const activityRepository = require('../team/activity.repository');
const activity = require('../team/activity');
const analyticsDays = require('../analytics/analytics-days');
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
const LISTER_VIEWS = ['approved', 'listed'];
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
async function duplicatesFor(ownerId, { productId, itemId, title, connectionId, excludeId = null }) {
  const [hunts, listings, live, allLive] = await Promise.all([
    huntingRepository.huntsMatching(ownerId, { productId, itemId, excludeId }),
    huntingRepository.listingsMatching(ownerId, { productId, itemId }),
    mirror.ownerLiveListings(ownerId, { productId, itemId }),
    mirror.ownerLiveListings(ownerId),
  ]);
  return huntDuplicates.describe({ hunts, listings, live, allLive }, { productId, itemId, title, connectionId });
}

/**
 * Reads both listings and works out the profit check for this account:
 * { competitorUrl, sourceUrl, itemId, productId, result } (result is
 * hunt-profit's, with the duplicates found).
 */
async function readProduct(ownerId, connectionId, { competitorUrl, sourceUrl }, { excludeId = null } = {}) {
  const connection = await connectionService.getConnectionSummary(connectionId, ownerId);
  if (connection.platform_key !== 'ebay') throw new HuntError('Product hunting needs an eBay account.');
  const site = marketplaces.byId(connection.marketplace?.id) || marketplaces.byId(connection.settings?.ebay?.marketplaceId) || marketplaces.byId(marketplaces.DEFAULT_ID);
  // The competitor is optional, as in drafting: without one nothing is read
  // from eBay and each option is priced at the account's target return.
  const itemId = competitorUrl ? ebaySource.legacyItemIdFromUrl(competitorUrl) : null;
  const productId = aliexpressSource.productIdFromUrl(sourceUrl);
  if (competitorUrl) await ensureAllowance();

  // AliExpress is the slower read: started first, awaited after eBay's.
  const sourcePromise = aliexpressSource.fetchProduct(sourceUrl, { shipTo: site.country, currency: site.currency });
  sourcePromise.catch(() => {});
  const competitor = competitorUrl ? await browseUsage.as('hunting', () => ebaySource.fetchListing(competitorUrl, site.id)) : null;
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
  result.source.productId = productId;
  if (result.competitor) result.competitor.itemId = result.competitor.itemId || itemId;
  if (postage) result.shipping.forOption = anchor.label;
  result.market = { id: site.id, name: site.name, country: site.country };
  result.duplicates = await duplicatesFor(ownerId, { productId, itemId, title: competitor?.title || source.title, connectionId, excludeId });
  return { competitorUrl: competitorUrl || null, sourceUrl, itemId, productId, result };
}

function checkColumns(read) {
  const { result } = read;
  return {
    competitorUrl: read.competitorUrl,
    competitorItemId: read.itemId,
    sourceUrl: read.sourceUrl,
    sourceProductId: read.productId,
    title: result.competitor?.title || result.source.title || 'Untitled product',
    imageUrl: result.source.imageUrl || result.competitor?.imageUrl || null,
    currency: result.currency,
    checkResult: result,
    headlineProfit: result.summary.headline.profit,
    headlineRoi: result.summary.headline.roi,
    soldPerMonth: result.demand.soldPerMonth,
  };
}

// ---- shaping for the page --------------------------------------------------------------------

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
    competitorSold: result.demand?.sold ?? null,
    options: result.summary?.total ?? null,
    hunter: personOf(row.hunter_user_id, row.hunter_name, row.hunter_email),
    reviewer: personOf(row.reviewer_user_id, row.reviewer_name, row.reviewer_email),
    autoApproved: Boolean(row.reviewer_user_id && row.reviewer_user_id === row.hunter_user_id),
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    checkedAt: row.checked_at,
    resubmits: row.resubmits,
    rejectReason: row.reject_reason,
    rejectReasonLabel: reasonLabel(row.reject_reason),
    decisionNote: row.decision_note,
    hunterNote: row.hunter_note,
    warnings: levelCount(result),
    duplicates: (result.duplicates || []).filter((d) => d.type !== 'similar').length,
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
    }));
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

/** Adds a checked product to the account's hunting list. The owner's own are approved as they're added. */
async function add(auth, connectionId, { checkId, note }) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt) refuse("You don't have access to hunting on this account.");
  pruneChecks();
  const kept = checks.get(checkId);
  if (!kept || kept.userId !== auth.userId || kept.connectionId !== String(connectionId)) throw new HuntError('That check has expired. Check the product again.');
  const columns = checkColumns(kept.read);
  const id = await huntingRepository.insert({
    ...columns,
    ownerId: auth.ownerId,
    connectionId,
    hunterId: auth.userId,
    status: viewer.isOwner ? 'approved' : 'pending',
    reviewerId: viewer.isOwner ? auth.userId : null,
    decidedAt: viewer.isOwner ? new Date() : null,
    note: typeof note === 'string' ? note.trim().slice(0, 1000) : null,
  });
  checks.delete(checkId);
  await activityRepository.record({
    actorUserId: auth.userId,
    connectionId,
    kind: 'hunt.added',
    subjectType: 'hunt',
    subjectId: id,
    title: columns.title,
    detail: { profit: columns.headlineProfit, roi: columns.headlineRoi, autoApproved: viewer.isOwner },
  });
  return detail(auth, id);
}

/** An account's hunted products for one view, with each view's count. */
async function list(auth, connectionId, { view, mine, hunter, q, sort, page } = {}) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt && !viewer.canReview && !viewer.canDraft) refuse("You don't have access to hunting on this account.");
  const allowed = listerOnly(viewer) ? LISTER_VIEWS : huntingRepository.VIEWS;
  const chosen = allowed.includes(view) ? view : allowed.includes('all') ? 'all' : 'approved';
  const hunterId = mine ? auth.userId : /^[0-9a-f-]{36}$/i.test(String(hunter || '')) ? hunter : null;
  const offset = Math.max(0, (Number(page) || 1) - 1) * PAGE;
  const [{ rows, more }, counts, hunters] = await Promise.all([
    huntingRepository.list(connectionId, { view: chosen, hunterId, q: String(q || '').trim().slice(0, 100), sort: huntingRepository.SORTS.includes(sort) ? sort : chosen === 'review' ? 'waiting' : 'newest', limit: PAGE, offset }),
    huntingRepository.counts(connectionId, { hunterId }),
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
  const { hunt, viewer } = await loadHunt(auth, huntId);
  const [events, duplicates, sales] = await Promise.all([
    huntingRepository.history(auth.ownerId, hunt.id),
    duplicatesFor(auth.ownerId, { productId: hunt.source_product_id, itemId: hunt.competitor_item_id, title: hunt.title, connectionId: hunt.connection_id, excludeId: hunt.id }).catch(() => hunt.check_result?.duplicates || []),
    salesOf([hunt]).catch(() => new Map()),
  ]);
  return {
    ...summaryOf(hunt, viewer, sales.get(hunt.id)),
    connectionLabel: hunt.connection_label,
    result: { ...hunt.check_result, duplicates },
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
  const previous = hunt.check_result?.summary?.headline || {};
  return { ...(await detail(auth, huntId)), previous: { profit: previous.profit ?? null, roi: previous.roi ?? null } };
}

/**
 * The hunter changes a waiting (or sent back) product: other links, which
 * re-reads it, or their note. `competitorUrl: null` takes the competitor
 * away (undefined leaves it as it is).
 */
async function update(auth, huntId, { competitorUrl, sourceUrl, note }) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canEdit(hunt, viewer)) refuse('Only the hunter can change it, and only while it waits for review or has been sent back.');
  const nextCompetitor = competitorUrl === undefined ? hunt.competitor_url : competitorUrl || null;
  const nextSource = sourceUrl || hunt.source_url;
  const links = nextCompetitor !== hunt.competitor_url || nextSource !== hunt.source_url;
  if (links) {
    const read = await readProduct(auth.ownerId, hunt.connection_id, { competitorUrl: nextCompetitor, sourceUrl: nextSource }, { excludeId: hunt.id });
    await huntingRepository.setCheck(hunt.id, checkColumns(read));
  }
  if (typeof note === 'string') await huntingRepository.setNote(hunt.id, note.trim().slice(0, 1000));
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.updated', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { links: Boolean(links) } });
  return detail(auth, huntId);
}

/** A product sent back goes in for review again. */
async function resubmit(auth, huntId, { note } = {}) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canResubmit(hunt, viewer)) refuse('Only a product sent back to you can be resubmitted.');
  if (typeof note === 'string') await huntingRepository.setNote(hunt.id, note.trim().slice(0, 1000));
  await huntingRepository.resubmit(hunt.id);
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.resubmitted', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: {} });
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
  return detail(auth, huntId);
}

/** The hunter withdraws a product still waiting (or sent back); the owner can remove any not yet drafted. */
async function withdraw(auth, huntId) {
  const { hunt, viewer } = await loadHunt(auth, huntId);
  if (!rules.canWithdraw(hunt, viewer)) refuse('It can only be withdrawn by its hunter while it waits for review, or removed by the owner before it is drafted.');
  await huntingRepository.deleteById(hunt.id);
  await activityRepository.record({ actorUserId: auth.userId, connectionId: hunt.connection_id, kind: 'hunt.withdrawn', subjectType: 'hunt', subjectId: hunt.id, title: hunt.title, detail: { stage: stageOf(hunt) } });
}

/** The side menu's badge. */
async function badge(auth, connectionId) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canHunt && !viewer.canReview && !viewer.canDraft) return { review: 0, sentBack: 0, approved: 0, access: false };
  const counts = await huntingRepository.badgeCounts(connectionId, auth.userId);
  return { review: viewer.canReview ? counts.review : 0, sentBack: counts.sent_back, approved: viewer.canDraft ? counts.approved : 0, access: true };
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
    },
  };
}

// ---- figures ---------------------------------------------------------------------------

function accountZone(connection) {
  return analyticsDays.timeZoneFor(connection.marketplace?.id || connection.settings?.ebay?.marketplaceId || 'EBAY_GB') || 'Europe/London';
}

/**
 * The Hunting page's team table for a range: each person who hunted or
 * reviewed on this account, their results and decisions, and the sales of
 * the listings their products became. Owner and reviewers only.
 */
async function team(auth, connectionId, { range, from, to } = {}) {
  const viewer = await viewerFor(auth, connectionId);
  if (!viewer.canReview) refuse('Only reviewers see the team figures.');
  const connection = await connectionService.getConnectionSummary(connectionId, auth.ownerId);
  const win = activity.rangeWindow(range, { from, to, timeZone: accountZone(connection) });
  const span = { start: win.startsAt, end: win.endsAt, connectionId };
  const [hunted, decided, decisions, listed] = await Promise.all([
    huntingRepository.huntedBetween(auth.ownerId, span),
    huntingRepository.decidedBetween(auth.ownerId, span),
    huntingRepository.decisionsBetween(auth.ownerId, span),
    huntingRepository.listedHunts(auth.ownerId, { connectionId }),
  ]);
  const orders = await mirror.ordersForItems([connectionId], listed.flatMap((h) => h.item_ids), win.startsAt, win.endsAt);
  const byItem = stats.salesByItem(orders, { isCancelled });
  const ids = [...new Set([...hunted.map((h) => h.hunter_user_id), ...decisions.map((d) => d.actor_user_id)].filter(Boolean))];
  const people = await huntingRepository.people(ids);
  const rows = ids
    .map((id) => {
      const person = people.get(id);
      return {
        person: { id, name: person?.name || (person?.email ? person.email.split('@')[0] : 'Someone'), isOwner: person?.role === 'owner', removed: Boolean(person?.deactivated_at) },
        hunter: stats.hunterFigures(hunted.filter((h) => h.hunter_user_id === id)),
        reviewer: stats.reviewerFigures(
          decisions.filter((d) => d.actor_user_id === id),
          decided.filter((d) => d.reviewer_user_id === id)
        ),
        sales: stats.salesFor(listed.filter((h) => h.hunter_user_id === id).flatMap((h) => h.item_ids), byItem)[0] || null,
      };
    })
    .sort((a, b) => b.hunter.hunted - a.hunter.hunted || b.reviewer.reviewed - a.reviewer.reviewed);
  return {
    range: { key: win.key, from: win.from, to: win.to, days: win.days, timeZone: win.timeZone },
    people: rows,
    totals: {
      hunter: stats.hunterFigures(hunted),
      reviewer: stats.reviewerFigures(decisions, decided),
      sales: stats.salesFor(listed.flatMap((h) => h.item_ids), byItem)[0] || null,
    },
    reasons: stats.reasonCounts(hunted),
    currency: marketplaces.currencyFor(connection.marketplace?.id || connection.settings?.ebay?.marketplaceId),
  };
}

/**
 * A member's hunting for their page, across the owner's accounts, for a
 * range window and the one before it (team/activity.rangeWindow).
 */
async function memberFigures(ownerId, memberId, win) {
  const span = (w) => ({ start: w.startsAt, end: w.endsAt });
  const [hunted, prevHunted, decisions, prevDecisions, decided, prevDecided, listed] = await Promise.all([
    huntingRepository.huntedBetween(ownerId, { ...span(win), hunterId: memberId }),
    huntingRepository.huntedBetween(ownerId, { ...span(win.previous), hunterId: memberId }),
    huntingRepository.decisionsBetween(ownerId, { ...span(win), actorId: memberId }),
    huntingRepository.decisionsBetween(ownerId, { ...span(win.previous), actorId: memberId }),
    huntingRepository.decidedBetween(ownerId, { ...span(win), reviewerId: memberId }),
    huntingRepository.decidedBetween(ownerId, { ...span(win.previous), reviewerId: memberId }),
    huntingRepository.listedHunts(ownerId, { hunterId: memberId }),
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

/** Test hook. */
function forgetChecks() {
  checks.clear();
}

module.exports = { check, add, list, detail, recheck, update, resubmit, decide, withdraw, badge, draftStart, team, memberFigures, viewerFor, readProduct, forgetChecks, HuntError };
