// STARMART POS — Service Worker
// Bump this version string any time you want to force a cache refresh
const VERSION = 'starmart-v5';

// ── Install: cache the app shell immediately ──────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      cache.addAll(['/', '/index.html']).catch(() => {})
    )
  );
  self.skipWaiting();
});

// ── Activate: delete every old cache ─────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // 1. Different hostname = API backend → network only
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // 2. /api/* on same host → network only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // 3. Navigation (page refresh) → network first, cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(req);
          if (networkRes.ok) {
            const cache = await caches.open(VERSION);
            cache.put('/index.html', networkRes.clone());
          }
          return networkRes;
        } catch {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return new Response(
            '<h2 style="font-family:sans-serif;padding:40px">App not cached yet. Please visit once while online first.</h2>',
            { status: 503, headers: { 'Content-Type': 'text/html' } }
          );
        }
      })()
    );
    return;
  }

  // 4. Static assets (Vite JS/CSS bundles) → cache first
  const isAsset = (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.js')    ||
    url.pathname.endsWith('.mjs')   ||
    url.pathname.endsWith('.css')   ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff')  ||
    url.pathname.endsWith('.ttf')   ||
    url.pathname.endsWith('.png')   ||
    url.pathname.endsWith('.jpg')   ||
    url.pathname.endsWith('.jpeg')  ||
    url.pathname.endsWith('.webp')  ||
    url.pathname.endsWith('.svg')   ||
    url.pathname.endsWith('.ico')
  );

  if (isAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const networkRes = await fetch(req);
          if (networkRes.ok) {
            const cache = await caches.open(VERSION);
            cache.put(req, networkRes.clone());
          }
          return networkRes;
        } catch {
          return new Response('Asset unavailable offline', { status: 503 });
        }
      })()
    );
    return;
  }

  // 5. Everything else → network with cache fallback
  event.respondWith(
    (async () => {
      try {
        const networkRes = await fetch(req);
        if (networkRes.ok) {
          const cache = await caches.open(VERSION);
          cache.put(req, networkRes.clone());
        }
        return networkRes;
      } catch {
        const cached = await caches.match(req);
        return cached || new Response('Offline', { status: 503 });
      }
    })()
  );
});

// Allow the page to trigger skipWaiting (used during auto-update)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});