const bcrypt = require('bcrypt');
const teamRepository = require('./team.repository');
const connectionRepository = require('../connections/connection.repository');
const activityRepository = require('./activity.repository');
const activity = require('./activity');
const analyticsDays = require('../analytics/analytics-days');

const SALT_ROUNDS = 12;

class TeamError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// The owner's day: their eBay accounts' site time zone (the same days the
// rest of Liston counts in).
async function ownerTimeZone(ownerId, connections = null) {
  const list = connections || (await connectionRepository.findAllByUser(ownerId));
  for (const c of list) {
    const tz = analyticsDays.timeZoneFor(c.settings?.ebay?.marketplaceId || 'EBAY_GB');
    if (tz) return tz;
  }
  return 'Europe/London';
}

/**
 * The Team page: each member with their access, when they last logged in
 * and last did something, and what they've done today.
 */
async function listMembers(ownerId) {
  const [members, connections] = await Promise.all([teamRepository.listMembers(ownerId), connectionRepository.findAllByUser(ownerId)]);
  const today = activity.rangeWindow('today', { timeZone: await ownerTimeZone(ownerId, connections) });
  const { last, recent } = await activityRepository.teamSince(ownerId, today.startsAt);
  const lastBy = new Map(last.map((r) => [r.actor_user_id, r.last_active_at]));
  return Promise.all(
    members.map(async (member) => ({
      ...member,
      lastActiveAt: lastBy.get(member.id) || null,
      today: activity.metricsFrom(recent.filter((r) => r.actor_user_id === member.id), today.timeZone),
      permissions: await teamRepository.getPermissions(member.id),
    }))
  );
}

/**
 * A member's page for a range: who they are, their access, their figures
 * against the period before, day by day and per eBay account.
 */
async function getMemberOverview(ownerId, memberId, { range, from, to } = {}) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  const connections = await connectionRepository.findAllByUser(ownerId);
  const win = activity.rangeWindow(range, { from, to, timeZone: await ownerTimeZone(ownerId, connections) });
  const [rows, prevRows, permissions, lastActive, recordingSince] = await Promise.all([
    activityRepository.rowsFor(ownerId, memberId, win.startsAt, win.endsAt),
    activityRepository.rowsFor(ownerId, memberId, win.previous.startsAt, win.previous.endsAt),
    teamRepository.getPermissions(memberId),
    activityRepository.lastActiveAt(ownerId, memberId),
    activityRepository.recordingSince(),
  ]);

  // Day by day, in the owner's time zone.
  const byDay = new Map(analyticsDays.daysBetween(win.from, win.to).map((d) => [d, []]));
  for (const r of rows) byDay.get(analyticsDays.dayOf(r.created_at, win.timeZone))?.push(r);
  const series = [...byDay].map(([day, dayRows]) => ({ day, ...activity.metricsFrom(dayRows, win.timeZone) }));
  // The period before, day by day, lined up with this one for the chart.
  const prevByDay = new Map(analyticsDays.daysBetween(win.previous.from, win.previous.to).map((d) => [d, []]));
  for (const r of prevRows) prevByDay.get(analyticsDays.dayOf(r.created_at, win.timeZone))?.push(r);
  const previousSeries = [...prevByDay].map(([day, dayRows]) => ({ day, ...activity.metricsFrom(dayRows, win.timeZone) }));

  // Per eBay account (a removed account keeps its name from the rows).
  const byAccount = new Map();
  // (Logins and supplier accounts are on no one eBay account.)
  for (const r of rows.filter((x) => x.connection_id || x.connection_label)) {
    const key = r.connection_id || `gone:${r.connection_label}`;
    if (!byAccount.has(key)) byAccount.set(key, { connectionId: r.connection_id, label: r.connection_label, rows: [] });
    byAccount.get(key).rows.push(r);
  }
  const accounts = [...byAccount.values()]
    .map((a) => ({ connectionId: a.connectionId, label: a.label, actions: a.rows.filter((r) => activity.isWork(r.kind)).length, ...activity.metricsFrom(a.rows, win.timeZone) }))
    .sort((a, b) => b.actions - a.actions);

  return {
    member: { ...member, lastActiveAt: lastActive },
    recordingSince,
    range: { key: win.key, from: win.from, to: win.to, days: win.days, timeZone: win.timeZone, previous: { from: win.previous.from, to: win.previous.to } },
    metrics: activity.METRICS.map(({ key, label }) => ({ key, label })),
    totals: activity.metricsFrom(rows, win.timeZone),
    previous: activity.metricsFrom(prevRows, win.timeZone),
    actions: rows.filter((r) => activity.isWork(r.kind)).length,
    series,
    previousSeries,
    accounts,
    permissions,
    connections: connections.filter((c) => c.platform_key === 'ebay').map((c) => ({ id: c.id, label: c.label })),
    knownFeatures: teamRepository.KNOWN_FEATURES,
  };
}

const FEED_MAX = 5000;

/**
 * A member's activity log for a range, newest first, a page at a time
 * (`before` = the last id shown), or all of it (up to 5,000) for a CSV.
 */
async function getMemberActivity(ownerId, memberId, { range, from, to, kind, connectionId, before, limit = 50 } = {}) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  const win = activity.rangeWindow(range, { from, to, timeZone: await ownerTimeZone(ownerId) });
  // A figure's name (e.g. "cases") stands for all of its kinds.
  const metric = activity.METRICS.find((m) => m.key === kind);
  const kinds = metric ? metric.kinds : kind && activity.KINDS[kind] ? [kind] : null;
  const size = Math.min(Math.max(1, Number(limit) || 50), FEED_MAX);
  const rows = await activityRepository.feed(ownerId, memberId, { startsAt: win.startsAt, endsAt: win.endsAt, kinds, connectionId: connectionId || null, before: before || null, limit: size + 1 });
  return {
    items: rows.slice(0, size).map((r) => ({
      id: String(r.id),
      kind: r.kind,
      label: activity.KINDS[r.kind] || r.kind,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      subjectPart: r.subject_part,
      title: r.title,
      amount: r.amount == null ? null : Number(r.amount),
      currency: r.currency,
      detail: r.detail || {},
      connectionId: r.connection_id,
      connectionLabel: r.connection_label,
      at: r.created_at,
    })),
    next: rows.length > size ? activityRepository.cursorOf(rows[size - 1]) : null,
    range: { key: win.key, from: win.from, to: win.to, timeZone: win.timeZone },
  };
}

async function addMember(ownerId, { email, name, password }) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    return await teamRepository.createMember({ ownerId, email, name, passwordHash });
  } catch (err) {
    if (err.code === '23505') {
      const removed = await teamRepository.findRemovedMemberByEmail(ownerId, email);
      throw new TeamError(removed ? `${removed.name || email} was removed earlier. Restore them from Former members on the Team page instead.` : 'An account with this email already exists', 409);
    }
    throw err;
  }
}

// Owners hand out member logins, so they can also reset one — the member's
// old password stops working immediately.
async function setMemberPassword(memberId, ownerId, password) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const updated = await teamRepository.setMemberPassword(memberId, ownerId, passwordHash);
  if (!updated) {
    throw new TeamError('Team member not found', 404);
  }
}

// Removing a member signs them out and refuses their login from then on;
// their record and activity stay. Restoring gives the same access back.
async function removeMember(memberId, ownerId) {
  const done = await teamRepository.setMemberDeactivated(memberId, ownerId, true);
  if (!done) {
    throw new TeamError('Team member not found', 404);
  }
}

async function restoreMember(memberId, ownerId) {
  const done = await teamRepository.setMemberDeactivated(memberId, ownerId, false);
  if (!done) {
    throw new TeamError('Team member not found', 404);
  }
}

async function getMemberPermissions(memberId, ownerId) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) {
    throw new TeamError('Team member not found', 404);
  }
  return teamRepository.getPermissions(memberId);
}

// permissions: [{ connectionId: string|null, feature: string, allowed: boolean|null }]
// connectionId null sets/overrides the member's global default for that
// feature (allowed must be a real boolean there — there's no higher-level
// default for it to fall back to). A real connectionId sets a per-connection
// override; `allowed: null` there means "clear the override and defer back
// to the global default" rather than "explicitly deny," which a hard
// `false` would be indistinguishable from once written. Every connectionId
// is verified to belong to this owner before being written, so an admin can
// never grant a member access to someone else's connection.
async function updateMemberPermissions(memberId, ownerId, permissions) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) {
    throw new TeamError('Team member not found', 404);
  }

  for (const { connectionId, feature, allowed } of permissions) {
    if (connectionId) {
      // eslint-disable-next-line no-await-in-loop -- each grant must be verified before the next is written
      const connection = await connectionRepository.findByIdForUser(connectionId, ownerId);
      if (!connection) {
        throw new TeamError('Connection not found', 404);
      }
    }
    if (allowed === null) {
      if (!connectionId) {
        throw new TeamError('The global default must be either allowed or denied', 400);
      }
      // eslint-disable-next-line no-await-in-loop
      await teamRepository.clearPermission({ memberId, connectionId, feature });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await teamRepository.setPermission({ memberId, connectionId: connectionId || null, feature, allowed });
    }
  }

  return teamRepository.getPermissions(memberId);
}

module.exports = {
  KNOWN_FEATURES: teamRepository.KNOWN_FEATURES,
  listMembers,
  addMember,
  removeMember,
  restoreMember,
  getMemberOverview,
  getMemberActivity,
  setMemberPassword,
  getMemberPermissions,
  updateMemberPermissions,
  TeamError,
};
