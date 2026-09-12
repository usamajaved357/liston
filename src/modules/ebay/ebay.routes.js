const express = require('express');
const ebayController = require('./ebay.controller');

const router = express.Router();

// Public — eBay itself calls this via browser redirect, not an authenticated
// API client. Authenticity comes from the signed `state` param, not a session.
router.get('/oauth/callback', ebayController.oauthCallback);

module.exports = router;
