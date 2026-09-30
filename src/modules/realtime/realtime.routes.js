const express = require('express');
const realtimeController = require('./realtime.controller');

// /api/me: the signed-in person's live channel (behind requireAuth + requireAccess in app.js).
const router = express.Router();

router.get('/events', realtimeController.events);
router.post('/presence', realtimeController.presence);

module.exports = router;
