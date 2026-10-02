const teamRepository = require('../modules/team/team.repository');

// Requires requireAuth to have run first (needs req.role/req.userId/req.ownerId).
// A member with owner access passes (req.role is 'owner' for them).
function requireOwner(req, res, next) {
  if (req.role !== 'owner') {
    return res.status(403).json({ error: 'Only the account owner can do this.' });
  }
  next();
}

// The account's own owner only, never someone given owner access: giving
// and taking away owner access.
function requireMainOwner(req, res, next) {
  if (req.role !== 'owner' || req.coOwner) {
    return res.status(403).json({ error: 'Only the account owner can do this.' });
  }
  next();
}

// Gates a connection-scoped route by one feature string. Owners always pass
// (they have full access to their own account). A member passes only if
// team.repository's deny-by-default resolution grants this feature for the
// connection being accessed.
//
// `resolveConnectionId` lets routes that aren't shaped as
// `/connections/:id/...` (e.g. `/listings/:listingId`) tell this middleware
// how to find the connection id for the resource being accessed — it
// defaults to reading `req.params.id`, which matches the existing
// connections-nested route convention.
function requireFeature(feature, { resolveConnectionId } = {}) {
  const getConnectionId = resolveConnectionId || ((req) => req.params.id);
  return async (req, res, next) => {
    try {
      if (req.role === 'owner') return next();

      const connectionId = await getConnectionId(req);
      if (!connectionId) {
        return res.status(404).json({ error: 'Not found' });
      }

      const allowed = await teamRepository.resolvePermission(req.userId, connectionId, feature);
      if (!allowed) {
        return res.status(403).json({ error: `You don't have access to ${feature} for this account.` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Like requireFeature, but passes if the member has ANY of the given
// features on this connection — used on routes that render baseline
// connection info shared across every feature tab (e.g. the connection
// summary), so a connection isn't reachable at all once every feature is
// denied.
function requireAnyFeature(features, { resolveConnectionId } = {}) {
  const getConnectionId = resolveConnectionId || ((req) => req.params.id);
  return async (req, res, next) => {
    try {
      if (req.role === 'owner') return next();

      const connectionId = await getConnectionId(req);
      if (!connectionId) {
        return res.status(404).json({ error: 'Not found' });
      }

      const allowed = await teamRepository.resolveAnyPermission(req.userId, connectionId, features);
      if (!allowed) {
        return res.status(403).json({ error: "You don't have access to this account." });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Whether this person may put listings live on this account: publishing a
 * draft (or relisting an ended listing) needs "Publish listings" on top of
 * Listings, so a member can draft and edit without anything going live
 * before someone trusted presses Publish. The owner always may.
 */
async function canPublishListings(req, connectionId) {
  if (req.role === 'owner') return true;
  return Boolean(connectionId && (await teamRepository.resolvePermission(req.userId, connectionId, 'listings_publish')));
}

module.exports = { requireOwner, requireMainOwner, requireFeature, requireAnyFeature, canPublishListings };
