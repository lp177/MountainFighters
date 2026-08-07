/**
 * "There is a new build" — the one thing the service worker is allowed to
 * interrupt the player with.
 *
 * A toast rather than a dialog, in the corner rather than over the fight,
 * because the update is never urgent: the game the player is holding works. It
 * waits as long as it takes, survives being ignored, and is dismissible.
 *
 * Keyboard: it takes no focus when it appears — stealing focus mid-fight would
 * be worse than the stale build — but it is reachable by Tab, both buttons are
 * real buttons, and Escape dismisses it while focus is inside. Rendered into
 * its own layer, NOT `#ui`, which scenes clear whenever they change view.
 */

import { attachRipple } from '@/ui/Widgets';

const LAYER_ID = 'sw-toast';

let host: HTMLElement | null = null;

/**
 * Show the toast. `onApply` reloads into the new build; the toast is left on
 * screen while that happens, because the page is about to go away anyway and a
 * button that vanishes on click reads as a button that did nothing.
 */
export function showUpdatePrompt(onApply: () => void): void {
  if (host) return;

  const box = document.createElement('div');
  box.id = LAYER_ID;
  box.className = 'sw-toast';
  box.setAttribute('role', 'status');
  // Polite: it must not cut across a screen reader mid-sentence.
  box.setAttribute('aria-live', 'polite');

  const text = document.createElement('div');
  text.className = 'sw-toast__text';
  const title = document.createElement('strong');
  title.textContent = 'A NEW BUILD LANDED';
  const body = document.createElement('span');
  body.textContent = 'Already downloaded. Reload whenever you are between fights.';
  text.append(title, body);

  const row = document.createElement('div');
  row.className = 'sw-toast__row';

  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'btn btn--text';
  later.textContent = 'Later';
  later.addEventListener('click', dismiss);
  attachRipple(later);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'btn btn--filled';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => {
    reload.disabled = true;
    reload.textContent = 'Reloading…';
    onApply();
  });
  attachRipple(reload);

  row.append(later, reload);
  box.append(text, row);

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  });

  document.body.appendChild(box);
  host = box;

  // One frame later, so the transition has a start state to run from.
  requestAnimationFrame(() => box.classList.add('is-in'));
}

function dismiss(): void {
  const box = host;
  if (!box) return;
  host = null;
  box.classList.remove('is-in');
  // Leaves on the same curve it arrived on, and is gone either way — a toast
  // that outlives a cancelled transition is a toast that never leaves.
  window.setTimeout(() => box.remove(), 260);
}
