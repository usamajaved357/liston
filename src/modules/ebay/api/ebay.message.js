// eBay's Message API (REST, commerce/message/v1): the member messages a
// buyer sees in their eBay Messages, and eBay's own messages to the seller.
// Liston reads the account's conversations (the Inbox), reads one
// conversation's messages, marks them read or unread and archives them, and
// sends: a reply in a conversation (`conversationId`), or a new conversation
// with a buyer about a listing (`otherPartyUsername` + a LISTING reference;
// eBay threads it with anything already said). Needs the commerce.message
// scope on the seller's token (see ebay.oauth). Text is at most 2,000
// characters; up to 5 attachments as self-hosted HTTPS links.
const { request } = require('./ebay.client');
const ebayOauth = require('./ebay.oauth');

const MAX_TEXT = 2000;
const MAX_MEDIA = 5;
const TYPES = ['FROM_MEMBERS', 'FROM_EBAY'];

function baseUrl() {
  return ebayOauth.isSandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

function messageOf(m = {}) {
  return {
    messageId: m.messageId ? String(m.messageId) : null,
    body: m.messageBody ?? m.body ?? '',
    subject: m.subject || null,
    sender: m.senderUsername || m.sender || null,
    recipient: m.recipientUsername || m.recipient || null,
    read: m.readStatus === undefined ? null : Boolean(m.readStatus),
    createdAt: m.createdDate || m.creationDate || null,
    media: (m.messageMedia || []).map((x) => ({ name: x.mediaName || null, type: x.mediaType || null, url: x.mediaUrl || null })).filter((x) => x.url),
  };
}

// eBay names a folder ARCHIVED or DELETED when it lists them, ARCHIVE or DELETE when you move one: Liston keeps one name.
const FOLDER = { ARCHIVED: 'ARCHIVE', DELETED: 'DELETE' };

function conversationOf(c = {}, type) {
  return {
    conversationId: String(c.conversationId),
    type: c.conversationType || type,
    status: FOLDER[c.conversationStatus] || c.conversationStatus || 'ACTIVE',
    title: c.conversationTitle || null,
    referenceId: c.referenceId ? String(c.referenceId) : null,
    referenceType: c.referenceType || null,
    unreadCount: Number(c.unreadCount) || 0,
    createdAt: c.createdDate || null,
    latestMessage: c.latestMessage ? messageOf(c.latestMessage) : null,
  };
}

const badStatus = (err) => /conversationStatus|conversation_status/i.test(err?.message || '');

/**
 * One page of the account's conversations of a type (FROM_MEMBERS: buyers
 * and other members; FROM_EBAY: eBay's own), newest first: { conversations,
 * total }. `status`: ACTIVE (the default), ARCHIVE or DELETE — asked of eBay
 * as ARCHIVED / DELETED (its listing names; the other spelling if it refuses).
 */
async function getConversations(accessToken, { type = 'FROM_MEMBERS', status = null, limit = 50, offset = 0, otherPartyUsername = null, referenceId = null } = {}, marketplaceId) {
  const names = status === 'ARCHIVE' ? ['ARCHIVED', 'ARCHIVE'] : status === 'DELETE' ? ['DELETED', 'DELETE'] : [status];
  let lastError;
  for (const name of names) {
    const query = qs({ conversation_type: type, conversation_status: name, other_party_username: otherPartyUsername, reference_id: referenceId, reference_type: referenceId ? 'LISTING' : null, limit, offset });
    try {
      const res = await request(accessToken, 'GET', `/commerce/message/v1/conversation?${query}`, null, marketplaceId, { baseUrl: baseUrl() });
      return { conversations: (res?.conversations || []).map((c) => ({ ...conversationOf(c, type), status: status || conversationOf(c, type).status })), total: Number(res?.total) || 0 };
    } catch (err) {
      lastError = err;
      if (!badStatus(err)) throw err;
    }
  }
  throw lastError;
}

/** One page of a conversation's messages: { messages, total }. */
async function getConversation(accessToken, conversationId, { type = 'FROM_MEMBERS', limit = 50, offset = 0 } = {}, marketplaceId) {
  const query = qs({ conversation_type: type, limit, offset });
  const res = await request(accessToken, 'GET', `/commerce/message/v1/conversation/${encodeURIComponent(conversationId)}?${query}`, null, marketplaceId, { baseUrl: baseUrl() });
  return { messages: (res?.messages || []).map(messageOf), total: Number(res?.total) || 0 };
}

/**
 * Marks a conversation read or unread (`read`), or moves it (`status`:
 * ACTIVE, ARCHIVE, DELETE). eBay takes one change per call.
 */
async function updateConversation(accessToken, { conversationId, type = 'FROM_MEMBERS', read, status }, marketplaceId) {
  const body = { conversationId: String(conversationId), conversationType: type };
  if (!status) {
    body.read = Boolean(read);
    await request(accessToken, 'POST', '/commerce/message/v1/update_conversation', body, marketplaceId, { baseUrl: baseUrl() });
    return;
  }
  const names = status === 'ARCHIVE' ? ['ARCHIVE', 'ARCHIVED'] : status === 'DELETE' ? ['DELETE', 'DELETED'] : [status];
  for (let i = 0; i < names.length; i += 1) {
    try {
      await request(accessToken, 'POST', '/commerce/message/v1/update_conversation', { ...body, conversationStatus: names[i] }, marketplaceId, { baseUrl: baseUrl() });
      return;
    } catch (err) {
      if (!badStatus(err) || i === names.length - 1) throw err;
    }
  }
}

/**
 * Sends a message: a reply in a conversation (`conversationId`), or to a
 * buyer about one listing (`buyerUsername` + `itemId`). `media`: up to 5
 * { name, type: IMAGE | PDF | DOC | TXT, url } on self-hosted HTTPS links.
 * { messageId, conversationId }.
 */
async function sendMessage(accessToken, { conversationId = null, buyerUsername = null, itemId = null, text, media = [] }, marketplaceId) {
  const body = { messageText: String(text || '').slice(0, MAX_TEXT) };
  if (conversationId) body.conversationId = String(conversationId);
  else {
    body.otherPartyUsername = String(buyerUsername);
    if (itemId) body.reference = { referenceId: String(itemId), referenceType: 'LISTING' };
  }
  if (media.length) body.messageMedia = media.slice(0, MAX_MEDIA).map((m) => ({ mediaName: m.name, mediaType: m.type, mediaUrl: m.url }));
  const res = await request(accessToken, 'POST', '/commerce/message/v1/send_message', body, marketplaceId, { baseUrl: baseUrl() });
  return { messageId: res?.messageId || null, conversationId: res?.conversationId || conversationId || null };
}

module.exports = { getConversations, getConversation, updateConversation, sendMessage, MAX_TEXT, MAX_MEDIA, TYPES };
