/**
 * Controllers.
 *
 * Three rules hold this file together:
 *
 *  1. BIND BY POSITION, LABEL BY VENDOR. The bottom face button is Light on
 *     every pad; whether it says A, B or ✕ is the UI's problem and nobody
 *     else's. See GamepadProfiles.ts — it is the same rule the keyboard follows
 *     with `KeyboardEvent.code`.
 *  2. READ ONLY WHAT THE PROFILE NAMES. A Steam Deck reports its trackpads and
 *     gyro as further axes, and a gyro that is merely sitting on a table is
 *     never quiet. Anything past the axes a profile names does not exist.
 *  3. THE WIRE TAKES BITS, NOT FLOATS. Lockstep compares input masks exactly,
 *     so the stick's position cannot travel. What the game needs from an analog
 *     stick — a direction, and whether the player means it — reduces to the
 *     direction bits plus `Btn.Run`, and that is all that is transmitted.
 *
 * The stick itself is read with a RADIAL deadzone rescaled to 0..1: a circular
 * dead area so a diagonal needs no more deflection than a cardinal, and a
 * rescale so the first movement past the edge of it is slow instead of jumping
 * straight to full speed. Push to the limit and `Btn.Run` sets; ease off and it
 * clears, which is the whole difference between a stick and a d-pad.
 */

import type { BtnMask, InputSource } from '@/core/types';
import { Btn } from '@/core/types';
import type { PadProfile } from '@/engine/input/GamepadProfiles';
import { profileFor } from '@/engine/input/GamepadProfiles';

/** Radius of the circular dead area at the centre of the stick. */
const INNER_DEADZONE = 0.2;
/** Rescaled magnitude above which the player means "run", not "walk". */
const RUN_THRESHOLD = 0.72;
/**
 * How far off a cardinal the stick may sit before the diagonal engages.
 * A pure 8-way split would use tan(22.5°) = 0.414 and give every sector the
 * same width; biasing it up to 0.5 widens the cardinals to about 53° each, so
 * walking flat along the floor is easy while diagonals stay comfortably
 * reachable.
 */
const DIAGONAL_RATIO = 0.5;
/**
 * Analog trigger threshold. Drivers disagree about whether an axis trigger
 * rests at -1 or at 0, and a single threshold at 0.5 is correct for both.
 */
const TRIGGER_THRESHOLD = 0.5;
/** How close a hat axis must sit to one of its eight detents to count. */
const HAT_TOLERANCE = 0.12;
/** Digital threshold for a d-pad reported as a pair of axes. */
const DPAD_AXIS_THRESHOLD = 0.5;
/** Movement that proves a guessed d-pad axis is really wired to a d-pad. */
const AXIS_WAKE = 0.1;
/** Rumble longer than this is a stuck motor, not feedback. */
const MAX_RUMBLE_MS = 300;

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

// ─────────────────────────────────────────────────────────────────────────────
// Per-pad state
// ─────────────────────────────────────────────────────────────────────────────

interface PadState {
  /** Identity of the hardware this profile was derived from. */
  key: string;
  profile: PadProfile;
  /**
   * First value seen on each guessed d-pad axis, and whether it has ever
   * changed. A d-pad guessed onto an axis is exactly that — a guess — and the
   * failure it risks is the worst one available: an axis that rests at -1
   * because it is really a trigger would read as "left held" forever and walk
   * the player into a wall for the rest of the fight. An axis that has never
   * moved since the pad appeared is therefore treated as centred. The cost is
   * that a d-pad held down at the moment the pad is first polled is ignored
   * until it is released, which the next press fixes.
   */
  restHat: number;
  liveHat: boolean;
  restDx: number;
  liveDx: boolean;
  restDy: number;
  liveDy: boolean;
}

const padStates = new Map<number, PadState>();

function padKey(pad: Gamepad): string {
  const id = typeof pad.id === 'string' ? pad.id : '';
  const mapping = typeof pad.mapping === 'string' ? pad.mapping : '';
  const nb = pad.buttons ? pad.buttons.length : 0;
  const na = pad.axes ? pad.axes.length : 0;
  return `${id}|${mapping}|${nb}|${na}`;
}

function stateFor(index: number, pad: Gamepad): PadState {
  const key = padKey(pad);
  const existing = padStates.get(index);
  if (existing && existing.key === key) return existing;
  // A different pad in the same slot is a different pad: nothing learned about
  // the old one applies.
  const fresh: PadState = {
    key,
    profile: profileFor(pad),
    restHat: NaN,
    liveHat: false,
    restDx: NaN,
    liveDx: false,
    restDy: NaN,
    liveDy: false,
  };
  padStates.set(index, fresh);
  return fresh;
}

/** Poll once per sim frame before sampling any GamepadSource. */
export function pollGamepads(): void {
  snapshot = readPads();
  polled = true;
  if (padStates.size > 0) {
    for (const index of Array.from(padStates.keys())) {
      const pad = snapshot[index];
      if (!pad || !pad.connected) padStates.delete(index);
    }
  }
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

/** What a connected pad is, for any UI that needs to print its button names. */
export function padProfile(index: number): PadProfile | null {
  if (!polled) pollGamepads();
  const pad = snapshot[index];
  if (!pad || !pad.connected) return null;
  return stateFor(index, pad).profile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds-checked reads
// ─────────────────────────────────────────────────────────────────────────────

function buttonValue(pad: Gamepad, index: number): number {
  if (index < 0) return 0;
  const b = pad.buttons ? pad.buttons[index] : undefined;
  if (!b) return 0;
  const v = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : 0;
  if (v > 0) return v;
  return b.pressed ? 1 : 0;
}

function pressed(pad: Gamepad, index: number): boolean {
  return buttonValue(pad, index) > TRIGGER_THRESHOLD;
}

function axis(pad: Gamepad, index: number | undefined): number {
  if (typeof index !== 'number' || index < 0) return 0;
  const v = pad.axes ? pad.axes[index] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * True only for an axis the profile actually names AND the pad actually has.
 * This is the gate that keeps a Steam Deck's trackpads and gyro — reported as
 * further axes, and never entirely still — out of the movement code.
 */
function hasAxis(pad: Gamepad, index: number | undefined): boolean {
  if (typeof index !== 'number' || index < 0) return false;
  return !!pad.axes && index < pad.axes.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stick
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Direction bits plus Btn.Run from the left stick.
 *
 * The deadzone is radial and the remainder is rescaled to 0..1, so the stick
 * behaves the same in every direction and the first degree of movement past the
 * dead area is a slow walk rather than a sprint.
 */
function stickBits(pad: Gamepad, profile: PadProfile): number {
  if (!hasAxis(pad, profile.axisX) || !hasAxis(pad, profile.axisY)) return 0;

  const ax = axis(pad, profile.axisX);
  const ay = axis(pad, profile.axisY);

  let mag = Math.sqrt(ax * ax + ay * ay);
  if (mag <= INNER_DEADZONE) return 0;
  // Square-gated sticks report up to ~1.41 on the diagonal. Clamp so the
  // rescale below cannot exceed 1 and turn a diagonal into a permanent run.
  if (mag > 1) mag = 1;

  const t = (mag - INNER_DEADZONE) / (1 - INNER_DEADZONE);

  let bits = 0;
  const bx = Math.abs(ax);
  const by = Math.abs(ay);
  if (bx >= by) {
    bits |= ax < 0 ? Btn.Left : Btn.Right;
    if (by >= DIAGONAL_RATIO * bx) bits |= ay < 0 ? Btn.Up : Btn.Down;
  } else {
    // The Gamepad API's Y axis grows downward; up the screen is up the map.
    bits |= ay < 0 ? Btn.Up : Btn.Down;
    if (bx >= DIAGONAL_RATIO * by) bits |= ax < 0 ? Btn.Left : Btn.Right;
  }

  if (t > RUN_THRESHOLD) bits |= Btn.Run;
  return bits;
}

// ─────────────────────────────────────────────────────────────────────────────
// The d-pad
// ─────────────────────────────────────────────────────────────────────────────

const HAT_BITS: number[] = [
  Btn.Up,
  Btn.Up | Btn.Right,
  Btn.Right,
  Btn.Down | Btn.Right,
  Btn.Down,
  Btn.Down | Btn.Left,
  Btn.Left,
  Btn.Up | Btn.Left,
];

/**
 * Decode an 8-way hat switch reported on a single axis: -1 is up and the
 * remaining detents run clockwise in steps of 2/7, with anything outside the
 * range meaning centred. Values that do not sit close to a detent are rejected,
 * because an axis that is not really a hat should move nothing.
 */
function hatBits(v: number): number {
  if (!Number.isFinite(v) || v < -1.05 || v > 1.05) return 0;
  const idx = Math.round((v + 1) * 3.5);
  if (idx < 0 || idx > 7) return 0;
  const detent = idx / 3.5 - 1;
  if (Math.abs(v - detent) > HAT_TOLERANCE) return 0;
  return HAT_BITS[idx];
}

/** Direction bits from the d-pad, in whichever of its three forms this pad uses. */
function dpadBits(pad: Gamepad, profile: PadProfile, st: PadState): number {
  let bits = 0;

  if (pressed(pad, profile.dpadLeft)) bits |= Btn.Left;
  if (pressed(pad, profile.dpadRight)) bits |= Btn.Right;
  if (pressed(pad, profile.dpadUp)) bits |= Btn.Up;
  if (pressed(pad, profile.dpadDown)) bits |= Btn.Down;

  if (hasAxis(pad, profile.hatAxis)) {
    const v = axis(pad, profile.hatAxis);
    if (!Number.isFinite(st.restHat)) st.restHat = v;
    else if (!st.liveHat && Math.abs(v - st.restHat) > AXIS_WAKE) st.liveHat = true;
    if (st.liveHat) bits |= hatBits(v);
  }

  if (hasAxis(pad, profile.dpadAxisX)) {
    const v = axis(pad, profile.dpadAxisX);
    if (!Number.isFinite(st.restDx)) st.restDx = v;
    else if (!st.liveDx && Math.abs(v - st.restDx) > AXIS_WAKE) st.liveDx = true;
    if (st.liveDx) {
      if (v <= -DPAD_AXIS_THRESHOLD) bits |= Btn.Left;
      else if (v >= DPAD_AXIS_THRESHOLD) bits |= Btn.Right;
    }
  }

  if (hasAxis(pad, profile.dpadAxisY)) {
    const v = axis(pad, profile.dpadAxisY);
    if (!Number.isFinite(st.restDy)) st.restDy = v;
    else if (!st.liveDy && Math.abs(v - st.restDy) > AXIS_WAKE) st.liveDy = true;
    if (st.liveDy) {
      if (v <= -DPAD_AXIS_THRESHOLD) bits |= Btn.Up;
      else if (v >= DPAD_AXIS_THRESHOLD) bits |= Btn.Down;
    }
  }

  // A d-pad has no analog travel, so pressing one means go, not creep.
  if (bits !== 0) bits |= Btn.Run;
  return bits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A trigger is a button with a `value` on a standard pad and an axis on plenty
 * of others. Both are read, since the one the pad does not have reads as
 * nothing, and the same 0.5 threshold suits an axis resting at -1 and one
 * resting at 0.
 */
function triggerHeld(pad: Gamepad, button: number, axisIndex: number | undefined): boolean {
  if (hasAxis(pad, axisIndex) && axis(pad, axisIndex as number) > TRIGGER_THRESHOLD) return true;
  return buttonValue(pad, button) > TRIGGER_THRESHOLD;
}

// ─────────────────────────────────────────────────────────────────────────────
// The source
// ─────────────────────────────────────────────────────────────────────────────

export class GamepadSource implements InputSource {
  readonly id: string;
  readonly kind = 'gamepad' as const;

  private readonly padIndex: number;
  private disposed = false;
  /** Last profile seen, so the label survives a pad being unplugged mid-menu. */
  private lastProfile: PadProfile | null = null;

  constructor(padIndex: number) {
    this.padIndex = padIndex;
    this.id = `pad${padIndex}`;
  }

  sample(_frame: number): BtnMask {
    if (this.disposed) return 0;
    const pad = snapshot[this.padIndex];
    if (!pad || !pad.connected) return 0;

    const st = stateFor(this.padIndex, pad);
    const p = st.profile;
    this.lastProfile = p;

    let mask = stickBits(pad, p) | dpadBits(pad, p, st);

    // A pad reporting both directions of an axis at once would confuse the
    // fighter state machine; last-resort tie-break drops both.
    if ((mask & Btn.Left) !== 0 && (mask & Btn.Right) !== 0) mask &= ~(Btn.Left | Btn.Right);
    if ((mask & Btn.Up) !== 0 && (mask & Btn.Down) !== 0) mask &= ~(Btn.Up | Btn.Down);
    // Nothing left to run in.
    if ((mask & (Btn.Left | Btn.Right | Btn.Up | Btn.Down)) === 0) mask &= ~Btn.Run;
    else {
      // Tell the fighter this direction came from a pad, so it trusts Run
      // instead of also running its own hold-to-run timer on top. Sent every
      // frame rather than once, so putting the pad down and going back to the
      // keyboard is handled immediately.
      mask |= Btn.Analog;
    }

    // Actions bind to the PHYSICAL position of the button, never to the letter
    // printed on it. The bottom button is Light on an Xbox pad (A), a Nintendo
    // pad (B) and a DualSense (✕) alike.
    if (pressed(pad, p.south)) mask |= Btn.Light;
    if (pressed(pad, p.east)) mask |= Btn.Heavy;
    if (pressed(pad, p.west)) mask |= Btn.Jump;
    if (pressed(pad, p.north)) mask |= Btn.Special;
    if (pressed(pad, p.r1)) mask |= Btn.Block;
    if (pressed(pad, p.l1)) mask |= Btn.Grab;
    // Both triggers go through triggerHeld rather than pressed(): on most pads
    // a trigger is analog, and on the ones that report it on an axis instead of
    // a button there is no `pressed` flag to read at all. Interact sits on the
    // left trigger — LT / L2 / ZL, whatever this pad has printed on it — beside
    // Grab on the left bumper, which is the hand the pick-up belongs to.
    if (triggerHeld(pad, p.l2, p.l2Axis)) mask |= Btn.Interact;
    if (triggerHeld(pad, p.r2, p.r2Axis)) mask |= Btn.Super;
    if (pressed(pad, p.start)) mask |= Btn.Pause;

    return mask;
  }

  /** 'Xbox Controller (pad 2)'. */
  label(): string {
    const p = padProfile(this.padIndex) ?? this.lastProfile;
    const name = p ? p.name : 'Gamepad';
    return `${name} (pad ${this.padIndex + 1})`;
  }

  /** The pad's identity, for a UI that wants to print its button letters. */
  profile(): PadProfile | null {
    return padProfile(this.padIndex) ?? this.lastProfile;
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rumble
// ─────────────────────────────────────────────────────────────────────────────
//
// PRESENTATION ONLY. Rumble is a haptic sibling of screen shake and audio: it
// is called from the render/juice side, never from sim code, because it depends
// on hardware the other peer does not have and would make the simulation
// diverge if it were ever allowed to matter.
//
// `vibrationActuator` is absent on Firefox and older Safari, the promise it
// returns rejects when an effect is pre-empted, and some drivers throw outright.
// Every one of those degrades to doing nothing: a rumble call must never throw
// into the game loop.

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function livePad(index: number): Gamepad | null {
  if (index < 0) return null;
  // Fresh, not the frame's snapshot: an actuator wants the current object.
  const pads = readPads();
  const pad = pads[index] ?? snapshot[index] ?? null;
  return pad && pad.connected ? pad : null;
}

function playRumble(pad: Gamepad, strength: number, ms: number): void {
  try {
    const actuator = pad.vibrationActuator as GamepadHapticActuator | undefined;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    const result = actuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: ms,
      // The weak motor is the buzz, the strong one is the thump. Driving both
      // from one number keeps callers honest about it being an intensity.
      strongMagnitude: strength,
      weakMagnitude: strength * 0.75,
    }) as unknown;
    const p = result as Promise<unknown> | null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // No haptics on this pad, in this browser, today. Silence is the fallback.
  }
}

/** Buzz one pad. Strength 0..1, duration clamped to something a hand tolerates. */
export function rumble(index: number, strength: number, ms: number): void {
  const s = clamp01(strength);
  const dur = Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), MAX_RUMBLE_MS);
  if (s <= 0 || dur <= 0) return;
  const pad = livePad(index);
  if (!pad) return;
  playRumble(pad, s, dur);
}

/** Buzz every connected pad — a KO, a boss landing, the things everyone feels. */
export function rumbleAll(strength: number, ms: number): void {
  const s = clamp01(strength);
  const dur = Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), MAX_RUMBLE_MS);
  if (s <= 0 || dur <= 0) return;
  const pads = readPads();
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected) playRumble(pad, s, dur);
  }
}
