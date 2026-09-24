const overviewService = require('./overview.service');

async function getOverview(req, res, next) {
  try {
    const range = typeof req.query.range === 'string' ? req.query.range : 'today';
    // The owner's dashboard counts "Today" in the viewer's own time zone.
    const timeZone = require('../analytics/analytics-days').validTimeZone(req.query.tz);
    const overview = await overviewService.getOverview(req.ownerId, { role: req.role, userId: req.userId }, { range, timeZone });
    res.status(200).json(overview);
  } catch (err) {
    next(err);
  }
}

// One account's money and listing work (its own Overview page).
async function getAccountOverview(req, res, next) {
  try {
    const range = typeof req.query.range === 'string' ? req.query.range : 'today';
    res.status(200).json(await overviewService.getAccountOverview(req.ownerId, req.params.id, { range }));
  } catch (err) {
    next(err);
  }
}

module.exports = { getOverview, getAccountOverview };
