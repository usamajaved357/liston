const filesService = require('./files.service');

// Uploading a file (the raw bytes as the body, its name in X-File-Name) and
// reading one back before it's sent; the bytes themselves come from /media.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const auth = (req) => ({ userId: req.userId, ownerId: req.ownerId, role: req.role });

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

function headerName(req) {
  try {
    return decodeURIComponent(String(req.get('X-File-Name') || ''));
  } catch {
    return String(req.get('X-File-Name') || '');
  }
}

module.exports = {
  upload: handle(async (req, res) => {
    const purpose = req.query.purpose === 'ebay' ? 'ebay' : 'chat';
    const file = await filesService.upload(auth(req), { buffer: req.body, name: headerName(req), mime: req.get('Content-Type'), purpose });
    res.status(201).json(file);
  }),
  get: handle(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'File not found.' });
    res.json(await filesService.get(auth(req), req.params.id));
  }),
};
