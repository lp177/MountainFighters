import type { BtnMask, InputSource } from '@/core/types';
import { DEFAULT_BINDINGS, bindingLabel } from '@/engine/input/Bindings';

/** Shared across every KeyboardSource — one listener pair for the whole game. */
const held = new Set<string>();

/**
 * Keys the game owns. Their default action (page scroll, caret movement,
 * numpad navigation) is suppressed so a fight never scrolls the document.
 * Escape is deliberately left alone so the browser keeps its own behaviour.
 */
const OWNED_KEYS = (() => {
  const set = new Set<string>();
  for (const key of Object.keys(DEFAULT_BINDINGS)) {
    const layout = DEFAULT_BINDINGS[Number(key)];
    if (!layout) continue;
    for (const code of Object.keys(layout)) {
      if (code !== 'Escape') set.add(code);
    }
  }
  return set;
})();

let installed = false;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeyDown(e: KeyboardEvent): void {
  if (isEditableTarget(e.target)) return;
  if (OWNED_KEYS.has(e.code)) e.preventDefault();
  held.add(e.code);
}

function onKeyUp(e: KeyboardEvent): void {
  // Always release, even from a text field: a key that went down in the game
  // and up somewhere else must not stick.
  if (OWNED_KEYS.has(e.code) && !isEditableTarget(e.target)) e.preventDefault();
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

export class KeyboardSource implements InputSource {
  readonly id: string;
  readonly kind = 'keyboard' as const;

  private readonly slot: number;
  private map: [string, number][];
  private disposed = false;

  constructor(slot: number, bindings: Record<string, number>) {
    this.slot = slot;
    this.id = `kb${slot}`;
    this.map = Object.keys(bindings).map((code) => [code, bindings[code]] as [string, number]);
    installKeyboard();
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
    return bindingLabel(this.slot);
  }

  dispose(): void {
    this.disposed = true;
    this.map = [];
  }
}
