/**
 * Keyboard bindings.
 *
 * Everything here is keyed by `KeyboardEvent.code` — the physical position of
 * the key, not the letter printed on it. That is deliberate and it is the whole
 * reason this game plays correctly on a keyboard it has never heard of: `KeyW`
 * is the top of the movement diamond on every board on the planet, whether its
 * owner calls that key W (QWERTY), Z (AZERTY) or , (Dvorak). Never rewrite
 * these defaults into letters, and never add a second set of defaults "for
 * AZERTY" — both make it worse for everyone.
 *
 * The labels are a different matter, and they live in Layout.ts, which asks the
 * browser what each of these keys actually says.
 */

import { Btn } from '@/core/types';
import { movementLabelForCodes } from '@/engine/input/Layout';

/**
 * Default keyboard layouts, keyed by local player slot.
 *
 * Slot 0 lives on the left half of the board (WASD + FGH + space), slot 1 on
 * the right (arrows + numpad), so two people can share one keyboard without
 * elbowing each other.
 */
export const DEFAULT_BINDINGS: Record<number, Record<string, number>> = {
  0: {
    KeyW: Btn.Up,
    KeyS: Btn.Down,
    KeyA: Btn.Left,
    KeyD: Btn.Right,
    KeyF: Btn.Light,
    KeyG: Btn.Heavy,
    Space: Btn.Jump,
    KeyH: Btn.Special,
    ShiftLeft: Btn.Block,
    KeyR: Btn.Grab,
    KeyT: Btn.Super,
    Escape: Btn.Pause,
  },
  1: {
    ArrowUp: Btn.Up,
    ArrowDown: Btn.Down,
    ArrowLeft: Btn.Left,
    ArrowRight: Btn.Right,
    Numpad1: Btn.Light,
    Numpad2: Btn.Heavy,
    Numpad0: Btn.Jump,
    Numpad3: Btn.Special,
    NumpadDecimal: Btn.Block,
    Numpad5: Btn.Grab,
    NumpadAdd: Btn.Super,
    Escape: Btn.Pause,
  },
};

/** One rebindable action: the bit it sets, a stable id, and what to call it. */
export interface ActionDef {
  bit: number;
  id: string;
  name: string;
}

/**
 * Every action a key can be bound to, in the order a rebinding screen should
 * list them: the four directions first, then the buttons in the order the HUD
 * and the move list use, then Pause on its own at the bottom.
 */
export const ACTIONS: ActionDef[] = [
  { bit: Btn.Up, id: 'up', name: 'Up' },
  { bit: Btn.Down, id: 'down', name: 'Down' },
  { bit: Btn.Left, id: 'left', name: 'Left' },
  { bit: Btn.Right, id: 'right', name: 'Right' },
  { bit: Btn.Light, id: 'light', name: 'Light attack' },
  { bit: Btn.Heavy, id: 'heavy', name: 'Heavy attack' },
  { bit: Btn.Jump, id: 'jump', name: 'Jump' },
  { bit: Btn.Special, id: 'special', name: 'Special' },
  { bit: Btn.Block, id: 'block', name: 'Block' },
  { bit: Btn.Grab, id: 'grab', name: 'Grab' },
  { bit: Btn.Super, id: 'super', name: 'Super' },
  { bit: Btn.Pause, id: 'pause', name: 'Pause' },
];

const ACTION_BITS = new Set<number>(ACTIONS.map((a) => a.bit));

/** The movement diamond, in the order a label reads them: up, left, down, right. */
const DIRECTION_BITS: readonly number[] = [Btn.Up, Btn.Left, Btn.Down, Btn.Right];

/**
 * A fresh copy of the defaults for a slot — fresh because the rebinding screen
 * edits what it is handed, and handing out DEFAULT_BINDINGS itself would let a
 * "Reset to defaults" button quietly redefine the defaults.
 */
export function defaultBindingsFor(slot: number): Record<string, number> {
  const src = DEFAULT_BINDINGS[slot] ?? DEFAULT_BINDINGS[0];
  const out: Record<string, number> = {};
  for (const code of Object.keys(src)) out[code] = src[code];
  return out;
}

/**
 * The action already sitting on this key, or null if it is free.
 *
 * A rebinding screen calls this before it commits, so it can say "that is your
 * Jump" instead of silently stealing the key and leaving the player unable to
 * jump for the rest of the game.
 */
export function conflictFor(bindings: Record<string, number>, code: string): number | null {
  if (!bindings || typeof bindings !== 'object') return null;
  if (typeof code !== 'string' || code.length === 0) return null;
  const bit = bindings[code];
  if (typeof bit !== 'number' || !Number.isFinite(bit)) return null;
  return ACTION_BITS.has(bit) ? bit : null;
}

/** The key bound to an action, or null. The reverse of the map, done honestly. */
export function codeForBit(bindings: Record<string, number>, bit: number): string | null {
  if (!bindings || typeof bindings !== 'object') return null;
  for (const code of Object.keys(bindings)) {
    if (bindings[code] === bit) return code;
  }
  return null;
}

/** Look up an action by its bit — for turning a conflict back into a name. */
export function actionForBit(bit: number): ActionDef | null {
  for (const action of ACTIONS) {
    if (action.bit === bit) return action;
  }
  return null;
}

/**
 * Label for a live binding map: 'Keyboard (ZQSD)', 'Keyboard (Arrows + Numpad)',
 * 'Keyboard (I/J/K/L)'. Built from what is bound right now and from what the
 * keys actually say, so it stays true after both a rebind and a layout change.
 */
export function labelForBindings(bindings: Record<string, number>, slot: number): string {
  const codes: string[] = [];
  for (const bit of DIRECTION_BITS) {
    const code = codeForBit(bindings, bit);
    if (!code) return `Keyboard (slot ${slot + 1})`;
    codes.push(code);
  }
  const move = movementLabelForCodes(codes);
  if (!move) return `Keyboard (slot ${slot + 1})`;
  const numpad = Object.keys(bindings).some((code) => code.startsWith('Numpad'));
  return `Keyboard (${move}${numpad ? ' + Numpad' : ''})`;
}

/**
 * Label for a slot's DEFAULT bindings — 'Keyboard (WASD)' on a US board,
 * 'Keyboard (ZQSD)' on a French one. The same four keys either way.
 */
export function bindingLabel(slot: number): string {
  const map = DEFAULT_BINDINGS[slot];
  if (!map) return `Keyboard (slot ${slot + 1})`;
  return labelForBindings(map, slot);
}
