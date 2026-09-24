const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const listingRepository = require('./listing.repository');
const listingController = require('./listing.controller');
const activityRepository = require('../team/activity.repository');

const router = express.Router();

// These routes are keyed by listingId, not connectionId (unlike
// /api/connections/:id/...), so requireFeature needs to look the listing up
// to find which connection it belongs to before it can resolve the member's
// permission for it.
async function resolveConnectionIdFromListing(req) {
  const listing = await listingRepository.findByIdForUser(req.params.listingId, req.ownerId);
  req.listingRow = listing || null;
  return listing?.connection_id;
}

// Working on a draft (edits, AI rewrites, photos, variation fixes, SKU) is
// the person's work: recorded once it succeeds, at most once per draft and
// person in any 3 hours — autosave is many small saves, one sitting. A live
// listing's working copy isn't a draft: its publish is recorded instead.
const DRAFT_SITTING_HOURS = 3;
function recordDraftWork(req, res, next) {
  res.on('finish', () => {
    const listing = req.listingRow;
    if (res.statusCode >= 400 || !listing || listing.edit_of_item_id || listing.status !== 'pending_review') return;
    const draft = listing.generated_data || {};
    activityRepository.record({
      actorUserId: req.userId,
      connectionId: listing.connection_id,
      kind: 'listing.draft_edited',
      subjectType: 'draft',
      subjectId: listing.id,
      title: (Array.isArray(draft.variants) && draft.variants.length ? draft.commonTitle : draft.title) || null,
      onceWithinHours: DRAFT_SITTING_HOURS,
    });
  });
  next();
}

router.get('/:listingId', requireAuth, requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }), listingController.getOne);
router.patch(
  '/:listingId',
  requireAuth,
  requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }),
  recordDraftWork,
  listingController.update
);
router.delete(
  '/:listingId',
  requireAuth,
  requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }),
  listingController.remove
);
const editGuard = [requireAuth, requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing })];

router.get('/:listingId/description-preview', ...editGuard, listingController.descriptionPreview);
router.post('/:listingId/variants/:index/split', ...editGuard, recordDraftWork, listingController.splitVariant);
router.get('/:listingId/variation-fixes', ...editGuard, listingController.variationFixes);
router.post('/:listingId/variation-fixes', ...editGuard, recordDraftWork, listingController.applyVariationFix);
router.post('/:listingId/revise', ...editGuard, recordDraftWork, listingController.reviseText);
router.post('/:listingId/sku', ...editGuard, recordDraftWork, listingController.regenerateSku);
router.post('/:listingId/policy-words/fix', ...editGuard, recordDraftWork, listingController.fixPolicyWords);
router.post('/:listingId/images/revise', ...editGuard, recordDraftWork, listingController.reviseImage);
router.post('/:listingId/images/accept', ...editGuard, recordDraftWork, listingController.acceptImage);
// A base64 image can be ~16MB for eBay's 12MB cap — well past the app-wide
// 2MB JSON limit, so this route parses its own body.
router.post('/:listingId/images/upload', ...editGuard, recordDraftWork, express.json({ limit: '20mb' }), listingController.uploadImage);
router.get('/:listingId/images/download', ...editGuard, listingController.downloadImage);
router.post(
  '/:listingId/publish',
  requireAuth,
  requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }),
  listingController.publish
);

module.exports = router;
