// Teams (Slack's workspaces, migration 051): one login can work in several
// owners' teams. A team is keyed by its owner's user id. Pure helpers: a
// team's name, and which team a request is in.

const NAME_MAX = 60;

/** "Usama's workspace": the owner's first name, else their email's name part. */
function defaultTeamName({ name, email }) {
  const first = String(name || '').trim().split(/\s+/)[0] || String(email || '').split('@')[0] || 'My';
  return `${first.slice(0, NAME_MAX - 12)}'s workspace`;
}

/** A team name as typed, tidied; null when there's nothing to it. */
function cleanTeamName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, NAME_MAX) : null;
}

/**
 * The team a request works in. `teams`: the login's own team (an owner's)
 * and the teams it's an active member of, [{ ownerId, own, ownerAccessAt,
 * accessStatus }]. `asked`: the team the page named (X-Liston-Workspace);
 * one the login isn't in is refused (null), never swapped for another.
 * Without one: the last team used, else the first that's approved (own
 * first), else the first.
 * Returns { team } or { refused: true } or { none: true }.
 */
function pickTeam(teams, { asked = null, last = null } = {}) {
  if (!teams.length) return { none: true };
  if (asked) {
    const team = teams.find((t) => String(t.ownerId) === String(asked));
    return team ? { team } : { refused: true };
  }
  const active = teams.filter((t) => (t.accessStatus || 'active') === 'active');
  const team = (last && active.find((t) => String(t.ownerId) === String(last))) || active[0] || teams[0];
  return { team };
}

/** What the login is in that team: the owner, someone with owner access, or a member. */
function roleIn(team) {
  if (team.own) return { role: 'owner', coOwner: false };
  if (team.ownerAccessAt) return { role: 'owner', coOwner: true };
  return { role: 'member', coOwner: false };
}

/** A link inside Liston that opens in this team (`ws`), for notifications and pushes. */
function linkInTeam(url, ownerId) {
  if (!url || !ownerId || /[?&]ws=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}ws=${ownerId}`;
}

module.exports = { NAME_MAX, defaultTeamName, cleanTeamName, pickTeam, roleIn, linkInTeam };
