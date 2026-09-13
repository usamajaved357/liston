const { z } = require('zod');
const connectionService = require('./connection.service');
const ebayOauth = require('../ebay/ebay.oauth');
const ebayService = require('../ebay/ebay.service');

const startEbayAuthSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100),
});

async function startEbayAuth(req, res, next) {
  try {
    const parsed = startEbayAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // Fail fast on plan limit before sending the user through eBay's consent
    // screen — nothing worse than a "connection added" surprise 403 after.
    await connectionService.assertUnderPlanLimit(req.userId);

    const state = ebayOauth.signState({ userId: req.userId, label: parsed.data.label });
    const authorizeUrl = ebayOauth.buildAuthorizeUrl(state);
    res.status(200).json({ authorizeUrl });
  } catch (err) {
    next(err);
  }
}

async function listPlatforms(req, res, next) {
  try {
    const platforms = await connectionService.listPlatforms();
    res.status(200).json({ platforms });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { connections, maxConnections } = await connectionService.listConnections(req.userId);
    res.status(200).json({ connections, maxConnections });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const connection = await connectionService.getConnectionSummary(req.params.id, req.userId);
    res.status(200).json({ connection });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await connectionService.deleteConnection(req.params.id, req.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

const LIST_ORDER_RANGES = ['7d', '30d', '90d'];
const ORDER_STATUS_FILTERS = ['all', 'awaiting_payment', 'awaiting_dispatch', 'dispatched', 'cancelled'];
const ORDER_PAGE_SIZES = [25, 50, 100, 200];
const EARNINGS_RANGES = ['today', '7d', '30d', '90d', 'this_month', 'last_month', 'custom', 'all_time'];

async function getListings(req, res, next) {
  try {
    const status = req.query.status === 'inactive' ? 'inactive' : 'active';
    const pageNumber = Math.max(1, parseInt(req.query.page, 10) || 1);

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.userId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Listings aren't available for ${connection.platform_name} yet`, 400);
      }
      return status === 'active'
        ? ebayService.listActiveListings(credentials, { pageNumber, entriesPerPage: 25 })
        : ebayService.listUnsoldListings(credentials, { pageNumber, entriesPerPage: 25 });
    });

    res.status(200).json({ items: result.items, totalEntries: result.totalEntries, totalPages: result.totalPages });
  } catch (err) {
    next(err);
  }
}

async function getOrders(req, res, next) {
  try {
    const range = LIST_ORDER_RANGES.includes(req.query.range) ? req.query.range : '90d';
    const status = ORDER_STATUS_FILTERS.includes(req.query.status) ? req.query.status : 'all';
    const perPage = ORDER_PAGE_SIZES.includes(Number(req.query.perPage)) ? Number(req.query.perPage) : 25;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.userId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Orders aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.listOrdersDetailed(credentials, { connectionId: req.params.id, range, status, search, page, perPage });
    });

    res.status(200).json({
      orders: result.orders,
      counts: result.counts,
      totalEntries: result.totalEntries,
      totalPages: result.totalPages,
      page: result.page,
      perPage: result.perPage,
    });
  } catch (err) {
    next(err);
  }
}

async function getEarnings(req, res, next) {
  try {
    const range = EARNINGS_RANGES.includes(req.query.range) ? req.query.range : '7d';
    const { from, to } = req.query;

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.userId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Earnings aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getEarningsSummary(credentials, { range, from, to });
    });

    res.status(200).json({ earnings: result.earnings, orderCount: result.orderCount, truncated: result.truncated });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, listPlatforms, getOne, remove, startEbayAuth, getListings, getOrders, getEarnings };
