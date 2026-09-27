const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireAnyFeature, requireFeature } = require('../../middleware/feature.middleware');
const discoverController = require('./discover.controller');

// Mounted under /api/connections/:id/discover. Discover is part of product
// hunting: whoever hunts or reviews on the account uses it. The account's
// own keywords are its traffic, so they need Analytics as well.
const router = express.Router({ mergeParams: true });
const HUNTERS = requireAnyFeature(['hunting', 'hunting_review']);

router.get('/', requireAuth, HUNTERS, discoverController.start);
router.get('/explore', requireAuth, HUNTERS, discoverController.explore);
router.get('/review', requireAuth, HUNTERS, discoverController.review);
router.get('/suggest', requireAuth, HUNTERS, discoverController.suggest);
router.post('/rank', requireAuth, HUNTERS, discoverController.rank);
router.get('/watches', requireAuth, HUNTERS, discoverController.watches);
router.post('/watches', requireAuth, HUNTERS, discoverController.addWatch);
router.delete('/watches/:watchId', requireAuth, HUNTERS, discoverController.removeWatch);
router.get('/your-keywords', requireAuth, HUNTERS, requireFeature('analytics'), discoverController.yourKeywords);

module.exports = router;
