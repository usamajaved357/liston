// Who may do what to a hunted product, and where it stands. Pure.
//
// The owner reviews everything and their own finds are approved as they're
// added. A member with "Review hunted products" access reviews the account's
// products and can hunt too, but never decides on their own finds (their
// figures would be their own to write). A member with Hunting access adds
// products and, while one waits or has been sent back, can change and
// improve their own, but never remove one: only a reviewer (the owner
// included) removes a hunted product, at any stage (a hunter removes their
// own that Liston rejected). A rejected product can be edited (by its hunter
// or a reviewer) and goes back in for review. An approved product drafts itself; drafting it
// by hand, when that failed, needs Listings access or reviewing.

const REJECT_REASONS = [
  { key: 'low_profit', label: 'Low profit' },
  { key: 'low_demand', label: 'Low demand' },
  { key: 'competition', label: 'Too much competition' },
  { key: 'brand_risk', label: 'Brand or VeRO risk' },
  { key: 'supplier', label: 'Supplier problem' },
  { key: 'listed', label: 'Already listed' },
  { key: 'other', label: 'Other' },
];
// Reasons only Liston gives (a reviewer can't pick them): the supplier doesn't sell what the eBay listing sells.
const SYSTEM_REASONS = [{ key: 'mismatch', label: "Supplier doesn't match the eBay listing" }];
const reasonLabel = (key) => [...REJECT_REASONS, ...SYSTEM_REASONS].find((r) => r.key === key)?.label || null;
const autoRejected = (hunt) => hunt.status === 'rejected' && hunt.reject_reason === 'mismatch' && !hunt.reviewer_user_id;
// A draft started more than this long ago and never finished (a restart mid-draft) counts as failed.
const DRAFT_STUCK_MS = 15 * 60 * 1000;
/** Where the automatic draft stands: 'drafting', 'failed' or null (not tried, or done). */
function draftStateOf(hunt, now = Date.now()) {
  if (hunt.listing_id) return null;
  if (hunt.draft_status === 'drafting') return hunt.draft_attempted_at && now - new Date(hunt.draft_attempted_at).getTime() > DRAFT_STUCK_MS ? 'failed' : 'drafting';
  return hunt.draft_status || null;
}

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
  // Fixing and resubmitting are the hunter's own while it waits; a reviewer sends it back instead.
  // A rejected product can be fixed by its hunter or a reviewer, and goes in for review again.
  canEdit: (hunt, viewer) => (['pending', 'sent_back'].includes(stageOf(hunt)) && isHunter(hunt, viewer)) || (stageOf(hunt) === 'rejected' && (isHunter(hunt, viewer) || Boolean(viewer.canReview))),
  // The hunter sends their own back in for review: one sent back, or one rejected (as it is, or after fixing it).
  canResubmit: (hunt, viewer) => ['sent_back', 'rejected'].includes(stageOf(hunt)) && isHunter(hunt, viewer),
  // A reviewer removes any; the hunter removes their own that Liston rejected.
  canRemove: (hunt, viewer) => Boolean(viewer.canReview) || (autoRejected(hunt) && isHunter(hunt, viewer)),
  canRecheck: (hunt, viewer) => stageOf(hunt) !== 'listed' && (viewer.canHunt || viewer.canReview),
  // Approved products draft themselves; this is the way to do it by hand when that failed (or never ran).
  canDraft: (hunt, viewer) => (viewer.canDraft || viewer.canReview) && stageOf(hunt) === 'approved' && draftStateOf(hunt) !== 'drafting',
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
    if (!REJECT_REASONS.some((r) => r.key === reason)) throw new HuntError('Choose why it is rejected.');
    if (reason === 'other' && text.length < 3) throw new HuntError('Say why it is rejected.');
    return { status: 'rejected', reject_reason: reason, decision_note: text || null };
  }
  throw new HuntError('Approve, reject or send it back.');
}

module.exports = { REJECT_REASONS, SYSTEM_REASONS, autoRejected, draftStateOf, DRAFT_STUCK_MS, reasonLabel, STAGES, stageOf, permissionsFor, decisionFields, HuntError, rules };
