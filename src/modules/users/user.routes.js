const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const userController = require('./user.controller');

const router = express.Router();

router.get('/me', requireAuth, userController.getMe);

module.exports = router;
