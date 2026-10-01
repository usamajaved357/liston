const express = require('express');
const filesController = require('./files.controller');
const { MAX_BYTES } = require('./files.service');

// /api/files: uploads for the Inbox (signed in; the JSON parser skips this
// route so the body arrives as raw bytes, up to 25 MB).
const router = express.Router();

router.post('/', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), filesController.upload);
router.get('/:id', filesController.get);

module.exports = router;
