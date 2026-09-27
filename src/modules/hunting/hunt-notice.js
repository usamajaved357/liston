// What a hunter is told when a reviewer acts on their product: the bell's
// line and the browser push's title and text. Pure.

const clip = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** { title, body, detail } for a hunt.* notification, or null for a kind nobody is told about. */
function noticeFor(kind, { title, by, reason = null, note = null }) {
  const product = clip(title, 60) || 'your product';
  const who = by || 'A reviewer';
  const said = note ? ` “${clip(note, 140)}”` : '';
  // The parts, for the bell to lay out.
  const detail = { product: clip(title, 140) || null, by: by || null, reason: reason || null, note: note ? clip(note, 300) : null };
  const notice = build(kind, { product, who, reason, said });
  return notice ? { ...notice, detail } : null;
}

function build(kind, { product, who, reason, said }) {
  switch (kind) {
    case 'hunt.approved':
      return { title: `Approved: ${product}`, body: `${who} approved your product. It's ready to draft.${said}` };
    case 'hunt.rejected':
      return { title: `Rejected: ${product}`, body: `${who} rejected it${reason ? `: ${reason}` : ''}.${said}` };
    case 'hunt.sent_back':
      return { title: `Sent back: ${product}`, body: `${who} sent it back for you to improve.${said}` };
    case 'hunt.removed':
      return { title: `Removed: ${product}`, body: `${who} removed your hunted product.` };
    default:
      return null;
  }
}

module.exports = { noticeFor };
