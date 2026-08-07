/**
 * THE menu navigation. One implementation, shared by every menu in the game.
 *
 * It used to live inside the pause menu, and the title screen, the map wall and
 * the results screens each grew their own. Four copies of "walk the focus ring
 * with a d-pad" is four copies of every trap in it, and none of the fixes ever
 * crossed from one to another: one copy learned that a button still held when a
 * menu opens must not read as a press, another learned that a held direction
 * needs a long delay before it starts repeating, and neither told the others. So
 * this is the one that knows all of it, and it is the one menus use.
 *
 * Two jobs. First, the gameplay keyboard handler suppresses Space's default
 * action (it is the jump button), which would otherwise stop Space activating a
 * focused button — so we listen in the capture phase and do it ourselves.
 * Second, it walks focus, nudges sliders and flips switches from a gamepad.
 */

import type { AudioBus } from '@/core/types';
import { Btn } from '@/core/types';

import { clamp } from '@/core/math';
import { GamepadSource, connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { isCapturing } from '@/engine/input/KeyboardSource';

import type { Ui } from '@/ui/Ui';
import { cancelActiveCapture } from '@/ui/KeyBindingEditor';
import { TOAST_ID } from '@/pwa/UpdatePrompt';

/**
 * Frames a held direction waits before it starts repeating, and the gap between
 * repeats after that.
 *
 * These have to be two numbers. With one, the first repeat lands as soon as the
 * gap does, so a tap that is a few frames long moves the focus twice — and on a
 * screen with exactly two things to focus, twice is back where you started and
 * the pad looks dead.
 */
const NAV_DELAY = 26;
const NAV_REPEAT = 11;

/** B / Circle / the right face button, and the left shoulder beside it. */
const BACK = Btn.Heavy | Btn.Grab;

/**
 * Keypresses this class has already acted on.
 *
 * The same event arrives twice — once through the window listener, once when
 * the host routes it on to the mounted scene — and a menu that walked its focus
 * on both would move two rows per press. Weak, so nothing is retained.
 */
const handled = new WeakSet<KeyboardEvent>();

/** True where the player is entering text rather than driving a menu. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  // A range or a checkbox is a control, not a field; those the menu still owns.
  return el.type !== 'range' && el.type !== 'checkbox' && !el.readOnly;
}

export interface MenuInputHooks {
  /** The mounted view, re-read each time because views get swapped. */
  ui(): Ui | null;
  audio: AudioBus;
  /** B / Escape. */
  onBack(): void;
  /** Start / Pause. Defaults to onBack. */
  onStart?(): void;
}

/**
 * Makes a DOM menu behave like a console menu: attach it when the view mounts,
 * detach it when the view goes away, and poll it once per frame in between.
 */
export class MenuInput {
  private readonly hooks: MenuInputHooks;
  private readonly pads = new Map<number, GamepadSource>();
  private prev = 0;
  private hold = 0;
  /** Cleared on every attach: the first poll after one only samples. */
  private primed = false;
  private attached = false;

  constructor(hooks: MenuInputHooks) {
    this.hooks = hooks;
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    this.primed = false;
    window.addEventListener('keydown', this.onKey, true);
  }

  detach(): void {
    if (this.attached && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKey, true);
    }
    this.attached = false;
    for (const src of this.pads.values()) src.dispose();
    this.pads.clear();
    this.prev = 0;
    this.hold = 0;
    this.primed = false;
  }

  /** Call once per frame while the menu is up. */
  poll(): void {
    pollGamepads();
    let mask = 0;
    for (const index of connectedGamepads()) {
      let src = this.pads.get(index);
      if (!src) {
        src = new GamepadSource(index);
        this.pads.set(index, src);
      }
      mask |= src.sample(0);
    }

    const dirs = Btn.Up | Btn.Down | Btn.Left | Btn.Right;

    // The button that opened the menu is still down on the frame the menu opens,
    // and against a fresh `prev` of zero that reads as a brand-new press — which
    // activated whatever was autofocused and closed the menu again in the same
    // frame it appeared. Swallowing the first mask outright is what stops it.
    if (!this.primed) {
      this.primed = true;
      this.prev = mask;
      // A direction held across the open serves the full delay before it starts
      // repeating, rather than repeating straight into a menu one frame old.
      this.hold = (mask & dirs) !== 0 ? NAV_DELAY : 0;
      return;
    }

    const pressed = mask & ~this.prev;

    let repeat = 0;
    if (mask & dirs) {
      if (this.hold > 0) this.hold--;
      else {
        repeat = mask & dirs;
        // A direction only now going down has its whole delay ahead of it; one
        // that has already been held carries on at the faster rate. Testing the
        // HELD-OVER bits rather than the whole mask matters: pressing a second
        // direction must not re-arm the long delay for the one already running.
        this.hold = (mask & this.prev & dirs) !== 0 ? NAV_REPEAT : NAV_DELAY;
      }
    } else {
      this.hold = 0;
    }
    // A fresh press always fires; a direction that is merely held fires on the
    // repeat tick, which is what stops a menu scrolling past at 60Hz.
    const move = (pressed & dirs) | (repeat & this.prev & dirs);
    this.prev = mask;

    // The binding editor is waiting for a key. Everything is still sampled so a
    // button held across the wait does not read as a fresh press afterwards,
    // but nothing acts on it: walking focus now would move the menu out from
    // under the row being rebound.
    if (isCapturing()) {
      // Back is the exception, and it has to be. A player who armed a capture
      // from a pad has no Escape key and no pointer to click away with, so
      // without this every pad button in their hands is inert for good — stuck
      // on the Controls page, and from the pause menu stuck in the fight.
      if (pressed & BACK) cancelActiveCapture();
      return;
    }

    if (move & Btn.Up) this.moveFocus(-1);
    else if (move & Btn.Down) this.moveFocus(1);
    else if (move & Btn.Left) this.adjust(-1);
    else if (move & Btn.Right) this.adjust(1);

    if (pressed & (Btn.Light | Btn.Jump)) this.activate();
    else if (pressed & BACK) this.hooks.onBack();
    else if (pressed & Btn.Pause) (this.hooks.onStart ?? this.hooks.onBack)();
  }

  /** Also exposed so a Game that routes DOM keys can call it directly. */
  readonly onKey = (e: KeyboardEvent): void => {
    if (!this.attached) return;
    // Reached twice for the same keypress: once through this window listener,
    // and again when the host routes the event on to the mounted scene. Marking
    // it is how the second visit is ignored — this used to be stopPropagation(),
    // which also aborted the rest of the capture path and took the WebAudio
    // unlock gesture listeners with it, so the title screen stayed silent for
    // anyone who opened it from the keyboard.
    if (handled.has(e)) return;
    // This handler is registered before the binding editor's own, so it would
    // otherwise get first refusal on the very keypress the editor is waiting
    // for: Escape would close the page instead of cancelling the capture, and
    // Space would re-click the button rather than becoming the new Jump key.
    if (isCapturing()) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // A room code being typed into is not a menu. Escape still backs out — a
    // text field is not a trap — but nothing else is taken off it.
    if (isTypingTarget(document.activeElement) && e.code !== 'Escape') return;

    if (e.code === 'Escape') {
      e.preventDefault();
      handled.add(e);
      this.hooks.onBack();
      return;
    }

    const view = this.hooks.ui()?.current ?? null;
    const active = document.activeElement;
    const inView = view !== null && active instanceof HTMLElement && view.contains(active);

    if (e.code === 'Space' && inView && active instanceof HTMLButtonElement) {
      // preventDefault stops the browser activating the button as well, which
      // would fire everything twice; the element's own keydown listeners still
      // run, which is how the ripple lands under the key.
      e.preventDefault();
      handled.add(e);
      active.click();
      return;
    }

    const vertical = e.code === 'ArrowUp' || e.code === 'ArrowDown';
    const horizontal = e.code === 'ArrowLeft' || e.code === 'ArrowRight';
    if (vertical || horizontal) {
      // Sliders own the arrow keys, and so does anything that implements the
      // roving-tab contract for itself — a tab strip that walks its own tabs
      // must not also walk the page behind it.
      if (active instanceof HTMLInputElement && active.type === 'range') return;
      if (active instanceof HTMLElement && active.getAttribute('role') === 'tab') return;
      // Left and Right walk the ring only where there is nothing to nudge;
      // where there is, they nudge it, which is what a pad's Left and Right do.
      if (horizontal) {
        if (this.adjust(e.code === 'ArrowRight' ? 1 : -1)) {
          e.preventDefault();
          handled.add(e);
        }
        return;
      }
      e.preventDefault();
      handled.add(e);
      this.moveFocus(vertical && e.code === 'ArrowUp' ? -1 : 1);
    }
  };

  private focusables(): HTMLElement[] {
    const sel =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const out: HTMLElement[] = [];
    // The mounted view, plus any transient layer that lives outside it. The
    // update toast is appended to <body> so scenes cannot clear it away, which
    // also put it outside the focus ring — a controller could see the Reload
    // button and had no way to press it.
    const roots = [this.hooks.ui()?.current ?? null, document.getElementById(TOAST_ID)];
    for (const root of roots) {
      if (!root) continue;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
        if (el.offsetParent !== null || el.getClientRects().length > 0) out.push(el);
      }
    }
    return out;
  }

  private moveFocus(dir: number): void {
    const items = this.focusables();
    if (items.length === 0) return;
    const active = document.activeElement;
    let i = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (i < 0) i = dir > 0 ? -1 : 0;
    const next = items[(i + dir + items.length) % items.length];
    if (!next) return;
    next.focus();
    // Focusing a control the browser cannot see does not bring it into view on
    // its own, and the bindings list is a scrolling column of dozens of rows: a
    // pad walking down it left the focus ring below the fold within a screenful.
    if (typeof next.scrollIntoView === 'function') next.scrollIntoView({ block: 'nearest' });
    this.hooks.audio.play('ui_move', { gain: 0.5 });
  }

  private activate(): void {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) {
      active.click();
      return;
    }
    if (active instanceof HTMLInputElement && active.type === 'checkbox') {
      active.checked = !active.checked;
      active.dispatchEvent(new Event('change', { bubbles: true }));
      this.hooks.audio.play('ui_select');
    }
  }

  private adjust(dir: number): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return false;

    if (active.type === 'range') {
      const min = Number(active.min);
      const max = Number(active.max);
      const step = Number(active.step) || 0.05;
      active.value = String(clamp(Number(active.value) + step * dir, min, max));
      active.dispatchEvent(new Event('input', { bubbles: true }));
      this.hooks.audio.play('ui_move', { gain: 0.4 });
      return true;
    }

    if (active.type === 'checkbox') {
      const want = dir > 0;
      if (active.checked === want) return true;
      active.checked = want;
      active.dispatchEvent(new Event('change', { bubbles: true }));
      this.hooks.audio.play('ui_select');
      return true;
    }
    return false;
  }
}
