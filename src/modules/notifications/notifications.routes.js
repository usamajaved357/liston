const express = require('express');
const notificationsController = require('./notifications.controller');

// /api/notifications: a person's own notifications (signed in, per person).
const router = express.Router();

router.get('/', notificationsController.list);
router.post('/read', notificationsController.read);
router.post('/test', notificationsController.test);
router.post('/clear', notificationsController.clear);
router.post('/push', notificationsController.subscribe);
router.delete('/push', notificationsController.unsubscribe);

module.exports = router;
