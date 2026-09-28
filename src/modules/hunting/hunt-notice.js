// What a hunter is told when a reviewer acts on their product: the bell's
// line and the browser push's title and text. Pure.

const clip = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** { title, body, detail } for a hunt.* notification, or null for a kind nobody is told about. */
// `system`: Liston did it itself (a supplier that doesn't match its eBay listing).
function noticeFor(kind, { title, by, reason = null, note = null, system = false }) {
  const product = clip(title, 60) || 'your product';
  const who = system ? 'Liston' : by || 'A reviewer';
  const said = note ? ` “${clip(note, 140)}”` : '';
  // The parts, for the bell to lay out.
  const detail = { product: clip(title, 140) || null, by: system ? 'Liston' : by || null, reason: reason || null, note: note ? clip(note, 300) : null, ...(system ? { system: true } : {}) };
  const notice = build(kind, { product, who, reason, said, system });
  return notice ? { ...notice, detail } : null;
}

function build(kind, { product, who, reason, said, system }) {
  switch (kind) {
    case 'hunt.approved':
      return { title: `Approved: ${product}`, body: `${who} approved your product. Liston is drafting it now.${said}` };
    case 'hunt.rejected':
      return system
        ? { title: `Rejected by Liston: ${product}`, body: `Liston rejected it automatically${reason ? `: ${reason}` : ''}.${said}` }
        : { title: `Rejected: ${product}`, body: `${who} rejected it${reason ? `: ${reason}` : ''}.${said}` };
    case 'hunt.sent_back':
      return { title: `Sent back: ${product}`, body: `${who} sent it back for you to improve.${said}` };
    case 'hunt.removed':
      return { title: `Removed: ${product}`, body: `${who} removed your hunted product.` };
    default:
      return null;
  }
}

module.exports = { noticeFor };
