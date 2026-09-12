// sw.js — service worker for push notifications.
//
// Deliberately minimal: no offline caching, no asset interception. Its only job
// is to be alive when a push arrives (which is what lets notifications land with
// the browser closed) and to focus the app when one is tapped.

self.addEventListener('install', (event) => {
  // Take over immediately instead of waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: '6ix Glazer', body: event.data ? event.data.text() : 'Someone had a beer.' };
  }

  const title = payload.title || '6ix Glazer Terminal';
  const options = {
    body: payload.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    // Same tag => a new beer replaces the last notification instead of stacking
    // 50 of them on the lock screen.
    tag: payload.tag || 'beer-counter',
    // Android vibrates with this pattern; iOS ignores it and uses its own.
    vibrate: [90, 50, 90],
    renotify: true,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an already-open tab if there is one, otherwise open the app.
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
