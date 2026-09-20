const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const orderController = require('./order.controller');

// Mounted under /api/connections/:id — one order's detail and its sourcing.
const router = express.Router({ mergeParams: true });

router.get('/:orderId', requireAuth, requireFeature('orders'), orderController.getOrder);
router.put('/:orderId/sourcing/:lineKey', requireAuth, requireFeature('orders'), orderController.saveSourcing);
router.post('/:orderId/notes', requireAuth, requireFeature('orders'), orderController.addNote);
// Seller Hub's "More actions", done from here.
router.post('/:orderId/dispatch', requireAuth, requireFeature('orders'), orderController.dispatchOrder);
router.post('/:orderId/refund', requireAuth, requireFeature('orders'), orderController.refundOrder);
router.post('/:orderId/cancel', requireAuth, requireFeature('orders'), orderController.cancelOrder);
router.post('/:orderId/archive', requireAuth, requireFeature('orders'), orderController.setArchived);
router.get('/:orderId/cases', requireAuth, requireFeature('orders'), orderController.getCases);
router.post('/:orderId/cancel/decline', requireAuth, requireFeature('orders'), orderController.declineCancellation);
router.post('/:orderId/returns', requireAuth, requireFeature('orders'), orderController.respondToReturn);
router.post('/:orderId/inquiries', requireAuth, requireFeature('orders'), orderController.respondToInquiry);
router.post('/:orderId/disputes', requireAuth, requireFeature('orders'), orderController.respondToDispute);

module.exports = router;
