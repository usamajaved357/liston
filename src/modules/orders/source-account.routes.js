const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const orderController = require('./order.controller');

// The team's supplier buying accounts: shared by every member, per owner.
const router = express.Router();

router.get('/', requireAuth, orderController.listSourceAccounts);
router.post('/', requireAuth, orderController.createSourceAccount);
router.patch('/:accountId', requireAuth, orderController.updateSourceAccount);

module.exports = router;
