/*
 * Mountain Fighters — service worker.
 *
 * Not built by Vite: the two placeholder constants below are substituted by the
 * plugin in vite.config.ts, which is the only thing that knows the hashed file
 * names. It runs in ServiceWorkerGlobalScope, so nothing here may import from
 * the app — a service worker that drags the game into its own scope is a
 * service worker that reinstalls itself every time the game changes.
 *
 * ── The strategy, and why ──────────────────────────────────────────────────
 *
 * The game is a single static bundle with no server behind it. Once it is on
 * the machine there is no reason to ask the network for it again, so:
 *
 *   hashed assets   cache-first, forever. The hash IS the version; a file that
 *                   is in the cache under that name can never be stale.
 *   navigations     cache-first with a network fallback. This is what makes it
 *                   start instantly and work on a train.
 *   everything else stale-while-revalidate: served from cache at once, and
 *                   quietly refreshed for next time.
 *
 * Cache-first everywhere would normally mean never seeing a new version. It
 * does not here, because the browser re-fetches THIS FILE on every navigation
 * and whenever the page asks for an update — and this file's contents change
 * whenever the shipped bytes do. So the update channel is the worker itself,
 * not any cached response. When a new one installs it waits, tells the page,
 * and the page offers the player a reload. Nobody is interrupted mid-fight.
 *
 * Cross-origin is never touched. The PeerJS broker and the TURN credential
 * endpoint must reach the network every time, and a stale ICE grant is worse
 * than no ICE grant.
 */

const BUILD = '__BUILD_ID__';
const CACHE = `mountainfighters-${BUILD}`;
const PRECACHE = __PRECACHE__;

/** Hashed build output. Immutable by construction — the name contains the hash. */
function isImmutable(url) {
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one 404 does not throw away the whole install. A
      // missing file will simply be fetched on demand later.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const url = new URL(path, self.registration.scope);
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline during install; the runtime handlers will cope */
          }
        }),
      );
      // Deliberately NOT skipWaiting() here. A new worker waits until the
      // player says so, because activating under a running fight would swap the
      // bundle beneath it.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('mountainfighters-') && n !== CACHE)
          .map((n) => caches.delete(n)),
      );
      // Navigation preload would race the cache-first path for no gain.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable();
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

  const url = new URL(req.url);
  // Someone else's server. The broker and the TURN grant both live out there
  // and both must be asked fresh, every time.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigateFirst(req));
    return;
  }
  if (isImmutable(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

/**
 * A navigation is answered from the cache when we have it, so the game opens
 * at the speed of a local file and opens at all on a dead connection. The
 * network is still asked, in the background, so the copy on disk stays current
 * for the visit after this one.
 */
async function navigateFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(req)) ?? (await cache.match('./')) ?? (await cache.match('./index.html'));
  if (cached) {
    void refresh(cache, req);
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
    return new Response('Mountain Fighters is offline and was never cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = refresh(cache, req);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  return new Response('', { status: 504 });
}

async function refresh(cache, req) {
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return null;
  }
}
