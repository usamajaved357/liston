const express = require('express');
const ebayController = require('./ebay.controller');

const router = express.Router();

// Public — eBay itself calls this via browser redirect, not an authenticated
// API client. Authenticity comes from the signed `state` param, not a session.
router.get('/oauth/callback', ebayController.oauthCallback);

// Public — eBay's own verification/notification calls, no auth header.
// Authenticity comes from the SHA-256 challenge response / payload shape,
// not a session.
router.get('/account-deletion', ebayController.accountDeletionChallenge);
router.post('/account-deletion', ebayController.accountDeletionNotification);

module.exports = router;
