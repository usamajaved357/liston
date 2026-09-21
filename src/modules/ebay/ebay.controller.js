const crypto = require('crypto');
const ebayOauth = require('./api/ebay.oauth');
const connectionService = require('../connections/connection.service');
const ebayService = require('./ebay.service');
const ebayNotifications = require('./ebay.notifications');
const connectionRepository = require('../connections/connection.repository');
const governor = require('./request-governor');
const analyticsBudget = require('./analytics-budget');
const analyticsService = require('../analytics/analytics.service');
const config = require('../../config');
const logger = require('../../utils/logger');

// eBay redirects the seller's browser here after they approve (or deny)
// access — this is a browser navigation, not an API call, so failures
// redirect back to the frontend with an error flag rather than returning JSON.
async function oauthCallback(req, res) {
  const { code, state, error: ebayError } = req.query;
  const failureUrl = `${config.frontendUrl}/dashboard?ebayError=`;

  if (ebayError) {
    return res.redirect(`${failureUrl}${encodeURIComponent(String(ebayError))}`);
  }
  if (!code || !state) {
    return res.redirect(`${failureUrl}${encodeURIComponent('missing_code_or_state')}`);
  }

  let statePayload;
  try {
    statePayload = ebayOauth.verifyState(String(state));
  } catch {
    return res.redirect(`${failureUrl}${encodeURIComponent('invalid_or_expired_state')}`);
  }

  try {
    const tokens = await ebayOauth.exchangeCodeForToken(String(code));
    if (statePayload.connectionId) {
      // A reconnect: the fresh token replaces the old one on the same
      // connection; everything else it holds (marketplace, signing key…)
      // is kept.
      const existing = await connectionService.getConnectionWithDecryptedCredentials(statePayload.connectionId, statePayload.userId);
      await connectionService.updateConnectionCredentials(existing.id, { ...(existing.credentials || {}), ...tokens });
      const returnTo = typeof statePayload.returnTo === 'string' && statePayload.returnTo.startsWith('/') ? statePayload.returnTo : `/accounts/${existing.id}`;
      const joiner = returnTo.includes('?') ? '&' : '?';
      return res.redirect(`${config.frontendUrl}${returnTo}${joiner}reconnected=1`);
    }
    const created = await connectionService.createConnection(statePayload.userId, {
      platformKey: 'ebay',
      label: statePayload.label,
      credentials: tokens,
    });
    // Tag the account with its eBay site straight away; a failure here just
    // means the tag is picked up on the next Connections visit.
    await connectionService.ensureMarketplace(created.id, statePayload.userId, ebayService).catch(() => null);
    return res.redirect(`${config.frontendUrl}/dashboard?connected=ebay`);
  } catch (err) {
    logger.error('eBay OAuth callback failed', { message: err.message });
    return res.redirect(`${failureUrl}${encodeURIComponent('connection_failed')}`);
  }
}

// eBay's Marketplace Account Deletion/Closure Notification compliance check.
// GET is the one-time endpoint-ownership verification eBay fires immediately
// after the URL + token are saved in the Developer Portal; POST is the real
// notification sent whenever a user actually deletes their eBay account.
// Spec: https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion
function accountDeletionChallenge(req, res) {
  const { challenge_code: challengeCode } = req.query;
  const { deletionVerificationToken: verificationToken, deletionEndpointUrl: endpoint } = config.ebay;

  if (!challengeCode) {
    return res.status(400).json({ error: 'missing_challenge_code' });
  }
  if (!verificationToken || !endpoint) {
    logger.error('eBay account-deletion challenge received but not configured', {
      hasToken: Boolean(verificationToken),
      hasEndpoint: Boolean(endpoint),
    });
    return res.status(500).json({ error: 'not_configured' });
  }

  const hash = crypto.createHash('sha256');
  hash.update(String(challengeCode));
  hash.update(verificationToken);
  hash.update(endpoint);

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ challengeResponse: hash.digest('hex') });
}

// The actual account-deletion notification payload. Liston stores no eBay
// end-user personal data outside of the connected seller's own connection
// record (no shopper/buyer PII is persisted anywhere) — acknowledging with
// 200 is all compliance requires; nothing needs to be deleted on our side.
function accountDeletionNotification(req, res) {
  logger.info('eBay account-deletion notification received', {
    notificationId: req.body?.notification?.notificationId,
  });
  return res.status(200).json({});
}

// eBay Platform Notifications: something changed on a subscribed account.
// eBay gets its 200 straight away (it retries on anything else) and the
// affected parts of the account are re-read in the background, then pushed
// to every open page. Which parts depends on the event: a listing event
// touches the listings; a sale or payment/dispatch mark touches the orders
// (and a sale also the listing's quantity — but that is one item, so it is
// patched from a single GetItem rather than re-reading every listing).
const ORDER_EVENTS = new Set(['ItemSold', 'FixedPriceTransaction', 'ItemMarkedPaid', 'ItemMarkedShipped']);
const LISTING_EVENTS = new Set(['ItemListed', 'ItemRevised', 'ItemClosed', 'ItemUnsold']);
const SALE_EVENTS = new Set(['ItemSold', 'FixedPriceTransaction']);

// What a notification means for one account: which mirrors to re-read in
// full, and whether one listing's quantity can be patched instead.
function planFor(notification) {
  const { eventName, itemId } = notification;
  const kinds = [];
  if (LISTING_EVENTS.has(eventName)) kinds.push('listings');
  if (ORDER_EVENTS.has(eventName)) kinds.push('orders');
  const sale = SALE_EVENTS.has(eventName);
  // A sale without an item id (unexpected) still has to reach the listing.
  if (sale && !itemId) kinds.push('listings');
  if (!kinds.length) kinds.push('listings', 'orders');
  return { kinds, saleItemId: sale && itemId ? itemId : null };
}

async function platformNotification(req, res) {
  const xml = typeof req.body === 'string' ? req.body : '';
  const notification = ebayNotifications.parseNotification(xml);
  if (!notification || !notification.recipientUserId) {
    logger.warn('eBay notification could not be read');
    return res.status(200).send('');
  }
  if (!ebayNotifications.verify(notification)) {
    logger.warn('eBay notification failed signature check', { event: notification.eventName });
    return res.status(200).send('');
  }
  res.status(200).send('');

  try {
    const rows = await connectionRepository.findIdsByEbayUsername(notification.recipientUserId);
    const { kinds, saleItemId } = planFor(notification);
    for (const row of rows) {
      connectionService
        .withDecryptedCredentials(row.id, row.user_id, async (credentials) => {
          const jobs = [ebayService.syncAccount(credentials, row.id, kinds)];
          if (saleItemId) jobs.push(ebayService.applySale(credentials, row.id, saleItemId));
          await Promise.all(jobs);
        })
        .catch((err) => logger.warn('Re-read after eBay notification failed', { connectionId: row.id, error: err.message }));
    }
    logger.info('eBay notification handled', { event: notification.eventName, accounts: rows.length, kinds, saleItemId });
  } catch (err) {
    logger.error('eBay notification handling failed', { error: err.message });
  }
}

// Today's use of the shared eBay allowance, for the admin's usage page:
// totals, what is paused, per call and per account (with labels).
async function usage(req, res, next) {
  try {
    if (req.query.sync === '1') await Promise.all([governor.syncWithEbay(), analyticsBudget.syncWithEbay()]);
    const snap = governor.snapshot();
    const accounts = await connectionRepository.findAllEbay();
    const labels = new Map(accounts.map((a) => [String(a.id), a.label]));
    const byAccount = Object.entries(snap.byAccount)
      .map(([id, count]) => ({ connectionId: id, label: labels.get(id) || 'Removed account', count, push: Boolean(accounts.find((a) => String(a.id) === id)?.settings?.ebay?.notificationsEnabledAt) }))
      .sort((a, b) => b.count - a.count);
    const byCall = Object.entries(snap.byCall)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    res.status(200).json({
      ...snap,
      byAccount,
      byCall,
      accountsTotal: accounts.length,
      notificationsUrl: config.ebay.notificationsUrl || null,
      // The traffic report's separate allowance (see analytics-budget).
      analytics: await analyticsService.adminUsage(labels),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { oauthCallback, accountDeletionChallenge, accountDeletionNotification, platformNotification, usage, _planFor: planFor };
