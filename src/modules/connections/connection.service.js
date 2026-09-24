const connectionRepository = require('./connection.repository');
const teamRepository = require('../team/team.repository');
const marketplaces = require('../ebay/marketplaces');
const { encrypt, decrypt } = require('./credentials.encryption');

class ConnectionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Credentials are always encrypted before touching the DB — stored as
// { enc: "<base64 ciphertext>" } inside the JSONB column so the column stays
// valid JSON while its contents remain opaque without the encryption key.
function encryptCredentials(plainCredentials) {
  return { enc: encrypt(plainCredentials) };
}

function decryptCredentials(storedCredentials) {
  return decrypt(storedCredentials.enc);
}

// Platforms can be "active" in the DB (available in principle, per plan
// gating) before Liston has actually built a connect flow for them —
// TikTok Shop is active but only eBay has a real OAuth flow wired up so
// far. This keeps the picker from offering a button that goes nowhere.
const PLATFORMS_WITH_CONNECT_FLOW = ['ebay'];

async function listPlatforms() {
  const platforms = await connectionRepository.findAllPlatforms();
  return platforms.map((p) => ({
    ...p,
    connectable: p.status === 'active' && PLATFORMS_WITH_CONNECT_FLOW.includes(p.key),
    // The sites an eBay account can be linked for, one connection each.
    ...(p.key === 'ebay' ? { marketplaces: marketplaces.MARKETPLACES.map((m) => marketplaces.summary(m.id)) } : {}),
  }));
}

// `viewer` (optional: { role, userId }) is the actual authenticated caller —
// distinct from `ownerId`, whose connections are being listed. For a member,
// each connection gets its resolved feature permissions attached and
// connections with zero granted features are dropped entirely (they'd have
// nothing to show a member anyway). Omitted/owner viewer returns everything
// unchanged, matching today's owner-only behavior.
// The marketplace tag every connection carries in the UI. Null until the
// site has been detected (see ensureMarketplace), so nothing is guessed.
function withMarketplace(connection) {
  const id = connection.settings?.ebay?.marketplaceId;
  return { ...connection, marketplace: id ? marketplaces.summary(id) : null };
}

async function listConnections(ownerId, viewer) {
  const [rawConnections, maxConnections] = await Promise.all([
    connectionRepository.findAllByUser(ownerId),
    connectionRepository.getMaxConnectionsForUser(ownerId),
  ]);
  const connections = rawConnections.map(withMarketplace);

  if (!viewer || viewer.role === 'owner') {
    return { connections, maxConnections };
  }

  const withPermissions = await Promise.all(
    connections.map(async (connection) => ({
      ...connection,
      permissions: await teamRepository.getResolvedPermissions(viewer.userId, connection.id),
    }))
  );
  const visible = withPermissions.filter((c) => Object.values(c.permissions).some(Boolean));
  return { connections: visible, maxConnections };
}

// Plan limits are switched off for now: the product is being run for a
// single business with several eBay accounts before billing exists. The
// check stays in place (and the frontend still shows `maxConnections`) so
// it can be re-enabled by flipping ENFORCE_PLAN_LIMITS=true once plans are
// real.
async function assertUnderPlanLimit(userId) {
  if (process.env.ENFORCE_PLAN_LIMITS !== 'true') return;
  const [used, max] = await Promise.all([
    connectionRepository.countByUser(userId),
    connectionRepository.getMaxConnectionsForUser(userId),
  ]);
  if (used >= max) {
    throw new ConnectionError(
      `Your plan allows up to ${max} connection${max === 1 ? '' : 's'}. Remove one or upgrade your plan.`,
      403
    );
  }
}

async function createConnection(userId, { platformKey, label, credentials, settings = null }, { planChecked = false } = {}) {
  if (!planChecked) await assertUnderPlanLimit(userId);

  const platform = await connectionRepository.findPlatformByKey(platformKey);
  if (!platform) {
    throw new ConnectionError('Unknown platform', 400);
  }
  if (platform.status !== 'active') {
    throw new ConnectionError(`${platform.name} isn't available yet`, 400);
  }

  const created = await connectionRepository.create({
    userId,
    destinationPlatformId: platform.id,
    label,
    credentials: encryptCredentials(credentials),
  });
  if (!settings) return created;
  await connectionRepository.updateSettings(created.id, settings);
  return { ...created, settings };
}

// The owner's eBay connections that don't know which seller they are yet
// (linked before sellers were recorded), told now, so a second site of the
// same account is recognised. Best effort: one that can't be asked is left.
async function recordSellers(ownerId, ebayService) {
  const unknown = (await connectionRepository.findAllByUser(ownerId)).filter(
    (c) => c.platform_key === 'ebay' && !c.settings?.ebay?.userId && !c.settings?.ebay?.username
  );
  await Promise.all(
    unknown.map((c) =>
      withDecryptedCredentials(c.id, ownerId, async (credentials) => {
        const seller = await ebayService.identifySeller(credentials);
        await connectionRepository.mergeEbaySettings(c.id, {
          ...(seller.userId ? { userId: seller.userId } : {}),
          ...(seller.username ? { username: seller.username } : {}),
        });
        return seller;
      }).catch(() => null)
    )
  );
}

/**
 * A signed-in eBay account, linked for one eBay site. The same account can
 * be linked once per site (UK and Australia are two connections of one
 * seller); linking it again for a site it already has refreshes that
 * connection's sign-in instead of adding a copy. Extra sites of an account
 * already linked don't take a plan slot. `marketplaceId` is the site the
 * seller picked; without one, the account's home site is detected.
 *
 * @returns { connection, existing } — existing is true when that site of
 *          that account was already connected.
 */
async function connectEbayAccount(ownerId, { label, marketplaceId, tokens }, ebayService) {
  const seller = await ebayService.identifySeller(tokens).catch(() => null);
  const credentials = seller?.credentialsChanged ? seller.credentials : tokens;
  const market = marketplaces.byId(marketplaceId)?.id || (await ebayService.detectMarketplace(credentials).catch(() => null))?.marketplaceId || marketplaces.DEFAULT_ID;

  const known = seller && (seller.userId || seller.username);
  if (known) await recordSellers(ownerId, ebayService);
  const siblings = known ? await connectionRepository.findOwnerEbayAccount(ownerId, seller) : [];
  const sameSite = siblings.find((c) => c.settings?.ebay?.marketplaceId === market);
  if (sameSite) {
    const current = await getConnectionWithDecryptedCredentials(sameSite.id, ownerId);
    await updateConnectionCredentials(sameSite.id, { ...(current.credentials || {}), ...credentials });
    return { connection: sameSite, existing: true };
  }
  if (!siblings.length) await assertUnderPlanLimit(ownerId);

  const connection = await createConnection(
    ownerId,
    {
      platformKey: 'ebay',
      label,
      credentials,
      settings: {
        ebay: {
          marketplaceId: market,
          ...(seller?.userId ? { userId: seller.userId } : {}),
          ...(seller?.username ? { username: seller.username } : {}),
        },
        pricing: { currency: marketplaces.currencyFor(market) },
      },
    },
    { planChecked: true }
  );
  ebayService.forgetMarketScopes();
  return { connection, existing: false };
}

// Safe to return to the frontend — no credentials, decrypted or otherwise.
// `viewer` (optional: { role, userId }), see listConnections — a member's
// summary carries their resolved permissions so the frontend (AccountShell)
// can gate nav tabs from the same data it already fetches per-page.
async function getConnectionSummary(id, ownerId, viewer) {
  const connection = await connectionRepository.findByIdForUser(id, ownerId);
  if (!connection) {
    throw new ConnectionError('Connection not found', 404);
  }
  const { credentials, ...summary } = withMarketplace(connection);
  void credentials;
  if (viewer && viewer.role === 'member') {
    summary.permissions = await teamRepository.getResolvedPermissions(viewer.userId, id);
  }
  return summary;
}

async function getConnectionWithDecryptedCredentials(id, userId) {
  const connection = await connectionRepository.findByIdForUser(id, userId);
  if (!connection) {
    throw new ConnectionError('Connection not found', 404);
  }
  // marketplaceId rides along in memory so every eBay call knows which site
  // to talk to; it is stripped again before anything is written back.
  const credentials = { ...decryptCredentials(connection.credentials), marketplaceId: connection.settings?.ebay?.marketplaceId };
  return { ...connection, credentials };
}

async function updateConnectionCredentials(id, credentials) {
  const { marketplaceId, ...stored } = credentials;
  void marketplaceId;
  await connectionRepository.updateCredentials(id, encryptCredentials(stored));
}

// Settings are plain, non-secret per-connection config (e.g. eBay's chosen
// default business policies) — never routed through credentials encryption.
// Shallow-merged at the top level, namespaced by platform key, so
// { ebay: {...} } replaces wholesale without touching other platforms' keys.
async function updateConnectionSettings(id, userId, patch) {
  const connection = await connectionRepository.findByIdForUser(id, userId);
  if (!connection) {
    throw new ConnectionError('Connection not found', 404);
  }
  const merged = { ...connection.settings, ...patch };
  await connectionRepository.updateSettings(id, merged);
  return merged;
}

// Detects and saves which eBay site a connection sells on, the first time
// it's needed. Also seeds the pricing currency from the marketplace when the
// seller hasn't set one. Returns the (possibly updated) connection.
async function ensureMarketplace(id, userId, ebayService) {
  const connection = await getConnectionWithDecryptedCredentials(id, userId);
  if (connection.platform_key !== 'ebay' || connection.settings?.ebay?.marketplaceId) return connection;
  const detected = await ebayService.detectMarketplace(connection.credentials);
  if (detected.credentialsChanged) await updateConnectionCredentials(id, detected.credentials);
  const settings = await updateConnectionSettings(id, userId, {
    ebay: {
      ...(connection.settings?.ebay || {}),
      marketplaceId: detected.marketplaceId,
      // Recorded when GetUser answered: eBay's notifications name the seller.
      ...(detected.profile?.username ? { username: detected.profile.username } : {}),
    },
    pricing: { ...(connection.settings?.pricing || {}), currency: connection.settings?.pricing?.currency || marketplaces.currencyFor(detected.marketplaceId) },
  });
  ebayService.forgetMarketScopes?.();
  return { ...connection, settings, credentials: { ...connection.credentials, marketplaceId: detected.marketplaceId } };
}

// Runs a platform action (e.g. an eBay draft/publish call) with this
// connection's decrypted credentials, then persists any refreshed tokens the
// action reports back — callers never touch encryption or the DB directly.
async function withDecryptedCredentials(id, userId, action) {
  const connection = await getConnectionWithDecryptedCredentials(id, userId);
  const result = await action(connection.credentials, connection);
  if (result && result.credentialsChanged) {
    await updateConnectionCredentials(id, result.credentials);
  }
  return result;
}

async function deleteConnection(id, userId) {
  const deleted = await connectionRepository.deleteByIdForUser(id, userId);
  if (!deleted) {
    throw new ConnectionError('Connection not found', 404);
  }
}

// The seller behind a connection ({ userId, username }), asked of eBay and
// recorded the first time it's needed.
async function sellerOf(connection, ownerId, ebayService) {
  const known = { userId: connection.settings?.ebay?.userId || null, username: connection.settings?.ebay?.username || null };
  if (known.userId || known.username) return known;
  const seller = await withDecryptedCredentials(connection.id, ownerId, async (credentials) => {
    const found = await ebayService.identifySeller(credentials);
    await connectionRepository.mergeEbaySettings(connection.id, {
      ...(found.userId ? { userId: found.userId } : {}),
      ...(found.username ? { username: found.username } : {}),
    });
    return found;
  });
  ebayService.forgetMarketScopes();
  return { userId: seller.userId || null, username: seller.username || null };
}

/**
 * The eBay sites a connection's account sells on, as eBay's copies show
 * them, each with the connection that holds it (this one, a sibling, or
 * none yet): [{ marketplace, listings, orders, connectionId }].
 */
async function ebaySites(ownerId, connectionId, ebayService) {
  const connection = await connectionRepository.findByIdForUser(connectionId, ownerId);
  if (!connection) throw new ConnectionError('Connection not found', 404);
  if (connection.platform_key !== 'ebay') return [];
  const own = connection.settings?.ebay?.marketplaceId || null;
  const seller = await sellerOf(connection, ownerId, ebayService).catch(() => ({}));
  const siblings = await connectionRepository.findOwnerEbayAccount(ownerId, seller, connection.id);
  const found = await withDecryptedCredentials(connection.id, ownerId, (credentials) => ebayService.accountSites(credentials, connection.id));
  const holder = (market) => (market === own ? connection.id : siblings.find((c) => c.settings?.ebay?.marketplaceId === market)?.id || null);
  return found
    .filter((site) => marketplaces.byId(site.marketplaceId))
    .map((site) => ({ marketplace: marketplaces.summary(site.marketplaceId), listings: site.listings, orders: site.orders, connectionId: holder(site.marketplaceId) }));
}

const SHARED_PRICING = ['targetRoiPercent', 'adsFeePercent', 'processingFeePercent', 'roundTo99', 'followCompetitorPrice'];
function sharedPricing(pricing = {}) {
  return Object.fromEntries(SHARED_PRICING.filter((key) => pricing?.[key] !== undefined).map((key) => [key, pricing[key]]));
}

/**
 * Another eBay site of a connected account, as a connection of its own —
 * no second eBay sign-in: eBay's token is the account's, for every site.
 * Named like the first, priced in the site's currency, and worked by the
 * same team (members' grants are copied). Takes no plan slot.
 */
async function addEbaySite(ownerId, connectionId, marketplaceId, ebayService) {
  const market = marketplaces.byId(marketplaceId);
  if (!market) throw new ConnectionError('Liston doesn’t sell on that eBay site.', 400);
  const source = await getConnectionWithDecryptedCredentials(connectionId, ownerId);
  if (source.platform_key !== 'ebay') throw new ConnectionError('Only eBay accounts have eBay sites.', 400);
  if (source.settings?.ebay?.marketplaceId === market.id) throw new ConnectionError(`This account is already the ${market.name} one.`, 400);
  const seller = await sellerOf(source, ownerId, ebayService);
  if (!seller.userId && !seller.username) throw new ConnectionError("eBay didn't say which seller this is. Try again in a minute.", 502);
  const taken = (await connectionRepository.findOwnerEbayAccount(ownerId, seller)).find((c) => c.settings?.ebay?.marketplaceId === market.id);
  if (taken) throw new ConnectionError(`${market.name} is already connected for this account.`, 409);

  const { marketplaceId: ownSite, ...credentials } = source.credentials;
  void ownSite;
  const connection = await createConnection(
    ownerId,
    {
      platformKey: 'ebay',
      label: source.label,
      credentials,
      settings: {
        ebay: { marketplaceId: market.id, ...(seller.userId ? { userId: seller.userId } : {}), ...(seller.username ? { username: seller.username } : {}) },
        // The first site's percentages carry over; its fixed fees are in
        // its own currency, so they're left for the seller to set.
        pricing: { ...sharedPricing(source.settings?.pricing), currency: market.currency },
      },
    },
    { planChecked: true }
  );
  await teamRepository.copyConnectionPermissions(source.id, connection.id);
  ebayService.forgetMarketScopes();
  return connection;
}

module.exports = {
  ebaySites,
  addEbaySite,
  listPlatforms,
  listConnections,
  assertUnderPlanLimit,
  createConnection,
  getConnectionSummary,
  getConnectionWithDecryptedCredentials,
  updateConnectionCredentials,
  updateConnectionSettings,
  ensureMarketplace,
  connectEbayAccount,
  withDecryptedCredentials,
  deleteConnection,
  ConnectionError,
};
