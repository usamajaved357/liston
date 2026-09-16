const express = require('express');
const { requireAuth, requireAccess } = require('../../middleware/auth.middleware');
const overviewController = require('./overview.controller');

const router = express.Router();
router.get('/', requireAuth, requireAccess, overviewController.getOverview);

module.exports = router;
