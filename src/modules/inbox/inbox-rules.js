// The eBay Inbox's rules, pure: who a conversation is with, which messages
// are the seller's, eBay's HTML notices made readable (text, with their
// links as buttons), previews, and how long a buyer has been waiting.

const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());

/** Whether a message is the seller's own (by their eBay username). */
const fromSeller = (message, seller) => Boolean(message && same(message.sender, seller));

/** Who a conversation is with: the other member's username, or "eBay" for eBay's own. */
function otherPartyOf(conversation, seller) {
  if (conversation.type === 'FROM_EBAY') return 'eBay';
  const m = conversation.latestMessage || {};
  if (m.sender && !same(m.sender, seller)) return m.sender;
  if (m.recipient && !same(m.recipient, seller)) return m.recipient;
  return m.sender || m.recipient || null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•' };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const looksHtml = (s) => /<\/?[a-z][\s\S]*?>/i.test(String(s || ''));

/**
 * A message's text for a bubble: eBay's HTML (its notices, some buyers'
 * messages) turned into lines and paragraphs, scripts and styles dropped,
 * entities decoded; plain text as it is.
 */
function htmlToText(input, { dropLinks = false } = {}) {
  let s = String(input || '');
  if (!looksHtml(s)) return decode(s).replace(/\r\n/g, '\n').trim();
  // eBay's notices show their links as buttons, so their words leave the text.
  if (dropLinks) s = s.replace(/<a\b[^>]*href\s*=\s*["']https?:[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '');
  s = s
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol|section)>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|ul|ol|section)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '');
  return decode(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The links in eBay's HTML, as buttons: [{ text, url }] (http(s) only, each once, at most 6). */
function linksIn(input) {
  const out = [];
  const seen = new Set();
  for (const m of String(input || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decode(m[1]).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;
    seen.add(url);
    out.push({ text, url });
    if (out.length >= 6) break;
  }
  return out;
}

/** A list row's line: the message's text, to 160 characters. */
function previewOf(body) {
  const text = htmlToText(body).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * When a buyer started waiting for an answer: a buyer conversation whose
 * last word is theirs (null when the seller spoke last, or it's eBay's).
 */
function waitingSince(row) {
  if (row.type !== 'FROM_MEMBERS' || row.latest_from_seller || !row.latest_at) return null;
  return row.latest_at;
}

// What eBay blocks or flags in a message to a buyer (its member-to-member rules):
// contact details, links off eBay, and paying outside eBay.
const EBAY_HOST = /(^|\.)ebay\.[a-z.]{2,8}$/i;
function warningsFor(text) {
  const s = String(text || '');
  const out = [];
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(s)) out.push({ kind: 'email', text: "An email address: eBay removes them from messages, and sharing one can get the account restricted." });
  // A phone number stands alone and starts like one (+44, 07…, (555)…): not a tracking number, order or item number.
  const digits = (s.match(/(?<![A-Za-z0-9-])(?:\+|0|\()[\d\s().-]{8,}\d(?![A-Za-z0-9-])/g) || []).filter((m) => {
    const n = m.replace(/\D/g, '').length;
    return n >= 10 && n <= 13 && !/^\d{2}-\d{5}-\d{5}$/.test(m.trim());
  });
  if (digits.length) out.push({ kind: 'phone', text: 'A phone number: eBay blocks contact details in messages.' });
  const links = (s.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) || []).filter((u) => {
    try {
      return !EBAY_HOST.test(new URL(u.startsWith('http') ? u : `https://${u}`).hostname);
    } catch {
      return true;
    }
  });
  if (links.length) out.push({ kind: 'link', text: 'A link to another website: eBay only allows links to eBay.' });
  if (/\b(pay ?pal|bank transfer|pay (me )?(directly|outside|off)|western union|venmo|cash ?app|zelle|whats ?app|telegram|wechat)\b/i.test(s)) {
    out.push({ kind: 'offsite', text: 'Talk of paying or talking outside eBay: eBay forbids it and can suspend the account.' });
  }
  return out;
}

/**
 * How many are unread in a conversation eBay lists (`unread`, its latest
 * message `latestAt`, whether that was the seller's), given when someone
 * last read it in Liston (`readAt`): nothing is unread once it's been read
 * up to its latest message, or when the last word is the seller's since it
 * was read here; only a newer message from the buyer brings eBay's count
 * back. (eBay's list can keep saying "unread" after it was marked read.)
 * The same rule guards the write in inboxRepository.upsertConversations.
 */
function unreadAfterRead(unread, { latestAt, latestFromSeller }, readAt) {
  if (!readAt) return unread;
  if (latestFromSeller || !latestAt || new Date(latestAt).getTime() <= new Date(readAt).getTime()) return 0;
  return unread;
}

module.exports = {
  warningsFor, fromSeller, otherPartyOf, htmlToText, linksIn, previewOf, waitingSince, looksHtml, same, unreadAfterRead };
