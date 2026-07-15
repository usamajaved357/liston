const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const userController = require('./user.controller');

const router = express.Router();

router.get('/me', requireAuth, userController.getMe);
router.delete('/me', requireAuth, userController.deleteAccount);
router.patch('/me/email', requireAuth, userController.updateEmail);
router.patch('/me/password', requireAuth, userController.updatePassword);

module.exports = router;
