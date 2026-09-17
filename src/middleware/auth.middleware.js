const config = require('../config');
const authService = require('../modules/auth/auth.service');
const userRepository = require('../modules/users/user.repository');

// req.userId is always the authenticated person (identity: profile settings,
// permission lookups). req.ownerId is whose DATA this request should operate
// on — for an owner that's themselves; for a member (a team login created by
// an owner, see src/modules/team/) it's their parent's id, since a member's
// connections/listings/etc. all live under the owner's account. Existing
// connection-scoped repository calls take req.ownerId instead of req.userId
// with no signature changes needed elsewhere.
async function requireAuth(req, res, next) {
  // Already resolved by a router-level guard on this request.
  if (req.userId) return next();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = authService.verifyToken(token);
    const user = await userRepository.findRoleInfo(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.userId = user.id;
    req.userEmail = user.email;
    req.role = user.role;
    req.ownerId = user.role === 'member' ? user.parent_user_id : user.id;
    // Members ride on their owner's approval; the owner row holds the status.
    req.accessStatus = user.role === 'member' ? (await userRepository.findRoleInfo(user.parent_user_id))?.access_status || 'active' : user.access_status;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// The approval gate. Everything that touches marketplace accounts, listings
// or team data sits behind this; auth and /users/me stay open so a pending
// user can log in, see "under review", and manage their own login.
function requireAccess(req, res, next) {
  if (req.accessStatus === 'active') return next();
  const message =
    req.accessStatus === 'rejected'
      ? "This account's access request was declined."
      : "Your access request is still under review. You'll get an email once it's approved.";
  return res.status(403).json({ error: message, accessStatus: req.accessStatus || 'pending' });
}

function requireAdmin(req, res, next) {
  if (config.adminEmails.includes(String(req.userEmail || '').toLowerCase())) return next();
  return res.status(403).json({ error: 'Admins only.' });
}

module.exports = { requireAuth, requireAccess, requireAdmin };
