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
 * ── THE FOLLOW-THROUGH ──────────────────────────────────────────────────────
 *
 * A finisher used to end with the killer holding a spine and quietly dropping
 * it, while six guards stood in a ring and politely waited their turn. So the
 * performance has a second act: `FatalityDef.trophy` says what is left in the
 * killer's hands, `pickFlourish` says what they do with it, and one entry in
 * `FLOURISH_VISUALS` draws it — the same table shape as `VISUALS`, resolved the
 * same way, and just as fatal to an unknown id. Everyone hostile inside the
 * flourish's radius takes its damage through `Fighter.takeHit`, so hitstun,
 * knockdown, blood and the combo counter behave exactly as they do in the
 * fight. The crowd arrives through `FatalityDeps.crowd`; with no provider the
 * flourish still plays and simply hits nobody.
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
 * The performance itself NEVER consumes the shared RNG. It reads `getState()`
 * to season a per-performance seed and nothing else. That is deliberate: gore
 * is a local preference, two peers in a lockstep match may legitimately
 * disagree about it, and a director that drew from the shared stream would turn
 * that disagreement into a desync.
 *
 * The follow-through is the one exception and it has to be: it deals real
 * damage, so choosing it and applying it must come from the seeded stream
 * rather than from `Math.random`. That is safe for the same reason the freeze
 * is — the scene refuses to stage a finisher at all in a netplay fight, so the
 * shared stream is never shared while any of this runs. Presentation (lens
 * splatter, smear ghosts) still uses `Math.random`, and still never touches it.
 */

import type {
  AudioBus,
  BoneName,
  Facing,
  FatalityDef,
  FatalityFlourish,
  HitProperties,
  ParticleSpec,
  Pose,
  RigStyle,
  Rng,
  Settings,
  SfxCue,
  SimContext,
  TrophyKind,
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
import { drawBossRig, hasBossRig } from '@/render/rig/BossRigs';
import { drawCharacter, drawLooseHat } from '@/render/rig/CharacterRig';
import { pickFlourish } from '@/content/fatalities';

import { FONT_DISPLAY } from '@/ui/theme';
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
const DISPLAY = FONT_DISPLAY;

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

/**
 * Where the performers' floor sits on screen while the camera is slammed in.
 *
 * The slam zooms about the middle of the frame, and the belt is not in the
 * middle of the frame: at 2.15x a pair standing anywhere but the back third of
 * it had their legs under the bottom letterbox bar, and a pair at the front
 * were off the screen altogether. The camera now carries them up to this line —
 * a little floor above the bar, and every head on the roster under the top one.
 */
const FRAME_FLOOR_Y = VIEW_H - BAR_H - 30;

/**
 * A blow this hard does something to the FILM, not just to the room: the
 * picture holds on it. Below this, a hit is a shake and nothing else.
 */
const BEAT_FROM = 6;
/** ...and one this hard is the killing frame. It gets the grade and the lines. */
const BEAT_KILL = 9;
/** Most frames a single blow may hold the picture for. */
const HOLD_MAX = 7;
/**
 * Frames of hold one whole show may spend.
 *
 * A held frame is a frame the film does not advance, so every one of them is
 * added to how long the fight stays frozen. Capped, so that a finisher made of
 * six big hits is still a three-second finisher. The scene's watchdog knows
 * this number — see FATALITY_GRACE in FightScene.
 */
export const HOLD_BUDGET = 24;
/** The lean the camera settles into, in radians, and how fast a knock dies. */
const DUTCH = 0.032;
const TILT_DECAY = 0.84;
/** How dark the room goes round the two of them, at the edge of the pool. */
const VEIL = 0.62;
/** ...and how much of that the middle of the pool keeps. */
const VEIL_CORE = 0.08;
/** Frames the focus lines stay up, and how many of them there are. */
const FOCUS_FRAMES = 13;
const FOCUS_LINES = 30;

/**
 * Hard ceiling on a follow-through, in frames.
 *
 * The scene gives a finisher its own duration plus a fixed grace and then
 * cancels the whole thing out from under the director, so a content entry with
 * an over-generous duration in it has to cost a clipped flourish rather than a
 * fight that never resumes. Comfortably above the longest one in the book.
 */
const MAX_FLOURISH = 116;
/** Where the camera settles for the follow-through: the fight's own framing. */
const FLOURISH_ZOOM = 1.04;
/**
 * How far either side of the lane a thrown trophy still counts as hitting, in
 * world depth units. The belt is Z_DEPTH deep; this is about a third of it, so
 * a bowling ball down the middle takes the middle and misses the back row.
 */
const LANE_DEPTH = 26;
/** How far a landed throw knocks over the bystanders around its impact point. */
const SPLASH = 38;

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
  /** Cues and shakes go through the director, which is what schedules them. */
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
  /** Victim is metal: draw sparks and oil, never blood. */
  mechanical: boolean;
  reduced: boolean;
  seed: number;
  /**
   * Where the action has gone, for the camera to go after it: screen pixels to
   * the side of the pair's midpoint, and above their floor. A renderer sets
   * these from `tick` when its choreography leaves the spot — a body launched
   * overhead, a charge through three walls — and leaves them at zero otherwise.
   */
  pan: number;
  lift: number;

  // ── the follow-through, only meaningful while a flourish is on stage ───────
  /** Frames elapsed in the flourish, and the same thing normalised to 0..1. */
  ff: number;
  ft: number;
  fdur: number;
  /** What is in the killer's hand. Never 'none' while a flourish is running. */
  trophy: TrophyKind;
  /** How many the sweep caught. 0 until it connects; drives the reaction size. */
  caught: number;
  /**
   * Screen point the throw is aimed at — the nearest hostile when there is one,
   * otherwise a plausible spot out in front of the killer so an empty room
   * still gets a throw with somewhere to go.
   */
  tx: number;
  ty: number;
  /** Draw scale for whatever is standing at the aim point. */
  ts: number;
}

interface Visual {
  draw(s: Stage): void;
  tick?(s: Stage): void;
  /** Where the title card lands, as a fraction of the duration. */
  banner?: number;
}

/**
 * How a flourish decides who it caught.
 *
 * `FatalityFlourish.radius` alone cannot say this, and the difference matters:
 * TORNADO's 66 is a circle drawn around the killer's feet, BOWLING's 210 is the
 * length of a lane, and JAVELIN's 240 is how far it will look for ONE target
 * before it gives up. Reading all three as "a sphere of damage" would turn the
 * javelin — the highest-damage entry in the book, and named after a throw at a
 * single person — into a screen clear.
 *
 *   'self'  — a circle about the killer. Spins, slams, whips.
 *   'lane'  — a corridor from the killer out to `radius`, LANE_DEPTH either
 *             side. Anything that travels along the floor or through the front
 *             row.
 *   'point' — the nearest hostile within `radius`, plus everyone within SPLASH
 *             of where it lands. "Hurl it at the nearest enemy, and knock over
 *             everyone nearby", which is what was actually asked for.
 */
type FlourishReach = 'self' | 'lane' | 'point';

/**
 * One entry per `FatalityFlourish.visual`.
 *
 * Same contract as `Visual`, with two additions. `strike` is the fraction of
 * the flourish at which the sweep connects — the single frame the director
 * deals damage on, required rather than defaulted, because "when does this hit"
 * is the one thing a follow-through cannot be vague about. `reach` is the shape
 * above.
 */
interface FlourishVisual {
  draw(s: Stage): void;
  tick?(s: Stage): void;
  strike: number;
  reach: FlourishReach;
}

/** 0 before `a`, 1 after `b`, linear between. The spine of every renderer. */
function seg(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);
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

/**
 * Standing height of a skeleton in rig units, feet to crown.
 *
 * Walked rather than hard-coded: the dwarf skeleton and the human one are 46
 * and 72 units tall, bosses scale on top of that, and a prop sized off the
 * wrong one lands at the wrong height on half the cast.
 */
function rigHeight(f: Fighter): number {
  let h = 0;
  for (const b of f.skeleton) {
    if (b.name === 'pelvis') h += b.y;
    else if (b.name === 'torso' || b.name === 'chest' || b.name === 'neck' || b.name === 'head') {
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
  // A boss with a body of its own keeps it here too. The finisher poses its
  // actors from authored keyframes, which a quadruped or a car has no joints
  // for — but drawing the Shiba as a humanoid for the whole animation, which is
  // what happened before, is far worse than posing it generically. Better the
  // right creature in a plain pose than the wrong creature in a good one.
  if (who.bossRig && hasBossRig(who.bossRig)) {
    drawBossRig(s.ctx, who.bossRig, who.style, x, y, facing, {
      state: who === s.victim ? 'hurt' : who.state,
      frame: s.f,
      scale,
      alpha,
      flash,
      tint: tint ?? who.tint ?? undefined,
      damage: who.damage,
    });
    return;
  }

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
  tint?: string,
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
    tint,
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

/** Run `fn` with the canvas turned about (cx, cy). Positive is clockwise on screen. */
function rolled(s: Stage, cx: number, cy: number, rot: number, fn: () => void): void {
  const ctx = s.ctx;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
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

/**
 * A dent in the floor with cracks running out of it. `k` grows it in.
 *
 * Flattened like everything else that lies on the belt, and seeded per
 * performance so two craters in one fight are not the same crater.
 */
function drawCrater(s: Stage, x: number, y: number, w: number, k: number): void {
  if (k <= 0) return;
  const r = w * easeOut(clamp(k, 0, 1));
  ellipse(s.ctx, x, y, r, r * 0.2, 0, 'rgba(14,11,19,0.78)', 'none');
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + jitter(s.seed, i + 60) * 0.3;
    const len = r * (1.25 + 0.5 * hash(i * 2.3 + 1));
    zigzag(
      s.ctx,
      x + Math.cos(a) * r * 0.7,
      y + Math.sin(a) * r * 0.16,
      x + Math.cos(a) * len,
      y + Math.sin(a) * len * 0.22,
      1.2,
      4,
      'rgba(14,11,19,0.7)',
      1,
    );
  }
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
 * The one the follow-through uses, in WORLD space.
 *
 * `emit` below converts from the stage's screen coordinates using the victim's
 * depth, which is exactly wrong for a guard standing somewhere else on the
 * belt: the crowd already has world coordinates, so it keeps its own spec and
 * skips the round trip.
 */
const CROWD_SPEC: ParticleSpec = {
  count: 0,
  x: 0,
  y: 0,
  z: 0,
  angle: Math.PI * 0.5,
  spread: 2.2,
  speed: [1, 3],
  life: [20, 40],
  size: [1.6, 2.8],
  colors: BLOOD_COLORS,
  gravity: 0.32,
  drag: 0.96,
  shape: 'blood',
  fade: 'ease',
};

/** Stable ordering for anything the sweep iterates. See `strikeCrowd`. */
function byId(a: Fighter, b: Fighter): number {
  return a.id - b.id;
}

/**
 * Emit at a SCREEN point.
 *
 * Particles live in world space, the stage thinks in screen space, and the two
 * differ by the victim's depth — so every emission in this file goes through
 * here rather than doing the conversion four ways in forty places.
 *
 * `angle` is a SCREEN angle like everything else a renderer hands over: zero is
 * right, and NEGATIVE is up, because the canvas's y runs down. The particle
 * system's own angles run the other way (PI/2 is straight up), so it is turned
 * over here, once. It used to be passed through as it stood, which sent every
 * fountain in the book — written as `-PI / 2`, meaning "up" — straight into the
 * floor, and every drip up into the air.
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
  SPEC.angle = -angle;
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
  if (s.mechanical) {
    sparks(s, sx, sy, Math.max(4, Math.round(count * 0.7)), angle);
    return;
  }
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

// ── Trophy art ───────────────────────────────────────────────────────────────
//
// Everything a finisher can leave in the killer's hands, drawn from the same
// primitives as the finishers themselves and coloured out of the VICTIM's
// RigStyle, so a torn-off arm is visibly the arm of the man on the floor.
//
// Each of these draws around (x, y) with `u` as the unit of size — roughly a
// tenth of the victim's on-screen height — and `rot` as the direction it points
// in, 0 = up, positive = clockwise on screen.

/** A severed arm: sleeve, forearm, hand, and a stump at the shoulder end. */
function drawTrophyArm(ctx: C2D, style: RigStyle, x: number, y: number, rot: number, u: number): void {
  const dx = Math.sin(rot);
  const dy = -Math.cos(rot);
  const ex = x + dx * u * 2.1;
  const ey = y + dy * u * 2.1;
  const hx = ex + dx * u * 1.7 + -dy * u * 0.5;
  const hy = ey + dy * u * 1.7 + dx * u * 0.5;
  capsule(ctx, x, y, ex, ey, u * 0.44, style.jacketColor, INK, 1.4);
  capsule(ctx, ex, ey, hx, hy, u * 0.34, style.skin, INK, 1.3);
  ellipse(ctx, hx, hy, u * 0.42, u * 0.36, rot, style.skin, INK, 1.2);
  // Knuckles, so the far end reads as a hand and not as a sausage.
  for (let i = -1; i <= 1; i++) {
    ellipse(ctx, hx + -dy * u * 0.22 * i, hy + dx * u * 0.22 * i, u * 0.12, u * 0.12, 0, style.skinShade, 'none');
  }
  ellipse(ctx, x, y, u * 0.46, u * 0.3, rot, BLOOD_DARK, INK, 1.1);
  ellipse(ctx, x, y, u * 0.18, u * 0.13, rot, BONE, 'none');
}

/** A severed leg: trouser, calf, boot, femur showing at the hip end. */
function drawTrophyLeg(ctx: C2D, style: RigStyle, x: number, y: number, rot: number, u: number): void {
  const dx = Math.sin(rot);
  const dy = -Math.cos(rot);
  const kx = x + dx * u * 2.4;
  const ky = y + dy * u * 2.4;
  const ax = kx + dx * u * 2.2;
  const ay = ky + dy * u * 2.2;
  capsule(ctx, x, y, kx, ky, u * 0.58, style.tunicColor, INK, 1.5);
  capsule(ctx, kx, ky, ax, ay, u * 0.42, style.tunicColor, INK, 1.4);
  // The boot, square to the leg rather than to the world: it has been off the
  // body long enough to stop caring which way is down.
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(rot);
  roundRect(ctx, -u * 0.5, -u * 0.1, u * 1.5, u * 0.8, u * 0.3, '#2a2530', INK, 1.4);
  capsule(ctx, -u * 0.4, u * 0.62, u * 0.9, u * 0.62, u * 0.16, '#4a4250', INK, 1);
  ctx.restore();
  ellipse(ctx, x, y, u * 0.62, u * 0.4, rot, BLOOD_DARK, INK, 1.2);
  ellipse(ctx, x, y, u * 0.24, u * 0.17, rot, BONE, INK, 0.8);
}

/**
 * A head, hat and all, wearing the expression it stopped on.
 *
 * `hatScale` is the scale the loose hat is drawn at, which is NOT derivable
 * from `u`: `drawLooseHat` sizes itself off the rig's own units, so the caller
 * passes the same scale the victim was being drawn at and the hat comes out
 * fitting the skull it came off.
 */
function drawTrophyHead(
  ctx: C2D,
  style: RigStyle,
  x: number,
  y: number,
  rot: number,
  u: number,
  hatScale: number,
): void {
  const r = u * 1.4;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Beard first so the jaw sits on top of it.
  if (style.beardStyle !== 'none') {
    ellipse(ctx, 0, r * 0.72, r * 0.86, r * (0.7 + (style.beardLength || 1) * 0.28), 0, style.hair, INK, 1.3);
  }
  ellipse(ctx, 0, 0, r, r * 1.08, 0, style.skin, INK, 1.5);
  ellipse(ctx, r * 0.6, r * 0.14, r * 0.28, r * 0.24, 0, style.skinShade, INK, 1);
  if (style.shades) {
    roundRect(ctx, -r * 0.82, -r * 0.34, r * 1.64, r * 0.4, r * 0.14, '#15121b', INK, 1);
  } else {
    // Eyes, shut. Nobody in this file is ever drawn conscious.
    capsule(ctx, -r * 0.52, -r * 0.2, -r * 0.2, -r * 0.2, r * 0.07, INK, 'none');
    capsule(ctx, r * 0.2, -r * 0.2, r * 0.52, -r * 0.2, r * 0.07, INK, 'none');
  }
  // The neck, opened, at the bottom of the skull.
  ellipse(ctx, 0, r * 1.02, r * 0.44, r * 0.2, 0, BLOOD_DARK, INK, 1.1);
  ellipse(ctx, 0, r * 1.02, r * 0.17, r * 0.09, 0, BONE, 'none');
  ctx.restore();
  drawLooseHat(ctx, style, x, y - r * 0.62, rot, hatScale);
}

/** A torso: jacket, collar, and three stumps where the rest of him went. */
function drawTrophyTorso(ctx: C2D, style: RigStyle, x: number, y: number, rot: number, u: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  roundRect(ctx, -u * 1.1, -u * 1.5, u * 2.2, u * 3, u * 0.5, style.jacketColor, INK, 1.7);
  roundRect(ctx, -u * 0.32, -u * 1.5, u * 0.64, u * 3, u * 0.2, style.tunicColor, INK, 1.2);
  poly(
    ctx,
    [-u * 1.1, -u * 1.5, -u * 0.2, -u * 1.5, -u * 0.6, -u * 0.7],
    style.jacketAccent,
    INK,
    1.1,
  );
  poly(
    ctx,
    [u * 1.1, -u * 1.5, u * 0.2, -u * 1.5, u * 0.6, -u * 0.7],
    style.jacketAccent,
    INK,
    1.1,
  );
  // Neck and both shoulders, opened.
  ellipse(ctx, 0, -u * 1.5, u * 0.4, u * 0.24, 0, BLOOD_DARK, INK, 1.1);
  ellipse(ctx, 0, -u * 1.5, u * 0.16, u * 0.1, 0, BONE, 'none');
  for (let i = -1; i <= 1; i += 2) {
    ellipse(ctx, i * u * 1.05, -u * 1.05, u * 0.3, u * 0.36, 0, BLOOD_DARK, INK, 1);
  }
  ellipse(ctx, 0, u * 1.5, u * 0.7, u * 0.26, 0, BLOOD, INK, 1.1);
  ctx.restore();
}

/**
 * The catch-all: whatever the kill actually involved.
 *
 * Deliberately generic — a wrenched-out server blade, a barrel lid, a stapler,
 * a gavel all read as "a heavy angular thing with an edge on it" at this size,
 * and a specific silhouette per finisher would be forty props for two seconds
 * of screen time each.
 */
function drawTrophyObject(ctx: C2D, x: number, y: number, rot: number, u: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  poly(
    ctx,
    [
      -u * 0.9, -u * 1.6,
      u * 0.9, -u * 1.3,
      u * 1.05, u * 1.4,
      -u * 0.7, u * 1.6,
    ],
    STEEL,
    INK,
    1.7,
  );
  poly(
    ctx,
    [-u * 0.9, -u * 1.6, u * 0.9, -u * 1.3, u * 0.6, -u * 0.6, -u * 0.7, -u * 0.85],
    STEEL_DARK,
    INK,
    1.1,
  );
  for (let i = 0; i < 3; i++) {
    ellipse(ctx, -u * 0.35 + i * u * 0.5, u * 0.75, u * 0.14, u * 0.14, 0, '#2b303a', 'none');
  }
  // A torn edge, because it did not come off cleanly.
  zigzag(ctx, -u * 0.7, u * 1.6, u * 1.05, u * 1.4, u * 0.3, 4, STEEL_DARK, 1.2);
  ctx.restore();
}

/**
 * Whatever this performance left in the killer's hands, at (x, y).
 *
 * `k` scales the whole prop; 1 is the size it hangs at. Unknown trophies cannot
 * reach here — `beginFlourish` refuses a trophy it has no art for, exactly as
 * `start` refuses a visual it has no renderer for.
 */
function drawTrophy(s: Stage, x: number, y: number, rot: number, k = 1): void {
  const ctx = s.ctx;
  const style = s.victim.style;
  const u = Math.max(1.2, s.vh * 0.1 * k);
  switch (s.trophy) {
    case 'spine':
      drawSpine(ctx, x, y - u * 2.4, u * 7, rot, Math.sin(s.ft * 12) * 0.3);
      break;
    case 'heart':
      drawHeart(ctx, x, y, u * 1.1, 0.5 + 0.5 * Math.sin(s.ff * 0.4), 0);
      break;
    case 'arm':
      drawTrophyArm(ctx, style, x, y, rot, u);
      break;
    case 'leg':
      drawTrophyLeg(ctx, style, x, y, rot, u);
      break;
    case 'head':
      drawTrophyHead(ctx, style, x, y, rot, u, s.vs * k);
      break;
    case 'hat':
      drawLooseHat(ctx, style, x, y, rot, s.vs * k * 1.1);
      break;
    case 'torso':
      drawTrophyTorso(ctx, style, x, y, rot, u);
      break;
    default:
      drawTrophyObject(ctx, x, y, rot, u);
      break;
  }
}

/** True when this file knows how to draw the thing. Checked before staging. */
function hasTrophyArt(t: TrophyKind): boolean {
  return (
    t === 'spine' || t === 'heart' || t === 'arm' || t === 'leg' ||
    t === 'head' || t === 'hat' || t === 'torso' || t === 'object'
  );
}

// ── Motion ───────────────────────────────────────────────────────────────────

/**
 * The trophy, plus the several places it just was.
 *
 * Motion blur is the whole reason a tornado reads as a tornado rather than as a
 * prop teleporting round a circle: at 60Hz a limb travelling three revolutions
 * a second lands in a different quadrant every frame, and without the ghosts
 * the eye simply loses it.
 */
function trophyTrail(
  s: Stage,
  n: number,
  at: (i: number) => { x: number; y: number; rot: number; k?: number },
): void {
  const ctx = s.ctx;
  const count = s.reduced ? Math.min(2, n) : n;
  for (let i = count; i >= 1; i--) {
    const p = at(i);
    ctx.save();
    ctx.globalAlpha *= 0.42 * (1 - i / (count + 1));
    drawTrophy(s, p.x, p.y, p.rot, p.k ?? 1);
    ctx.restore();
  }
  const p = at(0);
  drawTrophy(s, p.x, p.y, p.rot, p.k ?? 1);
}

/** A thick arc of speed, swept about (cx, cy) from `a0` to `a1`. */
function arcSmear(
  s: Stage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  width: number,
  color: string,
  alpha: number,
): void {
  if (alpha <= 0.01 || width <= 0.05) return;
  const ctx = s.ctx;
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, a0, a1, a1 < a0);
  ctx.stroke();
  ctx.restore();
}

/** A straight streak of speed. The javelin's contrail, the discus's line. */
function lineSmear(
  s: Stage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: string,
  alpha: number,
): void {
  if (alpha <= 0.01) return;
  const ctx = s.ctx;
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  capsule(ctx, x1, y1, x2, y2, Math.max(0.4, width), color, 'none');
  ctx.restore();
}

/**
 * A ring of dust travelling out along the floor.
 *
 * Drawn as a flattened ellipse rather than a circle because the floor is a belt
 * seen at an angle, and a round ring on it reads as a hoop standing up.
 */
function floorRing(s: Stage, x: number, y: number, r: number, alpha: number, color = '#cfc6b8'): void {
  if (alpha <= 0.01 || r <= 0.5) return;
  const ctx = s.ctx;
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 3 - r * 0.012);
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * Z_SCALE * 0.62, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * What is left where the victim was standing.
 *
 * The flourish renderers do not re-stage the finisher they follow — half the
 * book ends with no body at all (kicked into orbit, folded into a box, dropped
 * down a tunnel) — so the aftermath is one honest mark on the floor rather than
 * a corpse that half the finishers never produced.
 */
function aftermath(s: Stage): void {
  if (s.gore > 0) {
    bloodPool(s, s.vx, s.gy, s.vh * 0.5, 1);
  } else {
    dustPool(s, s.vx, s.gy, s.vh * 0.42, 1);
    if (s.mechanical) {
      for (let i = 0; i < 5; i++) {
        const j = jitter(s.seed, i + 40);
        poly(
          s.ctx,
          [
            s.vx + j * s.vh * 0.4, s.gy - 1,
            s.vx + j * s.vh * 0.4 + 3, s.gy - 4,
            s.vx + j * s.vh * 0.4 + 5, s.gy - 1,
          ],
          i & 1 ? STEEL : STEEL_DARK,
          INK,
          0.8,
        );
      }
    }
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
  /** Everyone currently in the fight, for the follow-through to sweep. */
  crowd?: () => Fighter[];
  /**
   * The world's vertical framing offset, as the scene applies it inside its
   * camera transform. The director needs it to work out where the floor will
   * land on screen; left unset, it assumes there is none.
   */
  frameY?: number;
}

/** Nothing to sweep. Frozen and shared, so the no-crowd path allocates nothing. */
const NO_CROWD: readonly Fighter[] = Object.freeze([]) as readonly Fighter[];

export class FatalityDirector {
  private readonly fx: Fx;
  private readonly audio: AudioBus;
  private readonly cam: Camera;
  private readonly rng: Rng;
  private readonly crowd: () => readonly Fighter[];
  private gore: Settings['gore'];
  private reduced: boolean;

  private _active = false;
  private _done = true;

  private def: FatalityDef | null = null;
  private vis: Visual | null = null;
  private killer: Fighter | null = null;

  /** Who performed it, so the scene can hand them back their feet. */
  get performer(): Fighter | null {
    return this.killer;
  }
  private victim: Fighter | null = null;
  private frame = 0;

  /**
   * The follow-through, decided at `start()` so the letterbox and the camera
   * know how long the whole show is before the first frame of it is drawn.
   * Null whenever there is nothing in the killer's hands.
   */
  private fl: FatalityFlourish | null = null;
  private flVis: FlourishVisual | null = null;
  private flFrame = 0;
  private flDur = 0;
  private flStruck = false;
  private inFlourish = false;
  /** What a thrown trophy is aimed at, chosen once when the flourish begins. */
  private aim: Fighter | null = null;

  /** Reused so the sweep allocates nothing per hit. */
  private readonly hitProps: HitProperties = {
    damage: 0,
    hitstun: 0,
    blockstun: 0,
    hitstop: 0,
    knockback: { x: 0, y: 0 },
    pushback: 0,
    reaction: 'sweep',
    level: 'unblockable',
    chip: 0,
    meterGain: 0,
    meterGainVictim: 0,
    shake: 0,
  };
  private readonly caught: Fighter[] = [];
  private readonly sim: SimContext;

  private savedZoom = 1;
  private targetX = 0;
  private readonly frameY: number;

  /** Frames the picture is being held on a blow. See `beat`. */
  private hold = 0;
  private holdBudget = 0;
  /** Roll the last blow knocked the camera to; decays to nothing. */
  private tiltKick = 0;
  /** Frames of focus lines left. */
  private focus = 0;

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
    this.crowd = deps.crowd ?? (() => NO_CROWD);
    this.frameY = deps.frameY ?? 0;
    this.gore = deps.gore;
    this.reduced =
      deps.reducedMotion ??
      (typeof matchMedia === 'function'
        ? matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    /*
     * A SimContext for the sweep, and only for the sweep.
     *
     * `Fighter.takeHit` is the ONE damage route in this game — hitstun, the
     * knockdown, the blood, the drop, the combo counter and the death all hang
     * off it — so the follow-through goes through it too rather than inventing
     * a second one that would get three of those five right. It wants a
     * SimContext, and the director does not own the fight's one; what it needs
     * out of it, though, is small and entirely satisfiable from here.
     *
     *   fighters      — the crowd, which is exactly what the caller supplies
     *   fx / audio    — the director's own, already the fight's own
     *   rng           — the shared seeded stream, as the determinism rule says
     *   spawnHit      — nothing: a flourish is resolved here, not queued
     *   spawn         — nothing, and faithfully so: `Level.spawn` refuses
     *                   outright while a finisher is on stage, so a dropped
     *                   weapon leaves the hand and does not become a pickup
     *                   either way
     *   requestHitstop— swallowed. Six guards caught by one swing would each
     *                   ask for their own freeze and stack five they did not
     *                   earn; the director spends one, sized to the crowd, in
     *                   `strikeCrowd`.
     */
    const self = this;
    this.sim = {
      get frame(): number {
        return self.frame;
      },
      get rng(): Rng {
        return self.rng;
      },
      get fighters(): readonly Fighter[] {
        return self.crowd();
      },
      spawnHit(): void {
        /* resolved directly; see above */
      },
      spawn(): void {
        /* the map is frozen; see above */
      },
      requestHitstop(): void {
        /* the director owns the freeze; see above */
      },
      get fx(): Fx {
        return self.fx;
      },
      get audio(): AudioBus {
        return self.audio;
      },
    };

    this.stage = {
      ctx: null as unknown as C2D,
      fx: this.fx,
      d: this,
      mechanical: false,
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
      pan: 0,
      lift: 0,
      ff: 0,
      ft: 0,
      fdur: 1,
      trophy: 'none',
      caught: 0,
      tx: 0,
      ty: 0,
      ts: 1,
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
    // Machines do not bleed. The blood helpers all fall through to their dry
    // variants at gore 0, so zeroing it here routes a vacuum bot or a
    // Cybertruck down the sparks-and-oil path instead of spraying arterial red
    // out of a chassis. Combat already did this; the finishers never did.
    s.mechanical = victim.mechanical;
    if (s.mechanical) s.gore = 0;
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

    this.chooseFlourish(def, s);

    this.savedZoom = this.cam.baseZoom;
    this.targetX = s.mx - VIEW_W * 0.5;
    s.pan = 0;
    s.lift = 0;
    this.hold = 0;
    this.holdBudget = HOLD_BUDGET;
    this.tiltKick = 0;
    this.focus = this.reduced ? 0 : FOCUS_FRAMES;

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
    this.inFlourish = false;
    this.releaseCamera();
  }

  /** Everything the director borrowed from the camera, handed back at once. */
  private releaseCamera(): void {
    this.cam.zoom = this.savedZoom;
    this.cam.y = 0;
    this.cam.rotation = 0;
    this.hold = 0;
    this.focus = 0;
  }

  update(): void {
    if (!this._active) return;
    const s = this.stage;

    for (let i = 0; i < SPLAT_MAX; i++) {
      if (this.spLife[i] > 0) this.spLife[i]--;
    }
    if (this.focus > 0) this.focus--;

    /*
     * The held frame.
     *
     * A blow that earned one stops the film on the picture of it landing: the
     * clock does not advance, no cue fires, no beat is re-run. The camera keeps
     * working — it is still settling from the knock — and that is all that
     * moves. This is the same trick hitstop plays in the fight, and the reason
     * a finisher's big hit used to feel lighter than an ordinary uppercut is
     * that the fight had it and the film did not.
     */
    if (this.hold > 0) {
      this.hold--;
      if (this.inFlourish) this.driveFlourishCamera(s);
      else this.driveCamera(s);
      return;
    }

    if (this.inFlourish) {
      this.updateFlourish(s);
    } else {
      s.f = this.frame;
      s.t = clamp(this.frame / s.dur, 0, 1);

      this.driveCamera(s);
      this.playScheduledCues(s);
      if (this.vis?.tick) this.vis.tick(s);
    }

    if (this.inFlourish) {
      this.flFrame++;
      if (this.flFrame > this.flDur) this.finish();
      return;
    }

    this.frame++;
    if (this.frame > s.dur) {
      // The finisher is over. If there is something in the killer's hands, the
      // room is about to find out about it; otherwise this is the end, exactly
      // as it has always been.
      if (this.flVis) this.beginFlourish(s);
      else this.finish();
    }
  }

  /** Retire, hand the camera back, and report done. The one way out. */
  private finish(): void {
    this._active = false;
    this._done = true;
    this.inFlourish = false;
    this.releaseCamera();
  }

  // ── the follow-through ─────────────────────────────────────────────────────

  /** The flourish on stage, if one is running. Null the rest of the time. */
  get flourish(): FatalityFlourish | null {
    return this._active && this.inFlourish ? this.fl : null;
  }

  /**
   * Decide the second act, at the same moment as the first.
   *
   * Deciding it up front rather than when the finisher runs out is what lets
   * the letterbox and the camera know the length of the WHOLE show before they
   * draw a frame of it — bars that retract at the finisher's last frame and
   * then have to slam back in for the flourish look like a bug, because they
   * are one.
   *
   * `pickFlourish` consumes at most one number from the shared stream and only
   * when it returns something, which is the same bargain `pickFatality` makes.
   */
  private chooseFlourish(def: FatalityDef, s: Stage): void {
    this.fl = null;
    this.flVis = null;
    this.flFrame = 0;
    this.flDur = 0;
    this.flStruck = false;
    this.inFlourish = false;
    this.aim = null;
    s.trophy = 'none';
    s.caught = 0;
    s.ff = 0;
    s.ft = 0;
    s.fdur = 1;

    const trophy = def.trophy;
    if (trophy === undefined || trophy === 'none') return;
    if (this.gore === 'off') return;
    if (!hasTrophyArt(trophy)) return;

    const fl = pickFlourish(trophy, this.rng, this.gore);
    if (!fl) return;
    const vis = FLOURISH_VISUALS[fl.visual];
    // Same refusal as `start`: a flourish this file cannot draw never plays,
    // and the finisher simply ends the way it used to.
    if (!vis) return;

    this.fl = fl;
    this.flVis = vis;
    // Bounded on purpose. The scene gives a finisher its own duration plus a
    // fixed grace before it cancels the whole thing out from under us, so a
    // content entry with a silly duration in it costs a clipped flourish rather
    // than a fight that never resumes.
    this.flDur = clamp(Math.round(fl.duration), 20, MAX_FLOURISH);
    s.trophy = trophy;
    s.fdur = this.flDur;
  }

  /** Total frames of the whole show, finisher plus follow-through. */
  private get showDur(): number {
    return this.stage.dur + (this.flVis ? this.flDur : 0);
  }

  /** Frames elapsed across the whole show, for the letterbox and the banner. */
  private get showFrame(): number {
    return this.inFlourish ? this.stage.dur + this.flFrame : this.frame;
  }

  private beginFlourish(s: Stage): void {
    const fl = this.fl;
    const vis = this.flVis;
    const killer = this.killer;
    if (!fl || !vis || !killer) {
      this.finish();
      return;
    }

    this.inFlourish = true;
    this.flFrame = 0;
    this.flStruck = false;
    s.ff = 0;
    s.ft = 0;
    s.caught = 0;

    // Where the throw is going. Fixed once, so the trophy does not chase a
    // target that is about to be knocked flat by it.
    const aim = this.nearestHostile(killer, fl.radius);
    this.aim = aim;
    if (aim) {
      s.tx = aim.pos.x;
      s.ts = depthScale(aim.pos.z);
      s.ty = GROUND_Y + aim.pos.z * Z_SCALE - Math.max(0, aim.pos.y);
    } else {
      // An empty room still gets the throw. It just goes over the horizon, and
      // the flourish plays out as a visual with nothing on the end of it.
      const far = fl.radius < 0 ? 150 : clamp(fl.radius * 0.6, 60, 190);
      s.tx = s.kx + s.dir * far;
      s.ts = s.ks;
      s.ty = s.ky;
    }
  }

  private updateFlourish(s: Stage): void {
    const vis = this.flVis;
    s.ff = this.flFrame;
    s.ft = clamp(this.flFrame / Math.max(1, this.flDur), 0, 1);

    this.driveFlourishCamera(s);
    this.playFlourishCues();
    if (vis) {
      if (!this.flStruck && s.ft >= vis.strike) {
        this.flStruck = true;
        this.strikeCrowd(s);
      }
      if (vis.tick) vis.tick(s);
    }
  }

  /**
   * The flourish's own cue list, spread across it.
   *
   * Same shape as `playScheduledCues` and for the same reason: the content
   * entry names the sounds, the director owns the clock, and a renderer is left
   * free to add whatever punctuation its own choreography needs on top.
   */
  private playFlourishCues(): void {
    const fl = this.fl;
    if (!fl) return;
    const cues = fl.sfx;
    const n = cues.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const at = n === 1 ? 2 : Math.round(this.flDur * (0.02 + 0.66 * (i / (n - 1))));
      if (this.flFrame === at) this.audio.play(cues[i], { pitch: 1 - i * 0.05, gain: 0.8 });
    }
  }

  /**
   * Everyone hostile, alive, and inside the shape — knocked flat.
   *
   * Damage goes through `Fighter.takeHit`, which is the fight's own route and
   * therefore the only one that gets hitstun, the knockdown, the blood, the
   * dropped weapon and the killer's combo counter all correct at once.
   *
   * The killer, the corpse and anyone on the killer's own team are never in it:
   * friendly fire is not the joke, and a co-op partner standing next to the
   * finish would otherwise be the single most reliable way to lose a life.
   */
  private strikeCrowd(s: Stage): void {
    const fl = this.fl;
    const vis = this.flVis;
    const killer = this.killer;
    if (!fl || !vis || !killer) return;

    const list = this.crowd();
    const caught = this.caught;
    caught.length = 0;

    // 'point' throws are centred on where the trophy lands rather than on the
    // hand that threw it, so a javelin knocks over the man it hit and the two
    // beside him rather than the whole room.
    const point = vis.reach === 'point';
    const cx = point ? s.tx : killer.pos.x;
    const cz = point && this.aim ? this.aim.pos.z : killer.pos.z;
    const r = point ? SPLASH : fl.radius;
    const r2 = r < 0 ? Infinity : r * r;
    // A throw with nothing to throw at landed on nobody, and there is no circle
    // to draw around a target that does not exist.
    const dead = point && !this.aim;

    for (let i = 0; i < list.length && !dead; i++) {
      const f = list[i];
      if (f === killer || f === this.victim) continue;
      if (!f.alive) continue;
      if (f.team === killer.team) continue;

      if (vis.reach === 'lane') {
        // A corridor, not a circle: everything from the killer's toes out to
        // `radius` in the direction they are facing, a third of the belt wide.
        const along = (f.pos.x - killer.pos.x) * s.dir;
        if (along < -14 || (fl.radius >= 0 && along > fl.radius)) continue;
        if (Math.abs(f.pos.z - killer.pos.z) > LANE_DEPTH) continue;
      } else if (r2 !== Infinity) {
        const dx = f.pos.x - cx;
        // Depth weighted into screen terms, or a sweep that looks like it
        // covers the whole belt reaches half of it and vice versa.
        const dz = (f.pos.z - cz) * Z_SCALE;
        if (dx * dx + dz * dz > r2) continue;
      }
      caught.push(f);
    }

    // Stable order regardless of what the provider hands back, so the numbers
    // each hit takes off the shared stream come off it in the same order every
    // time this runs.
    caught.sort(byId);

    const props = this.hitProps;
    props.damage = fl.damage;
    props.hitstun = 26;
    props.blockstun = 12;
    // Zero: the director spends ONE freeze below, sized to the whole crowd.
    // Six guards each asking for their own would stack five nobody earned.
    props.hitstop = 0;
    props.pushback = 0;
    props.reaction = fl.reaction;
    // A flourish is not a move with a start-up you could have read. Guarding it
    // is not the fantasy, and a guard who happened to be holding block through
    // somebody else's death should not be the one left standing.
    props.level = 'unblockable';
    props.chip = 0;
    props.meterGain = 0.015;
    props.meterGainVictim = 0.01;
    props.shake = 0;

    let landed = 0;
    let wet = 0;
    for (let i = 0; i < caught.length; i++) {
      const f = caught[i];
      // Deterministic scatter: the pack does not fall over in formation.
      props.knockback.x = 3.1 + this.rng.range(-0.5, 0.9);
      props.knockback.y = fl.reaction === 'launch' ? 3.4 + this.rng.range(0, 1.2) : 0;
      if (f.takeHit(props, cx, this.sim, killer)) {
        landed++;
        if (!f.mechanical) wet++;
        this.crowdImpact(f);
      }
    }
    caught.length = 0;
    s.caught = landed;

    // Bigger crowd, bigger everything.
    const heft = Math.min(landed, 6);
    // The blow landed on the crowd, not on the spot the victim died on.
    this.hit(
      4 + heft * 2.4,
      14 + heft * 3,
      wet > 0 ? Math.min(wet, 5) * 2 : 0,
      cx,
      (point ? s.ty : s.ky) - 22,
    );
    if (landed > 0) {
      this.fx.slowmo(this.reduced ? 0.55 : 0.1, 5 + heft * 2);
      if (!this.reduced) this.cam.punch(0.05 + heft * 0.02);
      this.fx.aberration(0.4 + heft * 0.25, 10 + heft * 2);
      this.cue(wet > 0 ? 'hit_flesh' : 'hit_metal', 0.8, Math.min(1, 0.5 + heft * 0.12));
      if (landed >= 2) {
        this.fx.text({
          text: `${landed} DOWN`,
          x: killer.pos.x,
          y: 58,
          z: killer.pos.z,
          color: '#ffe14a',
          size: 9 + heft,
          life: 52,
          rise: 0.42,
          style: landed >= 4 ? 'critical' : 'bonus',
        });
      }
    } else if (fl.damage > 0) {
      // Nobody there. The swing still happened, and still moved the air.
      this.cue('whiff', 0.85, 0.6);
    }
  }

  /** Blood off a body, sparks off a chassis, and a frame of white on both. */
  private crowdImpact(f: Fighter): void {
    this.fx.impactFrame(f.id, this.reduced ? 3 : 5);
    const gore = goreMul(this.gore);
    // World angles here, not the stage's: PI/2 is straight up. See `emit`.
    const up = Math.PI * 0.5;
    CROWD_SPEC.x = f.pos.x;
    CROWD_SPEC.y = Math.max(0, f.pos.y) + 16;
    CROWD_SPEC.z = f.pos.z;
    CROWD_SPEC.angle = up;
    CROWD_SPEC.spread = 2.2;
    if (f.mechanical) {
      CROWD_SPEC.count = 10;
      CROWD_SPEC.colors = SPARK_COLORS;
      CROWD_SPEC.shape = 'spark';
      CROWD_SPEC.additive = true;
      CROWD_SPEC.speed[0] = 1.4;
      CROWD_SPEC.speed[1] = 3.8;
      CROWD_SPEC.gravity = 0.22;
      CROWD_SPEC.size[0] = 1.1;
      CROWD_SPEC.size[1] = 1.9;
      CROWD_SPEC.life[0] = 14;
      CROWD_SPEC.life[1] = 26;
    } else if (gore > 0) {
      CROWD_SPEC.count = Math.round(9 * gore);
      CROWD_SPEC.colors = BLOOD_COLORS;
      CROWD_SPEC.shape = 'blood';
      CROWD_SPEC.additive = false;
      CROWD_SPEC.speed[0] = 1.2;
      CROWD_SPEC.speed[1] = 3.4;
      CROWD_SPEC.gravity = 0.34;
      CROWD_SPEC.size[0] = 1.7;
      CROWD_SPEC.size[1] = 2.8;
      CROWD_SPEC.life[0] = 24;
      CROWD_SPEC.life[1] = 40;
    } else {
      // Gore off still needs the hit to read, so it reads as dust.
      CROWD_SPEC.count = 7;
      CROWD_SPEC.colors = DUST_COLORS;
      CROWD_SPEC.shape = 'smoke';
      CROWD_SPEC.additive = false;
      CROWD_SPEC.speed[0] = 0.6;
      CROWD_SPEC.speed[1] = 1.9;
      CROWD_SPEC.gravity = 0.02;
      CROWD_SPEC.size[0] = 2.6;
      CROWD_SPEC.size[1] = 4.2;
      CROWD_SPEC.life[0] = 20;
      CROWD_SPEC.life[1] = 34;
    }
    this.fx.particles(CROWD_SPEC);
  }

  /** The closest thing within `reach` that would rather this had not happened. */
  private nearestHostile(killer: Fighter, reach: number): Fighter | null {
    const list = this.crowd();
    const max = reach < 0 ? Infinity : reach * reach;
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === killer || f === this.victim) continue;
      if (!f.alive || f.team === killer.team) continue;
      const dx = f.pos.x - killer.pos.x;
      const dz = (f.pos.z - killer.pos.z) * Z_SCALE;
      const d = dx * dx + dz * dz;
      if (d > max) continue;
      // Ties broken by id, so two guards standing on the same spot pick the
      // same one on every run.
      if (d < bestD || (d === bestD && best !== null && f.id < best.id)) {
        bestD = d;
        best = f;
      }
    }
    return best;
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
    cam.x = lerp(cam.x, this.targetX + s.pan, this.reduced ? 0.2 : lead);

    // Vertical framing rides on the zoom: all of it at the peak, none of it at
    // the fight's own zoom, so the two arrive together and let go together and
    // there is never a frame of one without the other. See FRAME_FLOOR_Y.
    const k = clamp((zoom - this.savedZoom) / Math.max(0.01, peak - this.savedZoom), 0, 1);
    const floor = Math.max(s.gy, s.ky);
    const framed = floor + this.frameY - VIEW_H * 0.5 - (FRAME_FLOOR_Y - VIEW_H * 0.5) / peak;
    cam.y = lerp(cam.y, (framed - s.lift) * k, this.frame < SLAM_IN ? 0.5 : 0.22);

    // A slow lean into the shot, and whatever the last blow knocked it to.
    this.tiltKick *= TILT_DECAY;
    cam.rotation = this.reduced ? 0 : -s.dir * DUTCH * k + this.tiltKick;
  }

  /**
   * Let go of the close-up, because the crowd is the shot now.
   *
   * The finisher's own zoom-out has already run by the time this takes over, so
   * this only has to keep the framing honest: back at the fight's own zoom, and
   * centred between the killer and whatever they are about to hit.
   */
  private driveFlourishCamera(s: Stage): void {
    const cam = this.cam;
    cam.zoom = lerp(cam.zoom, this.savedZoom * FLOURISH_ZOOM, this.reduced ? 0.12 : 0.2);
    const mid = (s.kx + s.tx) * 0.5;
    const want = clamp(mid, s.kx - 110, s.kx + 110) - VIEW_W * 0.5;
    cam.x = lerp(cam.x, want, this.reduced ? 0.1 : 0.16);
    // The fight's framing is level and unlifted; get back to it.
    cam.y = lerp(cam.y, 0, 0.22);
    this.tiltKick *= TILT_DECAY;
    cam.rotation = this.reduced ? 0 : lerp(cam.rotation, 0, 0.2) + this.tiltKick * 0.5;
  }

  /**
   * Spread the def's cue list across the first two thirds of the film.
   *
   * These, and whatever the renderer plays from its own `tick`, are the whole
   * soundtrack of a finisher — the director adds nothing of its own. It did,
   * briefly: a boom on the stop, a sting on the title card and one big hit
   * under every killing blow, the same three sounds on all forty-seven films.
   * Every one of those films already has a sound written for exactly that
   * moment, and a stock one laid over it only makes them all sound alike.
   */
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

  /**
   * A visual asking for weight: shake, a wet lens if it earned it, and — from
   * BEAT_FROM up — a beat of the film itself.
   *
   * `sx`/`sy` are where on screen the blow landed, for the impact star. Left
   * out, it is the victim's chest, which is where most of the book hits.
   */
  hit(mag: number, frames = 12, splat = 0, sx?: number, sy?: number): void {
    this.fx.shake({ magnitude: mag, duration: frames });
    if (splat > 0) this.splatter(splat);
    if (mag >= BEAT_FROM) this.beat(mag, sx, sy);
  }

  /**
   * What a hard blow does to the film: the picture holds, the camera is
   * knocked off its lean, and an ink star goes up where it landed. The hardest
   * ones — the frame somebody actually dies on — also drain the colour out of
   * the shot and pull the focus lines in.
   *
   * Every finisher in the book calls `hit` on its big moments, so this is the
   * one place that had to change for all of them to get heavier at once.
   */
  private beat(mag: number, sx?: number, sy?: number): void {
    const s = this.stage;
    const kill = mag >= BEAT_KILL;

    const want = Math.min(HOLD_MAX, Math.round(2 + (mag - BEAT_FROM) * 0.85));
    const add = Math.min(Math.max(0, want - this.hold), this.holdBudget);
    this.hold += add;
    this.holdBudget -= add;

    // The star is asked for in world terms; the stage thinks in screen ones.
    const px = sx ?? s.vx;
    const py = sy ?? s.vy - s.vh * 0.55;
    this.fx.impactLines(px, s.gy - py, s.vz, s.dir, kill ? 2.6 : 1.4);
    this.fx.flash('#ffffff', 2, this.reduced ? 0.08 : kill ? 0.42 : 0.2);
    this.fx.aberration(0.25 + mag * 0.05, 8 + Math.round(mag));

    if (!this.reduced) {
      this.cam.punch(0.025 + mag * 0.006);
      // Knocked the way the blow went, and a little further each time it is big.
      this.tiltKick = s.dir * (0.012 + mag * 0.0024);
    }
    if (kill) {
      this.fx.fatalityGrade(28, 0.8);
      this.fx.slowmo(this.reduced ? 0.7 : 0.38, 12);
      if (!this.reduced) this.focus = FOCUS_FRAMES;
    }
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
    this.drawVeil(ctx, cam, s);
    ctx.save();
    if (this.inFlourish && this.flVis) this.flVis.draw(s);
    else this.vis.draw(s);
    ctx.restore();
  }

  /**
   * The room goes dark and the two of them do not.
   *
   * Drawn after the map and before the performance, so it falls on everything
   * that is NOT the finisher — the set, the props, the six guards waiting their
   * turn — and leaves a pool of light on the floor under the pair. It is one
   * gradient fill, and it does more for "this is the shot" than the zoom does:
   * a busy factory floor behind a spine being pulled out is a lot of picture
   * competing with the only part of it that matters.
   *
   * Gone by the time the follow-through starts, because the crowd is the shot
   * then and has to be seen.
   */
  private drawVeil(ctx: C2D, cam: Camera, s: Stage): void {
    if (this.inFlourish) return;
    const k =
      easeOut(clamp(this.frame / 10, 0, 1)) * (1 - clamp((this.frame - (s.dur - 18)) / 18, 0, 1));
    if (k <= 0.01) return;
    const cx = s.mx + s.pan;
    const cy = s.gy - 30 - s.lift;
    const g = ctx.createRadialGradient(cx, cy, 34, cx, cy, 210);
    g.addColorStop(0, `rgba(7,6,11,${(VEIL_CORE * k).toFixed(3)})`);
    g.addColorStop(1, `rgba(7,6,11,${(VEIL * k).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = g;
    // Everything the camera could be showing, and then some: cheaper than
    // working the visible rectangle back out through a zoom, a lift and a roll.
    ctx.fillRect(cam.x - VIEW_W, -VIEW_H, VIEW_W * 3, VIEW_H * 3);
    ctx.restore();
  }

  /** Screen-space layer: letterbox, title card, lens splatter. */
  renderOverlay(ctx: C2D): void {
    if (!this._active || !this.def) return;
    const s = this.stage;
    const t = s.t;

    // Measured across the WHOLE show — finisher plus follow-through — so the
    // bars do not retract on the finisher's last frame and then slam back in
    // for the second act.
    const shown = this.showFrame;
    const total = this.showDur;
    const inK = easeOut(clamp(shown / BAR_IN, 0, 1));
    const outK = 1 - easeIn(clamp((shown - (total - 14)) / 14, 0, 1));
    const bar = BAR_H * inK * outK;
    // Under the bars, so the lines run out from behind the frame of the shot.
    if (this.focus > 0) this.drawFocus(ctx, this.focus / FOCUS_FRAMES);
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
    if (this.inFlourish) {
      this.drawBanner(ctx, 1, bar);
    } else if (t >= at) {
      this.drawBanner(ctx, clamp((t - at) / Math.max(0.02, 1 - at), 0, 1), bar);
    }
  }

  /**
   * Focus lines: every edge of the frame pointing at the middle of it.
   *
   * The oldest trick in the comic for "LOOK HERE", used twice — on the frame
   * the fight stops, and on the frame somebody dies. Re-dealt every other frame
   * so they flicker like ink rather than sitting there like a sunburst, and off
   * entirely under reduced motion, which is exactly the kind of thing that
   * setting exists to switch off.
   */
  private drawFocus(ctx: C2D, k: number): void {
    const cx = VIEW_W * 0.5;
    const cy = VIEW_H * 0.56;
    const deal = Math.floor(this.focus * 0.5);
    const far = VIEW_W * 0.75;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < FOCUS_LINES; i++) {
      const h = hash(i * 3.7 + deal * 11.3);
      const h2 = hash(i * 9.1 + deal * 5.9);
      const ang = (i / FOCUS_LINES) * TAU + (h - 0.5) * 0.16;
      const near = 96 + h2 * 90 + (1 - k) * 60;
      const w = 0.012 + h * 0.02;
      ctx.globalAlpha = k * (0.1 + h2 * 0.22);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * near, cy + Math.sin(ang) * near);
      ctx.lineTo(cx + Math.cos(ang - w) * far, cy + Math.sin(ang - w) * far);
      ctx.lineTo(cx + Math.cos(ang + w) * far, cy + Math.sin(ang + w) * far);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
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
    // Straddling the top edge of the bottom bar. It used to sit a card's height
    // higher, which is exactly where the camera now puts the floor — and a
    // title drawn across the body it is the title of has hidden its own joke.
    const cy = VIEW_H - bar - 10;

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

    this.drawFlourishTag(ctx, cy);
  }

  /**
   * The follow-through's own name, slammed in UNDER the finisher's card.
   *
   * A second card in the same style would fight the first one for the eye;
   * this is deliberately smaller and hangs off the bottom of it, so it reads as
   * a subtitle to the joke already on screen rather than as a new joke.
   */
  private drawFlourishTag(ctx: C2D, cy: number): void {
    const fl = this.fl;
    if (!fl || !this.inFlourish) return;
    const k = clamp(this.flFrame / 12, 0, 1);
    const slam = this.reduced ? easeOut(k) : easeOutBack(k);
    const name = fl.name;
    const size = name.length > 16 ? 12 : 15;

    ctx.save();
    ctx.translate(VIEW_W * 0.5, cy + 27);
    ctx.scale(clamp(slam, 0.02, 1.15), clamp(slam, 0.02, 1.15));
    ctx.rotate(-0.024);

    ctx.font = `900 ${size}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(name).width + 26;
    ctx.fillStyle = 'rgba(9,7,14,0.82)';
    ctx.fillRect(-w * 0.5, -10, w, 20);
    ctx.fillStyle = '#ffe14a';
    ctx.fillRect(-w * 0.5, 8, w, 1.6);

    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = size * 0.3;
    ctx.strokeStyle = '#3a0206';
    ctx.strokeText(name, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, 0, 0);
    ctx.restore();
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
        // save/restore rather than multiply-and-divide: this factor starts at
        // zero, and dividing an alpha back out by ~0 loses the alpha entirely.
        s.ctx.save();
        s.ctx.globalAlpha *= clamp((age - 0.3) * 1.2, 0, 1);
        capsule(
          s.ctx,
          px - dir * 1, py + s.vh * 0.08,
          px - dir * 2, py + s.vh * 0.08 + s.vh * 0.5 * age,
          s.vh * 0.07,
          '#e6e2ea',
          'none',
        );
        s.ctx.restore();
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

    if (splat >= 1) {
      // He wipes his face. He does not look at what he is wiping off.
      const wipe = seg(t, 0.82, 0.94);
      const p = P(1);
      arms(p, -0.3, 0.4, -1.9 + wipe * 0.6, 1.7);
      hands(p, 0, -0.4);
      spine(p, -0.05, -0.05, 0.05, 0.1);
      legs(p, 0.05, 0.1, -0.05, 0.1);
      kill(s, 0, 0, p);
    } else {
      const kp = splat > 0
        ? poseSmug(1, Math.sin(t * 5))
        : wait > 0
          ? poseStand(1, Math.sin(t * 4))
          : poseSwing(1, release);
      kill(s, 0, 0, kp);
    }

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

// ── PLAYER — the action reel ─────────────────────────────────────────────────
//
// The first thirteen are mostly one beat and a punchline: reach in, take the
// thing, hold it up. These six are choreography — a launch and what happens in
// the air, a barrage and the bill for it, a charge and everything it goes
// through — and they are the ones that use the camera's `lift` and `pan`, since
// a fight scene that never leaves the spot it started on is a tableau.
//
// One rule they all keep: the killer finishes where he started. The fight
// resumes from his real position the frame the film ends, and a performer left
// eighty pixels away would be seen to teleport home.

/** How far up the org chart he goes, in screen pixels. */
const SKIP_HEIGHT = 92;
/** When the three rungs land, as fractions of the film, and what each one is. */
const SKIP_RUNGS: readonly number[] = [0.42, 0.48, 0.54];
const SKIP_TITLES: readonly string[] = ['VP', 'SVP', 'CEO'];

/** 1 on the frame a rung lands, falling to 0 over the next few. */
function rungPulse(t: number): number {
  let k = 0;
  for (const r of SKIP_RUNGS) if (t >= r) k = Math.max(k, 1 - seg(t, r, r + 0.045));
  return k;
}

/** SKIP LEVEL — up the org chart one fist at a time, and back down it in one. */
VISUALS.launch_spike = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const crouch = seg(t, 0.04, 0.14);
    const upper = seg(t, 0.14, 0.19);
    const rise = seg(t, 0.17, 0.34);
    const leap = seg(t, 0.26, 0.38);
    const spike = seg(t, 0.6, 0.64);
    const drop = seg(t, 0.62, 0.67);
    const fall = seg(t, 0.7, 0.78);
    const home = easeInOut(seg(t, 0.9, 0.98));
    const landed = t >= 0.67;
    const jolt = rungPulse(t);

    // Where he is in the air, and where the other man hangs beside him.
    const ax = s.vx + dir * 8;
    const ay = -SKIP_HEIGHT * easeOut(rise) * (1 - easeIn(drop)) - jolt * 5 * (1 - drop);
    const gap = s.vx - s.kx;
    const beside = gap + dir * 8 - dir * s.kh * 0.42;

    drawCrater(s, ax, s.gy, s.vh * 0.55, seg(t, 0.67, 0.72));

    if (landed) {
      bloodPool(s, ax, s.gy, s.vh * 0.5, seg(t, 0.68, 0.9));
      squash(s, ax, s.gy, 1.12, 0.78, () => {
        vict(s, dir * 8, 2, posePlank(0, 1));
      });
    } else if (upper <= 0) {
      vict(s, 0, 0, poseSlump(0, crouch * 0.3));
    } else {
      // Tumbling on the way up, hung out flat for the three rungs, and coming
      // down head first like something dropped off a roof.
      const p = P(0);
      spine(p, -0.3, -0.2, -0.2, -0.4);
      arms(p, -1.4, 0.3, -1.6, 0.4);
      legs(p, 0.5, 0.7, 0.2, 0.9);
      const off = dir * 8 * easeOut(rise) + dir * jolt * 5;
      const turn = dir * (rise * 2.2 + drop * 2.6);
      rolled(s, s.vx + off, s.vy + ay - s.vh * 0.5, turn, () => {
        vict(s, off, ay, p, 1, jolt > 0.6 ? 0.7 : 0);
      });
      if (jolt > 0.05) {
        burst(s.ctx, ax, s.vy + ay - s.vh * 0.5, s.vh * 0.45 * jolt, 9, '#fff3c4', t * 9);
      }
      if (drop > 0 && drop < 1) {
        const y = s.vy + ay - s.vh;
        lineSmear(s, ax - 5, y, ax - 5, y - 46 * drop, 1.8, '#ffffff', 0.5);
        lineSmear(s, ax + 6, y, ax + 6, y - 34 * drop, 1.4, '#ffffff', 0.4);
      }
    }

    let kp: Pose;
    let kdx = 0;
    let kdy = 0;
    if (t < 0.14) {
      // Coiled under it. The whole uppercut is in the legs.
      kp = P(1);
      spine(kp, 0.3 * crouch, 0.2 * crouch, 0, -0.2 * crouch);
      arms(kp, -0.7 * crouch, 1.2 * crouch, -0.9 * crouch, 1.4 * crouch);
      legs(kp, 0.5 * crouch, 1.1 * crouch, 0.4 * crouch, 1.0 * crouch);
      body(kp, 0, -4 * crouch);
      kdx = dir * 5 * crouch;
    } else if (t < 0.26) {
      kp = posePresent(1, 0);
      kdx = dir * 5;
      kdy = -7 * Math.sin(upper * Math.PI);
    } else if (t < 0.6) {
      const up = easeOut(leap);
      kdx = lerp(dir * 5, beside, up);
      kdy = -(SKIP_HEIGHT - 4) * up;
      // Fist, fist, boot. Each one a promotion he did not apply for.
      const boot = t >= SKIP_RUNGS[2];
      kp = boot ? poseKick(1, jolt) : poseThrust(1, 0.35 + jolt * 0.65, 0.3);
    } else if (t < 0.7) {
      kp = poseSwing(1, spike);
      kdx = beside;
      kdy = -(SKIP_HEIGHT - 4);
    } else if (t < 0.78) {
      kp = P(1);
      arms(kp, -2.2, 0.2, -2.1, 0.2);
      legs(kp, 0.5, 0.9, 0.3, 1.1);
      kdx = lerp(beside, gap + dir * 8, fall);
      kdy = -(SKIP_HEIGHT - 4) * (1 - easeIn(fall));
    } else {
      // Standing on the result, then stepping back off it to where he began.
      kp = poseSmug(1, Math.sin(t * 40));
      kdx = lerp(gap + dir * 8, 0, home);
      kdy = lerp(-s.vh * 0.14, 0, home);
    }
    kill(s, kdx, kdy, kp);

    for (let i = 0; i < SKIP_RUNGS.length; i++) {
      const r = SKIP_RUNGS[i];
      const sx = ax + dir * (s.vh * 0.5 + 14);
      shout(s, SKIP_TITLES[i], sx, s.vy - SKIP_HEIGHT - s.vh * 0.3 + i * 5, seg(t, r, r + 0.1), 10, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    // The camera goes up the org chart with them and comes back for the landing.
    s.lift =
      SKIP_HEIGHT * 0.6 * easeInOut(seg(s.t, 0.17, 0.36)) * (1 - easeIn(seg(s.t, 0.6, 0.68)));
    const ax = s.vx + s.dir * 8;
    const ay = s.vy - SKIP_HEIGHT - s.vh * 0.5;
    if (at(0.14)) s.d.cue('whiff', 0.8, 0.7);
    if (at(0.17)) {
      s.d.cue('punch_heavy', 0.8);
      s.d.hit(8, 14, 2);
      dust(s, s.vx, s.gy, 10, 2.4);
    }
    if (at(0.26)) s.d.cue('jump', 1.1, 0.7);
    for (let i = 0; i < SKIP_RUNGS.length; i++) {
      if (!at(SKIP_RUNGS[i])) continue;
      s.d.cue(i === 2 ? 'jump_kick' : 'punch_heavy', 1.1 + i * 0.12, 0.8);
      s.d.hit(4.4 + i * 0.6, 8, i === 2 ? 2 : 0, ax, ay);
      spray(s, ax, ay, 6 + i * 3, -Math.PI * 0.5, 2.2, 2.6);
    }
    if (at(0.6)) s.d.cue('whoosh_big', 1.5, 0.7);
    if (at(0.62)) {
      s.d.cue('punch_heavy', 0.7);
      s.d.hit(7, 12, 3, ax, ay);
    }
    if (at(0.67)) {
      s.d.cue('slam', 0.85);
      s.d.cue('bone_snap', 0.9);
      s.d.hit(12, 26, 8, ax, s.gy - 6);
      dust(s, ax, s.gy, 26, 4.2);
      spray(s, ax, s.gy - 4, 24, -Math.PI * 0.5, 2.6, 4.6);
    }
    if (at(0.78)) {
      s.d.cue('slam', 1.2, 0.8);
      s.d.hit(6.5, 12, 2, ax, s.gy - 8);
      dust(s, ax, s.gy, 12, 2.6);
    }
  },
};

/** How many of them land. Nobody is counting; it is called a hundred anyway. */
const FISTS = 14;

/** ALREADY REDUNDANT — every blow lands now and is felt later, all at once. */
VISUALS.hundred_fists = {
  banner: 0.82,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const step = seg(t, 0.03, 0.12);
    const barrage = t >= 0.12 && t < 0.5;
    const count = seg(t, 0.12, 0.5) * FISTS;
    const turn = seg(t, 0.5, 0.57);
    const snap = seg(t, 0.67, 0.71);
    const cash = seg(t, 0.71, 0.79);
    const fold = seg(t, 0.79, 0.9);

    if (fold > 0) {
      bloodPool(s, s.vx, s.gy, s.vh * 0.6, fold);
      vict(s, 0, 0, poseSprawl(0, easeIn(fold)));
    } else {
      // Rattled where he stands, then perfectly fine, then not.
      const rattle = barrage
        ? jitter(s.seed, s.f) * 1.7
        : cash > 0
          ? jitter(s.seed, s.f * 3) * 3.2 * cash
          : 0;
      const vp = barrage
        ? poseSlump(0, 0.2 + 0.08 * Math.sin(s.f * 1.7))
        : poseStand(0, Math.sin(t * 30));
      const flash = barrage ? ((s.f & 3) === 0 ? 0.45 : 0) : cash * 0.85;
      squash(s, s.vx, s.vy - s.vh * 0.5, 1 + cash * 0.2, 1 + cash * 0.05, () => {
        vict(s, rattle, 0, vp, 1, flash);
      });
    }

    // Where each one went in. They flash as they land, go out, and all come
    // back on together when the bill arrives.
    for (let i = 0; i < FISTS; i++) {
      if (count < i) break;
      const mx = s.vx + jitter(s.seed, i + 7) * s.vh * 0.17;
      const my = s.vy - s.vh * (0.28 + 0.5 * hash(s.seed * 0.013 + i * 3.1));
      const age = count - i;
      if (barrage && age < 1.3) {
        burst(s.ctx, mx, my, s.vh * 0.17 * (1.3 - age), 7, '#fff3c4', i * 1.7);
      } else if (cash > 0 && fold < 0.35) {
        const lit = clamp(cash * FISTS * 1.3 - i, 0, 1);
        if (lit > 0) burst(s.ctx, mx, my, s.vh * 0.22 * lit, 8, '#ffe14a', i + t * 9);
      }
    }

    if (t < 0.5) {
      const beat = barrage ? (s.f % 4) / 4 : 0;
      const reach = barrage ? 0.5 + 0.5 * (1 - beat) : step * 0.45;
      const lunge = step * 5 + (barrage ? (1 - beat) * 2 : 0);
      kill(s, dir * lunge, 0, poseThrust(1, reach, ((s.f >> 2) & 1) * 0.5));
      if (barrage) {
        // The fists the eye cannot keep up with: three more of them, in flight.
        const fromX = s.kx + dir * s.kh * 0.34;
        const fromY = s.ky - s.kh * 0.62;
        const toX = s.vx - dir * s.vh * 0.1;
        for (let g = 0; g < 3; g++) {
          const u = (s.f * 0.37 + g * 0.31) % 1;
          const gx = lerp(fromX, toX, u);
          const gy = fromY + jitter(s.seed, g + s.f) * s.vh * 0.15;
          lineSmear(s, gx - dir * 9, gy, gx, gy, 1.6, '#ffffff', 0.35 * (1 - u));
          ellipse(s.ctx, gx, gy, 2.6, 2.2, 0, s.killer.style.skin, INK, 1);
        }
      }
    } else {
      // Back turned. He is finished; the other man has not been told yet.
      const kp = snap > 0 && snap < 1 ? posePresent(1, 0) : poseSmug(1, Math.sin(t * 30));
      const face = (turn > 0.5 ? -dir : dir) as Facing;
      actor(s, s.killer, s.kx + dir * 5 * (1 - easeInOut(turn)), s.ky, kp, face, s.ks);
    }

    shout(s, '?', s.vx, s.vy - s.vh * 1.18, seg(t, 0.57, 0.69), 12, '#e8e2ff');
    shout(s, 'CLICK', s.kx - dir * 4, s.ky - s.kh * 1.3, seg(t, 0.68, 0.78), 8, '#ffe14a');
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (s.t >= 0.12 && s.t < 0.5 && s.f % 4 === 0) {
      const n = s.f >> 2;
      const my = s.vy - s.vh * (0.3 + 0.45 * hash(n * 2.9));
      s.d.cue('punch_light', 0.9 + (n % 3) * 0.13, 0.55);
      s.d.hit(2.2, 4);
      if (s.mechanical) sparks(s, s.vx, my, 3, s.dir > 0 ? 0 : Math.PI);
      else dust(s, s.vx, my, 2, 1.2);
    }
    if (at(0.5)) s.d.cue('whiff', 1.2, 0.5);
    if (at(0.68)) s.d.cue('ui_select', 1.4, 0.8);
    if (at(0.71) || at(0.735) || at(0.76)) {
      s.d.cue('squelch', 1.1, 0.8);
      s.d.hit(4.5, 6, 2);
      spray(s, s.vx, s.vy - s.vh * 0.5, 9, -Math.PI * 0.5, 2.8, 3.4);
    }
    if (at(0.79)) {
      s.d.cue('bone_snap', 0.9);
      s.d.cue('ko', 0.9, 0.8);
      s.d.hit(11, 24, 9);
      spray(s, s.vx, s.vy - s.vh * 0.55, 34, -Math.PI * 0.5, 3, 5.2);
      dust(s, s.vx, s.gy, 12, 2.4);
    }
    if (at(0.9)) s.d.cue('slam', 1.25, 0.6);
  },
};

/** How high the pair of them go before they come back down as one object. */
const PILE_HEIGHT = 88;

/** BOTTOM LINE — turned over, taken up, and delivered to the floor head first. */
VISUALS.piledriver = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const grab = seg(t, 0.04, 0.14);
    const flip = seg(t, 0.14, 0.26);
    const up = seg(t, 0.26, 0.44);
    const down = seg(t, 0.5, 0.58);
    const planted = t >= 0.58;
    // Held against the chest, half a step in front of him.
    const holdX = s.kx + dir * s.kh * 0.3;

    drawCrater(s, holdX, s.gy, s.vh * 0.5, seg(t, 0.58, 0.63));

    if (!planted) {
      const air = -PILE_HEIGHT * easeOut(up) * (1 - easeIn(down));
      // One full turn between leaving the floor and meeting it again, so they
      // come down exactly as they went up: him upright, the other man not.
      const spin = dir * TAU * easeInOut(seg(t, 0.28, 0.57));
      const cx = lerp(s.vx, holdX, easeInOut(grab));
      rolled(s, holdX, s.ky + air - s.kh * 0.5, spin, () => {
        rolled(s, cx, s.vy + air - s.vh * 0.5, Math.PI * easeInOut(flip) * dir, () => {
          const p = P(0);
          spine(p, 0.2 * grab, 0.1, 0, 0.2);
          arms(p, -0.4 - flip * 1.6, 0.3, -0.5 - flip * 1.5, 0.3);
          legs(p, 0.2 + flip * 0.3, 0.3 + flip * 0.5, -0.1 - flip * 0.2, 0.4 + flip * 0.4);
          actor(s, s.victim, cx, s.vy + air, p, (-dir) as Facing, s.vs);
        });
        kill(s, 0, air, poseThrust(1, 0.5 + grab * 0.5, flip * 0.5));
      });
      if (down > 0) {
        const y = s.ky + air - s.kh;
        lineSmear(s, holdX - 7, y, holdX - 7, y - 44 * down, 1.8, '#ffffff', 0.5);
        lineSmear(s, holdX + 8, y, holdX + 8, y - 30 * down, 1.4, '#ffffff', 0.4);
      }
      return;
    }

    // In to the shoulders. What is left above the floor is a pair of legs and
    // an opinion, and the legs stop first.
    const sink = s.vh * 0.3;
    const twitch = (1 - seg(t, 0.58, 0.84)) * Math.sin(s.f * 0.9);
    clipRect(s, holdX - 80, s.gy - 300, 160, 300, () => {
      rolled(s, holdX, s.gy - s.vh * 0.5 + sink, Math.PI, () => {
        const p = P(0);
        arms(p, -0.3, 0.2, -0.3, 0.2);
        legs(p, 0.25 + twitch * 0.5, 0.4 + twitch * 0.4, -0.2 - twitch * 0.5, 0.5 - twitch * 0.3);
        actor(s, s.victim, holdX, s.gy + sink, p, (-dir) as Facing, s.vs);
      });
    });
    bloodPool(s, holdX, s.gy, s.vh * 0.4, seg(t, 0.62, 0.9));

    // He steps off it, has a look at his work, and goes back to his mark.
    const off = seg(t, 0.58, 0.68);
    const home = easeInOut(seg(t, 0.9, 0.98));
    const kp = off < 1 ? poseReach(1, 0.4) : poseSmug(1, Math.sin(t * 30));
    kill(s, -dir * s.kh * 0.55 * easeOut(off) * (1 - home), -Math.sin(off * Math.PI) * 14, kp);
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    s.lift =
      PILE_HEIGHT * 0.6 * easeInOut(seg(s.t, 0.26, 0.44)) * (1 - easeIn(seg(s.t, 0.5, 0.6)));
    const x = s.kx + s.dir * s.kh * 0.3;
    if (at(0.06)) s.d.cue('grunt', 0.9);
    if (at(0.14)) s.d.cue('whoosh_big', 1.3, 0.7);
    if (at(0.26)) {
      s.d.cue('jump', 0.9);
      dust(s, s.kx, s.gy, 10, 2.2);
    }
    if (at(0.5)) s.d.cue('whoosh_big', 0.9);
    if (at(0.58)) {
      s.d.cue('slam', 0.8);
      s.d.cue('bone_snap', 0.85);
      s.d.hit(12.5, 28, 9, x, s.gy - 6);
      dust(s, x, s.gy, 28, 4.4);
      spray(s, x, s.gy - 3, 26, -Math.PI * 0.5, 2.4, 5);
    }
    if (at(0.68)) s.d.cue('land', 1.1, 0.6);
    if (at(0.84)) s.d.cue('drop', 0.8, 0.5);
  },
};

/** How far back each rollback carries the pair of them. */
const SUPLEX_STEP = 26;
const SUPLEX_STARTS: readonly number[] = [0.06, 0.28, 0.5];
const SUPLEX_LEN = 0.22;
/** How far through one suplex the other man meets the floor. */
const SUPLEX_HIT = 0.55;
/** A little past flat: enough to put the back of a head into the concrete. */
const SUPLEX_ARC = 1.72;
/** Each one lands harder than the last. The third is the one that sticks. */
const SUPLEX_WEIGHT: readonly number[] = [7.5, 8.5, 11.5];

/** When suplex `n` lands, as a fraction of the film. */
function suplexHit(n: number): number {
  return SUPLEX_STARTS[n] + SUPLEX_LEN * SUPLEX_HIT;
}

/**
 * ROLLBACK — the same suplex three times, rewound between takes.
 *
 * The rewind is the joke and also the solution: a real suplex leaves both men
 * on the floor, and getting them back up three times would be three getting-up
 * animations nobody wants to watch. So the first two simply run backwards.
 */
VISUALS.suplex_chain = {
  banner: 0.8,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    let i = 0;
    for (let n = 0; n < SUPLEX_STARTS.length; n++) if (t >= SUPLEX_STARTS[n]) i = n;
    const last = i === SUPLEX_STARTS.length - 1;
    const u = seg(t, SUPLEX_STARTS[i], SUPLEX_STARTS[i] + SUPLEX_LEN);
    const out = easeIn(seg(u, 0.2, SUPLEX_HIT));
    // A breath on the floor, then back up the way it came.
    const back = easeInOut(seg(u, SUPLEX_HIT + 0.1, 1));
    const home = easeInOut(seg(t, 0.84, 0.96));
    const down = last && u >= SUPLEX_HIT;
    const hug = s.kh * 0.3;

    const base = lerp(s.kx - dir * SUPLEX_STEP * (i + back), s.kx, home);
    const vBase = down ? s.kx - dir * SUPLEX_STEP * i : base;
    // The first clinch has to be walked into; after that he never gets out of it.
    const clinch = easeInOut(seg(t, 0, SUPLEX_STARTS[0] + SUPLEX_LEN * 0.18));
    const vx = lerp(s.vx, vBase + dir * hug, clinch);
    const kAng = -dir * SUPLEX_ARC * out * (1 - back);
    const vAng = down ? -dir * SUPLEX_ARC * 1.06 : kAng * 1.06;

    // One dent per landing, each a step further back than the one before.
    for (let n = 0; n <= i; n++) {
      const x = s.kx - dir * (SUPLEX_STEP * n + s.vh * 0.95);
      drawCrater(s, x, s.gy, s.vh * (0.3 + n * 0.08), seg(t, suplexHit(n), suplexHit(n) + 0.05));
    }
    if (down) dustPool(s, vBase - dir * s.vh * 0.9, s.gy, s.vh * 0.42, seg(t, suplexHit(i), 0.92));

    rolled(s, vBase, s.ky, vAng, () => {
      const flash = out > 0.95 && back <= 0 && !down ? 0.6 : 0;
      const vp = poseSlump(0, (0.5 + out * 0.4) * clinch);
      actor(s, s.victim, vx, lerp(s.vy, s.ky, clinch) - out * 3, vp, (-dir) as Facing, s.vs, 1, flash);
    });
    rolled(s, base, s.ky, kAng, () => {
      const kp = t >= 0.74 ? poseSmug(1, Math.sin(t * 30)) : poseThrust(1, down ? 0.2 : 1, out * 0.4);
      actor(s, s.killer, base, s.ky, kp, dir, s.ks);
    });

    // The tape running backwards.
    if (!last && back > 0 && back < 1) {
      for (let g = 0; g < 4; g++) {
        const y = s.ky - s.kh * (0.2 + g * 0.28);
        const x = base + dir * (10 + hash(g * 3.1 + s.f) * 30);
        lineSmear(s, x, y, x + dir * 22, y, 0.9, NEON, 0.4 * Math.sin(back * Math.PI));
      }
    }
    for (let n = 0; n < SUPLEX_STARTS.length; n++) {
      const x = s.kx - dir * (SUPLEX_STEP * n + s.vh * 0.5);
      const k = seg(t, suplexHit(n) + 0.02, suplexHit(n) + 0.13);
      shout(s, n === 2 ? 'STILL BROKEN' : `ROLLBACK ${n + 1}`, x, s.ky - s.kh * 1.45, k, n === 2 ? 9 : 8, n === 2 ? '#ffe14a' : NEON);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    let i = 0;
    for (let n = 0; n < SUPLEX_STARTS.length; n++) if (s.t >= SUPLEX_STARTS[n]) i = n;
    const u = seg(s.t, SUPLEX_STARTS[i], SUPLEX_STARTS[i] + SUPLEX_LEN);
    const back = easeInOut(seg(u, SUPLEX_HIT + 0.1, 1));
    // The camera backs up with them, and comes home when he does.
    s.pan = -s.dir * SUPLEX_STEP * (i + back) * 0.9 * (1 - easeInOut(seg(s.t, 0.84, 0.96)));

    for (let n = 0; n < SUPLEX_STARTS.length; n++) {
      if (at(SUPLEX_STARTS[n] + SUPLEX_LEN * 0.18)) s.d.cue(n === 0 ? 'grunt' : 'whiff', 0.9 + n * 0.1);
      if (!at(suplexHit(n))) continue;
      const x = s.kx - s.dir * (SUPLEX_STEP * n + s.vh * 0.95);
      s.d.cue('slam', 1.1 - n * 0.1);
      s.d.hit(SUPLEX_WEIGHT[n], 14 + n * 5, 0, x, s.gy - 6);
      dust(s, x, s.gy, 12 + n * 7, 2.6 + n * 0.7);
      if (n === 2) {
        s.d.cue('bone_snap', 0.9);
      } else {
        // The tape, spooling back.
        s.d.cue('ui_back', 1.3, 0.6);
      }
    }
  },
};

/** How high the pane hangs over the floor. */
const CEILING = 80;
const CEILING_HALF = 74;
const GLASS = ['#dff3ff', '#9fd8ff', '#ffffff'];

/** GLASS CEILING — he finally got through it. Most of the way. */
VISUALS.glass_ceiling = {
  banner: 0.6,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const ctx = s.ctx;
    const slide = easeOut(seg(t, 0.03, 0.18));
    const crouch = seg(t, 0.14, 0.24);
    const launch = seg(t, 0.24, 0.33);
    const through = t >= 0.33;
    const drop = seg(t, 0.36, 0.48);
    const limp = seg(t, 0.4, 0.75);
    const shoe = seg(t, 0.62, 0.74);
    const home = easeInOut(seg(t, 0.9, 0.98));
    const paneY = s.gy - CEILING;
    // How much of him ends up on the executive floor: head and shoulders.
    const stuck = -(CEILING + s.vh * 0.42 - s.vh);

    if (!through) {
      const look = seg(t, 0.06, 0.2);
      const p = P(0);
      spine(p, -0.1 * look, -0.12 * look, -0.35 * look, -0.6 * look);
      arms(p, -0.3 - launch * 1.6, 0.4, -0.25 - launch * 1.7, 0.4);
      legs(p, 0.05 + launch * 0.3, 0.12 + launch * 0.5, -0.05, 0.12 + launch * 0.6);
      vict(s, 0, stuck * easeIn(launch), p, 1, launch > 0 && launch < 0.3 ? 0.6 : 0);
    } else {
      // Kicking, then not. The view from below is all anybody down here gets.
      const k = (1 - limp) * Math.sin(s.f * 0.8);
      const p = P(0);
      arms(p, -2.2, 0.2, -2.3, 0.2);
      legs(p, 0.3 + k * 0.7, 0.4 + k * 0.3, -0.2 - k * 0.7, 0.3 - k * 0.2);
      vict(s, 0, stuck + Math.sin(s.f * 0.2) * 0.6 * (1 - limp), p);
    }

    // The pane, on two cables, and after him a pane with a man-shaped opinion in it.
    ctx.save();
    ctx.globalAlpha *= slide;
    const y = paneY - 40 * (1 - slide);
    const x0 = s.vx - CEILING_HALF;
    const x1 = s.vx + CEILING_HALF;
    capsule(ctx, x0 + 8, y - 70, x0 + 8, y, 0.7, STEEL_DARK, 'none');
    capsule(ctx, x1 - 8, y - 70, x1 - 8, y, 0.7, STEEL_DARK, 'none');
    if (!through) {
      roundRect(ctx, x0, y - 3, CEILING_HALF * 2, 5, 1, 'rgba(159,216,255,0.36)', GLASS[0], 1);
    } else {
      const hole = s.vh * 0.2;
      roundRect(ctx, x0, y - 3, CEILING_HALF - hole, 5, 1, 'rgba(159,216,255,0.36)', GLASS[0], 1);
      roundRect(ctx, s.vx + hole, y - 3, CEILING_HALF - hole, 5, 1, 'rgba(159,216,255,0.36)', GLASS[0], 1);
      for (let i = 0; i < 6; i++) {
        const side = i & 1 ? 1 : -1;
        const len = 14 + hash(i * 4.7) * 26;
        zigzag(ctx, s.vx + side * hole, y, s.vx + side * (hole + len), y + (hash(i * 2.2) - 0.5) * 3, 1.4, 4, GLASS[0], 0.8);
      }
    }
    label(s, 'L7 EXECUTIVE', x1 - 6, y - 10, 4.5, GLASS[0], 'right', '700');
    ctx.restore();

    const gap = s.vx - s.kx - dir * s.kh * 0.3;
    const jump = Math.max(8, CEILING - s.kh * 1.28);
    let kp: Pose;
    let kdy = 0;
    if (t < 0.24) {
      kp = P(1);
      spine(kp, 0.3 * crouch, 0.2 * crouch, 0, -0.3 * crouch);
      arms(kp, -0.7 * crouch, 1.2 * crouch, -0.9 * crouch, 1.4 * crouch);
      legs(kp, 0.5 * crouch, 1.1 * crouch, 0.4 * crouch, 1.0 * crouch);
      body(kp, 0, -4 * crouch);
    } else if (t < 0.36) {
      kp = posePresent(1, 0);
      kdy = -jump * easeOut(launch);
    } else if (t < 0.48) {
      kp = poseReach(1, 0.2);
      kdy = -jump * (1 - easeIn(drop));
    } else {
      // Looking up at it. Then the shoe arrives.
      const bonk = seg(t, 0.74, 0.86);
      kp = shoe >= 1 ? poseSlump(1, 0.3 * Math.sin(bonk * Math.PI)) : poseReach(1, 0.5);
    }
    const kdx = gap * easeOut(seg(t, 0.14, 0.24)) * (1 - home);
    kill(s, kdx, kdy, kp);

    if (shoe > 0) {
      // One shoe, off one foot, onto the one person standing under it.
      const headY = s.ky - s.kh * 1.04;
      const fromY = s.vy + stuck;
      const bounce = seg(t, 0.74, 0.84);
      const sx = lerp(s.vx, s.kx + kdx, shoe) + dir * bounce * 16;
      const sy = shoe < 1 ? lerp(fromY, headY, easeIn(shoe)) : lerp(headY, s.gy - 3, easeIn(bounce)) - Math.sin(bounce * Math.PI) * 12;
      rolled(s, sx, sy, shoe * 5 + bounce * 4, () => {
        roundRect(ctx, sx - 4, sy - 2, 8, 4, 1.6, '#2a2530', INK, 1.1);
      });
      shout(s, 'BONK', s.kx + kdx, headY - 12, seg(t, 0.74, 0.86), 8, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    const paneY = s.gy - CEILING;
    // Up just far enough to keep his head in shot above the pane, and no
    // further: the man standing under it has to stay in the picture too.
    s.lift = 12 * easeInOut(seg(s.t, 0.1, 0.3)) * (1 - seg(s.t, 0.92, 1));
    if (at(0.03)) s.d.cue('ui_move', 0.7, 0.5);
    if (at(0.24)) {
      s.d.cue('jump', 0.9);
      s.d.cue('punch_heavy', 0.8);
      s.d.hit(8, 14, 2);
      dust(s, s.vx, s.gy, 10, 2.4);
    }
    if (at(0.33)) {
      s.d.cue('glass', 1);
      s.d.cue('hit_flesh', 0.8);
      s.d.hit(10.5, 22, 0, s.vx, paneY);
      emit(s, s.vx, paneY, 28, Math.PI * 0.5, 2.6, 1, 4.2, GLASS, 'shard', 0.3, 2.6, 64);
    }
    if (at(0.48)) s.d.cue('land', 1, 0.6);
    if (at(0.74)) {
      s.d.cue('drop', 1.4, 0.7);
      s.d.hit(2, 4);
    }
  },
};

/** How far the charge carries, and where along it each partition stands. */
const PLAN_RUN = 150;
const PLAN_WALLS: readonly number[] = [0.3, 0.55, 0.8];
/** The charge itself, as fractions of the film. */
const PLAN_FROM = 0.24;
const PLAN_TO = 0.6;
const PLAN_WEIGHT: readonly number[] = [7, 8, 9.5];
const PARTITION = ['#8d93a0', '#5f6673', '#c9cfd9', '#3f8f86'];

/** When partition `n` is gone through, as a fraction of the film. */
function planCrash(n: number): number {
  return PLAN_FROM + (PLAN_TO - PLAN_FROM) * PLAN_WALLS[n];
}

/** OPEN PLAN — three partitions, one shoulder, and a man used as the door. */
VISUALS.wall_run = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const ctx = s.ctx;
    const wind = seg(t, 0.04, 0.16);
    const dash = easeIn(seg(t, 0.16, 0.24));
    const run = seg(t, PLAN_FROM, PLAN_TO);
    const skid = seg(t, PLAN_TO, 0.66);
    const fly = seg(t, PLAN_TO, 0.74);
    const back = easeInOut(seg(t, 0.78, 0.96));
    const contact = s.vx - s.kx - dir * s.kh * 0.34;

    // The partitions: up out of the floor while he paws the ground, and then
    // in two pieces each, the top one travelling.
    for (let n = 0; n < PLAN_WALLS.length; n++) {
      const x = s.vx + dir * (PLAN_RUN * PLAN_WALLS[n] + 14);
      const h = 62 * easeOut(wind);
      const q = seg(t, planCrash(n), planCrash(n) + 0.16);
      if (q <= 0) {
        roundRect(ctx, x - 3, s.gy - h, 6, h, 1, PARTITION[0], INK, 1.3);
        roundRect(ctx, x - 2, s.gy - h + 3, 4, Math.max(0, h * 0.5), 1, PARTITION[3], 'none');
      } else {
        roundRect(ctx, x - 3, s.gy - 13, 6, 13, 1, PARTITION[1], INK, 1.3);
        // Two and a half turns: it lands flat, a step past where it stood.
        const px = x + dir * 54 * easeOut(q);
        const py = s.gy - 38 - Math.sin(q * Math.PI) * 30 + easeIn(q) * 35;
        rolled(s, px, py, dir * q * Math.PI * 2.5, () => {
          roundRect(ctx, px - 3, py - 24, 6, 48, 1, PARTITION[0], INK, 1.3);
        });
      }
    }

    // Him: a step back, a sprinter's lean, and then nothing but shoulder.
    const stride = Math.sin(s.f * 0.9);
    let kdx: number;
    let kp: Pose;
    if (t < 0.16) {
      kdx = -dir * 10 * wind;
      kp = P(1);
      tilt(kp, 0.28 * wind);
      arms(kp, 0.6 * wind, 1.2 * wind, -0.5 * wind, 1.1 * wind);
      legs(kp, 0.5 * wind, 0.9 * wind, -0.5 * wind, 0.5 * wind);
      body(kp, 0, -3 * wind);
    } else if (t < 0.66) {
      kdx = lerp(-dir * 10, contact, dash) + dir * PLAN_RUN * run;
      kp = P(1);
      tilt(kp, 0.5 - skid * 0.75);
      arms(kp, 0.9, 1.5, 0.8, 1.4);
      legs(kp, 0.8 * stride, 0.6 + 0.5 * stride, -0.8 * stride, 0.6 - 0.5 * stride);
    } else if (t < 0.78) {
      kdx = contact + dir * PLAN_RUN;
      kp = poseSmug(1, Math.sin(t * 34));
    } else {
      // The walk back through the gaps he has just made.
      kdx = (contact + dir * PLAN_RUN) * (1 - back);
      kp = back < 1 ? P(1) : poseSmug(1, Math.sin(t * 34));
      if (back < 1) {
        arms(kp, 0.4 * stride, 0.3, -0.4 * stride, 0.3);
        legs(kp, 0.45 * stride, 0.2 + 0.2 * stride, -0.45 * stride, 0.2 - 0.2 * stride);
      }
    }
    const face = (t >= 0.78 && back < 1 ? -dir : dir) as Facing;
    actor(s, s.killer, s.kx + kdx, s.ky, kp, face, s.ks);
    if (run > 0 && run < 1) {
      for (let g = 0; g < 3; g++) {
        const y = s.ky - s.kh * (0.3 + g * 0.3);
        lineSmear(s, s.kx + kdx - dir * (14 + g * 5), y, s.kx + kdx - dir * (40 + g * 9), y, 1.1, '#ffffff', 0.35);
      }
    }

    // The other man: folded over the shoulder for the whole trip, and then
    // let go of, which at that speed is the same as being thrown.
    if (dash < 1) {
      vict(s, 0, 0, poseReach(0, wind * 0.6));
    } else if (fly <= 0) {
      let flash = 0;
      for (let n = 0; n < PLAN_WALLS.length; n++) {
        if (t >= planCrash(n)) flash = Math.max(flash, 1 - seg(t, planCrash(n), planCrash(n) + 0.03));
      }
      vict(s, dir * PLAN_RUN * run, -s.kh * 0.22, poseSlump(0, 1), 1, flash * 0.8);
    } else if (fly < 1) {
      const u = easeOut(fly);
      const x = s.vx + dir * (PLAN_RUN + u * 300);
      const y = s.vy - s.kh * 0.22 - Math.sin(u * Math.PI) * 26;
      rolled(s, x, y - s.vh * 0.5, dir * fly * 9, () => {
        actor(s, s.victim, x, y, poseSlump(0, 1), (-dir) as Facing, s.vs, clamp(1.4 - fly * 1.4, 0, 1));
      });
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    const dir = s.dir;
    // The camera runs with them, and walks back with him.
    s.pan =
      dir * PLAN_RUN * 0.8 * easeInOut(seg(s.t, 0.2, PLAN_TO)) * (1 - easeInOut(seg(s.t, 0.78, 0.96)));
    if (at(0.05) || at(0.11)) {
      s.d.cue('dash', 0.8, 0.6);
      dust(s, s.kx, s.gy, 5, 1.6);
    }
    if (at(0.16)) s.d.cue('dash', 1.1);
    if (at(0.24)) {
      s.d.cue('punch_heavy', 0.8);
      s.d.hit(7, 12, 2);
    }
    for (let n = 0; n < PLAN_WALLS.length; n++) {
      if (!at(planCrash(n))) continue;
      const x = s.vx + dir * (PLAN_RUN * PLAN_WALLS[n] + 14);
      s.d.cue('crash', 1.1 - n * 0.07);
      s.d.hit(PLAN_WEIGHT[n], 12 + n * 4, 0, x, s.gy - 34);
      emit(s, x, s.gy - 34, 14 + n * 4, dir > 0 ? 0 : Math.PI, 1.6, 1.6, 5, PARTITION, 'shard', 0.28, 3, 54);
    }
    if (at(PLAN_TO)) {
      s.d.cue('tyres', 1.2, 0.6);
      dust(s, s.vx + dir * PLAN_RUN, s.gy, 12, 2.4);
    }
    if (at(0.74)) {
      s.d.cue('crash', 0.8, 0.6);
      s.d.hit(5, 12);
    }
  },
};

// ── ENEMY — the damage type is humiliation ───────────────────────────────────

/** Where a fighter's mouth is, near enough, on both skeletons. */
function mouthX(s: Stage): number {
  return s.kx + s.dir * s.kh * 0.11;
}
function mouthY(s: Stage): number {
  return s.ky - s.kh * 0.87;
}

/**
 * HAT TRICK — he takes the hat and he EATS it.
 *
 * This one is the whole brief in miniature and it is allowed to be slow. The
 * beats that make it work are the ones with no violence in them at all: the
 * reach, the chewing, the swallow travelling down the neck, and the small
 * satisfied belch afterwards. The dwarf is not killed. He is bareheaded, in
 * public, and that turns out to be enough.
 */
VISUALS.hat_eat = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const snatch = seg(t, 0.04, 0.14);
    const reach = seg(t, 0.14, 0.3);
    const raise = seg(t, 0.3, 0.38);
    const chew = seg(t, 0.38, 0.6);
    const gulp = seg(t, 0.6, 0.7);
    const belch = seg(t, 0.72, 0.82);
    const die = seg(t, 0.82, 1);
    const dir = s.dir;

    // The eater. Head tips back for the last of it, jaw working throughout.
    const kp = P(1);
    const jaw = chew > 0 && chew < 1 ? Math.sin(chew * 46) * 0.16 : 0;
    const back = raise * 0.5 - gulp * 0.2;
    spine(kp, -0.06 - back * 0.2, -0.05, -0.2 * back + jaw * 0.3, -0.45 * back + jaw);
    arms(
      kp,
      -0.3,
      0.5,
      snatch > 0 ? lerp(-0.2, -1.55, easeOut(raise + snatch * 0.35)) : 0,
      lerp(0.2, 1.5, easeOut(raise)),
    );
    hands(kp, 0, -0.3);
    legs(kp, 0.05, 0.12, -0.05, 0.12);
    kill(s, 0, 0, kp);

    // The bulge going down. Ridiculous, and the frame it happens on is the one
    // people remember.
    if (gulp > 0 && gulp < 1) {
      const u = easeInOut(gulp);
      const bx = s.kx + dir * s.kh * 0.04;
      const by = lerp(mouthY(s) + 3, s.ky - s.kh * 0.62, u);
      ellipse(s.ctx, bx, by, s.kh * 0.07, s.kh * 0.055, 0, s.killer.style.skin, INK, 1.2);
    }
    if (belch > 0 && belch < 1) {
      shout(s, 'BURP', mouthX(s) + dir * 12, mouthY(s) - 10, belch, 10, '#c8f5d8');
      // One pom-pom scrap escapes, and floats.
      ellipse(
        s.ctx,
        mouthX(s) + dir * (6 + belch * 16),
        mouthY(s) - belch * 22,
        1.8, 1.8, 0,
        s.victim.style.hatColor,
        INK, 0.8,
      );
    }

    // The hat: on the head, in the hand, then in stages, gone.
    if (snatch < 1 || chew < 1) {
      const u = easeOut(snatch);
      const hx = lerp(s.vx, mouthX(s), Math.max(u, chew > 0 ? 1 : 0));
      const hy = lerp(s.vy - s.vh * 1.02, mouthY(s), Math.max(u, chew > 0 ? 1 : 0));
      const bites = Math.floor(chew * 4);
      const left = clamp(1 - bites * 0.25 - (chew >= 1 ? 1 : 0), 0, 1);
      if (left > 0.02) {
        drawLooseHat(
          s.ctx,
          s.victim.style,
          hx + dir * chew * 3,
          hy,
          (0.5 + snatch * 0.9) * dir + Math.sin(t * 18) * 0.05 * chew,
          s.vs * left,
        );
      }
    }

    // The dwarf: reaches for it, does not get it, and folds.
    const vp = P(0);
    hatGone(vp);
    if (die > 0) {
      const k = easeIn(die);
      if (k < 0.55) {
        const kp2 = poseKneel(0, k / 0.55);
        hatGone(kp2);
        vict(s, 0, 0, kp2);
      } else {
        const pp = posePlank(0, (k - 0.55) / 0.45);
        hatGone(pp);
        vict(s, 0, 0, pp);
      }
    } else {
      const up = reach * (1 - raise * 0.4);
      const r = poseReach(0, up);
      hatGone(r);
      body(r, dir * up * 2, up > 0.6 ? Math.abs(Math.sin(t * 20)) * 2 : 0);
      vict(s, 0, 0, r);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.05)) {
      s.d.cue('pickup', 0.9);
      s.victim.damage.hatless = true;
    }
    if (at(0.16)) s.d.cue('grunt', 1.3, 0.5);
    // Four bites, each with its own crunch and a puff of felt.
    for (let i = 0; i < 4; i++) {
      if (at(0.4 + i * 0.05)) {
        s.d.cue('hit_flesh', 1.5 + i * 0.1, 0.45);
        emit(
          s, mouthX(s), mouthY(s), 5, -Math.PI * 0.5, 2.2, 0.6, 1.8,
          [s.victim.style.hatColor, '#f2ecdc'], 'dot', 0.16, 1.6, 30,
        );
      }
    }
    if (at(0.62)) s.d.cue('drop', 0.5, 0.8);
    if (at(0.73)) s.d.cue('laugh', 0.8, 0.7);
    if (at(0.95)) {
      s.d.cue('ko', 0.9);
      s.d.hit(4, 12);
      dust(s, s.vx, s.gy, 10, 1.6);
    }
  },
};

/** ROOF TOSS — the hat goes up. The dwarf does not. */
VISUALS.hat_roof = {
  banner: 0.74,
  draw(s) {
    const t = s.t;
    const snatch = seg(t, 0.04, 0.12);
    const wind = seg(t, 0.12, 0.2);
    const throwK = seg(t, 0.2, 0.28);
    const reach = seg(t, 0.3, 0.66);
    const give = seg(t, 0.7, 0.8);
    const fall = seg(t, 0.82, 1);
    const dir = s.dir;

    const kp = throwK > 0 ? poseSwing(1, throwK) : poseThrust(1, snatch + wind * 0.4, 0.5);
    kill(s, 0, 0, throwK >= 1 ? poseSmug(1, Math.sin(t * 5)) : kp);

    if (throwK < 1) {
      const u = easeOut(Math.max(snatch, throwK));
      const hx = lerp(s.vx, s.kx + dir * s.kh * 0.3, easeOut(snatch));
      const hy = lerp(s.vy - s.vh * 1.02, s.ky - s.kh * 1.3, easeOut(snatch));
      const fx = lerp(hx, hx + dir * 40, easeOut(throwK));
      const fy = lerp(hy, hy - 240, easeIn(throwK));
      drawLooseHat(s.ctx, s.victim.style, fx, fy, t * 14 * dir, s.vs * (1 - u * 0.1));
    } else {
      // The ledge, and the hat on it, exactly as unreachable as it looks.
      const ly = s.gy - s.vh * 3.4;
      roundRect(s.ctx, s.vx - 90, ly, 180, 8, 1, '#3a3f4a', INK, 1.6);
      drawLooseHat(s.ctx, s.victim.style, s.vx + dir * 24, ly, -0.15 * dir, s.vs * 0.9);
    }

    const vp = P(0);
    hatGone(vp);
    if (fall > 0) {
      const pp = posePlank(0, easeIn(fall));
      hatGone(pp);
      vict(s, 0, 0, pp);
    } else {
      const up = reach * (1 - give);
      const hop = up > 0.4 && give < 0.5 ? Math.max(0, Math.sin(t * 26)) * 5 : 0;
      const r = poseReach(0, up);
      hatGone(r);
      body(r, 0, hop);
      // The arm gets a little higher every time, which is the sad bit.
      if (up > 0.3) r.armR_upper!.rot = (r.armR_upper!.rot ?? 0) - 0.15 * Math.sin(t * 13);
      vict(s, 0, -hop, r);
      if (give > 0.2) shout(s, '. . .', s.vx + dir * 16, s.vy - s.vh * 1.3, give, 9, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.05)) {
      s.d.cue('pickup', 0.9);
      s.victim.damage.hatless = true;
    }
    if (at(0.22)) s.d.cue('whiff', 1.2);
    if (at(0.36)) s.d.cue('ui_error', 0.8, 0.4);
    if (at(0.72)) s.d.cue('ui_error', 0.6, 0.5);
    if (at(0.9)) {
      s.d.cue('land', 0.7);
      s.d.hit(5, 14);
      dust(s, s.vx, s.gy, 12, 1.8);
    }
  },
};

/** PERFORMANCE IMPROVEMENT PLAN — beaten with a rolled-up document. */
VISUALS.pip_beating = {
  banner: 0.68,
  draw(s) {
    const t = s.t;
    const produce = seg(t, 0.04, 0.16);
    const beat = seg(t, 0.18, 0.72);
    const dir = s.dir;
    const HITS = 7;
    const phase = beat * HITS;
    const idx = Math.min(HITS - 1, Math.floor(phase));
    const swingK = phase - idx;
    const landing = swingK > 0.55 && beat > 0 && beat < 1;

    kill(s, 0, 0, beat > 0 && beat < 1 ? poseSwing(1, clamp((swingK - 0.2) / 0.6, 0, 1)) : posePresent(1, produce));

    // The document: a rolled tube, held at one end, arriving at a head.
    const hx = s.kx + dir * s.kh * (0.16 + swingK * 0.5);
    const hy = s.ky - s.kh * (1.3 - swingK * 0.5);
    if (produce > 0.2) {
      const ang = (beat > 0 ? lerp(-2.2, 0.4, swingK) : -1.6) * dir;
      const ex = hx + Math.sin(ang) * s.kh * 0.42;
      const ey = hy + Math.cos(ang) * s.kh * 0.42;
      capsule(s.ctx, hx, hy, ex, ey, s.kh * 0.05, PAPER, INK, 1.4);
      ellipse(s.ctx, ex, ey, s.kh * 0.05, s.kh * 0.05, ang, '#d8cdb4', INK, 1);
    }

    const wob = landing ? 1 : 0;
    const vp = P(0);
    const wear = clamp(beat * 1.2, 0, 1);
    spine(vp, 0.25 + wear * 0.5, 0.2 + wear * 0.3, 0.1, 0.3 + wear * 0.4);
    arms(vp, 0.6 + wear * 0.6, 1.4, 0.55 + wear * 0.6, 1.45);
    hands(vp, -0.3, -0.3);
    legs(vp, 0.12, 0.4 + wear * 0.9, -0.1, 0.42 + wear * 0.9);
    hips(vp, 0.2 * wear, 0, -3 * wear);
    head2(vp, 0.4 + wear * 0.3, 0.5 + wear * 0.5);
    if (wob) tilt(vp, 0.12 * dir);
    if (beat >= 1) {
      const pp = posePlank(0, easeIn(seg(t, 0.74, 0.9)));
      vict(s, 0, 0, pp);
    } else {
      vict(s, wob ? -dir * 2 : 0, 0, vp, 1, wob ? 0.35 : 0);
    }
    if (landing) {
      burst(s.ctx, s.vx, s.vy - s.vh * 0.9, s.vh * 0.26, 7, '#fff3c4', idx);
      if (idx === HITS - 1) shout(s, 'THIRTY DAYS', s.vx, s.vy - s.vh * 1.5, 0.4, 8, '#ffe14a');
    }
  },
  tick(s) {
    const HITS = 7;
    const a = 0.18;
    const b = 0.72;
    for (let i = 0; i < HITS; i++) {
      const at = Math.round(s.dur * (a + ((b - a) * (i + 0.62)) / HITS));
      if (s.f === at) {
        s.d.cue('punch_light', 1.3 - i * 0.04, 0.7);
        s.d.hit(3 + i * 0.4, 8);
        emit(
          s, s.vx, s.vy - s.vh * 0.9, 4, -Math.PI * 0.5, 2.4, 0.8, 2.2,
          [PAPER, '#d8cdb4'], 'shard', 0.12, 2.2, 34,
        );
        if (i >= 4) spray(s, s.vx, s.vy - s.vh * 0.88, 5, -Math.PI * 0.5, 2, 2.2);
      }
    }
    if (s.f === Math.round(s.dur * 0.76)) {
      s.d.cue('ko', 0.9);
      s.d.hit(5, 14);
    }
  },
};

/** NON-DISCLOSURE — mouth stapled shut, then flicked over. */
VISUALS.staple_mouth = {
  banner: 0.66,
  draw(s) {
    const t = s.t;
    const grab = seg(t, 0.04, 0.18);
    const staple = seg(t, 0.2, 0.58);
    const flick = seg(t, 0.66, 0.72);
    const topple = seg(t, 0.72, 0.94);
    const dir = s.dir;
    const shots = 3;
    const si = Math.min(shots - 1, Math.floor(staple * shots));
    const sk = staple * shots - si;

    const kp = P(1);
    arms(kp, -0.2, 0.5, flick > 0 ? 1.7 - flick * 0.3 : 1.35 - sk * 0.25, flick > 0 ? 0.1 : 0.5);
    hands(kp, 0, -0.2);
    spine(kp, 0.08, 0.06, 0, 0.04);
    legs(kp, -0.08, 0.12, 0.1, 0.14);
    kill(s, 0, 0, kp);

    const mx = s.vx - dir * s.vh * 0.06;
    const my = s.vy - s.vh * 0.84;
    if (grab > 0.5 && flick <= 0) {
      // The stapler, in hand, at the height of a mouth.
      const sx = lerp(s.kx + dir * s.kh * 0.4, mx + dir * 6, easeOut(clamp(staple * 3, 0, 1)));
      const sy = lerp(s.ky - s.kh * 0.85, my, easeOut(clamp(staple * 3, 0, 1)));
      roundRect(s.ctx, sx - 5, sy - 3, 10, 5, 1.4, '#2f3742', INK, 1.3);
      roundRect(s.ctx, sx - 5, sy - 5 + sk * 1.6, 10, 3, 1.2, STEEL, INK, 1.2);
    }

    const vp = P(0);
    if (topple > 0) {
      const k = easeIn(topple);
      tilt(vp, -1.5 * k);
      body(vp, 2.3 * k, 3 * k);
      arms(vp, -1.4 * k, 0.2, -1.3 * k, 0.2);
      legs(vp, 0.5 * k, 0.3, 0.5 * k, 0.3);
    } else {
      const fear = grab;
      spine(vp, -0.05, -0.05, -0.15 * fear, -0.25 * fear);
      arms(vp, 0.5 * fear, 1.2, 0.45 * fear, 1.2);
      legs(vp, 0.05, 0.2 + fear * 0.2, -0.05, 0.2 + fear * 0.2);
    }
    vict(s, 0, 0, vp, 1, staple > 0 && sk < 0.25 ? 0.4 : 0);

    // The staples stay put. Three of them, in a neat line, because whoever did
    // this has done it before.
    const placed = staple >= 1 ? shots : si + (sk > 0.4 ? 1 : 0);
    for (let i = 0; i < placed; i++) {
      const ox = (i - 1) * s.vh * 0.05;
      const ang = topple > 0 ? -1.5 * easeIn(topple) : 0;
      const px = mx + ox * Math.cos(ang) - (topple > 0 ? easeIn(topple) * s.vh * 0.7 * dir : 0);
      const py = my + ox * Math.sin(ang) + (topple > 0 ? easeIn(topple) * s.vh * 0.62 : 0);
      capsule(s.ctx, px - 1.4, py, px + 1.4, py, 0.7, STEEL, INK, 0.6);
      if (s.gore > 0) ellipse(s.ctx, px + 1.6, py + 1.2, 0.9, 1.4, 0, BLOOD, 'none');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    for (let i = 0; i < 3; i++) {
      if (at(0.24 + i * 0.13)) {
        s.d.cue('hit_metal', 1.6 - i * 0.1, 0.6);
        s.d.cue('grunt', 1.2 + i * 0.1, 0.4);
        s.d.hit(3, 8, 1);
        spray(s, s.vx - s.dir * s.vh * 0.06, s.vy - s.vh * 0.84, 5, -Math.PI * 0.5, 2.4, 1.8);
      }
    }
    if (at(0.67)) s.d.cue('drop', 1.6, 0.4);
    if (at(0.9)) {
      s.d.cue('drop', 0.6);
      s.d.hit(6, 16, 3);
      dust(s, s.vx, s.gy, 12, 2);
    }
  },
};

/** GROOMING POLICY — the beard goes. So does he. */
VISUALS.beard_shave = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const produce = seg(t, 0.04, 0.16);
    const buzz = seg(t, 0.2, 0.62);
    const look = seg(t, 0.66, 0.82);
    const stop = seg(t, 0.84, 1);
    const dir = s.dir;

    const kp = P(1);
    arms(kp, -0.2, 0.5, 1.3 - buzz * 0.15, 0.55);
    hands(kp, 0, -0.25);
    spine(kp, 0.06, 0.05, 0, 0.03);
    legs(kp, -0.06, 0.12, 0.08, 0.14);
    kill(s, 0, 0, buzz >= 1 ? poseSmug(1, Math.sin(t * 6)) : kp);

    const cx = s.vx - dir * s.vh * 0.04;
    const cy = s.vy - s.vh * 0.76;
    if (produce > 0.3 && buzz < 1) {
      // Clippers, doing a job a taser was not designed for.
      const bx = lerp(s.kx + dir * s.kh * 0.4, cx + dir * 5, easeOut(clamp(buzz * 4, 0, 1)));
      const by = lerp(s.ky - s.kh * 0.8, cy + buzz * s.vh * 0.1, easeOut(clamp(buzz * 4, 0, 1)));
      roundRect(s.ctx, bx - 5, by - 2.4, 10, 5, 1.6, '#3a4250', INK, 1.3);
      if (buzz > 0 && buzz < 1) {
        zigzag(s.ctx, bx - dir * 5, by, cx, cy + s.vh * 0.06, 2, 5, '#9fe8ff', 1);
      }
    }

    const vp = P(0);
    const shame = look;
    if (stop > 0) {
      const pp = posePlank(0, easeIn(stop));
      pp.beard!.scale = 0.05;
      vict(s, 0, 0, pp);
    } else {
      spine(vp, 0.05 + shame * 0.3, 0.05 + shame * 0.2, -0.1, 0.15 + shame * 0.35);
      arms(vp, 0.2 + shame * 0.5, 0.9, 0.15 + shame * 0.5, 0.9);
      legs(vp, 0.05, 0.2 + shame * 0.3, -0.05, 0.2 + shame * 0.3);
      // The beard goes in one continuous take.
      vp.beard!.scale = clamp(1 - buzz, 0.05, 1);
      vict(s, 0, 0, vp);
    }
    // The pile on the floor, which he is looking at.
    if (buzz > 0.2) {
      const pile = clamp(buzz, 0, 1);
      ellipse(s.ctx, cx + dir * 2, s.gy - 1, s.vh * 0.16 * pile, s.vh * 0.05 * pile, 0, s.victim.style.hair, INK, 1);
    }
    if (look > 0.2 && stop <= 0) shout(s, '. . .', s.vx + dir * 14, s.vy - s.vh * 1.2, look, 9, '#cfc8e0');
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.2)) s.d.cue('taser', 1.4, 0.5);
    if (s.f > s.dur * 0.2 && s.f < s.dur * 0.62 && s.f % 9 === 0) {
      s.d.cue('taser', 1.7, 0.18);
      emit(
        s, s.vx - s.dir * s.vh * 0.04, s.vy - s.vh * 0.74, 4, -Math.PI * 0.5, 2.6, 0.5, 1.6,
        [s.victim.style.hair, '#8c8078'], 'dot', 0.2, 1.4, 34,
      );
    }
    if (at(0.68)) s.d.cue('ui_error', 0.7, 0.5);
    if (at(0.9)) {
      s.d.cue('drop', 0.7);
      s.d.hit(4, 12);
    }
  },
};

/** ESCORTED FROM THE BUILDING — off frame, and back alone. */
VISUALS.escort_out = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const grab = seg(t, 0.04, 0.16);
    const walk = seg(t, 0.16, 0.5);
    const pause = seg(t, 0.5, 0.62);
    const back = seg(t, 0.62, 0.8);
    const dust2 = seg(t, 0.82, 0.94);
    const dir = s.dir;
    const away = easeInOut(walk) * 240;

    if (walk < 1) {
      // Marched off by the collar, heels dragging two lines in the floor.
      const step = Math.sin(t * 30) * 0.35;
      const kp = P(1);
      arms(kp, -0.2, 0.4, 1.5, 0.3);
      hands(kp, 0, -0.2);
      spine(kp, 0.06, 0.05, 0, 0.04);
      legs(kp, step, 0.2, -step, 0.2);
      kill(s, dir * away, 0, kp);

      const vp = P(0);
      const drag = grab;
      spine(vp, -0.15 * drag, -0.1, 0.2 * drag, 0.35 * drag);
      arms(vp, -1.2 * drag, 0.9, 0.6 * drag, 1.0);
      legs(vp, -0.5 * drag, 0.9 * drag, -0.65 * drag, 1.1 * drag, 0.5, 0.6);
      hips(vp, -0.1 * drag, 0, -1.4 * drag);
      vict(s, dir * away - dir * s.vh * 0.1, -grab * s.vh * 0.06, vp);
      if (drag > 0.5) {
        s.ctx.globalAlpha *= 0.4;
        for (let i = 0; i < 2; i++) {
          const y = s.gy - 1 + i * 2;
          capsule(s.ctx, s.vx + dir * away - dir * 60, y, s.vx + dir * away - dir * s.vh * 0.2, y, 0.7, '#8a8090', 'none');
        }
        s.ctx.globalAlpha /= 0.4;
      }
    } else if (back > 0) {
      // He comes back alone, dusts his hands, straightens his tie.
      const u = easeOut(back);
      const x = lerp(s.kx + dir * 240, s.kx, u);
      const kp = P(1);
      const step = Math.sin(t * 26) * 0.3 * (1 - u);
      if (dust2 > 0) {
        arms(kp, -1.0 + Math.sin(t * 40) * 0.2, 1.3, -1.0 - Math.sin(t * 40) * 0.2, 1.3);
        hands(kp, -0.3, -0.3);
      } else {
        arms(kp, step, 0.2, -step, 0.2);
      }
      legs(kp, step, 0.2, -step, 0.2);
      spine(kp, -0.04, -0.04, 0.02, 0.03);
      kill(s, x - s.kx, 0, kp);
    }
    if (pause > 0.1 && back <= 0) {
      shout(s, '. . .', s.kx + dir * 10, s.ky - s.kh * 1.3, pause, 10, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.06)) s.d.cue('grunt', 0.9);
    if (at(0.54)) {
      s.d.cue('drop', 0.7, 0.7);
      s.d.hit(4, 14);
    }
    if (at(0.58)) s.d.cue('ui_back', 0.9, 0.5);
    if (at(0.84)) dust(s, s.kx, s.ky - s.kh * 0.8, 8, 1.2);
  },
};

/** How many times round he goes before anybody lets go. */
const SPIN_TURNS = 4.5;

/** TEAM BUILDING — the trust fall, performed at altitude, with nobody briefed to catch. */
VISUALS.airplane_spin = {
  banner: 0.76,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const grab = seg(t, 0.04, 0.12);
    const press = seg(t, 0.12, 0.2);
    const spin = seg(t, 0.2, 0.6);
    const fly = seg(t, 0.6, 0.76);
    const ang = spin * spin * TAU * SPIN_TURNS;
    const c = Math.cos(ang);
    // Overhead, at arm's length: where a small man is held by a large one.
    const topY = s.ky - s.kh * 1.12;

    if (spin > 0 && spin < 1) {
      spinDust(s, spin, ang);
      spinBody(s, ang, poseHoist(1, 1));
    } else if (t < 0.2) {
      kill(s, 0, 0, press > 0 ? poseHoist(1, press) : poseThrust(1, grab));
    } else {
      // Empty hands, dusted off. Nothing to see up there any more.
      const done = seg(t, 0.6, 0.68);
      kill(s, 0, 0, done < 1 ? poseHoist(1, 1 - done) : poseSmug(1, Math.sin(t * 38)));
    }

    if (fly <= 0) {
      // Lifted off his feet, turned flat, and then the room goes round.
      const lift = easeInOut(seg(t, 0.06, 0.2));
      const cx = lerp(s.vx, s.kx, lift);
      const cy = lerp(s.vy - s.vh * 0.5, topY, lift);
      const flat = dir * Math.PI * 0.5 * lift * (c >= 0 ? 1 : -1);
      if (spin > 0.1) {
        arcSmear(s, s.kx, topY, s.vh * 0.62, 3.2, ang, ang + 2.4, 2.2, '#ffffff', 0.3 * spin);
      }
      squash(s, cx, cy, spin > 0 ? Math.max(0.28, Math.abs(c)) : 1, 1, () => {
        rolled(s, cx, cy, flat, () => {
          const p = P(0);
          const flail = Math.sin(s.f * 0.7) * spin;
          arms(p, -2.3 + flail * 0.4, 0.15, -2.5 - flail * 0.4, 0.15);
          legs(p, 0.3 + flail * 0.5, 0.3, -0.3 - flail * 0.5, 0.35);
          head2(p, 0.6 * spin, 0.8 * spin);
          actor(s, s.victim, cx, cy + s.vh * 0.5, p, (-dir) as Facing, s.vs);
        });
      });
    } else if (fly < 1) {
      // Released on the upswing. He leaves the shot before he has finished
      // working out which way is down.
      const u = easeOut(fly);
      const x = s.kx + dir * u * 330;
      const y = topY - Math.sin(u * Math.PI * 0.8) * 46;
      lineSmear(s, x - dir * 34, y + 4, x - dir * 8, y, 1.6, '#ffffff', 0.4 * (1 - fly));
      rolled(s, x, y, dir * fly * 14, () => {
        const p = P(0);
        arms(p, -2.3, 0.15, -2.5, 0.15);
        legs(p, 0.6, 0.3, -0.5, 0.35);
        actor(s, s.victim, x, y + s.vh * 0.5, p, (-dir) as Facing, s.vs * (1 - u * 0.25), clamp(1.5 - fly * 1.5, 0, 1));
      });
    }

    shout(s, 'WHEEE', s.kx - dir * (s.vh * 0.6 + 22), topY + 4, seg(t, 0.3, 0.6), 9, '#e8e2ff');
    shout(s, 'NOBODY?', s.kx - dir * 6, s.ky - s.kh * 1.3, seg(t, 0.8, 0.96), 8, '#ffe14a');
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    const spin = seg(s.t, 0.2, 0.6);
    if (at(0.04)) s.d.cue('grunt', 0.8);
    if (at(0.12)) s.d.cue('whiff', 0.7, 0.7);
    // The whoosh comes round faster every time he does.
    if (spin > 0 && spin < 1 && s.f % Math.max(4, Math.round(15 - spin * 11)) === 0) {
      s.d.cue('whiff', 0.8 + spin * 0.8, 0.45);
      if (spin > 0.5) s.d.hit(1.6, 4);
    }
    if (at(0.6)) {
      s.d.cue('whoosh_big', 1.2);
      s.d.hit(5, 10);
    }
    if (at(0.78)) {
      // Somewhere off to the side, something that was not his breaks his fall.
      s.d.cue('crash', 0.9, 0.7);
      s.d.cue('glass', 0.9, 0.6);
      s.d.hit(6.5, 14, 0, s.kx + s.dir * 260, s.ky - 20);
    }
    if (at(0.86)) s.d.cue('ui_back', 0.9, 0.6);
  },
};

/** How far downfield the posts stand, and how tall the bar is. */
const PUNT_POSTS = 128;
const PUNT_BAR = 46;
const POST = '#ffd166';

/** KICKED UPSTAIRS — a lateral move, mostly vertical, and it is good. */
VISUALS.punt = {
  banner: 0.74,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const ctx = s.ctx;
    const back = seg(t, 0.05, 0.25);
    const runUp = easeIn(seg(t, 0.27, 0.41));
    const boot = seg(t, 0.41, 0.46);
    const fly = seg(t, 0.42, 0.74);
    const good = seg(t, 0.72, 0.8);
    const u = easeOut(fly);
    const px = s.vx + dir * PUNT_POSTS;

    // The far upright first: he goes BETWEEN them, so one of them is behind him.
    const rise = easeOut(seg(t, 0.03, 0.2));
    const postH = 112 * rise;
    capsule(ctx, px + dir * 9, s.gy - 6, px + dir * 9, s.gy - 6 - postH, 1.6, POST, INK, 1.2);

    if (fly <= 0) {
      // Set down like a ball: on his knees, seeing stars, facing the wrong way.
      vict(s, 0, 0, poseKneel(0, 1), 1, 0);
      const k = 0.5 + 0.5 * Math.sin(s.f * 0.3);
      star(ctx, s.vx - 7 + k * 14, s.vy - s.vh * 0.92, 2.2, 5, '#ffe14a', 'none');
      star(ctx, s.vx + 7 - k * 14, s.vy - s.vh * 0.98, 1.8, 5, '#ffffff', 'none');
    } else if (fly < 1) {
      // Tucked, end over end, getting smaller. A good clean strike.
      const x = s.vx + dir * u * (PUNT_POSTS + 70);
      const y = s.vy - Math.sin(u * Math.PI * 0.86) * 96 - u * 14;
      const sc = s.vs * (1 - u * 0.3);
      rolled(s, x, y - s.vh * 0.3, dir * fly * 20, () => {
        const p = P(0);
        spine(p, 0.5, 0.4, 0.2, 0.4);
        arms(p, 0.9, 1.6, 0.9, 1.6);
        legs(p, 1.2, 1.9, 1.1, 1.9);
        actor(s, s.victim, x, y, p, (-dir) as Facing, sc, clamp(1.6 - fly * 1.6, 0, 1));
      });
    }

    // Crossbar and the near upright, in front of everything that went through.
    capsule(ctx, px - dir * 9, s.gy, px - dir * 9, s.gy - postH, 1.8, POST, INK, 1.3);
    if (rise > 0.5) {
      capsule(ctx, px - dir * 9, s.gy - PUNT_BAR, px + dir * 9, s.gy - 6 - PUNT_BAR, 1.6, POST, INK, 1.2);
    }

    // Three steps back, a run-up, and a boot that starts behind the hip.
    const stride = Math.sin(s.f * 0.8);
    const start = -dir * 26 * easeInOut(back);
    let kp: Pose;
    let kdx: number;
    if (t < 0.27) {
      kdx = start;
      kp = P(1);
      arms(kp, 0.3 * stride * back, 0.3, -0.3 * stride * back, 0.3);
      legs(kp, -0.4 * stride * back, 0.2, 0.4 * stride * back, 0.25);
    } else if (t < 0.41) {
      kdx = lerp(-dir * 26, 0, runUp);
      kp = P(1);
      tilt(kp, 0.25);
      arms(kp, 0.9 * stride, 0.9, -0.9 * stride, 0.9);
      legs(kp, 0.8 * stride, 0.6 + 0.4 * stride, -0.8 * stride, 0.6 - 0.4 * stride);
    } else if (good <= 0) {
      // Through it, back on two feet, and a hand up to watch it go.
      kdx = 0;
      const watch = seg(t, 0.5, 0.6);
      kp = watch < 1 ? poseKick(1, boot * (1 - watch)) : poseReach(1, 0.35);
    } else {
      // Both arms straight up. Every sport has agreed on what that means.
      kdx = 0;
      kp = poseReach(1, 1);
    }
    kill(s, kdx, 0, kp);

    if (boot > 0 && boot < 1) {
      burst(ctx, s.vx - dir * 4, s.vy - s.vh * 0.3, s.vh * 0.5 * (1 - boot), 9, '#fff3c4', t * 8);
    }
    shout(s, "IT'S GOOD", px, s.gy - PUNT_BAR - 62, seg(t, 0.74, 0.96), 11, '#ffe14a');
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    const dir = s.dir;
    const px = s.vx + dir * PUNT_POSTS;
    // The camera follows the ball, like every broadcast there has ever been.
    const track = easeInOut(seg(s.t, 0.42, 0.66)) * (1 - easeInOut(seg(s.t, 0.86, 0.98)));
    s.pan = dir * PUNT_POSTS * 0.62 * track;
    s.lift = 40 * track;
    if (at(0.07) || at(0.13) || at(0.19)) {
      s.d.cue('land', 1.2, 0.4);
      dust(s, s.kx - dir * 12, s.gy, 3, 1.2);
    }
    if (at(0.27)) s.d.cue('dash', 1);
    if (at(0.41)) s.d.cue('whoosh_big', 1.6, 0.6);
    if (at(0.42)) {
      s.d.cue('jump_kick', 0.8);
      s.d.hit(9.5, 18, 0, s.vx, s.vy - s.vh * 0.3);
      dust(s, s.vx, s.gy, 14, 3);
    }
    if (at(0.72)) {
      s.d.cue('coin', 1.2);
      confetti(s, px, s.gy - PUNT_BAR - 30, 26);
    }
    if (at(0.76)) s.d.cue('coin', 1.5, 0.8);
    if (at(0.8)) s.d.cue('laugh', 1, 0.8);
  },
};

// ── BOSSES ───────────────────────────────────────────────────────────────────

/** CRUNCH — closes the ticket. */
VISUALS.wontfix = {
  banner: 0.62,
  draw(s) {
    const t = s.t;
    const open = seg(t, 0.05, 0.2);
    const read = seg(t, 0.2, 0.4);
    const click = seg(t, 0.44, 0.5);
    const stamp = seg(t, 0.52, 0.6);
    const fade = seg(t, 0.62, 0.86);
    const shut = seg(t, 0.9, 1);
    const dir = s.dir;

    kill(s, 0, 0, click > 0 && click < 1 ? poseThrust(1, 1, 0.9) : poseSmug(1, Math.sin(t * 5)));

    // The dwarf de-renders bottom-up: the floor eats him a band at a time, and
    // he watches it happen.
    const gone = easeInOut(fade);
    const keep = s.vh * (1 - gone) + 2;
    if (gone < 1) {
      clipRect(s, s.vx - 60, s.gy - keep, 120, keep, () => {
        const p = P(0);
        const alarm = read;
        spine(p, -0.1 * alarm, -0.1, -0.2 * alarm, -0.3 * alarm);
        arms(p, 0.6 * alarm, 1.1, 0.55 * alarm, 1.1);
        legs(p, 0.05, 0.2, -0.05, 0.2);
        actor(s, s.victim, s.vx, s.gy, p, (-dir) as Facing, s.vs, 1, click > 0 && click < 1 ? 0.5 : 0);
      });
      if (fade > 0 && fade < 1) {
        emit(
          s, s.vx, s.gy - keep, 3, -Math.PI * 0.5, 2.8, 0.3, 1.2,
          [NEON, '#8be0c8'], 'dot', -0.02, 1.6, 26,
        );
      }
    }

    // The ticket window, hanging in the air where a manager can reach it.
    if (open > 0.02 && shut < 1) {
      const w = 128 * easeOut(open) * (1 - shut);
      const h = 52 * easeOut(open) * (1 - shut);
      const cx = s.vx + dir * 14;
      const cy = s.gy - s.vh * 1.9;
      roundRect(s.ctx, cx - w * 0.5, cy - h * 0.5, w, h, 3, '#182230', INK, 1.8);
      roundRect(s.ctx, cx - w * 0.5, cy - h * 0.5, w, 11, 3, '#22303f', 'none');
      if (w > 60) {
        label(s, 'MF-1937', cx - w * 0.5 + 6, cy - h * 0.5 + 6, 7, '#8be0c8', 'left');
        label(s, 'dwarf keeps hitting me', cx - w * 0.5 + 6, cy - h * 0.5 + 20, 6.5, '#cfe4dd', 'left', '700');
        label(s, 'severity: 1  reporter: security', cx - w * 0.5 + 6, cy - h * 0.5 + 30, 5.5, '#7d8f96', 'left', '700');
        const btn = click > 0 ? '#c0242b' : '#2e4152';
        roundRect(s.ctx, cx + w * 0.5 - 44, cy + h * 0.5 - 15, 38, 11, 2, btn, INK, 1.2);
        label(s, 'CLOSE', cx + w * 0.5 - 25, cy + h * 0.5 - 9.5, 6.5, '#e8f6f2');
      }
      if (stamp > 0) {
        const sc = 1 + (1 - easeOut(stamp)) * 1.8;
        s.ctx.save();
        s.ctx.translate(cx, cy);
        s.ctx.rotate(-0.18);
        s.ctx.scale(sc, sc);
        s.ctx.globalAlpha *= clamp(stamp * 3, 0, 1);
        label(s, 'WONTFIX', 0, 0, 15, '#ff5d5d');
        roundRect(s.ctx, -34, -9, 68, 18, 2, 'none', '#ff5d5d', 1.4);
        s.ctx.restore();
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.06)) s.d.cue('ui_move', 0.9, 0.5);
    if (at(0.45)) s.d.cue('ui_select', 0.8);
    if (at(0.53)) {
      s.d.cue('ui_error', 0.6);
      s.d.hit(4, 12);
    }
    if (at(0.92)) s.d.cue('ui_back', 0.8, 0.6);
  },
};

/** SHIBA INU — takes the leg, trots off with it, tail going the whole time. */
VISUALS.shiba_leg = {
  banner: 0.6,
  draw(s) {
    const t = s.t;
    const crouch = seg(t, 0.04, 0.16);
    const lunge = seg(t, 0.16, 0.24);
    const rip = seg(t, 0.26, 0.36);
    const trot = seg(t, 0.4, 0.78);
    const hop = seg(t, 0.4, 0.66);
    const fall = seg(t, 0.7, 0.9);
    const dir = s.dir;

    // The dog. Low, then forward, then away, and the tail never stops.
    const away = easeInOut(trot) * -dir * 190;
    const dp = P(1);
    const bounce = trot > 0 && trot < 1 ? Math.abs(Math.sin(t * 34)) : 0;
    tilt(dp, 0.5 + crouch * 0.3 - lunge * 0.2);
    body(dp, lunge * 8, -crouch * 4 + bounce * 3);
    arms(dp, 1.1 - lunge * 0.5, 0.9, 1.0 - lunge * 0.5, 0.85);
    legs(dp, 0.7 + bounce * 0.4, 0.9, 0.5 - bounce * 0.4, 0.95, 0.3, 0.3);
    spine(dp, 0.3, 0.2, -0.5 - lunge * 0.3, -0.3);
    kill(s, away + dir * lunge * 14, 0, dp);

    // A tail, because the rig has none and the wag is half the joke.
    const tx = s.kx + away + dir * lunge * 14 - dir * s.kh * 0.42;
    const ty = s.ky - s.kh * 0.62;
    const wag = Math.sin(t * 26) * 0.5;
    capsule(
      s.ctx, tx, ty,
      tx - dir * s.kh * 0.18 + wag * 6, ty - s.kh * 0.26,
      s.kh * 0.075, s.killer.style.hair, INK, 1.4,
    );

    // The leg, in the mouth, going with him.
    if (rip > 0.1) {
      const mx2 = s.kx + away + dir * (lunge * 14 + s.kh * 0.34);
      const my2 = s.ky - s.kh * 0.72;
      const ang = 0.35 * dir + Math.sin(t * 12) * 0.06;
      capsule(
        s.ctx, mx2, my2,
        mx2 + Math.cos(ang) * s.vh * 0.34 * -dir, my2 + Math.sin(ang) * s.vh * 0.34,
        s.vh * 0.06, s.victim.style.tunicColor, INK, 1.4,
      );
      roundRect(s.ctx, mx2 - Math.cos(ang) * 4 - dir * s.vh * 0.34 - 4, my2 + Math.sin(ang) * s.vh * 0.34, 9, 4.5, 1.4, '#2a2530', INK, 1.2);
      drawStump(s, mx2, my2, s.vh * 0.055, ang);
    }

    // The dwarf: one leg, one hop, one conclusion.
    const vp = P(0);
    if (fall > 0) {
      const k = easeIn(fall);
      tilt(vp, -1.45 * k);
      body(vp, 2.2 * k, 3 * k);
      arms(vp, -1.5 * k, 0.3, -1.3 * k, 0.3);
      legs(vp, 0.6 * k, 0.4, 0, 0.2);
    } else {
      const h = hop > 0 ? Math.max(0, Math.sin(t * 17)) : 0;
      body(vp, 0, h * 6);
      spine(vp, 0.25, 0.2, 0.1, 0.3);
      arms(vp, -1.3 - h * 0.4, 0.8, -1.2 - h * 0.4, 0.8);
      legs(vp, 0.1, 0.3, 0, 0.2);
    }
    if (rip > 0.4) {
      vp.legR_lower!.scale = 0.01;
      vp.footR!.scale = 0.01;
    }
    vict(s, 0, 0, vp, 1, lunge > 0.4 && rip < 0.2 ? 0.5 : 0);
    if (rip > 0.4) {
      const kneeX = s.vx + s.vh * 0.06 * dir;
      const kneeY = s.vy - s.vh * (fall > 0 ? 0.1 : 0.18);
      drawStump(s, kneeX, kneeY, s.vh * 0.055, 0.2);
    }
    bloodPool(s, s.vx, s.gy, s.vh * 0.44, seg(t, 0.36, 0.9));
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.17)) s.d.cue('dash', 1.2, 0.6);
    if (at(0.27)) {
      s.d.cue('bone_crack', 0.75);
      s.d.cue('hit_flesh', 0.9);
      s.d.hit(9, 20, 9);
      spray(s, s.vx, s.vy - s.vh * 0.2, 28, -Math.PI * 0.4, 2.2, 4.4);
    }
    if (s.f > s.dur * 0.36 && s.f < s.dur * 0.72 && (s.f & 7) === 0) {
      spray(s, s.vx, s.vy - s.vh * 0.16, 4, -Math.PI * 0.5, 1.6, 2.2);
    }
    if (at(0.44)) s.d.cue('laugh', 1.4, 0.4);
    if (at(0.86)) {
      s.d.cue('drop', 0.8);
      s.d.hit(5, 14);
    }
  },
};

/** SHIBA INU — digs, deposits, backfills, pats it down. */
VISUALS.shiba_bury = {
  banner: 0.68,
  draw(s) {
    const t = s.t;
    const dig = seg(t, 0.04, 0.34);
    const drop = seg(t, 0.36, 0.5);
    const fill = seg(t, 0.52, 0.76);
    const pat = seg(t, 0.78, 0.88);
    const leave = seg(t, 0.9, 1);
    const dir = s.dir;
    const holeX = s.vx;

    // The hole, then the mound, in the same ellipse.
    const depth = easeOut(dig) * (1 - fill);
    ellipse(s.ctx, holeX, s.gy, s.vh * 0.34, s.vh * 0.12 * (0.4 + depth), 0, '#2a2018', INK, 1.2);
    if (fill > 0) {
      const m = easeOut(fill) * (1 - pat * 0.4);
      ellipse(s.ctx, holeX, s.gy - m * s.vh * 0.1, s.vh * 0.36, s.vh * 0.13 * m, 0, '#6b5744', INK, 1.3);
    }

    // The dwarf goes in head first. Two boots stay out, as is traditional.
    const sink = easeInOut(drop);
    if (fill < 0.9) {
      clipRect(s, holeX - 60, s.gy - 200, 120, 200 - sink * 4, () => {
        const p = P(0);
        tilt(p, 3.0);
        arms(p, -1.4, 0.5, -1.3, 0.5);
        legs(p, 0.4 + Math.sin(t * 20) * 0.2 * (1 - fill), 0.5, 0.2 - Math.sin(t * 20) * 0.2 * (1 - fill), 0.6);
        actor(s, s.victim, holeX, s.gy - sink * s.vh * 0.9 + s.vh, p, (-dir) as Facing, s.vs);
      });
    } else {
      for (let i = -1; i <= 1; i += 2) {
        const bx = holeX + i * s.vh * 0.1;
        roundRect(s.ctx, bx - 3.5, s.gy - s.vh * 0.16, 7, 8, 1.6, '#2a2530', INK, 1.2);
      }
    }

    // The dog: digging, nosing, patting, then gone without a backward glance.
    const dp = P(1);
    const paw = dig > 0 && dig < 1 ? Math.sin(t * 40) : pat > 0 && pat < 1 ? Math.sin(t * 24) : 0;
    tilt(dp, 0.55);
    spine(dp, 0.35, 0.25, -0.4, -0.25);
    arms(dp, 1.4 + paw * 0.7, 0.8, 1.3 - paw * 0.7, 0.8);
    legs(dp, 0.6, 0.9, 0.4, 0.95, 0.3, 0.3);
    body(dp, 0, 0);
    const kx = leave > 0 ? easeIn(leave) * -dir * 150 : 0;
    kill(s, kx + dir * 4, 0, dp);
    const tx = s.kx + kx + dir * 4 - dir * s.kh * 0.42;
    const ty = s.ky - s.kh * 0.62;
    capsule(s.ctx, tx, ty, tx - dir * s.kh * 0.18 + Math.sin(t * 26) * 6, ty - s.kh * 0.26, s.kh * 0.075, s.killer.style.hair, INK, 1.4);
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (s.f > s.dur * 0.05 && s.f < s.dur * 0.34 && s.f % 6 === 0) {
      s.d.cue('dash', 1.6, 0.16);
      emit(
        s, s.vx, s.gy, 6, Math.PI * (s.dir > 0 ? 0.15 : 0.85), 0.8, 1.4, 3.4,
        ['#6b5744', '#8a7256', '#3a2e22'], 'dot', 0.3, 2.2, 30,
      );
    }
    if (at(0.4)) s.d.cue('drop', 0.7);
    if (s.f > s.dur * 0.52 && s.f < s.dur * 0.76 && s.f % 7 === 0) {
      emit(s, s.vx, s.gy - 4, 5, -Math.PI * 0.5, 1.6, 0.6, 2.2, ['#6b5744', '#8a7256'], 'dot', 0.34, 2, 26);
    }
    if (at(0.8)) {
      s.d.cue('land', 1.3, 0.5);
      s.d.hit(3, 10);
    }
  },
};

/** THE BLUE TICK — buried under replies, then noted. */
VISUALS.ratio_crush = {
  banner: 0.66,
  draw(s) {
    const t = s.t;
    const post = seg(t, 0.04, 0.16);
    const pile = seg(t, 0.16, 0.66);
    const note = seg(t, 0.7, 0.8);
    const dir = s.dir;
    const N = 9;

    kill(s, 0, 0, post < 1 ? poseThrust(1, post, 0.7) : poseSmug(1, Math.sin(t * 6)));

    // Every reply presses him a little further into the floor. The stack gets
    // faster because that is how it actually feels.
    const shown = Math.min(N, Math.floor(easeIn(pile) * N + 0.001));
    const press = easeIn(pile);
    squash(s, s.vx, s.gy, 1 + press * 0.5, 1 - press * 0.72, () => {
      const p = P(0);
      const k = press;
      spine(p, 0.5 * k, 0.4 * k, 0.2, 0.5 * k);
      arms(p, 0.7 * k, 1.4, 0.65 * k, 1.4);
      legs(p, 0.2 * k, 1.3 * k, -0.15 * k, 1.3 * k, 0.4, 0.4);
      hips(p, 0.3 * k, 0, -5 * k);
      vict(s, 0, 0, p);
    });

    for (let i = 0; i < shown; i++) {
      const u = i / N;
      const w = 60 + hash(i * 5.1) * 42;
      const h = 11;
      const y = s.gy - 6 - i * (h + 1.6) - press * 2;
      const x = s.vx + (hash(i * 2.7) - 0.5) * 26;
      roundRect(s.ctx, x - w * 0.5, y - h, w, h, 3, i & 1 ? '#16222e' : '#12283a', INK, 1.2);
      ellipse(s.ctx, x - w * 0.5 + 6, y - h * 0.5, 3, 3, 0, '#1d9bf0', 'none');
      s.ctx.fillStyle = 'rgba(210,226,240,0.55)';
      s.ctx.fillRect(x - w * 0.5 + 11, y - h * 0.66, w * 0.5 + hash(i) * 14, 1.4);
      s.ctx.fillRect(x - w * 0.5 + 11, y - h * 0.38, w * 0.34, 1.4);
      if (u > 0.7) label(s, 'ratio', x + w * 0.5 - 12, y - h * 0.5, 5.5, '#7fd8ff');
    }
    if (note > 0) {
      const w = 132;
      const y = s.gy - 8 - N * 12.6 - 14;
      s.ctx.save();
      s.ctx.globalAlpha *= clamp(note * 2, 0, 1);
      roundRect(s.ctx, s.vx - w * 0.5, y - 22, w, 22, 3, '#f2ecdc', INK, 1.4);
      label(s, 'Readers added context', s.vx, y - 15, 6.5, '#2a2f38');
      label(s, 'He is dead.', s.vx, y - 6, 6.5, '#2a2f38');
      s.ctx.restore();
    }
  },
  tick(s) {
    const N = 9;
    for (let i = 0; i < N; i++) {
      const at = Math.round(s.dur * (0.16 + 0.5 * easeOut((i + 1) / N)));
      if (s.f === at) {
        s.d.cue('ui_move', 1 + i * 0.06, 0.32);
        s.d.hit(1.6 + i * 0.5, 7);
      }
    }
    if (s.f === Math.round(s.dur * 0.67)) {
      s.d.cue('explosion', 1.4, 0.5);
      s.d.hit(7, 18, 3);
      spray(s, s.vx, s.gy - 4, 14, -Math.PI * 0.5, 2.9, 2.6);
    }
    if (s.f === Math.round(s.dur * 0.71)) s.d.cue('ui_error', 0.7, 0.6);
  },
};

/** TESLA — forwards, backwards, forwards, and then it parks. */
VISUALS.car_roll = {
  banner: 0.74,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    // Four passes over one dwarf, with a polite pause between each.
    const p1 = seg(t, 0.08, 0.26);
    const rev = seg(t, 0.3, 0.48);
    const p2 = seg(t, 0.52, 0.68);
    const park = seg(t, 0.72, 0.88);
    const carW = s.kh * 1.9;
    const carH = s.kh * 0.62;

    let cx: number;
    if (park > 0) cx = lerp(s.vx + dir * carW * 0.2, s.vx + dir * carW * 0.75, easeOut(park));
    else if (p2 > 0) cx = lerp(s.vx - dir * carW * 0.85, s.vx + dir * carW * 0.2, easeInOut(p2));
    else if (rev > 0) cx = lerp(s.vx + dir * carW * 0.9, s.vx - dir * carW * 0.85, easeInOut(rev));
    else cx = lerp(s.vx - dir * carW * 1.4, s.vx + dir * carW * 0.9, easeInOut(p1));

    // How flat he is right now: the wheel is over him whenever the body is.
    const over = clamp(1 - Math.abs(cx - s.vx) / (carW * 0.5), 0, 1);
    const flat = clamp(Math.max(p1 > 0 ? over : 0, rev > 0 ? over : 0, p2 > 0 ? over : 0), 0, 1);
    const pressed = clamp(Math.max(seg(t, 0.14, 0.2), seg(t, 0.36, 0.42), seg(t, 0.56, 0.62)), 0, 1);
    const squashK = Math.max(flat, pressed * 0.9);

    squash(s, s.vx, s.gy, 1 + squashK * 0.85, 1 - squashK * 0.86, () => {
      const p = P(0);
      const k = squashK;
      tilt(p, -1.5 * clamp(k * 1.4, 0, 1));
      body(p, 2.2 * k, 3 * k);
      arms(p, -1.9 * k, 0.2, -1.7 * k, 0.2);
      legs(p, 0.7 * k, 0.4, 0.6 * k, 0.4);
      vict(s, 0, 0, p);
    });
    bloodPool(s, s.vx, s.gy, s.vh * 0.7, seg(t, 0.2, 0.7));

    // Tyre tracks, laid down once there is something to lay them down in.
    if (s.gore > 0 && t > 0.24) {
      s.ctx.globalAlpha *= 0.55;
      const spread2 = clamp((t - 0.24) * 3, 0, 1) * carW * 0.9;
      capsule(s.ctx, s.vx - spread2, s.gy - 1, s.vx + spread2 * 0.4, s.gy - 1, 2.2, BLOOD_DARK, 'none');
      s.ctx.globalAlpha /= 0.55;
    }

    // The vehicle. An angular wedge, because that is the entire design.
    const bodyY = s.gy - carH * 0.4;
    poly(
      s.ctx,
      [
        cx - carW * 0.5, bodyY,
        cx - carW * 0.34, bodyY - carH * 0.62,
        cx + carW * 0.06, bodyY - carH * 1.05,
        cx + carW * 0.5, bodyY - carH * 0.34,
        cx + carW * 0.5, bodyY,
      ],
      '#c6ccd4',
      INK,
      2,
    );
    poly(
      s.ctx,
      [
        cx - carW * 0.24, bodyY - carH * 0.6,
        cx + carW * 0.04, bodyY - carH * 0.92,
        cx + carW * 0.3, bodyY - carH * 0.5,
        cx - carW * 0.2, bodyY - carH * 0.5,
      ],
      '#25303c',
      INK,
      1.4,
    );
    for (let i = -1; i <= 1; i += 2) {
      const wx = cx + i * carW * 0.3;
      ellipse(s.ctx, wx, s.gy - carH * 0.16, carH * 0.3, carH * 0.3, 0, '#1b1f26', INK, 1.6);
      ellipse(s.ctx, wx, s.gy - carH * 0.16, carH * 0.13, carH * 0.13, 0, STEEL, INK, 1);
    }
    // Reversing lights, and then the hazards, blinking at nobody.
    const blink = (s.f % 30) < 15;
    if (rev > 0 && rev < 1) {
      ellipse(s.ctx, cx + dir * carW * 0.48, bodyY - carH * 0.2, 2.4, 2.4, 0, '#ffffff', 'none');
    }
    if (park > 0.4 && blink) {
      ellipse(s.ctx, cx - carW * 0.46, bodyY - carH * 0.22, 2.6, 2.6, 0, '#ffb03a', 'none');
      ellipse(s.ctx, cx + carW * 0.46, bodyY - carH * 0.22, 2.6, 2.6, 0, '#ffb03a', 'none');
    }
    if (park > 0.9) label(s, 'PARKED', cx, bodyY - carH * 1.5, 8, '#c6ccd4');
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('engine', 0.8, 0.7);
    for (const u of [0.17, 0.39, 0.59]) {
      if (at(u)) {
        s.d.cue('hit_flesh', 0.7);
        s.d.cue('tyres', 0.9, 0.6);
        s.d.hit(10, 20, 8);
        spray(s, s.vx, s.gy - 2, 24, -Math.PI * 0.5, 2.9, 4.2);
      }
    }
    if (s.f > s.dur * 0.3 && s.f < s.dur * 0.48 && s.f % 18 === 0) s.d.cue('ui_move', 1.8, 0.3);
    if (at(0.74)) s.d.cue('tyres', 0.7, 0.5);
    if (at(0.9)) s.d.cue('engine', 0.5, 0.4);
  },
};

/** TESLA — the door closes. The sensor is confident. */
VISUALS.falcon_door = {
  banner: 0.66,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const open = seg(t, 0.04, 0.16);
    const c1 = seg(t, 0.2, 0.28);
    const c2 = seg(t, 0.38, 0.46);
    const c3 = seg(t, 0.56, 0.66);
    const held = seg(t, 0.7, 1);
    const w = s.vh * 0.9;
    const h = s.vh * 1.5;

    // Body pillar and sill: enough car to make the door mean something.
    roundRect(s.ctx, s.vx - w * 0.9, s.gy - h * 0.2, w * 1.9, h * 0.22, 2, '#aeb5bd', INK, 1.8);

    const closeK = Math.max(
      c1 > 0 && c1 < 1 ? Math.sin(c1 * Math.PI) : 0,
      c2 > 0 && c2 < 1 ? Math.sin(c2 * Math.PI) : 0,
      c3 > 0 ? (c3 < 1 ? Math.sin(c3 * Math.PI) : 1) : 0,
    );
    const crush = Math.max(c1 >= 1 ? 0.35 : 0, c2 >= 1 ? 0.6 : 0, held > 0 ? 0.85 : 0, closeK * 0.9);

    squash(s, s.vx, s.gy, 1 - crush * 0.42, 1 + crush * 0.12, () => {
      const p = P(0);
      const k = crush;
      spine(p, 0.2 * k, 0.2 * k, 0.1, 0.3 * k);
      arms(p, 1.2 * k, 0.6, 1.1 * k, 0.6);
      legs(p, 0.2 * k, 0.5 * k, -0.15 * k, 0.5 * k);
      hips(p, 0, 0, -2 * k);
      vict(s, 0, 0, p, 1, closeK > 0.8 ? 0.4 : 0);
    });

    // The door itself, hinged at the roof, coming down like a bird's wing.
    const ang = lerp(-1.15, -0.12, closeK) * dir;
    const hx = s.vx + dir * w * 0.62;
    const hy = s.gy - h;
    s.ctx.save();
    s.ctx.translate(hx, hy);
    s.ctx.rotate(ang);
    roundRect(s.ctx, -w * 0.86, 0, w * 0.86, h * 0.86, 3, '#c6ccd4', INK, 2);
    roundRect(s.ctx, -w * 0.74, h * 0.08, w * 0.6, h * 0.34, 2, '#25303c', INK, 1.4);
    if (c2 >= 1) {
      // The glass gives up before the sensor does.
      zigzag(s.ctx, -w * 0.7, h * 0.12, -w * 0.2, h * 0.38, 3, 6, '#dff2ff', 1.1);
      zigzag(s.ctx, -w * 0.44, h * 0.1, -w * 0.6, h * 0.4, 2.4, 5, '#dff2ff', 0.9);
    }
    s.ctx.restore();
    bloodPool(s, s.vx, s.gy, s.vh * 0.4, seg(t, 0.4, 0.9));

    if (open > 0.4) {
      const flash = (s.f % 24) < 12;
      if (flash || held > 0) {
        label(s, 'OBSTRUCTION DETECTED', s.vx, s.gy - h - 12, 7, '#ff5d5d');
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.06)) s.d.cue('ui_error', 1.1, 0.4);
    for (let i = 0; i < 3; i++) {
      if (at(0.24 + i * 0.18)) {
        s.d.cue('hit_metal', 0.8 - i * 0.08);
        if (i > 0) s.d.cue('glass', 1.1 + i * 0.1, 0.6);
        s.d.hit(7 + i * 2, 16, 4 + i * 3);
        spray(s, s.vx, s.vy - s.vh * 0.5, 12 + i * 8, -Math.PI * 0.5, 2.6, 3.6);
      }
    }
  },
};

/** THE BORING MACHINE — ground down, extruded, sold as landscaping. */
VISUALS.muck_brick = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const down = seg(t, 0.06, 0.24);
    const grind = seg(t, 0.24, 0.56);
    const belt = seg(t, 0.6, 0.82);
    const stamp = seg(t, 0.86, 0.94);
    const headR = s.vh * 0.72;
    const hy = lerp(s.gy - s.vh * 2.6, s.gy - s.vh * 0.34, easeIn(down));

    if (grind < 1) {
      const eaten = easeIn(grind);
      clipRect(s, s.vx - 60, s.gy - s.vh * (1 - eaten) - 2, 120, s.vh * (1 - eaten) + 4, () => {
        const p = P(0);
        const k = grind;
        arms(p, 0.8 * k, 1.2, 0.75 * k, 1.2);
        spine(p, -0.1, -0.1, -0.2 * k, -0.3 * k);
        legs(p, 0.1, 0.3 * k, -0.1, 0.3 * k);
        actor(s, s.victim, s.vx, s.gy, p, (-dir) as Facing, s.vs);
      });
    }

    // The cutterhead: a disc of teeth that does not care what it is cutting.
    if (down > 0.02 && belt < 0.5) {
      const rot = t * 26;
      ellipse(s.ctx, s.vx, hy, headR, headR * 0.95, 0, '#5f5142', INK, 2);
      for (let i = 0; i < 10; i++) {
        const a = rot + (i * TAU) / 10;
        const px = s.vx + Math.cos(a) * headR * 0.72;
        const py = hy + Math.sin(a) * headR * 0.68;
        ellipse(s.ctx, px, py, headR * 0.15, headR * 0.15, 0, i & 1 ? STEEL : '#c2743a', INK, 1.2);
      }
      ellipse(s.ctx, s.vx, hy, headR * 0.24, headR * 0.24, 0, '#3e3428', INK, 1.4);
    }

    // Out the other end: one brick, one hat, no ceremony.
    if (belt > 0.05) {
      const bx = lerp(s.vx - dir * s.vh * 0.9, s.vx + dir * s.vh * 0.6, easeOut(belt));
      const bw = s.vh * 0.5;
      const bh = s.vh * 0.28;
      roundRect(s.ctx, bx - bw * 0.5, s.gy - bh, bw, bh, 1.5, s.gore > 0 ? '#8a3b34' : '#6f6154', INK, 1.8);
      s.ctx.globalAlpha *= 0.4;
      roundRect(s.ctx, bx - bw * 0.42, s.gy - bh * 0.7, bw * 0.84, 1.4, 0.5, '#c98a74', 'none');
      s.ctx.globalAlpha /= 0.4;
      drawLooseHat(s.ctx, s.victim.style, bx + dir * bw * 0.2, s.gy - bh, 0.4 * dir, s.vs * 0.6);
      if (stamp > 0) {
        s.ctx.save();
        s.ctx.globalAlpha *= clamp(stamp * 3, 0, 1);
        s.ctx.translate(bx, s.gy - bh - 12);
        s.ctx.rotate(-0.12);
        label(s, 'GRADE A FILL', 0, 0, 8, '#ffb347');
        s.ctx.restore();
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('engine', 0.6, 0.8);
    if (at(0.25)) {
      s.d.cue('hit_flesh', 0.6);
      s.d.hit(9, 22, 10);
    }
    if (s.f > s.dur * 0.24 && s.f < s.dur * 0.56 && s.f % 5 === 0) {
      s.d.hit(3, 6);
      spray(s, s.vx, s.gy - s.vh * 0.4, 9, -Math.PI * 0.5, 2.9, 4.6);
    }
    if (at(0.62)) s.d.cue('drop', 0.6, 0.7);
    if (at(0.88)) s.d.cue('drop', 1.4, 0.5);
  },
};

/** THE BORING MACHINE — the floor opens. Traffic, solved. */
VISUALS.tube_drop = {
  banner: 0.68,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const open = seg(t, 0.08, 0.28);
    const fall = seg(t, 0.3, 0.5);
    const shut = seg(t, 0.56, 0.72);
    const w = s.vh * 0.8;

    kill(s, 0, 0, poseSmug(1, Math.sin(t * 5)));

    // The hole, then the man in it, then no hole.
    const hole = easeOut(open) * (1 - easeIn(shut));
    if (hole > 0.02) {
      ellipse(s.ctx, s.vx, s.gy, w * 0.5 * hole, w * 0.16 * hole, 0, '#06080c', INK, 1.4);
      s.ctx.globalAlpha *= 0.5;
      ellipse(s.ctx, s.vx, s.gy - 1, w * 0.4 * hole, w * 0.1 * hole, 0, '#1b2430', 'none');
      s.ctx.globalAlpha /= 0.5;
    }
    if (fall < 1) {
      const drop = easeIn(fall);
      clipRect(s, s.vx - 60, s.gy - 220, 120, 220, () => {
        const p = P(0);
        const k = fall;
        arms(p, -1.7 * k, 0.4, -1.6 * k, 0.4);
        legs(p, 0.6 * k, 0.7 * k, 0.4 * k, 0.8 * k);
        spine(p, -0.2 * k, -0.15 * k, -0.1, -0.2 * k);
        actor(s, s.victim, s.vx, s.gy + drop * s.vh * 1.7, p, (-dir) as Facing, s.vs, 1 - drop * 0.3);
      });
    }
    // Hatch flaps, closing over it.
    const flap = 1 - hole;
    for (let i = -1; i <= 1; i += 2) {
      const fx = s.vx + i * w * 0.5;
      poly(
        s.ctx,
        [
          fx, s.gy - 1,
          fx - i * w * 0.5 * flap, s.gy - 1 - w * 0.06 * flap,
          fx - i * w * 0.5 * flap, s.gy + 1,
          fx, s.gy + 1,
        ],
        '#3f4652',
        INK,
        1.4,
      );
    }
    if (shut > 0.6) {
      roundRect(s.ctx, s.vx - 34, s.gy - s.vh * 0.5, 68, 13, 2, '#ffb347', INK, 1.4);
      label(s, 'PLEASE STAND CLEAR', s.vx, s.gy - s.vh * 0.5 + 6.5, 6, '#3e3428');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.1)) {
      s.d.cue('drop', 0.5, 0.7);
      dust(s, s.vx, s.gy, 14, 2.2);
    }
    if (at(0.32)) s.d.cue('whiff', 0.7);
    if (at(0.52)) s.d.cue('land', 0.4, 0.35);
    if (at(0.58)) {
      s.d.cue('drop', 0.8);
      s.d.hit(5, 14);
    }
  },
};

/** SUBJECT P-47 — a clinical trial with one participant. */
VISUALS.implant_fit = {
  banner: 0.66,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const lower = seg(t, 0.06, 0.24);
    const drill = seg(t, 0.26, 0.44);
    const fit = seg(t, 0.46, 0.56);
    const twitch = seg(t, 0.58, 0.74);
    const salute = seg(t, 0.76, 0.86);
    const off = seg(t, 0.88, 1);

    kill(s, 0, 0, posePresent(1, Math.sin(t * 9) * (1 - fit)));

    const hx = s.vx;
    const hy = s.vy - s.vh * 0.95;
    // The arm comes down from above, because of course it does.
    if (lower > 0.02 && off < 0.6) {
      const ay = lerp(s.gy - s.vh * 3, hy - s.vh * 0.14, easeOut(lower));
      capsule(s.ctx, hx, s.gy - s.vh * 3.4, hx, ay, s.vh * 0.05, STEEL, INK, 1.4);
      roundRect(s.ctx, hx - s.vh * 0.09, ay - s.vh * 0.06, s.vh * 0.18, s.vh * 0.14, 1.4, '#7f8794', INK, 1.4);
      if (drill > 0 && drill < 1) {
        capsule(s.ctx, hx, ay + s.vh * 0.06, hx, ay + s.vh * 0.16, s.vh * 0.018, '#e6ebf5', INK, 0.8);
      }
    }

    const vp = P(0);
    if (off > 0) {
      const k = easeIn(off);
      tilt(vp, -1.4 * k);
      body(vp, 2 * k, 2.8 * k);
      arms(vp, -1.4 * k, 0.2, -1.3 * k, 0.2);
      legs(vp, 0.6 * k, 0.4, 0.5 * k, 0.4);
    } else if (salute > 0) {
      spine(vp, -0.12, -0.1, -0.05, -0.08);
      arms(vp, -0.1, 0.2, -1.5 * salute, 2.2 * salute);
      hands(vp, 0, -0.4);
      legs(vp, 0, 0.05, 0, 0.05);
    } else {
      const shake2 = twitch > 0 ? Math.sin(t * 60) * twitch * 0.14 : 0;
      spine(vp, 0.1 + shake2, 0.1 - shake2, -0.2 * drill + shake2, -0.35 * drill);
      arms(vp, 0.5 + shake2 * 2, 1.0, 0.45 - shake2 * 2, 1.0);
      legs(vp, 0.05, 0.3 + drill * 0.4, -0.05, 0.3 + drill * 0.4);
      hips(vp, 0, 0, -2 * drill);
    }
    vict(s, twitch > 0 ? Math.sin(t * 70) * twitch * 1.2 : 0, 0, vp, 1, drill > 0 && drill < 1 && (s.f & 3) < 2 ? 0.4 : 0);

    // The implant. A neat little disc with a light on it.
    if (fit > 0.2) {
      const on = off > 0.3 ? false : (s.f % 40) < 20 || twitch > 0;
      ellipse(s.ctx, hx - dir * s.vh * 0.04, hy - (off > 0 ? -s.vh * 0.5 : 0), s.vh * 0.07, s.vh * 0.05, 0, '#9aa4b2', INK, 1.2);
      ellipse(s.ctx, hx - dir * s.vh * 0.04, hy - (off > 0 ? -s.vh * 0.5 : 0), s.vh * 0.025, s.vh * 0.025, 0, on ? '#6ee4ff' : '#3a2020', 'none');
    }
    if (twitch > 0 && twitch < 1 && !s.reduced) {
      zigzag(s.ctx, hx - 10, hy - 6, hx + 10, hy - 10, 3, 6, '#6ee4ff', 1);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('robot_death', 1.6, 0.3);
    if (at(0.28)) s.d.cue('taser', 0.9, 0.7);
    if (s.f > s.dur * 0.26 && s.f < s.dur * 0.44 && s.f % 6 === 0) {
      sparks(s, s.vx, s.vy - s.vh * 0.95, 6, -Math.PI * 0.5);
      spray(s, s.vx, s.vy - s.vh * 0.95, 4, -Math.PI * 0.5, 2.2, 2.4);
    }
    if (at(0.46)) {
      s.d.cue('bone_crack', 1.1, 0.7);
      s.d.hit(5, 12, 3);
    }
    if (at(0.6)) s.d.cue('taser', 1.5, 0.5);
    if (at(0.9)) {
      s.d.cue('robot_death', 0.7);
      s.d.hit(5, 14);
    }
  },
};

/** THE REGULATOR — one gavel, from a great height. */
VISUALS.gavel_stamp = {
  banner: 0.64,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const rise = seg(t, 0.06, 0.3);
    const fall = seg(t, 0.32, 0.4);
    const hold = seg(t, 0.4, 0.52);
    const lift = seg(t, 0.54, 0.68);
    const sign = seg(t, 0.74, 0.9);
    const gw = s.vh * 1.1;

    kill(s, 0, 0, posePresent(1, rise * Math.sin(t * 10)));

    const flat = clamp(Math.max(hold, lift), 0, 1);
    if (lift < 0.4) {
      squash(s, s.vx, s.gy, 1 + flat * 1.1, 1 - flat * 0.94, () => {
        const p = P(0);
        const k = flat;
        tilt(p, -1.5 * k);
        body(p, 2.2 * k, 3 * k);
        arms(p, -1.9 * k, 0.2, -1.7 * k, 0.2);
        legs(p, 0.7 * k, 0.3, 0.6 * k, 0.3);
        vict(s, 0, 0, p);
      });
    } else {
      // What is left is filed rather than buried.
      const u = easeOut(lift);
      const py = lerp(s.gy - 2, s.gy - s.vh * 1.1, u);
      const px = lerp(s.vx, s.vx + dir * s.vh * 0.4, u);
      s.ctx.save();
      s.ctx.translate(px, py);
      s.ctx.rotate(-0.12 * dir * u);
      drawPaper(s.ctx, 0, -s.vh * 0.34, s.vh * 0.62, s.vh * 0.7, 6, s.gore > 0 ? '#f0dcd8' : PAPER);
      if (s.gore > 0) {
        ellipse(s.ctx, s.vh * 0.06, -s.vh * 0.06, s.vh * 0.12, s.vh * 0.05, 0.2, BLOOD, 'none');
      }
      if (sign > 0) {
        s.ctx.save();
        s.ctx.globalAlpha *= clamp(sign * 3, 0, 1);
        s.ctx.rotate(-0.16);
        label(s, 'DISMISSED', 0, -s.vh * 0.3, 9, '#c0242b');
        roundRect(s.ctx, -s.vh * 0.28, -s.vh * 0.42, s.vh * 0.56, s.vh * 0.22, 2, 'none', '#c0242b', 1.3);
        s.ctx.restore();
      }
      s.ctx.restore();
    }

    // The gavel: up, then very much down.
    if (lift < 0.5) {
      const gy2 = fall > 0
        ? lerp(s.gy - s.vh * 2.6, s.gy - s.vh * 0.12, easeIn(fall))
        : lerp(s.gy - s.vh * 1.2, s.gy - s.vh * 2.6, easeOut(rise));
      const back = hold > 0 ? easeOut(hold) * s.vh * 0.18 : 0;
      roundRect(s.ctx, s.vx - gw * 0.5, gy2 - gw * 0.24 - back, gw, gw * 0.42, 4, '#8a5a34', INK, 2);
      roundRect(s.ctx, s.vx - gw * 0.08, gy2 - gw * 0.24 - back - gw * 0.75, gw * 0.16, gw * 0.75, 2.4, '#a06a3e', INK, 1.6);
      s.ctx.globalAlpha *= 0.45;
      roundRect(s.ctx, s.vx - gw * 0.44, gy2 - gw * 0.16 - back, gw * 0.88, 2.4, 1, '#c78d54', 'none');
      s.ctx.globalAlpha /= 0.45;
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.3)) s.d.cue('whiff', 0.7);
    if (at(0.38)) {
      s.d.cue('explosion', 1.2, 0.7);
      s.d.hit(13, 26, 9);
      dust(s, s.vx, s.gy, 24, 3.6);
      spray(s, s.vx, s.gy - 2, 26, -Math.PI * 0.5, 2.9, 4.2);
    }
    if (at(0.76)) s.d.cue('drop', 1.3, 0.5);
  },
};

/** DONALD J. TRUMP — does not do this personally. Has never done this personally. */
VISUALS.delegate_drag = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const point = seg(t, 0.06, 0.22);
    const arrive = seg(t, 0.24, 0.44);
    const grab = seg(t, 0.44, 0.54);
    const drag = seg(t, 0.56, 0.88);
    const thumb = seg(t, 0.9, 1);

    // He points. That is the entire contribution.
    const kp = P(1);
    arms(kp, -0.2, 0.4, thumb > 0 ? -1.2 : 1.5 * point, thumb > 0 ? 1.6 : 0.15);
    hands(kp, 0, thumb > 0 ? -0.6 : -0.1);
    spine(kp, 0.06, 0.05, 0, 0.04);
    legs(kp, -0.06, 0.12, 0.08, 0.14);
    kill(s, 0, 0, kp);
    if (thumb > 0.3) shout(s, 'TREMENDOUS', s.kx + dir * 8, s.ky - s.kh * 1.45, thumb, 8, '#ffe14a');

    const pull = easeInOut(drag) * dir * 250;
    const vp = P(0);
    if (grab > 0.2) {
      const k = grab;
      spine(vp, -0.2 * k, -0.12, 0.25 * k, 0.4 * k);
      arms(vp, -1.9 * k, 0.5, -1.85 * k, 0.5);
      legs(vp, -0.55 * k, 0.85 * k, -0.7 * k, 1.05 * k, 0.55, 0.6);
      hips(vp, -0.12 * k, 0, -1.6 * k);
    } else {
      const p2 = posePlank(0, 0.9);
      vict(s, 0, 0, p2);
    }
    if (grab > 0.2) {
      vict(s, pull, -grab * s.vh * 0.1, vp);
      if (drag > 0.05) {
        s.ctx.globalAlpha *= 0.4;
        for (let i = 0; i < 2; i++) {
          const y = s.gy - 1 + i * 2.4;
          capsule(s.ctx, s.vx, y, s.vx + pull, y, 0.8, '#8a8090', 'none');
        }
        s.ctx.globalAlpha /= 0.4;
      }
    }

    // Two goons, drawn as silhouettes: they are staff, not characters.
    if (arrive > 0.02 && drag < 1) {
      const gx = lerp(s.vx + dir * 260, s.vx + dir * s.vh * 0.55, easeOut(arrive)) + pull;
      for (let i = 0; i < 2; i++) {
        const ox = gx + i * dir * s.vh * 0.34;
        const bob = Math.sin(t * 24 + i) * 1.4 * (drag > 0 ? 1 : 0);
        const h = s.vh * (1.45 + i * 0.06);
        s.ctx.globalAlpha *= 0.92;
        capsule(s.ctx, ox, s.gy - h * 0.1, ox, s.gy - h * 0.72 + bob, s.vh * 0.16, '#171b24', INK, 1.6);
        ellipse(s.ctx, ox, s.gy - h * 0.86 + bob, s.vh * 0.13, s.vh * 0.15, 0, '#1d222c', INK, 1.4);
        capsule(s.ctx, ox, s.gy - h * 0.6 + bob, ox - dir * s.vh * 0.3, s.gy - h * 0.38 + bob, s.vh * 0.05, '#1d222c', INK, 1.2);
        // Earpiece. Nobody is on the other end.
        ellipse(s.ctx, ox + dir * s.vh * 0.09, s.gy - h * 0.86 + bob, 1.5, 1.5, 0, '#4a5260', 'none');
        s.ctx.globalAlpha /= 0.92;
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.1)) s.d.cue('ui_select', 0.7, 0.5);
    if (at(0.46)) {
      s.d.cue('grunt', 0.8);
      s.d.hit(4, 12);
    }
    if (at(0.58)) s.d.cue('drop', 0.9, 0.5);
    if (at(0.9)) s.d.cue('ui_back', 0.8, 0.5);
  },
};

/** DONALD J. TRUMP — the wall, and the invoice for the wall. */
VISUALS.wall_drop = {
  banner: 0.62,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const point = seg(t, 0.06, 0.24);
    const fall = seg(t, 0.28, 0.38);
    const land = seg(t, 0.38, 0.46);
    const bill = seg(t, 0.6, 0.86);
    const w = s.vh * 1.5;
    const h = s.vh * 1.05;

    kill(s, 0, 0, fall > 0.5 ? poseSmug(1, Math.sin(t * 6)) : posePresent(1, point));

    if (fall < 0.6) {
      const p = P(0);
      const look = point;
      spine(p, -0.1 * look, -0.14 * look, -0.4 * look, -0.7 * look);
      arms(p, -0.35 * look, 0.5, -0.3 * look, 0.5);
      legs(p, 0.05, 0.12, -0.05, 0.12);
      vict(s, 0, 0, p);
    }

    const y = lerp(s.gy - 300, s.gy, easeIn(fall)) - (land > 0 ? Math.sin(land * Math.PI) * 3 : 0);
    // Brick, laid in courses, because a wall that is one rectangle is a slab.
    roundRect(s.ctx, s.vx - w * 0.5, y - h, w, h, 1.5, '#9c5b3e', INK, 2);
    s.ctx.globalAlpha *= 0.45;
    for (let r = 0; r < 6; r++) {
      const by = y - h + (h / 6) * r;
      s.ctx.fillStyle = '#6d3a26';
      s.ctx.fillRect(s.vx - w * 0.5, by, w, 1.2);
      for (let c = 0; c < 6; c++) {
        const bx = s.vx - w * 0.5 + (w / 6) * c + (r & 1 ? w / 12 : 0);
        s.ctx.fillRect(bx, by, 1.2, h / 6);
      }
    }
    s.ctx.globalAlpha /= 0.45;
    if (land > 0.3) bloodPool(s, s.vx, s.gy, w * 0.55, seg(t, 0.46, 0.8));

    if (bill > 0.02) {
      // The invoice, arriving by air, face up, addressed to the deceased.
      const u = easeOut(bill);
      const bx = s.vx + Math.sin(t * 7) * 12 * (1 - u);
      const by = lerp(s.gy - s.vh * 2.4, y - h - 3, u);
      s.ctx.save();
      s.ctx.translate(bx, by);
      s.ctx.rotate((1 - u) * 0.6 * dir - 0.1);
      drawPaper(s.ctx, 0, 0, s.vh * 0.7, s.vh * 0.42, 3);
      label(s, 'INVOICE', 0, s.vh * 0.1, 7, '#2a2f38');
      s.ctx.restore();
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.28)) s.d.cue('whiff', 0.6);
    if (at(0.38)) {
      s.d.cue('explosion', 0.8);
      s.d.hit(13, 26, 8);
      dust(s, s.vx, s.gy, 30, 4.4);
      spray(s, s.vx, s.gy - 3, 20, -Math.PI * 0.5, 2.9, 4);
    }
    if (at(0.62)) s.d.cue('coin', 1.2, 0.5);
  },
};

/** OPTIMUS — folds him. Neatly. It was built to do exactly this. */
VISUALS.fold_stack = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const lift = seg(t, 0.05, 0.2);
    const f1 = seg(t, 0.24, 0.36);
    const f2 = seg(t, 0.4, 0.52);
    const f3 = seg(t, 0.56, 0.68);
    const place = seg(t, 0.74, 0.9);

    kill(s, 0, 0, place > 0.5 ? poseSmug(1, 0) : poseThrust(1, lift, 0.5));

    // Three folds: each one halves him and squares off the corners.
    const folds = f1 * 1 + f2 * 1 + f3 * 1;
    const hover = easeOut(lift) * s.vh * 0.7;
    const stackY = s.gy - (place > 0 ? easeInOut(place) * 0 : 0);
    const cx = s.vx + (place > 0 ? easeInOut(place) * dir * s.vh * 0.7 : 0);
    const cy = stackY - hover + (place > 0 ? easeInOut(place) * (hover - s.vh * 0.26) : 0);

    const sx = 1 - clamp(folds, 0, 3) * 0.28;
    const sy = 1 - clamp(folds, 0, 3) * 0.22;
    squash(s, cx, cy, sx, sy, () => {
      const p = P(0);
      const k = clamp(folds / 3, 0, 1);
      tilt(p, 0.2 * k);
      spine(p, 1.2 * k, 0.9 * k, 0.4 * k, 0.9 * k);
      arms(p, 1.7 * k - 0.2, 2.4 * k, 1.65 * k - 0.2, 2.4 * k);
      legs(p, 1.8 * k, 2.5 * k, 1.7 * k, 2.5 * k, 0.6 * k, 0.6 * k);
      hips(p, 0.5 * k, 0, -3 * k);
      actor(s, s.victim, cx, cy + s.vh * (1 - sy * 0.2), p, (-dir) as Facing, s.vs * (1 - k * 0.1));
    });
    // Crisp edges, drawn over the top: laundry, not a body.
    if (folds > 1.4) {
      const w = s.vh * 0.5 * (1 - (folds - 1.4) * 0.16);
      const h = s.vh * 0.22;
      s.ctx.save();
      s.ctx.globalAlpha *= clamp((folds - 1.4) * 1.2, 0, 0.85);
      roundRect(s.ctx, cx - w * 0.5, cy - h, w, h, 1.2, 'none', INK, 1.4);
      s.ctx.restore();
    }
    if (place > 0.6) {
      drawLooseHat(s.ctx, s.victim.style, cx, cy - s.vh * 0.22, 0, s.vs * 0.42);
    }
    // The two he did earlier.
    for (let i = 0; i < 2; i++) {
      const w = s.vh * 0.5;
      const h = s.vh * 0.13;
      const y = s.gy - i * (h + 1.4);
      roundRect(s.ctx, s.vx + dir * s.vh * 0.7 - w * 0.5, y - h, w, h, 1.4, i ? '#c9d2dc' : '#dfe4ea', INK, 1.5);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.07)) s.d.cue('robot_death', 1.7, 0.25);
    for (let i = 0; i < 3; i++) {
      if (at(0.3 + i * 0.16)) {
        s.d.cue('bone_crack', 0.9 - i * 0.08);
        s.d.cue('robot_death', 1.4, 0.2);
        s.d.hit(6 + i * 2, 14, 2 + i * 2);
        spray(s, s.vx, s.vy - s.vh * 0.6, 8 + i * 5, -Math.PI * 0.5, 2.6, 2.8);
      }
    }
    if (at(0.78)) s.d.cue('drop', 1.1, 0.5);
  },
};

/** GROK — confidently reports that he was never here. */
VISUALS.hallucinated = {
  banner: 0.68,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const scan = seg(t, 0.06, 0.3);
    const label2 = seg(t, 0.32, 0.44);
    const glitch = seg(t, 0.48, 0.74);
    const gone = seg(t, 0.74, 0.86);
    const foot = seg(t, 0.88, 1);

    kill(s, 0, 0, posePresent(1, Math.sin(t * 7)));

    if (gone < 1) {
      // He de-renders in bands, which is what an answer looks like when it is
      // being made up as it goes.
      const bands = 9;
      const p = P(0);
      const alarm = clamp(label2 + glitch, 0, 1);
      spine(p, -0.08, -0.08, -0.18 * alarm, -0.3 * alarm);
      arms(p, 0.55 * alarm, 1.1, 0.5 * alarm, 1.1);
      legs(p, 0.05, 0.2, -0.05, 0.2);
      for (let i = 0; i < bands; i++) {
        const u = i / bands;
        const drop = clamp((gone - u * 0.5) * 3, 0, 1);
        if (drop >= 1) continue;
        const y0 = s.gy - s.vh * 1.15 + (s.vh * 1.2 * i) / bands;
        const off2 = glitch > 0 && !s.reduced ? jitter(s.seed + i, Math.floor(s.f * 0.25)) * glitch * 7 : 0;
        clipRect(s, s.vx - 60, y0, 120, s.vh * 1.2 / bands + 0.6, () => {
          s.ctx.globalAlpha *= 1 - drop;
          actor(s, s.victim, s.vx + off2, s.gy, p, (-dir) as Facing, s.vs);
        });
      }
    }

    // The annotation. Extremely confident, slightly to the left of correct.
    if (scan > 0.3) {
      const w = s.vh * 0.9;
      const h = s.vh * 1.3;
      s.ctx.globalAlpha *= clamp(scan * 2, 0, 1) * (1 - gone * 0.8);
      roundRect(s.ctx, s.vx - w * 0.5 + 6, s.gy - h, w, h, 1, 'none', NEON, 1.1);
      for (let i = 0; i < 4; i++) {
        const cxx = s.vx - w * 0.5 + 6 + (i & 1 ? w : 0);
        const cyy = s.gy - h + (i > 1 ? h : 0);
        capsule(s.ctx, cxx - 3, cyy, cxx + 3, cyy, 1, NEON, 'none');
      }
      s.ctx.globalAlpha /= clamp(scan * 2, 0, 1) * (1 - gone * 0.8);
    }
    if (label2 > 0.05) {
      const bx = s.vx + dir * s.vh * 0.8;
      const by = s.gy - s.vh * 1.35;
      s.ctx.globalAlpha *= clamp(label2 * 3, 0, 1);
      roundRect(s.ctx, bx - 46, by - 9, 92, 18, 2, '#101a24', NEON, 1.2);
      label(s, 'NOT IN TRAINING DATA', bx, by, 6.5, NEON);
      s.ctx.globalAlpha /= clamp(label2 * 3, 0, 1);
    }
    if (foot > 0.02) {
      label(s, '[1]', s.vx, s.gy - s.vh * 0.5, 12 * easeOutBack(clamp(foot * 3, 0, 1)), '#8be0c8');
      label(s, 'source: itself', s.vx, s.gy - s.vh * 0.2, 5.5, '#4e6a66');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('ui_move', 1.4, 0.4);
    if (at(0.33)) s.d.cue('ui_error', 1.2, 0.6);
    if (s.f > s.dur * 0.48 && s.f < s.dur * 0.74 && s.f % 7 === 0) {
      s.d.cue('glass', 1.8, 0.16);
      emit(
        s, s.vx, s.vy - s.vh * 0.6, 4, -Math.PI * 0.5, 2.8, 0.4, 2,
        [NEON, '#8be0c8', '#ffffff'], 'shard', -0.04, 1.8, 24,
      );
    }
    if (at(0.76)) {
      s.d.cue('ui_back', 0.7);
      s.d.hit(4, 12);
    }
  },
};

/** STARSHIP — strapped to the nose. A successful test. */
VISUALS.rud_launch = {
  banner: 0.78,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const strap = seg(t, 0.05, 0.22);
    const ign = seg(t, 0.26, 0.36);
    const climb = seg(t, 0.36, 0.6);
    const boom = seg(t, 0.62, 0.68);
    const rain = seg(t, 0.68, 0.92);
    const rw = s.vh * 0.4;
    const rh = s.vh * 1.6;

    const rise = easeIn(climb) * 420;
    const rx = s.vx;
    const ry = s.gy - rise - (ign > 0 ? Math.sin(t * 90) * 1.4 : 0);

    if (boom < 0.5) {
      // Rocket: a tube, a nose cone, three fins, one passenger.
      capsule(s.ctx, rx, ry - rh * 0.15, rx, ry - rh, rw * 0.5, '#cfd6de', INK, 1.8);
      poly(s.ctx, [rx - rw * 0.5, ry - rh, rx + rw * 0.5, ry - rh, rx, ry - rh - rw * 0.9], '#e4eaf0', INK, 1.6);
      for (let i = -1; i <= 1; i += 2) {
        poly(
          s.ctx,
          [rx + i * rw * 0.45, ry - rh * 0.28, rx + i * rw * 1.05, ry - rh * 0.02, rx + i * rw * 0.45, ry - rh * 0.02],
          '#aab2bb',
          INK,
          1.4,
        );
      }
      const p = P(0);
      const panic = clamp(strap + climb, 0, 1);
      tilt(p, 0);
      arms(p, -1.4 * panic, 0.7, -1.35 * panic, 0.7);
      legs(p, 0.3 * panic, 0.6, 0.2 * panic, 0.6);
      spine(p, -0.1, -0.1, -0.2 * panic, -0.35 * panic);
      actor(s, s.victim, rx + dir * rw * 0.5, ry - rh * 0.62 + s.vh, p, (-dir) as Facing, s.vs * 0.9);
      // Strapping, which is one ratchet strap and a great deal of confidence.
      capsule(s.ctx, rx - rw * 0.2, ry - rh * 0.5, rx + rw * 0.9, ry - rh * 0.5, 1.2, '#ff6a2a', INK, 0.9);

      if (ign > 0.1) {
        const fl = (1 + Math.sin(t * 70) * 0.14) * (0.4 + climb);
        poly(
          s.ctx,
          [
            rx - rw * 0.42, ry - rh * 0.14,
            rx + rw * 0.42, ry - rh * 0.14,
            rx + rw * 0.2, ry + rh * 0.5 * fl,
            rx, ry + rh * 0.8 * fl,
            rx - rw * 0.2, ry + rh * 0.5 * fl,
          ],
          '#ffb03a',
          'none',
        );
        poly(
          s.ctx,
          [
            rx - rw * 0.22, ry - rh * 0.12,
            rx + rw * 0.22, ry - rh * 0.12,
            rx, ry + rh * 0.5 * fl,
          ],
          '#fff6d8',
          'none',
        );
      }
    }
    if (boom > 0 && boom < 1) {
      burst(s.ctx, rx, s.gy - 460, 120 * easeOut(boom), 12, '#ffd166', 0.3);
      burst(s.ctx, rx, s.gy - 460, 78 * easeOut(boom), 9, '#fff6d8', 1.1);
    }
    // What comes back down: one boot, and a great deal of confetti.
    if (rain > 0.05) {
      const u = easeIn(clamp(rain * 1.4, 0, 1));
      const bx = rx + dir * 26;
      const by = lerp(s.gy - 300, s.gy - 3, u);
      s.ctx.save();
      s.ctx.translate(bx, by);
      s.ctx.rotate(u < 1 ? t * 12 : 0.4);
      roundRect(s.ctx, -5, -3, 10, 6, 1.8, '#2a2530', INK, 1.3);
      s.ctx.restore();
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.06)) s.d.cue('drop', 1.2, 0.5);
    if (at(0.27)) {
      s.d.cue('super_charge', 0.7);
      dust(s, s.vx, s.gy, 30, 4);
      s.d.hit(6, 30);
    }
    if (s.f > s.dur * 0.3 && s.f < s.dur * 0.6 && s.f % 4 === 0) {
      emit(s, s.vx, s.gy, 8, Math.PI * 0.5, 1.6, 1.5, 4, SPARK_COLORS, 'smoke', -0.02, 5, 40);
    }
    if (at(0.63)) {
      s.d.cue('explosion', 0.6);
      s.d.hit(16, 34, 14);
      s.d.splatter(8);
      confetti(s, s.vx, s.gy - 260, 70);
      spray(s, s.vx, s.gy - 200, 34, -Math.PI * 0.5, 3.0, 5.4);
    }
    if (at(0.93)) {
      s.d.cue('land', 1.6, 0.5);
      s.d.hit(3, 10);
    }
  },
};

/** STARSHIP — held in the exhaust. A shadow is left on the floor. */
VISUALS.static_fire = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const hold = seg(t, 0.05, 0.2);
    const fire = seg(t, 0.24, 0.62);
    const ash = seg(t, 0.62, 0.76);
    const hat = seg(t, 0.78, 0.96);
    const ex = s.vx - dir * s.vh * 1.5;
    const ey = s.gy - s.vh * 0.6;

    // The engine bell, off to one side, pointed at a man.
    poly(
      s.ctx,
      [
        ex - dir * s.vh * 0.5, ey - s.vh * 0.4,
        ex - dir * s.vh * 0.5, ey + s.vh * 0.4,
        ex + dir * s.vh * 0.1, ey + s.vh * 0.55,
        ex + dir * s.vh * 0.1, ey - s.vh * 0.55,
      ],
      '#aab2bb',
      INK,
      1.8,
    );
    if (fire > 0 && ash < 1) {
      const fl = 1 + Math.sin(t * 80) * 0.1;
      const len = s.vh * 2.2 * fl * clamp(fire * 2, 0, 1);
      poly(
        s.ctx,
        [
          ex + dir * s.vh * 0.1, ey - s.vh * 0.5,
          ex + dir * s.vh * 0.1, ey + s.vh * 0.5,
          ex + dir * len, ey + s.vh * 0.14,
          ex + dir * len, ey - s.vh * 0.14,
        ],
        '#ff8a2a',
        'none',
      );
      poly(
        s.ctx,
        [
          ex + dir * s.vh * 0.12, ey - s.vh * 0.28,
          ex + dir * s.vh * 0.12, ey + s.vh * 0.28,
          ex + dir * len * 0.9, ey,
        ],
        '#fff6d8',
        'none',
      );
    }

    // He goes from a man, to a silhouette, to a mark on the floor.
    const burn = clamp(fire, 0, 1);
    if (ash < 1) {
      const p = P(0);
      const brace = clamp(hold + burn, 0, 1);
      spine(p, 0.3 * brace, 0.25 * brace, 0.1, 0.2 * brace);
      arms(p, 1.3 * brace, 1.0, 1.25 * brace, 1.0);
      legs(p, -0.3 * brace, 0.5 * brace, 0.4 * brace, 0.6 * brace, 0.2, 0.2);
      hips(p, 0.1 * brace, 0, -1.5 * brace);
      const tintK = burn > 0.35 ? '#1a1520' : undefined;
      actor(s, s.victim, s.vx, s.gy, p, (-dir) as Facing, s.vs, 1 - ash, 0, tintK);
    }
    if (ash > 0.1) {
      // The stencil. Arms still up.
      s.ctx.globalAlpha *= clamp(ash * 2, 0, 1) * 0.75;
      const p = P(1);
      spine(p, 0.3, 0.25, 0.1, 0.2);
      arms(p, 1.3, 1.0, 1.25, 1.0);
      legs(p, -0.3, 0.5, 0.4, 0.6, 0.2, 0.2);
      squash(s, s.vx, s.gy, 1.1, 0.24, () => {
        actor(s, s.victim, s.vx, s.gy, p, (-dir) as Facing, s.vs, 1, 0, '#0a0810');
      });
      s.ctx.globalAlpha /= clamp(ash * 2, 0, 1) * 0.75;
    }
    if (hat > 0.02) {
      // The hat survives, because of course the hat survives.
      const u = easeOut(hat);
      const hy = lerp(s.gy - s.vh * 1.8, s.gy - 2, u);
      drawLooseHat(s.ctx, s.victim.style, s.vx + Math.sin(t * 6) * 8 * (1 - u), hy, 0.4 * dir, s.vs);
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.24)) {
      s.d.cue('engine', 0.5, 0.9);
      s.d.hit(6, 40);
    }
    if (s.f > s.dur * 0.24 && s.f < s.dur * 0.62 && s.f % 5 === 0) {
      emit(s, s.vx, s.vy - s.vh * 0.5, 7, Math.PI * (s.dir > 0 ? 0 : 1), 0.9, 2, 5, SPARK_COLORS, 'spark', -0.03, 2.2, 26);
      if (s.f % 15 === 0) spray(s, s.vx, s.vy - s.vh * 0.55, 5, Math.PI * (s.dir > 0 ? 0 : 1), 1, 3.4);
    }
    if (at(0.63)) {
      s.d.cue('explosion', 1.3, 0.6);
      s.d.hit(9, 20, 6);
      dust(s, s.vx, s.gy, 22, 3);
    }
    if (at(0.8)) s.d.cue('hit_flesh', 1.9, 0.2);
  },
};

/** THE GOVERNOR OF MARS — the air subscription lapses. */
VISUALS.airlock_vent = {
  banner: 0.7,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const seal = seg(t, 0.05, 0.22);
    const cycle = seg(t, 0.26, 0.42);
    const swell = seg(t, 0.42, 0.58);
    const suck = seg(t, 0.58, 0.78);
    const shut = seg(t, 0.82, 0.94);
    const dw = s.vh * 1.1;
    const dh = s.vh * 1.7;
    const dx = s.vx + dir * s.vh * 0.9;

    // He waves once the door has him. Until then he simply watches.
    if (suck > 0.5) {
      const wv = Math.sin(t * 22);
      const p = P(1);
      arms(p, -0.2, 0.4, -1.9, 0.5 + wv * 0.4);
      hands(p, 0, wv * 0.4);
      spine(p, -0.05, -0.05, 0.02, 0.04);
      legs(p, 0.05, 0.1, -0.05, 0.1);
      kill(s, 0, 0, p);
    } else {
      kill(s, 0, 0, poseSmug(1, Math.sin(t * 5)));
    }

    // The outer door and, once it is open, the part of Mars behind it.
    const open = clamp(cycle - shut, 0, 1);
    roundRect(s.ctx, dx - dw * 0.5, s.gy - dh, dw, dh, 4, '#3a3f4a', INK, 2);
    if (open > 0.02) {
      roundRect(s.ctx, dx - dw * 0.38, s.gy - dh * 0.92, dw * 0.76, dh * 0.86, 3, '#0a0912', INK, 1.4);
      for (let i = 0; i < 7; i++) {
        const px = dx - dw * 0.3 + hash(i * 3.1) * dw * 0.6;
        const py = s.gy - dh * 0.9 + hash(i * 7.7) * dh * 0.8;
        ellipse(s.ctx, px, py, 0.9, 0.9, 0, '#dfe6ff', 'none');
      }
      // The half-open leaf.
      roundRect(s.ctx, dx - dw * 0.5 + dw * open * 0.86, s.gy - dh * 0.92, dw * 0.4, dh * 0.86, 2, '#4a505c', INK, 1.6);
    }

    const puff = 1 + easeOut(swell) * 0.5;
    const away = easeIn(suck);
    const px2 = s.vx + away * (dx - s.vx + dir * 60);
    const py2 = s.gy - away * s.vh * 0.9 - easeOut(swell) * s.vh * 0.2;
    if (away < 0.98) {
      squash(s, px2, py2, puff, puff * (1 - away * 0.2), () => {
        const p = P(0);
        const k = clamp(swell + suck, 0, 1);
        tilt(p, away * 1.2 * dir);
        arms(p, -1.2 * k, 0.6, -1.1 * k, 0.6);
        legs(p, 0.5 * k, 0.7 * k, 0.35 * k, 0.75 * k);
        spine(p, -0.1, -0.1, -0.2 * k, -0.3 * k);
        actor(s, s.victim, px2, py2 + s.vh, p, (-dir) as Facing, s.vs * (1 - away * 0.35), 1 - away * 0.6);
      });
    }
    if (seal > 0.5 && cycle < 0.4) {
      label(s, 'SUBSCRIPTION LAPSED', s.vx, s.gy - s.vh * 1.7, 7, '#ffb04a');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('ui_error', 0.9, 0.5);
    if (at(0.27)) {
      s.d.cue('whiff', 0.4, 0.9);
      s.d.hit(5, 30);
    }
    if (s.f > s.dur * 0.42 && s.f < s.dur * 0.78 && s.f % 6 === 0) {
      emit(
        s, s.vx, s.vy - s.vh * 0.5, 6, s.dir > 0 ? 0 : Math.PI, 0.7, 2, 4.6,
        ['#dfe6ff', '#9fd8ff'], 'smoke', -0.05, 3.4, 30,
      );
    }
    if (at(0.6)) s.d.cue('glass', 0.6, 0.5);
    if (at(0.84)) {
      s.d.cue('hit_metal', 0.6);
      s.d.hit(7, 16);
    }
  },
};

/** SNOW MUSK MK. II — the kiss. Ninety-six percent of one. */
VISUALS.kiss_shatter = {
  banner: 0.68,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const lean = seg(t, 0.06, 0.28);
    const kiss = seg(t, 0.28, 0.4);
    const frost = seg(t, 0.4, 0.62);
    const crack = seg(t, 0.64, 0.72);
    const shatter = seg(t, 0.72, 0.82);
    const wipe = seg(t, 0.86, 1);

    const kp = P(1);
    const bend = kiss > 0 && shatter <= 0 ? 1 : easeOut(lean) * (1 - shatter);
    if (wipe > 0) {
      arms(kp, -0.3, 0.4, -1.8 + wipe * 0.5, 1.8);
      hands(kp, 0, -0.4);
      spine(kp, -0.05, -0.05, 0.04, 0.06);
      legs(kp, 0.05, 0.1, -0.05, 0.1);
    } else {
      spine(kp, 0.28 * bend, 0.22 * bend, -0.1 * bend, -0.15 * bend);
      arms(kp, 0.4 * bend, 0.6, 1.1 * bend, 0.9);
      hands(kp, 0, -0.3 * bend);
      legs(kp, -0.15 * bend, 0.25, 0.2 * bend, 0.3);
      hips(kp, 0.1 * bend, 0, -1.2 * bend);
    }
    kill(s, bend * s.kh * 0.06 * 1, 0, kp);

    if (shatter < 1) {
      const ice = clamp(frost, 0, 1);
      const p = P(0);
      const stiff = ice;
      spine(p, -0.05 - 0.1 * stiff, -0.05, -0.05, -0.1 * stiff);
      arms(p, -0.1 - 0.5 * stiff, 0.3, -0.08 - 0.45 * stiff, 0.3);
      legs(p, 0.02, 0.08, -0.02, 0.08);
      const tintC = ice > 0.15 ? '#bfe6ff' : undefined;
      vict(s, 0, 0, p, 1 - shatter * 0.4, kiss > 0 && frost < 0.1 ? 0.3 : 0, undefined, tintC);
      if (ice > 0.2) {
        // Frost creeping up, drawn as a rim of ice on the silhouette.
        s.ctx.globalAlpha *= ice * 0.5;
        for (let i = 0; i < 7; i++) {
          const u = i / 7;
          const y = s.gy - s.vh * 1.1 * u * ice * 1.3;
          zigzag(s.ctx, s.vx - s.vh * 0.22, y, s.vx + s.vh * 0.22, y, 1.6, 4, '#dff2ff', 0.8);
        }
        s.ctx.globalAlpha /= ice * 0.5;
      }
      if (crack > 0) {
        for (let i = 0; i < 5; i++) {
          const x0 = s.vx + (hash(i * 4.1) - 0.5) * s.vh * 0.4;
          zigzag(s.ctx, x0, s.gy - s.vh * (0.2 + hash(i) * 0.8), x0 + (hash(i * 2) - 0.5) * 14, s.gy - s.vh * (0.1 + hash(i * 3) * 0.9), 2.4, 4, '#ffffff', 1);
        }
      }
    }
    if (shatter > 0.05) {
      // The pile. Sharp, blue, and knee height.
      const k = easeOut(shatter);
      for (let i = 0; i < 14; i++) {
        const a = hash(i * 5.3) * TAU;
        const r = hash(i * 9.1) * s.vh * 0.5 * k;
        const px = s.vx + Math.cos(a) * r;
        const py = s.gy - Math.abs(Math.sin(a)) * 5 * k;
        poly(
          s.ctx,
          [px, py - 5 * k, px + 3 * k, py, px - 3 * k, py],
          i & 1 ? '#cfe9ff' : '#a9d4f0',
          INK,
          0.9,
        );
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.3)) s.d.cue('super_charge', 1.4, 0.35);
    if (at(0.42)) s.d.cue('glass', 0.6, 0.5);
    if (at(0.66)) {
      s.d.cue('glass', 1.2, 0.7);
      s.d.hit(5, 12);
    }
    if (at(0.73)) {
      s.d.cue('ko', 1.1);
      s.d.cue('glass', 0.8);
      s.d.hit(11, 24, 4);
      emit(
        s, s.vx, s.vy - s.vh * 0.55, 40, -Math.PI * 0.5, 3.1, 1.4, 4.6,
        ['#dff2ff', '#a9d4f0', '#ffffff'], 'shard', 0.3, 2.6, 50,
      );
      spray(s, s.vx, s.vy - s.vh * 0.5, 10, -Math.PI * 0.5, 3, 3);
    }
  },
};

/** ELON MUSK — at last, the exploded view. */
VISUALS.exploded_view = {
  banner: 0.76,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const lift = seg(t, 0.06, 0.24);
    const apart = seg(t, 0.26, 0.5);
    const study = seg(t, 0.5, 0.72);
    const file = seg(t, 0.78, 0.94);
    const spread2 = easeOut(apart) * (1 - easeIn(file));
    const hover = easeOut(lift) * s.vh * 0.5 * (1 - easeIn(file));

    kill(s, study > 0.2 ? dir * 10 * easeInOut(seg(t, 0.5, 0.7)) : 0, 0, posePresent(1, Math.sin(t * 6)));

    // Five clipped bands of one rig, pulled apart, labelled, and floating.
    const parts = 5;
    const cy = s.gy - hover;
    for (let i = 0; i < parts; i++) {
      const u = i / (parts - 1);
      const bandH = (s.vh * 1.2) / parts;
      const y0 = s.gy - s.vh * 1.15 + bandH * i;
      const ox = (u - 0.5) * spread2 * s.vh * 1.5;
      const oy = -spread2 * (parts - i) * bandH * 0.55;
      const drift = s.reduced ? 0 : Math.sin(t * 5 + i) * 1.6 * spread2;
      s.ctx.save();
      s.ctx.translate(ox + drift, oy - hover);
      clipRect(s, s.vx - 60, y0, 120, bandH + 0.6, () => {
        const p = P(0);
        arms(p, -0.4, 0.4, -0.35, 0.4);
        legs(p, 0.05, 0.1, -0.05, 0.1);
        actor(s, s.victim, s.vx, s.gy, p, (-dir) as Facing, s.vs, 1 - file * 0.6);
      });
      // Leader line and part number, in the style of a manual nobody reads.
      if (spread2 > 0.4 && file < 0.5) {
        const lx = s.vx + s.vh * 0.42;
        const ly = y0 + bandH * 0.5;
        s.ctx.globalAlpha *= 0.8;
        capsule(s.ctx, lx, ly, lx + 16, ly - 4, 0.5, NEON, 'none');
        ellipse(s.ctx, lx, ly, 1.3, 1.3, 0, NEON, 'none');
        label(s, PART_IDS[i], lx + 20, ly - 4, 5.5, NEON, 'left');
        s.ctx.globalAlpha /= 0.8;
      }
      s.ctx.restore();
    }
    if (spread2 > 0.5 && file < 0.4) {
      label(s, 'FIG. 1 — DWARF, ASSEMBLY', s.vx, cy - s.vh * 1.5, 7, '#8be0c8');
    }
    // The drawer. It closes on the whole diagram.
    if (file > 0.02) {
      const k = easeInOut(file);
      const w = s.vh * 1.6;
      const h = s.vh * 0.5;
      const y = s.gy - h * k;
      roundRect(s.ctx, s.vx - w * 0.5, y, w, h, 2, '#4a505c', INK, 1.8);
      roundRect(s.ctx, s.vx - w * 0.16, y + h * 0.4, w * 0.32, 3.2, 1.4, '#8f98a6', INK, 1.2);
      if (k > 0.7) label(s, 'D-07', s.vx, y + h * 0.18, 6, '#c6ccd4');
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('super_charge', 1.2, 0.4);
    if (at(0.28)) {
      s.d.cue('bone_crack', 0.7);
      s.d.hit(8, 20, 8);
      spray(s, s.vx, s.vy - s.vh * 0.6, 30, -Math.PI * 0.5, 3.1, 4.4);
    }
    if (s.f > s.dur * 0.3 && s.f < s.dur * 0.5 && s.f % 9 === 0) {
      spray(s, s.vx, s.vy - s.vh * 0.7, 6, -Math.PI * 0.5, 2.8, 2.6);
      s.d.cue('bone_crack', 1.5, 0.25);
    }
    if (at(0.72)) s.d.cue('super_blast', 0.8, 0.6);
    if (at(0.95)) {
      s.d.cue('hit_metal', 0.7);
      s.d.hit(6, 16);
    }
  },
};

const PART_IDS: readonly string[] = ['D-07-A', 'D-07-B', 'D-07-C', 'D-07-D', 'D-07-E'];

/** ELON MUSK — undervalued, bought anyway, shut down on Friday. */
VISUALS.acquired_box = {
  banner: 0.72,
  draw(s) {
    const t = s.t;
    const dir = s.dir;
    const tag = seg(t, 0.06, 0.22);
    const fold = seg(t, 0.26, 0.48);
    const tape = seg(t, 0.52, 0.64);
    const stamp = seg(t, 0.66, 0.76);
    const away = seg(t, 0.84, 1);
    const bw = s.vh * 0.78;
    const bh = s.vh * 0.66;
    const bx = s.vx + easeIn(away) * dir * 240;

    kill(s, 0, 0, poseSmug(1, Math.sin(t * 6)));

    // Into the box, knees first, hat last.
    const inK = easeInOut(fold);
    if (inK < 0.98) {
      squash(s, s.vx, s.gy, 1 + inK * 0.2, 1 - inK * 0.45, () => {
        const p = P(0);
        const k = inK;
        spine(p, 0.8 * k, 0.6 * k, 0.2, 0.6 * k);
        arms(p, 1.4 * k - 0.1, 1.8 * k, 1.35 * k - 0.1, 1.8 * k);
        legs(p, 1.5 * k, 2.0 * k, 1.35 * k, 2.0 * k, 0.5 * k, 0.5 * k);
        hips(p, 0.4 * k, 0, -5 * k);
        vict(s, 0, 0, p);
      });
    }
    drawBox(s.ctx, bx, s.gy, bw, bh, clamp(tape, 0, 1));
    if (tape > 0.4) {
      s.ctx.globalAlpha *= 0.85;
      roundRect(s.ctx, bx - bw * 0.5, s.gy - bh - 1.2, bw, 3, 0.6, '#e6dcc4', INK, 0.7);
      s.ctx.globalAlpha /= 0.85;
    }
    if (stamp > 0) {
      s.ctx.save();
      s.ctx.globalAlpha *= clamp(stamp * 3, 0, 1);
      s.ctx.translate(bx, s.gy - bh * 0.55);
      s.ctx.rotate(-0.16);
      const sc = 1 + (1 - easeOut(stamp)) * 1.6;
      s.ctx.scale(sc, sc);
      label(s, 'ACQUIRED', 0, 0, 10, '#c0242b');
      roundRect(s.ctx, -30, -8, 60, 16, 2, 'none', '#c0242b', 1.3);
      s.ctx.restore();
    }
    // The price tag, which is the insult.
    if (tag > 0.05) {
      const u = easeOutBack(clamp(tag, 0, 1));
      const tx = bx + dir * bw * 0.5;
      const ty = s.gy - bh * (fold > 0.5 ? 0.85 : 1.4);
      s.ctx.save();
      s.ctx.translate(tx, ty);
      s.ctx.rotate(0.25 * dir);
      s.ctx.scale(u, u);
      roundRect(s.ctx, -13, -7, 26, 14, 2, '#f2ecdc', INK, 1.2);
      ellipse(s.ctx, -9, 0, 1.4, 1.4, 0, '#2a2f38', 'none');
      label(s, '$1', 3, 0, 8, '#2a2f38');
      s.ctx.restore();
    }
  },
  tick(s) {
    const at = (u: number) => s.f === Math.round(s.dur * u);
    if (at(0.08)) s.d.cue('coin', 1.3, 0.6);
    if (at(0.28)) {
      s.d.cue('drop', 0.9);
      s.d.hit(4, 12);
    }
    if (at(0.4)) {
      s.d.cue('bone_crack', 1.3, 0.5);
      spray(s, s.vx, s.gy - s.vh * 0.4, 8, -Math.PI * 0.5, 2.4, 2.2);
    }
    if (at(0.54)) s.d.cue('hit_metal', 1.8, 0.35);
    if (at(0.68)) {
      s.d.cue('hit_metal', 0.7);
      s.d.hit(6, 14);
    }
    if (at(0.86)) s.d.cue('drop', 0.6, 0.5);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// THE FOLLOW-THROUGH. One entry per `FatalityFlourish.visual`.
//
// Same rules as the book above — no placeholders, no shared renderers, and an
// unknown id is refused rather than drawn as nothing. These are shorter films
// than the finishers and they have a different job: the finisher was a close-up
// on two people, this is a wide shot of a room, and the thing the eye has to
// follow is the trophy rather than a face. Hence the trails: at 60Hz a femur
// going round three and a half times lands in a different quadrant every frame,
// and without the ghosts behind it the eye simply loses the prop.
//
// Every one of them opens with `aftermath(s)`, which is the mark the finisher
// left on the floor. None of them re-stage the finisher itself: half the book
// ends with no body at all, so there is nothing to re-stage.
// ─────────────────────────────────────────────────────────────────────────────

const FLOURISH_VISUALS: Record<string, FlourishVisual> = {};

/** Screen x of the killer's working hand, with the arm at `ang` from straight down. */
function handX(s: Stage, ang: number, reach = 0.5): number {
  return s.kx + s.dir * (s.kh * 0.05 + Math.sin(ang) * s.kh * reach);
}

/**
 * ...and the y of it.
 *
 * Same sign convention as the pose helpers: `ang` is the shoulder rotation, 0
 * is hanging straight down, and NEGATIVE lifts the arm — which is why raising
 * a hand adds a negative cosine and moves UP the screen.
 */
function handY(s: Stage, ang: number, reach = 0.5): number {
  return s.ky - s.kh * 0.78 + Math.cos(ang) * s.kh * reach;
}

/** Arms out, weight low: the frame a spin is built on. */
function poseWheel(i: number, k: number): Pose {
  const p = P(i);
  spine(p, -0.12, -0.1, 0.04, 0.08);
  arms(p, -1.15 - k * 0.25, 0.1, -1.2 - k * 0.25, 0.08);
  hands(p, -0.15, -0.18);
  legs(p, 0.22 + k * 0.1, 0.42 + k * 0.2, -0.24 - k * 0.1, 0.44 + k * 0.2);
  hips(p, 0, 0, -1.4 * k);
  head2(p, -0.3 * k, -0.4 * k);
  return p;
}

/** Both hands overhead, gripping something heavy. Slams and dunks start here. */
function poseHoist(i: number, k: number): Pose {
  const p = P(i);
  const d = clamp(k, 0, 1);
  spine(p, -0.3 * d, -0.22 * d, -0.1 * d, -0.25 * d);
  arms(p, -2.15 * d - 0.1, 0.2, -2.2 * d - 0.1, 0.18);
  hands(p, -0.2, -0.2);
  legs(p, -0.12 * d, 0.2 + 0.2 * d, 0.14 * d, 0.22 + 0.2 * d);
  hips(p, 0, 0, -0.8 * d);
  head2(p, -0.5 * d, -0.35 * d);
  return p;
}

/** A body turning on the spot, faked the only way 2D allows. */
function spinBody(s: Stage, ang: number, pose: Pose, dx = 0, dy = 0): void {
  const c = Math.cos(ang);
  const face = (c >= 0 ? s.dir : (-s.dir as Facing)) as Facing;
  // The squash IS the turn: a rig has no third axis, so the silhouette narrows
  // as the shoulders come edge-on and widens again as they come round.
  const sx = Math.max(0.3, Math.abs(c));
  squash(s, s.kx + dx, s.ky + dy, sx, 1, () => {
    actor(s, s.killer, s.kx + dx, s.ky + dy, pose, face, s.ks);
  });
}

/** The floor under a spin: grit picked up and thrown outward. */
function spinDust(s: Stage, k: number, ang: number): void {
  if (k <= 0 || k >= 1) return;
  const n = s.reduced ? 3 : 6;
  for (let i = 0; i < n; i++) {
    const a = ang * 0.6 + (i * TAU) / n;
    const r = s.kh * (0.35 + 0.45 * k) * (0.7 + 0.3 * hash(i * 3.7));
    const x = s.kx + Math.cos(a) * r;
    const y = s.gy - Math.abs(Math.sin(a)) * 3 - k * 4;
    s.ctx.save();
    s.ctx.globalAlpha *= 0.35 * (1 - k * 0.4);
    ellipse(s.ctx, x, y, 3.4 + k * 3, 1.6 + k * 1.4, 0, DUST_COLORS[i % DUST_COLORS.length], 'none');
    s.ctx.restore();
  }
}

/** Where a thrown trophy is on a flat-ish arc from the hand to the target. */
function throwX(s: Stage, u: number, fromX: number): number {
  return lerp(fromX, s.tx, u);
}

function throwY(s: Stage, u: number, fromY: number, toY: number, lift: number): number {
  return lerp(fromY, toY, u) - Math.sin(u * Math.PI) * lift;
}

// ── TORNADO — plant a foot and turn until the room is horizontal ──────────────

FLOURISH_VISUALS.tornado = {
  strike: 0.52,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const wind = seg(t, 0, 0.16);
    const spin = seg(t, 0.16, 0.84);
    const stop = seg(t, 0.84, 1);
    const dir = s.dir;
    aftermath(s);

    const spun = easeInOut(spin);
    const turns = 3.6;
    const ang = -Math.PI * 0.5 - wind * 0.7 + spun * TAU * turns;
    const cx = s.kx;
    const cy = s.ky - s.kh * (0.62 + spin * 0.08 - stop * 0.1);
    const out = 0.42 + 0.5 * Math.max(wind * 0.4, spin);
    const rx = s.kh * out;
    const ry = rx * 0.34;

    spinDust(s, spin, ang);

    // A full ring of speed once it is properly going, and a bright leading arc
    // hard behind the trophy for the whole spin.
    if (spin > 0.05 && stop < 1) {
      const heat = Math.sin(clamp(spin, 0, 1) * Math.PI);
      arcSmear(s, cx, cy, rx, ry, 0, TAU, Math.max(1.4, s.kh * 0.07), s.gore > 0 ? BLOOD_DARK : STEEL_DARK, 0.2 * heat);
      arcSmear(s, cx, cy, rx, ry, ang - 2.3, ang, Math.max(2, s.kh * 0.12), s.gore > 0 ? BLOOD_LIGHT : STEEL, 0.45 * heat);
    }

    spinBody(s, ang, poseWheel(1, spin - stop * 0.6), 0, stop > 0 ? Math.sin(stop * Math.PI) * -2 : 0);

    trophyTrail(s, 7, (i) => {
      const a = ang - i * 0.3;
      return {
        x: cx + Math.cos(a) * rx,
        y: cy + Math.sin(a) * ry,
        rot: a + Math.PI * 0.5,
      };
    });

    if (s.caught > 0 && s.ft > 0.52) {
      // A dust ring going out along the floor, sized to how many it took.
      const k = seg(t, 0.52, 0.78);
      floorRing(s, cx, s.gy, s.kh * (0.6 + s.caught * 0.5) * easeOut(k), (1 - k) * 0.8);
    }
    if (stop > 0.2 && stop < 0.9) {
      shout(s, s.caught > 2 ? 'HUP' : 'HNGH', s.kx + dir * 14, s.ky - s.kh * 1.35, stop, 9, '#ffe8b0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.16)) s.d.cue('weapon_swing', 0.7);
    // Four whooshes across the spin, rising, so the ear hears it speed up too.
    for (let i = 0; i < 4; i++) {
      if (at(0.24 + i * 0.13)) s.d.cue('whiff', 0.8 + i * 0.16, 0.4);
    }
    if (at(0.86)) s.d.cue('land', 0.9, 0.5);
  },
};

// ── JAVELIN — one target, and that target leaves the postcode ─────────────────

FLOURISH_VISUALS.javelin = {
  strike: 0.5,
  reach: 'point',
  draw(s) {
    const t = s.ft;
    const load = seg(t, 0, 0.26);
    const step = seg(t, 0.26, 0.34);
    const fly = seg(t, 0.34, 0.5);
    const after = seg(t, 0.5, 0.72);
    const dir = s.dir;
    aftermath(s);

    // Wound up behind the ear, then everything through the hips at once.
    const kp = P(1);
    if (fly > 0) {
      const f = easeOut(clamp(fly * 1.6, 0, 1));
      spine(kp, 0.34 * f, 0.24 * f, 0.06, 0.12 * f);
      arms(kp, -0.5 - f * 0.2, 0.5, lerp(-2.5, 0.9, f), lerp(0.9, 0.2, f));
      legs(kp, -0.5 * f, 0.34, 0.62 * f, 0.5, 0.12, 0.2);
      hips(kp, 0.2 * f, 0, -1.4 * f);
      head2(kp, 0.2 * f, 0.3 * f);
    } else {
      const b = easeOut(load) - step * 0.2;
      spine(kp, -0.3 * b, -0.22 * b, 0.1, 0.16 * b);
      arms(kp, -0.5, 0.4, -2.5 * b - 0.1, 0.9 * b + 0.1);
      legs(kp, 0.35 * b, 0.3, -0.4 * b, 0.42, 0.1, 0.1);
      hips(kp, -0.18 * b, 0, -0.8 * b);
      head2(kp, -0.3 * b, -0.2 * b);
    }
    kill(s, dir * step * 5, 0, kp);

    const hx = handX(s, -2.4 + easeOut(clamp(fly * 1.6, 0, 1)) * 3.3, 0.52);
    const hy = handY(s, -2.4 + easeOut(clamp(fly * 1.6, 0, 1)) * 3.3, 0.52);
    const toY = s.ty - s.kh * 0.55;

    if (fly <= 0) {
      // Still cocked. Held level, pointing where it is going.
      drawTrophy(s, hx, hy, Math.PI * 0.5 * dir + load * 0.25 * dir);
    } else if (fly < 1) {
      const u = easeOut(fly);
      const px = throwX(s, u, hx);
      const py = throwY(s, u, hy, toY, s.kh * 0.32);
      const rot = Math.PI * 0.5 * dir;
      // The contrail: three lines of decreasing weight back down the flight.
      for (let i = 1; i <= 3; i++) {
        const b = clamp(u - i * 0.075, 0, 1);
        lineSmear(
          s,
          throwX(s, b, hx), throwY(s, b, hy, toY, s.kh * 0.32),
          px, py,
          2.6 - i * 0.6,
          '#fff6d8',
          0.3 / i,
        );
      }
      drawTrophy(s, px, py, rot);
    } else if (after < 1) {
      // Landed, embedded, and quivering.
      const q = s.reduced ? 0 : Math.sin(s.ff * 0.9) * (1 - after) * 0.12;
      drawTrophy(s, s.tx, toY, Math.PI * 0.5 * dir + q, s.ts / Math.max(0.1, s.vs));
    } else {
      const fall = seg(t, 0.72, 1);
      drawTrophy(s, s.tx, lerp(toY, s.ty - 3, easeIn(fall)), lerp(Math.PI * 0.5 * dir, Math.PI * dir, fall));
    }

    if (fly >= 1 && after > 0 && after < 0.6 && s.caught > 0) {
      burst(s.ctx, s.tx, toY, s.kh * 0.7 * Math.sin(after / 0.6 * Math.PI), 9, '#fff3c4', 0.4);
    }
    if (after > 0.3 && after < 1 && s.caught === 0) {
      shout(s, '. . .', s.kx + dir * 20, s.ky - s.kh * 1.3, after, 9, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.28)) s.d.cue('grunt', 0.85, 0.7);
    if (at(0.35)) s.d.cue('whiff', 0.65);
    if (at(0.76)) s.d.cue('drop', 0.8, 0.5);
  },
};

// ── BOWLING — underarm, along the floor, down a lane of guards ────────────────

FLOURISH_VISUALS.bowling = {
  strike: 0.56,
  reach: 'lane',
  draw(s) {
    const t = s.ft;
    const back = seg(t, 0, 0.2);
    const swing = seg(t, 0.2, 0.3);
    const roll = seg(t, 0.3, 0.86);
    const dir = s.dir;
    aftermath(s);

    const kp = P(1);
    if (roll > 0) {
      // Followed through, one arm out, watching it go. Nobody moves after they
      // have bowled; they just lean.
      const w = easeOut(clamp(roll * 3, 0, 1));
      spine(kp, 0.2 * w, 0.14 * w, 0.04, 0.1 * w);
      arms(kp, -0.4, 0.4, 1.0 * w, 0.2);
      legs(kp, -0.55 * w, 0.5, 0.4 * w, 0.7, 0.2, 0.3);
      hips(kp, 0.14 * w, 0, -1.2 * w);
    } else {
      const b = easeOut(back) - swing * 0.4;
      spine(kp, 0.3 * b, 0.22 * b, 0.06, 0.2 * b);
      arms(kp, -0.4, 0.4, -1.5 * b, 0.3);
      legs(kp, 0.4 * b, 0.5, -0.3 * b, 0.4, 0.1, 0.1);
      hips(kp, 0.2 * b, 0, -2 * b);
      head2(kp, 0.3 * b, 0.4 * b);
    }
    kill(s, 0, 0, kp);

    // The lane runs slightly INTO the screen, which is what sells the floor as
    // a floor instead of as a wall: the ball shrinks and climbs as it recedes,
    // by exactly the amount Z_SCALE says a step back up the belt is worth.
    const laneLen = Math.min(220, Math.abs(s.tx - s.kx) + 30);
    const recede = Z_DEPTH * 0.28 * Z_SCALE;
    const u = easeOut(roll);

    if (roll > 0 && roll < 1) {
      // Two gutter lines, drawn from the killer's feet out, so the eye reads a
      // lane before the ball reaches the end of it.
      s.ctx.save();
      s.ctx.globalAlpha *= 0.22;
      for (let i = -1; i <= 1; i += 2) {
        capsule(
          s.ctx,
          s.kx + dir * s.kh * 0.3, s.gy - 1 + i * 5,
          s.kx + dir * (s.kh * 0.3 + laneLen), s.gy - 1 - recede * 0.5 + i * 3,
          0.9,
          '#cfc6b8',
          'none',
        );
      }
      s.ctx.restore();
      // Grit thrown up behind it.
      for (let i = 1; i <= 4; i++) {
        const b = clamp(u - i * 0.06, 0, 1);
        s.ctx.save();
        s.ctx.globalAlpha *= 0.22 / i;
        ellipse(
          s.ctx,
          s.kx + dir * (s.kh * 0.4 + b * laneLen),
          lerp(s.gy - 1, s.gy - 1 - recede, b * 0.5),
          4 + i, 1.6, 0, DUST_COLORS[i % DUST_COLORS.length], 'none',
        );
        s.ctx.restore();
      }
    }

    const spun = (back * 0.4 + u * 9) * dir;
    if (roll > 0) {
      trophyTrail(s, s.reduced ? 1 : 3, (i) => {
        const b = clamp(u - i * 0.045, 0, 1);
        return {
          x: s.kx + dir * (s.kh * 0.4 + b * laneLen),
          y: lerp(s.gy - 2, s.gy - 2 - recede, b * 0.5),
          rot: spun - i * 0.5 * dir,
          k: 0.95 - b * 0.15,
        };
      });
    } else {
      const a = -0.4 - easeOut(back) * 1.1 + swing * 1.6;
      drawTrophy(s, handX(s, a, 0.5), handY(s, a, 0.5), spun);
    }

    if (s.caught >= 3 && t > 0.56) {
      shout(s, 'STRIKE', s.kx + dir * 60, s.gy - s.kh * 1.9, seg(t, 0.58, 0.9), 13, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.3)) s.d.cue('drop', 0.7, 0.8);
    // A rolling rumble, ticking down in pitch as it gets further away.
    if (s.ff > s.fdur * 0.32 && s.ff < s.fdur * 0.84 && s.ff % 7 === 0) {
      s.d.cue('dash', 0.5 + (s.ff / s.fdur) * 0.3, 0.16);
    }
  },
};

// ── HELICOPTER — overhead, faster, faster, then look at something else ────────

FLOURISH_VISUALS.helicopter = {
  strike: 0.62,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const raise = seg(t, 0, 0.18);
    const spin = seg(t, 0.18, 0.62);
    const release = seg(t, 0.62, 0.82);
    const bored = seg(t, 0.8, 1);
    const dir = s.dir;
    aftermath(s);

    if (bored > 0.2) {
      // Not watching. Never watching.
      kill(s, 0, 0, poseSmug(1, Math.sin(s.ff * 0.12)));
    } else {
      const kp = P(1);
      const u = easeOut(raise);
      spine(kp, -0.1 * u, -0.08 * u, -0.04, -0.1 * u);
      arms(kp, -0.3, 0.4, -2.4 * u - 0.1, 0.12);
      hands(kp, 0, -0.25);
      legs(kp, 0.1, 0.16, -0.12, 0.18);
      head2(kp, -0.35 * u, -0.2 * u);
      // Lifted off the heels by his own rotor. Not by much.
      kill(s, 0, s.reduced ? 0 : Math.sin(s.ff * 0.5) * spin * -1.4, kp);
    }

    const cx = handX(s, -2.5, 0.5);
    const cy = s.ky - s.kh * 1.34;
    // Rotor speed ramps hard, so the ring goes from "a thing on a stick" to a
    // solid disc without ever passing through "a thing on a stick, quickly".
    const rate = easeIn(spin);
    const ang = raise * 1.2 + rate * TAU * 7;
    const rx = s.kh * (0.3 + 0.62 * easeOut(spin));
    const ry = rx * 0.26;

    if (spin > 0.1 && release < 1) {
      const heat = Math.min(1, spin * 1.6) * (1 - release);
      arcSmear(s, cx, cy, rx, ry, 0, TAU, Math.max(2, s.kh * 0.14 * heat), '#dfe6ff', 0.16 * heat);
      arcSmear(s, cx, cy, rx, ry, ang - 3.4, ang, Math.max(2, s.kh * 0.11), s.gore > 0 ? BLOOD_LIGHT : STEEL, 0.4 * heat);
    }

    if (release < 1) {
      trophyTrail(s, s.reduced ? 2 : 8, (i) => {
        const a = ang - i * 0.34;
        return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, rot: a + Math.PI * 0.5 };
      });
    } else {
      // Let go, straight out, gone over the scenery.
      const u = easeOut(seg(t, 0.62, 1));
      const px = cx + dir * u * 320;
      const py = cy - u * 90 + u * u * 40;
      s.ctx.save();
      s.ctx.globalAlpha *= clamp(1 - u * 1.1, 0, 1);
      drawTrophy(s, px, py, ang + u * 18);
      s.ctx.restore();
    }

    // The downwash, which is the part that actually knocks people over.
    if (release > 0 && release < 1) {
      const k = easeOut(release);
      floorRing(s, s.kx, s.gy, s.kh * (0.8 + 3.4 * k), (1 - k) * 0.85, '#dfe6ff');
      floorRing(s, s.kx, s.gy, s.kh * (0.4 + 2.2 * k), (1 - k) * 0.5);
    }
    if (bored > 0.3) {
      shout(s, 'WHAT', s.kx + dir * 16, s.ky - s.kh * 1.4, bored, 8, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.2)) s.d.cue('weapon_swing', 0.9, 0.6);
    // A rotor is a whiff played faster and faster until it is a note.
    if (s.ff > s.fdur * 0.2 && s.ff < s.fdur * 0.62) {
      const k = (s.ff - s.fdur * 0.2) / (s.fdur * 0.42);
      const every = Math.max(3, Math.round(11 - k * 8));
      if (s.ff % every === 0) s.d.cue('whiff', 0.7 + k * 1.1, 0.22);
    }
    if (at(0.63)) {
      s.d.cue('explosion', 1.5, 0.4);
      s.d.hit(4, 16);
      dust(s, s.kx, s.gy, 18, 3.2);
    }
  },
};

// ── GOLF — tee it up and put it flat through the front row ────────────────────

FLOURISH_VISUALS.golf_drive = {
  strike: 0.44,
  reach: 'lane',
  draw(s) {
    const t = s.ft;
    const tee = seg(t, 0, 0.18);
    const address = seg(t, 0.18, 0.3);
    const back = seg(t, 0.3, 0.4);
    const swing = seg(t, 0.4, 0.46);
    const fly = seg(t, 0.46, 0.9);
    const dir = s.dir;
    aftermath(s);

    const teeX = s.kx + dir * s.kh * 0.62;
    const teeY = s.gy - 2;

    // A committed golf swing is all shoulders: the arms barely change, the
    // spine does the work, and the follow-through ends up behind the head.
    const kp = P(1);
    const b = easeOut(back) * (1 - swing);
    const f = easeOut(swing);
    spine(kp, 0.28 - b * 0.5 + f * 0.3, 0.2 - b * 0.35 + f * 0.2, 0.05, 0.18 - b * 0.2);
    arms(kp, 1.1 - b * 2.6 + f * 2.2, 0.3, 1.15 - b * 2.7 + f * 2.3, 0.28);
    hands(kp, -0.2, -0.2);
    legs(kp, -0.2, 0.3, 0.24, 0.34, 0.1, 0.1);
    hips(kp, -0.1 * b + 0.24 * f, 0, -1.2 * (b + f));
    head2(kp, -0.2 * b, -0.15 * b);
    kill(s, 0, 0, kp);

    // The club-arc, which is the whole reason a golf swing reads at all.
    if (swing > 0 && swing < 1) {
      const hxc = s.kx + dir * s.kh * 0.1;
      const hyc = s.ky - s.kh * 0.72;
      arcSmear(
        s, hxc, hyc, s.kh * 0.78, s.kh * 0.78,
        -Math.PI * (dir > 0 ? 1.15 : -0.15), -Math.PI * (dir > 0 ? 0.15 : 0.85),
        Math.max(2, s.kh * 0.09), '#fff6d8', 0.55 * (1 - swing),
      );
    }

    if (fly <= 0) {
      const lift = tee < 1 ? (1 - easeOut(tee)) * s.kh * 0.9 : 0;
      const wob = address > 0 && back <= 0 ? Math.sin(s.ff * 0.6) * 0.06 : 0;
      drawTrophy(s, teeX, teeY - lift, wob * dir);
      if (tee >= 1 && fly <= 0) {
        // The tee. One line, and it is a golf course.
        capsule(s.ctx, teeX, teeY, teeX, teeY + 3, 0.8, '#e6dcc4', INK, 0.6);
      }
    } else {
      const u = easeOut(fly);
      const len = Math.min(240, Math.abs(s.tx - teeX) + 60);
      const px = teeX + dir * u * len;
      const py = teeY - Math.sin(u * Math.PI * 0.85) * s.kh * 1.5 - u * 6;
      for (let i = 1; i <= 4; i++) {
        const c = clamp(u - i * 0.06, 0, 1);
        lineSmear(
          s,
          teeX + dir * c * len, teeY - Math.sin(c * Math.PI * 0.85) * s.kh * 1.5 - c * 6,
          px, py, 1.8 - i * 0.3, '#ffffff', 0.26 / i,
        );
      }
      s.ctx.save();
      s.ctx.globalAlpha *= clamp(1.2 - u, 0, 1);
      drawTrophy(s, px, py, u * 22 * dir, 1 - u * 0.35);
      s.ctx.restore();
      if (fly > 0.1 && fly < 0.6) {
        shout(s, 'FORE', s.kx + dir * 22, s.ky - s.kh * 1.5, fly / 0.6, 10, '#ffe14a');
      }
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.06)) s.d.cue('drop', 1.4, 0.4);
    if (at(0.4)) s.d.cue('whiff', 0.9, 0.7);
    if (at(0.45)) {
      s.d.cue('bat_crack', 1.1);
      dust(s, s.kx + s.dir * s.kh * 0.6, s.gy, 10, 2.2);
    }
    if (at(0.9)) s.d.cue('coin', 1.7, 0.35);
  },
};

// ── PILE DRIVER — both hands, straight down, floor passes the message on ──────

FLOURISH_VISUALS.ground_slam = {
  strike: 0.46,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const hoist = seg(t, 0, 0.32);
    const hang = seg(t, 0.32, 0.4);
    const slam = seg(t, 0.4, 0.46);
    const held = seg(t, 0.46, 0.8);
    const dir = s.dir;
    aftermath(s);

    const down = easeIn(slam);
    const kp = slam > 0
      ? poseThrust(1, down, -0.4)
      : poseHoist(1, easeOut(hoist) * (1 + hang * 0.06));
    if (slam > 0) {
      // Thrust bends forward; this one wants to be driving straight down.
      arms(kp, -0.5 + down * 1.6, 0.2, -0.55 + down * 1.65, 0.2);
      spine(kp, 0.15 + down * 0.5, 0.1 + down * 0.35, 0.05, 0.2 + down * 0.3);
      legs(kp, -0.3 - down * 0.2, 0.4 + down * 0.9, 0.3 + down * 0.2, 0.42 + down * 0.9, 0.2, 0.2);
      hips(kp, 0, 0, -4 * down);
    }
    kill(s, 0, slam > 0 ? down * 2 : -hoist * 1.5, kp);

    const topY = s.ky - s.kh * (1.5 + hang * 0.1);
    const py = lerp(topY, s.gy - s.kh * 0.14, down);
    const px = s.kx + dir * s.kh * 0.16;
    if (slam > 0 && slam < 1) {
      lineSmear(s, px, topY, px, py, Math.max(2, s.kh * 0.12), '#fff6d8', 0.5);
    }
    trophyTrail(s, slam > 0 && slam < 1 ? 4 : 0, (i) => {
      const b = clamp(down - i * 0.16, 0, 1);
      return { x: px, y: lerp(topY, s.gy - s.kh * 0.14, b), rot: Math.PI * 0.5 + i * 0.05 };
    });

    if (held > 0) {
      const k = easeOut(held);
      floorRing(s, s.kx, s.gy, s.kh * (0.5 + 3.2 * k), (1 - k) * 0.9);
      floorRing(s, s.kx, s.gy, s.kh * (0.3 + 1.9 * k), (1 - k) * 0.55, '#8a8090');
      // Cracks, radiating, drawn once and then held.
      if (held < 0.9) {
        s.ctx.save();
        s.ctx.globalAlpha *= clamp(1 - held * 0.6, 0, 1);
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI + (i / 4) * Math.PI;
          const len = s.kh * (0.9 + hash(i * 4.3) * 1.4) * easeOut(held);
          zigzag(
            s.ctx,
            s.kx, s.gy - 1,
            s.kx + Math.cos(a) * len, s.gy - 1 - Math.sin(a) * len * 0.16,
            2.2, 4, '#2a2530', 1.2,
          );
        }
        s.ctx.restore();
      }
    }
    if (hang > 0.1 && slam <= 0) {
      shout(s, 'HRRK', s.kx + dir * 12, s.ky - s.kh * 1.8, hang, 9, '#ffe8b0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.06)) s.d.cue('grunt', 0.75, 0.7);
    if (at(0.41)) s.d.cue('whiff', 0.55);
    if (at(0.47)) {
      s.d.cue('explosion', 0.8, 0.8);
      s.d.cue('land', 0.5);
      dust(s, s.kx, s.gy, 26, 4.2);
    }
  },
};

// ── WHIP — thirty-three vertebrae of rawhide ─────────────────────────────────

FLOURISH_VISUALS.whip = {
  strike: 0.5,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const lash = seg(t, 0.28, 0.5);
    const crack = seg(t, 0.5, 0.58);
    const recoil = seg(t, 0.58, 0.86);
    const dir = s.dir;
    aftermath(s);

    const kp = P(1);
    const l = easeOut(lash) - recoil * 0.35;
    spine(kp, -0.3 + l * 0.7, -0.2 + l * 0.5, 0.06, -0.14 + l * 0.4);
    arms(kp, -0.4, 0.4, lerp(-2.3, 1.2, clamp(l, 0, 1)), lerp(0.8, 0.15, clamp(l, 0, 1)));
    legs(kp, -0.3 + l * 0.6, 0.34, 0.4 - l * 0.5, 0.5, 0.1, 0.15);
    hips(kp, -0.15 + l * 0.36, 0, -1.4 * clamp(l, 0, 1));
    kill(s, 0, 0, kp);

    const a0 = lerp(-2.3, 1.2, clamp(l, 0, 1));
    const hx = handX(s, a0, 0.5);
    const hy = handY(s, a0, 0.5);
    // The lash: a curve whose far end travels much further than its near end,
    // which is the whole trick — the tip is doing several times the speed of
    // the hand and the taper is what says so.
    const reach = s.kh * (0.4 + 2.1 * easeOut(clamp(lash, 0, 1)) * (1 - recoil * 0.7));
    const tipX = hx + dir * reach;
    const tipY = hy + s.kh * (0.5 - easeOut(clamp(lash, 0, 1)) * 0.7) + Math.sin(s.ff * 0.4) * 2 * (1 - lash);
    const sag = s.kh * (0.9 * (1 - clamp(lash, 0, 1)) - crack * 0.3);

    const SEGS = 12;
    for (let i = 0; i < SEGS; i++) {
      const u0 = i / SEGS;
      const u1 = (i + 1) / SEGS;
      const bend0 = Math.sin(u0 * Math.PI) * sag;
      const bend1 = Math.sin(u1 * Math.PI) * sag;
      const w = Math.max(0.5, s.kh * 0.055 * (1 - u0 * 0.75));
      capsule(
        s.ctx,
        lerp(hx, tipX, u0), lerp(hy, tipY, u0) + bend0,
        lerp(hx, tipX, u1), lerp(hy, tipY, u1) + bend1,
        w,
        s.trophy === 'arm' ? s.victim.style.jacketColor : (i & 1 ? BONE : BONE_SHADE),
        INK,
        1,
      );
    }
    drawTrophy(s, tipX, tipY, Math.PI * 0.5 * dir, 0.7);

    if (crack > 0 && crack < 1) {
      const k = Math.sin(crack * Math.PI);
      burst(s.ctx, tipX, tipY, s.kh * 0.6 * k, 8, '#ffffff', 0.2);
      shout(s, 'CRACK', tipX, tipY - s.kh * 0.5, crack, 11, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.26)) s.d.cue('chain_whip', 0.7, 0.6);
    if (at(0.48)) s.d.cue('whiff', 1.4, 0.5);
    if (at(0.51)) {
      s.d.cue('bone_crack', 1.5, 0.8);
      s.d.cue('chain_whip', 1.5, 0.7);
    }
  },
};

// ── PIÑATA — bat it until it gives up its contents ───────────────────────────

FLOURISH_VISUALS.pinata = {
  strike: 0.72,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const hang = seg(t, 0, 0.14);
    const beat = seg(t, 0.14, 0.72);
    const burstK = seg(t, 0.72, 0.8);
    const rain = seg(t, 0.76, 1);
    const dir = s.dir;
    aftermath(s);

    const HITS = 4;
    const phase = beat * HITS;
    const idx = Math.min(HITS - 1, Math.floor(phase));
    const swingK = phase - idx;
    const landing = beat > 0 && beat < 1 && swingK > 0.6;

    kill(s, 0, 0, beat > 0 && beat < 1 ? poseSwing(1, clamp((swingK - 0.15) / 0.6, 0, 1)) : poseReach(1, hang * 0.4));

    // Strung up from somewhere above the frame, swinging further every time it
    // is hit, which is what makes the fourth swing look like a decision.
    const anchorX = s.kx + dir * s.kh * 0.9;
    const anchorY = s.gy - s.kh * 3.2;
    const amp = 0.28 + beat * 0.5;
    const sway = Math.sin(s.ff * 0.16 + hang * 2) * amp * (1 - burstK);
    const len = s.kh * 2.1;
    const px = anchorX + Math.sin(sway) * len;
    const py = anchorY + Math.cos(sway) * len;

    if (burstK < 1) {
      s.ctx.save();
      s.ctx.globalAlpha *= 0.7;
      capsule(s.ctx, anchorX, anchorY, px, py, 0.7, '#c8bda6', 'none');
      s.ctx.restore();
      const wob = landing ? 0.2 * dir : 0;
      drawTrophy(s, px, py, sway + wob, 1 + burstK * 0.4);
    }
    if (landing) {
      burst(s.ctx, px, py, s.kh * 0.4, 7, '#fff3c4', idx);
    }
    if (burstK > 0 && burstK < 1) {
      const k = easeOut(burstK);
      burst(s.ctx, px, py, s.kh * 1.4 * k, 11, '#ffd166', 0.3);
      burst(s.ctx, px, py, s.kh * 0.9 * k, 8, '#ffffff', 1.2);
    }
    if (rain > 0.02) {
      // The contents. Nobody looks at what they are, which is for the best.
      const k = easeIn(rain);
      for (let i = 0; i < 12; i++) {
        const j = jitter(s.seed, i + 12);
        const rx = px + j * s.kh * 1.5;
        const ry = lerp(py, s.gy - 2, clamp(k * (0.6 + hash(i * 2.3) * 0.7), 0, 1));
        ellipse(
          s.ctx, rx, ry, 2.2, 2.8, j * 3,
          s.gore > 0 ? BLOOD_COLORS[i % 3] : CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          INK, 0.7,
        );
      }
    }
    if (rain > 0.3) {
      shout(s, 'OLE', s.kx + dir * 16, s.ky - s.kh * 1.4, seg(t, 0.82, 1), 11, '#ffe14a');
    }
  },
  tick(s) {
    const HITS = 4;
    for (let i = 0; i < HITS; i++) {
      const at = Math.round(s.fdur * (0.14 + (0.58 * (i + 0.72)) / HITS));
      if (s.ff === at) {
        s.d.cue(i === HITS - 1 ? 'bat_crack' : 'punch_heavy', 1.1 - i * 0.1, 0.7);
        s.d.hit(3 + i * 1.4, 9);
      }
    }
    if (s.ff === Math.round(s.fdur * 0.73)) {
      s.d.cue('hit_flesh', 0.7);
      s.d.cue('laugh', 1.2, 0.5);
      confetti(s, s.kx + s.dir * 24, s.gy - s.kh * 1.6, 40);
    }
  },
};

// ── HOT POTATO — lobbed to a stranger who catches it before he thinks ─────────

FLOURISH_VISUALS.hot_potato = {
  strike: 0.56,
  reach: 'point',
  draw(s) {
    const t = s.ft;
    const wind = seg(t, 0, 0.18);
    const lob = seg(t, 0.18, 0.44);
    const hold = seg(t, 0.44, 0.56);
    const drop = seg(t, 0.6, 0.86);
    const dir = s.dir;
    aftermath(s);

    // Underarm, friendly, entirely without malice. That is the joke.
    const w = easeOut(wind) * (1 - lob);
    const f = easeOut(lob);
    if (lob >= 1) {
      kill(s, 0, 0, poseSmug(1, Math.sin(s.ff * 0.1)));
    } else {
      const kp = P(1);
      spine(kp, 0.1 * w - 0.12 * f, 0.08 * w, 0.04, 0.1 * w);
      arms(kp, -0.4, 0.4, -0.9 * w + f * 1.5, 0.5 - f * 0.35);
      legs(kp, 0.14, 0.2, -0.16, 0.22);
      kill(s, 0, 0, kp);
    }

    const hx = handX(s, -0.9 + f * 2.4, 0.48);
    const hy = handY(s, -0.9 + f * 2.4, 0.48);
    const catchY = s.ty - s.kh * 0.72;

    if (lob > 0 && drop <= 0) {
      const u = easeOut(lob);
      const px = throwX(s, u, hx);
      const py = throwY(s, u, hy, catchY, s.kh * 1.35);
      drawTrophy(s, px, py, u * 5 * dir);
      if (lob >= 1 && hold > 0 && hold < 1) {
        // Held at arm's length by somebody who has just worked out what it is.
        shout(s, hold < 0.5 ? '?' : '!', s.tx + dir * 10, catchY - s.kh * 0.5, hold, 13, '#ffe14a');
      }
    } else if (lob <= 0) {
      drawTrophy(s, hx, hy, -0.3 * dir);
    } else {
      // Dropped, because nobody wanted it in the first place.
      const u = easeIn(drop);
      drawTrophy(s, s.tx + dir * 4 * u, lerp(catchY, s.ty - 3, u), lerp(0, Math.PI * 0.55 * dir, u));
    }
    if (drop > 0.2) {
      shout(s, '. . .', s.kx + dir * 18, s.ky - s.kh * 1.3, drop, 9, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.2)) s.d.cue('whiff', 1.3, 0.4);
    if (at(0.45)) s.d.cue('pickup', 0.8, 0.6);
    if (at(0.5)) s.d.cue('grunt', 1.5, 0.5);
    if (at(0.62)) s.d.cue('drop', 0.9, 0.6);
  },
};

// ── SOUVENIR — pockets it, walks off, nothing happens to anybody ──────────────

FLOURISH_VISUALS.souvenir = {
  // Nothing to connect with. It still needs a moment, and this is where the
  // shrug lands: `radius: 0` means the sweep finds nobody and says so quietly.
  strike: 0.62,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const look = seg(t, 0, 0.24);
    const wipe = seg(t, 0.26, 0.5);
    const pocket = seg(t, 0.54, 0.74);
    const off = seg(t, 0.78, 1);
    const dir = s.dir;
    aftermath(s);

    const kp = P(1);
    const l = easeOut(look);
    const w = wipe > 0 && wipe < 1 ? Math.sin(wipe * Math.PI * 3) * 0.22 : 0;
    const p = easeInOut(pocket);
    spine(kp, 0.1 * l - 0.05 * p, 0.08 * l, 0.06 * l, 0.22 * l - 0.2 * p);
    arms(kp, -0.35 - w, 0.5, lerp(-1.35, -0.15, p) + w, lerp(1.1, 0.35, p));
    hands(kp, -0.2, -0.3);
    legs(kp, 0.08 + off * 0.4, 0.16, -0.1 - off * 0.4, 0.2);
    kill(s, off > 0 ? dir * easeIn(off) * 26 : 0, 0, kp);

    if (pocket < 0.85) {
      const a = lerp(-1.35, -0.15, p);
      const k = 1 - p * 0.35;
      drawTrophy(s, handX(s, a, 0.46) + dir * easeIn(off) * 26, handY(s, a, 0.46), 0.2 * dir + w, k);
    }
    if (wipe > 0.1 && wipe < 1) {
      // A polish. On the sleeve. Like a apple.
      for (let i = 0; i < 3; i++) {
        const k = clamp(wipe * 3 - i, 0, 1);
        if (k <= 0 || k >= 1) continue;
        star(s.ctx, handX(s, -1.2, 0.46) + i * 3 * dir, handY(s, -1.2, 0.46) - 4 - i * 2, 2.2 * Math.sin(k * Math.PI), 4, '#ffffff', 'none');
      }
    }
    if (pocket > 0.4 && off <= 0) {
      shout(s, '. . .', s.kx + dir * 16, s.ky - s.kh * 1.3, seg(t, 0.6, 0.78), 9, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.3)) s.d.cue('ui_move', 1.4, 0.25);
    if (at(0.58)) s.d.cue('pickup', 0.7, 0.6);
    if (at(0.8)) s.d.cue('coin', 1.5, 0.35);
  },
};

// ── ALL HANDS — backhand, backhand, backhand, all the way round ───────────────

FLOURISH_VISUALS.all_hands = {
  strike: 0.66,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const turn = seg(t, 0.08, 0.88);
    const dir = s.dir;
    aftermath(s);

    // Deliberate rather than fast: a quarter turn, a backhand, a pause, repeat.
    const QUARTERS = 4;
    const step = turn * QUARTERS;
    const idx = Math.min(QUARTERS - 1, Math.floor(step));
    const k = step - idx;
    const swing = clamp((k - 0.45) / 0.35, 0, 1);
    const ang = ((idx + easeInOut(clamp(k / 0.45, 0, 1))) / QUARTERS) * TAU;

    const kp = P(1);
    spine(kp, -0.06, -0.05, 0.03, 0.06);
    arms(kp, -0.35, 0.45, lerp(-0.4, -1.75, swing), lerp(1.5, 0.2, swing));
    hands(kp, -0.15, -0.3);
    legs(kp, 0.12, 0.24, -0.14, 0.26);
    spinBody(s, ang, kp);

    const r = s.kh * (0.3 + swing * 0.62);
    const cy = s.ky - s.kh * 0.86;
    const a = Math.cos(ang) >= 0 ? 1 : -1;
    const px = s.kx + a * dir * r;
    const py = cy - swing * s.kh * 0.1;

    if (swing > 0.05 && swing < 1) {
      arcSmear(
        s, s.kx, cy, r, r * 0.3,
        a * dir > 0 ? Math.PI * 0.9 : -0.1, a * dir > 0 ? 0.1 : Math.PI * 1.1,
        Math.max(1.6, s.kh * 0.08), s.gore > 0 ? BLOOD_LIGHT : STEEL, 0.4,
      );
    }
    trophyTrail(s, swing > 0.05 && swing < 1 ? 3 : 0, (i) => {
      const b = clamp(swing - i * 0.12, 0, 1);
      return {
        x: s.kx + a * dir * s.kh * (0.3 + b * 0.62),
        y: cy - b * s.kh * 0.1,
        rot: (Math.PI * 0.5 + b * 0.9) * a * dir,
      };
    });
    if (swing > 0.6 && swing < 1) {
      burst(s.ctx, px, py, s.kh * 0.34, 6, '#fff3c4', idx);
    }
    if (t > 0.9) {
      shout(s, 'ATTENDANCE MANDATORY', s.kx, s.ky - s.kh * 1.7, seg(t, 0.9, 1), 8, '#ffe14a');
    }
  },
  tick(s) {
    for (let i = 0; i < 4; i++) {
      const at = Math.round(s.fdur * (0.08 + (0.8 * (i + 0.72)) / 4));
      if (s.ff === at) {
        s.d.cue('weapon_swing', 1.1 - i * 0.06, 0.5);
        s.d.cue('punch_heavy', 0.9 + i * 0.05, 0.6);
        s.d.hit(3.5 + i * 1.2, 10);
      }
    }
  },
};

// ── RETURN POLICY — thrown flat, and it comes home through the same people ────

FLOURISH_VISUALS.boomerang = {
  strike: 0.44,
  reach: 'lane',
  draw(s) {
    const t = s.ft;
    const wind = seg(t, 0, 0.16);
    const out = seg(t, 0.16, 0.5);
    const home = seg(t, 0.5, 0.84);
    const grab = seg(t, 0.84, 1);
    const dir = s.dir;
    aftermath(s);

    const kp = P(1);
    const w = easeOut(wind) * (1 - out);
    const f = easeOut(out);
    if (grab > 0.3) {
      arms(kp, -0.35, 0.45, -1.3, 0.5);
      hands(kp, 0, -0.4);
      spine(kp, -0.05, -0.05, 0.03, 0.05);
      legs(kp, 0.1, 0.2, -0.12, 0.22);
    } else {
      spine(kp, -0.2 * w + 0.24 * f, -0.14 * w + 0.16 * f, 0.05, -0.1 * w);
      arms(kp, -0.4, 0.45, lerp(-1.9, 1.3, f) - w * 0.4, lerp(0.7, 0.15, f));
      legs(kp, -0.2 * w + 0.3 * f, 0.3, 0.24 * w - 0.24 * f, 0.36, 0.1, 0.1);
      hips(kp, 0.2 * f, 0, -1.1 * f);
    }
    kill(s, 0, 0, kp);

    const hx = handX(s, lerp(-1.9, 1.3, f), 0.5);
    const hy = handY(s, lerp(-1.9, 1.3, f), 0.5);
    const len = Math.min(200, Math.max(90, Math.abs(s.tx - s.kx) + 40));

    if (out > 0 && grab < 1) {
      // Out low and flat, round the far end, and back at head height, so the
      // two passes never sit on top of each other.
      const goingOut = home <= 0;
      const u = goingOut ? easeOut(out) : easeIn(home);
      const px = goingOut
        ? lerp(hx, hx + dir * len, u)
        : lerp(hx + dir * len, hx, u);
      const py = goingOut
        ? lerp(hy, hy - s.kh * 0.1, u) + Math.sin(u * Math.PI) * s.kh * 0.22
        : lerp(hy - s.kh * 0.1, hy, u) - Math.sin(u * Math.PI) * s.kh * 0.5;
      const spun = (out * 12 + home * 12) * dir;

      // The flight path, dotted, so the return reads as a return.
      s.ctx.save();
      s.ctx.globalAlpha *= 0.22;
      for (let i = 0; i <= 10; i++) {
        const b = i / 10;
        ellipse(
          s.ctx,
          lerp(hx, hx + dir * len, b),
          lerp(hy, hy - s.kh * 0.1, b) + Math.sin(b * Math.PI) * s.kh * (goingOut ? 0.22 : -0.5),
          1.1, 1.1, 0, '#cfc8e0', 'none',
        );
      }
      s.ctx.restore();

      trophyTrail(s, s.reduced ? 2 : 5, (i) => {
        const b = clamp(u - i * 0.06, 0, 1);
        const bx = goingOut ? lerp(hx, hx + dir * len, b) : lerp(hx + dir * len, hx, b);
        const by = goingOut
          ? lerp(hy, hy - s.kh * 0.1, b) + Math.sin(b * Math.PI) * s.kh * 0.22
          : lerp(hy - s.kh * 0.1, hy, b) - Math.sin(b * Math.PI) * s.kh * 0.5;
        return { x: bx, y: by, rot: spun - i * 0.6 * dir };
      });
    } else if (grab >= 1) {
      drawTrophy(s, hx, hy, -0.2 * dir);
    } else {
      drawTrophy(s, hx, hy, lerp(-0.4, 0.4, w) * dir);
    }

    if (grab > 0.1 && grab < 0.7) {
      burst(s.ctx, hx, hy, s.kh * 0.3 * Math.sin((grab / 0.7) * Math.PI), 6, '#fff3c4', 0.6);
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.17)) s.d.cue('whiff', 0.8);
    if (s.ff > s.fdur * 0.18 && s.ff < s.fdur * 0.84 && s.ff % 6 === 0) {
      s.d.cue('chain_whip', 1.5, 0.12);
    }
    if (at(0.86)) s.d.cue('pickup', 0.9, 0.6);
  },
};

// ── SLAM DUNK — up, hang there too long, down onto somebody's head ────────────

FLOURISH_VISUALS.slam_dunk = {
  strike: 0.62,
  reach: 'point',
  draw(s) {
    const t = s.ft;
    const crouch = seg(t, 0, 0.16);
    const rise = seg(t, 0.16, 0.42);
    const hang = seg(t, 0.42, 0.58);
    const down = seg(t, 0.58, 0.64);
    const land = seg(t, 0.64, 0.86);
    const dir = s.dir;
    aftermath(s);

    // Toward the target and up, hang, then everything down at once.
    const travel = easeInOut(clamp(rise + down * 0.4, 0, 1));
    const kx = lerp(s.kx, s.tx - s.dir * s.kh * 0.5, travel);
    const air = easeOut(rise) * (1 - easeIn(down)) - crouch * 0.06;
    // The landing bounce, which is the only reason the floor reads as solid.
    const ky = s.ky - air * s.kh * 1.35 + (land > 0 && land < 1 ? Math.sin(land * Math.PI) * 2 : 0);

    const kp = air > 0.1 ? poseHoist(1, clamp(air * 1.4, 0, 1)) : poseKneel(1, crouch * 0.5);
    if (down > 0 && land <= 0) {
      const d = easeIn(down);
      arms(kp, -2.1 + d * 3.4, 0.2, -2.15 + d * 3.45, 0.2);
      spine(kp, -0.2 + d * 0.9, -0.14 + d * 0.6, 0.05, -0.2 + d * 0.7);
      legs(kp, 0.6, 1.1, 0.5, 1.0, 0.3, 0.3);
    }
    actor(s, s.killer, kx, ky, kp, s.dir, s.ks);

    const armAng = air > 0.1 && down <= 0 ? -2.2 : lerp(-2.2, 1.1, easeIn(down));
    const px = kx + dir * (s.kh * 0.05 + Math.sin(armAng) * s.kh * 0.52);
    const py = ky - s.kh * 0.78 + Math.cos(armAng) * s.kh * 0.52;

    if (hang > 0.1 && down <= 0) {
      // The hang. Held one beat longer than physics would like.
      s.ctx.save();
      s.ctx.globalAlpha *= 0.3 * Math.sin(hang * Math.PI);
      for (let i = 1; i <= 3; i++) {
        ellipse(s.ctx, kx, ky + i * 5, s.kh * 0.3, s.kh * 0.05, 0, '#cfc8e0', 'none');
      }
      s.ctx.restore();
    }
    if (down > 0 && down < 1) {
      lineSmear(s, px, py - s.kh * 0.9, px, py, Math.max(2, s.kh * 0.12), '#fff6d8', 0.5);
    }
    drawTrophy(s, px, py, armAng * dir + Math.PI * (down > 0.5 ? 0.5 : 0));

    if (land > 0 && land < 1) {
      const k = easeOut(land);
      floorRing(s, kx + dir * s.kh * 0.4, s.gy, s.kh * (0.4 + 2.4 * k), (1 - k) * 0.85);
      burst(s.ctx, px, py, s.kh * 0.8 * (1 - k), 9, '#fff3c4', 0.9);
    }
    if (land > 0.3) {
      shout(s, 'TWO POINTS', kx + dir * 20, ky - s.kh * 1.6, seg(t, 0.7, 1), 9, '#ffe14a');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.17)) s.d.cue('jump', 0.9, 0.7);
    if (at(0.59)) s.d.cue('whiff', 0.6);
    if (at(0.63)) {
      s.d.cue('bone_crack', 0.7);
      s.d.cue('land', 0.6);
      dust(s, s.tx, s.gy, 18, 3);
    }
  },
};

// ── DRUM SOLO — two guards, one femur, alternating ───────────────────────────

FLOURISH_VISUALS.drum_solo = {
  strike: 0.5,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const ready = seg(t, 0, 0.1);
    const solo = seg(t, 0.1, 0.86);
    const finish = seg(t, 0.88, 1);
    const dir = s.dir;
    aftermath(s);

    const TAPS = 9;
    const phase = solo * TAPS;
    const idx = Math.min(TAPS - 1, Math.floor(phase));
    const k = phase - idx;
    const side = idx & 1 ? -1 : 1;
    const lift = solo > 0 && solo < 1 ? 1 - Math.sin(clamp(k / 0.62, 0, 1) * Math.PI * 0.5) : 1;

    const kp = P(1);
    const bob = solo > 0 && solo < 1 ? Math.sin(phase * Math.PI * 2) * 0.06 : 0;
    spine(kp, -0.08 + bob, -0.06, 0.04, 0.1 + bob * 2);
    arms(
      kp,
      lerp(-0.5, -1.5, side < 0 ? lift : 0.15) - ready * 0.1,
      0.6,
      lerp(-0.5, -1.5, side > 0 ? lift : 0.15),
      0.55,
    );
    hands(kp, -0.2, -0.2);
    legs(kp, 0.1, 0.2, -0.12, 0.22);
    kill(s, 0, solo > 0 && solo < 1 ? bob * 8 : 0, kp);

    // Two heads' worth of drum, implied rather than drawn: the crowd is real
    // and already on screen, so this only owes the eye the impacts.
    for (let i = -1; i <= 1; i += 2) {
      const dx2 = s.kx + i * dir * s.kh * 0.66;
      const dy2 = s.ky - s.kh * 0.92;
      if (i === side && solo > 0 && solo < 1 && k > 0.55) {
        const hitK = clamp((k - 0.55) / 0.3, 0, 1);
        burst(s.ctx, dx2, dy2, s.kh * 0.3 * (1 - hitK), 6, '#fff3c4', idx);
        // A note, leaving. It has nowhere to be.
        s.ctx.save();
        s.ctx.globalAlpha *= 1 - hitK;
        const ny = dy2 - hitK * 16;
        ellipse(s.ctx, dx2 + 4, ny, 2, 1.5, -0.4, '#ffe14a', INK, 0.7);
        capsule(s.ctx, dx2 + 5.6, ny - 0.6, dx2 + 5.6, ny - 6, 0.5, '#ffe14a', 'none');
        s.ctx.restore();
      }
    }

    trophyTrail(s, s.reduced ? 1 : 3, (i) => {
      const b = clamp(lift + i * 0.12, 0, 1);
      const a2 = lerp(-0.5, -1.5, b);
      return {
        x: s.kx + side * dir * (s.kh * 0.06 + Math.sin(a2) * s.kh * 0.46) * -1,
        y: s.ky - s.kh * 0.78 + Math.cos(a2) * s.kh * 0.46,
        rot: (Math.PI * 0.35 + b * 0.5) * side * dir,
        k: 0.85,
      };
    });

    if (finish > 0.1) {
      shout(s, 'TSS', s.kx + dir * 22, s.ky - s.kh * 1.45, finish, 10, '#dff2ff');
    }
  },
  tick(s) {
    const TAPS = 9;
    for (let i = 0; i < TAPS; i++) {
      const at = Math.round(s.fdur * (0.1 + (0.76 * (i + 0.72)) / TAPS));
      if (s.ff === at) {
        s.d.cue('punch_light', 1.5 - (i & 1) * 0.35, 0.4);
        s.d.hit(1.8, 6);
      }
    }
    if (s.ff === Math.round(s.fdur * 0.9)) {
      s.d.cue('hit_metal', 1.9, 0.35);
      s.d.cue('laugh', 1.1, 0.4);
    }
  },
};

// ── MASCOT — wears it, bows, holds the bow far too long ───────────────────────

FLOURISH_VISUALS.mascot = {
  strike: 0.66,
  reach: 'self',
  draw(s) {
    const t = s.ft;
    const raise = seg(t, 0, 0.22);
    const wear = seg(t, 0.22, 0.34);
    const pose2 = seg(t, 0.36, 0.56);
    const bow = seg(t, 0.6, 0.7);
    const hold = seg(t, 0.7, 1);
    const dir = s.dir;
    aftermath(s);

    const b = easeOut(bow) * (1 - hold * 0.06);
    const kp = P(1);
    if (bow > 0) {
      // The bow. From the waist. Held.
      spine(kp, 0.95 * b, 0.6 * b, 0.2 * b, 0.5 * b);
      arms(kp, -0.4 - b * 0.6, 0.4, 1.3 * b - 0.4, 0.3);
      legs(kp, 0.1, 0.24 + b * 0.2, -0.12, 0.26 + b * 0.2);
      hips(kp, 0.3 * b, 0, -1.4 * b);
    } else {
      const p = easeOutBack(clamp(pose2, 0, 1));
      const u = easeOut(raise) * (1 - wear);
      spine(kp, -0.12 * p, -0.1 * p, -0.06, -0.16 * p);
      arms(kp, lerp(-0.4, -1.9, p) - u * 0.4, 0.35, lerp(-2.2 * (1 - wear) - 0.2, -1.95, p), 0.3);
      hands(kp, -0.25, -0.25);
      legs(kp, -0.16 * p, 0.2, 0.2 * p, 0.24);
    }
    kill(s, 0, 0, kp);

    // On the head — which means on the HAT, which is where the rig keeps it.
    const headX = s.kx + dir * s.kh * 0.04;
    const headY = s.ky - s.kh * (1.02 + (bow > 0 ? -0.28 * b : 0));
    if (wear >= 1) {
      const wobble = s.reduced ? 0 : Math.sin(s.ff * 0.18) * 0.05;
      const bowLean = bow > 0 ? b * 0.9 * dir : 0;
      drawTrophy(s, headX + bowLean * s.kh * 0.4, headY + b * s.kh * 0.5, wobble * dir + bowLean, 1.05);
    } else {
      const u = easeOut(Math.max(raise * 0.6, wear));
      const fromA = -2.2;
      drawTrophy(
        s,
        lerp(handX(s, fromA, 0.5), headX, u),
        lerp(handY(s, fromA, 0.5), headY, u),
        lerp(0.5 * dir, 0, u),
        1.05,
      );
    }

    if (pose2 > 0.2 && bow <= 0) {
      // Jazz hands, at a funeral.
      for (let i = 0; i < 4; i++) {
        const k = clamp(pose2 * 2 - i * 0.3, 0, 1);
        if (k <= 0 || k >= 1) continue;
        star(
          s.ctx,
          s.kx + (i - 1.5) * s.kh * 0.4,
          s.ky - s.kh * (1.5 + i * 0.1),
          3 * Math.sin(k * Math.PI),
          5, '#ffe14a', 'none',
        );
      }
    }
    if (hold > 0.3) {
      shout(s, '. . .', s.kx + dir * 24, s.ky - s.kh * 0.9, seg(t, 0.8, 1), 10, '#cfc8e0');
    }
  },
  tick(s) {
    const at = (u: number) => s.ff === Math.round(s.fdur * u);
    if (at(0.24)) s.d.cue('pickup', 0.8, 0.6);
    if (at(0.4)) s.d.cue('ui_select', 1.2, 0.4);
    if (at(0.62)) s.d.cue('laugh', 0.9, 0.6);
    if (at(0.68)) s.d.hit(3, 12);
    if (at(0.86)) s.d.cue('ui_error', 0.6, 0.4);
  },
};
