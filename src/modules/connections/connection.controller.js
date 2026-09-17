const { z } = require('zod');
const connectionService = require('./connection.service');
const ebayOauth = require('../ebay/ebay.oauth');
const ebayService = require('../ebay/ebay.service');
const logoPalette$ = require('./logo-palette');
const marketplaces = require('../ebay/marketplaces');

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
    await connectionService.assertUnderPlanLimit(req.ownerId);

    const state = ebayOauth.signState({ userId: req.ownerId, label: parsed.data.label });
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
    let { connections, maxConnections } = await connectionService.listConnections(req.ownerId, {
      role: req.role,
      userId: req.userId,
    });
    // An eBay account connected before marketplaces existed has no tag yet;
    // detect it now so the list is right from the first visit. One GetUser
    // per untagged account, never repeated once saved.
    const untagged = connections.filter((c) => c.platform_key === 'ebay' && !c.marketplace);
    if (untagged.length && req.role === 'owner') {
      await Promise.all(untagged.map((c) => connectionService.ensureMarketplace(c.id, req.ownerId, ebayService).catch(() => null)));
      ({ connections } = await connectionService.listConnections(req.ownerId, { role: req.role, userId: req.userId }));
    }
    res.status(200).json({ connections, maxConnections });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId, {
      role: req.role,
      userId: req.userId,
    });
    res.status(200).json({ connection });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await connectionService.deleteConnection(req.params.id, req.ownerId);
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
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // perPage=all puts everything on one page.
    const perPage = req.query.perPage === 'all' ? 0 : Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 25));
    const search = typeof req.query.q === 'string' ? req.query.q : '';

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Listings aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.listListingsDetailed(credentials, {
        connectionId: req.params.id,
        status,
        search,
        page,
        perPage,
        hiddenItemIds: status === 'inactive' ? connection.settings?.hiddenItemIds || [] : [],
      });
    });

    res.status(200).json({
      items: result.items,
      totalEntries: result.totalEntries,
      totalPages: result.totalPages,
      page: result.page,
      perPage: result.perPage,
      allCount: result.allCount,
    });
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

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
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

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Earnings aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getEarningsSummary(credentials, { connectionId: req.params.id, range, from, to });
    });

    res.status(200).json({ earnings: result.earnings, orderCount: result.orderCount, truncated: result.truncated });
  } catch (err) {
    next(err);
  }
}

const updatePoliciesSchema = z.object({
  marketplaceId: z.string().min(1).default('EBAY_GB'),
  fulfillmentPolicyId: z.string().min(1),
  paymentPolicyId: z.string().min(1),
  returnPolicyId: z.string().min(1),
  merchantLocationKey: z.string().min(1).optional(),
});

// Listing settings: the numbers every sell price is derived from. Bounds are
// there to stop a typo producing silently broken prices — a 1200% ads fee, or
// a target ROI of 6000% because a decimal moved.
const updatePricingSchema = z.object({
  targetRoiPercent: z.coerce.number().min(0, 'Target ROI cannot be negative').max(1000, 'Target ROI looks too high'),
  adsFeePercent: z.coerce.number().min(0).max(100, 'Ads fee must be a percentage'),
  processingFeePercent: z.coerce.number().min(0).max(100, 'Processing fee must be a percentage'),
  fixedFeePerOrder: z.coerce.number().min(0).max(100),
  shippingCostPerOrder: z.coerce.number().min(0).max(10000),
  currency: z.string().min(3).max(3).default('GBP'),
  roundTo99: z.boolean().default(true),
  followCompetitorPrice: z.boolean().default(true),
});

async function getPolicies(req, res, next) {
  try {
    // The marketplace is the account's own, detected from eBay, never a
    // query default: a US seller's policies only exist on EBAY_US.
    const ensured = await connectionService.ensureMarketplace(req.params.id, req.ownerId, ebayService);
    if (ensured.platform_key !== 'ebay') {
      throw new connectionService.ConnectionError(`Policies aren't available for ${ensured.platform_name} yet`, 400);
    }
    const marketplaceId = ensured.settings?.ebay?.marketplaceId || marketplaces.DEFAULT_ID;

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, async (credentials) => {
      const [policies, locations, detected] = await Promise.all([
        ebayService.getBusinessPolicies(credentials, marketplaceId),
        ebayService.getMerchantLocations(credentials),
        // The registration address is what "Create from my eBay address" offers.
        ebayService.detectMarketplace(credentials).catch(() => null),
      ]);
      const refreshed = locations.credentialsChanged ? locations : policies;
      return { policies, locations, detected, credentialsChanged: refreshed.credentialsChanged, credentials: refreshed.credentials };
    });

    res.status(200).json({
      marketplace: marketplaces.summary(marketplaceId),
      fulfillmentPolicies: result.policies.fulfillmentPolicies,
      paymentPolicies: result.policies.paymentPolicies,
      returnPolicies: result.policies.returnPolicies,
      merchantLocations: result.locations.locations.map((l) => ({
        merchantLocationKey: l.merchantLocationKey,
        name: l.name || l.merchantLocationKey,
        status: l.merchantLocationStatus || null,
        address: l.location?.address || null,
      })),
      registrationAddress: result.detected?.profile?.registrationAddress || null,
    });
  } catch (err) {
    next(err);
  }
}

const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional().default(''),
  city: z.string().trim().min(1).max(100),
  stateOrProvince: z.string().trim().max(100).optional().default(''),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().length(2),
  phone: z.string().trim().max(30).optional().default(''),
});

// Creates the Inventory API location an offer ships from, from the address
// the seller confirms in Settings (prefilled with their eBay registration
// address). Saves it as the connection's shipping location straight away.
async function createLocation(req, res, next) {
  try {
    const parsed = createLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    if (connection.platform_key !== 'ebay') {
      throw new connectionService.ConnectionError(`Locations aren't available for ${connection.platform_name} yet`, 400);
    }
    const base = String(connection.label || 'LISTON')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 20) || 'LISTON';
    const merchantLocationKey = `${base}-${Date.now().toString(36).toUpperCase()}`;
    const { name, ...address } = parsed.data;

    await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials) =>
      ebayService.createMerchantLocation(credentials, { merchantLocationKey, name, address: { ...address, country: address.country.toUpperCase() } })
    );
    const settings = await connectionService.updateConnectionSettings(req.params.id, req.ownerId, {
      ebay: { ...(connection.settings?.ebay || {}), merchantLocationKey },
    });
    res.status(201).json({ merchantLocationKey, settings });
  } catch (err) {
    next(err);
  }
}

async function updatePolicies(req, res, next) {
  try {
    const parsed = updatePoliciesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    if (connection.platform_key !== 'ebay') {
      throw new connectionService.ConnectionError(`Policies aren't available for ${connection.platform_name} yet`, 400);
    }

    const settings = await connectionService.updateConnectionSettings(req.params.id, req.ownerId, {
      ebay: { ...parsed.data, marketplaceId: connection.settings?.ebay?.marketplaceId || parsed.data.marketplaceId },
    });
    res.status(200).json({ settings });
  } catch (err) {
    next(err);
  }
}

// The store's description template — the branding, delivery and returns
// copy that wraps every listing this account publishes.
const updateTemplateSchema = z.object({
  storeName: z.string().max(60).default(''),
  tagline: z.string().max(60).default('Official UK Store'),
  logoUrl: z.string().url().or(z.literal('')).default(''),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #FF6B2B').default('#FF6B2B'),
  darkColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1E1E2E').default('#1E1E2E'),
  feedbackPercent: z.string().max(6).default(''),
  dispatchTime: z.string().max(40).default('1–2 Business Days'),
  dispatchNote: z.string().max(60).default('From our UK warehouse'),
  carrier: z.string().max(40).default('Royal Mail / Evri'),
  deliveryTime: z.string().max(40).default('2–4 Business Days'),
  freePostage: z.boolean().default(true),
  returnsDays: z.coerce.number().int().min(0).max(365).default(30),
  recommendedCount: z.coerce.number().int().min(0).max(24).default(12),
  responseTime: z.string().max(30).default('24 hours'),
  reviews: z
    .array(z.object({ stars: z.coerce.number().min(1).max(5).default(5), text: z.string().max(400), buyer: z.string().max(60).default(''), date: z.string().max(30).default('') }))
    .max(3)
    .default([]),
});

// What eBay knows about this store — name, logo, feedback — so the
// template can be filled from the source of truth instead of typed.
async function getStoreProfile(req, res, next) {
  try {
    const profile = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Store profiles aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getStoreProfile(credentials);
    });
    const { credentials, credentialsChanged, ...safe } = profile;
    res.status(200).json(safe);
  } catch (err) {
    next(err);
  }
}

// Colour suggestions for the description template, read from the store's
// logo (the saved one, or the eBay store logo when none is set).
async function logoPalette(req, res, next) {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    let logoUrl = url;
    if (!logoUrl) {
      const profile = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials) => ebayService.getStoreProfile(credentials));
      logoUrl = profile.logoUrl || '';
    }
    if (!/^https?:\/\//i.test(logoUrl)) {
      return res.status(400).json({ error: 'No logo to read colours from. Add a logo URL first.' });
    }
    const result = await logoPalette$.palettesFromLogo(logoUrl);
    res.status(200).json({ logoUrl, ...result });
  } catch (err) {
    next(Object.assign(new Error("Couldn't read colours from that logo."), { statusCode: 400, cause: err }));
  }
}

async function updateTemplate(req, res, next) {
  try {
    const parsed = updateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const settings = await connectionService.updateConnectionSettings(req.params.id, req.ownerId, { template: parsed.data });
    res.status(200).json({ settings });
  } catch (err) {
    next(err);
  }
}

async function updatePricing(req, res, next) {
  try {
    const parsed = updatePricingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // Fees that add up to the whole sale price make every price impossible —
    // caught here so the seller finds out on the settings page, not on their
    // next draft.
    if (parsed.data.adsFeePercent + parsed.data.processingFeePercent >= 100) {
      return res
        .status(400)
        .json({ error: 'Ads and processing fees add up to 100% or more of the sale price — no price could be profitable.' });
    }

    const settings = await connectionService.updateConnectionSettings(req.params.id, req.ownerId, {
      pricing: parsed.data,
    });
    res.status(200).json({ settings });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  listPlatforms,
  getOne,
  remove,
  startEbayAuth,
  getListings,
  getOrders,
  getEarnings,
  getPolicies,
  createLocation,
  updatePolicies,
  updatePricing,
  updateTemplate,
  logoPalette,
  getStoreProfile,
};
