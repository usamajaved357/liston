const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireFeature } = require('../../middleware/feature.middleware');
const c = require('./inbox.controller');

// Mounted under /api/connections/:id/inbox — one account's eBay messages (Inbox access).
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireFeature('inbox'), c.list);
router.post('/refresh', requireAuth, requireFeature('inbox'), c.refresh);
router.get('/unread', requireAuth, requireFeature('inbox'), c.unread);
// Quick replies: everyone with the Inbox reads them; only the owner changes them (the service checks).
router.get('/quick-replies', requireAuth, requireFeature('inbox'), c.quickReplies);
router.post('/quick-replies', requireAuth, requireFeature('inbox'), c.addQuickReply);
router.put('/quick-replies/:replyId', requireAuth, requireFeature('inbox'), c.saveQuickReply);
router.delete('/quick-replies/:replyId', requireAuth, requireFeature('inbox'), c.deleteQuickReply);
// "Message buyer" from an order page: a real message, sent when someone presses Send.
router.post('/message-buyer', requireAuth, requireFeature('inbox'), c.messageBuyer);
router.get('/:conversationId', requireAuth, requireFeature('inbox'), c.thread);
router.post('/:conversationId/read', requireAuth, requireFeature('inbox'), c.setRead);
router.post('/:conversationId/status', requireAuth, requireFeature('inbox'), c.setStatus);
// The team's working: who has it, where it stands, notes only the team sees.
router.post('/:conversationId/assign', requireAuth, requireFeature('inbox'), c.assign);
router.post('/:conversationId/work', requireAuth, requireFeature('inbox'), c.setWork);
router.post('/:conversationId/notes', requireAuth, requireFeature('inbox'), c.addNote);
router.delete('/:conversationId/notes/:noteId', requireAuth, requireFeature('inbox'), c.deleteNote);
// A reply to a buyer: a real message, sent when someone presses Send.
router.post('/:conversationId/messages', requireAuth, requireFeature('inbox'), c.reply);

module.exports = router;
