/**
 * The DOM overlay.
 *
 * The game itself is canvas. Menus, lobbies and settings are real DOM sitting
 * in the #ui div above it, because a real <button> beats a hand-rolled canvas
 * menu on every axis that matters: keyboard, screen readers, text selection,
 * browser zoom, and the amount of code you have to write.
 *
 * One view at a time. Scenes call show() on enter and clear() on exit.
 */

// The stylesheet is bundled by Vite. `vite/client`, referenced from
// src/vite-env.d.ts, is what declares the CSS module so this typechecks.
import '@/ui/styles.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class Ui {
  private readonly root: HTMLElement;
  private view: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('ui-root');
  }

  /** The mounted view, or null when the overlay is empty. */
  get current(): HTMLElement | null {
    return this.view;
  }

  /** Replaces whatever was on screen with `view` and gives it focus. */
  show(view: HTMLElement): void {
    this.clear();
    view.classList.add('ui-view');
    this.root.appendChild(view);
    this.root.classList.add('has-view');
    this.view = view;
    const first = focusFirst(view);
    if (first) markCurrent(first);
    view.addEventListener('focusin', onFocusIn);
  }

  /**
   * Empties the overlay and hands the keyboard back to the game — otherwise a
   * focused menu button would keep eating Space while the fight is on.
   */
  clear(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    this.root.classList.remove('has-view');
    this.view = null;
  }
}

/**
 * Mirrors the in-game reduced-motion setting onto <html> so the stylesheet and
 * the ripple both obey it, not just the OS-level media query.
 */
export function setReducedMotion(on: boolean): void {
  document.documentElement.classList.toggle('reduced-motion', on);
}

/**
 * Moves focus into the freshly-mounted view so a keyboard player never has to
 * find the first control by tabbing in from the address bar. Returns what it
 * focused, or meant to.
 */
function focusFirst(view: HTMLElement): HTMLElement | null {
  const marked = view.querySelector('[autofocus]');
  const target =
    marked instanceof HTMLElement ? marked : view.querySelector<HTMLElement>(FOCUSABLE);
  if (!target) return null;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  return target;
}

/**
 * The menu item the player is "on", kept as an attribute as well as as focus.
 *
 * Focus alone is not enough to draw from: a page that has not been clicked yet
 * (opened from a link, the tab behind another window) does not have focus at
 * all, and an arcade menu with nothing lit looks dead. The stylesheet lights
 * `[data-current]` whenever nothing in its menu has real focus.
 */
function markCurrent(el: HTMLElement): void {
  const menu = el.closest('.menu');
  if (!menu) return;
  for (const other of menu.querySelectorAll('[data-current]')) other.removeAttribute('data-current');
  el.setAttribute('data-current', '');
}

function onFocusIn(e: FocusEvent): void {
  if (e.target instanceof HTMLElement) markCurrent(e.target);
}
