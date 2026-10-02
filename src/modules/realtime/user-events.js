const { EventEmitter } = require('events');

// A live channel per person (GET /api/me/events): chat messages, edits,
// read receipts, typing, and unread counts for the Inbox's two modes reach
// every tab that person has open, and which conversation each tab is
// looking at comes back (POST /api/me/presence), so a push isn't sent about
// a conversation someone is already reading. Process-local, like the
// account stream; a Redis channel once there's more than one server.
const emitter = new EventEmitter();
emitter.setMaxListeners(5000);

// userId -> number of open streams (someone's online while it's above 0).
const streams = new Map();
// userId -> Map(tabId -> { view, focused, at }): what each open tab shows.
const views = new Map();
// A tab that hasn't said anything for this long is treated as gone.
const VIEW_TTL_MS = 2 * 60 * 1000;

function emit(userId, payload) {
  if (userId) emitter.emit(`user:${userId}`, payload);
}

function emitMany(userIds, payload) {
  for (const id of new Set(userIds)) emit(id, payload);
}

/** Streams a person's events to `handler`; returns the function that stops it. */
function subscribe(userId, handler) {
  const event = `user:${userId}`;
  emitter.on(event, handler);
  streams.set(userId, (streams.get(userId) || 0) + 1);
  return () => {
    emitter.off(event, handler);
    const left = (streams.get(userId) || 1) - 1;
    if (left > 0) streams.set(userId, left);
    else streams.delete(userId);
  };
}

const isOnline = (userId) => (streams.get(userId) || 0) > 0;

/**
 * What one of a person's tabs shows: `view` is a conversation key
 * ("chat:<id>", "ebay:<connectionId>:<conversationId>") or null, `focused`
 * whether the tab is the one in front.
 */
function setView(userId, tabId, { view = null, focused = false } = {}) {
  let tabs = views.get(userId);
  if (!tabs) views.set(userId, (tabs = new Map()));
  if (!view) tabs.delete(tabId);
  else tabs.set(tabId, { view, focused: Boolean(focused), at: Date.now() });
  if (!tabs.size) views.delete(userId);
}

/**
 * Whether the person is reading this conversation right now, in a tab in
 * front. A tab may show more than one at once, space-separated (a team
 * chat conversation and a thread open beside it).
 */
function isViewing(userId, view) {
  const tabs = views.get(userId);
  if (!tabs) return false;
  const now = Date.now();
  for (const [tabId, t] of tabs) {
    if (now - t.at > VIEW_TTL_MS) tabs.delete(tabId);
    else if (t.focused && String(t.view).split(' ').includes(view)) return true;
  }
  return false;
}

/** Test hook. */
function forget() {
  streams.clear();
  views.clear();
  emitter.removeAllListeners();
}

module.exports = { emit, emitMany, subscribe, isOnline, setView, isViewing, forget };
