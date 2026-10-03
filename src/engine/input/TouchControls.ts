/**
 * Touch controls.
 *
 * The game is shared by link, and a link shared on a social network is opened
 * on a phone. Before this existed that phone reached the character select and
 * stopped: nothing on the screen could be pressed. Now a thumb gets a floating
 * stick on the left half and a pad on the right, laid out like the controller
 * the rest of the game already speaks — A light, B heavy, X jump, Y special in
 * a diamond, the shoulders and triggers as smaller buttons round it.
 *
 * DESIGN NOTES
 *
 *  - The stick FLOATS: it appears wherever the left thumb lands. A fixed stick
 *    on glass has no edge to feel for, and missing it by a centimetre is the
 *    most common way touch controls fail.
 *  - Shown when touch is how the player is actually playing, not when the
 *    device merely could be touched. A coarse primary pointer turns it on at
 *    boot; the first touch anywhere turns it on later; the first key press or
 *    pad button turns it back off. A touchscreen laptop played on its keyboard
 *    never sees it.
 *  - It is an input like any other: the held mask is OR-ed into keyboard half
 *    zero (see KeyboardSource), so the select screen, the fight, lockstep and
 *    the replay of a netplay frame all see an ordinary player-one input and
 *    none of them has to know a phone exists.
 *  - What it shows depends on the scene: the whole pad in a fight, a single
 *    back button on character select and the map wall (pad-driven screens with
 *    no DOM menu — their cards themselves take taps), nothing over a DOM menu,
 *    which a finger can already press, and nothing over the film, which reads
 *    taps itself.
 */

import type { BtnMask } from '@/core/types';
import { Btn } from '@/core/types';

export type TouchMode = 'off' | 'fight' | 'back';

interface ButtonDef {
  bit: number;
  label: string;
  cls: string;
}

const BUTTONS: readonly ButtonDef[] = [
  { bit: Btn.Light, label: 'Light', cls: 'light' },
  { bit: Btn.Heavy, label: 'Heavy', cls: 'heavy' },
  { bit: Btn.Jump, label: 'Jump', cls: 'jump' },
  { bit: Btn.Special, label: 'Spec', cls: 'special' },
  { bit: Btn.Block, label: 'Block', cls: 'block small' },
  { bit: Btn.Super, label: 'Super', cls: 'super small' },
  { bit: Btn.Grab, label: 'Grab', cls: 'grab small' },
  { bit: Btn.Interact, label: 'Use', cls: 'use small' },
];

/** Stick travel, in CSS px, from rest to full deflection. */
const STICK_RADIUS = 46;
/** Below this the stick is centred. */
const DEADZONE = 12;
/** Past this, the dwarf runs rather than walks — the same bit a pad sends. */
const RUN_AT = 40;
/** Cosine-ish threshold for a diagonal: 0.38 ≈ 22.5° either side of an axis. */
const AXIS = 0.38;

let root: HTMLElement | null = null;
let stickEl: HTMLElement | null = null;
let knobEl: HTMLElement | null = null;
let backEl: HTMLButtonElement | null = null;

let mode: TouchMode = 'off';
/** Is touch the input the player is actually using right now? */
let active = false;

let buttonMask = 0;
let stickMask = 0;
/** Pause/back is a press, not a hold: it latches until the next sample. */
let backLatch = 0;

let stickId = -1;
let stickX = 0;
let stickY = 0;
const buttonIds = new Map<number, number>();

/** The buttons' held mask plus the stick. Read by KeyboardSource half zero. */
export function touchMask(): BtnMask {
  if (!active || mode === 'off') return 0;
  const m = buttonMask | stickMask | backLatch;
  backLatch = 0;
  return m;
}

/** True while touch is the live input. The HUD names touch buttons, not keys. */
export function touchActive(): boolean {
  return active && root !== null;
}

/**
 * Called by Game once per frame with the top scene's name. Cheap: it only
 * touches the DOM when the answer changes.
 */
export function syncTouchMode(scene: string, hasDomView: boolean): void {
  let next: TouchMode = 'off';
  if (scene === 'fight') next = 'fight';
  else if ((scene === 'select' || scene === 'gallery') && !hasDomView) next = 'back';
  if (next === mode) return;
  mode = next;
  if (next !== 'fight') releaseAll();
  paint();
}

export function installTouchControls(): void {
  if (root || typeof document === 'undefined') return;

  root = document.createElement('div');
  root.className = 'touchpad';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');

  // ── The stick zone: the left half, wherever the thumb lands ──────────────
  const zone = document.createElement('div');
  zone.className = 'touchpad__zone touchpad__zone--move';
  stickEl = document.createElement('div');
  stickEl.className = 'touchpad__stick';
  knobEl = document.createElement('div');
  knobEl.className = 'touchpad__knob';
  stickEl.appendChild(knobEl);
  zone.appendChild(stickEl);
  zone.addEventListener('pointerdown', onStickDown);
  zone.addEventListener('pointermove', onStickMove);
  zone.addEventListener('pointerup', onStickUp);
  zone.addEventListener('pointercancel', onStickUp);
  root.appendChild(zone);

  // ── The pad ──────────────────────────────────────────────────────────────
  const pad = document.createElement('div');
  pad.className = 'touchpad__buttons';
  for (const def of BUTTONS) {
    const b = document.createElement('div');
    b.className = def.cls
      .split(' ')
      .map((c) => (c === 'small' ? 'touchpad__btn--small' : `touchpad__btn--${c}`))
      .concat('touchpad__btn')
      .join(' ');
    b.textContent = def.label;
    b.addEventListener('pointerdown', (e) => onButtonDown(e, b, def.bit));
    const up = (e: PointerEvent): void => onButtonUp(e, b, def.bit);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    pad.appendChild(b);
  }
  root.appendChild(pad);

  // ── Pause in a fight, back on the pad-driven screens ─────────────────────
  backEl = document.createElement('button');
  backEl.type = 'button';
  backEl.className = 'touchpad__pause';
  backEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    backLatch = Btn.Pause;
  });
  root.appendChild(backEl);

  document.body.appendChild(root);

  // Which input is live. Touch turns the pad on; a key or a pad turns it off.
  active = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch' && !active) {
        active = true;
        paint();
      }
    },
    true,
  );
  window.addEventListener(
    'keydown',
    () => {
      if (!active) return;
      active = false;
      releaseAll();
      paint();
    },
    true,
  );
  window.addEventListener('gamepadconnected', () => {
    if (!active) return;
    active = false;
    releaseAll();
    paint();
  });
  // A finger lifted while the tab was hidden never sends its pointerup.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  paint();
}

function paint(): void {
  if (!root) return;
  const show = active && mode !== 'off';
  root.hidden = !show;
  root.dataset.mode = mode;
  const fight = mode === 'fight';
  for (const el of root.querySelectorAll<HTMLElement>('.touchpad__zone, .touchpad__buttons')) {
    el.hidden = !fight;
  }
  if (backEl) {
    backEl.textContent = fight ? 'II' : '‹';
    backEl.setAttribute('aria-label', fight ? 'Pause' : 'Back');
  }
}

function releaseAll(): void {
  buttonMask = 0;
  stickMask = 0;
  backLatch = 0;
  stickId = -1;
  buttonIds.clear();
  restStick();
  if (root) for (const b of root.querySelectorAll('.touchpad__btn.is-down')) b.classList.remove('is-down');
}

// ── Stick ────────────────────────────────────────────────────────────────────

function onStickDown(e: PointerEvent): void {
  if (stickId !== -1 || !stickEl || !knobEl) return;
  e.preventDefault();
  stickId = e.pointerId;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
  stickX = e.clientX;
  stickY = e.clientY;
  stickEl.style.left = `${e.clientX - host.left}px`;
  stickEl.style.top = `${e.clientY - host.top}px`;
  stickEl.classList.add('is-active');
  knobEl.style.transform = 'translate(0px, 0px)';
  stickMask = 0;
}

function onStickMove(e: PointerEvent): void {
  if (e.pointerId !== stickId || !knobEl) return;
  e.preventDefault();
  let dx = e.clientX - stickX;
  let dy = e.clientY - stickY;
  const dist = Math.hypot(dx, dy);
  // Drag past the rim and the base follows the thumb, so a long swipe never
  // leaves the stick pinned against an edge the player cannot feel.
  if (dist > STICK_RADIUS) {
    const k = (dist - STICK_RADIUS) / dist;
    stickX += dx * k;
    stickY += dy * k;
    dx = e.clientX - stickX;
    dy = e.clientY - stickY;
    if (stickEl) {
      const host = stickEl.parentElement?.getBoundingClientRect();
      if (host) {
        stickEl.style.left = `${stickX - host.left}px`;
        stickEl.style.top = `${stickY - host.top}px`;
      }
    }
  }
  knobEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;

  const d = Math.hypot(dx, dy);
  let m = 0;
  if (d > DEADZONE) {
    const nx = dx / d;
    const ny = dy / d;
    if (nx > AXIS) m |= Btn.Right;
    else if (nx < -AXIS) m |= Btn.Left;
    if (ny > AXIS) m |= Btn.Down;
    else if (ny < -AXIS) m |= Btn.Up;
    if (d >= RUN_AT) m |= Btn.Run;
  }
  stickMask = m;
}

function onStickUp(e: PointerEvent): void {
  if (e.pointerId !== stickId) return;
  stickId = -1;
  stickMask = 0;
  restStick();
}

/**
 * Back to its resting place, dimmed. It stays visible: an empty left half of
 * the screen does not say "put your thumb here", a faint stick does.
 */
function restStick(): void {
  if (!stickEl || !knobEl) return;
  stickEl.classList.remove('is-active');
  stickEl.style.left = '';
  stickEl.style.top = '';
  knobEl.style.transform = 'translate(0px, 0px)';
}

// ── Buttons ──────────────────────────────────────────────────────────────────

function onButtonDown(e: PointerEvent, el: HTMLElement, bit: number): void {
  e.preventDefault();
  el.setPointerCapture?.(e.pointerId);
  buttonIds.set(e.pointerId, bit);
  buttonMask |= bit;
  el.classList.add('is-down');
  // A short tick under the thumb: glass has no travel, so the press needs a
  // body somewhere. Where the platform allows it, and never more than this.
  navigator.vibrate?.(8);
}

function onButtonUp(e: PointerEvent, el: HTMLElement, bit: number): void {
  if (buttonIds.get(e.pointerId) !== bit) return;
  buttonIds.delete(e.pointerId);
  let still = false;
  for (const b of buttonIds.values()) if (b === bit) still = true;
  if (!still) {
    buttonMask &= ~bit;
    el.classList.remove('is-down');
  }
}
