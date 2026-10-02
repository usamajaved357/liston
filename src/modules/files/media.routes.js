const express = require('express');
const filesRepository = require('./files.repository');
const filesService = require('./files.service');

// /media: the bytes of shared files, no sign-in (an <img> can't send one).
//   /media/f/:id/:variant?exp=&sig=  a private file, by a signed link that runs out
//   /media/p/:token/:name            an eBay attachment, by its unguessable token (30 days)
const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/f/:id/:variant', async (req, res, next) => {
  try {
    const { id, variant } = req.params;
    if (!UUID.test(id) || !['full', 'thumb'].includes(variant) || !filesService.verify(id, variant, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'This link has run out. Open it again from Liston.' });
    }
    const file = await filesRepository.findById(id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    await filesService.send(res, file, variant, { range: req.headers.range });
  } catch (err) {
    next(err);
  }
});

router.get('/p/:token/:name?', async (req, res, next) => {
  try {
    const file = /^[A-Za-z0-9_-]{20,64}$/.test(req.params.token) ? await filesRepository.findByPublicToken(req.params.token) : null;
    if (!file) return res.status(404).json({ error: 'Not found' });
    await filesService.send(res, file, 'full');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
