const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireOwner, requireMainOwner } = require('../../middleware/feature.middleware');
const teamController = require('./team.controller');

const router = express.Router();

// Anyone signed in: a minute of their own time in Liston (only members' is kept; the service decides).
router.post('/clock', requireAuth, teamController.clock);

// Team management is never delegable by feature: every route here is the
// owner's, or a member's the owner gave owner access (who may change the
// rest of the team, never their own login or another with owner access:
// team.service manageable). Owner access itself is the owner's alone.
router.get('/members', requireAuth, requireOwner, teamController.listMembers);
router.post('/members', requireAuth, requireOwner, teamController.addMember);
router.delete('/members/:id', requireAuth, requireOwner, teamController.removeMember);
router.post('/members/:id/restore', requireAuth, requireOwner, teamController.restoreMember);
router.get('/members/:id/overview', requireAuth, requireOwner, teamController.getMemberOverview);
router.get('/members/:id/activity', requireAuth, requireOwner, teamController.getMemberActivity);
router.get('/members/:id/time', requireAuth, requireOwner, teamController.getMemberTime);
router.put('/members/:id/password', requireAuth, requireOwner, teamController.setMemberPassword);
router.get('/members/:id/permissions', requireAuth, requireOwner, teamController.getMemberPermissions);
router.put('/members/:id/permissions', requireAuth, requireOwner, teamController.updateMemberPermissions);
router.put('/members/:id/owner-access', requireAuth, requireMainOwner, teamController.setOwnerAccess);
// The workspace's name, and deleting it: its owner only.
router.put('/name', requireAuth, requireMainOwner, teamController.renameTeam);
router.delete('/workspace', requireAuth, requireMainOwner, teamController.deleteWorkspace);

module.exports = router;
