// eBay's Message API (REST, commerce/message/v1): the member messages a
// buyer sees in their eBay Messages. Liston starts a conversation with a
// buyer about the listing they bought (`otherPartyUsername` + a LISTING
// reference); eBay threads it with anything already said. Needs the
// commerce.message scope on the seller's token (see ebay.oauth). Text is at
// most 2,000 characters.
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

const MAX_TEXT = 2000;

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

/** Sends `text` to a buyer about one listing: { messageId, conversationId }. */
async function sendMessage(accessToken, { buyerUsername, itemId, text }, marketplaceId) {
  const body = {
    otherPartyUsername: String(buyerUsername),
    messageText: String(text).slice(0, MAX_TEXT),
    reference: { referenceId: String(itemId), referenceType: 'LISTING' },
  };
  const res = await request(accessToken, 'POST', '/commerce/message/v1/send_message', body, marketplaceId, { baseUrl: baseUrl() });
  return { messageId: res?.messageId || null, conversationId: res?.conversationId || null };
}

module.exports = { sendMessage, MAX_TEXT };
