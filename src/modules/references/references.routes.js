const express = require('express');
const referencesController = require('./references.controller');

// /api/references: Liston cards for the Inbox (signed in; each card checks
// the viewer's access to its account itself).
const router = express.Router();

router.post('/resolve', referencesController.resolve);
router.post('/detect', referencesController.detect);
router.get('/search', referencesController.search);

module.exports = router;
