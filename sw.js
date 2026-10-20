/* Exhibitor Leads service worker: works offline, picks up updates on the next open. */
const CACHE = 'exhibitorleads-v17';   // bump on every release, together with core.js?v= in index.html
const SHELL = ['./', 'index.html', 'core.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'google.png', 'microsoft.png'];

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's own copy, so the offline set is always the release just published
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: network first so updates arrive straight away, cache when offline.
  // 'no-cache' asks GitHub every time (a quick "unchanged" when nothing is new), so the
  // phone never mixes a new page with an older script it kept from the last 10 minutes.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        // a shared page arrives as index.html?title=...&url=..., so the saved copy is kept under the plain address
        const net = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
        const res = await Promise.race([
          net,
          new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000)),
        ]);
        if (res.ok) cache.put(req.mode === 'navigate' ? new Request(url.origin + url.pathname) : req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) ||
          (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
      }
    })());
    return;
  }

  // Fonts: cache first
  if (FONTS.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
  }
  // Everything else (your Apps Script web app, Google searches) goes straight to the network
});
