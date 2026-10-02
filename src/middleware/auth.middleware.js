const config = require('../config');
const authService = require('../modules/auth/auth.service');
const workspaceRepository = require('../modules/team/workspace.repository');
const teams = require('../modules/team/teams');

// req.userId is always the authenticated person (identity: profile settings,
// permission lookups). req.ownerId is whose DATA this request should operate
// on: the team it's in (migration 051, one login in several owners' teams,
// as Slack's workspaces). The page names the team in X-Liston-Workspace;
// a team the login isn't in (or was removed from) is refused with code
// TEAM_GONE, never swapped for another; without one it's the login's last
// team. In its own team a login is the owner; in another's a member, or
// the owner there too with owner access (req.coOwner). Existing
// connection-scoped repository calls take req.ownerId instead of
// req.userId with no signature changes needed elsewhere.
//
// A sign-in lasts a week (JWT_EXPIRES_IN) from its last renewal: a token
// over a day old comes back renewed in the X-Liston-Token header, which the
// pages keep, so someone using Liston isn't signed out mid-work. One that
// has run out (or is no good) is a 401 with code SESSION_ENDED, on which
// the pages go to the sign-in page; a database hiccup is a 500, never a
// sign-out.
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const ended = (res, error) => res.status(401).json({ error, code: 'SESSION_ENDED' });

async function requireAuth(req, res, next) {
  // Already resolved by a router-level guard on this request.
  if (req.userId) return next();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice('Bearer '.length);
  let payload;
  try {
    payload = authService.verifyToken(token);
  } catch {
    return ended(res, 'Your sign-in has run out. Sign in again.');
  }
  try {
    const session = await workspaceRepository.sessionFor(payload.sub);
    if (!session) return ended(res, 'Your sign-in has run out. Sign in again.');
    const { user } = session;
    const asked = req.headers['x-liston-workspace'] || null;
    const picked = teams.pickTeam(session.teams, { asked, last: user.last_workspace_id });
    // A member removed from every team they were in is signed out at their next request.
    if (picked.none) return ended(res, 'This login has been removed by the account owner.');
    if (picked.refused) return res.status(403).json({ error: "You're not in that team any more.", code: 'TEAM_GONE' });
    if (payload.iat && Date.now() - payload.iat * 1000 > RENEW_AFTER_MS) res.setHeader('X-Liston-Token', authService.issueToken(user));
    const { role, coOwner } = teams.roleIn(picked.team);
    req.userId = user.id;
    req.userEmail = user.email;
    req.ownerId = picked.team.ownerId;
    req.role = role;
    // Owner access in another's team: the owner there, apart from where only the owner may act.
    req.coOwner = coOwner;
    // Whether the login has a team of its own (an owner), whatever team it's in now.
    req.ownsTeam = user.role === 'owner';
    req.teams = session.teams;
    // Members ride on their team owner's approval; the owner row holds the status.
    req.accessStatus = picked.team.accessStatus || 'active';
    next();
  } catch (err) {
    next(err);
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
