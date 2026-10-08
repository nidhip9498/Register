// Keeps the app's own files on the device so it opens with no signal.
// Patient data is not stored here; it lives in the app's local database.
const VERSION = 'ward-register-v14';
const FILES = ['./', 'index.html', 'app.js', 'store.js', 'sync.js', 'style.css', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// App files: open instantly from the saved copy, and refresh that copy in the background.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const saved = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; });
    if (saved) { fresh.catch(() => {}); return saved; }
    return fresh.catch(() => c.match('index.html'));
  }));
});
