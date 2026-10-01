// What in a message points at something in Liston (pure): a Liston link to
// an order, a listing, a draft, a hunted product or an eBay conversation in
// an account's Inbox; an eBay order number
// (12-34567-89012); an eBay listing link or a 12-digit item number. Each
// becomes a reference the resolver turns into a card. A few per message.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LISTON = new RegExp(
  `(?:https?:\\/\\/[^\\s/]+)?\\/accounts\\/(${UUID})\\/(?:orders\\/(\\d{2}-\\d{5}-\\d{5})|listings\\/draft\\/(${UUID})|listings\\?(?:[^\\s#]*&)?q=(\\d{9,15})|hunting\\?(?:[^\\s#]*&)?open=(${UUID}))`,
  'gi'
);
// An account's Inbox opened at one conversation: ?e=<account>~<conversation>.
const INBOX = new RegExp(`(?:https?:\\/\\/[^\\s/]+)?\\/accounts\\/(${UUID})\\/inbox\\?(?:[^\\s#]*&)?e=${UUID}(?:~|%7E)([\\w.-]+)`, 'gi');
const ORDER = /(?<![\d-])(\d{2}-\d{5}-\d{5})(?![\d-])/g;
const EBAY_ITEM = /https?:\/\/(?:www\.)?ebay\.[a-z.]{2,8}\/itm\/(?:[^\s/?#]+\/)?(\d{9,15})/gi;
const ITEM = /(?<![\d/=-])(\d{12})(?![\d-])/g;
const MAX = 5;

/** The references in `text`, in the order they appear, each once: [{ kind, id, connectionId? }]. */
function detect(text) {
  const s = String(text || '');
  // Every match with where it sits; a Liston or eBay link claims its span, so the numbers inside it aren't read again.
  const found = [];
  const taken = [];
  const claim = (m) => taken.push([m.index, m.index + m[0].length]);
  const free = (m) => !taken.some(([a, b]) => m.index < b && m.index + m[0].length > a);
  for (const m of s.matchAll(LISTON)) {
    const connectionId = m[1].toLowerCase();
    const ref = m[2]
      ? { kind: 'order', id: m[2], connectionId }
      : m[3]
        ? { kind: 'draft', id: m[3].toLowerCase(), connectionId }
        : m[4]
          ? { kind: 'listing', id: m[4], connectionId }
          : { kind: 'hunt', id: m[5].toLowerCase(), connectionId };
    found.push({ at: m.index, ref });
    claim(m);
  }
  for (const m of s.matchAll(INBOX)) {
    if (!free(m)) continue;
    found.push({ at: m.index, ref: { kind: 'conversation', id: m[2], connectionId: m[1].toLowerCase() } });
    claim(m);
  }
  for (const m of s.matchAll(EBAY_ITEM)) {
    if (!free(m)) continue;
    found.push({ at: m.index, ref: { kind: 'listing', id: m[1] } });
    claim(m);
  }
  for (const m of s.matchAll(ORDER)) if (free(m)) found.push({ at: m.index, ref: { kind: 'order', id: m[1] } });
  for (const m of s.matchAll(ITEM)) if (free(m)) found.push({ at: m.index, ref: { kind: 'listing', id: m[1] } });

  const out = [];
  const seen = new Set();
  for (const { ref } of found.sort((a, b) => a.at - b.at)) {
    const key = `${ref.kind}:${String(ref.id).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= MAX) break;
  }
  return out;
}

module.exports = { detect, MAX };
