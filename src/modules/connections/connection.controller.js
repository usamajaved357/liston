const { z } = require('zod');
const connectionService = require('./connection.service');
const ebayOauth = require('../ebay/api/ebay.oauth');
const ebayService = require('../ebay/ebay.service');
const logoPalette$ = require('./logo-palette');
const marketplaces = require('../ebay/marketplaces');
const ebayTaxonomy = require('../ebay/api/ebay.taxonomy');
const descriptionTemplate = require('../listings/description-template');
const listingService = require('../listings/listing.service');
const accountEvents = require('../ebay/account-events');

const startEbayAuthSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100),
});

// Re-runs eBay's consent for an EXISTING connection, so the new token (with
// the current scopes — the order ones, for accounts linked before they were
// asked for) replaces the old one in place. Nothing else about the account
// changes: same id, listings, drafts, orders, sourcing.
async function reauthorizeEbay(req, res, next) {
  try {
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    if (connection.platform_key !== 'ebay') return res.status(400).json({ error: 'Only eBay accounts can be reconnected this way.' });
    const returnTo = typeof req.body?.returnTo === 'string' && req.body.returnTo.startsWith('/') ? req.body.returnTo.slice(0, 300) : `/accounts/${connection.id}`;
    const state = ebayOauth.signState({ userId: req.ownerId, label: connection.label, connectionId: connection.id, returnTo });
    res.status(200).json({ authorizeUrl: ebayOauth.buildAuthorizeUrl(state) });
  } catch (err) {
    next(err);
  }
}

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
        push: ebayService.pushEnabled(connection),
      });
    });

    res.status(200).json({
      items: result.items,
      totalEntries: result.totalEntries,
      totalPages: result.totalPages,
      page: result.page,
      perPage: result.perPage,
      allCount: result.allCount,
      syncedAt: result.syncedAt ? new Date(result.syncedAt).toISOString() : null,
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
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    const archivedOrderIds = await require('../orders/order.service').archivedOrderIds(req.params.id).catch(() => []);

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Orders aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.listOrdersDetailed(credentials, { connectionId: req.params.id, range, status, search, page, perPage, push: ebayService.pushEnabled(connection), archivedOrderIds, archived });
    });

    // Each row's supplier-order state, so the list can show it and take a
    // tracking number without opening the order.
    const sourcingByOrder = await require('../orders/order.service')
      .sourcingForOrders(req.params.id, result.orders.map((o) => o.orderId))
      .catch(() => ({}));

    res.status(200).json({
      orders: result.orders.map((o) => ({ ...o, sourcing: sourcingByOrder[o.orderId] || [] })),
      counts: result.counts,
      totalEntries: result.totalEntries,
      totalPages: result.totalPages,
      page: result.page,
      perPage: result.perPage,
      syncedAt: result.syncedAt ? new Date(result.syncedAt).toISOString() : null,
      archivedCount: archivedOrderIds.length,
    });
  } catch (err) {
    next(err);
  }
}

// "I just changed something in Seller Hub": re-read the account from eBay
// now. Once a minute per account, since every press spends Trading calls.
async function refresh(req, res, next) {
  try {
    await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Refresh isn't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.refreshAccount(credentials, req.params.id);
    });
    res.status(200).json({ syncedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

// A live stream of "this account's data changed" events (server-sent
// events), one per open page. The page re-fetches what it shows when one
// arrives, so a sale, a publish, or an edit in Seller Hub appears without
// a reload. Heartbeats keep proxies from closing an idle stream.
const SSE_HEARTBEAT_MS = 25 * 1000;

async function events(req, res, next) {
  try {
    // Authorisation already ran (requireAuth + feature guard); just confirm
    // the account exists for this owner.
    await connectionService.getConnectionSummary(req.params.id, req.ownerId);
  } catch (err) {
    return next(err);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const unsubscribe = accountEvents.subscribe(req.params.id, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function getEarnings(req, res, next) {
  try {
    const range = EARNINGS_RANGES.includes(req.query.range) ? req.query.range : 'today';
    const { from, to } = req.query;

    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Earnings aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getEarningsSummary(credentials, { connectionId: req.params.id, range, from, to, push: ebayService.pushEnabled(connection) });
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
  fontFamily: z.enum(descriptionTemplate.FONTS.map((f) => f.id)).default('modern'),
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
    .max(10)
    .default([]),
  // The seller's own layout, or empty for Liston's. eBay's description
  // limit is 500,000 characters; scripts and iframes are refused by eBay
  // itself, but there's no reason to store them either.
  customHtml: z
    .string()
    .max(200000, 'Template code is limited to 200,000 characters')
    .refine((html) => !/<\s*(script|iframe|object|embed)\b/i.test(html), 'eBay does not allow scripts, iframes or embeds in descriptions')
    .default(''),
});

const SAMPLE_PRODUCT = {
  productName: 'Sample Product Title — This Is How Your Listing Will Look',
  description:
    'This is where the drafted description goes.\n\nFEATURES\n- Durable, well made and ready to ship\n- Exactly what buyers searched for\n- Packed with care\n\nSPECIFICATIONS\n- Colour: Black\n- Material: Steel',
  condition: 'NEW',
};

// The built-in layout as editable HTML with {{placeholders}}.
async function templateSource(req, res, next) {
  try {
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    const html = descriptionTemplate.renderTemplateSource({
      template: connection.settings?.template || {},
      marketplaceId: connection.settings?.ebay?.marketplaceId,
    });
    res.status(200).json({ html, placeholders: descriptionTemplate.PLACEHOLDERS });
  } catch (err) {
    next(err);
  }
}

// Renders the template as it would publish, with a sample product and the
// account's real live listings, for the Theme tab's preview. Takes the
// unsaved template in the body so edits preview before Save.
async function templatePreview(req, res, next) {
  try {
    const parsed = updateTemplateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const html = await listingService.renderTemplatePreview(req.params.id, req.ownerId, parsed.data, SAMPLE_PRODUCT);
    res.status(200).json({ html });
  } catch (err) {
    next(err);
  }
}

// The best five positive reviews buyers left this seller on eBay.
async function storeReviews(req, res, next) {
  try {
    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Reviews aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getBestReviews(credentials, req.params.id, { refresh: req.query.refresh === '1' });
    });
    res.status(200).json({ reviews: result.reviews });
  } catch (err) {
    if (err.statusCode === 429) return res.status(200).json({ reviews: [], unavailable: err.message });
    next(err);
  }
}

// What eBay knows about this store — name, logo, feedback — so the
// template can be filled from the source of truth instead of typed.
async function getStoreProfile(req, res, next) {
  try {
    const profile = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials, connection) => {
      if (connection.platform_key !== 'ebay') {
        throw new connectionService.ConnectionError(`Store profiles aren't available for ${connection.platform_name} yet`, 400);
      }
      return ebayService.getStoreProfile(credentials, req.params.id, { refresh: req.query.refresh === '1' });
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
      const profile = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials) => ebayService.getStoreProfile(credentials, req.params.id));
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

// ---- Categories, for the listing editor's picker ----
// All read from eBay's own tree for the account's marketplace, so the picker
// offers exactly the categories this seller can list in.
async function marketplaceOf(req) {
  const ensured = await connectionService.ensureMarketplace(req.params.id, req.ownerId, ebayService);
  return ensured.settings?.ebay?.marketplaceId || marketplaces.DEFAULT_ID;
}

async function searchCategories(req, res, next) {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.status(200).json({ results: [] });
    const marketplaceId = await marketplaceOf(req);
    res.status(200).json({ results: await ebayTaxonomy.searchCategories(marketplaceId, q) });
  } catch (err) {
    next(err);
  }
}

async function categoryChildren(req, res, next) {
  try {
    const marketplaceId = await marketplaceOf(req);
    const parent = typeof req.query.parent === 'string' && req.query.parent ? req.query.parent : null;
    const [children, path] = await Promise.all([
      ebayTaxonomy.getCategoryChildren(marketplaceId, parent),
      parent ? ebayTaxonomy.getCategoryPath(marketplaceId, parent) : [],
    ]);
    res.status(200).json({ children, path });
  } catch (err) {
    next(err);
  }
}

async function categoryDetail(req, res, next) {
  try {
    const marketplaceId = await marketplaceOf(req);
    const categoryId = String(req.params.categoryId);
    const [path, variationsSupported, aspects] = await Promise.all([
      ebayTaxonomy.getCategoryPath(marketplaceId, categoryId),
      ebayTaxonomy.getVariationsSupported(marketplaceId, categoryId),
      ebayTaxonomy.getEditorAspectSchema(marketplaceId, categoryId),
    ]);
    if (!path.length) return res.status(404).json({ error: 'That category is not in eBay\'s tree for this marketplace.' });
    res.status(200).json({ id: categoryId, path, variationsSupported, aspects: aspects || [] });
  } catch (err) {
    next(err);
  }
}

function storeCategoriesResponse(result) {
  return {
    categories: result.categories,
    hasStore: result.hasStore ?? null,
    ...(result.unavailable ? { unavailable: result.unavailable } : {}),
    ...(result.created ? { created: result.created } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

async function storeCategories(req, res, next) {
  try {
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    if (connection.platform_key !== 'ebay') return res.status(200).json({ categories: [], hasStore: false });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials) =>
      ebayService.getStoreCategoriesCached(credentials, req.params.id, { refresh })
    );
    res.status(200).json(storeCategoriesResponse(result));
  } catch (err) {
    next(err);
  }
}

const addStoreCategorySchema = z.object({
  name: z.string().trim().min(1, 'Give the department a name').max(35, 'eBay allows up to 35 characters'),
  parentId: z.string().trim().min(1).optional(),
});

async function addStoreCategory(req, res, next) {
  try {
    const parsed = addStoreCategorySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid department' });
    const connection = await connectionService.getConnectionSummary(req.params.id, req.ownerId);
    if (connection.platform_key !== 'ebay') return res.status(400).json({ error: 'Only eBay accounts have Shop departments.' });
    const result = await connectionService.withDecryptedCredentials(req.params.id, req.ownerId, (credentials) =>
      ebayService.addStoreCategory(credentials, req.params.id, parsed.data)
    );
    res.status(201).json(storeCategoriesResponse(result));
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
  reauthorizeEbay,
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
  templateSource,
  templatePreview,
  storeReviews,
  refresh,
  events,
  searchCategories,
  categoryChildren,
  categoryDetail,
  storeCategories,
  addStoreCategory,
};
