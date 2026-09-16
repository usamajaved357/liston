const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireOwner } = require('../../middleware/feature.middleware');
const teamController = require('./team.controller');

const router = express.Router();

// Team management is never delegable — every route here is owner-only,
// regardless of any feature a member might otherwise be granted.
router.get('/members', requireAuth, requireOwner, teamController.listMembers);
router.post('/members', requireAuth, requireOwner, teamController.addMember);
router.delete('/members/:id', requireAuth, requireOwner, teamController.removeMember);
router.put('/members/:id/password', requireAuth, requireOwner, teamController.setMemberPassword);
router.get('/members/:id/permissions', requireAuth, requireOwner, teamController.getMemberPermissions);
router.put('/members/:id/permissions', requireAuth, requireOwner, teamController.updateMemberPermissions);

module.exports = router;
