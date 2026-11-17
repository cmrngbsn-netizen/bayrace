const SHELL = 'shell-v1', TILES = 'tiles-v1', MAX_TILES = 4000;
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'data/marks.json', 'lib/leaflet.js', 'lib/leaflet.css',
  'lib/images/marker-icon.png', 'lib/images/layers.png', 'lib/images/layers-2x.png', 'icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {           // app shell: network-first so edits show up, cache fallback offline
    e.respondWith(fetch(e.request).then(r => { caches.open(SHELL).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request, {ignoreSearch: true})));
  } else if (/\/tile\/|\/\d+\/\d+\/\d+\.png|WMSServer$/.test(u.pathname)) {   // map tiles: cache-first, filled as you browse
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); c.keys().then(k => k.length > MAX_TILES && c.delete(k[0])); }
      return r;
    }));
  }
});
