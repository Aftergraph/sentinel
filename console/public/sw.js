'use strict';
/* Sentinel Console service worker — app shell only, never verdict data.
 * Cached: /, /index.html, /styles.css, /app.js, /manifest.webmanifest.
 * /api/* is network-only (network-first, never cached): stale verdicts
 * must never render as fresh.
 */

const CACHE = 'sentinel-console-v1';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function shellPath(pathname) {
  if (pathname === '/') return '/';
  return APP_SHELL.includes(pathname) ? pathname : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Verdict data: network-only, never cached.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // App shell: cache-first, refresh cache in background.
  if (shellPath(url.pathname) !== null) {
    event.respondWith(
      caches.match(req, { ignoreSearch: false }).then((hit) => {
        const fetched = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        });
        return hit || fetched;
      })
    );
  }
  // Everything else: passthrough, never cached.
});
