// Service worker — caches the site shell and the last search response.
// Offline behavior: site loads, last search you did still appears.

var SHELL_CACHE = 'pgf-shell-v32';
var DATA_CACHE  = 'pgf-data-v32';

// Files that make up the shell — bumped version triggers re-cache
var SHELL_FILES = [
  '/',
  '/index.html',
  '/about.html',
  '/style.css',
  '/app.js',
  '/icon.svg',
  '/manifest.json'
];

// ---- Install: pre-cache the shell ----
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // addAll fails the whole install on any one error; use individual put for resilience
      return Promise.all(SHELL_FILES.map(function (url) {
        return fetch(url, { cache: 'reload' })
          .then(function (resp) { if (resp.ok) return cache.put(url, resp); })
          .catch(function () { /* ignore individual failures */ });
      }));
    })
  );
  self.skipWaiting();
});

// ---- Activate: clean up old caches ----
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== DATA_CACHE) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// ---- Fetch ----
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only handle GET. POST (e.g. /api/signals) bypasses the SW entirely.
  if (event.request.method !== 'GET') return;

  // API responses (Google Places search and weather): network-first, fall back to cache.
  if (url.pathname.startsWith('/api/places')) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }

  // Same-origin static assets: cache-first
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // Everything else (Google photo CDN, Leaflet tiles, fonts, etc.) — pass through
  // We don't try to cache cross-origin resources to keep the cache size bounded.
});

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (resp) {
      if (resp.ok) {
        var clone = resp.clone();
        caches.open(cacheName).then(function (c) { c.put(request, clone); });
      }
      return resp;
    });
  });
}

function networkFirst(request, cacheName) {
  return fetch(request).then(function (resp) {
    if (resp.ok) {
      var clone = resp.clone();
      caches.open(cacheName).then(function (c) { c.put(request, clone); });
    }
    return resp;
  }).catch(function () {
    return caches.match(request);
  });
}
