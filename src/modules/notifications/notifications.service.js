const notificationsRepository = require('./notifications.repository');
const push = require('./push');
const userEvents = require('../realtime/user-events');
const logger = require('../../utils/logger');
const { linkInTeam } = require('../team/teams');

// What Liston tells a person: kept for the bell, and pushed to every browser
// they turned push notifications on in. Each change is also said on the
// person's live stream (`notifications.changed`) so an open bell follows at once.
// Each is about one team (`ownerId`): the bell lists the team the person is
// in, and its link opens in that team (`ws`), from a push too.

const changed = (userId) => userEvents.emit(String(userId), { type: 'notifications.changed' });

/**
 * Tells someone something: kept for the bell, then pushed in the background.
 * Never throws, since a failed notification must not undo the work that
 * caused it.
 */
async function notify({ userId, ownerId = null, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId = null, detail = {} }) {
  if (!userId || !kind || !title) return null;
  url = linkInTeam(url, ownerId);
  let row;
  try {
    row = await notificationsRepository.insert({ userId, ownerId, actorUserId, kind, title, body, url, subjectType, subjectId, detail });
  } catch (err) {
    logger.warn('Notification not kept', { kind, error: err.message });
    return null;
  }
  changed(userId);
  // Pushed in the background: the action that caused it doesn't wait on the push services.
  pushTo(userId, { id: row.id, at: row.created_at, kind, title, body, url, tag: subjectId ? `${kind.split('.')[0]}-${subjectId}` : row.id }).catch((err) => logger.warn('Push not sent', { kind, error: err.message }));
  return row;
}

/**
 * A notification kept once per subject (a chat conversation, an eBay
 * conversation): the bell shows one line counting up; `push` (when given)
 * is sent to the person's browsers — tag, title, body, url, image — and
 * left out when they shouldn't be disturbed. Never throws.
 */
async function notifyGrouped({ userId, ownerId = null, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId, detail = {}, push: pushed = null }) {
  if (!userId || !kind || !title || !subjectId) return null;
  url = linkInTeam(url, ownerId);
  let row;
  try {
    row = await notificationsRepository.upsertGrouped({ userId, ownerId, actorUserId, kind, title, body, url, subjectType, subjectId, detail });
  } catch (err) {
    logger.warn('Notification not kept', { kind, error: err.message });
    return null;
  }
  changed(userId);
  // `at`: when the line last moved, so an open tab knows a conversation's next message from the one before (same line, same id).
  if (pushed) pushTo(userId, { id: row.id, at: row.created_at, kind, url, ...pushed }).catch((err) => logger.warn('Push not sent', { kind, error: err.message }));
  return row;
}

/** The person opened what these notifications were about: they're read. */
async function readSubject(userId, kind, subjectId) {
  const count = await notificationsRepository.markReadBySubject(userId, kind, subjectId).catch(() => 0);
  if (count) changed(userId);
  return count;
}

/** Sends one notification to every browser the person turned push on in; forgets the ones that are gone. */
async function pushTo(userId, payload) {
  if (!push.configured()) return;
  const subscriptions = await notificationsRepository.subscriptionsFor(userId);
  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        const res = await push.send(s, payload);
        if (res.gone) await notificationsRepository.forgetEndpoint(s.endpoint);
        else if (res.sent) await notificationsRepository.touchSubscription(s.endpoint);
      } catch (err) {
        logger.warn('Push not sent', { kind: payload.kind, status: err.statusCode, error: err.message });
      }
    })
  );
}

// Who did it, by their name now (a name set later shows on older ones too).
const nameOf = (row) => row.actor_name || (row.actor_email ? row.actor_email.split('@')[0] : null);

function shape(row) {
  const detail = { ...(row.detail || {}) };
  if (row.kind.startsWith('hunt.')) {
    // Older ones kept only their title ("Sent back: <product>").
    if (!detail.product && row.title.includes(': ')) detail.product = row.title.slice(row.title.indexOf(': ') + 2);
    if (detail.product) detail.by = nameOf(row) || detail.by || null;
  }
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, url: row.url, detail, readAt: row.read_at, createdAt: row.created_at };
}

/** The person's notifications in the team they're in (`ownerId`). */
async function list(userId, ownerId) {
  const { rows, unread } = await notificationsRepository.listFor(userId, ownerId);
  return { items: rows.map(shape), unread, push: { available: push.configured(), publicKey: push.publicKey() } };
}

async function markRead(userId, ownerId, ids) {
  await notificationsRepository.markRead(userId, ownerId, ids || null);
  changed(userId);
  return list(userId, ownerId);
}

async function subscribe(userId, { endpoint, keys, userAgent }) {
  if (!push.configured()) {
    const err = new Error("Push notifications aren't set up on this server.");
    err.statusCode = 503;
    err.expose = true;
    throw err;
  }
  await notificationsRepository.saveSubscription(userId, { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent });
}

/** Clears some (or all in the team) of a person's notifications. */
async function clear(userId, ownerId, ids) {
  await notificationsRepository.deleteFor(userId, ownerId, ids || null);
  changed(userId);
  return list(userId, ownerId);
}

/** A notification to oneself (of no team), to see that this browser and computer show them. */
async function sendTest(userId, ownerId) {
  await notify({
    userId,
    kind: 'test',
    title: 'Notifications are working',
    body: "This is how Liston tells you when a reviewer decides on a product you hunted.",
    url: null,
  });
  return list(userId, ownerId);
}

async function unsubscribe(userId, endpoint) {
  await notificationsRepository.deleteSubscription(userId, endpoint);
}

module.exports = { notify, notifyGrouped, readSubject, pushTo, list, markRead, clear, subscribe, unsubscribe, sendTest };
