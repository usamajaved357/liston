const bcrypt = require('bcrypt');
const teamRepository = require('./team.repository');
const connectionRepository = require('../connections/connection.repository');
const activityRepository = require('./activity.repository');
const activity = require('./activity');
const analyticsDays = require('../analytics/analytics-days');
const huntingService = require('../hunting/hunting.service');
const huntingRepository = require('../hunting/hunting.repository');
const workTime = require('./work-time');
const workTimeRepository = require('./work-time.repository');
const userRepository = require('../users/user.repository');
const notificationsService = require('../notifications/notifications.service');

const SALT_ROUNDS = 12;

class TeamError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// The day team figures are counted in: the viewer's own time zone (their
// browser's), so "today" is their today wherever the accounts sell. Without
// one, the owner's eBay site's.
async function zoneFor(ownerId, timeZone, connections = null) {
  return timeZone || ownerTimeZone(ownerId, connections);
}

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
async function listMembers(ownerId, { timeZone = null } = {}) {
  const [members, connections] = await Promise.all([teamRepository.listMembers(ownerId), connectionRepository.findAllByUser(ownerId)]);
  const today = activity.rangeWindow('today', { timeZone: await zoneFor(ownerId, timeZone, connections) });
  const [{ last, recent }, minutes] = await Promise.all([activityRepository.teamSince(ownerId, today.startsAt), workTimeRepository.teamSince(ownerId, today.startsAt)]);
  const lastBy = new Map(last.map((r) => [r.actor_user_id, r.last_active_at]));
  const timeBy = new Map(minutes.map((r) => [String(r.user_id), r]));
  return Promise.all(
    members.map(async (member) => {
      const t = timeBy.get(String(member.id));
      return {
        ...member,
        lastActiveAt: lastBy.get(member.id) || null,
        today: activity.metricsFrom(recent.filter((r) => r.actor_user_id === member.id), today.timeZone),
        // Their time in Liston today, and whether a tab of theirs is open now (a minute kept in the last two).
        time: { working: t?.working || 0, idle: t?.idle || 0, lastSeenAt: t?.last_minute || null, inListon: Boolean(t?.last_minute && Date.now() - new Date(t.last_minute).getTime() < 2.5 * 60 * 1000) },
        permissions: await teamRepository.getPermissions(member.id),
      };
    })
  );
}

/**
 * A member's page for a range: who they are, their access, their figures
 * against the period before, day by day and per eBay account.
 */
// `connectionId`: one eBay account's work only (a member's own Overview there).
async function getMemberOverview(ownerId, memberId, { range, from, to, timeZone = null, connectionId = null } = {}) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  const connections = await connectionRepository.findAllByUser(ownerId);
  // One account's days are that account's site's, as on its Overview.
  const scoped = connectionId ? connections.find((c) => c.id === connectionId) : null;
  const scopedZone = scoped ? analyticsDays.timeZoneFor(scoped.settings?.ebay?.marketplaceId || 'EBAY_GB') : null;
  const win = activity.rangeWindow(range, { from, to, timeZone: timeZone || scopedZone || (await zoneFor(ownerId, null, connections)) });
  const onAccount = (list) => (connectionId ? list.filter((r) => r.connection_id === connectionId) : list);
  const [allRows, allPrevRows, permissions, lastActive, recordingSince, hunting] = await Promise.all([
    activityRepository.rowsFor(ownerId, memberId, win.startsAt, win.endsAt),
    activityRepository.rowsFor(ownerId, memberId, win.previous.startsAt, win.previous.endsAt),
    teamRepository.getPermissions(memberId),
    activityRepository.lastActiveAt(ownerId, memberId),
    activityRepository.recordingSince(),
    // Their hunted products' results and their reviews (hunting/hunting-stats.js).
    huntingService.memberFigures(ownerId, memberId, win, { connectionId }),
  ]);
  const rows = onAccount(allRows);
  const prevRows = onAccount(allPrevRows);
  // Their products approved and rejected, day by day on the day each was decided (a reviewer's action, not theirs).
  // And their converting products: finds that sold, how many different ones a day.
  const [outcomes, prevOutcomes, converting, prevConverting] = await Promise.all([
    huntingRepository.outcomesBetween(ownerId, { start: win.startsAt, end: win.endsAt, hunterId: memberId, connectionId }),
    huntingRepository.outcomesBetween(ownerId, { start: win.previous.startsAt, end: win.previous.endsAt, hunterId: memberId, connectionId }),
    huntingService.convertingByDay(ownerId, memberId, { startsAt: win.startsAt, endsAt: win.endsAt, timeZone: win.timeZone, connectionId }).catch(() => ({ byDay: new Map(), total: 0 })),
    huntingService.convertingByDay(ownerId, memberId, { startsAt: win.previous.startsAt, endsAt: win.previous.endsAt, timeZone: win.timeZone, connectionId }).catch(() => ({ byDay: new Map(), total: 0 })),
  ]);
  const outcomeDays = (list, sold, from, to) => {
    const days = new Map(analyticsDays.daysBetween(from, to).map((d) => [d, { day: d, approved: 0, rejected: 0, converting: sold.byDay.get(d) || 0 }]));
    for (const o of list) {
      const d = days.get(analyticsDays.dayOf(o.decided_at, win.timeZone));
      if (d) d[o.status] += 1;
    }
    return [...days.values()];
  };
  const huntOutcomes = {
    series: outcomeDays(outcomes, converting, win.from, win.to),
    previousSeries: outcomeDays(prevOutcomes, prevConverting, win.previous.from, win.previous.to),
    totals: { approved: outcomes.filter((o) => o.status === 'approved').length, rejected: outcomes.filter((o) => o.status === 'rejected').length, converting: converting.total },
    previous: { approved: prevOutcomes.filter((o) => o.status === 'approved').length, rejected: prevOutcomes.filter((o) => o.status === 'rejected').length, converting: prevConverting.total },
  };

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

  // Their time in Liston (the whole period; one account's when scoped) against the period before.
  const [minutes, prevMinutes] = await Promise.all([workTimeRepository.minutesFor(ownerId, memberId, win.startsAt, win.endsAt), workTimeRepository.minutesFor(ownerId, memberId, win.previous.startsAt, win.previous.endsAt)]);
  const onAccountMinutes = (list) => (connectionId ? list.filter((m) => m.connection_id === connectionId) : list);
  return {
    member: { ...member, lastActiveAt: lastActive },
    recordingSince,
    // How quickly they answer buyers: the median wait before their replies.
    replyTime: activity.replyTime(rows),
    previousReplyTime: activity.replyTime(prevRows),
    time: workTime.totalsOf(onAccountMinutes(minutes)),
    previousTime: workTime.totalsOf(onAccountMinutes(prevMinutes)),
    range: { key: win.key, from: win.from, to: win.to, days: win.days, timeZone: win.timeZone, previous: { from: win.previous.from, to: win.previous.to } },
    metrics: activity.METRICS.map(({ key, label }) => ({ key, label })),
    totals: activity.metricsFrom(rows, win.timeZone),
    previous: activity.metricsFrom(prevRows, win.timeZone),
    actions: rows.filter((r) => activity.isWork(r.kind)).length,
    series,
    previousSeries,
    accounts,
    permissions,
    hunting,
    huntOutcomes,
    connections: connections.filter((c) => c.platform_key === 'ebay').map((c) => ({ id: c.id, label: c.label })),
    knownFeatures: teamRepository.KNOWN_FEATURES,
  };
}

/**
 * A team member's own work on one eBay account, for their Overview there:
 * the same figures their owner sees on their Team page, for that account
 * only, and never any money — sales from their finds come as orders and
 * units, no amounts. Members only; an owner's account Overview has the rest.
 */
async function getOwnWork(viewer, connectionId, { range, from, to, timeZone = null } = {}) {
  if (viewer.role !== 'member') throw new TeamError('This shows a team member their own work.', 403);
  const data = await getMemberOverview(viewer.ownerId, viewer.userId, { range, from, to, timeZone, connectionId });
  const resolved = await teamRepository.getResolvedPermissions(viewer.userId, connectionId);
  const counts = (list) => (list || []).map(({ orders, units, lastAt }) => ({ orders, units, lastAt }));
  return {
    recordingSince: data.recordingSince,
    range: data.range,
    metrics: data.metrics,
    totals: data.totals,
    previous: data.previous,
    actions: data.actions,
    series: data.series,
    previousSeries: data.previousSeries,
    accounts: [],
    // What they can do on this account.
    permissions: Object.entries(resolved).map(([feature, allowed]) => ({ feature, connectionId, allowed })),
    hunting: data.hunting && { ...data.hunting, sales: counts(data.hunting.sales), previousSales: counts(data.hunting.previousSales) },
    huntOutcomes: data.huntOutcomes,
    replyTime: data.replyTime,
    previousReplyTime: data.previousReplyTime,
    time: data.time,
    previousTime: data.previousTime,
  };
}

// ---- time in Liston ------------------------------------------------------------

const ownedCache = new Map();
async function ownedAccountIds(ownerId) {
  const hit = ownedCache.get(ownerId);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ids;
  const ids = new Set((await connectionRepository.findAllByUser(ownerId)).map((c) => String(c.id)));
  ownedCache.set(ownerId, { at: Date.now(), ids });
  return ids;
}

/**
 * A minute of a team member's time in Liston, from one of their tabs:
 * working or idle, the area and the eBay account they were in. Members
 * only, those with owner access too (the owner's own time isn't kept). { kept }.
 */
async function clock(auth, { working, area, connectionId = null }) {
  if (auth.role !== 'member' && !auth.coOwner) return { kept: false };
  const account = connectionId && (await ownedAccountIds(auth.ownerId)).has(String(connectionId)) ? connectionId : null;
  await workTimeRepository.recordMinute({ userId: auth.userId, ownerId: auth.ownerId, working: Boolean(working), area: workTime.areaKey(area), connectionId: account });
  return { kept: true };
}

/**
 * A member's time in Liston for a range: working and idle against the
 * period before, each day's stretches, where the working time went and
 * what they did there (their recorded actions in each area), and actions
 * per working hour.
 */
async function getMemberTime(ownerId, memberId, { range, from, to, timeZone = null } = {}) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  const win = activity.rangeWindow(range, { from, to, timeZone: await zoneFor(ownerId, timeZone) });
  const [minutes, prevMinutes, rows, prevRows, since] = await Promise.all([
    workTimeRepository.minutesFor(ownerId, memberId, win.startsAt, win.endsAt),
    workTimeRepository.minutesFor(ownerId, memberId, win.previous.startsAt, win.previous.endsAt),
    activityRepository.rowsFor(ownerId, memberId, win.startsAt, win.endsAt),
    activityRepository.rowsFor(ownerId, memberId, win.previous.startsAt, win.previous.endsAt),
    workTimeRepository.firstMinute(ownerId, memberId),
  ]);
  const summary = workTime.summarize(minutes, { from: win.from, to: win.to, timeZone: win.timeZone });
  const work = rows.filter((r) => activity.isWork(r.kind));
  const actionsIn = new Map();
  const actionsOn = new Map();
  for (const r of work) {
    const area = workTime.areaOfKind(r.kind);
    if (area) actionsIn.set(area, (actionsIn.get(area) || 0) + 1);
    const day = analyticsDays.dayOf(r.created_at, win.timeZone);
    actionsOn.set(day, (actionsOn.get(day) || 0) + 1);
  }
  // Areas with time or with work, each with its actions.
  const areas = summary.areas.map((a) => ({ ...a, actions: actionsIn.get(a.area) || 0 }));
  for (const [area, actions] of actionsIn) if (!areas.some((a) => a.area === area)) areas.push({ area, label: workTime.AREAS[area], working: 0, idle: 0, actions });
  const prev = workTime.totalsOf(prevMinutes);
  const perHour = (actions, mins) => (mins >= 15 ? Math.round((actions / (mins / 60)) * 10) / 10 : null);
  return {
    range: { key: win.key, from: win.from, to: win.to, days: win.days, timeZone: win.timeZone, previous: { from: win.previous.from, to: win.previous.to } },
    trackedSince: since,
    totals: { ...summary.totals, actions: work.length, actionsPerHour: perHour(work.length, summary.totals.working), daysInListon: summary.days.filter((d) => d.working + d.idle > 0).length },
    previous: { ...prev, actions: prevRows.filter((r) => activity.isWork(r.kind)).length },
    days: summary.days.map((d) => ({ ...d, actions: actionsOn.get(d.day) || 0 })),
    areas,
  };
}

const FEED_MAX = 5000;

/**
 * A member's activity log for a range, newest first, a page at a time
 * (`before` = the last id shown), or all of it (up to 5,000) for a CSV.
 */
async function getMemberActivity(ownerId, memberId, { range, from, to, timeZone = null, kind, connectionId, before, limit = 50 } = {}) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  const win = activity.rangeWindow(range, { from, to, timeZone: await zoneFor(ownerId, timeZone) });
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

// Who may change a member (`actor`: { userId, coOwner }, the person asking):
// the owner, anyone on the team; someone with owner access, the rest of the
// team, but never their own login or another with owner access: those are
// the owner's alone.
async function manageable(actor, memberId, ownerId) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  if (actor?.coOwner) {
    if (String(member.id) === String(actor.userId)) throw new TeamError('Your own login and access are managed by the account owner.', 403);
    if (member.owner_access_at) throw new TeamError(`${member.name || member.email} has owner access, so only the account owner can change their login or access.`, 403);
  }
  return member;
}

// Owners hand out member logins, so they can also reset one — the member's
// old password stops working immediately.
async function setMemberPassword(memberId, ownerId, password, actor) {
  await manageable(actor, memberId, ownerId);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const updated = await teamRepository.setMemberPassword(memberId, ownerId, passwordHash);
  if (!updated) {
    throw new TeamError('Team member not found', 404);
  }
}

// Removing a member signs them out and refuses their login from then on;
// their record and activity stay. Restoring gives the same access back
// (owner access too, which only the owner can restore).
async function removeMember(memberId, ownerId, actor) {
  await manageable(actor, memberId, ownerId);
  const done = await teamRepository.setMemberDeactivated(memberId, ownerId, true);
  if (!done) {
    throw new TeamError('Team member not found', 404);
  }
}

async function restoreMember(memberId, ownerId, actor) {
  await manageable(actor, memberId, ownerId);
  const done = await teamRepository.setMemberDeactivated(memberId, ownerId, false);
  if (!done) {
    throw new TeamError('Team member not found', 404);
  }
}

/**
 * Gives a member owner access, or takes it away: everything the owner can
 * see and do, the rest of the team to run, until the owner says otherwise.
 * The owner only (the route lets no one else in; checked here as well).
 * The member is told, and their next click in Liston is under the new
 * access. Returns the member.
 */
async function setOwnerAccess(memberId, ownerId, on, actor) {
  if (actor?.coOwner) throw new TeamError('Only the account owner can give or take away owner access.', 403);
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) throw new TeamError('Team member not found', 404);
  if (on && member.deactivated_at) throw new TeamError(`${member.name || member.email} was removed. Restore them first.`, 409);
  if (Boolean(member.owner_access_at) === on) return member;
  const updated = await teamRepository.setOwnerAccess(memberId, ownerId, on);
  if (!updated) throw new TeamError('Team member not found', 404);
  if (!member.deactivated_at) {
    const owner = await userRepository.findByIdWithPlan(ownerId);
    const ownerName = owner?.name || owner?.email || 'The account owner';
    await notificationsService.notify({
      userId: memberId,
      actorUserId: actor?.userId || ownerId,
      kind: on ? 'team.owner_access_given' : 'team.owner_access_removed',
      title: on ? `${ownerName} gave you owner access` : `${ownerName} took away your owner access`,
      body: on
        ? 'You can now see and do everything the owner can: every eBay account, settings, and the rest of the team.'
        : "You're back to the access set for you on the team. Reload Liston to see it.",
      url: on ? '/dashboard' : '/connections',
      subjectType: 'member',
      subjectId: memberId,
    });
  }
  return { ...member, owner_access_at: updated.owner_access_at };
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
async function updateMemberPermissions(memberId, ownerId, permissions, actor) {
  await manageable(actor, memberId, ownerId);

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
  getOwnWork,
  getMemberActivity,
  getMemberTime,
  clock,
  setMemberPassword,
  setOwnerAccess,
  getMemberPermissions,
  updateMemberPermissions,
  TeamError,
};
