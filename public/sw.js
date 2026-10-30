const CACHE_VERSION = 'gtr-pos-v2.4.2-cache';
const CACHE_NAME = CACHE_VERSION;
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg'
];

// Installation phase - Pre-caching baseline shell & skip waiting immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => {
      return self.skipWaiting();
    }).catch(err => {
      console.warn('[PWA SW] Pre-loading cache warning (non-fatal):', err);
    })
  );
});

// Activation phase - Purge all deprecated caches & take immediate control of clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[PWA SW] Eliminando caché obsoleta:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetching network requests & intelligent caching without web/PWA bundle conflicts
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. ABSOLUTE BYPASS: Never intercept or cache Service Worker itself, registerSW, API routes, WebSockets, or version manifest
  if (
    url.pathname === '/sw.js' ||
    url.pathname === '/registerSW.js' ||
    url.pathname === '/service-worker.js' ||
    url.pathname.endsWith('/sw.js') ||
    url.pathname.startsWith('/api') ||
    url.pathname.includes('socket') ||
    url.pathname.includes('/live') ||
    url.pathname.includes('/alerts') ||
    url.pathname.endsWith('/version.json')
  ) {
    return; // Pass through straight to network
  }

  // 2. Vite development & live HMR bypass: Never cache raw dev files so code changes reflect instantly
  if (
    url.pathname.startsWith('/@') ||
    url.pathname.includes('/src/') ||
    url.pathname.includes('node_modules') ||
    url.search.includes('t=') ||
    url.search.includes('v=')
  ) {
    return; // Pass through straight to network
  }

  // 3. Navigation Mode (HTML entry points): Network-First with rapid fallback to offline cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }

  // 4. JavaScript & CSS Bundles: Network-First falling back to Cache (prevents stale JS/CSS conflicts between WebApp and PWA)
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // 5. Static visual & font assets (icons, manifest, fonts): Stale-While-Revalidate
  const isStaticAsset =
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.json');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 6. Default fallback: Network-First falling back to Cache
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
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
