const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const orderController = require('./order.controller');

// Mounted under /api/connections/:id — one order's detail and its sourcing.
const router = express.Router({ mergeParams: true });

router.get('/:orderId', requireAuth, requireFeature('orders'), orderController.getOrder);
router.put('/:orderId/sourcing/:lineKey', requireAuth, requireFeature('orders'), orderController.saveSourcing);
router.post('/:orderId/notes', requireAuth, requireFeature('orders'), orderController.addNote);

module.exports = router;
