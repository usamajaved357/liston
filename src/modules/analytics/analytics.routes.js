const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const analyticsController = require('./analytics.controller');

// Mounted under /api/connections/:id/analytics.
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireFeature('analytics'), analyticsController.getAnalytics);
// Every live listing's figures for a range (1 traffic call per 200 listings).
router.post('/listings/all', requireAuth, requireFeature('analytics'), analyticsController.loadAllListings);
// The Listings tab's rows: the 30-day report, shared with the Analytics tab.
router.get('/listings/summary', requireAuth, requireFeature('analytics'), analyticsController.getListingSummaries);
router.get('/listings/:itemId', requireAuth, requireFeature('analytics'), analyticsController.getListingAnalytics);
// One listing's figures for a range, read on request (1–2 traffic calls).
router.post('/listings/:itemId/read', requireAuth, requireFeature('analytics'), analyticsController.readListing);

module.exports = router;
