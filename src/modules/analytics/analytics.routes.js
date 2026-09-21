const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const analyticsController = require('./analytics.controller');

// Mounted under /api/connections/:id/analytics.
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireFeature('analytics'), analyticsController.getAnalytics);
router.post('/refresh', requireAuth, requireFeature('analytics'), analyticsController.refreshToday);
// Stored figures only (no eBay traffic calls), for the Listings tab's rows.
router.get('/listings/summary', requireAuth, requireFeature('analytics'), analyticsController.getListingSummaries);
router.get('/listings/:itemId', requireAuth, requireFeature('analytics'), analyticsController.getListingAnalytics);

module.exports = router;
