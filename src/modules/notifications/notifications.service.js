const notificationsRepository = require('./notifications.repository');
const push = require('./push');
const logger = require('../../utils/logger');

// What Liston tells a person: kept for the bell, and pushed to every browser
// they turned push notifications on in.

/**
 * Tells someone something: kept for the bell, then pushed in the background.
 * Never throws, since a failed notification must not undo the work that
 * caused it.
 */
async function notify({ userId, actorUserId = null, kind, title, body = null, url = null, subjectType = null, subjectId = null }) {
  if (!userId || !kind || !title) return null;
  let row;
  try {
    row = await notificationsRepository.insert({ userId, actorUserId, kind, title, body, url, subjectType, subjectId });
  } catch (err) {
    logger.warn('Notification not kept', { kind, error: err.message });
    return null;
  }
  // Pushed in the background: the action that caused it doesn't wait on the push services.
  pushTo(userId, { id: row.id, kind, title, body, url, tag: subjectId ? `${kind.split('.')[0]}-${subjectId}` : row.id }).catch((err) => logger.warn('Push not sent', { kind, error: err.message }));
  return row;
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

function shape(row) {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, url: row.url, readAt: row.read_at, createdAt: row.created_at };
}

async function list(userId) {
  const { rows, unread } = await notificationsRepository.listFor(userId);
  return { items: rows.map(shape), unread, push: { available: push.configured(), publicKey: push.publicKey() } };
}

async function markRead(userId, ids) {
  await notificationsRepository.markRead(userId, ids || null);
  return list(userId);
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

/** A notification to oneself, to see that this browser and computer show them. */
async function sendTest(userId) {
  await notify({
    userId,
    kind: 'test',
    title: 'Notifications are working',
    body: "This is how Liston tells you when a reviewer decides on a product you hunted.",
    url: null,
  });
  return list(userId);
}

async function unsubscribe(userId, endpoint) {
  await notificationsRepository.deleteSubscription(userId, endpoint);
}

module.exports = { notify, list, markRead, subscribe, unsubscribe, sendTest };
