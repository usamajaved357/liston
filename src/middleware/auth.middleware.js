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
    req.role = user.role;
    req.ownerId = user.role === 'member' ? user.parent_user_id : user.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
