const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireOwner, requireFeature, requireAnyFeature } = require('../../middleware/feature.middleware');
const { KNOWN_FEATURES } = require('../team/team.repository');
const connectionController = require('./connection.controller');
const listingController = require('../listings/listing.controller');

const router = express.Router();

router.get('/', requireAuth, connectionController.list);
router.get('/platforms', requireAuth, connectionController.listPlatforms);
// Creating/removing a whole eBay connection, and its business
// policies/shipping location, are always admin-only — never delegable.
router.post('/ebay/authorize', requireAuth, requireOwner, connectionController.startEbayAuth);
router.get('/:id', requireAuth, requireAnyFeature(KNOWN_FEATURES), connectionController.getOne);
router.delete('/:id', requireAuth, requireOwner, connectionController.remove);
router.get('/:id/listings', requireAuth, requireFeature('listings'), connectionController.getListings);
router.get('/:id/orders', requireAuth, requireFeature('orders'), connectionController.getOrders);
router.get('/:id/earnings', requireAuth, requireFeature('orders'), connectionController.getEarnings);
router.get('/:id/policies', requireAuth, requireOwner, connectionController.getPolicies);
router.put('/:id/policies', requireAuth, requireOwner, connectionController.updatePolicies);
// Listing settings (target ROI, fees, shipping) drive every sell price, so
// they're owner-only for the same reason policies are — never delegable.
router.put('/:id/pricing', requireAuth, requireOwner, connectionController.updatePricing);
router.put('/:id/template', requireAuth, requireOwner, connectionController.updateTemplate);
router.get('/:id/template/palette', requireAuth, requireOwner, connectionController.logoPalette);
router.get('/:id/store-profile', requireAuth, requireOwner, connectionController.getStoreProfile);
router.get('/:id/listings/drafts', requireAuth, requireFeature('listings'), listingController.listDrafts);
router.post('/:id/listings/:itemId/edit', requireAuth, requireFeature('listings'), listingController.startLiveEdit);
router.delete('/:id/listings/:itemId', requireAuth, requireOwner, listingController.removeInactive);
// Step one of drafting: read both listings so the seller can pick which
// variations to list, before anything is generated or paid for.
router.post('/:id/listings/drafts/preview', requireAuth, requireFeature('listings'), listingController.previewDraft);
router.post('/:id/listings/drafts', requireAuth, requireFeature('listings'), listingController.generateDraft);

module.exports = router;
