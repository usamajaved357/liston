const exportsService = require('./exports.service');
const { ordersQuery, listingsQuery, selectedIds } = require('../connections/list-queries');

// The Orders and Listings pages' "Download CSV": the page's own filters (and
// ticked rows, `ids`) in the query string, a CSV file back.

function sendCsv(res, { filename, csv, count }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Liston-Rows', String(count));
  res.status(200).send(csv);
}

async function orders(req, res, next) {
  try {
    sendCsv(res, await exportsService.ordersCsv(req.ownerId, req.params.id, ordersQuery(req.query), selectedIds(req.query)));
  } catch (err) {
    next(err);
  }
}

async function listings(req, res, next) {
  try {
    sendCsv(res, await exportsService.listingsCsv(req.ownerId, req.params.id, listingsQuery(req.query), selectedIds(req.query)));
  } catch (err) {
    next(err);
  }
}

module.exports = { orders, listings };
