const crypto = require('crypto');
const ebayOauth = require('./ebay.oauth');
const connectionService = require('../connections/connection.service');
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
    await connectionService.createConnection(statePayload.userId, {
      platformKey: 'ebay',
      label: statePayload.label,
      credentials: tokens,
    });
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

module.exports = { oauthCallback, accountDeletionChallenge, accountDeletionNotification };
