const express = require('express');
const ebayController = require('./ebay.controller');
const { requireAuth, requireAdmin } = require('../../middleware/auth.middleware');

const router = express.Router();

// Public — eBay itself calls this via browser redirect, not an authenticated
// API client. Authenticity comes from the signed `state` param, not a session.
router.get('/oauth/callback', ebayController.oauthCallback);

// Public — eBay's own verification/notification calls, no auth header.
// Authenticity comes from the SHA-256 challenge response / payload shape,
// not a session.
router.get('/account-deletion', ebayController.accountDeletionChallenge);
router.post('/account-deletion', ebayController.accountDeletionNotification);

// Public — eBay's Platform Notifications arrive here as SOAP XML. Verified
// by signature when EBAY_DEV_ID is set; only ever triggers a re-read.
router.post('/notifications', express.text({ type: '*/*', limit: '1mb' }), ebayController.platformNotification);

// Admin only: today's eBay API usage.
router.get('/usage', requireAuth, requireAdmin, ebayController.usage);

module.exports = router;
