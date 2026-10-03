/*
 * sw.js — orbit's service worker (makes the hosted website installable and usable offline).
 *
 * A "service worker" is a tiny script the browser runs in the background, separate from the page.
 * It can intercept network requests and answer them from a cache, so after your first visit orbit
 * loads instantly and keeps working with no connection. Your data already lives in the browser
 * (localStorage), so offline orbit is fully usable for everything that doesn't need the internet.
 *
 * Strategy:
 *   - APP SHELL (this site's own files: html, css, js, icons, manifest) → "cache-first": serve from
 *     cache for speed, and refresh the cache in the background when online ("stale-while-revalidate").
 *   - EVERYTHING ELSE (AI providers, job APIs, Google Fonts, /api/*) → "network-only": never cached,
 *     because these are live calls (and must never store secrets or stale results).
 *
 * All URLs are relative so this works at a domain root OR under a subpath like github.io/orbit/.
 * Bump CACHE_VERSION whenever the app files change so visitors get the update.
 */

// Change this string to force every browser to download fresh files on the next visit.
const CACHE_VERSION = 'orbit-v1';

// The app-shell files to pre-cache on install. Relative paths resolve against the service worker's
// own location (its scope), so under /orbit/ these become /orbit/index.html, etc.
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
  // JS modules (the whole app).
  'js/app.js',
  'js/ai.js',
  'js/byoai.js',
  'js/webjobs.js',
  'js/store.js',
  'js/ui.js',
  'js/util.js',
  'js/cselect.js',
  'js/modelpicker.js',
  'js/dashboard.js',
  'js/calendar.js',
  'js/syllabus.js',
  'js/notes.js',
  'js/chat.js',
  'js/focus.js',
  'js/degree.js',
  'js/degree-engine.js',
  'js/examprep.js',
  'js/careers.js',
  'js/fileread.js',
  'js/settings.js',
  'js/spotify.js',
];

// install: open the cache and add every shell file. We use individual, failure-tolerant adds so one
// missing/renamed file can't abort the whole install.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => { /* skip anything that 404s */ })));
    // Activate this new worker immediately instead of waiting for all tabs to close.
    self.skipWaiting();
  })());
});

// activate: delete old caches from previous versions, then take control of open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// isShellRequest(req): is this a GET for one of our OWN files (same origin, not an API call)?
function isShellRequest(req, url) {
  if (req.method !== 'GET') return false;
  // Only handle same-origin requests here; external calls (AI, jobs, fonts) go straight to network.
  if (url.origin !== self.location.origin) return false;
  // Never cache API calls (they're live, and only exist in local-server mode anyway).
  if (url.pathname.includes('/api/')) return false;
  return true;
}

// fetch: decide how to answer each request.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // External requests and APIs: just go to the network (don't touch the cache).
  if (!isShellRequest(req, url)) return;

  // App shell: stale-while-revalidate. Answer from cache immediately if we have it, and update the
  // cache in the background. For navigations (opening the app) fall back to the cached index.html so
  // the single-page app still boots offline even on a deep link.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      // Save a copy of successful, basic (same-origin) responses for next time.
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    // Prefer the cached copy for speed; otherwise wait for the network.
    if (cached) return cached;
    const fromNet = await network;
    if (fromNet) return fromNet;

    // Offline and not cached: for a page navigation, serve the app shell so orbit still loads.
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
    }
    return Response.error();
  })());
});
