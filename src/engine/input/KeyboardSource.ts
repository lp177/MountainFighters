/**
 * The shared keyboard.
 *
 * One listener pair serves every KeyboardSource in the game: two players on one
 * board is the common case, and four `keydown` handlers fighting over the same
 * event is not a design.
 *
 * Two things here are easy to get wrong and loud when you do:
 *
 *  - The set of keys whose default action we suppress must follow the CURRENT
 *    bindings, not the shipped defaults. Bind Jump to PageDown, forget to
 *    refresh, and the page scrolls every time you jump.
 *  - While the rebinding editor is listening for a key, this module must be
 *    completely deaf: no preventDefault, no held state, nothing. Otherwise the
 *    key you just pressed to rebind Jump also makes you jump, and the one you
 *    were holding stays welded down after the editor closes.
 */

import type { BtnMask, InputSource } from '@/core/types';
import { DEFAULT_BINDINGS, labelForBindings } from '@/engine/input/Bindings';

/** Shared across every KeyboardSource — one listener pair for the whole game. */
const held = new Set<string>();

/**
 * Keys the game owns. Their default action (page scroll, caret movement,
 * numpad navigation) is suppressed so a fight never scrolls the document.
 * Escape is deliberately left alone so the browser keeps its own behaviour.
 *
 * Seeded from the defaults so the very first frame after boot is already safe,
 * then replaced by refreshOwnedKeys() as soon as anyone knows better.
 */
let owned = ownedFrom(DEFAULT_BINDINGS);

/** True while the rebinding editor has the keyboard. See setCaptureMode. */
let capturing = false;

let installed = false;

function ownedFrom(all: Record<number, Record<string, number>>): Set<string> {
  const set = new Set<string>();
  if (!all || typeof all !== 'object') return set;
  for (const key of Object.keys(all)) {
    const layout = all[Number(key)];
    if (!layout || typeof layout !== 'object') continue;
    for (const code of Object.keys(layout)) {
      // Escape is the browser's, and the player's: full-screen exit, dialog
      // dismissal, the way out of a fight. It is never swallowed.
      if (code && code !== 'Escape') set.add(code);
    }
  }
  return set;
}

/**
 * Recompute the suppression set from every slot's CURRENT bindings. Call this
 * whenever bindings change — a rebind, a reset, a save being loaded.
 *
 * The whole set is replaced rather than merged: a key that is no longer bound
 * to anything should go back to doing whatever the browser wants it to do.
 */
export function refreshOwnedKeys(all: Record<number, Record<string, number>>): void {
  const next = ownedFrom(all);
  // Nothing usable came in. Owning nothing would hand Space back to the page
  // and scroll the document mid-fight, so the defaults stand instead.
  owned = next.size > 0 ? next : ownedFrom(DEFAULT_BINDINGS);
}

/**
 * Hand the keyboard to the rebinding editor, or take it back.
 *
 * While capture is on, the game does not preventDefault, does not record keys
 * as held, and sees nothing at all — every event goes to the editor untouched.
 * The held set is cleared in both directions: a key held when the editor opens
 * must not count as a press, and a key eaten by the editor must not stay down
 * once it closes.
 */
export function setCaptureMode(on: boolean): void {
  capturing = on === true;
  held.clear();
}

/** True while the rebinding editor owns the keyboard. */
export function isCapturing(): boolean {
  return capturing;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Suppress the key's default action — unless a browser-level chord is in
 * flight. Ctrl+R is bound to Grab by position, and stealing someone's reload
 * because their Grab key happens to be R is not a trade worth making.
 */
function shouldSuppress(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  return owned.has(e.code);
}

function onKeyDown(e: KeyboardEvent): void {
  if (capturing) return;
  if (isEditableTarget(e.target)) return;
  if (shouldSuppress(e)) e.preventDefault();
  held.add(e.code);
}

function onKeyUp(e: KeyboardEvent): void {
  if (capturing) {
    held.delete(e.code);
    return;
  }
  // Always release, even from a text field: a key that went down in the game
  // and up somewhere else must not stick.
  if (shouldSuppress(e) && !isEditableTarget(e.target)) e.preventDefault();
  held.delete(e.code);
}

function releaseAll(): void {
  held.clear();
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') releaseAll();
}

/** Installed once at boot; all KeyboardSources read from this shared key state. */
export function installKeyboard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  // Alt-tabbing mid-punch would otherwise leave the key welded down.
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);
}

export function isKeyDown(code: string): boolean {
  return held.has(code);
}

/** Drop anything that is not a real button bit; a corrupt save is not input. */
function sanitize(bindings: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!bindings || typeof bindings !== 'object') return out;
  for (const code of Object.keys(bindings)) {
    const bit = bindings[code];
    if (typeof bit === 'number' && Number.isFinite(bit) && bit !== 0) out[code] = bit | 0;
  }
  return out;
}

export class KeyboardSource implements InputSource {
  readonly id: string;
  readonly kind = 'keyboard' as const;

  private readonly slot: number;
  private bindings: Record<string, number>;
  private map: [string, number][];
  private disposed = false;

  constructor(slot: number, bindings: Record<string, number>) {
    this.slot = slot;
    this.id = `kb${slot}`;
    this.bindings = sanitize(bindings);
    this.map = Object.keys(this.bindings).map(
      (code) => [code, this.bindings[code]] as [string, number],
    );
    this.claimKeys();
    installKeyboard();
  }

  /**
   * Swap the key map live. A rebind has to land on the fight already in
   * progress, not on the next launch, so nothing is allowed to cache the
   * bindings a source was constructed with.
   */
  setBindings(bindings: Record<string, number>): void {
    if (this.disposed) return;
    this.bindings = sanitize(bindings);
    this.map = Object.keys(this.bindings).map(
      (code) => [code, this.bindings[code]] as [string, number],
    );
    this.claimKeys();
  }

  sample(_frame: number): BtnMask {
    if (this.disposed) return 0;
    let mask = 0;
    for (const [code, bit] of this.map) {
      if (held.has(code)) mask |= bit;
    }
    return mask;
  }

  label(): string {
    return labelForBindings(this.bindings, this.slot);
  }

  dispose(): void {
    this.disposed = true;
    this.map = [];
  }

  /**
   * A source that is reading a key had better be suppressing it too. This is a
   * union, not a reset — refreshOwnedKeys() is what prunes keys nobody uses any
   * more — so a saved custom binding is safe from the first frame even if
   * nothing has called refreshOwnedKeys() yet.
   */
  private claimKeys(): void {
    for (const code of Object.keys(this.bindings)) {
      if (code !== 'Escape') owned.add(code);
    }
  }
}
