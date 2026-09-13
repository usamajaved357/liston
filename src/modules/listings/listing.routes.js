const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const listingController = require('./listing.controller');

const router = express.Router();

router.get('/:listingId', requireAuth, listingController.getOne);
router.post('/:listingId/publish', requireAuth, listingController.publish);

module.exports = router;
