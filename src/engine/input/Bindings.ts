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
 * Slot 0 lives on the left half of the board (WASD + ERFGH + space), slot 1 on
 * the right (arrows + numpad), so two people can share one keyboard without
 * elbowing each other.
 *
 * Interact sits one key up and right of the movement diamond on slot 0 (`KeyE`,
 * the key an AZERTY board calls E too and a Dvorak board calls '.') and beside
 * Grab on the numpad for slot 1: both are reachable without the hand leaving
 * the keys it is already on, which matters for something pressed mid-fight to
 * swap a weapon or jump on a bike.
 *
 * SLOT 0 GETS THE ARROWS AS A SECOND MOVEMENT DIAMOND. Every action may hold up
 * to two keys (see `codesForBit`), and the arrows are where most people's left
 * hand is not: somebody who has never met WASD can just walk. The order matters
 * and is not decorative — the FIRST code bound to a bit is the primary, which is
 * what the HUD prompt and the controls screen print, so `KeyW` is written above
 * `ArrowUp` here and every mutation goes through `setBinding`, which rebuilds the
 * map in a defined order rather than trusting whatever order a rebind happened
 * to leave behind.
 *
 * These arrows collide with slot 1's PRIMARY movement, and that collision is
 * resolved where it actually matters — `Game.keyboardMapFor`, which strips the
 * shared codes off slot 0 when two local players are on one keyboard, and leaves
 * them alone when there is only one pair of hands.
 */
export const DEFAULT_BINDINGS: Record<number, Record<string, number>> = {
  0: {
    KeyW: Btn.Up,
    KeyS: Btn.Down,
    KeyA: Btn.Left,
    KeyD: Btn.Right,
    // Secondary movement. Listed after the diamond so the diamond stays primary.
    ArrowUp: Btn.Up,
    ArrowDown: Btn.Down,
    ArrowLeft: Btn.Left,
    ArrowRight: Btn.Right,
    KeyF: Btn.Light,
    KeyG: Btn.Heavy,
    Space: Btn.Jump,
    KeyH: Btn.Special,
    ShiftLeft: Btn.Block,
    KeyR: Btn.Grab,
    KeyE: Btn.Interact,
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
    Numpad4: Btn.Interact,
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
  // Named for what it does rather than for the bit, because a player reading a
  // controls screen wants to know which key picks the bat up off the floor.
  { bit: Btn.Interact, id: 'interact', name: 'Pick up / Use' },
  { bit: Btn.Super, id: 'super', name: 'Super' },
  { bit: Btn.Pause, id: 'pause', name: 'Pause' },
];

const ACTION_BITS = new Set<number>(ACTIONS.map((a) => a.bit));

/** The movement diamond, in the order a label reads them: up, left, down, right. */
const DIRECTION_BITS: readonly number[] = [Btn.Up, Btn.Left, Btn.Down, Btn.Right];

/**
 * How many keys one action is allowed to answer to: a primary and a secondary.
 * Nothing in the storage format enforces this — a map is `code -> bit` and any
 * number of codes may carry the same bit — it is the number of slots the editor
 * offers, and therefore the number this module keeps in a defined order.
 */
export const KEY_SLOTS = 2;

/** Which of an action's two keys a call means: 0 = primary, 1 = secondary. */
export type KeySlot = 0 | 1;

/**
 * Rebuild a map with a DEFINED key order, keeping every entry exactly as it was.
 *
 * This is the whole of how primary and secondary stay straight. The pair is not
 * stored anywhere — it cannot be, because the saved shape is
 * `Record<code, bit>` and the save layer, the netcode and every existing player
 * save depend on that shape — so the pair IS the order: the first code carrying
 * a bit is that action's primary, the second is its secondary.
 *
 * Left to itself that order is insertion order, which a rebind (delete, re-add)
 * scrambles. So every mutation ends here, and the result is emitted in the order
 * ACTIONS lists, primary before secondary, with anything bound to a bit this
 * build does not recognise carried along at the end rather than dropped.
 *
 * It survives the round trip through Save.ts untouched: `JSON.stringify` writes
 * non-numeric string keys in insertion order, `JSON.parse` reads them back the
 * same way, and Save's own `cloneSlot` copies them in `Object.keys` order and
 * normalises again on the way in.
 */
export function normalizeBindings(bindings: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!bindings || typeof bindings !== 'object') return out;

  const placed = new Set<string>();
  for (const action of ACTIONS) {
    for (const code of Object.keys(bindings)) {
      if (placed.has(code) || bindings[code] !== action.bit) continue;
      placed.add(code);
      out[code] = bindings[code];
    }
  }
  // A bit from a newer build, or a hand-edited file. Not ours to throw away.
  for (const code of Object.keys(bindings)) {
    if (placed.has(code)) continue;
    out[code] = bindings[code];
  }
  return out;
}

/**
 * A fresh copy of the defaults for a slot — fresh because the rebinding screen
 * edits what it is handed, and handing out DEFAULT_BINDINGS itself would let a
 * "Reset to defaults" button quietly redefine the defaults.
 */
export function defaultBindingsFor(slot: number): Record<string, number> {
  return normalizeBindings(DEFAULT_BINDINGS[slot] ?? DEFAULT_BINDINGS[0]);
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

/**
 * Every key bound to an action, primary first.
 *
 * Dense and in order: `[]` for an action nobody can reach, `['KeyW']` for one
 * with a primary and no secondary, `['KeyW', 'ArrowUp']` for the full pair. A
 * hand-edited save with three codes on one bit keeps all three; the editor shows
 * the first two and the rest still work.
 */
export function codesForBit(bindings: Record<string, number>, bit: number): string[] {
  const out: string[] = [];
  if (!bindings || typeof bindings !== 'object') return out;
  for (const code of Object.keys(bindings)) {
    if (bindings[code] === bit) out.push(code);
  }
  return out;
}

/**
 * The PRIMARY key bound to an action, or null. The reverse of the map, done
 * honestly — and the one every prompt in the game prints, so an action with a
 * spare key is still announced by the key it is really named after.
 */
export function codeForBit(bindings: Record<string, number>, bit: number): string | null {
  return codesForBit(bindings, bit)[0] ?? null;
}

/**
 * Put a code in one of an action's two key slots, or clear it with `null`, and
 * return a NEW map. The input is never touched: the editor keeps an undoable
 * copy and the live map belongs to the input layer.
 *
 * One action per key, per slot: the incoming code is evicted from whatever else
 * in this map was answering to it, which is what makes conflict handling
 * possible at all — the caller reads `conflictFor` BEFORE calling this and says
 * who lost what.
 *
 * THE PAIR IS DENSE, because a `Record<code, bit>` cannot store a hole. There is
 * no way to spell "no primary, but a secondary", so assigning a secondary to an
 * action that has none makes that key the primary, and clearing a primary
 * promotes the secondary into its place. Callers that care read the result back
 * through `codesForBit` and report where the key actually landed rather than
 * where it was aimed.
 */
export function setBinding(
  bindings: Record<string, number>,
  bit: number,
  slotIndex: KeySlot,
  code: string | null,
): Record<string, number> {
  const src = bindings && typeof bindings === 'object' ? bindings : {};
  const next = typeof code === 'string' && code.length > 0 ? code : null;
  const index: KeySlot = slotIndex === 1 ? 1 : 0;

  const current = codesForBit(src, bit);
  const pair: (string | null)[] = [current[0] ?? null, current[1] ?? null];
  // Anything past the pair came from a file we did not write. Keep it.
  const extras = current.slice(KEY_SLOTS).filter((c) => c !== next);

  if (next !== null) {
    // Already on this action, in the other slot: this is a move, not a copy.
    if (pair[0] === next) pair[0] = null;
    if (pair[1] === next) pair[1] = null;
  }
  pair[index] = next;

  const kept = [...pair.filter((c): c is string => c !== null), ...extras];

  const out: Record<string, number> = {};
  for (const c of Object.keys(src)) {
    if (src[c] === bit) continue; // this action's old keys, re-added below in order
    if (next !== null && c === next) continue; // evicted from whatever it used to do
    out[c] = src[c];
  }
  for (const c of kept) out[c] = bit;

  return normalizeBindings(out);
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
