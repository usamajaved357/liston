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

module.exports = { oauthCallback };
