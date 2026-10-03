const express = require('express');
const invitesController = require('./invites.controller');

// The page an invitation link opens: anyone holding the link, signed in or
// not (accepting checks who they are: invites.service accept).
const router = express.Router();

router.get('/:token', invitesController.view);
router.post('/:token/accept', invitesController.accept);

module.exports = router;
