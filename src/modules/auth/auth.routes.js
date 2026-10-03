const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth.middleware');
const authController = require('./auth.controller');

const router = express.Router();

router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', requireAuth, authController.resendVerification);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Access approval: one-click links from the admin email (browser GETs), and
// an in-app list/decide for admins.
router.get('/access/approve', authController.accessDecision);
router.get('/access/reject', authController.accessDecision);
router.get('/access/requests', requireAuth, requireAdmin, authController.listAccessRequests);
router.post('/access/requests/:userId', requireAuth, requireAdmin, authController.setAccessStatus);
// Every workspace account, and deleting one with everything in it.
router.get('/access/workspaces', requireAuth, requireAdmin, authController.listWorkspaces);
router.get('/access/workspaces/:userId', requireAuth, requireAdmin, authController.workspaceDetail);
router.delete('/access/accounts/:userId', requireAuth, requireAdmin, authController.deleteAccount);

module.exports = router;
