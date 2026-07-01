// Weekly Monitor service worker — network-first for pages (so a password/interstitial
// page can never get cached and served as the app), cache-first for static assets.
const CACHE = 'wm-v10';
const SHELL = ['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-512-maskable.png'];

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(()=>{})); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (url.hostname.indexOf('finnhub.io') > -1) return;     // live data: network
  if (req.method !== 'GET') return;
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') > -1;
  if (isPage) {
    // network-first: always try the live page; only fall back to cache when offline
    e.respondWith(
      fetch(req).then(res => { if (res && res.status === 200) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put('./', c)); } return res; })
                .catch(() => caches.match('./').then(r => r || caches.match(req)))
    );
    return;
  }
  // static assets: cache-first
  e.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => {
    const ok = res && res.status === 200 && (url.origin === location.origin || url.hostname.indexOf('gstatic') > -1 || url.hostname.indexOf('googleapis') > -1);
    if (ok) { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
    return res;
  }).catch(() => cached)));
});
