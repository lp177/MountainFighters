import type { BtnMask, InputSource } from '@/core/types';
import { Btn } from '@/core/types';

/** Analog stick deadzone. Below this the stick reads as centred. */
const DEADZONE = 0.35;
/** Analog trigger threshold for RT/R2. */
const TRIGGER_THRESHOLD = 0.5;

// Standard gamepad mapping indices.
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

let snapshot: (Gamepad | null)[] = [];
let polled = false;

function readPads(): (Gamepad | null)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  try {
    // Some browsers throw here when the page is not focused or the API is
    // blocked by permissions policy; a missing pad is not a crash.
    return Array.from(navigator.getGamepads());
  } catch {
    return [];
  }
}

/** Poll once per sim frame before sampling any GamepadSource. */
export function pollGamepads(): void {
  snapshot = readPads();
  polled = true;
}

export function connectedGamepads(): number[] {
  if (!polled) pollGamepads();
  const out: number[] = [];
  for (let i = 0; i < snapshot.length; i++) {
    const pad = snapshot[i];
    if (pad && pad.connected) out.push(i);
  }
  return out;
}

function buttonValue(pad: Gamepad, index: number): number {
  const b = pad.buttons[index];
  if (!b) return 0;
  return b.value > 0 ? b.value : b.pressed ? 1 : 0;
}

function pressed(pad: Gamepad, index: number): boolean {
  const b = pad.buttons[index];
  if (!b) return false;
  return b.pressed || b.value > TRIGGER_THRESHOLD;
}

function axis(pad: Gamepad, index: number): number {
  const v = pad.axes[index];
  return typeof v === 'number' ? v : 0;
}

export class GamepadSource implements InputSource {
  readonly id: string;
  readonly kind = 'gamepad' as const;

  private readonly padIndex: number;
  private disposed = false;

  constructor(padIndex: number) {
    this.padIndex = padIndex;
    this.id = `pad${padIndex}`;
  }

  sample(_frame: number): BtnMask {
    if (this.disposed) return 0;
    const pad = snapshot[this.padIndex];
    if (!pad || !pad.connected) return 0;

    let mask = 0;

    const ax = axis(pad, 0);
    const ay = axis(pad, 1);
    if (ax <= -DEADZONE) mask |= Btn.Left;
    else if (ax >= DEADZONE) mask |= Btn.Right;
    if (ay <= -DEADZONE) mask |= Btn.Up;
    else if (ay >= DEADZONE) mask |= Btn.Down;

    if (pressed(pad, BTN_DPAD_LEFT)) mask |= Btn.Left;
    if (pressed(pad, BTN_DPAD_RIGHT)) mask |= Btn.Right;
    if (pressed(pad, BTN_DPAD_UP)) mask |= Btn.Up;
    if (pressed(pad, BTN_DPAD_DOWN)) mask |= Btn.Down;

    // A pad reporting both directions of an axis at once would confuse the
    // fighter state machine; last-resort tie-break drops both.
    if ((mask & Btn.Left) !== 0 && (mask & Btn.Right) !== 0) mask &= ~(Btn.Left | Btn.Right);
    if ((mask & Btn.Up) !== 0 && (mask & Btn.Down) !== 0) mask &= ~(Btn.Up | Btn.Down);

    if (pressed(pad, BTN_A)) mask |= Btn.Light;
    if (pressed(pad, BTN_B)) mask |= Btn.Heavy;
    if (pressed(pad, BTN_X)) mask |= Btn.Jump;
    if (pressed(pad, BTN_Y)) mask |= Btn.Special;
    if (pressed(pad, BTN_RB)) mask |= Btn.Block;
    if (pressed(pad, BTN_LB)) mask |= Btn.Grab;
    if (buttonValue(pad, BTN_RT) > TRIGGER_THRESHOLD) mask |= Btn.Super;
    if (pressed(pad, BTN_START)) mask |= Btn.Pause;

    return mask;
  }

  label(): string {
    return `Gamepad ${this.padIndex + 1}`;
  }

  dispose(): void {
    this.disposed = true;
  }
}
