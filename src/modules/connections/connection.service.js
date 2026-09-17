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

async function createConnection(userId, { platformKey, label, credentials }) {
  await assertUnderPlanLimit(userId);

  const platform = await connectionRepository.findPlatformByKey(platformKey);
  if (!platform) {
    throw new ConnectionError('Unknown platform', 400);
  }
  if (platform.status !== 'active') {
    throw new ConnectionError(`${platform.name} isn't available yet`, 400);
  }

  return connectionRepository.create({
    userId,
    destinationPlatformId: platform.id,
    label,
    credentials: encryptCredentials(credentials),
  });
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
    ebay: { ...(connection.settings?.ebay || {}), marketplaceId: detected.marketplaceId },
    pricing: { ...(connection.settings?.pricing || {}), currency: connection.settings?.pricing?.currency || marketplaces.currencyFor(detected.marketplaceId) },
  });
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

module.exports = {
  listPlatforms,
  listConnections,
  assertUnderPlanLimit,
  createConnection,
  getConnectionSummary,
  getConnectionWithDecryptedCredentials,
  updateConnectionCredentials,
  updateConnectionSettings,
  ensureMarketplace,
  withDecryptedCredentials,
  deleteConnection,
  ConnectionError,
};
