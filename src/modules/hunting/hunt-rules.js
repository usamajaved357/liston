// Who may do what to a hunted product, and where it stands. Pure.
//
// The owner reviews everything and their own finds are approved as they're
// added. A member with "Review hunted products" access reviews the account's
// products and can hunt too, but never decides on their own finds (their
// figures would be their own to write). A member with Hunting access adds
// products and, while one waits or has been sent back, can change or
// withdraw their own. Drafting an approved product needs Listings access.

const REJECT_REASONS = [
  { key: 'low_profit', label: 'Low profit' },
  { key: 'low_demand', label: 'Low demand' },
  { key: 'competition', label: 'Too much competition' },
  { key: 'brand_risk', label: 'Brand or VeRO risk' },
  { key: 'supplier', label: 'Supplier problem' },
  { key: 'listed', label: 'Already listed' },
  { key: 'other', label: 'Other' },
];
const reasonLabel = (key) => REJECT_REASONS.find((r) => r.key === key)?.label || null;

// Where a product stands: its review decision until it's drafted, then
// drafted, then listed (drafted and listed follow the draft and the eBay
// item, so deleting a draft puts it back to approved).
const STAGES = ['pending', 'sent_back', 'approved', 'drafted', 'listed', 'rejected'];
function stageOf(hunt) {
  if (Array.isArray(hunt.item_ids) && hunt.item_ids.length) return 'listed';
  if (hunt.listing_id) return 'drafted';
  return hunt.status;
}

const isHunter = (hunt, viewer) => Boolean(hunt.hunter_user_id) && hunt.hunter_user_id === viewer.userId;
const beforeDraft = (hunt) => !['drafted', 'listed'].includes(stageOf(hunt));

const rules = {
  canDecide: (hunt, viewer) => viewer.canReview && beforeDraft(hunt) && (viewer.isOwner || !isHunter(hunt, viewer)),
  canEdit: (hunt, viewer) => ['pending', 'sent_back'].includes(stageOf(hunt)) && (isHunter(hunt, viewer) || viewer.isOwner),
  canResubmit: (hunt, viewer) => stageOf(hunt) === 'sent_back' && (isHunter(hunt, viewer) || viewer.isOwner),
  canWithdraw: (hunt, viewer) => (isHunter(hunt, viewer) && ['pending', 'sent_back'].includes(stageOf(hunt))) || (viewer.isOwner && beforeDraft(hunt)),
  canRecheck: (hunt, viewer) => stageOf(hunt) !== 'listed' && (viewer.canHunt || viewer.canReview),
  canDraft: (hunt, viewer) => viewer.canDraft && ['approved', 'drafted', 'listed'].includes(stageOf(hunt)),
};

function permissionsFor(hunt, viewer) {
  return Object.fromEntries(Object.entries(rules).map(([name, rule]) => [name, Boolean(rule(hunt, viewer))]));
}

class HuntError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * A reviewer's decision, checked: { status, reject_reason, decision_note }
 * to store, or a HuntError saying what's missing.
 */
function decisionFields({ decision, reason, note }) {
  const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  if (decision === 'approve') return { status: 'approved', reject_reason: null, decision_note: text || null };
  if (decision === 'send_back') {
    if (text.length < 3) throw new HuntError('Say what the hunter should change before sending it back.');
    return { status: 'sent_back', reject_reason: null, decision_note: text };
  }
  if (decision === 'reject') {
    if (!reasonLabel(reason)) throw new HuntError('Choose why it is rejected.');
    if (reason === 'other' && text.length < 3) throw new HuntError('Say why it is rejected.');
    return { status: 'rejected', reject_reason: reason, decision_note: text || null };
  }
  throw new HuntError('Approve, reject or send it back.');
}

module.exports = { REJECT_REASONS, reasonLabel, STAGES, stageOf, permissionsFor, decisionFields, HuntError, rules };
