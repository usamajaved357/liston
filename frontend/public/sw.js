// Liston's service worker: shows browser push notifications (a reviewer
// approved, rejected or sent back a hunted product; a team chat or eBay
// message) and opens Liston at the right page when one is clicked. It caches
// nothing.
//
// While a Liston tab is open and in view, that tab shows the notification
// itself (a card and a chime, whatever the computer's own notification
// settings); otherwise the system shows it, with its own sound.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Liston", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Liston";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      const message = { type: "liston:notification", id: data.id, title, body: data.body || "", url: data.url || null, kind: data.kind || null };
      tabs.forEach((tab) => tab.postMessage(message));
      // A Liston tab in view shows it; the system notification would only repeat it.
      if (tabs.some((tab) => tab.visibilityState === "visible" && tab.focused)) return;
      return self.registration.showNotification(title, {
        body: data.body || "",
        icon: "/notification-icon.png",
        badge: "/notification-badge.png",
        // One notification per product or conversation: a newer one replaces the older, and still alerts.
        tag: data.tag || data.id,
        // An eBay buyer's message shows the item's photo.
        image: data.image || undefined,
        renotify: true,
        silent: false,
        vibrate: [120, 60, 120],
        timestamp: Date.now(),
        data: { url: data.url || "/", id: data.id },
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      // A Liston tab already open goes to the page; otherwise a new one opens.
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      // (navigate only works on a tab this worker controls; any other gets a new one.)
      if (tab) return tab.focus().then((t) => t.navigate(target)).catch(() => self.clients.openWindow(target));
      return self.clients.openWindow(target);
    })
  );
});
