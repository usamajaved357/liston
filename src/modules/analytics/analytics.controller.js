const { z } = require('zod');
const analyticsService = require('./analytics.service');
const { RANGES } = require('./analytics-days');

const rangeSchema = z.object({ range: z.enum(RANGES).default('30d') });
const itemSchema = z.object({ itemId: z.string().regex(/^\d{6,20}$/, 'Not an eBay item number') });

function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const err = new Error(parsed.error.issues[0]?.message || 'Invalid request');
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }
  return parsed.data;
}

async function getAnalytics(req, res, next) {
  try {
    const { range } = parse(rangeSchema, req.query);
    const result = await analyticsService.getAnalytics(req.params.id, req.ownerId, { range });
    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
}

async function refreshToday(req, res, next) {
  try {
    const { refreshesLeft } = await analyticsService.refreshToday(req.params.id, req.ownerId);
    res.status(200).json({ refreshesLeft });
  } catch (err) {
    next(err);
  }
}

async function loadAllListings(req, res, next) {
  try {
    const { range } = parse(rangeSchema, req.query);
    const result = await analyticsService.loadAllListings(req.params.id, req.ownerId, { range });
    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
}

async function getListingAnalytics(req, res, next) {
  try {
    const { range } = parse(rangeSchema, req.query);
    const { itemId } = parse(itemSchema, req.params);
    const result = await analyticsService.getListingAnalytics(req.params.id, req.ownerId, itemId, { range });
    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
}

async function getListingSummaries(req, res, next) {
  try {
    const result = await analyticsService.getListingSummaries(req.params.id, req.ownerId);
    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
}

module.exports = { getAnalytics, refreshToday, loadAllListings, getListingAnalytics, getListingSummaries };
