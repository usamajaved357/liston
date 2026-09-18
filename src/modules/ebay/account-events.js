const { EventEmitter } = require('events');

// "This account's mirrored data just changed." Emitted whenever a listings,
// orders or count copy is refreshed from eBay — by a page view, a manual
// Refresh, or an eBay push notification — and streamed to every browser
// that has that account open, so the page updates without anyone reloading.
// Process-local; would become a Redis channel on several instances.
const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

function emitUpdated(connectionId, kind) {
  emitter.emit(`account:${connectionId}`, { type: 'updated', kind, at: new Date().toISOString() });
}

function subscribe(connectionId, handler) {
  const event = `account:${connectionId}`;
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

module.exports = { emitUpdated, subscribe };
