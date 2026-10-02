const express = require('express');
const c = require('./chat.controller');

// /api/chat: team chat, across the owner's whole business (signed in, behind
// requireAuth + requireAccess in app.js; every call checks the person is in
// the conversation, and channel changes need the owner or Manage channels).
const router = express.Router();

router.get('/people', c.people);
router.get('/conversations', c.list);
router.get('/unread', c.unread);
router.get('/search', c.search);
router.post('/dm', c.openDm);
router.post('/groups', c.createGroup);
router.post('/channels', c.createChannel);
router.get('/conversations/:id', c.get);
router.patch('/conversations/:id', c.update);
router.delete('/conversations/:id', c.remove);
router.post('/conversations/:id/people', c.addPeople);
router.delete('/conversations/:id/people/:userId', c.removePerson);
router.post('/conversations/:id/join', c.join);
router.put('/conversations/:id/notify', c.setNotify);
router.get('/conversations/:id/messages', c.messages);
router.post('/conversations/:id/messages', c.send);
router.post('/conversations/:id/read', c.read);
router.post('/conversations/:id/typing', c.typing);
router.get('/conversations/:id/threads', c.conversationThreads);
router.get('/conversations/:id/files', c.conversationFiles);
// Threads: the ones this person follows, one thread, reading it, following it.
router.get('/threads', c.threads);
router.get('/threads/:rootId', c.thread);
router.post('/threads/:rootId/read', c.threadRead);
router.put('/threads/:rootId/follow', c.follow);
router.patch('/messages/:id', c.edit);
router.delete('/messages/:id', c.deleteMessage);
router.get('/settings', c.getSettings);
router.put('/settings', c.saveSettings);

module.exports = router;
