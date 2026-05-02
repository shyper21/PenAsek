// =====================================================
// XpensesApp — Service Worker
// Strategy:
//   - App shell (HTML, JS CDN) → Cache First, fallback network
//   - Supabase API → Network First, fallback cache
//   - External images/gifs → Cache First (stale-while-revalidate)
// =====================================================

const CACHE_NAME     = 'xpenses-v1';
const RUNTIME_CACHE  = 'xpenses-runtime-v1';
const IMG_CACHE      = 'xpenses-images-v1';

// File yang dicache saat install (app shell)
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// =====================================================
// INSTALL — precache app shell
// =====================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// =====================================================
// ACTIVATE — hapus cache lama
// =====================================================
self.addEventListener('activate', event => {
  const validCaches = [CACHE_NAME, RUNTIME_CACHE, IMG_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => !validCaches.includes(key))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// =====================================================
// FETCH — routing strategy
// =====================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Supabase API → Network First (data harus fresh)
  //    Kalau offline, fallback ke cached response kalau ada
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  // 2. External images & GIFs (ibb.co, dll) → Cache First
  if (
    request.destination === 'image' ||
    url.hostname.includes('ibb.co') ||
    url.hostname.includes('cloudflareinsights')
  ) {
    event.respondWith(cacheFirst(request, IMG_CACHE, 7 * 24 * 60 * 60)); // 7 hari
    return;
  }

  // 3. CDN JS (Chart.js, dll) → Cache First
  if (url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // 4. App shell (index.html, manifest.json) → Cache First,
  //    update di background (stale-while-revalidate)
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    url.pathname === '/' ||
    url.pathname.endsWith('/index.html')
  ) {
    event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
    return;
  }

  // 5. Default → network
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

// =====================================================
// STRATEGY HELPERS
// =====================================================

/**
 * Cache First: cek cache dulu, kalau tidak ada baru fetch & simpan
 */
async function cacheFirst(request, cacheName, maxAgeSeconds = null) {
  const cache   = await caches.open(cacheName);
  const cached  = await cache.match(request);

  if (cached) {
    // Cek apakah cache sudah expired (opsional, pakai header Date)
    if (maxAgeSeconds) {
      const dateHeader = cached.headers.get('date');
      if (dateHeader) {
        const age = (Date.now() - new Date(dateHeader).getTime()) / 1000;
        if (age > maxAgeSeconds) {
          return fetchAndCache(request, cache);
        }
      }
    }
    return cached;
  }

  return fetchAndCache(request, cache);
}

/**
 * Network First: fetch dulu, kalau gagal pakai cache
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Simpan clone ke cache kalau sukses (hanya GET)
    if (request.method === 'GET' && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Offline fallback untuk API
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No network. Using cached data.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Stale While Revalidate: serve dari cache, update cache di background
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || fetchPromise;
}

/**
 * Fetch dan simpan ke cache
 */
async function fetchAndCache(request, cache) {
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Offline dan tidak ada cache — return empty offline page
    return new Response(
      `<!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Offline</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:system-ui;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}h1{color:#6366f1;font-size:2rem;margin-bottom:12px}p{color:#64748b;font-size:.9rem}</style>
      </head><body>
      <div><h1>💰</h1><h1>Kamu Offline</h1><p>Tidak ada koneksi internet.<br>Coba lagi nanti.</p></div>
      </body></html>`,
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// =====================================================
// BACKGROUND SYNC — retry saveData kalau offline
// (browser yang support Background Sync API)
// =====================================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-expenses') {
    event.waitUntil(syncPendingData());
  }
});

async function syncPendingData() {
  // Data sudah tersimpan di localStorage oleh app
  // Background sync ini hanya notify clients supaya re-try save
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_READY' });
  });
}

// =====================================================
// PUSH NOTIFICATION — siap untuk notif subscription
// =====================================================
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'XpensesApp', {
      body:    data.body    || '',
      icon:    data.icon    || 'https://i.ibb.co/VXq0RWQ/ur-pin-large-front-square-600x600-removebg-preview.png',
      badge:   data.badge   || 'https://i.ibb.co/VXq0RWQ/ur-pin-large-front-square-600x600-removebg-preview.png',
      tag:     data.tag     || 'xpenses-notif',
      data:    data.url     || '/',
      vibrate: [200, 100, 200],
      actions: data.actions || [],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        if (clientList.length > 0) {
          return clientList[0].focus();
        }
        return self.clients.openWindow(event.notification.data || '/');
      })
  );
});
