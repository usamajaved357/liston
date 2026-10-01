const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireOwner, requireFeature, requireAnyFeature } = require('../../middleware/feature.middleware');
const { KNOWN_FEATURES } = require('../team/team.repository');
const connectionController = require('./connection.controller');
const listingController = require('../listings/listing.controller');

const router = express.Router();

router.get('/', requireAuth, connectionController.list);
router.get('/platforms', requireAuth, connectionController.listPlatforms);
// Creating/removing a whole eBay connection, and its business
// policies/shipping location, are always admin-only — never delegable.
router.post('/ebay/authorize', requireAuth, requireOwner, connectionController.startEbayAuth);
router.get('/:id', requireAuth, requireAnyFeature(KNOWN_FEATURES), connectionController.getOne);
router.post('/:id/reauthorize', requireAuth, requireAnyFeature(KNOWN_FEATURES), connectionController.reauthorizeEbay);
router.delete('/:id', requireAuth, requireOwner, connectionController.remove);
// The eBay sites the account sells on; another one split off as its own connection.
router.get('/:id/sites', requireAuth, requireOwner, connectionController.listSites);
router.post('/:id/sites', requireAuth, requireOwner, connectionController.addSite);
router.get('/:id/listings', requireAuth, requireFeature('listings'), connectionController.getListings);
router.get('/:id/orders', requireAuth, requireFeature('orders'), connectionController.getOrders);
router.use('/:id/orders', require('../orders/order.routes'));
router.get('/:id/earnings', requireAuth, requireFeature('orders'), connectionController.getEarnings);
// The account's Overview money (sales, fees, earnings, source cost, profit) and listing work: owner-only, like the business Overview.
router.get('/:id/overview', requireAuth, requireOwner, require('../overview/overview.controller').getAccountOverview);
// A team member's own Overview there: their work on the account, no money (team.service.getOwnWork).
router.get('/:id/my-work', requireAuth, requireAnyFeature(KNOWN_FEATURES), require('../team/team.controller').getOwnWork);
router.use('/:id/analytics', require('../analytics/analytics.routes'));
// Discover, on the Hunting page: what to hunt (categories, keywords, what's selling, a watchlist).
router.use('/:id/discover', require('../discover/discover.routes'));
// The Inbox's eBay messages for this account (buyers and eBay).
router.use('/:id/inbox', require('../inbox/inbox.routes'));
router.post('/:id/refresh', requireAuth, requireAnyFeature(['listings', 'orders']), connectionController.refresh);
router.get('/:id/events', requireAuth, requireAnyFeature(['listings', 'orders', 'analytics']), connectionController.events);
router.get('/:id/policies', requireAuth, requireOwner, connectionController.getPolicies);
router.put('/:id/policies', requireAuth, requireOwner, connectionController.updatePolicies);
router.post('/:id/locations', requireAuth, requireOwner, connectionController.createLocation);
// Listing settings (target ROI, fees, shipping) drive every sell price, so
// they're owner-only for the same reason policies are — never delegable.
router.put('/:id/pricing', requireAuth, requireOwner, connectionController.updatePricing);
router.put('/:id/template', requireAuth, requireOwner, connectionController.updateTemplate);
// The message Liston sends a buyer once their order is delivered (off until the owner switches it on).
router.get('/:id/messages', requireAuth, requireOwner, connectionController.getMessages);
router.put('/:id/messages', requireAuth, requireOwner, connectionController.updateMessages);
router.get('/:id/template/palette', requireAuth, requireOwner, connectionController.logoPalette);
router.get('/:id/template/source', requireAuth, requireOwner, connectionController.templateSource);
router.post('/:id/template/preview', requireAuth, requireOwner, express.json({ limit: '1mb' }), connectionController.templatePreview);
router.get('/:id/store-reviews', requireAuth, requireOwner, connectionController.storeReviews);
router.get('/:id/store-profile', requireAuth, requireOwner, connectionController.getStoreProfile);
// Category picker data. Anyone who can edit listings can browse categories.
// Product research on the account's eBay site (Browse API; see modules/research).
const researchController = require('../research/research.controller');
router.get('/:id/research', requireAuth, requireFeature('listings'), researchController.search);
router.get('/:id/research/advice', requireAuth, requireFeature('listings'), researchController.advice);
router.post('/:id/research/sold', requireAuth, requireFeature('listings'), researchController.soldCounts);
router.get('/:id/research/budget', requireAuth, requireFeature('listings'), researchController.budget);
router.get('/:id/categories/search', requireAuth, requireFeature('listings'), connectionController.searchCategories);
router.get('/:id/categories/children', requireAuth, requireFeature('listings'), connectionController.categoryChildren);
router.get('/:id/categories/:categoryId', requireAuth, requireFeature('listings'), connectionController.categoryDetail);
router.get('/:id/store-categories', requireAuth, requireFeature('listings'), connectionController.storeCategories);
router.post('/:id/store-categories', requireAuth, requireFeature('listings'), connectionController.addStoreCategory);
router.get('/:id/listings/drafts', requireAuth, requireFeature('listings'), listingController.listDrafts);
router.post('/:id/listings/:itemId/edit', requireAuth, requireFeature('listings'), listingController.startLiveEdit);
router.post('/:id/listings/:itemId/end', requireAuth, requireFeature('listings'), listingController.endLive);
router.delete('/:id/listings/:itemId', requireAuth, requireOwner, listingController.removeInactive);
// Step one of drafting: read both listings so the seller can pick which
// variations to list, before anything is generated or paid for.
router.post('/:id/listings/drafts/preview', requireAuth, requireFeature('listings'), listingController.previewDraft);
router.post('/:id/listings/drafts', requireAuth, requireFeature('listings'), listingController.generateDraft);
// Product hunting (modules/hunting): hunters check and add products,
// reviewers decide, listers draft the approved ones. The service decides
// what each person may do; the badge answers everyone (zeros without access).
const huntingController = require('../hunting/hunting.controller');
const { HUNTING_ACCESS } = require('../hunting/hunting.routes');
router.get('/:id/hunting', requireAuth, requireAnyFeature(HUNTING_ACCESS), huntingController.list);
router.get('/:id/hunting/badge', requireAuth, requireAnyFeature(KNOWN_FEATURES), huntingController.badge);
router.post('/:id/hunting/check', requireAuth, requireAnyFeature(['hunting', 'hunting_review']), huntingController.check);
router.post('/:id/hunting', requireAuth, requireAnyFeature(['hunting', 'hunting_review']), huntingController.add);
router.post('/:id/hunting/from-listing', requireAuth, requireAnyFeature(['hunting', 'hunting_review']), huntingController.huntListing);
// A competitor's dated sales, pasted from eBay's purchase history page
// (tens of KB of text, well within the app-wide JSON limit).

module.exports = router;
