/**
 * Deterministic pseudo-random number generation.
 *
 * The entire simulation draws from one of these. mulberry32 is used because it
 * has a single 32-bit word of state, which makes snapshotting it for lockstep
 * checksums and rollback trivially cheap.
 */

import type { Rng } from '@/core/types';

export function makeRng(seed: number): Rng {
  let state = (Number.isFinite(seed) ? seed : 0) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min: number, max: number): number {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      if (hi < lo) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    range(min: number, max: number): number {
      return min + next() * (max - min);
    },
    chance(p: number): boolean {
      return next() < p;
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    getState(): number {
      return state;
    },
    setState(s: number): void {
      state = (Number.isFinite(s) ? s : 0) >>> 0;
    },
  };
}

/**
 * NON-deterministic. Boot-time only: the host rolls one of these and ships it
 * to every peer, after which all randomness is derived from it.
 */
export function randomSeed(): number {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return (Math.floor(Math.random() * 0x100000000) ^ Date.now()) >>> 0;
}
