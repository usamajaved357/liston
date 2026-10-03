const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const userController = require('./user.controller');

const router = express.Router();

router.get('/me', requireAuth, userController.getMe);
// Teams: the one to open next time, and the team an account link belongs to.
router.post('/me/team', requireAuth, userController.switchTeam);
router.get('/me/team-of', requireAuth, userController.teamOfConnection);
router.delete('/me', requireAuth, userController.deleteAccount);
router.patch('/me/email', requireAuth, userController.updateEmail);
router.patch('/me/password', requireAuth, userController.updatePassword);
router.patch('/me/name', requireAuth, userController.updateName);
router.patch('/me/avatar', requireAuth, userController.updateAvatar);
router.delete('/me/avatar', requireAuth, userController.deleteAvatar);

module.exports = router;
