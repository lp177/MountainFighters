/**
 * The fatality director — the thing that stops the fight and tells the joke.
 *
 * A finisher is a short film with a fixed frame count. While one is running the
 * world is expected to be FROZEN by whoever owns it: the caller checks
 * `active`, skips its own sim step and its own draw of the two performers (see
 * `isStaged`), and hands the frame to this class instead. Everything you see
 * during those two or three seconds is drawn here, from the same vector
 * primitives and the same `drawCharacter` the fight uses — there is no second
 * set of art anywhere in this file.
 *
 * ── HOW A VISUAL IS BUILT ───────────────────────────────────────────────────
 *
 * Every `FatalityDef.visual` resolves to one entry in `VISUALS`:
 *
 *     draw(s)   — the whole picture for this frame, in world space
 *     tick(s)   — the beats: particles, shake, extra cues. Runs at sim rate.
 *     banner    — when the title card slams in, as a fraction of the duration
 *
 * `Stage` carries the timing (`t` is 0..1 through the performance), where the
 * two performers stand, and the gore multiplier. It is a single object reused
 * for the life of the director, and the poses are drawn from a fixed pool, so
 * the draw path allocates nothing.
 *
 * ── THE THREE SETTINGS THIS FILE OWES A DEBT TO ─────────────────────────────
 *
 * `gore: 'off'` never reaches here at all — `pickFatality` returns null, so
 * there is nothing to start. It is still honoured defensively (`start` refuses,
 * and `s.gore` is 0), because a caller that stages a finisher by hand must not
 * be able to smuggle blood past the setting. `'max'` multiplies every emission
 * and adds a second lens splatter. `reducedMotion` removes the camera slam's
 * overshoot, the banner shudder and the lens jitter — the performance still
 * plays, it just stops moving the furniture.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * This class NEVER consumes the shared RNG. It reads `getState()` to season a
 * per-performance seed and nothing else. That is deliberate: gore is a local
 * preference, two peers in a lockstep match may legitimately disagree about it,
 * and a director that drew from the shared stream would turn that disagreement
 * into a desync.
 */

import type {
  AudioBus,
  BoneName,
  Facing,
  FatalityDef,
  ParticleSpec,
  Pose,
  RigStyle,
  Rng,
  Settings,
  SfxCue,
} from '@/core/types';
import type { Fx } from '@/juice/Fx';
import type { Camera } from '@/render/Camera';
import type { Fighter } from '@/game/Fighter';
import { clamp, easeIn, easeInOut, easeOut, easeOutBack, lerp, TAU } from '@/core/math';
import {
  GROUND_Y,
  VIEW_H,
  VIEW_W,
  Z_DEPTH,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';
import { burst, capsule, ellipse, poly, roundRect, star, zigzag } from '@/render/Shapes';
import { drawCharacter, drawLooseHat } from '@/render/rig/CharacterRig';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// Palette & tuning
// ─────────────────────────────────────────────────────────────────────────────

const INK = '#141019';
const BLOOD = '#c0242b';
const BLOOD_DARK = '#7d1420';
const BLOOD_LIGHT = '#e8514f';
const BONE = '#efe4cf';
const BONE_SHADE = '#c3b39a';
const STEEL = '#9aa2ad';
const STEEL_DARK = '#4c525d';
const PAPER = '#f2ecdc';
const CARD = '#c89a5e';
const NEON = '#37e6c8';
const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif';

const BLOOD_COLORS = [BLOOD_LIGHT, BLOOD, BLOOD_DARK];
const DUST_COLORS = ['#cfc6b8', '#9a9086', '#6b6259'];
const SPARK_COLORS = ['#ffe08a', '#ffb03a', '#fff6d8'];
const CONFETTI_COLORS = ['#ffd166', '#ff5d8f', '#5ad2ff', '#8bf58b', '#ffffff'];

/** Camera zoom the slam settles at, and the softer one for reduced motion. */
const SLAM_ZOOM = 2.15;
const SLAM_ZOOM_CALM = 1.75;
/** Frames the camera takes to arrive, and to let go again at the end. */
const SLAM_IN = 11;
const SLAM_OUT = 20;
/** Letterbox bar height at full extension. */
const BAR_H = 31;
const BAR_IN = 9;
/** Default point in the performance where the title card lands. */
const BANNER_AT = 0.52;
/** Lens drops live this long and there are at most this many. */
const SPLAT_MAX = 18;
const SPLAT_LIFE = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Pose plumbing
//
// Same sign conventions as render/rig/Anim.ts — POSITIVE IS FORWARD, in the
// direction the character faces — so a pose written here reads the same way as
// a clip written there. The difference is only where the memory comes from:
// clips are authored once and cached, these are rebuilt every frame, so they
// come out of a fixed pool instead of an object literal.
// ─────────────────────────────────────────────────────────────────────────────

const BONES: readonly BoneName[] = [
  'root', 'pelvis', 'torso', 'chest', 'neck', 'head', 'hat', 'beard',
  'armL_upper', 'armL_lower', 'handL', 'armR_upper', 'armR_lower', 'handR',
  'legL_upper', 'legL_lower', 'footL', 'legR_upper', 'legR_lower', 'footR',
];

function makePose(): Pose {
  const p: Pose = {};
  for (const n of BONES) p[n] = { rot: 0, x: 0, y: 0, scale: 1 };
  return p;
}

/** Four is one more than any single frame of any finisher has ever needed. */
const POSE_POOL: Pose[] = [makePose(), makePose(), makePose(), makePose()];

/** Reset and hand out pooled pose `i`. */
function P(i: number): Pose {
  const p = POSE_POOL[i];
  for (const n of BONES) {
    const b = p[n]!;
    b.rot = 0;
    b.x = 0;
    b.y = 0;
    b.scale = 1;
  }
  return p;
}

function set(p: Pose, n: BoneName, rot: number, x = 0, y = 0, scale = 1): void {
  const b = p[n]!;
  b.rot = rot;
  b.x = x;
  b.y = y;
  b.scale = scale;
}

/** Whole-rig translation in rig units. +y is UP. */
function body(p: Pose, x: number, y: number): void {
  const b = p.root!;
  b.x = x;
  b.y = y;
}

/** Tips the whole rig about the feet. Positive falls forward, onto the face. */
function tilt(p: Pose, rot: number): void {
  p.root!.rot = -rot;
}

function hips(p: Pose, rot: number, x = 0, y = 0): void {
  set(p, 'pelvis', -rot, x, y);
}

function spine(p: Pose, t: number, c = 0, n = 0, h = 0): void {
  p.torso!.rot = -t;
  p.chest!.rot = -c;
  p.neck!.rot = -n;
  p.head!.rot = -h;
}

function arms(p: Pose, lu: number, ll: number, ru: number, rl: number): void {
  p.armL_upper!.rot = lu;
  p.armL_lower!.rot = ll;
  p.armR_upper!.rot = ru;
  p.armR_lower!.rot = rl;
}

function hands(p: Pose, l: number, r: number): void {
  p.handL!.rot = l;
  p.handR!.rot = r;
}

/** Thigh and knee per leg, ankles relative to a flat sole. */
function legs(
  p: Pose,
  lu: number, ll: number, ru: number, rl: number,
  lf = 0, rf = 0,
): void {
  p.legL_upper!.rot = lu;
  p.legL_lower!.rot = -ll;
  p.footL!.rot = ll - lu + lf;
  p.legR_upper!.rot = ru;
  p.legR_lower!.rot = -rl;
  p.footR!.rot = rl - ru + rf;
}

/** Cap flop and beard swing, positive forward. */
function head2(p: Pose, hat: number, beard: number): void {
  p.hat!.rot = -hat;
  p.beard!.rot = beard;
}

/**
 * Send the rig's own hat somewhere the frame is not.
 *
 * The hat is part of the body in `CharacterRig` — there is no "no hat" flag to
 * pass — so a finisher that takes the hat off a dwarf moves the bone a few
 * hundred rig units into the sky and draws the loose one itself. Cheap, exact,
 * and it needs no cooperation from the rig.
 */
function hatGone(p: Pose): void {
  const b = p.hat!;
  b.y = 900;
  b.scale = 0.01;
}

// ── Stock poses ──────────────────────────────────────────────────────────────

function poseStand(i: number, breathe = 0): Pose {
  const p = P(i);
  spine(p, 0.01, 0.02, 0, 0.01);
  arms(p, -0.05, 0.16, 0.05, 0.14);
  legs(p, 0.03, 0.07, -0.03, 0.06);
  body(p, 0, breathe * 0.6);
  return p;
}

/** Doubled over, arms loose: the pose everything painful starts from. */
function poseSlump(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  spine(p, 0.5 * d, 0.35 * d, 0.2 * d, 0.45 * d);
  arms(p, -0.5 * d, 0.9 * d, -0.45 * d, 0.85 * d);
  legs(p, 0.1 * d, 0.5 * d, -0.05 * d, 0.45 * d);
  hips(p, 0.2 * d, 0, -1.6 * d);
  head2(p, 0.35 * d, 0.5 * d);
  return p;
}

/** Flat on the back, limp. The end state of most of the book. */
function poseSprawl(i: number, settle = 1): Pose {
  const p = P(i);
  const k = clamp(settle, 0, 1);
  body(p, 2.5 * k, 3.1 * k);
  tilt(p, -1.58 * k);
  arms(p, -2.32 * k, 0.12, -2.08 * k, 0.12);
  legs(p, 0.58 * k, 0.62 * k, 0.7 * k, 0.52 * k);
  head2(p, 0.36 * k, 0.46 * k);
  return p;
}

/** Face down instead — used when the joke is humiliation, not violence. */
function posePlank(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  tilt(p, 1.55 * d);
  body(p, -1.2 * d, 2.4 * d);
  arms(p, 0.1, 0.05, 0.1, 0.05);
  legs(p, 0, 0.04, 0, 0.04);
  head2(p, -0.2 * d, -0.3 * d);
  return p;
}

/** Hanging from something above: shoulders up, feet dangling. */
function poseDangle(i: number, sway: number): Pose {
  const p = P(i);
  spine(p, -0.1 + sway * 0.1, -0.08, 0.12, 0.3);
  arms(p, -0.35 + sway * 0.2, 0.4, -0.3 - sway * 0.2, 0.38);
  legs(p, 0.35 + sway * 0.25, 0.55, 0.15 - sway * 0.25, 0.7, 0.3, 0.25);
  hips(p, -0.05, 0, 0);
  head2(p, 0.2, 0.35);
  return p;
}

/** Both arms up, grasping at something out of reach. */
function poseReach(i: number, up: number): Pose {
  const p = P(i);
  const u = clamp(up, 0, 1);
  spine(p, -0.12 * u, -0.14 * u, -0.3 * u, -0.5 * u);
  arms(p, -1.9 * u - 0.1, 0.25, -2.0 * u - 0.1, 0.2);
  hands(p, -0.3 * u, -0.35 * u);
  legs(p, -0.1 * u, 0.18, 0.1 * u, 0.16);
  head2(p, -0.6 * u, -0.5 * u);
  return p;
}

/** On the knees, arms down. The last stop before the floor. */
function poseKneel(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  body(p, 0.2 * d, -6.5 * d);
  spine(p, 0.28 * d, 0.2 * d, 0.15 * d, 0.4 * d);
  arms(p, -0.15, 0.3, -0.1, 0.28);
  legs(p, 0.2 * d, 2.1 * d, -0.15 * d, 2.2 * d, 0.4 * d, 0.45 * d);
  hips(p, 0.15 * d);
  head2(p, 0.3 * d, 0.45 * d);
  return p;
}

/** Both hands forward, committed. Grabs, handshakes, chest cavities. */
function poseThrust(i: number, k: number, high = 0): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  spine(p, 0.3 * d, 0.2 * d, -0.05, -0.1);
  arms(p, 1.5 * d + high * 0.6, 0.25 - 0.2 * d, 1.6 * d + high * 0.6, 0.22 - 0.18 * d);
  hands(p, -0.25 * d, -0.28 * d);
  legs(p, -0.35 * d, 0.35, 0.5 * d, 0.6, 0.15, 0.2);
  hips(p, 0.1 * d, 0, -0.8 * d);
  head2(p, 0.15 * d, 0.2 * d);
  return p;
}

/** One arm straight up, holding the punchline where the camera can see it. */
function posePresent(i: number, wobble: number): Pose {
  const p = P(i);
  spine(p, -0.16, -0.12, -0.1, -0.2);
  arms(p, -0.3, 0.5, -2.4 + wobble * 0.06, 0.1);
  hands(p, 0, -0.2);
  legs(p, -0.18, 0.12, 0.22, 0.16);
  head2(p, -0.35, -0.25);
  return p;
}

/** Overhead swing, `k` from wind-up (0) to follow-through (1). */
function poseSwing(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  const back = 1 - d;
  spine(p, -0.5 * back + 0.7 * d, -0.3 * back + 0.4 * d, 0.1, 0.2 * d);
  arms(p, -2.5 * back + 1.3 * d, 0.3, -2.6 * back + 1.4 * d, 0.25);
  hands(p, 0.1, 0.1);
  legs(p, -0.4 + 0.5 * d, 0.3, 0.5 - 0.4 * d, 0.5, 0.1, 0.15);
  hips(p, -0.2 * back + 0.3 * d, 0, -1.2 * d);
  head2(p, -0.5 * back + 0.4 * d, -0.3 * back + 0.5 * d);
  return p;
}

/** Leg out, hips through it. The kick that clears the atmosphere. */
function poseKick(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  spine(p, -0.5 * d, -0.3 * d, 0.1, 0.15);
  arms(p, -1.2 * d, 0.6, 0.9 * d, 0.5);
  legs(p, -0.2 * d, 0.2, 1.9 * d, 0.15, 0, -0.5 * d);
  hips(p, -0.25 * d, 0, -1.5 * d);
  head2(p, -0.4 * d, -0.35 * d);
  return p;
}

/** Arms folded, weight on one hip. Nothing to add. */
function poseSmug(i: number, bob: number): Pose {
  const p = P(i);
  spine(p, -0.05, -0.06, 0.02, 0.04);
  arms(p, 0.9, 1.5, 0.85, 1.55);
  hands(p, -0.2, -0.2);
  legs(p, 0.06, 0.1, -0.08, 0.12);
  body(p, 0, bob * 0.5);
  head2(p, -0.08, -0.06);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

interface Stage {
  ctx: C2D;
  fx: Fx;
  audio: AudioBus;
  d: FatalityDirector;
  def: FatalityDef;
  killer: Fighter;
  victim: Fighter;
  /** Frames elapsed, and the same thing normalised to 0..1. */
  f: number;
  t: number;
  dur: number;
  /** +1 when the victim stands to the killer's right. */
  dir: Facing;
  /** Killer: world x, screen y of the feet, depth, height in px, draw scale. */
  kx: number;
  ky: number;
  kz: number;
  kh: number;
  ks: number;
  /** Victim, the same four. */
  vx: number;
  vy: number;
  vz: number;
  vh: number;
  vs: number;
  /** Screen y of the ground under the victim, and the midpoint of the pair. */
  gy: number;
  mx: number;
  /** 0 when gore is off, 1 on, 1.8 at max. Multiplies every emission. */
  gore: number;
  reduced: boolean;
  seed: number;
}

interface Visual {
  draw(s: Stage): void;
  tick?(s: Stage): void;
  /** Where the title card lands, as a fraction of the duration. */
  banner?: number;
}

/** 0 before `a`, 1 after `b`, linear between. The spine of every renderer. */
function seg(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);
}

/** A 0→1→0 hump across [a, b]. Impacts, flashes, squashes. */
function pulse(t: number, a: number, b: number): number {
  const u = seg(t, a, b);
  return Math.sin(u * Math.PI);
}

/** Deterministic value noise so a wobble is the same wobble on every peer. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function jitter(seed: number, i: number): number {
  return hash(seed * 0.017 + i * 1.618) * 2 - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared drawing
// ─────────────────────────────────────────────────────────────────────────────

/** Perspective scale, matched to Fighter.render so a staged body is the same size. */
function depthScale(z: number): number {
  return clamp(1 - (Z_DEPTH - z) * Z_PERSPECTIVE, 0.75, 1);
}

/** Standing height of a skeleton in rig units, feet to crown. */
function rigHeight(f: Fighter): number {
  let h = 0;
  for (const b of f.skeleton) {
    if (b.name === 'pelvis') h += b.y + b.length * 0;
    if (b.name === 'torso' || b.name === 'chest' || b.name === 'neck' || b.name === 'head') {
      h += b.length;
    }
  }
  return h;
}

function actor(
  s: Stage,
  who: Fighter,
  x: number,
  y: number,
  pose: Pose,
  facing: Facing,
  scale: number,
  alpha = 1,
  flash = 0,
  tint?: string,
): void {
  drawCharacter(s.ctx, who.style, pose, who.skeleton, x, y, facing, {
    scale,
    alpha,
    flash,
    tint: tint ?? who.tint ?? undefined,
  });
}

/** The killer, offset from where they were standing when the fight stopped. */
function kill(s: Stage, dx: number, dy: number, pose: Pose, alpha = 1, flash = 0): void {
  actor(s, s.killer, s.kx + dx, s.ky + dy, pose, s.dir, s.ks, alpha, flash);
}

/** The victim, likewise. Faces the killer unless a renderer says otherwise. */
function vict(
  s: Stage,
  dx: number,
  dy: number,
  pose: Pose,
  alpha = 1,
  flash = 0,
  facing?: Facing,
): void {
  actor(
    s,
    s.victim,
    s.vx + dx,
    s.vy + dy,
    pose,
    facing ?? ((-s.dir) as Facing),
    s.vs,
    alpha,
    flash,
  );
}

/**
 * Run `fn` with the canvas squashed about (cx, cy).
 *
 * Used by everything that flattens, stretches or crushes a body: the transform
 * goes on the canvas rather than into the rig, so the rig stays the rig.
 */
function squash(s: Stage, cx: number, cy: number, sx: number, sy: number, fn: () => void): void {
  const ctx = s.ctx;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sx, sy);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/** Run `fn` clipped to a screen-space rectangle. */
function clipRect(s: Stage, x: number, y: number, w: number, h: number, fn: () => void): void {
  const ctx = s.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  fn();
  ctx.restore();
}

const TEXT_SCRATCH: number[] = [];

function label(
  s: Stage,
  str: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'center',
  weight = '900',
): void {
  const ctx = s.ctx;
  ctx.font = `${weight} ${size}px ${DISPLAY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(1.4, size * 0.24);
  ctx.strokeStyle = INK;
  ctx.strokeText(str, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
}

/** A comic sound word, popping in and drifting up. */
function shout(s: Stage, str: string, x: number, y: number, k: number, size: number, fill: string): void {
  if (k <= 0 || k >= 1) return;
  const pop = k < 0.25 ? easeOutBack(k / 0.25) : 1;
  const ctx = s.ctx;
  const a = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
  ctx.save();
  ctx.globalAlpha *= clamp(a, 0, 1);
  label(s, str, x, y - k * 9, size * pop, fill);
  ctx.restore();
}

/** Screen-space blood pool that grows and darkens. */
function bloodPool(s: Stage, x: number, y: number, w: number, k: number): void {
  if (s.gore <= 0 || k <= 0) return;
  const r = w * easeOut(clamp(k, 0, 1));
  ellipse(s.ctx, x, y, r, r * 0.24, 0, BLOOD_DARK, 'none');
  ellipse(s.ctx, x - r * 0.2, y - r * 0.03, r * 0.6, r * 0.14, 0, BLOOD, 'none');
}

/** A dry version for when the setting says no blood but the beat needs weight. */
function dustPool(s: Stage, x: number, y: number, w: number, k: number): void {
  const r = w * easeOut(clamp(k, 0, 1));
  ellipse(s.ctx, x, y, r, r * 0.2, 0, 'rgba(30,26,36,0.35)', 'none');
}

const SPEC: ParticleSpec = {
  count: 0,
  x: 0,
  y: 0,
  z: 0,
  angle: 0,
  spread: 0,
  speed: [0, 0],
  life: [0, 0],
  size: [0, 0],
  colors: BLOOD_COLORS,
  gravity: 0.3,
  drag: 0.98,
  shape: 'blood',
};

/**
 * Emit at a SCREEN point.
 *
 * Particles live in world space, the stage thinks in screen space, and the two
 * differ by the victim's depth — so every emission in this file goes through
 * here rather than doing the conversion four ways in forty places.
 */
function emit(
  s: Stage,
  sx: number,
  sy: number,
  count: number,
  angle: number,
  spread: number,
  speedLo: number,
  speedHi: number,
  colors: string[],
  shape: ParticleSpec['shape'],
  gravity = 0.32,
  size = 2.4,
  life = 40,
): void {
  const n = Math.round(count);
  if (n <= 0) return;
  SPEC.count = n;
  SPEC.x = sx;
  SPEC.y = s.gy - sy;
  SPEC.z = s.vz;
  SPEC.angle = angle;
  SPEC.spread = spread;
  SPEC.speed[0] = speedLo;
  SPEC.speed[1] = speedHi;
  SPEC.life[0] = life * 0.6;
  SPEC.life[1] = life;
  SPEC.size[0] = size * 0.6;
  SPEC.size[1] = size;
  SPEC.colors = colors;
  SPEC.gravity = gravity;
  SPEC.drag = 0.985;
  SPEC.shape = shape;
  SPEC.additive = shape === 'spark' || shape === 'star';
  SPEC.fade = 'ease';
  SPEC.spin = shape === 'shard' ? 0.24 : 0;
  s.fx.particles(SPEC);
}

/** The wet one. Silent when the player asked for no blood. */
function spray(
  s: Stage,
  sx: number,
  sy: number,
  count: number,
  angle: number,
  spread: number,
  speed = 3.4,
): void {
  if (s.gore <= 0) return;
  emit(s, sx, sy, count * s.gore, angle, spread, speed * 0.35, speed, BLOOD_COLORS, 'blood', 0.36, 2.8, 46);
}

function dust(s: Stage, sx: number, sy: number, count: number, speed = 1.8): void {
  emit(s, sx, sy, count, -Math.PI * 0.5, Math.PI, speed * 0.3, speed, DUST_COLORS, 'smoke', 0.02, 4.2, 44);
}

function sparks(s: Stage, sx: number, sy: number, count: number, angle: number): void {
  emit(s, sx, sy, count, angle, 1.1, 1.6, 4.2, SPARK_COLORS, 'spark', 0.24, 1.8, 24);
}

function confetti(s: Stage, sx: number, sy: number, count: number): void {
  emit(s, sx, sy, count, -Math.PI * 0.5, 2.6, 1.4, 4.6, CONFETTI_COLORS, 'shard', 0.14, 3.0, 70);
}

// ── Props ────────────────────────────────────────────────────────────────────

/** A spine: vertebrae down a curve, ribs at the top, hips at the bottom. */
function drawSpine(ctx: C2D, x: number, y: number, len: number, rot: number, wob: number): void {
  const n = 11;
  const w = Math.max(1.6, len * 0.055);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const bend = Math.sin(u * 3.1 + wob) * len * 0.05;
    const px = x + Math.sin(rot) * len * u * -1 + Math.cos(rot) * bend;
    const py = y + Math.cos(rot) * len * u + Math.sin(rot) * bend;
    const r = w * (1.25 - u * 0.45);
    ellipse(ctx, px, py, r, r * 0.72, rot, i & 1 ? BONE : BONE_SHADE, INK, 1);
    if (i < 4) {
      const rib = w * (3.4 - i * 0.6);
      capsule(ctx, px - rib, py + r * 0.4, px + rib, py + r * 0.4, w * 0.34, BONE, INK, 1);
    }
  }
}

/** A heart, mid-beat. `k` 0..1 is the squeeze. */
function drawHeart(ctx: C2D, x: number, y: number, r: number, k: number, bite: number): void {
  const w = r * (1 + k * 0.12);
  const h = r * (1 - k * 0.08);
  ellipse(ctx, x - w * 0.45, y - h * 0.25, w * 0.62, h * 0.66, -0.3, BLOOD_LIGHT, INK, 1.4);
  ellipse(ctx, x + w * 0.45, y - h * 0.25, w * 0.62, h * 0.66, 0.3, BLOOD, INK, 1.4);
  poly(
    ctx,
    [x - w, y - h * 0.1, x + w, y - h * 0.1, x, y + h * 1.25],
    BLOOD,
    INK,
    1.4,
  );
  // Aorta and pulmonary stubs, because a heart without plumbing reads as a
  // playing-card symbol and the joke needs it to read as an organ.
  capsule(ctx, x - w * 0.35, y - h * 0.7, x - w * 0.5, y - h * 1.25, w * 0.16, BLOOD_DARK, INK, 1.1);
  capsule(ctx, x + w * 0.3, y - h * 0.75, x + w * 0.55, y - h * 1.15, w * 0.14, BLOOD_LIGHT, INK, 1.1);
  if (bite > 0) {
    ellipse(ctx, x + w * 0.85, y - h * 0.35, w * 0.55 * bite, h * 0.55 * bite, 0, 'rgba(20,16,25,0.9)', 'none');
  }
}

/** Severed end: meat ring, bone core, a drip. */
function drawStump(s: Stage, x: number, y: number, r: number, rot: number): void {
  const ctx = s.ctx;
  if (s.gore <= 0) {
    ellipse(ctx, x, y, r, r * 0.6, rot, STEEL_DARK, INK, 1.2);
    return;
  }
  ellipse(ctx, x, y, r, r * 0.62, rot, BLOOD_DARK, INK, 1.2);
  ellipse(ctx, x, y, r * 0.62, r * 0.4, rot, BLOOD_LIGHT, 'none');
  ellipse(ctx, x, y, r * 0.3, r * 0.22, rot, BONE, INK, 0.9);
}

/** A pickaxe. Not sharpened since 1937. */
function drawPickaxe(ctx: C2D, x: number, y: number, rot: number, u: number): void {
  const hx = Math.sin(rot);
  const hy = -Math.cos(rot);
  capsule(ctx, x, y, x + hx * u * 3.2, y + hy * u * 3.2, u * 0.28, '#8a5a34', INK, 1.4);
  const px = x + hx * u * 3.2;
  const py = y + hy * u * 3.2;
  const nx = -hy;
  const ny = hx;
  poly(
    ctx,
    [
      px - nx * u * 1.9, py - ny * u * 1.9,
      px + nx * u * 1.9, py + ny * u * 1.9,
      px + nx * u * 1.5 + hx * u * 0.5, py + ny * u * 1.5 + hy * u * 0.5,
      px - nx * u * 1.5 + hx * u * 0.5, py - ny * u * 1.5 + hy * u * 0.5,
    ],
    STEEL,
    INK,
    1.5,
  );
  ellipse(ctx, px, py, u * 0.42, u * 0.42, 0, STEEL_DARK, INK, 1.2);
}

/** A hanging chain between two points. */
function drawChain(ctx: C2D, x1: number, y1: number, x2: number, y2: number, links: number, r: number): void {
  for (let i = 0; i <= links; i++) {
    const u = i / links;
    const sag = Math.sin(u * Math.PI) * r * 1.4;
    const px = lerp(x1, x2, u);
    const py = lerp(y1, y2, u) + sag;
    ellipse(ctx, px, py, r, r * 0.72, i & 1 ? 0.5 : -0.5, i & 1 ? STEEL : STEEL_DARK, INK, 1);
  }
}

/** A cardboard box. Optionally taped, optionally stamped. */
function drawBox(ctx: C2D, x: number, y: number, w: number, h: number, flapK: number): void {
  roundRect(ctx, x - w * 0.5, y - h, w, h, 1.5, CARD, INK, 1.6);
  ctx.globalAlpha *= 0.5;
  roundRect(ctx, x - w * 0.5, y - h * 0.62, w, 1.6, 0.4, '#8f6a38', 'none');
  ctx.globalAlpha /= 0.5;
  const fl = clamp(flapK, 0, 1);
  const lift = (1 - fl) * h * 0.5;
  poly(
    ctx,
    [x - w * 0.5, y - h, x, y - h - lift * 0.2, x, y - h + 1.6, x - w * 0.5, y - h + 1.6],
    '#b98b4f',
    INK,
    1.3,
  );
  poly(
    ctx,
    [x + w * 0.5, y - h, x, y - h - lift * 0.2, x, y - h + 1.6, x + w * 0.5, y - h + 1.6],
    '#a97c44',
    INK,
    1.3,
  );
}

/** A slab of paper with ruled lines. Contracts, EULAs, invoices, tickets. */
function drawPaper(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  lines: number,
  fill = PAPER,
): void {
  roundRect(ctx, x - w * 0.5, y, w, h, 1, fill, INK, 1.3);
  ctx.fillStyle = 'rgba(30,26,40,0.5)';
  const step = h / (lines + 1);
  for (let i = 1; i <= lines; i++) {
    const ly = y + step * i;
    const lw = w * (0.62 + 0.26 * hash(i * 7.7));
    ctx.fillRect(x - w * 0.5 + w * 0.1, ly, lw, Math.max(0.7, h * 0.012));
  }
}

/** A rectangular machine face with vents and blinking status lights. */
function drawRack(ctx: C2D, x: number, y: number, w: number, h: number, f: number): void {
  roundRect(ctx, x - w * 0.5, y - h, w, h, 2, '#2b303a', INK, 2);
  for (let i = 0; i < 8; i++) {
    const ly = y - h + h * (0.08 + i * 0.11);
    roundRect(ctx, x - w * 0.38, ly, w * 0.76, h * 0.06, 1, '#1a1e26', 'none');
    const on = hash(i * 3.3 + Math.floor(f * 0.12)) > 0.45;
    ellipse(ctx, x + w * 0.3, ly + h * 0.03, 1.2, 1.2, 0, on ? NEON : '#26302c', 'none');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The director
// ─────────────────────────────────────────────────────────────────────────────

export interface FatalityDeps {
  fx: Fx;
  audio: AudioBus;
  cam: Camera;
  rng: Rng;
  gore: Settings['gore'];
  /**
   * Optional, because the constructor contract predates it. Left unset, the
   * director asks the browser, which is the honest default for a preference
   * the caller did not have an opinion about.
   */
  reducedMotion?: boolean;
}

export class FatalityDirector {
  private readonly fx: Fx;
  private readonly audio: AudioBus;
  private readonly cam: Camera;
  private readonly rng: Rng;
  private gore: Settings['gore'];
  private reduced: boolean;

  private _active = false;
  private _done = true;

  private def: FatalityDef | null = null;
  private vis: Visual | null = null;
  private killer: Fighter | null = null;
  private victim: Fighter | null = null;
  private frame = 0;

  private savedZoom = 1;
  private targetX = 0;

  /** Lens splatter, screen space. Presentation only, hence Math.random. */
  private readonly spX = new Float32Array(SPLAT_MAX);
  private readonly spY = new Float32Array(SPLAT_MAX);
  private readonly spR = new Float32Array(SPLAT_MAX);
  private readonly spLife = new Float32Array(SPLAT_MAX);
  private splatCursor = 0;

  private readonly stage: Stage;

  constructor(deps: FatalityDeps) {
    this.fx = deps.fx;
    this.audio = deps.audio;
    this.cam = deps.cam;
    this.rng = deps.rng;
    this.gore = deps.gore;
    this.reduced =
      deps.reducedMotion ??
      (typeof matchMedia === 'function'
        ? matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    this.stage = {
      ctx: null as unknown as C2D,
      fx: this.fx,
      audio: this.audio,
      d: this,
      def: null as unknown as FatalityDef,
      killer: null as unknown as Fighter,
      victim: null as unknown as Fighter,
      f: 0,
      t: 0,
      dur: 1,
      dir: 1,
      kx: 0, ky: 0, kz: 0, kh: 40, ks: 1,
      vx: 0, vy: 0, vz: 0, vh: 40, vs: 1,
      gy: GROUND_Y,
      mx: 0,
      gore: 1,
      reduced: this.reduced,
      seed: 0,
    };
  }

  get active(): boolean {
    return this._active;
  }

  get done(): boolean {
    return this._done;
  }

  /** The finisher on stage, for a caller that wants to log or announce it. */
  get current(): FatalityDef | null {
    return this._active ? this.def : null;
  }

  /**
   * True for the two fighters this director is drawing itself.
   *
   * The level must skip its own draw for these, or the frozen originals sit
   * underneath the performance in their last combat pose and every finisher
   * reads as a duplication bug.
   */
  isStaged(id: number): boolean {
    if (!this._active) return false;
    return (this.killer !== null && this.killer.id === id) ||
      (this.victim !== null && this.victim.id === id);
  }

  /** The gore setting can change mid-session from the pause menu. */
  setGore(level: Settings['gore']): void {
    this.gore = level;
    this.stage.gore = goreMul(level);
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    this.stage.reduced = on;
  }

  start(def: FatalityDef, killer: Fighter, victim: Fighter): boolean {
    if (this._active) return false;
    if (this.gore === 'off') return false;
    if (killer === victim) return false;
    const vis = VISUALS[def.visual];
    if (!vis) return false;
    // A boss finisher belongs to exactly one boss. `archetype` is the boss id
    // for a boss, so this is the same check the content validator makes, made
    // again at the one moment it can still be wrong.
    if (def.boss !== undefined && killer.archetype !== def.boss) return false;

    const s = this.stage;
    s.def = def;
    s.killer = killer;
    s.victim = victim;
    s.dur = Math.max(30, Math.round(def.duration));
    s.f = 0;
    s.t = 0;
    s.gore = goreMul(this.gore);
    s.reduced = this.reduced;
    // Seeded from the pair and the RNG's CURRENT state — read, never advanced.
    s.seed = ((killer.id * 73856093) ^ (victim.id * 19349663) ^ this.rng.getState()) >>> 0;

    const dx = victim.pos.x - killer.pos.x;
    s.dir = (dx >= 0 ? 1 : -1) as Facing;

    s.kx = killer.pos.x;
    s.kz = killer.pos.z;
    s.ky = GROUND_Y + s.kz * Z_SCALE - Math.max(0, killer.pos.y);
    s.ks = depthScale(s.kz);
    s.kh = rigHeight(killer) * (killer.style.scale || 1) * s.ks;

    s.vx = victim.pos.x;
    s.vz = victim.pos.z;
    s.vy = GROUND_Y + s.vz * Z_SCALE - Math.max(0, victim.pos.y);
    s.vs = depthScale(s.vz);
    s.vh = rigHeight(victim) * (victim.style.scale || 1) * s.vs;

    // A finisher played at arm's length looks like two people mining. Close the
    // gap to something the choreography can actually reach across.
    const want = (s.kh + s.vh) * 0.24 + 8;
    const gap = Math.abs(dx);
    if (gap > want) s.vx = s.kx + s.dir * want;
    else if (gap < want * 0.55) s.vx = s.kx + s.dir * want * 0.55;

    s.gy = GROUND_Y + s.vz * Z_SCALE;
    s.mx = (s.kx + s.vx) * 0.5;

    this.def = def;
    this.vis = vis;
    this.killer = killer;
    this.victim = victim;
    this.frame = 0;
    this._active = true;
    this._done = false;

    this.savedZoom = this.cam.baseZoom;
    this.targetX = s.mx - VIEW_W * 0.5;

    // The stop. Everything after this happens in a room that has gone quiet.
    this.fx.slowmo(this.reduced ? 0.6 : 0.32, Math.min(26, s.dur));
    this.fx.flash('#ffffff', 3, this.reduced ? 0.2 : 0.5);
    if (!this.reduced) this.cam.punch(0.08);
    for (let i = 0; i < SPLAT_MAX; i++) this.spLife[i] = 0;
    return true;
  }

  /** Abandon the performance and give the camera straight back. */
  cancel(): void {
    if (!this._active) return;
    this._active = false;
    this._done = true;
    this.cam.zoom = this.savedZoom;
  }

  update(): void {
    if (!this._active) return;
    const s = this.stage;
    s.f = this.frame;
    s.t = clamp(this.frame / s.dur, 0, 1);

    this.driveCamera(s);
    this.playScheduledCues(s);
    if (this.vis?.tick) this.vis.tick(s);

    for (let i = 0; i < SPLAT_MAX; i++) {
      if (this.spLife[i] > 0) this.spLife[i]--;
    }

    this.frame++;
    if (this.frame > s.dur) {
      this._active = false;
      this._done = true;
      this.cam.zoom = this.savedZoom;
    }
  }

  /**
   * Slam in, creep, let go.
   *
   * The creep matters more than the slam: a camera that arrives and then sits
   * perfectly still turns the hold at the end into a screenshot, and the whole
   * point of the hold is that it is still a shot.
   */
  private driveCamera(s: Stage): void {
    const cam = this.cam;
    const peak = this.reduced ? SLAM_ZOOM_CALM : SLAM_ZOOM;
    const outAt = s.dur - SLAM_OUT;

    let zoom: number;
    if (this.frame < SLAM_IN) {
      const u = this.frame / SLAM_IN;
      zoom = lerp(this.savedZoom, peak, this.reduced ? easeInOut(u) : easeOutBack(u) * 0.98 + 0.02);
    } else if (this.frame > outAt) {
      zoom = lerp(peak * 1.06, this.savedZoom, easeInOut(clamp((this.frame - outAt) / SLAM_OUT, 0, 1)));
    } else {
      const u = (this.frame - SLAM_IN) / Math.max(1, outAt - SLAM_IN);
      zoom = lerp(peak, peak * 1.06, u);
    }
    cam.zoom = zoom;

    const lead = this.frame < SLAM_IN ? 0.34 : 0.12;
    cam.x = lerp(cam.x, this.targetX, this.reduced ? 0.2 : lead);
  }

  /** Spread the def's cue list across the first two thirds of the film. */
  private playScheduledCues(s: Stage): void {
    const cues = s.def.sfx;
    const n = cues.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const at = n === 1 ? 3 : Math.round(s.dur * (0.04 + 0.56 * (i / (n - 1))));
      if (this.frame === at) this.audio.play(cues[i], { pitch: 1 - i * 0.06 });
    }
  }

  /** A visual asking for one of its own. */
  cue(id: SfxCue, pitch = 1, gain = 1): void {
    this.audio.play(id, { pitch, gain });
  }

  /** A visual asking for weight: shake, flash, and a wet lens if it earned it. */
  hit(mag: number, frames = 12, splat = 0): void {
    this.fx.shake({ magnitude: mag, duration: frames });
    if (splat > 0) this.splatter(splat);
  }

  /**
   * Blood on the camera lens.
   *
   * It is the cheapest trick in the genre and the most effective: it says the
   * camera is IN the room, close enough to get some on it. Off entirely when
   * the player asked for no gore, because it is the one gore effect that stays
   * on screen after the moment has passed.
   */
  splatter(count: number): void {
    if (this.gore === 'off') return;
    const n = Math.round(count * (this.gore === 'max' ? 1.7 : 1));
    for (let i = 0; i < n; i++) {
      const k = this.splatCursor;
      this.splatCursor = (this.splatCursor + 1) % SPLAT_MAX;
      this.spX[k] = Math.random() * VIEW_W;
      this.spY[k] = BAR_H + Math.random() * (VIEW_H - BAR_H * 2);
      this.spR[k] = 2.5 + Math.random() * (this.gore === 'max' ? 11 : 7);
      this.spLife[k] = SPLAT_LIFE * (0.6 + Math.random() * 0.4);
    }
  }

  /** World-space layer. Call inside the same transform the fighters use. */
  render(ctx: C2D, cam: Camera): void {
    if (!this._active || !this.vis) return;
    const s = this.stage;
    s.ctx = ctx;
    // Nothing to draw if the whole performance is off the side of the view.
    if (s.mx - cam.x < -260 || s.mx - cam.x > VIEW_W + 260) return;
    ctx.save();
    this.vis.draw(s);
    ctx.restore();
  }

  /** Screen-space layer: letterbox, title card, lens splatter. */
  renderOverlay(ctx: C2D): void {
    if (!this._active || !this.def) return;
    const s = this.stage;
    const t = s.t;

    const inK = easeOut(clamp(this.frame / BAR_IN, 0, 1));
    const outK = 1 - easeIn(clamp((this.frame - (s.dur - 14)) / 14, 0, 1));
    const bar = BAR_H * inK * outK;
    if (bar > 0.5) {
      ctx.fillStyle = '#07060b';
      ctx.fillRect(0, 0, VIEW_W, bar);
      ctx.fillRect(0, VIEW_H - bar, VIEW_W, bar);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, bar - 1, VIEW_W, 1);
      ctx.fillRect(0, VIEW_H - bar, VIEW_W, 1);
    }

    this.drawSplatter(ctx);

    const at = this.vis?.banner ?? BANNER_AT;
    if (t >= at) {
      this.drawBanner(ctx, clamp((t - at) / Math.max(0.02, 1 - at), 0, 1), bar);
    }
  }

  private drawSplatter(ctx: C2D): void {
    for (let i = 0; i < SPLAT_MAX; i++) {
      const life = this.spLife[i];
      if (life <= 0) continue;
      const k = life / SPLAT_LIFE;
      const a = clamp(k * 0.85, 0, 0.8);
      const r = this.spR[i] * (1 + (1 - k) * 0.25);
      const wob = this.reduced ? 0 : Math.sin(life * 0.11 + i) * 0.6;
      ctx.globalAlpha = a;
      ctx.fillStyle = BLOOD_DARK;
      ctx.beginPath();
      ctx.ellipse(this.spX[i], this.spY[i] + (1 - k) * 6, r, r * (0.78 + wob * 0.05), 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * 0.55;
      ctx.fillStyle = BLOOD_LIGHT;
      ctx.beginPath();
      ctx.ellipse(this.spX[i] - r * 0.25, this.spY[i] - r * 0.2 + (1 - k) * 6, r * 0.42, r * 0.3, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawBanner(ctx: C2D, k: number, bar: number): void {
    const def = this.def!;
    const slam = this.reduced ? easeOut(clamp(k * 6, 0, 1)) : easeOutBack(clamp(k * 5, 0, 1));
    const shudder = this.reduced ? 0 : Math.max(0, 1 - k * 8) * 3.2;
    const cy = VIEW_H - bar - 44;

    ctx.save();
    ctx.translate(VIEW_W * 0.5, cy);
    ctx.scale(clamp(slam, 0.02, 1.2), clamp(slam, 0.02, 1.2));
    ctx.rotate(-0.024 + (this.reduced ? 0 : Math.sin(k * 22) * 0.004 * Math.max(0, 1 - k * 6)));

    const w = VIEW_W * 0.96;
    ctx.fillStyle = 'rgba(9,7,14,0.86)';
    ctx.fillRect(-w * 0.5, -17, w, 34);
    ctx.fillStyle = BLOOD;
    ctx.fillRect(-w * 0.5, -17, w, 2);
    ctx.fillRect(-w * 0.5, 15, w, 2);

    const name = def.name;
    const size = name.length > 22 ? 19 : name.length > 15 ? 23 : 27;
    ctx.font = `900 ${size}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = size * 0.3;
    ctx.strokeStyle = '#3a0206';
    ctx.strokeText(name, shudder * 0.4, -4);
    ctx.fillStyle = '#ffe14a';
    ctx.fillText(name, shudder * 0.4, -4);

    ctx.font = `700 9px ${DISPLAY}`;
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = INK;
    ctx.strokeText(def.banner, 0, 10);
    ctx.fillStyle = '#e8e2ff';
    ctx.fillText(def.banner, 0, 10);
    ctx.restore();

    if (TEXT_SCRATCH.length > 0) TEXT_SCRATCH.length = 0;
  }
}

function goreMul(level: Settings['gore']): number {
  return level === 'off' ? 0 : level === 'max' ? 1.8 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The book. One entry per `FatalityDef.visual`, no placeholders, no sharing.
// ─────────────────────────────────────────────────────────────────────────────

const VISUALS: Record<string, Visual> = {};

// ── PLAYER ───────────────────────────────────────────────────────────────────

/** THE ANNUAL REVIEW — reach in, take the spine, hold it up, drop it. */
VISUALS.spine_pull = {
  banner: 0.58,
  draw(s) {
    const t = s.t;
    const reach = seg(t, 0.06, 0.2);
    const pull = seg(t, 0.22, 0.46);
    const hold = seg(t, 0.46, 0.72);
    const drop = seg(t, 0.78, 1);
    const dir = s.dir;
    const gap = (s.vx - s.kx) * (1 - reach * 0.45);

    // The victim, doubled over the arm, then emptied: the rig loses height as
    // the thing that was holding it up leaves the building.
    const empt = pull * (1 - drop * 0);
    const vp = pull > 0.98 ? poseSprawl(0, easeIn(seg(t, 0.5, 0.72))) : poseSlump(0, 0.35 + pull * 0.65);
    const sag = 1 - empt * 0.34;
    squash(s, s.vx, s.gy, 1 + empt * 0.16, sag, () => {
      vict(s, gap - (s.vx - s.kx), 0, vp, 1, reach > 0.6 && pull < 0.2 ? 0.5 : 0);
    });

    const kp = hold > 0 ? posePresent(1, Math.sin(t * 30) * (1 - hold)) : poseThrust(1, reach - pull * 0.4);
    kill(s, dir * reach * 6, 0, kp);

    // The spine itself: out of the back, into the air, then on the floor.
    const handX = s.kx + dir * s.kh * 0.42;
    const handY = s.ky - s.kh * (hold > 0 ? 1.12 : 0.66);
    const len = s.vh * 0.62;
    if (pull > 0.02 && drop < 1) {
      const fall = easeIn(drop);
      const px = lerp(handX, handX + dir * 4, fall);
      const py = lerp(handY, s.gy - 1, fall);
      const rot = lerp(0.1 * dir, 1.4 * dir, fall);
      drawSpine(s.ctx, px, py, len * Math.min(1, 0.3 + pull), rot, Math.sin(t * 18) * 0.4 * (1 - hold));
    }
    if (drop >= 1) {
      drawSpine(s.ctx, handX + dir * 5, s.gy - 2, len, Math.PI * 0.5 * dir, 0);
    }
    bloodPool(s, s.vx, s.gy, s.vh * 0.5, pull);
  },
  tick(s) {
    const f = s.f;
    const at = (u: number) => f === Math.round(s.dur * u);
    if (at(0.2)) {
      s.d.cue('hit_flesh', 0.8);
      s.d.hit(5, 12, 3);
      spray(s, s.vx, s.vy - s.vh * 0.55, 16, -Math.PI * 0.5, 1.6, 3.6);
    }
    if (at(0.44)) {
      s.d.cue('bone_crack', 0.7);
      s.d.hit(7, 16, 7);
      spray(s, s.vx, s.vy - s.vh * 0.7, 26, -Math.PI * 0.5, 2.4, 4.6);
    }
    if (at(0.82)) s.d.cue('drop', 1.3, 0.7);
  },
};

/** ORGAN HARVEST — heart out, shown to camera, bitten like an apple. */
VISUALS.heart_bite = {
  banner: 0.6,
  draw(s) {
    const t = s.t;
    const inK = seg(t, 0.05, 0.22);
    const out = seg(t, 0.24, 0.42);
    const show = seg(t, 0.42, 0.56);
    const bite = seg(t, 0.6, 0.68);
    const chew = seg(t, 0.68, 0.86);
    const toss = seg(t, 0.9, 1);
    const dir = s.dir;

    const vp = out > 0.5 ? poseSprawl(0, easeIn(seg(t, 0.44, 0.66))) : poseSlump(0, inK);
    vict(s, -dir * inK * 3, 0, vp, 1, inK > 0.7 && out < 0.1 ? 0.6 : 0);

    const kp = show > 0 ? posePresent(1, Math.sin(t * 26) * 0.4) : poseThrust(1, inK - out * 0.5);
    kill(s, dir * inK * 5, 0, kp, 1, 0);

    const handX = s.kx + dir * s.kh * (show > 0 ? 0.36 : 0.5);
    const handY = s.ky - s.kh * (show > 0 ? 1.05 : 0.62);
    if (out > 0.02) {
      const beat = 0.5 + 0.5 * Math.sin(t * 34);
      const bx = lerp(handX, s.kx + dir * s.kh * 0.2, chew);
      const by = lerp(handY, s.ky - s.kh * 0.95, chew);
      const tx = lerp(bx, bx - dir * 40, easeIn(toss));
      const ty = lerp(by, by - 30 + easeIn(toss) * 60, easeIn(toss));
      drawHeart(s.ctx, tx, ty, s.vh * 0.12 * (0.6 + out * 0.4), beat, bite * 0.9);
      if (s.gore > 0 && toss < 0.5) {
        const drip = (t * 40) % 1;
        ellipse(s.ctx, tx + dir * 2, ty + s.vh * 0.14 + drip * 16, 1.4, 2.4, 0, BLOOD, 'none');
      }
    }
    // The chew: the head rocks, the beard swings, and nobody says anything.
    if (chew > 0 && chew < 1) shout(s, 'MMH', s.kx + dir * 14, s.ky - s.kh * 1.25, chew, 9, '#ffd8d8');
    bloodPool(s, s.vx, s.gy, s.vh * 0.46, out);
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.2)) {
      s.d.cue('hit_flesh', 0.9);
      s.d.hit(5, 12, 4);
      spray(s, s.vx, s.vy - s.vh * 0.62, 20, Math.PI * (s.dir > 0 ? 1 : 0), 1.5, 4);
    }
    if (at(0.42)) {
      s.d.cue('bone_crack', 1.1);
      s.d.hit(4, 10, 6);
    }
    if (at(0.62)) {
      s.d.cue('hit_flesh', 1.5, 0.7);
      s.d.splatter(4);
      spray(s, s.kx + s.dir * s.kh * 0.3, s.ky - s.kh * 1.0, 10, -Math.PI * 0.5, 2.2, 2.4);
    }
    if (at(0.9)) s.d.cue('whiff', 1.2, 0.6);
  },
};

/** SEVERANCE PACKAGE — a kick that clears the atmosphere. */
VISUALS.orbit_kick = {
  banner: 0.62,
  draw(s) {
    const t = s.t;
    const wind = seg(t, 0.04, 0.24);
    const snap = seg(t, 0.24, 0.3);
    const fly = seg(t, 0.3, 0.62);
    const dir = s.dir;

    kill(s, 0, 0, fly > 0.4 ? poseSmug(1, Math.sin(t * 8)) : poseKick(1, wind * 0.2 + snap));

    if (fly < 1) {
      // A long shallow arc that leaves the top of the frame, shrinking as it
      // goes — the distance is the joke, so the scale does the work.
      const u = easeOut(fly);
      const fx = s.vx + dir * u * 520;
      const fy = s.vy - u * 400 - snap * 20;
      const sc = s.vs * (1 - u * 0.82);
      const p = P(0);
      tilt(p, t * 42);
      arms(p, -1.6, 0.4, -1.5, 0.3);
      legs(p, 1.2, 0.6, 0.9, 0.8);
      if (sc > 0.05) {
        actor(s, s.victim, fx, fy, p, (-dir) as Facing, sc, clamp(1 - fly * 0.2, 0, 1));
      }
    }
    // ...and the twinkle, which is the punchline.
    const tw = seg(t, 0.66, 0.78);
    if (tw > 0 && t < 0.95) {
      const twx = s.vx + dir * 250;
      const twy = s.vy - 250;
      const k = Math.sin(tw * Math.PI);
      const r = 3 + k * 9;
      star(s.ctx, twx, twy, r, 4, '#ffffff', 'none');
      s.ctx.globalAlpha *= 0.5;
      star(s.ctx, twx, twy, r * 2.1, 4, '#bfe3ff', 'none');
      s.ctx.globalAlpha /= 0.5;
    }
    if (snap > 0 && snap < 1) {
      burst(s.ctx, s.vx, s.vy - s.vh * 0.5, s.vh * 0.5 * (1 - snap), 9, '#fff3c4', t * 6);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.25)) {
      s.d.cue('kick', 0.8);
      s.d.hit(8, 18);
      dust(s, s.vx, s.gy, 14, 3);
    }
    if (at(0.7)) s.d.cue('coin', 1.6, 0.5);
  },
};

/** DOWNSIZING — a server rack from above. Only the shoes are left. */
VISUALS.rack_drop = {
  banner: 0.56,
  draw(s) {
    const t = s.t;
    const point = seg(t, 0.06, 0.26);
    const fall = seg(t, 0.3, 0.42);
    const land = seg(t, 0.42, 0.5);
    const dir = s.dir;

    kill(s, 0, 0, fall > 0.5 ? poseSmug(1, Math.sin(t * 7)) : posePresent(1, point));

    if (fall < 1) {
      const p = P(0);
      const look = point;
      spine(p, -0.1 * look, -0.14 * look, -0.4 * look, -0.7 * look);
      arms(p, -0.4 * look, 0.5, -0.35 * look, 0.5);
      legs(p, 0.05, 0.12, -0.05, 0.12);
      vict(s, 0, 0, p);
    }

    const w = s.vh * 0.9;
    const h = s.vh * 1.5;
    const y = lerp(s.gy - 320, s.gy, easeIn(fall));
    const bounce = land > 0 ? Math.sin(land * Math.PI) * 4 : 0;
    drawRack(s.ctx, s.vx, y - bounce, w, h, s.f);
    if (land > 0.4) {
      // Two shoes and one hand, which is all downsizing ever leaves behind.
      const foot = s.gy - 1;
      for (let i = -1; i <= 1; i += 2) {
        const fx = s.vx + i * w * 0.28 - dir * w * 0.1;
        roundRect(s.ctx, fx - 4, foot - 4, 8, 4, 1.6, '#2a2530', INK, 1.2);
        capsule(s.ctx, fx - 3, foot - 2, fx + 3, foot - 2, 1.4, '#4a4250', INK, 1);
      }
      bloodPool(s, s.vx, s.gy, w * 0.8, seg(t, 0.5, 0.85));
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.3)) s.d.cue('whiff', 0.6);
    if (at(0.42)) {
      s.d.cue('explosion', 0.7);
      s.d.cue('hit_metal', 0.9);
      s.d.hit(12, 26, 9);
      dust(s, s.vx, s.gy, 26, 4);
      spray(s, s.vx, s.gy - 3, 22, -Math.PI * 0.5, 2.9, 4.4);
    }
  },
};

/** HI HO — the pickaxe, out for the first time since 1937. */
VISUALS.pickaxe_split = {
  banner: 0.6,
  draw(s) {
    const t = s.t;
    const raise = seg(t, 0.05, 0.3);
    const chop = seg(t, 0.3, 0.37);
    const part = seg(t, 0.4, 0.78);
    const dir = s.dir;

    kill(s, 0, 0, poseSwing(1, chop));
    const hy = s.ky - s.kh * (1.35 - chop * 0.85);
    const hx = s.kx + dir * s.kh * (0.1 + chop * 0.55);
    drawPickaxe(s.ctx, hx, hy, (chop > 0 ? lerp(-2.4, 0.5, chop) : lerp(-0.6, -2.4, raise)) * dir, s.kh * 0.12);

    // Two clipped draws of one rig: the split is a camera trick, not a second
    // set of art, so the halves are exactly the man who was standing there.
    const spread = easeOut(part) * s.vh * 0.3;
    const droop = easeIn(part);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const p = P(i);
      tilt(p, droop * 1.3 * side * dir);
      body(p, side * dir * droop * 3, -droop * 2);
      arms(p, -0.8 - droop, 0.4, -0.7 - droop, 0.4);
      legs(p, 0.4 * droop, 0.5, 0.3 * droop, 0.5);
      spine(p, 0.2 * droop, 0.1, 0, 0.3 * droop);
      const cx = s.vx + side * spread;
      clipRect(s, cx + (side < 0 ? -60 : 0) + side * 0.5, s.gy - 200, 60, 240, () => {
        actor(s, s.victim, cx, s.gy, p, (-dir) as Facing, s.vs);
      });
    }
    if (chop > 0.2) {
      // The seam, drawn once so the two halves read as one cut.
      s.ctx.globalAlpha *= 0.9;
      capsule(s.ctx, s.vx, s.gy - s.vh, s.vx, s.gy, 1.1 + part * 2, s.gore > 0 ? BLOOD_DARK : 'rgba(20,16,26,0.5)', 'none');
      s.ctx.globalAlpha /= 0.9;
    }
    bloodPool(s, s.vx, s.gy, s.vh * 0.62, part);
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.28)) s.d.cue('weapon_swing', 0.8);
    if (at(0.33)) {
      s.d.cue('bone_crack', 0.65);
      s.d.cue('hit_flesh', 0.8);
      s.d.hit(11, 22, 11);
      spray(s, s.vx, s.vy - s.vh * 0.8, 34, -Math.PI * 0.5, 1.9, 5.2);
    }
    if (at(0.55)) spray(s, s.vx, s.vy - s.vh * 0.4, 16, -Math.PI * 0.5, 2.8, 2.6);
  },
};

/** CHAIN LETTER — one loop, one yank, and the head goes on ahead. */
VISUALS.chain_decap = {
  banner: 0.56,
  draw(s) {
    const t = s.t;
    const loop = seg(t, 0.05, 0.24);
    const yank = seg(t, 0.26, 0.34);
    const fly = seg(t, 0.34, 0.62);
    const fall = seg(t, 0.4, 0.72);
    const dir = s.dir;

    kill(s, 0, 0, yank > 0 ? poseSwing(1, 1 - yank * 0.4) : poseThrust(1, loop, 0.4));

    const neckY = s.vy - s.vh * 0.86;
    const p = P(0);
    if (fall > 0) {
      const k = easeIn(fall);
      tilt(p, -1.5 * k);
      body(p, 2.4 * k, 3 * k);
      arms(p, -1.6 * k, 0.3, -1.4 * k, 0.3);
      legs(p, 0.7 * k, 0.5, 0.6 * k, 0.5);
    } else {
      spine(p, 0.1 * loop, 0.1, -0.2 * yank, 0);
      arms(p, -0.4 - yank, 0.7, -0.3 - yank, 0.7);
    }
    if (yank > 0.1) hatGone(p);
    // Head off means head hidden: the neck bone keeps the skull, so the whole
    // head is scaled out of existence and the stump is drawn over the gap.
    if (yank > 0.5) p.head!.scale = 0.01;
    vict(s, 0, 0, p);
    if (yank > 0.5) drawStump(s, s.vx, neckY + (fall > 0 ? 4 : 0), s.vh * 0.09, 0);

    if (loop > 0 && yank < 0.6) {
      drawChain(
        s.ctx,
        s.kx + dir * s.kh * 0.42,
        s.ky - s.kh * 0.9,
        s.vx - dir * s.vh * 0.12,
        neckY,
        9,
        Math.max(1, s.vh * 0.035),
      );
    }
    if (yank > 0.5 && fly < 1) {
      // Head and hat, leaving together, still wearing the expression.
      const u = easeOut(fly);
      const hx = s.vx - dir * u * 150;
      const hy = neckY - Math.sin(u * Math.PI) * 90 + u * 40;
      const hp = P(1);
      tilt(hp, t * 30);
      s.ctx.save();
      s.ctx.translate(hx, hy);
      s.ctx.rotate(t * 9 * dir);
      s.ctx.translate(-s.vx, -neckY - s.vh * 0.14);
      clipRect(s, s.vx - 40, neckY - 60, 80, 62, () => {
        actor(s, s.victim, s.vx, s.gy, poseStand(2), (-dir) as Facing, s.vs);
      });
      s.ctx.restore();
      if (s.gore > 0 && (s.f & 3) === 0) spray(s, hx, hy, 2, Math.PI * 0.5, 1.2, 1.6);
    }
    bloodPool(s, s.vx, s.gy, s.vh * 0.5, seg(t, 0.4, 0.9));
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.2)) s.d.cue('chain_whip', 0.9);
    if (at(0.3)) {
      s.d.cue('bone_crack', 0.6);
      s.d.hit(9, 20, 10);
      spray(s, s.vx, s.vy - s.vh * 0.86, 30, -Math.PI * 0.5, 1.2, 5);
    }
    if (s.f > s.dur * 0.34 && s.f < s.dur * 0.62 && (s.f & 7) === 0) {
      spray(s, s.vx, s.vy - s.vh * 0.86, 6, -Math.PI * 0.5, 1.1, 3.4);
    }
  },
};

/** RECYCLING — folded into a barrel that will not close. */
VISUALS.barrel_fold = {
  banner: 0.6,
  draw(s) {
    const t = s.t;
    const stuff = seg(t, 0.06, 0.34);
    const lid1 = seg(t, 0.36, 0.46);
    const lid2 = seg(t, 0.5, 0.6);
    const stomp = seg(t, 0.66, 0.74);
    const dir = s.dir;
    const bx = s.vx;
    const bw = s.vh * 0.62;
    const bh = s.vh * 0.78;
    const by = s.gy;

    // The body, compressed into a container it does not fit in.
    const k = easeIn(stuff);
    const sink = k * s.vh * 0.72;
    const flat = 1 - stomp * 0.35;
    squash(s, bx, by, 1 + k * 0.1, 1 - k * 0.12, () => {
      const p = P(0);
      hips(p, 0.4 * k, 0, -6 * k);
      spine(p, 0.9 * k, 0.5 * k, 0.2, 0.5 * k);
      arms(p, -1.4 * k + (1 - stomp) * 0.9, 1.4 * k, -0.3, 1.2 * k);
      legs(p, 1.5 * k, 1.7 * k, 1.2 * k, 1.6 * k, 0.5, 0.5);
      body(p, 0, -sink * 0.55);
      vict(s, 0, 0, p, 1, 0);
    });

    // Barrel front, drawn after the body so the body is inside it.
    squash(s, bx, by, 1, flat, () => {
      roundRect(s.ctx, bx - bw * 0.5, by - bh, bw, bh, 3, '#3f6d4a', INK, 1.8);
      s.ctx.globalAlpha *= 0.55;
      roundRect(s.ctx, bx - bw * 0.5, by - bh * 0.72, bw, 2.4, 1, '#8fd0a0', 'none');
      roundRect(s.ctx, bx - bw * 0.5, by - bh * 0.3, bw, 2.4, 1, '#8fd0a0', 'none');
      s.ctx.globalAlpha /= 0.55;
      // The little triangle, applied with no irony whatsoever.
      const cy = by - bh * 0.5;
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI * 0.5 + (i * TAU) / 3;
        const px = bx + Math.cos(a) * bw * 0.17;
        const py = cy + Math.sin(a) * bw * 0.17;
        poly(
          s.ctx,
          [px, py - 2.6, px + 2.4, py + 1.8, px - 2.4, py + 1.8],
          '#c9f0d4',
          INK,
          0.8,
        );
      }
    });

    // The lid: down, up, down, and eventually flat regardless.
    const bounce = Math.max(lid1 > 0 && lid1 < 1 ? Math.sin(lid1 * Math.PI) : 0, lid2 > 0 && lid2 < 1 ? Math.sin(lid2 * Math.PI) : 0);
    const lidY = by - bh * flat - 2 - bounce * s.vh * 0.22 - (1 - Math.max(lid1, 0)) * s.vh * 0.5 * (1 - stuff);
    roundRect(s.ctx, bx - bw * 0.56, lidY - 3.4, bw * 1.12, 4.6, 2, '#2f5439', INK, 1.6);
    if (stomp > 0 && stomp < 1) {
      burst(s.ctx, bx, lidY, bw * 0.7 * Math.sin(stomp * Math.PI), 8, '#fff3c4', 0.4);
    }
    kill(s, dir * 4, stomp > 0 && stomp < 1 ? -s.kh * 0.3 * Math.sin(stomp * Math.PI) : 0, stomp > 0 ? poseSwing(1, stomp) : poseThrust(1, stuff * 0.8));
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.34)) s.d.cue('drop', 0.8);
    if (at(0.42)) s.d.cue('hit_metal', 1.4, 0.6);
    if (at(0.56)) s.d.cue('hit_metal', 1.2, 0.7);
    if (at(0.68)) {
      s.d.cue('bat_crack', 0.7);
      s.d.hit(9, 18, 2);
      dust(s, s.vx, s.gy, 16, 2.6);
    }
  },
};

/** TERMS OF SERVICE — made to read it. Ages, then crumbles, mid-scroll. */
VISUALS.eula_scroll = {
  banner: 0.66,
  draw(s) {
    const t = s.t;
    const give = seg(t, 0.04, 0.16);
    const read = seg(t, 0.16, 0.74);
    const dustK = seg(t, 0.76, 0.9);
    const dir = s.dir;

    kill(s, 0, 0, read > 0.2 ? poseSmug(1, Math.sin(t * 6)) : posePresent(1, give));

    const age = read;
    const px = s.vx;
    const py = s.vy - s.vh * 0.72;
    // The scroll: unrolled from the top, still going, still not the end.
    if (give > 0.1 && dustK < 1) {
      const w = s.vh * 0.44;
      const h = s.vh * (0.3 + read * 1.9);
      drawPaper(s.ctx, px + dir * s.vh * 0.3, py - s.vh * 0.1, w, h, Math.round(4 + read * 26));
      capsule(s.ctx, px + dir * s.vh * 0.3 - w * 0.55, py - s.vh * 0.1, px + dir * s.vh * 0.3 + w * 0.55, py - s.vh * 0.1, 2.2, '#d8cdb4', INK, 1.2);
      label(s, 'I AGREE', px + dir * s.vh * 0.3, py - s.vh * 0.1 + h - 6, 5.5, '#6a5a48');
    }

    if (dustK < 1) {
      const p = P(0);
      const stoop = age;
      spine(p, 0.45 * stoop, 0.3 * stoop, 0.25 * stoop, 0.4 * stoop);
      arms(p, 0.9 - 0.2 * stoop, 1.1, 0.85 - 0.2 * stoop, 1.05);
      legs(p, 0.15 * stoop, 0.4 * stoop, -0.1 * stoop, 0.42 * stoop);
      hips(p, 0.2 * stoop, 0, -3 * stoop);
      head2(p, 0.3 * stoop, 0.8 * stoop);
      p.beard!.scale = 1 + age * 2.6;
      vict(s, 0, 0, p, 1 - dustK * 0.9);
      // Grey creeps up the beard, because nothing else on the rig can age.
      if (age > 0.3) {
        s.ctx.globalAlpha *= (age - 0.3) * 1.2;
        capsule(
          s.ctx,
          px - dir * 1, py + s.vh * 0.08,
          px - dir * 2, py + s.vh * 0.08 + s.vh * 0.5 * age,
          s.vh * 0.07,
          '#e6e2ea',
          'none',
        );
        s.ctx.globalAlpha /= (age - 0.3) * 1.2;
      }
    }
    if (dustK > 0) {
      dustPool(s, s.vx, s.gy, s.vh * 0.4, dustK);
      ellipse(s.ctx, s.vx, s.gy - 3 * dustK, s.vh * 0.24 * dustK, s.vh * 0.1 * dustK, 0, '#b9ae9c', INK, 1);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (s.f > s.dur * 0.2 && s.f < s.dur * 0.74 && s.f % 26 === 0) s.d.cue('ui_move', 0.8, 0.35);
    if (at(0.78)) {
      s.d.cue('ui_error', 0.7, 0.6);
      s.d.cue('drop', 0.5, 0.6);
      dust(s, s.vx, s.gy - s.vh * 0.4, 30, 1.6);
      s.d.hit(3, 14);
    }
  },
};

/** SYNERGY — two smaller, more focused teams. Confetti, not blood. */
VISUALS.confetti_tear = {
  banner: 0.56,
  draw(s) {
    const t = s.t;
    const grab = seg(t, 0.04, 0.22);
    const strain = seg(t, 0.22, 0.4);
    const tear = seg(t, 0.4, 0.5);
    const hold = seg(t, 0.5, 0.72);
    const dir = s.dir;

    kill(s, 0, 0, tear > 0 ? posePresent(1, Math.sin(t * 18) * (1 - hold)) : poseThrust(1, grab + strain * 0.3));

    const lift = easeOut(grab) * s.vh * 0.5;
    const pull = strain * s.vh * 0.14 + easeOut(tear) * s.vh * 0.4;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const p = P(i);
      const flail = Math.sin(t * 22 + i * 2) * (1 - hold) * 0.5;
      tilt(p, 3.05 + flail * 0.2);
      arms(p, -1.2 + flail, 0.6, -1.1 - flail, 0.6);
      legs(p, 0.3, 0.5 + flail * 0.4, -0.2, 0.5 - flail * 0.4);
      const cx = s.vx + side * pull * 0.5;
      const cy = s.gy - lift - (tear > 0 ? easeOut(hold) * s.vh * 0.2 : 0);
      clipRect(s, cx + (side < 0 ? -70 : 0), cy - 200, 70, 260, () => {
        actor(s, s.victim, cx, cy + s.vh, p, (-dir) as Facing, s.vs);
      });
    }
    if (tear > 0.1) {
      // A paper streamer where the middle used to be.
      for (let i = 0; i < 5; i++) {
        const u = i / 4;
        const x = lerp(s.vx - pull * 0.5, s.vx + pull * 0.5, u);
        const y = s.gy - lift - s.vh * 0.5 + Math.sin(u * Math.PI + t * 6) * 4;
        ellipse(s.ctx, x, y, 2.4, 3.2, u * 2, CONFETTI_COLORS[i % CONFETTI_COLORS.length], INK, 0.7);
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.24)) s.d.cue('grunt', 0.8);
    if (at(0.42)) {
      s.d.cue('bone_crack', 0.8);
      s.d.hit(9, 20);
      confetti(s, s.vx, s.vy - s.vh * 0.55, 60);
    }
    if (at(0.52)) {
      s.d.cue('laugh', 1.1, 0.7);
      confetti(s, s.vx, s.vy - s.vh * 0.7, 40);
    }
    if (s.f > s.dur * 0.5 && s.f % 14 === 0) confetti(s, s.vx, s.vy - s.vh * 0.9, 8);
  },
};

/** THE VESTING CLIFF — off the frame, a long pause, a wet noise. */
VISUALS.off_frame_toss = {
  banner: 0.82,
  draw(s) {
    const t = s.t;
    const spin = seg(t, 0.06, 0.26);
    const release = seg(t, 0.26, 0.34);
    const gone = seg(t, 0.34, 0.4);
    const wait = seg(t, 0.4, 0.72);
    const splat = seg(t, 0.72, 0.8);
    const dir = s.dir;

    const kp = splat > 0
      ? poseSmug(1, Math.sin(t * 5))
      : wait > 0
        ? poseStand(1, Math.sin(t * 4))
        : poseSwing(1, release);
    kill(s, 0, 0, kp);

    if (gone < 1) {
      const u = easeOut(release);
      const around = spin * TAU * 2;
      const rx = s.kx + Math.cos(around) * s.kh * 0.5 * (1 - release);
      const ry = s.ky - s.kh * 1.1 - Math.sin(around) * s.kh * 0.2;
      const fx = lerp(rx, rx + dir * 320, u);
      const fy = lerp(ry, ry - 90, u);
      const p = P(0);
      tilt(p, t * 40);
      arms(p, -1.5, 0.5, -1.4, 0.4);
      legs(p, 1.0, 0.5, 0.8, 0.6);
      actor(s, s.victim, fx, fy + s.vh, p, (-dir) as Facing, s.vs * (1 - u * 0.25), 1 - gone);
    }
    // The pause. Nothing happens, at length, and that is the joke.
    if (wait > 0.2 && splat <= 0) {
      shout(s, '. . .', s.kx + dir * 26, s.ky - s.kh * 1.35, seg(t, 0.5, 0.72), 11, '#cfc8e0');
    }
    if (splat > 0 && splat < 1) {
      // Something comes back into frame. Not all of him.
      const u = easeOut(splat);
      const x = s.kx + dir * lerp(200, 30, u);
      const y = s.ky - s.kh * 0.8;
      if (s.gore > 0) {
        ellipse(s.ctx, x, y, 6 * (1 - u * 0.4), 4, 0, BLOOD, INK, 1);
        ellipse(s.ctx, x + dir * 9, y - 4, 3, 2.2, 0, BLOOD_DARK, 'none');
      } else {
        ellipse(s.ctx, x, y, 5, 3.4, 0, '#6d6470', INK, 1);
      }
    }
    if (splat >= 1) {
      // He wipes his face. He does not look at what he is wiping off.
      const wipe = seg(t, 0.82, 0.94);
      const p = P(1);
      arms(p, -0.3, 0.4, -1.9 + wipe * 0.6, 1.7);
      hands(p, 0, -0.4);
      spine(p, -0.05, -0.05, 0.05, 0.1);
      legs(p, 0.05, 0.1, -0.05, 0.1);
      kill(s, 0, 0, p);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.28)) s.d.cue('whiff', 0.7);
    if (at(0.73)) {
      s.d.cue('hit_flesh', 0.5);
      s.d.cue('glass', 0.6, 0.5);
      s.d.hit(7, 18, 12);
      spray(s, s.kx + s.dir * 120, s.ky - s.kh * 0.8, 22, Math.PI * (s.dir > 0 ? 1 : 0), 1.1, 5);
    }
  },
};

/** THE EXIT INTERVIEW — a firm handshake, and the arm comes with it. */
VISUALS.handshake_keep = {
  banner: 0.62,
  draw(s) {
    const t = s.t;
    const offer = seg(t, 0.04, 0.16);
    const shake = seg(t, 0.16, 0.3);
    const squeeze = seg(t, 0.3, 0.4);
    const rip = seg(t, 0.42, 0.52);
    const give = seg(t, 0.58, 0.72);
    const topple = seg(t, 0.82, 1);
    const dir = s.dir;

    const shakeWob = shake > 0 && squeeze <= 0 ? Math.sin(t * 40) * 0.12 : 0;
    const kp = P(1);
    arms(kp, -0.2, 0.4, 1.35 + shakeWob - give * 0.5, 0.35);
    hands(kp, 0, -0.2 - squeeze * 0.3);
    spine(kp, 0.1 + squeeze * 0.1, 0.08, 0, 0.05);
    legs(kp, -0.1, 0.12, 0.12, 0.14);
    kill(s, rip > 0 ? -dir * rip * 5 : 0, 0, kp);

    const vp = P(0);
    if (topple > 0) {
      const k = easeIn(topple);
      tilt(vp, -1.5 * k);
      body(vp, 2.3 * k, 3 * k);
      arms(vp, -1.6 * k, 0.2, 0, 0.2);
      legs(vp, 0.7 * k, 0.5, 0.6 * k, 0.5);
    } else {
      const pain = squeeze;
      spine(vp, 0.2 * pain, 0.15 * pain, -0.1, 0.2 * pain);
      arms(vp, 1.4 + shakeWob, 0.3, -0.2 + give * 1.3, 0.4 + give * 0.5);
      legs(vp, 0.1 * pain, 0.2 + pain * 0.3, -0.1, 0.2 + pain * 0.3);
      hips(vp, 0, 0, -2 * pain);
    }
    // The arm leaves at the shoulder. Everything above the elbow stays put.
    if (rip > 0.3) vp.armL_upper!.scale = 0.01;
    vict(s, rip > 0 ? dir * rip * 4 : 0, 0, vp, 1, squeeze > 0.8 && rip < 0.2 ? 0.5 : 0);
    if (rip > 0.3 && topple < 0.6) {
      const shoulderX = s.vx - dir * s.vh * 0.14;
      const shoulderY = s.vy - s.vh * 0.74;
      drawStump(s, shoulderX, shoulderY, s.vh * 0.06, 0.4);
    }

    // The arm itself, held, offered back, and accepted.
    if (rip > 0.05) {
      const u = easeOut(rip);
      const hx = lerp(s.vx - dir * s.vh * 0.14, s.kx + dir * s.kh * 0.5, u);
      const hy = lerp(s.vy - s.vh * 0.74, s.ky - s.kh * 0.78, u);
      const gx = lerp(hx, s.vx - dir * s.vh * 0.1, easeInOut(give));
      const gy = lerp(hy, s.vy - s.vh * 0.62, easeInOut(give));
      const ang = 0.5 * dir + give * 0.4;
      capsule(s.ctx, gx, gy, gx + Math.cos(ang) * s.vh * 0.3 * dir, gy + Math.sin(ang) * s.vh * 0.3, s.vh * 0.05, s.victim.style.jacketColor, INK, 1.4);
      ellipse(s.ctx, gx + Math.cos(ang) * s.vh * 0.34 * dir, gy + Math.sin(ang) * s.vh * 0.34, s.vh * 0.055, s.vh * 0.05, 0, s.victim.style.skin, INK, 1.2);
      drawStump(s, gx, gy, s.vh * 0.05, ang);
    }
    bloodPool(s, s.vx, s.gy, s.vh * 0.36, seg(t, 0.5, 0.9));
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.32)) s.d.cue('grunt', 0.9);
    if (at(0.38)) s.d.cue('bone_crack', 1.2, 0.8);
    if (at(0.44)) {
      s.d.cue('hit_flesh', 0.7);
      s.d.hit(7, 16, 6);
      spray(s, s.vx - s.dir * s.vh * 0.14, s.vy - s.vh * 0.74, 20, -Math.PI * 0.5, 2.4, 3.8);
    }
    if (at(0.86)) {
      s.d.cue('drop', 0.7);
      s.d.hit(4, 12);
    }
  },
};

/** CULTURE FIT — the head unscrews. There is a fizz. */
VISUALS.unscrew_head = {
  banner: 0.64,
  draw(s) {
    const t = s.t;
    const grab = seg(t, 0.04, 0.2);
    const turn = seg(t, 0.2, 0.6);
    const pop = seg(t, 0.6, 0.68);
    const fall = seg(t, 0.68, 0.86);
    const dir = s.dir;

    kill(s, 0, 0, pop > 0 ? posePresent(1, Math.sin(t * 20) * (1 - pop)) : poseThrust(1, grab, 0.55));

    const vp = P(0);
    if (fall > 0) {
      const k = easeIn(fall);
      tilt(vp, -1.5 * k);
      body(vp, 2.2 * k, 3 * k);
      arms(vp, -1.5 * k, 0.3, -1.4 * k, 0.3);
      legs(vp, 0.7 * k, 0.5, 0.6 * k, 0.5);
    } else {
      const wring = turn;
      spine(vp, -0.1, -0.1, 0.1, 0);
      arms(vp, -0.5 - wring * 0.6, 0.5, -0.4 - wring * 0.6, 0.5);
      legs(vp, 0.1, 0.25 + wring * 0.4, -0.1, 0.25 + wring * 0.4);
      hips(vp, 0, 0, -1.5 * wring);
      // The neck stretches as the threads give up.
      vp.neck!.scale = 1 + turn * 1.6 - pop * 1.5;
      vp.head!.rot = turn * TAU * 2.4;
    }
    if (pop > 0.5) vp.head!.scale = 0.01;
    if (pop > 0.5) hatGone(vp);
    vict(s, 0, 0, vp);
    if (pop > 0.5) drawStump(s, s.vx, s.vy - s.vh * 0.84 + (fall > 0 ? 5 : 0), s.vh * 0.075, 0);

    if (pop > 0.05) {
      // Held aloft, still turning, hat still on. Nobody is impressed.
      const u = easeOut(pop);
      const hx = lerp(s.vx, s.kx + dir * s.kh * 0.34, u);
      const hy = lerp(s.vy - s.vh * 0.86, s.ky - s.kh * 1.18, u);
      s.ctx.save();
      s.ctx.translate(hx, hy);
      s.ctx.rotate(0.3 * dir + Math.sin(t * 5) * 0.1);
      s.ctx.translate(-s.vx, -(s.vy - s.vh * 0.86) - s.vh * 0.14);
      clipRect(s, s.vx - 44, s.vy - s.vh * 1.5, 88, s.vh * 0.72, () => {
        actor(s, s.victim, s.vx, s.gy, poseStand(2), (-dir) as Facing, s.vs);
      });
      s.ctx.restore();
      if (pop < 1) {
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI * 0.5 + jitter(s.seed, i) * 1.4;
          const r = pop * 20 + i * 2;
          ellipse(s.ctx, s.vx + Math.cos(a) * r, s.vy - s.vh * 0.86 + Math.sin(a) * r, 1.6, 1.6, 0, '#dff6ff', 'none');
        }
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (s.f > s.dur * 0.24 && s.f < s.dur * 0.6 && s.f % 11 === 0) s.d.cue('bone_crack', 1.6, 0.3);
    if (at(0.61)) {
      s.d.cue('glass', 1.7, 0.6);
      s.d.cue('bone_crack', 0.7);
      s.d.hit(6, 16, 6);
      spray(s, s.vx, s.vy - s.vh * 0.86, 24, -Math.PI * 0.5, 1.4, 3.6);
      sparks(s, s.vx, s.vy - s.vh * 0.86, 12, -Math.PI * 0.5);
    }
    if (at(0.72)) s.d.cue('laugh', 1.2, 0.5);
  },
};

/** RETURN TO OFFICE — the cubicle comes to you. */
VISUALS.cubicle_seal = {
  banner: 0.64,
  draw(s) {
    const t = s.t;
    const kneel = seg(t, 0.04, 0.2);
    const rise = seg(t, 0.22, 0.5);
    const roof = seg(t, 0.54, 0.64);
    const dark = seg(t, 0.78, 0.9);
    const dir = s.dir;
    const w = s.vh * 1.1;
    const h = s.vh * 1.15;

    kill(s, dir * 6, 0, poseSmug(1, Math.sin(t * 6)));

    // Back panel first, then the body, then the front panels: the layering IS
    // the seal, so it is done in draw order rather than with a clip.
    const up = easeOut(rise) * h;
    roundRect(s.ctx, s.vx - w * 0.5, s.gy - up, w, up, 1, '#6f7a6a', INK, 1.6);
    for (let i = 0; i < 4; i++) {
      s.ctx.globalAlpha *= 0.4;
      roundRect(s.ctx, s.vx - w * 0.45, s.gy - up + up * (0.1 + i * 0.22), w * 0.9, 1.2, 0.4, '#8b9684', 'none');
      s.ctx.globalAlpha /= 0.4;
    }
    vict(s, 0, 0, poseKneel(0, kneel));

    if (rise > 0.4) {
      // Desk, monitor, and a phone that will ring in a moment.
      const dy = s.gy - up * 0.42;
      roundRect(s.ctx, s.vx - w * 0.42, dy, w * 0.84, 3, 1, '#a98f6a', INK, 1.2);
      roundRect(s.ctx, s.vx - 7, dy - 12, 14, 11, 1.4, '#2a2f38', INK, 1.2);
      roundRect(s.ctx, s.vx - 5.4, dy - 10.6, 10.8, 7.6, 0.8, dark > 0.4 ? '#10141a' : '#39d9ff', 'none');
    }
    const rf = easeIn(roof);
    if (rf > 0) {
      roundRect(s.ctx, s.vx - w * 0.56, s.gy - h - 14 + rf * 14, w * 1.12, 5, 1.4, '#8a927f', INK, 1.6);
    }
    if (dark > 0) {
      s.ctx.globalAlpha *= dark * 0.85;
      roundRect(s.ctx, s.vx - w * 0.5, s.gy - h, w, h, 1, '#0b0d12', 'none');
      s.ctx.globalAlpha /= dark * 0.85;
    }
    if (roof > 0.8 && dark < 0.6) {
      shout(s, 'RING', s.vx + dir * w * 0.4, s.gy - h * 0.7, seg(t, 0.66, 0.8), 8, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.24)) s.d.cue('drop', 0.7, 0.6);
    if (at(0.5)) s.d.cue('hit_metal', 0.6, 0.5);
    if (at(0.56)) {
      s.d.cue('drop', 0.5);
      s.d.hit(5, 14);
      dust(s, s.vx, s.gy, 14, 2);
    }
    if (at(0.68)) s.d.cue('ui_error', 1.3, 0.5);
  },
};

// APPEND-POINT
