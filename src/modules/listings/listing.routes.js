const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const listingRepository = require('./listing.repository');
const listingController = require('./listing.controller');

const router = express.Router();

// These routes are keyed by listingId, not connectionId (unlike
// /api/connections/:id/...), so requireFeature needs to look the listing up
// to find which connection it belongs to before it can resolve the member's
// permission for it.
async function resolveConnectionIdFromListing(req) {
  const listing = await listingRepository.findByIdForUser(req.params.listingId, req.ownerId);
  return listing?.connection_id;
}

router.get('/:listingId', requireAuth, requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }), listingController.getOne);
router.patch(
  '/:listingId',
  requireAuth,
  requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }),
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
router.post('/:listingId/revise', ...editGuard, listingController.reviseText);
router.post('/:listingId/images/revise', ...editGuard, listingController.reviseImage);
router.post('/:listingId/images/accept', ...editGuard, listingController.acceptImage);
router.post(
  '/:listingId/publish',
  requireAuth,
  requireFeature('listings', { resolveConnectionId: resolveConnectionIdFromListing }),
  listingController.publish
);

module.exports = router;
