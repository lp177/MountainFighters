/*
 * Mountain Fighters — service worker.
 *
 * Not built by Vite: the placeholder constants below are substituted by the
 * plugin in vite.config.ts, which is the only thing that knows the hashed file
 * names. It runs in ServiceWorkerGlobalScope, so nothing here may import from
 * the app — a service worker that drags the game into its own scope is a
 * service worker that reinstalls itself every time the game changes.
 *
 * ── The strategy ───────────────────────────────────────────────────────────
 *
 * The game is a static bundle with no server behind it, and the precache is
 * COMPLETE: every file the game will ever ask for is in the cache before this
 * worker is allowed to control anything. That is the load-bearing fact, and
 * everything else follows from it.
 *
 *   navigations     answered from the precached shell. Never re-fetched, never
 *                   re-stored, never written to at runtime.
 *   hashed assets   answered from the precache. The hash IS the version.
 *   anything else   passed straight through to the network, uncached.
 *
 * ── Why nothing is written at runtime ──────────────────────────────────────
 *
 * An earlier version refreshed the shell in the background "so the copy on disk
 * stays current". It refreshed it INTO THE RUNNING BUILD'S CACHE, so after a
 * deploy that cache held the new index.html next to the old hashed assets — an
 * incoherent pair. The next offline load asked for chunks that were in no cache
 * on the machine and rendered a blank page, permanently, with no way back on
 * GitHub Pages. Three independent reviewers reproduced it.
 *
 * There was never anything to gain: a cache is per-build and its shell is only
 * valid alongside its own assets. New shells arrive the only way they can, with
 * a new worker.
 *
 * ── How anyone sees a new version ──────────────────────────────────────────
 *
 * The browser re-fetches THIS FILE on navigation and whenever the page asks,
 * and its contents change exactly when the shipped bytes do. A new worker
 * installs into its OWN cache, waits, and the page offers the player a reload.
 * It never calls skipWaiting itself: activating under a running fight would
 * swap the bundle beneath it.
 *
 * ── The rules this file must never break ───────────────────────────────────
 *
 * 1. Install is all-or-nothing. A partial precache must FAIL, so the previous
 *    worker keeps serving a complete one. A half-cached build that reaches
 *    `waiting` is a blank page dressed up as an upgrade.
 * 2. No handler may reject. `respondWith` on a rejected promise is a network
 *    error for the document — strictly worse than having no worker at all — so
 *    every path degrades to the network and then to a legible response.
 * 3. Cross-origin is never touched. The PeerJS broker and the TURN credential
 *    endpoint must reach the network every time, and a stale ICE grant is worse
 *    than no ICE grant.
 */

const BUILD = 'e6363db3d0fd';
/** Namespaced by scope: two copies of the game on one origin must not reap each other's caches. */
const PREFIX = `mountainfighters:${new URL(self.registration.scope).pathname}:`;
const CACHE = `${PREFIX}${BUILD}`;

const PRECACHE = [
  "./",
  "./assets/index-CRCZkXvh.css",
  "./assets/index-DGbLEHTS.js",
  "./assets/peer-BsvW7Dtp.js",
  "./icon-maskable.svg",
  "./icon.svg",
  "./index.html",
  "./manifest.webmanifest",
  "./social-card.png"
];
/** Content-hashed output, named by the build rather than guessed from the shape of a filename. */
const IMMUTABLE = new Set([
  "./assets/index-CRCZkXvh.css",
  "./assets/index-DGbLEHTS.js",
  "./assets/peer-BsvW7Dtp.js"
]);

/** Absolute URL for a scope-relative precache path, which is how entries are keyed. */
function scoped(path) {
  return new URL(path, self.registration.scope).href;
}

const PRECACHE_URLS = new Set(PRECACHE.map(scoped));
const IMMUTABLE_URLS = new Set([...IMMUTABLE].map(scoped));
const SHELL = scoped('./index.html');
const ROOT = scoped('./');

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // All of it, or none of it. addAll rejects the whole install if any one
      // request fails, which is exactly what we want: the worker never reaches
      // `waiting`, the player is never told a broken build is "already
      // downloaded", and the previous complete cache keeps serving.
      //
      // `reload` for the two unhashed entries only. The hashed assets were just
      // pulled by the page and sitting in the HTTP cache; forcing those past it
      // doubles the download of the entire game on first visit.
      const fresh = [ROOT, SHELL];
      await Promise.all([
        cache.addAll(fresh.map((url) => new Request(url, { cache: 'reload' }))),
        cache.addAll(PRECACHE.map(scoped).filter((url) => !fresh.includes(url))),
      ]);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only reap once this build's cache is provably complete. If it is not,
      // leave every generation alone: a stale cache beats no cache.
      let complete = false;
      try {
        const cache = await caches.open(CACHE);
        const held = new Set((await cache.keys()).map((r) => r.url));
        complete = [...PRECACHE_URLS].every((url) => held.has(url));
      } catch {
        complete = false;
      }

      if (complete) {
        const names = await caches.keys();
        await Promise.all(
          names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)),
        );
      }

      // Navigation preload would race a cache hit for no gain.
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.disable();
        } catch {
          /* not supported here; nothing to disable */
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'BUILD_ID' && event.source) {
    event.source.postMessage({ type: 'BUILD_ID', build: BUILD });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Someone else's server. The broker and the TURN grant both live out there
  // and both must be asked fresh, every time.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(serveShell(req));
    return;
  }

  // Only what we precached is ours to answer. Everything else — a same-origin
  // fetch the game makes at runtime, a file added to the server later — goes to
  // the network untouched, so it can still honour its own cache directives.
  const key = url.origin + url.pathname;
  if (IMMUTABLE_URLS.has(key) || PRECACHE_URLS.has(key)) {
    event.respondWith(fromCache(req, key));
  }
});

/**
 * Navigations are answered from the precached shell, with the query string
 * ignored — an invite link carries `?room=<id>`, and caching one shell per room
 * would grow the cache forever for no benefit. Nothing is written back.
 */
async function serveShell(req) {
  try {
    const cache = await caches.open(CACHE);
    const hit =
      (await cache.match(SHELL)) ??
      (await cache.match(ROOT)) ??
      (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
  } catch {
    /* storage is unavailable; the network is still worth a try */
  }
  return networkOr(
    req,
    'Mountain Fighters is offline, and this build was never finished downloading.',
  );
}

async function fromCache(req, key) {
  try {
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(key)) ?? (await cache.match(req));
    if (hit) return hit;
  } catch {
    /* fall through to the network */
  }
  return networkOr(req, 'Mountain Fighters could not load part of itself.');
}

/**
 * The last line of rule 2: this never throws. A worker that lets a rejection
 * reach respondWith turns a working site into a browser error page, and the
 * player has no way to unregister it.
 */
async function networkOr(req, message) {
  try {
    return await fetch(req);
  } catch {
    return new Response(message, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
