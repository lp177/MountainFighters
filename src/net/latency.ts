/**
 * Network-delay sizing for deterministic lockstep.
 *
 * Mountain Fighters never predicts remote input: a frame either has every
 * player's buttons or it waits. The input lead therefore has to cover the
 * measured route, packetisation, and ordinary jitter. Keeping this arithmetic
 * in one small module makes the host's choice testable and, more importantly,
 * ensures every peer clamps the negotiated value in exactly the same way.
 */

import { DEFAULT_INPUT_DELAY, SIM_HZ } from '@/core/constants';

export const MAX_INPUT_DELAY = 24;

/** Extra room for the 1-3 frame packet cadence and browser scheduling jitter. */
const SAFETY_FRAMES = 3;
const FRAME_MS = 1000 / SIM_HZ;

export interface RttEstimate {
  /** Smoothed round-trip time. */
  rttMs: number;
  /** Smoothed absolute deviation between samples. */
  jitterMs: number;
  samples: number;
}

export const EMPTY_RTT: Readonly<RttEstimate> = { rttMs: 0, jitterMs: 0, samples: 0 };

/** RFC-style inexpensive smoothing; deterministic and deliberately allocation-light. */
export function addRttSample(previous: RttEstimate, rawSampleMs: number): RttEstimate {
  const sample = Number.isFinite(rawSampleMs) ? Math.max(0, rawSampleMs) : 0;
  if (previous.samples <= 0) return { rttMs: sample, jitterMs: 0, samples: 1 };

  const delta = Math.abs(sample - previous.rttMs);
  return {
    rttMs: previous.rttMs + (sample - previous.rttMs) * 0.125,
    jitterMs: previous.jitterMs + (delta - previous.jitterMs) * 0.25,
    samples: previous.samples + 1,
  };
}

export function clampInputDelay(value: number, minimum = DEFAULT_INPUT_DELAY): number {
  const min = Math.max(0, Math.min(MAX_INPUT_DELAY, Math.round(minimum)));
  const n = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(MAX_INPUT_DELAY, n));
}

/**
 * Size a shared input lead from the slowest host-to-peer route.
 *
 * The start message and the guest's first input also cross the link, so using
 * the complete RTT is intentionally conservative. Two jitter deviations and
 * three simulation frames cover normal variance plus the batched send cadence.
 * The hard cap avoids silently turning a bad route into more than 400ms of
 * fixed control latency; `isInputDelayCapped` lets the UI say when a
 * route exceeded that budget.
 */
export function recommendedInputDelay(
  estimate: Pick<RttEstimate, 'rttMs' | 'jitterMs'>,
  minimum = DEFAULT_INPUT_DELAY,
): number {
  if (!(estimate.rttMs > 0)) return clampInputDelay(minimum, minimum);
  const budgetMs = estimate.rttMs + Math.max(0, estimate.jitterMs) * 2;
  return clampInputDelay(Math.ceil(budgetMs / FRAME_MS) + SAFETY_FRAMES, minimum);
}

export function isInputDelayCapped(estimate: Pick<RttEstimate, 'rttMs' | 'jitterMs'>): boolean {
  if (!(estimate.rttMs > 0)) return false;
  const budgetMs = estimate.rttMs + Math.max(0, estimate.jitterMs) * 2;
  return Math.ceil(budgetMs / FRAME_MS) + SAFETY_FRAMES > MAX_INPUT_DELAY;
}
