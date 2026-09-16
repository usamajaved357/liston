const overviewService = require('./overview.service');

async function getOverview(req, res, next) {
  try {
    const range = typeof req.query.range === 'string' ? req.query.range : '30d';
    const overview = await overviewService.getOverview(req.ownerId, { role: req.role, userId: req.userId }, { range });
    res.status(200).json(overview);
  } catch (err) {
    next(err);
  }
}

module.exports = { getOverview };
