/**
 * Network-delay sizing for deterministic lockstep.
 *
 * Mountain Fighters never predicts remote input: a frame either has every
 * player's buttons or it waits. The input lead therefore has to cover the
 * route an input packet actually travels, plus ordinary jitter. Keeping this
 * arithmetic in one small module makes the host's choice testable and, more
 * importantly, ensures every peer clamps the negotiated value in exactly the
 * same way.
 */

import { DEFAULT_INPUT_DELAY, SIM_HZ } from '@/core/constants';

export const MAX_INPUT_DELAY = 24;

/** Extra room for browser scheduling jitter on top of the measured route. */
const SAFETY_FRAMES = 2;
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
 * Milliseconds of lead one link contributes to the shared input budget.
 *
 * Steady-state lockstep only pays the ONE-WAY trip: input sampled at frame F
 * is addressed to F + delay and has until the peer executes that frame to
 * arrive. Sizing for the full round trip doubled every fight's control
 * latency; what the return leg was quietly buying — margin against the clock
 * offset from `start` crossing the link, and against latency creep after a
 * stall re-anchors a peer's timeline — is bought instead by Lockstep's
 * RESUME_CUSHION, which banks a couple of buffered frames every time a stall
 * ends. The jitter cushion stays at two deviations, measured on the round
 * trip, so it is a deliberately fat margin for a one-way path.
 */
export function routeBudgetMs(estimate: Pick<RttEstimate, 'rttMs' | 'jitterMs'>): number {
  if (!(estimate.rttMs > 0)) return 0;
  return estimate.rttMs / 2 + Math.max(0, estimate.jitterMs) * 2;
}

/**
 * Combine per-link budgets into the worst path across the whole room.
 *
 * Host-to-guest input crosses one link; guest-to-guest input is relayed by the
 * host and crosses two. The worst route is therefore the two largest link
 * budgets summed — or the single budget in the common two-player room, which
 * is exactly where sizing from a full round trip used to double the lead.
 */
export function combinedRouteBudgetMs(budgets: readonly number[]): number {
  let top = 0;
  let second = 0;
  for (const b of budgets) {
    const v = Number.isFinite(b) && b > 0 ? b : 0;
    if (v >= top) {
      second = top;
      top = v;
    } else if (v > second) {
      second = v;
    }
  }
  return top + second;
}

/** Size a shared input lead from a route budget in milliseconds. */
export function recommendedInputDelayForBudget(
  budgetMs: number,
  minimum = DEFAULT_INPUT_DELAY,
): number {
  if (!(budgetMs > 0)) return clampInputDelay(minimum, minimum);
  return clampInputDelay(Math.ceil(budgetMs / FRAME_MS) + SAFETY_FRAMES, minimum);
}

/** Single-link convenience over routeBudgetMs + recommendedInputDelayForBudget. */
export function recommendedInputDelay(
  estimate: Pick<RttEstimate, 'rttMs' | 'jitterMs'>,
  minimum = DEFAULT_INPUT_DELAY,
): number {
  return recommendedInputDelayForBudget(routeBudgetMs(estimate), minimum);
}

/**
 * True when the measured route wanted more buffering than the gameplay cap
 * permits. The hard cap avoids silently turning a bad route into more than
 * 400ms of fixed control latency; the UI uses this to say a route exceeded
 * that budget.
 */
export function isBudgetCapped(budgetMs: number): boolean {
  if (!(budgetMs > 0)) return false;
  return Math.ceil(budgetMs / FRAME_MS) + SAFETY_FRAMES > MAX_INPUT_DELAY;
}

export function isInputDelayCapped(estimate: Pick<RttEstimate, 'rttMs' | 'jitterMs'>): boolean {
  return isBudgetCapped(routeBudgetMs(estimate));
}
