/**
 * Scalar / easing / collision helpers shared by the whole game.
 *
 * Everything here is pure and deterministic — no wall clock, no Math.random —
 * so it is safe to call from simulation code.
 */

import type { Box3, Facing, Vec3 } from '@/core/types';

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Move `cur` toward `target` by at most `step`, never overshooting. */
export function approach(cur: number, target: number, step: number): number {
  const d = target - cur;
  const s = step < 0 ? -step : step;
  if (d > s) return cur + s;
  if (d < -s) return cur - s;
  return target;
}

export function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Squared distance on the ground plane (x/z), avoiding a sqrt. */
export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function easeIn(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x;
}

export function easeOut(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) * (1 - x);
}

export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/** Overshoots past 1 then settles — the classic UI "pop". */
export function easeOutBack(t: number): number {
  const x = clamp(t, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = x - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** Springy settle, used for select-screen cards and KO text. */
export function easeOutElastic(t: number): number {
  const x = clamp(t, 0, 1);
  if (x === 0 || x === 1) return x;
  const p = TAU / 3;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * p) + 1;
}

/** Interpolate angles the short way around the circle. */
export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/**
 * World-space overlap test for a hitbox against a hurtbox.
 *
 * `Box3.ox` is authored in ENTITY-FACING space: a box in front of a fighter has
 * a positive ox regardless of which way that fighter is turned, so it mirrors
 * with `facing`. Height (oy) and depth (oz) are absolute and never mirror.
 */
export function boxOverlap(
  a: Box3,
  aPos: Vec3,
  aFace: Facing,
  b: Box3,
  bPos: Vec3,
  bFace: Facing,
): boolean {
  const ax = aPos.x + a.ox * aFace;
  const bx = bPos.x + b.ox * bFace;
  if (Math.abs(ax - bx) >= a.hw + b.hw) return false;

  const ay = aPos.y + a.oy;
  const by = bPos.y + b.oy;
  if (Math.abs(ay - by) >= a.hh + b.hh) return false;

  const az = aPos.z + a.oz;
  const bz = bPos.z + b.oz;
  if (Math.abs(az - bz) >= a.hd + b.hd) return false;

  return true;
}

/**
 * Mixes a value into a rolling checksum. Used for desync detection.
 *
 * Floats are quantised to 1/256 before folding so that harmless last-bit
 * differences in presentation-adjacent values cannot fake a desync, while any
 * real divergence in position or velocity still shows up immediately.
 */
export function hashNumber(acc: number, v: number): number {
  const q = Number.isFinite(v) ? Math.round(v * 256) | 0 : 0x7f7f7f7f;
  let h = (acc ^ q) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
