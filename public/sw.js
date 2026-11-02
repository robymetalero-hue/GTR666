const CACHE_VERSION = 'gtr-pos-v2.6.0-zero-cache';

// Installation phase - Purge any old caches & skip waiting immediately (Zero-Cache Online Mode)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activation phase - Purge all caches & take immediate control of clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          console.log('[PWA SW Zero-Cache] Eliminando caché del dispositivo:', key);
          return caches.delete(key);
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Network-Only Pass-Through: Never serve stale cached HTML, JS, CSS or API data from phone storage
self.addEventListener('fetch', () => {
  return; // Pass 100% of requests straight to the live network
});

// Native Web Push Notification Handler (for Installed PWA on Android/iOS/Desktop)
self.addEventListener('push', (event) => {
  let payload = {
    title: 'GTR POS — Nueva Venta Registrada',
    body: 'Se ha registrado una nueva operación de venta en el sistema.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'gtr-pos-sale-' + Date.now(),
    data: { url: '/', targetView: 'historial_ventas' }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        ...payload,
        ...parsed,
        data: {
          ...payload.data,
          ...(parsed.data || {})
        }
      };
    } catch (e) {
      try {
        payload.body = event.data.text();
      } catch (_) {}
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon || '/icon.svg',
    badge: payload.badge || '/icon.svg',
    tag: payload.tag || ('gtr-pos-sale-' + Date.now()),
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: payload.data || { url: '/', targetView: 'historial_ventas' }
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          client.postMessage({
            type: 'PUSH_NOTIFICATION_DISPLAYED',
            tag: notificationOptions.tag,
            title: payload.title,
            body: payload.body,
            data: notificationOptions.data
          });
        }
      });
    })
  );
});

// Notification Click Handler — Focuses or opens the installed PWA and navigates to the sale module
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const targetUrl = notifData.url || '/';
  const targetView = notifData.targetView || 'historial_ventas';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'NAVIGATE_FROM_PUSH',
            view: targetView,
            data: notifData
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// Direct control messages from application client
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data === 'SKIP_WAITING' || event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data === 'CLEAR_CACHES' || event.data.type === 'CLEAR_CACHES') {
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    });
  }
});
