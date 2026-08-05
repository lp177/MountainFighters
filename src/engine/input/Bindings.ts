import { Btn } from '@/core/types';

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

const SLOT_LABELS: Record<number, string> = {
  0: 'Keyboard (WASD)',
  1: 'Keyboard (Arrows + Numpad)',
};

export function bindingLabel(slot: number): string {
  return SLOT_LABELS[slot] ?? `Keyboard (slot ${slot + 1})`;
}
