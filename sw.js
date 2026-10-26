const VERSION = '__VERSION__';
const CACHE = 'edupulse-' + VERSION;
const SHELL = [
  '/',
  '/styles.css?v=' + VERSION,
  '/app.js?v=' + VERSION,
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'clear-caches') {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { body: e.data ? e.data.text() : '' };
  }
  const title = data.title || 'Навчальний Пульс';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'journal',
      renotify: true,
      data: { url: data.url || '/#/journal' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#/journal';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          return c.focus().then(() => (c.navigate ? c.navigate(url) : null));
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Помилки не кешуємо.
function cacheable(res) {
  if (!res || !res.ok) return false;
  const cc = res.headers.get('cache-control') || '';
  if (/no-store|private/i.test(cc)) return false;
  return true;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('', { status: 504 })))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: 'offline' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        })))
    );
    return;
  }

  const shellFiles = ['/app.js', '/styles.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
  if (shellFiles.includes(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || new Response('', { status: 504 })))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => new Response('', { status: 504 })))
  );
});
