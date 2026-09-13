const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const connectionController = require('./connection.controller');
const listingController = require('../listings/listing.controller');

const router = express.Router();

router.get('/', requireAuth, connectionController.list);
router.get('/platforms', requireAuth, connectionController.listPlatforms);
router.post('/ebay/authorize', requireAuth, connectionController.startEbayAuth);
router.get('/:id', requireAuth, connectionController.getOne);
router.delete('/:id', requireAuth, connectionController.remove);
router.get('/:id/listings', requireAuth, connectionController.getListings);
router.get('/:id/orders', requireAuth, connectionController.getOrders);
router.get('/:id/earnings', requireAuth, connectionController.getEarnings);
router.get('/:id/policies', requireAuth, connectionController.getPolicies);
router.put('/:id/policies', requireAuth, connectionController.updatePolicies);
router.get('/:id/listings/drafts', requireAuth, listingController.listDrafts);
router.post('/:id/listings/drafts', requireAuth, listingController.generateDraft);

module.exports = router;
