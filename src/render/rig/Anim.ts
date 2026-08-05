/**
 * Hand-authored keyframe animation for the vector rigs.
 *
 * AUTHORING CONVENTION — every helper below normalises signs so that, in clip
 * data, POSITIVE ALWAYS MEANS FORWARD (the direction the character faces):
 *   spine(t, c, n, h)  positive leans/nods forward
 *   arms(lu, ll, ru, rl)  upper positive swings forward, lower positive flexes
 *                         the elbow (hand toward the face)
 *   legs(lu, ll, ru, rl, lf, rf)  upper positive kicks the thigh forward, lower
 *                         positive flexes the knee (heel toward the backside),
 *                         lf/rf tilt the ankle away from a flat sole
 *   hips(rot, x, y)       positive rot tips the whole body forward
 *   body(x, y)            whole-rig translation, +y is UP
 *
 * L is the far-side limb, R the near-side limb. Clips are written for a
 * right-handed fighter: the near arm throws the punches.
 */

import type { AnimClip, AnimKeyframe, BoneName, BonePose, Pose } from '@/core/types';
import { clamp, easeIn, easeInOut, easeOut, lerp } from '@/core/math';

// ─────────────────────────────────────────────────────────────────────────────
// Pose plumbing
// ─────────────────────────────────────────────────────────────────────────────

const REST: BonePose = { rot: 0, x: 0, y: 0, scale: 1 };

/** Shallow-merges pose fragments left to right. */
function merge(...parts: Pose[]): Pose {
  const out: Pose = {};
  for (const part of parts) {
    for (const key of Object.keys(part) as BoneName[]) {
      const src = part[key];
      if (!src) continue;
      out[key] = { ...out[key], ...src };
    }
  }
  return out;
}

function clonePose(p: Pose): Pose {
  const out: Pose = {};
  for (const key of Object.keys(p) as BoneName[]) {
    const src = p[key];
    if (src) out[key] = { ...src };
  }
  return out;
}

export function blendPose(a: Pose, b: Pose, t: number): Pose {
  if (t <= 0) return clonePose(a);
  if (t >= 1) return clonePose(b);
  const out: Pose = {};
  const names = new Set<BoneName>([
    ...(Object.keys(a) as BoneName[]),
    ...(Object.keys(b) as BoneName[]),
  ]);
  for (const name of names) {
    const pa = a[name] ?? REST;
    const pb = b[name] ?? REST;
    out[name] = {
      rot: lerp(pa.rot ?? 0, pb.rot ?? 0, t),
      x: lerp(pa.x ?? 0, pb.x ?? 0, t),
      y: lerp(pa.y ?? 0, pb.y ?? 0, t),
      scale: lerp(pa.scale ?? 1, pb.scale ?? 1, t),
    };
  }
  return out;
}

function applyEase(kind: AnimKeyframe['ease'], t: number): number {
  switch (kind) {
    case 'easeIn':
      return easeIn(t);
    case 'easeOut':
      return easeOut(t);
    case 'easeInOut':
      return easeInOut(t);
    default:
      return t;
  }
}

/** Sample a clip at a frame, producing a blended pose. */
export function sampleClip(clip: AnimClip, frame: number): Pose {
  const fr = clip.frames;
  if (fr.length === 0) return {};
  if (fr.length === 1) return clonePose(fr[0].pose);

  const dur = Math.max(1, clip.duration);
  const t = clip.loop
    ? ((frame % dur) + dur) % dur
    : clamp(frame, fr[0].t, Math.max(dur, fr[fr.length - 1].t));

  let i = 0;
  for (let n = 0; n < fr.length; n++) {
    if (fr[n].t <= t) i = n;
    else break;
  }

  const a = fr[i];
  let b: AnimKeyframe;
  let span: number;

  if (i >= fr.length - 1) {
    if (!clip.loop) return clonePose(a.pose);
    b = fr[0];
    span = dur - a.t + fr[0].t;
  } else {
    b = fr[i + 1];
    span = b.t - a.t;
  }

  if (b.ease === 'snap') return clonePose(a.pose);
  if (span <= 0) return clonePose(b.pose);

  const u = applyEase(b.ease ?? 'linear', clamp((t - a.t) / span, 0, 1));
  return blendPose(a.pose, b.pose, u);
}

export const CLIPS: Record<string, AnimClip> = {};

export function registerClip(clip: AnimClip): void {
  CLIPS[clip.name] = clip;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoring helpers
// ─────────────────────────────────────────────────────────────────────────────

type Ease = AnimKeyframe['ease'];

function kf(t: number, pose: Pose, ease: Ease = 'easeInOut'): AnimKeyframe {
  return { t, pose, ease };
}

function clip(name: string, duration: number, loop: boolean, frames: AnimKeyframe[]): void {
  registerClip({ name, duration, loop, frames });
}

/** Whole-rig translation. +y is up. */
function body(x: number, y: number): Pose {
  return { root: { x, y } };
}

/** Tips the entire rig about the feet. Positive falls forward, onto the face. */
function tilt(rot: number): Pose {
  return { root: { rot: -rot } };
}

function hips(rot: number, x = 0, y = 0): Pose {
  return { pelvis: { rot: -rot, x, y } };
}

function spine(t: number, c = 0, n = 0, h = 0): Pose {
  return { torso: { rot: -t }, chest: { rot: -c }, neck: { rot: -n }, head: { rot: -h } };
}

function arms(lu: number, ll: number, ru: number, rl: number): Pose {
  return {
    armL_upper: { rot: lu },
    armL_lower: { rot: ll },
    armR_upper: { rot: ru },
    armR_lower: { rot: rl },
  };
}

function hands(l: number, r: number): Pose {
  return { handL: { rot: l }, handR: { rot: r } };
}

/**
 * Thigh and knee per leg, plus the ankles. Ankle angles are relative to a FLAT
 * SOLE — the knee flex is compensated for automatically, so `0` keeps the foot
 * on the floor however deep the crouch, positive lifts the toes and negative
 * points them.
 */
function legs(
  lu: number, ll: number, ru: number, rl: number,
  lf = 0, rf = 0,
): Pose {
  return {
    legL_upper: { rot: lu },
    legL_lower: { rot: -ll },
    footL: { rot: ll - lu + lf },
    legR_upper: { rot: ru },
    legR_lower: { rot: -rl },
    footR: { rot: rl - ru + rf },
  };
}

/** Cap flop and beard swing, positive forward. */
function head2(hatRot: number, beardRot: number): Pose {
  return { hat: { rot: -hatRot }, beard: { rot: beardRot } };
}

/** The neutral standing pose every clip departs from. */
const STAND: Pose = merge(
  body(0, 0),
  hips(0),
  spine(0, 0, 0, 0),
  arms(0, 0.1, 0, 0.1),
  hands(0, 0),
  legs(0, 0.05, 0, 0.05, 0, 0),
  head2(0, 0),
);

// ─────────────────────────────────────────────────────────────────────────────
// Locomotion
// ─────────────────────────────────────────────────────────────────────────────

clip('idle', 90, true, [
  kf(0, merge(
    body(0, 0), hips(0.02, -0.3), spine(0.01, 0.02, 0, 0.01),
    arms(-0.05, 0.16, 0.05, 0.14), hands(0, 0),
    legs(0.03, 0.07, -0.03, 0.06, 0, 0), head2(0.03, 0.04),
  )),
  // inhale — chest opens, beard lifts, weight rolls onto the back foot
  kf(16, merge(
    body(0, 0.5), hips(-0.02, -0.5), spine(-0.03, -0.05, 0.01, -0.02),
    arms(-0.09, 0.19, 0.09, 0.17), hands(0, 0),
    legs(0.05, 0.05, -0.05, 0.04, 0.02, 0.02), head2(-0.04, -0.05),
  )),
  kf(30, merge(
    body(0, 0.15), hips(0.03, 0), spine(0.03, 0.04, 0, 0.02),
    arms(-0.03, 0.14, 0.03, 0.12), hands(0, 0),
    legs(0.02, 0.08, -0.02, 0.07, 0, 0), head2(0.05, 0.07),
  )),
  // weight shift onto the front foot, shoulders roll
  kf(46, merge(
    body(0, 0.05), hips(0.04, 0.45), spine(0.02, 0.03, 0.01, 0.03),
    arms(0.06, 0.13, -0.04, 0.15), hands(0.05, -0.05),
    legs(-0.05, 0.05, 0.06, 0.09, 0, 0.02), head2(0.02, 0.02),
  )),
  kf(62, merge(
    body(0, 0.5), hips(-0.01, 0.3), spine(-0.03, -0.04, 0, -0.02),
    arms(0.02, 0.18, 0.02, 0.18), hands(0, 0),
    legs(-0.02, 0.06, 0.03, 0.07, 0.02, 0), head2(-0.05, -0.06),
  )),
  kf(78, merge(
    body(0, 0.1), hips(0.03, -0.1), spine(0.02, 0.03, 0, 0.02),
    arms(-0.03, 0.15, 0.04, 0.13), hands(0, 0),
    legs(0.01, 0.07, -0.01, 0.06, 0, 0), head2(0.04, 0.05),
  )),
]);

clip('walk', 24, true, [
  // contact: near leg forward, far leg trailing
  kf(0, merge(
    body(0, 0), hips(0.05, 0.3), spine(0.04, 0.02, 0, -0.03),
    arms(0.5, 0.2, -0.42, 0.28), hands(0, 0),
    legs(-0.52, 0.18, 0.55, 0.06, -0.25, 0.3), head2(-0.12, -0.08),
  ), 'easeOut'),
  // down: weight absorbs, body drops
  kf(3, merge(
    body(0, -1.3), hips(0.09, 0.15), spine(0.06, 0.03, 0, -0.02),
    arms(0.36, 0.22, -0.3, 0.3), hands(0, 0),
    legs(-0.4, 0.3, 0.42, 0.22, -0.1, 0.12), head2(0.1, 0.12),
  ), 'easeIn'),
  // pass: trailing leg swings through under the body
  kf(6, merge(
    body(0.3, 0.4), hips(0.04, -0.2), spine(0.03, 0.02, 0, 0.01),
    arms(0.14, 0.18, -0.12, 0.24), hands(0, 0),
    legs(0.16, 0.62, -0.06, 0.06, 0.18, -0.06), head2(0.06, 0.05),
  )),
  // up: push-off, hips at their highest
  kf(9, merge(
    body(0, 1.1), hips(0.06, -0.35), spine(0.05, 0.02, 0, -0.02),
    arms(-0.22, 0.2, 0.3, 0.26), hands(0, 0),
    legs(0.45, 0.24, -0.44, 0.3, 0.24, -0.3), head2(-0.1, -0.09),
  ), 'easeOut'),
  kf(12, merge(
    body(0, 0), hips(0.05, -0.3), spine(0.04, 0.02, 0, -0.03),
    arms(-0.42, 0.28, 0.5, 0.2), hands(0, 0),
    legs(0.55, 0.06, -0.52, 0.18, 0.3, -0.25), head2(-0.12, -0.08),
  ), 'easeOut'),
  kf(15, merge(
    body(0, -1.3), hips(0.09, -0.15), spine(0.06, 0.03, 0, -0.02),
    arms(-0.3, 0.3, 0.36, 0.22), hands(0, 0),
    legs(0.42, 0.22, -0.4, 0.3, 0.12, -0.1), head2(0.1, 0.12),
  ), 'easeIn'),
  kf(18, merge(
    body(-0.3, 0.4), hips(0.04, 0.2), spine(0.03, 0.02, 0, 0.01),
    arms(-0.12, 0.24, 0.14, 0.18), hands(0, 0),
    legs(-0.06, 0.06, 0.16, 0.62, -0.06, 0.18), head2(0.06, 0.05),
  )),
  kf(21, merge(
    body(0, 1.1), hips(0.06, 0.35), spine(0.05, 0.02, 0, -0.02),
    arms(0.3, 0.26, -0.22, 0.2), hands(0, 0),
    legs(-0.44, 0.3, 0.45, 0.24, -0.3, 0.24), head2(-0.1, -0.09),
  ), 'easeOut'),
]);

clip('run', 18, true, [
  // contact, hard forward lean, arms pumping
  kf(0, merge(
    body(0, 0), hips(0.2, 0.6), spine(0.16, 0.08, -0.04, -0.1),
    arms(1.0, 0.95, -0.85, 1.05), hands(0, 0),
    legs(-0.8, 0.5, 0.85, 0.25, -0.4, 0.45), head2(-0.3, -0.22),
  ), 'easeOut'),
  kf(3, merge(
    body(0.4, -2.2), hips(0.26, 0.3), spine(0.2, 0.1, -0.05, -0.06),
    arms(0.7, 1.0, -0.5, 1.1), hands(0, 0),
    legs(-0.55, 0.75, 0.6, 0.55, -0.2, 0.2), head2(0.24, 0.3),
  ), 'easeIn'),
  // pass: back leg folds tight and drives through
  kf(6, merge(
    body(0.6, 1.6), hips(0.18, -0.3), spine(0.15, 0.07, -0.03, -0.02),
    arms(0.2, 0.9, 0.05, 0.95), hands(0, 0),
    legs(0.35, 1.5, -0.25, 0.2, 0.4, -0.15), head2(0.1, 0.14),
  )),
  // airborne: both feet off the ground
  kf(9, merge(
    body(0, 3.2), hips(0.19, -0.6), spine(0.16, 0.08, -0.04, -0.1),
    arms(-0.85, 1.05, 1.0, 0.95), hands(0, 0),
    legs(0.85, 0.25, -0.8, 0.5, 0.45, -0.4), head2(-0.3, -0.24),
  ), 'easeOut'),
  kf(12, merge(
    body(-0.4, -2.2), hips(0.26, -0.3), spine(0.2, 0.1, -0.05, -0.06),
    arms(-0.5, 1.1, 0.7, 1.0), hands(0, 0),
    legs(0.6, 0.55, -0.55, 0.75, 0.2, -0.2), head2(0.24, 0.3),
  ), 'easeIn'),
  kf(15, merge(
    body(-0.6, 1.6), hips(0.18, 0.3), spine(0.15, 0.07, -0.03, -0.02),
    arms(0.05, 0.95, 0.2, 0.9), hands(0, 0),
    legs(-0.25, 0.2, 0.35, 1.5, -0.15, 0.4), head2(0.1, 0.14),
  )),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Air
// ─────────────────────────────────────────────────────────────────────────────

clip('jump', 22, false, [
  kf(0, STAND, 'snap'),
  // gather: squash down, arms drop behind
  kf(4, merge(
    body(0, -3.4), hips(0.14, -0.4), spine(0.18, 0.08, -0.06, -0.12),
    arms(-0.75, 0.35, -0.7, 0.4), hands(0, 0),
    legs(0.55, 1.1, 0.5, 1.05, 0.35, 0.35), head2(0.28, 0.3),
  ), 'easeIn'),
  // launch: everything extends, arms rip upward
  kf(8, merge(
    body(0, 2.6), hips(-0.06, 0.2), spine(-0.08, -0.05, 0.04, 0.06),
    arms(1.9, 0.1, 1.95, 0.08), hands(0, 0),
    legs(-0.1, 0.05, -0.05, 0.05, -0.5, -0.5), head2(-0.5, -0.45),
  ), 'easeOut'),
  // tuck at the apex
  kf(16, merge(
    body(0, 1.2), hips(0.06, 0), spine(0.06, 0.03, 0, -0.04),
    arms(1.1, 0.5, 1.25, 0.45), hands(0, 0),
    legs(0.5, 0.9, 0.3, 1.15, 0.3, 0.4), head2(-0.2, -0.15),
  )),
  kf(22, merge(
    body(0, 0.8), hips(0.05, 0), spine(0.05, 0.02, 0, -0.02),
    arms(0.95, 0.55, 1.05, 0.5), hands(0, 0),
    legs(0.35, 0.7, 0.2, 0.95, 0.2, 0.3), head2(-0.12, -0.08),
  )),
]);

clip('fall', 30, true, [
  kf(0, merge(
    body(0, 0), hips(-0.08, -0.2), spine(-0.06, -0.04, 0.03, 0.05),
    arms(1.35, 0.35, 1.15, 0.45), hands(0, 0),
    legs(-0.25, 0.35, 0.3, 0.75, -0.2, 0.15), head2(-0.35, -0.3),
  )),
  kf(15, merge(
    body(0, 0), hips(-0.05, 0.2), spine(-0.04, -0.03, 0.02, 0.03),
    arms(1.15, 0.5, 1.35, 0.3), hands(0, 0),
    legs(0.3, 0.7, -0.2, 0.4, 0.15, -0.2), head2(-0.42, -0.36),
  )),
]);

clip('land', 14, false, [
  kf(0, merge(
    body(0, 0.6), hips(0.02, 0), spine(0.02, 0, 0, 0),
    arms(0.9, 0.5, 1.0, 0.45), hands(0, 0),
    legs(0.25, 0.5, 0.15, 0.6, 0.25, 0.3), head2(-0.15, -0.1),
  ), 'snap'),
  // absorb hard — knees swallow the drop, beard whips down
  kf(4, merge(
    body(0, -4.6), hips(0.24, 0), spine(0.3, 0.14, -0.08, -0.18),
    arms(-0.55, 0.75, -0.5, 0.8), hands(0, 0),
    legs(0.7, 1.5, 0.6, 1.45, 0.45, 0.45), head2(0.5, 0.55),
  ), 'easeIn'),
  kf(9, merge(
    body(0, -1.2), hips(0.1, 0), spine(0.1, 0.05, -0.02, -0.04),
    arms(-0.2, 0.35, -0.18, 0.36), hands(0, 0),
    legs(0.25, 0.6, 0.2, 0.55, 0.15, 0.15), head2(0.16, 0.2),
  ), 'easeOut'),
  kf(14, STAND),
]);

clip('block', 10, false, [
  kf(0, STAND, 'snap'),
  // shoulder turned in, both forearms stacked as a shield
  kf(4, merge(
    body(-0.6, -1.2), hips(0.06, -0.6), spine(0.1, 0.06, 0.02, 0.04),
    arms(0.55, 1.55, 0.9, 1.7), hands(-0.2, -0.25),
    legs(-0.3, 0.35, 0.35, 0.55, -0.15, 0.1), head2(0.18, 0.22),
  ), 'easeOut'),
  kf(10, merge(
    body(-0.4, -1.0), hips(0.05, -0.5), spine(0.09, 0.05, 0.02, 0.04),
    arms(0.5, 1.5, 0.85, 1.65), hands(-0.2, -0.25),
    legs(-0.28, 0.32, 0.32, 0.5, -0.12, 0.08), head2(0.15, 0.18),
  )),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Strikes
// ─────────────────────────────────────────────────────────────────────────────

clip('punch1', 16, false, [
  kf(0, STAND, 'snap'),
  // wind: hips rotate away, punching shoulder loads back
  kf(3, merge(
    body(-0.8, -0.4), hips(-0.06, -1.1), spine(-0.05, -0.08, 0.03, 0.06),
    arms(0.7, 1.2, -0.55, 1.35), hands(0, -0.15),
    legs(-0.2, 0.25, 0.28, 0.4, -0.1, 0.08), head2(-0.14, -0.12),
  ), 'easeIn'),
  // snap: hips drive through, arm fires straight out
  kf(6, merge(
    body(2.2, 0), hips(0.1, 1.6), spine(0.14, 0.18, -0.04, -0.06),
    arms(0.15, 1.5, 1.52, 0.06), hands(0, 0.1),
    legs(-0.42, 0.2, 0.4, 0.18, -0.2, 0.16), head2(-0.25, -0.2),
  ), 'easeOut'),
  kf(8, merge(
    body(1.9, 0), hips(0.09, 1.4), spine(0.13, 0.17, -0.04, -0.05),
    arms(0.2, 1.45, 1.46, 0.1), hands(0, 0.1),
    legs(-0.4, 0.2, 0.38, 0.18, -0.2, 0.15), head2(-0.2, -0.16),
  ), 'linear'),
  // recover, hand snaps back to guard
  kf(12, merge(
    body(0.4, -0.3), hips(0.04, 0.3), spine(0.05, 0.06, 0, 0),
    arms(0.2, 0.9, 0.35, 1.1), hands(0, 0),
    legs(-0.15, 0.2, 0.16, 0.24, -0.06, 0.06), head2(0.14, 0.16),
  ), 'easeOut'),
  kf(16, STAND),
]);

clip('punch2', 20, false, [
  // picks up where punch1 left off — near hand still out, far shoulder loading
  kf(0, merge(
    body(1.2, 0), hips(0.06, 0.9), spine(0.1, 0.12, -0.02, -0.04),
    arms(-0.5, 1.3, 1.2, 0.4), hands(0, 0.1),
    legs(-0.3, 0.2, 0.3, 0.2, -0.14, 0.12), head2(-0.16, -0.12),
  ), 'snap'),
  kf(4, merge(
    body(-0.6, -0.6), hips(-0.1, -1.4), spine(-0.1, -0.12, 0.05, 0.1),
    arms(-0.85, 1.5, 0.5, 1.25), hands(-0.1, 0),
    legs(-0.12, 0.35, 0.22, 0.5, -0.05, 0.05), head2(-0.1, -0.1),
  ), 'easeIn'),
  // cross: far arm whips over, whole torso rotates into it
  kf(8, merge(
    body(3.4, -0.8), hips(0.1, 2.2), spine(0.2, 0.22, -0.07, -0.1),
    arms(1.6, 0.05, -0.3, 1.5), hands(0.15, 0),
    legs(-0.55, 0.18, 0.52, 0.3, -0.28, 0.24), head2(-0.34, -0.28),
  ), 'easeOut'),
  kf(11, merge(
    body(3.0, -0.7), hips(0.17, 2.0), spine(0.24, 0.28, -0.08, -0.1),
    arms(1.52, 0.12, -0.24, 1.44), hands(0.15, 0),
    legs(-0.52, 0.18, 0.5, 0.3, -0.26, 0.22), head2(-0.28, -0.22),
  ), 'linear'),
  kf(16, merge(
    body(0.6, -0.3), hips(0.05, 0.4), spine(0.06, 0.07, 0, 0),
    arms(0.4, 1.0, 0.25, 1.0), hands(0, 0),
    legs(-0.18, 0.22, 0.2, 0.26, -0.08, 0.08), head2(0.2, 0.24),
  ), 'easeOut'),
  kf(20, STAND),
]);

clip('kick', 22, false, [
  kf(0, STAND, 'snap'),
  // chamber the knee
  kf(5, merge(
    body(-0.6, -1.4), hips(-0.14, -0.8), spine(-0.12, -0.06, 0.04, 0.08),
    arms(0.9, 1.1, -0.7, 1.3), hands(0, 0),
    legs(-0.25, 0.35, 1.05, 1.65, -0.12, 0.5), head2(-0.2, -0.18),
  ), 'easeIn'),
  // extend — leg snaps out flat, body counter-leans away
  kf(9, merge(
    body(1.4, -0.6), hips(-0.3, 0.6), spine(-0.28, -0.14, 0.06, 0.12),
    arms(1.25, 0.8, -1.0, 1.15), hands(0, 0),
    legs(-0.45, 0.15, 1.5, 0.05, -0.2, -0.35), head2(-0.4, -0.34),
  ), 'easeOut'),
  kf(12, merge(
    body(1.2, -0.6), hips(-0.28, 0.5), spine(-0.26, -0.13, 0.06, 0.11),
    arms(1.2, 0.85, -0.95, 1.15), hands(0, 0),
    legs(-0.42, 0.15, 1.42, 0.1, -0.2, -0.3), head2(-0.34, -0.28),
  ), 'linear'),
  // re-chamber, then plant
  kf(16, merge(
    body(0.2, -1.0), hips(-0.1, 0), spine(-0.08, -0.04, 0.02, 0.04),
    arms(0.6, 0.9, -0.3, 1.1), hands(0, 0),
    legs(-0.2, 0.3, 0.75, 1.35, -0.1, 0.35), head2(0.16, 0.2),
  ), 'easeOut'),
  kf(22, STAND),
]);

clip('uppercut', 28, false, [
  kf(0, STAND, 'snap'),
  // deep crouch, fist drops to the hip
  kf(7, merge(
    body(-0.4, -5.2), hips(0.2, -0.8), spine(0.26, 0.12, -0.08, -0.16),
    arms(-0.6, 0.5, -1.0, 0.35), hands(0, -0.2),
    legs(0.65, 1.55, 0.6, 1.5, 0.5, 0.5), head2(0.4, 0.44),
  ), 'easeIn'),
  // explode: legs snap straight, fist rips up through the chin
  kf(11, merge(
    body(0.9, 3.4), hips(-0.24, 0.6), spine(-0.3, -0.2, 0.1, 0.18),
    arms(-0.3, 0.4, 2.55, 0.25), hands(0, 0.2),
    legs(-0.2, 0.1, -0.15, 0.08, -0.45, -0.4), head2(-0.6, -0.55),
  ), 'easeOut'),
  kf(15, merge(
    body(0.7, 2.4), hips(-0.2, 0.5), spine(-0.26, -0.18, 0.08, 0.16),
    arms(-0.25, 0.4, 2.7, 0.3), hands(0, 0.2),
    legs(-0.15, 0.15, -0.1, 0.12, -0.4, -0.35), head2(-0.55, -0.5),
  ), 'linear'),
  // land out of it
  kf(21, merge(
    body(0.2, -1.6), hips(0.12, 0), spine(0.14, 0.07, -0.02, -0.06),
    arms(0.1, 0.6, 1.1, 0.7), hands(0, 0),
    legs(0.3, 0.7, 0.25, 0.65, 0.2, 0.2), head2(0.24, 0.28),
  ), 'easeOut'),
  kf(28, STAND),
]);

clip('sweep', 24, false, [
  kf(0, STAND, 'snap'),
  // drop the whole body, plant both hands
  kf(6, merge(
    body(-1.2, -4.4), hips(0.12, -1.2), spine(0.6, 0.26, -0.12, -0.22),
    arms(-0.9, 0.3, -1.1, 0.25), hands(-0.3, -0.3),
    legs(0.5, 1.7, 0.2, 1.75, 0.4, 0.4), head2(0.55, 0.6),
  ), 'easeIn'),
  // the sweeping leg scythes forward, skimming the floor the whole way
  kf(8, merge(
    body(-0.4, -4.7), hips(0.13, -0.4), spine(0.64, 0.28, -0.13, -0.23),
    arms(-1.05, 0.25, -1.2, 0.2), hands(-0.32, -0.32),
    legs(0.55, 1.78, 0.95, 0.92, 0.4, -0.15),
  ), 'linear'),
  kf(10, merge(
    body(0.6, -4.9), hips(0.14, 0.4), spine(0.68, 0.3, -0.14, -0.24),
    arms(-1.2, 0.2, -1.35, 0.15), hands(-0.35, -0.35),
    legs(0.55, 1.8, 1.55, 0.05, 0.45, -0.5), head2(0.6, 0.66),
  ), 'easeOut'),
  kf(13, merge(
    body(0.5, -4.8), hips(0.13, 0.3), spine(0.66, 0.29, -0.13, -0.22),
    arms(-1.15, 0.2, -1.3, 0.15), hands(-0.35, -0.35),
    legs(0.55, 1.78, 1.42, 0.12, 0.45, -0.45), head2(0.58, 0.62),
  ), 'linear'),
  // gather the leg back under and stand
  kf(18, merge(
    body(0, -2.6), hips(0.08, 0), spine(0.38, 0.17, -0.08, -0.14),
    arms(-0.5, 0.4, -0.6, 0.4), hands(-0.15, -0.15),
    legs(0.4, 1.2, 0.5, 1.3, 0.3, 0.35), head2(0.34, 0.4),
  ), 'easeOut'),
  kf(24, STAND),
]);

clip('heavy_swing', 40, false, [
  kf(0, STAND, 'snap'),
  // telegraph: the fist goes all the way behind, weight on the back foot
  kf(10, merge(
    body(-2.4, -1.6), hips(-0.16, -2.6), spine(-0.16, -0.22, 0.08, 0.2),
    arms(1.0, 1.1, -1.35, 0.5), hands(0, -0.3),
    legs(0.05, 0.45, 0.35, 0.75, 0.05, 0.15), head2(-0.3, -0.26),
  ), 'easeInOut'),
  // a beat of stillness at full stretch, then everything unloads
  kf(15, merge(
    body(-2.8, -1.8), hips(-0.18, -3.0), spine(-0.18, -0.25, 0.09, 0.22),
    arms(1.05, 1.15, -1.45, 0.45), hands(0, -0.32),
    legs(0.02, 0.5, 0.38, 0.8, 0.05, 0.18), head2(-0.34, -0.3),
  ), 'easeIn'),
  // haymaker connects with the whole torso behind it
  kf(20, merge(
    body(4.6, -0.6), hips(0.14, 3.4), spine(0.26, 0.3, -0.12, -0.16),
    arms(-0.6, 1.3, 1.75, 0.05), hands(0, 0.2),
    legs(-0.7, 0.2, 0.65, 0.25, -0.35, 0.3), head2(-0.5, -0.42),
  ), 'easeOut'),
  // over-rotation: the punch drags him past his own balance
  kf(27, merge(
    body(5.2, -1.4), hips(0.2, 3.8), spine(0.34, 0.34, -0.14, -0.08),
    arms(-1.0, 1.0, 2.35, 0.4), hands(0, 0.1),
    legs(-0.75, 0.35, 0.7, 0.5, -0.3, 0.35), head2(0.3, 0.4),
  )),
  kf(34, merge(
    body(1.6, -0.8), hips(0.14, 1.2), spine(0.18, 0.16, -0.04, -0.02),
    arms(-0.2, 0.8, 0.9, 0.8), hands(0, 0),
    legs(-0.3, 0.3, 0.3, 0.35, -0.12, 0.12), head2(0.3, 0.34),
  ), 'easeOut'),
  kf(40, STAND),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

clip('weapon_swing', 26, false, [
  kf(0, STAND, 'snap'),
  // raise it over the shoulder
  kf(7, merge(
    body(-1.0, -0.6), hips(-0.1, -1.2), spine(-0.12, -0.14, 0.06, 0.12),
    arms(0.4, 0.9, -0.9, 1.6), hands(0, -0.35),
    legs(-0.1, 0.3, 0.2, 0.45, -0.05, 0.1), head2(-0.2, -0.18),
  ), 'easeIn'),
  // chop down and through
  kf(11, merge(
    body(2.6, -0.4), hips(0.22, 2.0), spine(0.3, 0.32, -0.1, -0.14),
    arms(0.1, 1.1, 1.35, 0.15), hands(0, 0.25),
    legs(-0.5, 0.22, 0.48, 0.24, -0.24, 0.2), head2(-0.36, -0.3),
  ), 'easeOut'),
  kf(14, merge(
    body(2.4, -0.6), hips(0.24, 1.8), spine(0.32, 0.34, -0.1, -0.12),
    arms(0.05, 1.1, 1.05, 0.3), hands(0, 0.2),
    legs(-0.48, 0.26, 0.46, 0.3, -0.22, 0.2), head2(-0.2, -0.14),
  ), 'linear'),
  kf(20, merge(
    body(0.5, -0.3), hips(0.06, 0.4), spine(0.08, 0.08, -0.02, 0),
    arms(0.2, 0.9, 0.5, 0.9), hands(0, 0),
    legs(-0.2, 0.24, 0.2, 0.26, -0.08, 0.08), head2(0.2, 0.24),
  ), 'easeOut'),
  kf(26, STAND),
]);

clip('weapon_heavy', 38, false, [
  kf(0, STAND, 'snap'),
  // two-handed load, all the way round behind the head
  kf(12, merge(
    body(-2.2, -1.2), hips(-0.2, -2.8), spine(-0.2, -0.28, 0.1, 0.24),
    arms(-1.15, 1.75, -1.3, 1.85), hands(-0.3, -0.35),
    legs(0.1, 0.5, 0.4, 0.85, 0.1, 0.2), head2(-0.38, -0.34),
  ), 'easeInOut'),
  kf(17, merge(
    body(-2.6, -1.4), hips(-0.22, -3.2), spine(-0.22, -0.3, 0.11, 0.26),
    arms(-1.25, 1.8, -1.4, 1.9), hands(-0.32, -0.36),
    legs(0.08, 0.55, 0.42, 0.9, 0.1, 0.22), head2(-0.4, -0.36),
  ), 'easeIn'),
  // home run
  kf(22, merge(
    body(4.8, -0.8), hips(0.16, 3.6), spine(0.28, 0.32, -0.13, -0.18),
    arms(1.5, 0.25, 1.62, 0.15), hands(0.2, 0.25),
    legs(-0.72, 0.24, 0.68, 0.28, -0.36, 0.3), head2(-0.52, -0.44),
  ), 'easeOut'),
  kf(28, merge(
    body(5.4, -1.6), hips(0.22, 4.0), spine(0.36, 0.36, -0.15, -0.06),
    arms(2.5, 0.6, 2.6, 0.5), hands(0.1, 0.15),
    legs(-0.78, 0.4, 0.72, 0.55, -0.3, 0.36), head2(0.34, 0.44),
  )),
  kf(33, merge(
    body(1.4, -0.8), hips(0.12, 1.0), spine(0.16, 0.14, -0.04, -0.02),
    arms(0.6, 1.0, 0.7, 0.95), hands(0, 0),
    legs(-0.28, 0.32, 0.28, 0.36, -0.1, 0.12), head2(0.3, 0.34),
  ), 'easeOut'),
  kf(38, STAND),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Taking it
// ─────────────────────────────────────────────────────────────────────────────

clip('hurt_light', 14, false, [
  // the hit lands on frame 0 — no ease in, it just happens
  kf(0, merge(
    body(-1.8, 0), hips(-0.18, -1.0), spine(-0.22, -0.16, 0.12, 0.3),
    arms(-0.5, 0.9, -0.4, 0.85), hands(0.2, 0.2),
    legs(0.3, 0.4, -0.35, 0.5, 0.15, -0.1), head2(-0.55, -0.5),
  ), 'snap'),
  kf(4, merge(
    body(-2.4, -0.4), hips(-0.22, -1.4), spine(-0.26, -0.2, 0.14, 0.34),
    arms(-0.7, 1.0, -0.55, 0.95), hands(0.25, 0.25),
    legs(0.36, 0.45, -0.4, 0.55, 0.18, -0.12), head2(0.4, 0.5),
  ), 'easeOut'),
  kf(9, merge(
    body(-0.6, -0.2), hips(-0.06, -0.4), spine(-0.08, -0.05, 0.04, 0.1),
    arms(-0.2, 0.5, -0.15, 0.5), hands(0.1, 0.1),
    legs(0.12, 0.25, -0.12, 0.3, 0.06, -0.04), head2(-0.2, -0.16),
  ), 'easeInOut'),
  kf(14, STAND),
]);

clip('hurt_heavy', 26, false, [
  kf(0, merge(
    body(-2.4, 0.4), tilt(-0.1), hips(-0.3, -1.6), spine(-0.4, -0.3, 0.2, 0.5),
    arms(-0.9, 1.2, -0.8, 1.1), hands(0.3, 0.3),
    legs(0.5, 0.5, -0.5, 0.6, 0.2, -0.15), head2(-0.8, -0.7),
  ), 'snap'),
  // full stagger — spine arcs back, feet leave the floor for a beat
  kf(6, merge(
    body(-5.2, -0.6), tilt(-0.26), hips(-0.42, -2.6), spine(-0.5, -0.4, 0.26, 0.6),
    arms(-1.3, 1.35, -1.15, 1.3), hands(0.35, 0.35),
    legs(0.75, 0.7, -0.6, 0.9, 0.3, -0.2), head2(0.75, 0.85),
  ), 'easeOut'),
  // stumble backwards to catch himself
  kf(13, merge(
    body(-7.5, -2.2), tilt(-0.16), hips(-0.3, -2.0), spine(-0.3, -0.24, 0.16, 0.4),
    arms(-0.6, 1.4, -0.5, 1.35), hands(0.2, 0.2),
    legs(-0.5, 0.9, 0.55, 0.5, -0.2, 0.25), head2(0.5, 0.6),
  )),
  kf(19, merge(
    body(-3.4, -1.0), tilt(-0.06), hips(-0.12, -0.9), spine(-0.12, -0.1, 0.06, 0.16),
    arms(-0.2, 1.0, -0.15, 0.95), hands(0.1, 0.1),
    legs(-0.2, 0.5, 0.24, 0.35, -0.08, 0.12), head2(0.24, 0.3),
  ), 'easeOut'),
  kf(26, STAND),
]);

clip('launched', 40, true, [
  // arched over backwards, limbs trailing behind the torso
  kf(0, merge(
    body(-1.5, 0), tilt(-0.42), hips(-0.3, -1.0), spine(-0.35, -0.3, 0.2, 0.45),
    arms(-1.5, 0.9, -1.35, 0.85), hands(0.3, 0.3),
    legs(0.9, 0.35, 0.55, 0.7, 0.3, 0.2), head2(-0.9, -0.8),
  )),
  kf(20, merge(
    body(-2.2, 0), tilt(-0.62), hips(-0.24, -1.4), spine(-0.28, -0.24, 0.16, 0.38),
    arms(-1.75, 0.7, -1.6, 0.65), hands(0.35, 0.35),
    legs(1.15, 0.5, 0.75, 0.95, 0.35, 0.25), head2(0.85, 0.95),
  )),
]);

clip('knockdown', 24, false, [
  kf(0, merge(
    body(-2.0, 0), tilt(-0.5), hips(-0.28, -1.2), spine(-0.32, -0.28, 0.18, 0.42),
    arms(-1.6, 0.8, -1.45, 0.75), hands(0.3, 0.3),
    legs(1.0, 0.4, 0.6, 0.8, 0.32, 0.22), head2(-0.9, -0.85),
  ), 'snap'),
  // the back hits the floor
  kf(7, merge(
    body(1.0, 2.6), tilt(-1.36), hips(-0.1, -0.6), spine(-0.12, -0.1, 0.08, 0.2),
    arms(-1.9, 0.5, -1.7, 0.45), hands(0.2, 0.2),
    legs(1.3, 0.9, 0.95, 1.2, 0.4, 0.3), head2(0.9, 1.0),
  ), 'easeIn'),
  // bounce, then settle flat and limp
  kf(12, merge(
    body(2.2, 3.4), tilt(-1.52), hips(0.04, 0), spine(0.05, 0.04, -0.02, -0.06),
    arms(-2.1, 0.3, -1.9, 0.28), hands(0.1, 0.1),
    legs(0.95, 1.1, 1.15, 0.85, 0.25, 0.2), head2(0.4, 0.5),
  ), 'easeOut'),
  kf(24, merge(
    body(2.6, 3.0), tilt(-1.56), hips(0.02, 0), spine(0.02, 0.02, -0.01, -0.02),
    arms(-2.2, 0.25, -2.0, 0.22), hands(0.05, 0.05),
    legs(0.7, 0.85, 0.9, 0.6, 0.15, 0.12), head2(0.2, 0.28),
  ), 'easeOut'),
]);

clip('getup', 30, false, [
  kf(0, merge(
    body(2.6, 3.0), tilt(-1.56), hips(0.02, 0), spine(0, 0, 0, 0),
    arms(-2.2, 0.25, -2.0, 0.22), hands(0, 0),
    legs(0.7, 0.85, 0.9, 0.6, 0.15, 0.12), head2(0.2, 0.28),
  ), 'snap'),
  // roll up onto an elbow
  kf(8, merge(
    body(2.0, 3.2), tilt(-1.15), hips(0.2, -0.4), spine(0.24, 0.16, -0.06, -0.14),
    arms(-1.5, 1.5, -1.6, 1.4), hands(-0.2, -0.2),
    legs(0.9, 1.5, 1.1, 1.3, 0.35, 0.3), head2(0.5, 0.6),
  ), 'easeOut'),
  // knee under, hands push off the floor
  kf(16, merge(
    body(-0.6, -0.4), tilt(-0.35), hips(0.4, -0.6), spine(0.5, 0.26, -0.12, -0.24),
    arms(-1.0, 0.9, -1.1, 0.8), hands(-0.3, -0.3),
    legs(0.7, 1.75, 0.4, 1.55, 0.5, 0.45), head2(0.7, 0.78),
  ), 'easeInOut'),
  // shove upright with a defiant shoulder roll
  kf(23, merge(
    body(0.2, -1.6), tilt(-0.06), hips(0.18, 0.3), spine(0.22, 0.1, -0.04, -0.1),
    arms(-0.3, 0.9, 0.1, 0.95), hands(0, 0),
    legs(0.35, 0.85, 0.28, 0.7, 0.25, 0.2), head2(-0.3, -0.24),
  ), 'easeOut'),
  kf(30, STAND),
]);

clip('stunned', 60, true, [
  // knees soft, head lolling, arms hanging dead
  kf(0, merge(
    body(-1.2, -1.8), tilt(-0.05), hips(0.12, -0.8), spine(0.1, -0.12, 0.16, 0.5),
    arms(-0.35, 0.55, 0.4, 0.5), hands(0.3, -0.3),
    legs(0.2, 0.55, -0.15, 0.5, 0.1, 0.05), head2(-0.5, 0.45),
  )),
  kf(15, merge(
    body(0.4, -2.4), tilt(0.06), hips(-0.1, 0.5), spine(-0.08, 0.14, -0.2, -0.35),
    arms(0.45, 0.5, -0.3, 0.55), hands(-0.3, 0.3),
    legs(-0.18, 0.6, 0.22, 0.55, -0.05, 0.12), head2(0.55, -0.4),
  )),
  kf(30, merge(
    body(1.2, -1.6), tilt(0.04), hips(-0.14, 0.9), spine(-0.12, 0.1, -0.14, -0.5),
    arms(0.3, 0.45, -0.4, 0.5), hands(-0.25, 0.25),
    legs(-0.22, 0.5, 0.18, 0.6, -0.1, 0.06), head2(0.45, -0.5),
  )),
  kf(45, merge(
    body(-0.5, -2.6), tilt(-0.06), hips(0.08, -0.4), spine(0.06, -0.1, 0.18, 0.4),
    arms(-0.4, 0.55, 0.35, 0.45), hands(0.25, -0.25),
    legs(0.16, 0.6, -0.2, 0.5, 0.08, -0.05), head2(-0.4, 0.5),
  )),
]);

clip('dead', 40, false, [
  kf(0, merge(
    body(-1.0, 0), tilt(-0.35), hips(-0.2, -0.8), spine(-0.24, -0.2, 0.14, 0.3),
    arms(-1.4, 0.7, -1.3, 0.65), hands(0.2, 0.2),
    legs(0.8, 0.35, 0.5, 0.7, 0.28, 0.2), head2(-0.7, -0.65),
  ), 'snap'),
  kf(10, merge(
    body(1.6, 2.8), tilt(-1.45), hips(0, 0), spine(0, 0, 0.04, 0.1),
    arms(-2.0, 0.4, -1.8, 0.35), hands(0.1, 0.1),
    legs(1.1, 0.7, 0.85, 0.95, 0.3, 0.25), head2(0.8, 0.9),
  ), 'easeIn'),
  // one last twitch, then nothing
  kf(18, merge(
    body(2.4, 3.2), tilt(-1.58), hips(0, 0), spine(0, 0, 0, 0),
    arms(-2.3, 0.2, -2.05, 0.18), hands(0, 0),
    legs(0.55, 0.7, 0.75, 0.5, 0.1, 0.08), head2(0.3, 0.4),
  ), 'easeOut'),
  kf(26, merge(
    body(2.5, 3.1), tilt(-1.58), hips(0, 0), spine(0, 0, 0, 0),
    arms(-2.35, 0.15, -2.1, 0.14), hands(0, 0),
    legs(0.62, 0.6, 0.68, 0.55, 0.06, 0.05), head2(0.34, 0.44),
  )),
  kf(40, merge(
    body(2.5, 3.1), tilt(-1.58), hips(0, 0), spine(0, 0, 0, 0),
    arms(-2.32, 0.12, -2.08, 0.12), hands(0, 0),
    legs(0.58, 0.62, 0.7, 0.52, 0.04, 0.04), head2(0.36, 0.46),
  )),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Grappling & business
// ─────────────────────────────────────────────────────────────────────────────

clip('grab', 16, false, [
  kf(0, STAND, 'snap'),
  kf(3, merge(
    body(-0.8, -0.8), hips(0.08, -0.6), spine(0.1, 0.06, 0, 0.02),
    arms(0.3, 1.2, 0.35, 1.15), hands(-0.3, -0.3),
    legs(-0.1, 0.35, 0.15, 0.4, -0.05, 0.05), head2(0.1, 0.14),
  ), 'easeIn'),
  // both hands stab forward, fingers spread
  kf(7, merge(
    body(2.4, -0.4), hips(0.16, 1.4), spine(0.22, 0.16, -0.04, -0.08),
    arms(1.42, 0.15, 1.5, 0.1), hands(0.45, 0.45),
    legs(-0.45, 0.25, 0.42, 0.3, -0.2, 0.18), head2(-0.28, -0.22),
  ), 'easeOut'),
  // clamp shut and haul the victim in
  kf(11, merge(
    body(1.4, -0.6), hips(0.12, 0.9), spine(0.16, 0.12, -0.02, -0.04),
    arms(1.2, 0.45, 1.28, 0.4), hands(-0.15, -0.15),
    legs(-0.35, 0.3, 0.35, 0.35, -0.15, 0.14), head2(-0.18, -0.14),
  ), 'easeOut'),
  kf(16, merge(
    body(1.2, -0.5), hips(0.1, 0.8), spine(0.14, 0.1, -0.02, -0.04),
    arms(1.15, 0.5, 1.22, 0.45), hands(-0.15, -0.15),
    legs(-0.32, 0.3, 0.32, 0.34, -0.14, 0.12), head2(-0.14, -0.1),
  )),
]);

clip('throw', 30, false, [
  kf(0, merge(
    body(1.2, -0.5), hips(0.1, 0.8), spine(0.14, 0.1, -0.02, -0.04),
    arms(1.15, 0.5, 1.22, 0.45), hands(-0.15, -0.15),
    legs(-0.32, 0.3, 0.32, 0.34, -0.14, 0.12), head2(-0.14, -0.1),
  ), 'snap'),
  // heave the poor bastard up over the head
  kf(9, merge(
    body(-1.0, 1.6), tilt(-0.14), hips(-0.24, -1.2), spine(-0.3, -0.24, 0.14, 0.3),
    arms(2.5, 0.35, 2.6, 0.3), hands(-0.1, -0.1),
    legs(0.15, 0.3, -0.2, 0.4, 0.1, -0.08), head2(-0.7, -0.6),
  ), 'easeOut'),
  kf(13, merge(
    body(-1.4, 1.4), tilt(-0.18), hips(-0.28, -1.5), spine(-0.34, -0.28, 0.16, 0.34),
    arms(2.7, 0.3, 2.8, 0.25), hands(-0.1, -0.1),
    legs(0.18, 0.3, -0.22, 0.42, 0.12, -0.1), head2(-0.8, -0.7),
  ), 'easeInOut'),
  // slam down and forward
  kf(18, merge(
    body(3.6, -1.7), tilt(0.14), hips(0.1, 2.2), spine(0.52, 0.4, -0.16, -0.2),
    arms(0.9, 0.2, 0.95, 0.15), hands(0.3, 0.3),
    legs(-0.5, 0.9, 0.55, 1.0, -0.1, 0.2), head2(-0.4, -0.2),
  ), 'easeIn'),
  kf(23, merge(
    body(2.6, -2.1), tilt(0.1), hips(0.08, 1.6), spine(0.48, 0.36, -0.14, -0.1),
    arms(0.5, 0.4, 0.55, 0.35), hands(0.2, 0.2),
    legs(-0.35, 1.05, 0.45, 1.15, -0.05, 0.25), head2(0.5, 0.6),
  ), 'easeOut'),
  kf(30, STAND),
]);

clip('pickup', 22, false, [
  kf(0, STAND, 'snap'),
  // fold down, near hand to the floor
  kf(8, merge(
    body(1.4, -5.8), hips(0.5, 0.4), spine(0.6, 0.3, -0.12, -0.3),
    arms(-0.4, 0.5, 1.3, 0.35), hands(-0.2, 0.3),
    legs(0.45, 1.5, 0.35, 1.4, 0.35, 0.4), head2(0.75, 0.85),
  ), 'easeIn'),
  kf(12, merge(
    body(1.5, -6.0), hips(0.52, 0.5), spine(0.62, 0.32, -0.12, -0.3),
    arms(-0.35, 0.55, 1.15, 0.55), hands(-0.2, -0.2),
    legs(0.46, 1.55, 0.36, 1.45, 0.36, 0.4), head2(0.78, 0.88),
  ), 'easeOut'),
  // straighten up, weapon hoisted to the shoulder
  kf(18, merge(
    body(-0.4, -1.0), hips(0.14, -0.4), spine(0.16, 0.08, -0.04, -0.08),
    arms(-0.15, 0.4, 0.35, 1.35), hands(0, -0.25),
    legs(0.15, 0.5, 0.12, 0.45, 0.12, 0.14), head2(0.2, 0.26),
  ), 'easeOut'),
  kf(22, STAND),
]);

clip('taunt', 60, false, [
  kf(0, STAND, 'snap'),
  // hip cocked, head back, near hand flicked out — "come on then"
  kf(10, merge(
    body(-1.2, -0.6), hips(-0.12, -1.4), spine(-0.14, -0.1, 0.08, 0.22),
    arms(-0.35, 0.6, 0.85, 1.5), hands(0.1, 0.4),
    legs(0.15, 0.3, -0.2, 0.4, 0.08, -0.06), head2(-0.4, -0.34),
  ), 'easeOut'),
  kf(18, merge(
    body(-0.6, -0.4), hips(-0.1, -1.0), spine(-0.12, -0.08, 0.06, 0.18),
    arms(-0.3, 0.6, 1.35, 0.35), hands(0.1, 0.55),
    legs(0.12, 0.3, -0.16, 0.38, 0.06, -0.05), head2(-0.32, -0.28),
  ), 'easeIn'),
  kf(26, merge(
    body(-1.2, -0.6), hips(-0.12, -1.4), spine(-0.14, -0.1, 0.08, 0.22),
    arms(-0.35, 0.6, 0.8, 1.55), hands(0.1, 0.4),
    legs(0.15, 0.3, -0.2, 0.4, 0.08, -0.06), head2(-0.4, -0.34),
  ), 'easeOut'),
  kf(34, merge(
    body(-0.6, -0.4), hips(-0.1, -1.0), spine(-0.12, -0.08, 0.06, 0.18),
    arms(-0.3, 0.6, 1.35, 0.35), hands(0.1, 0.55),
    legs(0.12, 0.3, -0.16, 0.38, 0.06, -0.05), head2(-0.32, -0.28),
  ), 'easeIn'),
  // shrug: both palms up, eyebrows somewhere in the next postcode
  kf(44, merge(
    body(0, -0.2), hips(-0.04, -0.2), spine(-0.06, -0.06, 0.04, 0.14),
    arms(0.55, 1.25, 0.6, 1.3), hands(0.5, 0.5),
    legs(0.05, 0.2, -0.05, 0.22, 0.04, -0.02), head2(-0.24, -0.2),
  ), 'easeOut'),
  kf(60, STAND),
]);

clip('victory', 80, true, [
  // chest out, fist up, weight rocking
  kf(0, merge(
    body(0, 0.4), hips(-0.06, 0.3), spine(-0.08, -0.1, 0.04, 0.1),
    arms(-0.3, 0.5, 2.35, 0.35), hands(0, 0.15),
    legs(-0.08, 0.1, 0.1, 0.14, 0, 0.04), head2(-0.3, -0.26),
  )),
  kf(14, merge(
    body(0, 2.2), hips(-0.1, 0.5), spine(-0.14, -0.16, 0.06, 0.16),
    arms(-0.45, 0.4, 2.75, 0.15), hands(0, 0.2),
    legs(-0.14, 0.06, 0.16, 0.1, -0.1, -0.06), head2(-0.5, -0.44),
  ), 'easeOut'),
  kf(26, merge(
    body(0, -0.6), hips(0.04, 0.1), spine(0.04, 0.02, 0, 0.02),
    arms(-0.25, 0.55, 2.2, 0.45), hands(0, 0.1),
    legs(0.06, 0.3, -0.04, 0.28, 0.1, 0.1), head2(0.2, 0.26),
  ), 'easeIn'),
  // cap tip, then both fists planted on the hips
  kf(42, merge(
    body(0, 0.2), hips(-0.05, -0.2), spine(-0.06, -0.06, 0.04, 0.12),
    arms(-0.2, 0.6, 1.9, 1.35), hands(0, -0.3),
    legs(-0.06, 0.16, 0.08, 0.18, 0, 0.05), head2(0.35, -0.3),
  )),
  kf(58, merge(
    body(0, 0.6), hips(-0.08, 0), spine(-0.1, -0.12, 0.05, 0.14),
    arms(-0.95, 1.65, -0.9, 1.7), hands(-0.35, -0.35),
    legs(-0.1, 0.14, 0.12, 0.16, 0, 0.04), head2(-0.4, -0.36),
  ), 'easeOut'),
  kf(70, merge(
    body(0, 0), hips(-0.04, 0.2), spine(-0.05, -0.06, 0.03, 0.08),
    arms(-0.7, 1.5, 0.6, 1.5), hands(-0.2, -0.2),
    legs(-0.06, 0.14, 0.08, 0.16, 0, 0.04), head2(-0.2, -0.18),
  )),
]);

clip('ride', 40, true, [
  // crouched over the bars, legs tucked up on the pegs
  kf(0, merge(
    body(1.6, -2.6), hips(0.3, 1.2), spine(0.38, 0.2, -0.1, -0.14),
    arms(1.35, 0.3, 1.4, 0.28), hands(-0.15, -0.15),
    legs(0.95, 1.25, 0.8, 1.35, 0.3, 0.35), head2(-0.3, -0.5),
  )),
  kf(9, merge(
    body(1.7, -2.2), hips(0.32, 1.3), spine(0.4, 0.21, -0.11, -0.12),
    arms(1.38, 0.28, 1.43, 0.26), hands(-0.16, -0.16),
    legs(0.98, 1.28, 0.82, 1.38, 0.32, 0.36), head2(-0.24, -0.42),
  ), 'linear'),
  kf(20, merge(
    body(1.5, -2.9), hips(0.29, 1.15), spine(0.37, 0.19, -0.1, -0.15),
    arms(1.33, 0.32, 1.38, 0.3), hands(-0.14, -0.14),
    legs(0.93, 1.23, 0.78, 1.33, 0.29, 0.34), head2(-0.34, -0.56),
  ), 'linear'),
  kf(30, merge(
    body(1.65, -2.3), hips(0.31, 1.25), spine(0.39, 0.2, -0.1, -0.13),
    arms(1.36, 0.29, 1.41, 0.27), hands(-0.15, -0.15),
    legs(0.96, 1.26, 0.81, 1.36, 0.31, 0.35), head2(-0.28, -0.46),
  ), 'linear'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// The transformation. Classic film dwarf walks in, bad boy walks out.
// ─────────────────────────────────────────────────────────────────────────────

/** Feet together, hands clasped, chin up. Insufferably wholesome. */
clip('dress_start', 72, true, [
  kf(0, merge(
    body(0, 0), hips(-0.04, 0), spine(-0.05, -0.06, 0.03, 0.12),
    arms(0.35, 1.5, 0.32, 1.52), hands(-0.2, -0.2),
    legs(0.04, 0.06, -0.04, 0.06, 0.05, 0.05), head2(-0.16, 0.06),
  )),
  kf(18, merge(
    body(0, 1.1), hips(-0.06, 0.2), spine(-0.07, -0.09, 0.04, 0.16),
    arms(0.4, 1.56, 0.36, 1.58), hands(-0.22, -0.22),
    legs(0.02, 0.04, -0.02, 0.04, 0.02, 0.02), head2(-0.22, -0.05),
  ), 'easeOut'),
  // a small pleased heel-rock
  kf(36, merge(
    body(0, 0.1), hips(-0.02, -0.3), spine(-0.03, -0.04, 0.02, 0.08),
    arms(0.3, 1.46, 0.28, 1.48), hands(-0.18, -0.18),
    legs(0.06, 0.09, -0.06, 0.09, 0.12, 0.12), head2(-0.1, 0.14),
  ), 'easeInOut'),
  kf(54, merge(
    body(0, 0.9), hips(-0.05, 0.1), spine(-0.06, -0.08, 0.03, 0.14),
    arms(0.38, 1.53, 0.34, 1.55), hands(-0.2, -0.2),
    legs(0.03, 0.05, -0.03, 0.05, 0.04, 0.04), head2(-0.2, -0.02),
  ), 'easeOut'),
]);

/** Shrugs on the jacket: reach back, punch through the sleeves, roll it on. */
clip('dress_jacket', 56, false, [
  kf(0, merge(
    body(0, 0), hips(-0.04, 0), spine(-0.05, -0.06, 0.03, 0.12),
    arms(0.35, 1.5, 0.32, 1.52), hands(-0.2, -0.2),
    legs(0.04, 0.06, -0.04, 0.06, 0.05, 0.05), head2(-0.16, 0.06),
  ), 'snap'),
  // both arms swing back and up to catch the collar
  kf(10, merge(
    body(-0.8, -1.2), hips(0.14, -0.8), spine(0.18, 0.1, -0.06, -0.14),
    arms(-1.2, 1.9, -1.3, 1.95), hands(-0.35, -0.35),
    legs(0.2, 0.5, 0.1, 0.45, 0.15, 0.15), head2(0.3, 0.35),
  ), 'easeIn'),
  // hurl it over the shoulders
  kf(18, merge(
    body(-0.4, 1.4), tilt(-0.08), hips(-0.14, -0.4), spine(-0.2, -0.16, 0.1, 0.24),
    arms(2.9, 1.35, 3.0, 1.3), hands(-0.2, -0.2),
    legs(0.05, 0.15, -0.05, 0.18, -0.1, -0.1), head2(-0.55, -0.5),
  ), 'easeOut'),
  // drive both fists down the sleeves
  kf(27, merge(
    body(1.6, -0.8), hips(0.12, 0.9), spine(0.16, 0.14, -0.04, -0.06),
    arms(1.45, 0.08, 1.5, 0.05), hands(0.15, 0.15),
    legs(-0.2, 0.3, 0.22, 0.32, -0.1, 0.12), head2(-0.2, -0.16),
  ), 'easeIn'),
  // shoulder roll to settle the leather, one at a time
  kf(36, merge(
    body(-0.6, 0.6), hips(-0.08, -0.6), spine(-0.1, -0.14, 0.06, 0.16),
    arms(-0.5, 0.9, 0.15, 0.7), hands(-0.1, 0), legs(0.06, 0.12, -0.06, 0.14, 0.04, 0.04), head2(-0.35, -0.3),
  ), 'easeOut'),
  kf(45, merge(
    body(0.4, 0.4), hips(0.06, 0.5), spine(0.08, 0.1, -0.03, -0.08),
    arms(0.2, 0.75, -0.55, 0.95), hands(0, -0.1),
    legs(-0.06, 0.14, 0.06, 0.12, 0.04, 0.04), head2(0.2, 0.26),
  ), 'easeInOut'),
  // collar popped, weight settled back. He knows.
  kf(56, merge(
    body(0, 0), hips(-0.06, -0.4), spine(-0.08, -0.1, 0.05, 0.1),
    arms(-0.25, 0.7, 0.2, 0.75), hands(0, 0),
    legs(-0.04, 0.16, 0.06, 0.2, 0, 0.04), head2(-0.22, -0.18),
  ), 'easeOut'),
]);

/** The shades come out of the jacket and slide down onto the nose. */
clip('dress_shades', 44, false, [
  kf(0, merge(
    body(0, 0), hips(-0.06, -0.4), spine(-0.08, -0.1, 0.05, 0.1),
    arms(-0.25, 0.7, 0.2, 0.75), hands(0, 0),
    legs(-0.04, 0.16, 0.06, 0.2, 0, 0.04), head2(-0.22, -0.18),
  ), 'snap'),
  // fish them out of the inside pocket
  kf(9, merge(
    body(-0.4, -0.4), hips(0.04, -0.6), spine(0.06, 0.04, 0.02, 0.06),
    arms(-0.2, 0.65, 0.75, 1.75), hands(0, -0.3),
    legs(-0.02, 0.2, 0.04, 0.22, 0, 0.05), head2(-0.15, -0.12),
  ), 'easeInOut'),
  // hand rises above the brow, shades dangling
  kf(18, merge(
    body(-0.2, 0.3), hips(-0.04, -0.3), spine(-0.06, -0.08, 0.04, 0.08),
    arms(-0.18, 0.6, 2.55, 1.5), hands(0, -0.15),
    legs(-0.02, 0.16, 0.04, 0.18, 0, 0.04), head2(-0.3, -0.24),
  ), 'easeOut'),
  // draw them down the face, dead slow
  kf(30, merge(
    body(0, 0.2), hips(-0.05, -0.2), spine(-0.07, -0.09, 0.04, 0.02),
    arms(-0.15, 0.6, 2.25, 1.9), hands(0, -0.2),
    legs(-0.02, 0.16, 0.04, 0.18, 0, 0.04), head2(-0.26, -0.2),
  ), 'easeInOut'),
  // flick the hand away, chin drops, eyes come up
  kf(38, merge(
    body(0.6, 0), hips(-0.02, 0.2), spine(-0.03, -0.02, 0.04, -0.06),
    arms(-0.1, 0.6, 1.1, 0.5), hands(0, 0.25),
    legs(-0.04, 0.18, 0.06, 0.2, 0, 0.05), head2(0.1, 0.14),
  ), 'easeOut'),
  kf(44, merge(
    body(0.2, 0), hips(-0.04, 0), spine(-0.05, -0.06, 0.04, -0.02),
    arms(-0.2, 0.65, 0.3, 0.7), hands(0, 0),
    legs(-0.04, 0.18, 0.06, 0.2, 0, 0.04), head2(-0.08, -0.04),
  ), 'easeOut'),
]);

/** The pose. Chin down, shoulder forward, fist on the hip, entirely unearned. */
clip('dress_pose', 96, true, [
  kf(0, merge(
    body(0.6, 0), hips(0.06, 0.6), spine(0.08, -0.04, 0.06, -0.14),
    arms(-0.9, 1.7, 0.55, 1.15), hands(-0.35, 0.1),
    legs(-0.14, 0.22, 0.16, 0.3, -0.06, 0.08), head2(0.16, 0.1),
  )),
  // slow swagger bounce, shoulders rolling
  kf(24, merge(
    body(0.9, 0.9), hips(0.04, 0.9), spine(0.06, -0.08, 0.07, -0.18),
    arms(-1.0, 1.75, 0.65, 1.05), hands(-0.38, 0.14),
    legs(-0.16, 0.18, 0.18, 0.26, -0.08, 0.06), head2(0.1, 0.02),
  ), 'easeInOut'),
  // a single, devastating nod
  kf(46, merge(
    body(0.5, -0.4), hips(0.1, 0.4), spine(0.13, 0.02, 0.03, -0.02),
    arms(-0.82, 1.62, 0.45, 1.25), hands(-0.32, 0.06),
    legs(-0.12, 0.26, 0.14, 0.34, -0.04, 0.1), head2(0.34, 0.3),
  ), 'easeIn'),
  kf(62, merge(
    body(0.7, 0.5), hips(0.05, 0.7), spine(0.07, -0.06, 0.07, -0.2),
    arms(-0.95, 1.72, 0.6, 1.1), hands(-0.36, 0.12),
    legs(-0.15, 0.2, 0.17, 0.28, -0.07, 0.07), head2(0.06, -0.04),
  ), 'easeOut'),
  kf(80, merge(
    body(0.6, 0.2), hips(0.06, 0.55), spine(0.08, -0.05, 0.06, -0.16),
    arms(-0.88, 1.68, 0.5, 1.12), hands(-0.34, 0.1),
    legs(-0.14, 0.22, 0.16, 0.3, -0.06, 0.08), head2(0.14, 0.06),
  ), 'easeInOut'),
]);
