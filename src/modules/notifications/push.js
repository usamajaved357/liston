const webpush = require('web-push');
const config = require('../../config');

// The browser push adapter (Web Push, VAPID): the one place Liston talks to
// browsers' push services. Off until the VAPID keys are set.

let ready = false;
function configured() {
  if (ready) return true;
  const { publicKey, privateKey, subject } = config.push;
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  ready = true;
  return true;
}

const publicKey = () => (configured() ? config.push.publicKey : null);

/**
 * Sends one push. Returns { sent } or { gone } when the push service says
 * the subscription no longer exists (so it's forgotten); other failures
 * throw.
 */
async function send(subscription, payload, { sendImpl = webpush.sendNotification } = {}) {
  if (!configured()) return { sent: false };
  try {
    await sendImpl({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), { TTL: 24 * 60 * 60, urgency: 'normal' });
    return { sent: true };
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return { gone: true };
    throw err;
  }
}

module.exports = { configured, publicKey, send };
