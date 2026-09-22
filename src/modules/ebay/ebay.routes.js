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

// Public — eBay's Notification API (REST push: new orders). GET is its
// endpoint-ownership challenge; POST is verified by X-EBAY-SIGNATURE
// (the raw body is kept for that by the JSON parser, see app.js).
router.get('/commerce-notifications', ebayController.commerceNotificationChallenge);
router.post('/commerce-notifications', ebayController.commerceNotification);

// Admin only: today's eBay API usage.
router.get('/usage', requireAuth, requireAdmin, ebayController.usage);

module.exports = router;
