/**
 * The page's half of the service worker.
 *
 * Registers it, keeps asking whether there is a newer one, and hands the answer
 * to whoever wants to tell the player. Nothing here draws anything: the prompt
 * is UpdatePrompt's job, so the policy and the pixels stay apart.
 *
 * ── Why it polls at all ────────────────────────────────────────────────────
 *
 * The worker serves the game cache-first, which is what makes it start
 * instantly and work with no connection. The cost of that bargain is that the
 * page will happily run a build from last week forever unless something goes
 * and looks. `registration.update()` is that something. It is cheap — one
 * conditional request for a file of a few kilobytes — and it is the ONLY thing
 * on the critical path for noticing a new release, so it runs:
 *
 *   - once on load, after the game has settled;
 *   - whenever the tab comes back to the foreground, throttled;
 *   - on a slow timer, for the browser left open on a second monitor all week.
 *
 * When the browser finds a different worker it installs it and parks it in
 * `waiting`. That is the moment there is genuinely something to download and
 * genuinely something to tell the player about.
 */

/** How long between background checks. Fifteen minutes is not a burden. */
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** Foreground checks closer together than this are ignored. */
const CHECK_THROTTLE_MS = 60 * 1000;

export interface UpdateHandle {
  /** Apply the waiting build and reload. Never returns; the page goes away. */
  apply(): void;
}

export interface SwOptions {
  /** Called once, when a new build is installed and waiting to take over. */
  onUpdateReady(handle: UpdateHandle): void;
  /** Called once the game is running entirely from the cache. */
  onOfflineReady?(): void;
}

let lastCheck = 0;
let reloading = false;

/**
 * Start the worker. Safe to call unconditionally: it does nothing in dev, on a
 * browser without service workers, or on a page served over plain http from
 * anywhere but localhost — all three would otherwise throw where nobody looks.
 */
export function installServiceWorker(opts: SwOptions): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!self.isSecureContext) return;

  window.addEventListener('load', () => {
    void start(opts);
  });
}

async function start(opts: SwOptions): Promise<void> {
  let reg: ServiceWorkerRegistration;
  try {
    // Relative, so the scope follows the base path: the same bundle registers
    // at /MountainFighters/ on Pages and at / on a local preview.
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    // A failed registration must never take the game down with it. The player
    // loses offline play and gets no update prompt; they still get the game.
    console.warn('[mountainfighters] service worker did not register:', err);
    return;
  }

  // Already parked from a previous visit the player did not act on.
  if (reg.waiting && navigator.serviceWorker.controller) announce(reg, opts);

  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener('statechange', () => {
      if (next.state !== 'installed') return;
      if (navigator.serviceWorker.controller) {
        // There was a controller before this one, so this is an UPDATE rather
        // than a first install. Only then is there anything to announce.
        announce(reg, opts);
      } else {
        opts.onOfflineReady?.();
      }
    });
  });

  // The worker calls skipWaiting when the player accepts; the browser then
  // swaps controller under us, and that is the cue to reload into the new one.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return;
    reloading = false;
    location.reload();
  });

  const check = (): void => {
    const now = Date.now();
    if (now - lastCheck < CHECK_THROTTLE_MS) return;
    lastCheck = now;
    reg.update().catch(() => {
      /* offline, or the server is having a day. Try again later. */
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', check);
  window.setInterval(check, CHECK_EVERY_MS);
}

function announce(reg: ServiceWorkerRegistration, opts: SwOptions): void {
  const waiting = reg.waiting;
  if (!waiting) return;
  opts.onUpdateReady({
    apply(): void {
      reloading = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // If the swap does not happen — a worker that failed to activate, a
      // browser being strange — reload anyway rather than leave a dead button.
      window.setTimeout(() => {
        if (reloading) {
          reloading = false;
          location.reload();
        }
      }, 3000);
    },
  });
}
