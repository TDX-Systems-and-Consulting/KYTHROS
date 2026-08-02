// PlannerXD service worker — app-shell caching only.
//
// PlannerXD is a single index.html (no separate versioned JS file like
// JOBSMETRIX's ?v=YYYYMMDDHHMM convention), so a plain cache-first
// strategy on the HTML itself would risk serving a stale shell after a
// real deploy with no way to bust it. Instead: network-first for the
// HTML document (always try to get the latest, fall back to cache only
// when offline), cache-first for genuinely static assets (icons,
// manifest). This deliberately never touches Firestore network calls —
// those have their own offline handling via Firestore's built-in
// persistence (enabled in initFirebase in index.html).
//
// Bump CACHE_NAME whenever the static asset list below changes.
const CACHE_NAME = 'plannerxd-shell-v1';

const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // HTML navigations (the app shell itself): network-first, so a real
  // deploy is visible on next load instead of stuck behind a cached
  // copy with no version stamp to bust it. Cache the fresh response as
  // we go so offline loads still work.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Everything else (manifest, icons): cache-first.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => undefined);
    })
  );
});
