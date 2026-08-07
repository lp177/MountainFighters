/**
 * The whole cast, drawn from vector geometry. Dwarfs, guards, robots and
 * bosses all come through here — the only thing that changes is the RigStyle
 * and the skeleton.
 *
 * `style.outfit` is a continuous 0..1 blend from the classic film dwarf (tunic,
 * soft cap, rosy cheeks) to the bad boy (spiked leather, studded belt, shades,
 * cigar). The hat survives at both ends: it is the one thing that keeps each
 * dwarf recognisable as himself.
 *
 * An optional `RigDamage` lays a second axis over all of that: the face changes
 * expression, the chest heaves, the wardrobe comes apart in stages and the
 * blood lands on top. See the damage section below for the rules it plays by.
 */

import type {
  Bone,
  BoneName,
  FaceState,
  Facing,
  Pose,
  RigDamage,
  RigStyle,
  WeaponDef,
} from '@/core/types';
import { clamp, easeOutBack, lerp, TAU } from '@/core/math';
import {
  burst,
  capsule,
  ellipse,
  limb,
  poly,
  roundRect,
  spikeStrip,
  star,
  zigzag,
} from '@/render/Shapes';
import { resolvePose } from '@/render/rig/Skeleton';
import type { ResolvedBone } from '@/render/rig/Skeleton';

type C2D = CanvasRenderingContext2D;

interface Pt {
  x: number;
  y: number;
}

/** Every outline in the game is this near-black. It is what glues the look. */
const INK = '#191320';
/** Shapes.ts sentinel: skip the stroke entirely. Detail marks are fill-only. */
const NO = 'none';
/** Contact shadow ink. Cool near-black, never pure black — see contactShadow. */
const SHADOW = '#0e0b16';

// ─────────────────────────────────────────────────────────────────────────────
// Colour pipeline: ambient tint, black lift, then the white hit-flash
//
// The cast wears black leather and half the campaign is underground, so the
// naive pipeline — a straight tint multiply over an already-black palette —
// rendered fighters darker than the floor they stood on. Three rules fix that
// without touching a single palette entry in content/:
//
//   1. AMBIENT. The map tint is blended toward identity on dark surfaces, so a
//      map can set the mood without crushing the character. Bright surfaces
//      still take it at close to full strength, which is where a tint is
//      actually doing visible work.
//   2. BLACK LIFT. Fills down in the toe of the curve are pulled up toward a
//      very dark blue-grey — true black lands around 12% luma. Leather still
//      reads as near-black, but as a SURFACE with form rather than a hole
//      punched through the screen. The lift makes up only part of the deficit,
//      so shading (near limb against far limb) survives it.
//   3. IDENTIFIERS. Hat, beard/hair, skin and jacket accent are what tell four
//      players apart mid-brawl, so they take almost none of the tint and sit on
//      a higher floor. They stay the anchors the eye tracks.
//
// Outlines opt out of the lift entirely: a dark outline underneath the rim
// light is exactly what makes a vector silhouette pop, and lifting the ink
// would soften every edge in the game.
// ─────────────────────────────────────────────────────────────────────────────

const MODE_FILL = 0;
const MODE_KEY = 1;
const MODE_INK = 2;

/** Rec.709 luma weights. */
const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

/** Tint strength on a dark surface. 0 = ignore the map, 1 = straight multiply. */
const TINT_MIX = 0.5;
/** ...and on an identifier, which should survive any lighting the map picks. */
const KEY_TINT_MIX = 0.22;
/** Luma the tint reaches full strength at. Above this the map tints freely. */
const TINT_FULL_AT = 150;
/**
 * Black lift, as a soft knee rather than a hard floor: `add = d²/knee * gain`
 * where d is how far under the knee the luma landed. The quadratic matters —
 * a hard floor would slam the near limb and the far limb to the same value and
 * flatten the character into a cut-out. This lands true black at ~12% luma,
 * keeps a bit under half the original shading contrast down there, and fades
 * out to nothing by the knee, so mid-tones are untouched.
 */
const LIFT_KNEE = 70;
const LIFT_GAIN = 0.45;
const KEY_LIFT_KNEE = 95;
const KEY_LIFT_GAIN = 0.5;
/** Direction the lift travels in, scaled so it adds exactly 1 luma. Cool, so a
 *  lifted black reads as shadow catching ambient rather than as grey paint. */
const LIFT_R = 0.79;
const LIFT_G = 1.01;
const LIFT_B = 1.49;

/**
 * The back light. Cool, so it reads as bounce off the stage rather than a
 * spotlight bolted to the camera, and opaque so that overlapping body parts
 * cannot stack alpha into bright blotches along the seams.
 */
const RIM = '#8aa0c8';
/** Rim offset in rig units — toward the character's back, and up. Applied
 *  inside the facing flip, so the lit edge follows `facing` for free. */
const RIM_BACK = -1.35;
const RIM_UP = -1.6;
/** Silhouette shapes are drawn this much fatter so the edge survives the ink.
 *  Offset plus pad minus the outline width is the rim you actually see — about
 *  0.8 rig units, a crisp line rather than a slab of paint. */
const RIM_PAD = 0.55;

let flashAmt = 0;
let tintRgb: [number, number, number] | null = null;

const parseCache = new Map<string, [number, number, number]>();
const colCache = new Map<string, string>();

/** Cache-key suffixes, one per mode, rebuilt only when the palette changes. */
let kFill = '||0';
let kKey = '||1';
let kInk = '||2';
/** Resolved once per palette — ink() and the rim are asked for constantly. */
let inkCol = INK;
let rimCol = RIM;
/** Last palette resolved. null, not '', so the first call can never match. */
let lastTint: string | null = null;
let lastFlash = -1;

function rgbOf(c: string): [number, number, number] {
  const hit = parseCache.get(c);
  if (hit) return hit;
  let out: [number, number, number] = [136, 136, 136];
  if (c.charCodeAt(0) === 35) {
    if (c.length >= 7) {
      out = [
        parseInt(c.slice(1, 3), 16),
        parseInt(c.slice(3, 5), 16),
        parseInt(c.slice(5, 7), 16),
      ];
    } else if (c.length >= 4) {
      const r = parseInt(c[1], 16);
      const g = parseInt(c[2], 16);
      const b = parseInt(c[3], 16);
      out = [r * 17, g * 17, b * 17];
    }
  } else {
    const m = /(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)/.exec(c);
    if (m) out = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (Number.isNaN(out[0]) || Number.isNaN(out[1]) || Number.isNaN(out[2])) out = [136, 136, 136];
  parseCache.set(c, out);
  return out;
}

function hex(r: number, g: number, b: number): string {
  const v =
    (clamp(Math.round(r), 0, 255) << 16) |
    (clamp(Math.round(g), 0, 255) << 8) |
    clamp(Math.round(b), 0, 255);
  return `#${v.toString(16).padStart(6, '0')}`;
}

/** Darkens (f < 1) or lifts (f > 1) a colour. Used for the far-side limbs. */
function shadeOf(c: string, f: number): string {
  const [r, g, b] = rgbOf(c);
  return f <= 1 ? hex(r * f, g * f, b * f) : hex(lerp(r, 255, f - 1), lerp(g, 255, f - 1), lerp(b, 255, f - 1));
}

function mixCol(a: string, b: string, t: number): string {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return hex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
}

/**
 * Run every colour through here. Applies the ambient tint, lifts the blacks off
 * the floor, then pushes the result toward flat white for the hit flash, so a
 * flash of 1 still turns the character into a solid white silhouette.
 */
function shadeCol(c: string, mode: number): string {
  const key = c + (mode === MODE_FILL ? kFill : mode === MODE_KEY ? kKey : kInk);
  const hit = colCache.get(key);
  if (hit !== undefined) return hit;

  const src = rgbOf(c);
  let r = src[0];
  let g = src[1];
  let b = src[2];

  if (tintRgb) {
    // Dark surfaces get roughly half the tint; bright ones get nearly all of
    // it. A multiply is fine on skin and brass, ruinous on black leather.
    const lum0 = r * LUM_R + g * LUM_G + b * LUM_B;
    const m =
      mode === MODE_KEY
        ? KEY_TINT_MIX
        : lerp(TINT_MIX, 1, clamp(lum0 / TINT_FULL_AT, 0, 1));
    r *= (255 - (255 - tintRgb[0]) * m) / 255;
    g *= (255 - (255 - tintRgb[1]) * m) / 255;
    b *= (255 - (255 - tintRgb[2]) * m) / 255;
  }

  if (mode !== MODE_INK) {
    const knee = mode === MODE_KEY ? KEY_LIFT_KNEE : LIFT_KNEE;
    const lum = r * LUM_R + g * LUM_G + b * LUM_B;
    if (lum < knee) {
      const d = knee - lum;
      const add = ((d * d) / knee) * (mode === MODE_KEY ? KEY_LIFT_GAIN : LIFT_GAIN);
      r += add * LIFT_R;
      g += add * LIFT_G;
      b += add * LIFT_B;
    }
  }

  if (flashAmt > 0) {
    r = lerp(r, 255, flashAmt);
    g = lerp(g, 255, flashAmt);
    b = lerp(b, 255, flashAmt);
  }

  const out = hex(r, g, b);
  colCache.set(key, out);
  return out;
}

/** Ordinary surface: tinted by the map, floored off true black. */
function col(c: string): string {
  return shadeCol(c, MODE_FILL);
}

/**
 * An identifier — hat, beard, hair, skin, jacket accent. These are the four
 * things that say WHICH dwarf during a four-player brawl, so they shrug off
 * most of the ambient darkening and sit on a higher floor.
 */
function keyCol(c: string): string {
  return shadeCol(c, MODE_KEY);
}

function ink(): string {
  return inkCol;
}

/**
 * Sets the module-wide colour state for one character. Cheap to call with
 * arguments it already has — a screen full of fighters shares one map tint.
 */
function setPalette(tint: string | undefined, flash: number): void {
  const t = tint ?? '';
  if (t === lastTint && flash === lastFlash) return;
  lastTint = t;
  lastFlash = flash;
  flashAmt = flash;
  tintRgb = tint ? rgbOf(tint) : null;
  // The tint is part of the key: two maps must never share cached entries.
  const p = `|${t}|${flash > 0 ? flash.toFixed(2) : ''}`;
  kFill = `${p}0`;
  kKey = `${p}1`;
  kInk = `${p}2`;
  if (colCache.size > 2048) colCache.clear();
  inkCol = shadeCol(INK, MODE_INK);
  rimCol = shadeCol(RIM, MODE_KEY);
}

/**
 * spikeStrip inks its own outlines, which would punch dark lines through the
 * hit-flash silhouette — so above half flash we draw the studs flat instead.
 */
function studs(
  ctx: C2D,
  x1: number, y1: number, x2: number, y2: number,
  count: number, size: number, color: string,
): void {
  if (flashAmt < 0.5) {
    spikeStrip(ctx, x1, y1, x2, y2, count, size, color);
    return;
  }
  const n = Math.max(1, count | 0);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l = Math.hypot(dx, dy);
  if (l < 0.001 || size <= 0) return;
  const ux = dx / l;
  const uy = dy / l;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : (i + 0.5) / n;
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    poly(
      ctx,
      [
        px - ux * size * 0.62, py - uy * size * 0.62,
        px - uy * size * 1.15, py + ux * size * 1.15,
        px + ux * size * 0.62, py + uy * size * 0.62,
      ],
      color,
      color,
      1,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage — the same character, chewed up
//
// A beaten fighter is not a second set of art. Everything here is a modifier on
// the rig that already exists: the face swaps expression, the chest heaves, the
// wardrobe loses material in stages, and blood lands on top of all of it.
//
// The three inputs are independent on purpose. `wear` is what the fight did to
// his CLOTHES, `blood` is what it did to HIM, and `breath` is what he has LEFT,
// so a fighter can be immaculate and gasping, or shredded and barely marked.
//
// GORE SETTING. This file never invents blood. `Settings.gore === 'off'` arrives
// as `blood: 0` and every red mark below is gated on that number — the hits, the
// tearing and the exhaustion all still read, bloodlessly. 'max' arrives as a
// bigger number and everything scales with it for free.
//
// DETERMINISM. Tears, stains, bruises and which sleeve goes first are hashed out
// of `RigDamage.seed`, never out of a frame counter, so they sit still on the
// cloth instead of crawling. The only things allowed to move with the wall clock
// are the breath, the sweat and the dazed spiral, which are presentation and
// obey `reducedMotion`.
// ─────────────────────────────────────────────────────────────────────────────

/** Deep and a little purple. Pure red reads as plastic at this size. */
const BLOOD = '#9e1420';
const BLOOD_DK = '#5c0a12';
// What a machine leaks. Same marks, same numbers — a robot that has been hit
// enough to bleed should look it — but hydraulic fluid, not arterial spray.
const OIL = '#241f28';
const OIL_DK = '#0f0d13';
const OIL_WET = '#3b3340';
/** Fresh, wet, still moving. */
const BLOOD_WET = '#cf2230';

/** Whichever of the two the body in hand is full of. See `RigDamage.oil`. */
function leak(d: { oil: boolean }): readonly [string, string, string] {
  return d.oil ? [OIL, OIL_DK, OIL_WET] : [BLOOD, BLOOD_DK, BLOOD_WET];
}
/** A bruise at full ripeness; mixed back toward the skin by how fresh it is. */
const BRUISE = '#43214f';
const SWEAT = '#a8cfe8';
/** Scuffs and ground-in dirt. Not blood, so it survives gore: 'off'. */
const DIRT = '#2f2833';
/** The inside of a shouting mouth. */
const MAW = '#2a0d14';
const TEETH = '#f2ece0';
const TONGUE = '#c0505f';

interface Dmg {
  /** False when the caller passed no RigDamage at all: skip every extra pass. */
  on: boolean;
  wear: number;
  blood: number;
  /** True where the marks are hydraulic fluid rather than blood. */
  oil: boolean;
  breath: number;
  seed: number;
  face: FaceState;
  hatless: boolean;
  reduced: boolean;
  /** -1..1 breathing oscillation, already reduced-motion aware. */
  heave: number;
  /** 0..1 postural collapse: forward hunch, dropped head, loose elbows. */
  slump: number;
  /** Wall-clock seconds. Presentation only — the sim never sees this file. */
  t: number;
  /** Wear stages, each 0..1 and overlapping: scuffed, ripped, shredded. */
  t1: number;
  t2: number;
  t3: number;
}

const NEUTRAL_DMG: Dmg = {
  on: false, wear: 0, blood: 0, oil: false, breath: 0, seed: 0, face: 'calm', hatless: false,
  reduced: false, heave: 0, slump: 0, t: 0, t1: 0, t2: 0, t3: 0,
};

/** Refilled once per character. drawCharacter is never re-entrant. */
const DMG: Dmg = { ...NEUTRAL_DMG };

/** Stable hash in [0,1) from a fighter seed and a slot index. */
function hashf(seed: number, i: number): number {
  let x = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 1, 0x85ebca77);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 13), 0x297a2d39);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** ...and the same, in [-1,1). */
function hashs(seed: number, i: number): number {
  return hashf(seed, i) * 2 - 1;
}

/** Where `v` sits inside a wear stage, 0 before it starts and 1 once it is done. */
function stage(v: number, a: number, b: number): number {
  return clamp((v - a) / (b - a), 0, 1);
}

function nowSec(): number {
  return typeof performance === 'undefined' ? 0 : performance.now() * 0.001;
}

/**
 * Fallback for a caller that does not thread the setting through: `Ui`
 * mirrors `Settings.reducedMotion` onto <html> already, so the rig can read it
 * from there rather than quietly ignoring it. Cached, because this would
 * otherwise be a DOM read once per character per frame.
 */
let motionCache = false;
let motionCheckedAt = -1;

function domReducedMotion(t: number): boolean {
  if (typeof document === 'undefined') return false;
  if (motionCheckedAt < 0 || t < motionCheckedAt || t - motionCheckedAt > 0.25) {
    motionCheckedAt = t;
    motionCache = document.documentElement.classList.contains('reduced-motion');
  }
  return motionCache;
}

function fillDamage(src: RigDamage | undefined, want: boolean | undefined): Dmg {
  const t = nowSec();
  const reduced = want ?? domReducedMotion(t);
  if (!src) {
    DMG.on = false;
    DMG.wear = 0;
    DMG.blood = 0;
    DMG.oil = false;
    DMG.breath = 0;
    DMG.seed = 0;
    DMG.face = 'calm';
    DMG.hatless = false;
    DMG.reduced = reduced;
    DMG.heave = 0;
    DMG.slump = 0;
    DMG.t = 0;
    DMG.t1 = 0;
    DMG.t2 = 0;
    DMG.t3 = 0;
    return DMG;
  }

  const wear = clamp(src.wear, 0, 1);
  const breath = clamp(src.breath, 0, 1);
  const seed = src.seed | 0;
  DMG.on = true;
  DMG.wear = wear;
  DMG.blood = clamp(src.blood, 0, 1);
  DMG.oil = src.oil === true;
  DMG.breath = breath;
  DMG.seed = seed;
  DMG.face = src.face;
  DMG.hatless = src.hatless === true;
  DMG.reduced = reduced;
  DMG.t1 = stage(wear, 0.1, 0.4);
  DMG.t2 = stage(wear, 0.36, 0.68);
  DMG.t3 = stage(wear, 0.62, 0.96);
  DMG.t = t;
  // Two oscillators at FIXED rates, crossfaded — not one oscillator whose rate
  // climbs. A moving frequency slews the phase every time health changes, and
  // the chest visibly stutters. Crossfading two sines that are already out of
  // phase gives a ragged, uneven heave, which is exactly what panting is.
  const ph = hashf(seed, 3) * TAU;
  const slow = Math.sin(t * 2.5 + ph);
  const fast = Math.sin(t * 9.6 + ph * 1.7);
  const amp = 0.2 + 0.8 * breath;
  DMG.heave = lerp(slow, fast, breath * breath) * amp * (reduced ? 0.28 : 1);
  // Reduced motion damps the OSCILLATION but never the POSTURE: a player who
  // turned the shaking off still has to be able to see that he is nearly out.
  const s = stage(breath, 0.28, 1);
  DMG.slump = clamp(s * s * (src.face === 'exhausted' ? 1.35 : 1) + wear * 0.12, 0, 1);
  return DMG;
}

// ── Damage posture ───────────────────────────────────────────────────────────
//
// The heave is applied to the SKELETON rather than to the drawing, so the rim
// light, the jacket, the arms and the held weapon all move with the chest for
// free. The caller's pose is copied into a scratch that is allocated once.

interface Bp {
  rot: number;
  x: number;
  y: number;
  scale: number;
}

const BONES_ALL: BoneName[] = [
  'root', 'pelvis', 'torso', 'chest', 'neck', 'head', 'hat', 'beard',
  'armL_upper', 'armL_lower', 'handL', 'armR_upper', 'armR_lower', 'handR',
  'legL_upper', 'legL_lower', 'footL', 'legR_upper', 'legR_lower', 'footR',
];

const SB = {} as Record<BoneName, Bp>;
const POSE_SCRATCH: Pose = {};
for (let i = 0; i < BONES_ALL.length; i++) {
  const bp: Bp = { rot: 0, x: 0, y: 0, scale: 1 };
  SB[BONES_ALL[i]] = bp;
  POSE_SCRATCH[BONES_ALL[i]] = bp;
}

/**
 * The caller's pose with the breathing and the slump laid over it. Nothing here
 * touches the pelvis or the legs: dropping the hips would push the feet through
 * the floor, so the collapse is spent entirely on the spine and the shoulders.
 */
function damagePose(pose: Pose, d: Dmg): Pose {
  if (!d.on) return pose;
  const loll = d.face === 'dazed' ? 0.16 : d.face === 'exhausted' ? 0.09 : 0;
  if (d.breath <= 0.001 && d.slump <= 0.001 && loll <= 0) return pose;

  for (let i = 0; i < BONES_ALL.length; i++) {
    const n = BONES_ALL[i];
    const src = pose[n];
    const bp = SB[n];
    bp.rot = src?.rot ?? 0;
    bp.x = src?.x ?? 0;
    bp.y = src?.y ?? 0;
    bp.scale = src?.scale ?? 1;
  }

  const hv = d.heave;
  const b = d.breath;
  const sl = d.slump;

  // Whole upper body rides the inhale; the spine folds forward as he tires.
  SB.torso.y += hv * (0.3 + 1.2 * b);
  SB.torso.rot -= sl * 0.13;
  SB.chest.rot += hv * 0.03 - sl * 0.1;
  SB.neck.rot -= sl * 0.17;
  SB.head.rot -= sl * 0.08;

  // Shoulders. The single most readable part of being out of breath.
  const rise = hv * (0.5 + 1.7 * b);
  SB.armL_upper.y += rise;
  SB.armR_upper.y += rise;
  SB.neck.y += rise * 0.3;
  SB.armL_upper.rot -= hv * 0.035 + sl * 0.05;
  SB.armR_upper.rot += hv * 0.035 - sl * 0.05;
  SB.armL_lower.rot += sl * 0.12;
  SB.armR_lower.rot += sl * 0.12;

  if (loll > 0) {
    const w = d.reduced ? 0.5 : Math.sin(d.t * 1.7 + hashf(d.seed, 5) * TAU);
    SB.head.rot += w * loll;
    SB.neck.rot += w * loll * 0.4;
  }
  return POSE_SCRATCH;
}

// ── Damage marks ─────────────────────────────────────────────────────────────

/** A tear: a lens of whatever is UNDERNEATH, ink-outlined so it reads as a hole. */
const RIP_PTS: number[] = new Array<number>(8).fill(0);

function rip(ctx: C2D, x: number, y: number, ang: number, l: number, w: number, under: string, ow: number): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const hx = ca * l * 0.5;
  const hy = sa * l * 0.5;
  RIP_PTS[0] = x - hx;
  RIP_PTS[1] = y - hy;
  RIP_PTS[2] = x - hx * 0.2 - sa * w;
  RIP_PTS[3] = y - hy * 0.2 + ca * w;
  RIP_PTS[4] = x + hx;
  RIP_PTS[5] = y + hy;
  RIP_PTS[6] = x + hx * 0.25 + sa * w * 0.75;
  RIP_PTS[7] = y + hy * 0.25 - ca * w * 0.75;
  poly(ctx, RIP_PTS, under, ink(), ow);
}

/** A flap of cloth hanging off a torn edge. */
const TATTER_PTS: number[] = new Array<number>(6).fill(0);

function tatter(ctx: C2D, x: number, y: number, dx: number, dy: number, w: number, c: string, ow: number): void {
  TATTER_PTS[0] = x - w;
  TATTER_PTS[1] = y;
  TATTER_PTS[2] = x + dx;
  TATTER_PTS[3] = y + dy;
  TATTER_PTS[4] = x + w;
  TATTER_PTS[5] = y;
  poly(ctx, TATTER_PTS, c, ink(), ow);
}

/**
 * Ground-in scratches scattered along a limb or a panel, all in one path.
 * Dirt, not blood — this is the part of the damage that gore: 'off' keeps.
 */
function scuffs(r: Rig, a: Pt, b: Pt, wide: number, n: number, salt: number): void {
  const t = r.d.t1;
  if (t <= 0.05 || n <= 0) return;
  const ctx = r.ctx;
  const seed = r.d.seed;
  const cnt = Math.max(1, Math.round(n * t));
  const pd = perp(a, b);
  ctx.strokeStyle = col(DIRT);
  ctx.lineWidth = Math.max(0.5, 0.42 * r.u);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < cnt; i++) {
    const f = 0.14 + 0.72 * hashf(seed, salt + i);
    const s = hashs(seed, salt + 41 + i) * wide;
    const px = lerp(a.x, b.x, f) + pd.x * s;
    const py = lerp(a.y, b.y, f) + pd.y * s;
    const ang = hashf(seed, salt + 83 + i) * TAU;
    const l = (0.8 + 1.3 * hashf(seed, salt + 127 + i)) * r.u;
    ctx.moveTo(px - Math.cos(ang) * l, py - Math.sin(ang) * l);
    ctx.lineTo(px + Math.cos(ang) * l, py + Math.sin(ang) * l);
  }
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rig plumbing
// ─────────────────────────────────────────────────────────────────────────────

interface Rig {
  ctx: C2D;
  st: RigStyle;
  bones: Map<BoneName, ResolvedBone>;
  len: Map<BoneName, number>;
  /** Pixels per rig unit. */
  u: number;
  /** Outline width. */
  ow: number;
  /** style.outfit, clamped. */
  fit: number;
  girth: number;
  /** How chewed up he is. Always present; `on` is false for a fresh fighter. */
  d: Dmg;
}

const ZERO: ResolvedBone = { name: 'root', x: 0, y: 0, rot: 0, scale: 1 };

function bone(r: Rig, n: BoneName): ResolvedBone {
  return r.bones.get(n) ?? ZERO;
}

/** Joint position in canvas-local space (rig +y is up, canvas +y is down). */
function jp(r: Rig, n: BoneName): Pt {
  const b = bone(r, n);
  return { x: b.x, y: -b.y };
}

/** Point a fraction `f` along the bone, in canvas-local space. */
function tp(r: Rig, n: BoneName, f = 1): Pt {
  const b = bone(r, n);
  const l = (r.len.get(n) ?? 0) * b.scale * f;
  return { x: b.x - l * Math.sin(b.rot), y: -(b.y + l * Math.cos(b.rot)) };
}

function mid(a: Pt, b: Pt, t = 0.5): Pt {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function perp(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: -dy / l, y: dx / l };
}

function len2(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function off(p: Pt, d: Pt, s: number): Pt {
  return { x: p.x + d.x * s, y: p.y + d.y * s };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export function drawCharacter(
  ctx: C2D,
  style: RigStyle,
  pose: Pose,
  skeleton: Bone[],
  x: number,
  y: number,
  facing: Facing,
  opts?: {
    weapon?: WeaponDef | null;
    flash?: number;
    tint?: string;
    alpha?: number;
    scale?: number;
    /**
     * How far through the mincer this one is. Omit for an untouched character —
     * the select screen, the menus and the cutscenes all leave it off and get
     * exactly the art they had before.
     */
    damage?: RigDamage;
    /**
     * Settings.reducedMotion: keeps the damage POSTURE, drops the wobble.
     * Omit it and the rig reads the same flag off <html>, which `Ui` keeps in
     * sync — the setting is honoured whether or not a caller remembers it.
     */
    reducedMotion?: boolean;
  },
): void {
  const d = fillDamage(opts?.damage, opts?.reducedMotion);
  const u = (opts?.scale ?? 1) * (style.scale || 1);
  const bones = resolvePose(skeleton, damagePose(pose, d), u);

  setPalette(opts?.tint, clamp(opts?.flash ?? 0, 0, 1));

  const len = new Map<BoneName, number>();
  for (const b of skeleton) len.set(b.name, b.length);

  const r: Rig = {
    ctx,
    st: style,
    bones,
    len,
    u,
    ow: Math.max(1, 1.35 * u),
    fit: clamp(style.outfit, 0, 1),
    girth: style.girth || 1,
    d,
  };

  ctx.save();
  ctx.globalAlpha *= clamp(opts?.alpha ?? 1, 0, 1);

  // Contact shadow at the rig's ground point, tightening as the pose lifts off.
  const lift = Math.max(0, bone(r, 'root').y);
  const rise = clamp(lift / (26 * u), 0, 1);
  const foot = Math.max(jp(r, 'footL').y, jp(r, 'footR').y);
  contactShadow(
    ctx,
    x + lift * 0.12,
    y + Math.max(0, foot) + lift,
    9 * u * r.girth * (1 - rise * 0.45),
    0.34 * (1 - rise * 0.6),
  );

  ctx.translate(x, y);
  ctx.scale(facing, 1);

  drawRim(r);
  drawArm(r, false);
  drawLeg(r, false);
  drawTorso(r);
  drawLeg(r, true);
  drawArm(r, true);
  if (opts?.weapon) drawHeldWeapon(r, opts.weapon);
  drawHead(r);
  // The hat is the last thing he owns, so losing it is worth its own art.
  if (d.hatless) drawFlatHair(r);
  else drawHat(r);
  drawBeard(r);
  // An open mouth punches THROUGH the beard — a dwarf yelling into his own
  // whiskers is the whole joke, and a mouth drawn under them is no expression
  // at all on five of the seven.
  drawFaceOver(r);
  drawAccessories(r);
  drawGoreOver(r);

  ctx.restore();
  // Loose weapons and pickups draw through drawWeapon() with no character
  // around them, so the tint and the flash must not leak out of here.
  setPalette(undefined, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Separation passes: the contact shadow below, the rim light behind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two soft rings rather than one flat disc. A single black ellipse either
 * disappears on a dark stage or sits on a bright one like a sticker; a dense
 * core inside a wide, faint skirt anchors the feet on both, and the cool
 * near-black keeps it from reading as a hole in the floor.
 */
function contactShadow(ctx: C2D, x: number, y: number, rx: number, a: number): void {
  const r = Math.abs(rx);
  if (r < 0.01 || a <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp(a * 0.45, 0, 1);
  ellipse(ctx, x, y, r * 1.32, r * 0.45, 0, SHADOW, NO);
  ctx.globalAlpha = prev * clamp(a * 0.9, 0, 1);
  ellipse(ctx, x, y, r * 0.74, r * 0.25, 0, SHADOW, NO);
  ctx.globalAlpha = prev;
}

/**
 * The back light, and the single most effective thing in this file.
 *
 * A copy of the major masses — limbs, torso, neck, skull, hat, beard — offset
 * toward the character's upper back and drawn UNDERNEATH the character, so
 * everything except a bright edge along the silhouette is immediately painted
 * over. A dark outline against a dark mine wall is invisible; the same outline
 * with a lit edge behind it is a character standing in front of a mine wall.
 *
 * It runs inside the `ctx.scale(facing, 1)` flip, so the lit edge swaps sides
 * with the character at no cost. Fills only, no strokes, ~15 paths.
 */
function drawRim(r: Rig): void {
  const ctx = r.ctx;
  const c = rimCol;
  const pad = RIM_PAD * r.u;
  ctx.save();
  ctx.translate(RIM_BACK * r.u, RIM_UP * r.u);
  rimLeg(r, false, c, pad);
  rimArm(r, false, c, pad);
  rimBody(r, c, pad);
  rimLeg(r, true, c, pad);
  rimArm(r, true, c, pad);
  rimHead(r, c, pad);
  ctx.restore();
}

function rimLeg(r: Rig, near: boolean, c: string, pad: number): void {
  const ctx = r.ctx;
  const s = near ? 'R' : 'L';
  const dx = near ? 0 : -0.9 * r.u;
  const hip = jp(r, `leg${s}_upper` as BoneName);
  const knee = jp(r, `leg${s}_lower` as BoneName);
  const ankle = jp(r, `foot${s}` as BoneName);
  const toe = tp(r, `foot${s}` as BoneName);
  const g = r.u * r.girth;
  limb(ctx, hip.x + dx, hip.y, knee.x + dx, knee.y, 3.7 * g + pad, 3.0 * g + pad, c, NO);
  limb(ctx, knee.x + dx, knee.y, ankle.x + dx, ankle.y, 3.0 * g + pad, 2.4 * g + pad, c, NO);
  capsule(ctx, ankle.x + dx, ankle.y, toe.x + dx, toe.y, 2.4 * r.u + pad, c, NO);
}

function rimArm(r: Rig, near: boolean, c: string, pad: number): void {
  const ctx = r.ctx;
  const s = near ? 'R' : 'L';
  const dx = near ? 0 : -1.1 * r.u;
  const sh = jp(r, `arm${s}_upper` as BoneName);
  const el = jp(r, `arm${s}_lower` as BoneName);
  const wr = jp(r, `hand${s}` as BoneName);
  const hand = mid(wr, tp(r, `hand${s}` as BoneName), 0.42);
  const g = r.u * r.girth;
  limb(ctx, sh.x + dx, sh.y, el.x + dx, el.y, 3.5 * g + pad, 2.8 * g + pad, c, NO);
  limb(ctx, el.x + dx, el.y, wr.x + dx, wr.y, 2.7 * g + pad, 2.3 * g + pad, c, NO);
  ellipse(ctx, hand.x + dx, hand.y, 2.5 * g + pad, 2.4 * g + pad, 0, c, NO);
}

function rimBody(r: Rig, c: string, pad: number): void {
  const ctx = r.ctx;
  const P = jp(r, 'pelvis');
  const N = jp(r, 'neck');
  const H = jp(r, 'head');
  const hw = (len2(P, N) || r.u) * 0.42 * r.girth;
  // One capsule covering both the body mass and the jacket hem below it.
  const a = mid(P, N, 0);
  const b = mid(P, N, 0.87);
  capsule(ctx, a.x, a.y, b.x, b.y, hw * 1.04 + pad, c, NO);
  capsule(ctx, N.x, N.y, H.x, H.y, 2.1 * r.u * r.girth + pad, c, NO);
}

function rimHead(r: Rig, c: string, pad: number): void {
  const ctx = r.ctx;
  const h = headFrame(r);
  ellipse(ctx, h.c.x, h.c.y, h.rx + pad, h.ry + pad, h.ang, c, NO);

  // A cone-shaped sliver of back light hanging over a bald head is worse than
  // no rim at all, so the hatless silhouette is the flattened hair instead.
  if (r.d.hatless) {
    ellipse(ctx, h.c.x, h.c.y - h.ry * 0.66, h.rx * 1.04 + pad, h.ry * 0.4 + pad, h.ang, c, NO);
  } else {
    const f = hatFrame(r);
    hatCone(f, pad, HAT_PTS);
    poly(ctx, HAT_PTS, c, NO);
    const b1 = off(f.base, f.side, f.w * 1.06);
    const b2 = off(f.base, f.side, -f.w * 1.06);
    capsule(ctx, b1.x, b1.y, b2.x, b2.y, f.w * 0.24 + pad, c, NO);
    ellipse(ctx, f.tip.x, f.tip.y, f.w * 0.25 + pad, f.w * 0.25 + pad, 0, c, NO);
  }

  // The beard is deliberately approximated small: it hangs down and forward,
  // away from the lit edge, and an oversized guess here would leave bright
  // slivers floating past the chin.
  if (r.st.beardStyle === 'none') return;
  const chin = jp(r, 'beard');
  const end = tp(r, 'beard', clamp(r.st.beardLength || 1, 0.25, 2.2));
  const l = len2(chin, end) || r.u;
  const m = mid(chin, end, 0.34);
  ellipse(
    ctx, m.x, m.y, l * 0.42 + pad, h.rx * 0.56 + pad,
    Math.atan2(end.y - chin.y, end.x - chin.x), c, NO,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wardrobe: every colour is a blend along `fit`
// ─────────────────────────────────────────────────────────────────────────────

function garmentCol(r: Rig): string {
  return mixCol(r.st.tunicColor, r.st.jacketColor, r.fit);
}

function pantsCol(r: Rig): string {
  return mixCol(shadeOf(r.st.tunicColor, 0.62), shadeOf(r.st.tunicColor, 0.32), r.fit);
}

function bootCol(r: Rig): string {
  return mixCol('#6d4523', '#17151c', r.fit);
}

function beltCol(r: Rig): string {
  return mixCol('#4a3320', '#141118', r.fit);
}

/** How far the spikes have popped out, with a little overshoot on the way. */
/** Bare skin, shaded for how far from the camera the part is. */
function skinTone(r: Rig, f: number): string {
  return keyCol(shadeOf(r.st.skin, f));
}

/** How far the shades have slid down onto the nose. Needed before they draw. */
function shadesT(r: Rig): number {
  return r.st.shades ? clamp((r.fit - 0.42) / 0.34, 0, 1) : 0;
}

function spikePop(r: Rig): number {
  const t = clamp((r.fit - 0.28) / 0.42, 0, 1);
  return t <= 0 ? 0 : easeOutBack(t);
}

function spikeCount(r: Rig): number {
  const n = clamp(Math.round(r.st.spikes), 0, 9);
  // Studs are the first thing to go: they are riveted to leather that is being
  // torn off him. Purely a function of wear, so it never flickers.
  const lost = Math.round(n * stage(r.d.wear, 0.22, 0.85) * 0.85);
  return Math.max(0, n - lost);
}

// ─────────────────────────────────────────────────────────────────────────────
// Limbs
// ─────────────────────────────────────────────────────────────────────────────

function drawLeg(r: Rig, near: boolean): void {
  const ctx = r.ctx;
  const s = near ? 'R' : 'L';
  const hip = jp(r, `leg${s}_upper` as BoneName);
  const knee = jp(r, `leg${s}_lower` as BoneName);
  const ankle = jp(r, `foot${s}` as BoneName);
  const toe = tp(r, `foot${s}` as BoneName);
  const g = r.girth;
  const u = r.u;
  const dk = near ? 1.14 : 0.7;
  const tone = (c: string) => col(shadeOf(c, dk));
  const keyTone = (c: string) => keyCol(shadeOf(c, dk));

  ctx.save();
  if (!near) ctx.translate(-0.9 * u, 0);

  const d = r.d;
  const pants = pantsCol(r);
  const skin = skinTone(r, near ? 1.0 : 0.76);
  // Trousers in strips: the leg below the knee is bare and what is left of the
  // cloth hangs off it. Near leg goes first — it is the one anyone can see.
  const stripped = d.on && (near ? d.t3 : d.t3 * 0.8) > 0.34;

  limb(ctx, hip.x, hip.y, knee.x, knee.y, 3.7 * u * g, 3.0 * u * g, tone(pants), ink());
  limb(
    ctx, knee.x, knee.y, ankle.x, ankle.y, 3.0 * u * g, 2.4 * u * g,
    stripped ? skin : tone(pants), ink(),
  );

  if (d.on) {
    if (stripped) {
      // the torn-off hem, then three strips still clinging to it
      const kp = perp(knee, ankle);
      const e1 = off(knee, kp, 3.1 * u * g);
      const e2 = off(knee, kp, -3.1 * u * g);
      capsule(ctx, e1.x, e1.y, e2.x, e2.y, 0.85 * u, tone(pants), ink(), r.ow * 0.6);
      const dir = { x: ankle.x - knee.x, y: ankle.y - knee.y };
      const sway = d.reduced ? 0 : Math.sin(d.t * 2.3 + hashf(d.seed, near ? 301 : 311) * TAU) * 0.5 * u;
      for (let i = 0; i < 3; i++) {
        const f = -0.7 + i * 0.7;
        const p = off(knee, kp, f * 2.6 * u * g);
        const l = (0.3 + 0.5 * hashf(d.seed, 320 + i + (near ? 0 : 7))) * (1 + d.t3);
        tatter(
          ctx, p.x, p.y, dir.x * l * 0.5 + sway, dir.y * l * 0.5,
          1.25 * u * g, tone(shadeOf(pants, 0.9)), r.ow * 0.5,
        );
      }
    } else if (d.t2 > 0.05) {
      // rips over the thigh, showing what is underneath
      for (let i = 0; i < 2; i++) {
        const p = mid(hip, knee, 0.3 + 0.45 * hashf(d.seed, 330 + i + (near ? 0 : 5)));
        rip(
          ctx, p.x + hashs(d.seed, 340 + i) * 1.6 * u, p.y,
          hashf(d.seed, 350 + i) * TAU, (2.6 + 2.8 * d.t2) * u, (0.55 + 0.75 * d.t2) * u,
          skin, r.ow * 0.5,
        );
      }
    }
    scuffs(r, hip, ankle, 2.2 * u * g, 5, near ? 360 : 380);
  }

  // boot
  const bc = bootCol(r);
  capsule(ctx, ankle.x, ankle.y, toe.x, toe.y, 2.4 * u, tone(bc), ink(), r.ow);
  const heel = off(ankle, perp(ankle, toe), -2.2 * u);
  capsule(ctx, ankle.x, ankle.y, heel.x, heel.y, 1.9 * u, tone(shadeOf(bc, 0.85)), ink(), r.ow);

  const pop = spikePop(r);
  if (pop > 0.02) {
    // steel toe cap and a buckled strap over the instep
    const steel = shadeOf(r.st.jacketAccent, 0.62);
    const cap = mid(ankle, toe, 0.86);
    ellipse(ctx, cap.x, cap.y, 1.5 * u * pop, 1.5 * u * pop, 0, keyTone(steel), ink(), r.ow * 0.7);
    const pp = perp(ankle, knee);
    const a = off(ankle, pp, 2.2 * u);
    const b = off(ankle, pp, -2.2 * u);
    capsule(ctx, a.x, a.y, b.x, b.y, 0.6 * u, keyTone(steel), ink(), r.ow * 0.5);
  } else {
    // soft classic shoe with a turned-up tip
    ellipse(ctx, toe.x, toe.y, 1.5 * u, 1.4 * u, 0, tone(shadeOf(bc, 1.12)), ink(), r.ow * 0.7);
  }

  ctx.restore();
}

function drawArm(r: Rig, near: boolean): void {
  const ctx = r.ctx;
  const s = near ? 'R' : 'L';
  const sh = jp(r, `arm${s}_upper` as BoneName);
  const el = jp(r, `arm${s}_lower` as BoneName);
  const wr = jp(r, `hand${s}` as BoneName);
  const tipH = tp(r, `hand${s}` as BoneName);
  const g = r.girth;
  const u = r.u;
  const dk = near ? 1.18 : 0.68;
  const tone = (c: string) => col(shadeOf(c, dk));
  // Skin and the jacket accent are identifiers: they keep their read even on
  // the far side of the body, where everything else falls away into shade.
  const keyTone = (c: string) => keyCol(shadeOf(c, dk));
  const flesh = (c: string) => keyCol(shadeOf(c, near ? 1.02 : 0.76));

  ctx.save();
  if (!near) ctx.translate(-1.1 * u, 0);

  // sleeve down to the elbow, bare forearm below it — rolled sleeves at both
  // ends of the outfit blend, which is where the tattoo lives
  const d = r.d;
  const sleeve = garmentCol(r);
  const bareSkin = flesh(r.st.skin);
  // Which sleeve goes first is seeded, so two guards in the same wave are not
  // wearing the same torn jacket.
  const firstIsNear = hashf(d.seed, 11) < 0.5;
  const sleeveWear = near === firstIsNear ? d.t2 : d.t3;
  const bare = d.on && sleeveWear > 0.4;

  if (bare) {
    limb(ctx, sh.x, sh.y, el.x, el.y, 3.5 * u * g, 2.8 * u * g, bareSkin, ink());
    // what is left of it, torn off at the shoulder and still flapping
    const stub = mid(sh, el, 0.24 + 0.12 * (1 - sleeveWear));
    capsule(ctx, sh.x, sh.y, stub.x, stub.y, 3.3 * u * g, tone(sleeve), ink(), r.ow * 0.8);
    const sp = perp(sh, el);
    const dir = { x: el.x - sh.x, y: el.y - sh.y };
    for (let i = 0; i < 3; i++) {
      const p = off(stub, sp, (-0.66 + i * 0.66) * 2.6 * u * g);
      const l = 0.14 + 0.16 * hashf(d.seed, 400 + i + (near ? 0 : 9));
      tatter(ctx, p.x, p.y, dir.x * l, dir.y * l, 1.15 * u * g, tone(shadeOf(sleeve, 0.88)), r.ow * 0.5);
    }
  } else {
    limb(ctx, sh.x, sh.y, el.x, el.y, 3.5 * u * g, 2.8 * u * g, tone(sleeve), ink());
    if (d.t2 > 0.05) {
      for (let i = 0; i < 2; i++) {
        const p = mid(sh, el, 0.28 + 0.44 * hashf(d.seed, 410 + i + (near ? 0 : 4)));
        rip(
          ctx, p.x + hashs(d.seed, 420 + i) * 1.4 * u, p.y,
          hashf(d.seed, 430 + i) * TAU, (2.4 + 2.6 * d.t2) * u, (0.5 + 0.7 * d.t2) * u,
          bareSkin, r.ow * 0.5,
        );
      }
    }
  }
  limb(ctx, el.x, el.y, wr.x, wr.y, 2.7 * u * g, 2.3 * u * g, bareSkin, ink());
  if (d.on) scuffs(r, sh, wr, 2.0 * u * g, 4, near ? 440 : 460);

  // cuff at the elbow — gone with the sleeve it was holding up
  const pp = perp(el, wr);
  if (!bare) {
    const ca = off(el, pp, 2.9 * u * g);
    const cb = off(el, pp, -2.9 * u * g);
    capsule(
      ctx, ca.x, ca.y, cb.x, cb.y, 1.0 * u,
      tone(mixCol(shadeOf(r.st.tunicColor, 1.2), r.st.jacketAccent, r.fit)), ink(), r.ow * 0.7,
    );
  }

  const pop = spikePop(r);
  const count = spikeCount(r);
  if (pop > 0.02 && count > 0 && !bare) {
    const back = perp(sh, el);
    const a = off(mid(sh, el, 0.18), back, -1.9 * u * g);
    const b = off(mid(sh, el, 0.92), back, -1.6 * u * g);
    studs(ctx, a.x, a.y, b.x, b.y, Math.max(2, count - 1), 2.1 * u * pop, keyTone(r.st.jacketAccent));
  }

  if (near && r.st.tattoo && r.st.tattoo !== 'none') {
    drawTattoo(r, mid(el, wr, 0.55), Math.atan2(wr.y - el.y, wr.x - el.x));
  }

  // fist
  const hand = mid(wr, tipH, 0.42);
  const gloved = r.fit > 0.45;
  ellipse(
    ctx, hand.x, hand.y, 2.5 * u * g, 2.4 * u * g, 0,
    gloved ? tone(mixCol(r.st.skin, r.st.jacketColor, (r.fit - 0.45) / 0.55)) : flesh(r.st.skin),
    ink(), r.ow,
  );
  if (gloved) {
    // fingerless glove: knuckles stay bare
    const kn = mid(wr, tipH, 0.05);
    capsule(
      ctx, kn.x, kn.y, hand.x, hand.y, 1.7 * u * g,
      tone(mixCol(r.st.jacketColor, '#000000', 0.2)), ink(), r.ow * 0.7,
    );
  }

  ctx.restore();
}

function drawTattoo(r: Rig, p: Pt, rot: number): void {
  const ctx = r.ctx;
  const u = r.u;
  const c = col(flashAmt > 0 ? '#ffffff' : '#2a3a58');
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(rot + Math.PI / 2);
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = Math.max(0.5, 0.45 * u);
  ctx.lineCap = 'round';
  const k = r.st.tattoo;
  if (k === 'anchor') {
    ctx.beginPath();
    ctx.moveTo(0, -1.6 * u);
    ctx.lineTo(0, 1.6 * u);
    ctx.moveTo(-1.2 * u, -0.7 * u);
    ctx.lineTo(1.2 * u, -0.7 * u);
    ctx.moveTo(-1.3 * u, 0.6 * u);
    ctx.quadraticCurveTo(0, 2.4 * u, 1.3 * u, 0.6 * u);
    ctx.stroke();
  } else if (k === 'skull') {
    ctx.beginPath();
    ctx.arc(0, -0.4 * u, 1.3 * u, 0, TAU);
    ctx.fill();
    ctx.fillRect(-0.7 * u, 0.6 * u, 1.4 * u, 0.9 * u);
    ctx.fillStyle = keyCol(r.st.skin);
    ctx.beginPath();
    ctx.arc(-0.5 * u, -0.5 * u, 0.36 * u, 0, TAU);
    ctx.arc(0.5 * u, -0.5 * u, 0.36 * u, 0, TAU);
    ctx.fill();
  } else if (k === 'heart') {
    ctx.beginPath();
    ctx.arc(-0.7 * u, -0.5 * u, 0.85 * u, 0, TAU);
    ctx.arc(0.7 * u, -0.5 * u, 0.85 * u, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-1.5 * u, -0.2 * u);
    ctx.lineTo(0, 1.9 * u);
    ctx.lineTo(1.5 * u, -0.2 * u);
    ctx.fill();
  } else {
    for (let i = 0; i < 6; i++) {
      ctx.fillRect((-1.6 + i * 0.62) * u, -1.2 * u, (i % 2 ? 0.24 : 0.4) * u, 2.4 * u);
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Torso: tunic underneath, leather growing over the top of it
// ─────────────────────────────────────────────────────────────────────────────

function drawTorso(r: Rig): void {
  const ctx = r.ctx;
  const u = r.u;
  const d = r.d;
  const P = jp(r, 'pelvis');
  const N = jp(r, 'neck');
  const spineLen = len2(P, N) || u;
  const waist = spineLen * 0.42 * r.girth;
  // The ribcage swells on the inhale and empties on the way out. The waist does
  // not, which is what makes it read as breathing rather than as a size change.
  const hw = waist * (1 + d.heave * 0.1 * (0.35 + 0.65 * d.breath));
  const pp = perp(P, N); // points forward (+x when facing right)

  // body mass
  const a = mid(P, N, 0.02);
  const b = mid(P, N, 0.84 + d.heave * 0.02);
  capsule(ctx, a.x, a.y, b.x, b.y, hw, col(r.st.tunicColor), ink(), r.ow);

  // a lighter panel down the front sells the tunic at outfit 0
  if (r.fit < 0.98) {
    const t1 = off(mid(P, N, 0.72), pp, hw * 0.18);
    const t2 = off(mid(P, N, 0.06), pp, hw * 0.18);
    capsule(
      ctx, t1.x, t1.y, t2.x, t2.y, hw * 0.52,
      col(shadeOf(r.st.tunicColor, 1.14)), ink(), r.ow * 0.6,
    );
  }

  // Wear on the shirt itself. Under an intact jacket none of this shows, which
  // is correct — it appears exactly as the leather stops covering it.
  if (d.on) {
    scuffs(r, P, N, hw * 0.8, 6, 500);
    if (d.t2 > 0.05) {
      for (let i = 0; i < 3; i++) {
        const p = off(
          mid(P, N, 0.12 + 0.7 * hashf(d.seed, 510 + i)),
          pp,
          hashs(d.seed, 520 + i) * hw * 0.7,
        );
        rip(
          ctx, p.x, p.y, hashf(d.seed, 530 + i) * TAU,
          (2.8 + 3.4 * d.t2) * u, (0.6 + 0.8 * d.t2) * u, skinTone(r, 0.95), r.ow * 0.5,
        );
      }
    }
  }

  // neck
  const H = jp(r, 'head');
  capsule(ctx, N.x, N.y, H.x, H.y, 2.1 * u * r.girth, keyCol(shadeOf(r.st.skin, 0.9)), ink(), r.ow);

  drawJacket(r, P, N, hw, pp);
  drawBelt(r, P, waist, pp);
  drawExposedChest(r, P, N, hw, pp);

  // spikes across the near shoulder
  const pop = spikePop(r);
  const count = spikeCount(r);
  if (pop > 0.02 && count > 0) {
    const S = mid(P, N, 0.9);
    const s1 = off(S, pp, hw * 0.95);
    const s2 = off(S, pp, -hw * 0.95);
    studs(ctx, s1.x, s1.y, s2.x, s2.y, count, 2.6 * u * pop, keyCol(r.st.jacketAccent));
  }
}

/** Scratch for the ragged hole torn down the front of everything he wears. */
const CHEST_PTS: number[] = new Array<number>(24).fill(0);

/**
 * The last stage: shirt, jacket and dignity all opened down the middle. Drawn
 * OVER the jacket, because the hole goes through it, not behind it.
 */
function drawExposedChest(r: Rig, P: Pt, N: Pt, hw: number, pp: Pt): void {
  const d = r.d;
  const t = d.t3;
  if (t <= 0.04) return;
  const ctx = r.ctx;
  const u = r.u;
  const seed = d.seed;
  const top = mid(P, N, 0.76);
  const bot = mid(P, N, 0.16);
  const w = hw * (0.3 + 0.55 * t);
  const n = 5;

  let k = 0;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const jag = w * (0.6 + 0.55 * hashf(seed, 540 + i));
    CHEST_PTS[k++] = lerp(top.x, bot.x, f) + pp.x * jag;
    CHEST_PTS[k++] = lerp(top.y, bot.y, f) + pp.y * jag;
  }
  for (let i = n; i >= 0; i--) {
    const f = i / n;
    const jag = w * (0.55 + 0.55 * hashf(seed, 560 + i));
    CHEST_PTS[k++] = lerp(top.x, bot.x, f) - pp.x * jag;
    CHEST_PTS[k++] = lerp(top.y, bot.y, f) - pp.y * jag;
  }
  poly(ctx, CHEST_PTS, skinTone(r, 0.98), ink(), r.ow * 0.8);

  // Ribs, spreading with the heave. Nobody in this game has a six-pack.
  if (t > 0.35) {
    ctx.strokeStyle = col(shadeOf(r.st.skin, 0.66));
    ctx.lineWidth = Math.max(0.5, 0.4 * u);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const f = 0.6 - i * 0.14 + d.heave * 0.014;
      const c0 = mid(top, bot, 1 - f);
      ctx.moveTo(c0.x + pp.x * w * 0.62, c0.y + pp.y * w * 0.62);
      ctx.lineTo(c0.x - pp.x * w * 0.5, c0.y - pp.y * w * 0.5);
    }
    ctx.stroke();
    const nav = mid(top, bot, 0.86);
    ellipse(ctx, nav.x, nav.y, 0.5 * u, 0.42 * u, 0, col(shadeOf(r.st.skin, 0.6)), NO);
  }
}

/** The jacket body, with a hem that goes ragged instead of straight. */
const JACKET_PTS: number[] = new Array<number>(16).fill(0);
/** The gap where the front hangs open. */
const GAP_PTS: number[] = new Array<number>(8).fill(0);

function drawJacket(r: Rig, P: Pt, N: Pt, hw: number, pp: Pt): void {
  const d = r.d;
  // As the leather is torn off him the hem climbs back up the body.
  const cover = clamp(r.fit * 1.25, 0, 1) * (1 - 0.42 * d.t3);
  if (cover < 0.02) return;
  const ctx = r.ctx;
  const u = r.u;
  const seed = d.seed;
  const jc = col(r.st.jacketColor);

  // the hem crawls down over the tunic as the outfit blend rises
  const top = mid(P, N, 0.9);
  const bot = mid(P, N, lerp(0.9, -0.04, cover));
  const tw = hw * 1.08;
  const bw = hw * 1.0;
  const sl = len2(P, N) || u;
  const ax = (N.x - P.x) / sl;
  const ay = (N.y - P.y) / sl;
  // Notches bite UP toward the chest along the spine, so a torn hem still hangs
  // off the same silhouette instead of growing spikes sideways.
  const tear = (0.9 * d.t1 + 2.6 * d.t3) * u;
  const hem = 5;

  let k = 0;
  JACKET_PTS[k++] = top.x + pp.x * tw;
  JACKET_PTS[k++] = top.y + pp.y * tw;
  for (let i = 0; i <= hem; i++) {
    const f = i / hem;
    const s = lerp(bw, -bw, f);
    const up = tear * hashf(seed, 570 + i);
    JACKET_PTS[k++] = bot.x + pp.x * s + ax * up;
    JACKET_PTS[k++] = bot.y + pp.y * s + ay * up;
  }
  JACKET_PTS[k++] = top.x - pp.x * tw;
  JACKET_PTS[k++] = top.y - pp.y * tw;
  poly(ctx, JACKET_PTS, jc, ink(), r.ow);

  if (cover > 0.3) {
    // Hanging open. One good hit and nothing holds the front closed any more.
    const gap = d.t1;
    if (gap > 0.06) {
      const g1 = mid(top, bot, 0.96);
      const g2 = mid(top, bot, 0.06);
      const gw = hw * 0.44 * gap;
      GAP_PTS[0] = g1.x + pp.x * gw * 1.15;
      GAP_PTS[1] = g1.y + pp.y * gw * 1.15;
      GAP_PTS[2] = g2.x + pp.x * gw * 1.5;
      GAP_PTS[3] = g2.y + pp.y * gw * 1.5;
      GAP_PTS[4] = g2.x - pp.x * gw * 0.7;
      GAP_PTS[5] = g2.y - pp.y * gw * 0.7;
      GAP_PTS[6] = g1.x - pp.x * gw * 0.45;
      GAP_PTS[7] = g1.y - pp.y * gw * 0.45;
      poly(ctx, GAP_PTS, col(r.st.tunicColor), ink(), r.ow * 0.7);
    }

    // open front: lapel folded back, zip running down the middle
    const lapTop = off(top, pp, hw * (1.0 + 0.18 * gap));
    const lapIn = off(top, pp, hw * 0.05);
    const lapEnd = off(mid(top, bot, 0.5), pp, hw * (0.62 + 0.3 * gap));
    poly(
      ctx,
      [lapTop.x, lapTop.y, lapEnd.x, lapEnd.y, lapIn.x, lapIn.y],
      col(shadeOf(r.st.jacketColor, 1.35)),
      ink(),
      r.ow * 0.8,
    );
    const z1 = off(mid(top, bot, 0.86), pp, hw * 0.1);
    const z2 = off(mid(top, bot, lerp(0.12, 0.5, d.t2)), pp, hw * 0.16);
    capsule(ctx, z1.x, z1.y, z2.x, z2.y, 0.55 * u, keyCol(r.st.jacketAccent), ink(), r.ow * 0.5);

    // Buttons pop off one at a time, and the thread they left stays behind.
    if (d.on) {
      for (let i = 0; i < 3; i++) {
        const p = off(mid(top, bot, 0.68 - i * 0.24), pp, hw * 0.36);
        const goneAt = 0.2 + i * 0.26;
        if (d.wear < goneAt) {
          ellipse(ctx, p.x, p.y, 0.62 * u, 0.62 * u, 0, keyCol(r.st.jacketAccent), ink(), r.ow * 0.4);
        } else {
          ellipse(ctx, p.x, p.y, 0.5 * u, 0.4 * u, 0, col(shadeOf(r.st.jacketColor, 0.55)), NO);
        }
      }
    }

    // Popped collar — until somebody rips it off, which they will.
    if (d.t2 < 0.55) {
      const cA = off(top, pp, hw * 0.95);
      const cB = off(top, pp, -hw * 0.95);
      const upA = { x: cA.x + pp.x * 1.2 * u, y: cA.y - 3.4 * u * (1 - d.t2) };
      const upB = { x: cB.x - pp.x * 1.2 * u, y: cB.y - 3.0 * u * (1 - d.t2) };
      poly(
        ctx,
        [cA.x, cA.y, upA.x, upA.y, top.x + pp.x * hw * 0.2, top.y - 1.2 * u],
        col(shadeOf(r.st.jacketColor, 1.2)), ink(), r.ow * 0.8,
      );
      poly(
        ctx,
        [cB.x, cB.y, upB.x, upB.y, top.x - pp.x * hw * 0.2, top.y - 1.2 * u],
        col(shadeOf(r.st.jacketColor, 0.85)), ink(), r.ow * 0.8,
      );
    } else {
      // the stub of a collar, torn off at the seam
      const cA = off(top, pp, hw * 0.95);
      const cB = off(top, pp, -hw * 0.95);
      for (let i = 0; i < 4; i++) {
        const p = mid(cA, cB, i / 3);
        tatter(
          ctx, p.x, p.y, 0, -(1.0 + 1.3 * hashf(seed, 590 + i)) * u, 1.05 * u,
          col(shadeOf(r.st.jacketColor, 1.1)), r.ow * 0.5,
        );
      }
    }
  }
}

function drawBelt(r: Rig, P: Pt, hw: number, pp: Pt): void {
  const ctx = r.ctx;
  const u = r.u;
  const a = off(P, pp, hw * 1.04);
  const b = off(P, pp, -hw * 1.04);
  capsule(ctx, a.x, a.y, b.x, b.y, 1.7 * u, col(beltCol(r)), ink(), r.ow * 0.8);

  const studsT = clamp((r.fit - 0.2) / 0.4, 0, 1);
  if (studsT > 0.02) {
    for (let i = 0; i < 5; i++) {
      const t = -0.7 + (i / 4) * 1.4;
      const s = off(P, pp, hw * t);
      ellipse(ctx, s.x, s.y, 0.62 * u * studsT, 0.62 * u * studsT, 0, keyCol(r.st.jacketAccent), NO);
    }
  }

  const bk = off(P, pp, hw * 0.34);
  const round = 2.3 * u * (1 - r.fit);
  const square = 3.2 * u * r.fit;
  if (round > 0.2) {
    ellipse(ctx, bk.x, bk.y, round, round * 0.86, 0, col('#e6b23c'), ink(), r.ow * 0.6);
  }
  if (square > 0.2) {
    roundRect(
      ctx, bk.x - square * 0.5, bk.y - square * 0.42, square, square * 0.84, 0.6 * u,
      keyCol(r.st.jacketAccent), ink(), r.ow * 0.6,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Head, cap, beard
// ─────────────────────────────────────────────────────────────────────────────

interface Head {
  c: Pt;
  rx: number;
  ry: number;
  /** Canvas rotation of the skull. */
  ang: number;
}

function headFrame(r: Rig): Head {
  const base = jp(r, 'head');
  const top = tp(r, 'head');
  const l = len2(base, top) || r.u;
  const hs = r.st.headSize || 1;
  return {
    c: mid(base, top, 0.46),
    rx: l * 0.5 * hs,
    ry: l * 0.54 * hs,
    ang: Math.atan2(top.y - base.y, top.x - base.x) + Math.PI / 2,
  };
}

function drawHead(r: Rig): void {
  const ctx = r.ctx;
  const u = r.u;
  const h = headFrame(r);
  const { rx, ry } = h;
  const skin = keyCol(r.st.skin);
  const dark = keyCol(shadeOf(r.st.skin, 0.82));

  ctx.save();
  ctx.translate(h.c.x, h.c.y);
  ctx.rotate(h.ang);

  // ear on the far side of the skull, hair tuft behind it
  ellipse(ctx, -rx * 0.78, ry * 0.02, rx * 0.3, ry * 0.32, -0.3, dark, ink(), r.ow);
  const hair = keyCol(r.st.hair);
  ellipse(ctx, -rx * 0.66, -ry * 0.34, rx * 0.34, ry * 0.28, 0.6, hair, ink(), r.ow * 0.7);
  ellipse(ctx, -rx * 0.5, ry * 0.42, rx * 0.3, ry * 0.24, -0.5, hair, ink(), r.ow * 0.7);

  // skull
  ellipse(ctx, 0, 0, rx, ry, 0, skin, ink(), r.ow);

  // rosy cheeks fade out as the bad boy takes over
  const rosy = 1 - r.fit;
  if (rosy > 0.06) {
    ellipse(
      ctx, rx * 0.3, ry * 0.3, rx * 0.28, ry * 0.2, 0,
      keyCol(mixCol(r.st.skin, '#e0596b', 0.45 * rosy)), NO,
    );
  }

  drawBruises(r, rx, ry);
  // Brows go on last when there are shades to clear — see drawAccessories.
  if (shadesT(r) < 0.35) drawBrows(r, rx, ry, false, -ry * 0.36);
  drawEyes(r, rx, ry);

  // the nose. It is a potato and it is load-bearing.
  const flare =
    r.d.face === 'angry' ? 1 : r.d.face === 'exhausted' ? 0.7 : r.d.face === 'strained' ? 0.3 : 0;
  const ns = 1 + flare * 0.16;
  ellipse(ctx, rx * 0.7, ry * 0.06, rx * 0.36 * ns, ry * 0.3 * ns, -0.15, dark, ink(), r.ow);
  ellipse(ctx, rx * 0.66, -ry * 0.02, rx * 0.13, ry * 0.1, 0, keyCol(shadeOf(r.st.skin, 1.12)), NO);
  if (flare > 0.2) {
    // nostrils, flared. A furious dwarf breathes through his nose.
    const nc = keyCol(shadeOf(r.st.skin, 0.5));
    ellipse(ctx, rx * 0.82, ry * 0.2, rx * 0.1 * flare + 0.2, ry * 0.08 * flare + 0.2, 0.5, nc, NO);
    ellipse(ctx, rx * 0.6, ry * 0.24, rx * 0.08 * flare + 0.15, ry * 0.07 * flare + 0.15, 0.5, nc, NO);
  }

  // A closed mouth is only a line, so it stays here where the beard can cover
  // it. Everything that OPENS is drawn over the beard by drawFaceOver.
  const bs = r.st.beardStyle;
  if (r.d.face === 'calm' && (bs === 'none' || bs === 'stubble')) {
    ctx.strokeStyle = col('#4a2f2c');
    ctx.lineWidth = Math.max(0.6, 0.5 * u);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (r.fit > 0.5) {
      ctx.moveTo(rx * 0.16, ry * 0.5);
      ctx.quadraticCurveTo(rx * 0.42, ry * 0.42, rx * 0.62, ry * 0.54);
    } else {
      ctx.moveTo(rx * 0.16, ry * 0.46);
      ctx.quadraticCurveTo(rx * 0.42, ry * 0.66, rx * 0.62, ry * 0.44);
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// The face
//
// Head-local space: the origin is the middle of the skull, +x is the direction
// he is facing, and the head is drawn three-quarter on — the near eye sits at
// 0.44·rx, the far one at 0.04·rx and the nose out at 0.7·rx. A dwarf is about
// fifty pixels tall in play, which makes this whole face roughly thirteen
// pixels wide: every feature here is deliberately two or three times bolder
// than it would need to be in close-up, because subtle does not survive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Brows carry more of the expression than the eyes do, which is why they are
 * also the pass that gets redrawn on top of the sunglasses. `inner` is the
 * nose-side end, `outer` the temple end, both as fractions of ry.
 */
function drawBrows(r: Rig, rx: number, ry: number, over: boolean, baseY: number): void {
  const ctx = r.ctx;
  const u = r.u;
  let inner = -0.06;
  let outer = r.fit * 0.5 * 0.22;
  let thick = 1;
  let drop = 0;

  switch (r.d.face) {
    case 'strained':
      inner = 0.2; outer = -0.02; thick = 1.15; drop = 0.02;
      break;
    case 'angry':
      // The hard V: inner ends crashing down over the eyes, outer ends up.
      inner = 0.3; outer = -0.22; thick = 1.45; drop = 0.04;
      break;
    case 'exhausted':
      inner = -0.22; outer = 0.18; thick = 0.9; drop = -0.04;
      break;
    case 'dazed':
      inner = -0.16; outer = -0.12; thick = 0.9; drop = -0.08;
      break;
    case 'dead':
      inner = 0.0; outer = 0.1; thick = 0.85; drop = 0.02;
      break;
    default:
      break;
  }

  // Over the lenses the brow rides on top of the frame and its spread is halved,
  // so the whole V stays readable against the top edge of the glass instead of
  // sinking behind it. Overlapping the frame is fine — it reads as a brow ridge
  // overhanging a pair of sunglasses, which is what it is.
  const t = thick * (over ? 1.2 : 1);
  const sp = over ? 0.55 : 1;
  const browY = baseY + (over ? 0 : drop * ry);
  const hair = keyCol(r.st.hair);
  capsule(
    ctx, rx * 0.08, browY + outer * ry * sp, rx * 0.72, browY + inner * ry * sp,
    0.95 * u * t, hair, ink(), r.ow * 0.6,
  );
  capsule(
    ctx, -rx * 0.34, browY + outer * ry * 0.78 * sp, -rx * 0.02, browY + inner * ry * 0.72 * sp,
    0.8 * u * t, keyCol(shadeOf(r.st.hair, 0.8)), ink(), r.ow * 0.5,
  );

  // The vein. Purely editorial.
  if (r.d.face === 'angry' && r.d.wear > 0.3 && !over) {
    ctx.strokeStyle = col('#c0384a');
    ctx.lineWidth = Math.max(0.5, 0.36 * u);
    ctx.beginPath();
    ctx.moveTo(-rx * 0.5, -ry * 0.62);
    ctx.lineTo(-rx * 0.3, -ry * 0.52);
    ctx.moveTo(-rx * 0.44, -ry * 0.44);
    ctx.lineTo(-rx * 0.3, -ry * 0.52);
    ctx.lineTo(-rx * 0.2, -ry * 0.66);
    ctx.stroke();
  }
}

/** How far one eye has puffed shut. Seeded, so it is always the same eye. */
function swellAmt(r: Rig): number {
  return clamp(r.d.blood * 1.3 - 0.15, 0, 1) * clamp(0.45 + r.d.wear, 0, 1);
}

function drawEyes(r: Rig, rx: number, ry: number): void {
  const ctx = r.ctx;
  const u = r.u;
  const d = r.d;
  const eyeY = -ry * 0.1;
  const nx = rx * 0.44;
  const fx = rx * 0.04;
  const pupil = col('#1a1622');

  if (d.face === 'dead' || d.face === 'dazed') {
    const pale = col('#efe9df');
    ellipse(ctx, nx, eyeY, 1.7 * u, 1.8 * u, 0, pale, ink(), r.ow * 0.5);
    ellipse(ctx, fx, eyeY + 0.1 * u, 1.25 * u, 1.4 * u, 0, pale, ink(), r.ow * 0.45);
    if (d.face === 'dead') {
      crossEye(ctx, nx, eyeY, 1.5 * u, ink(), Math.max(0.7, 0.62 * u));
      crossEye(ctx, fx, eyeY + 0.1 * u, 1.1 * u, ink(), Math.max(0.6, 0.5 * u));
    } else {
      // one spinning, one crossed — funnier than a matched pair
      const turn = d.reduced ? 0.6 : d.t * 2.4;
      spiralEye(ctx, nx, eyeY, 1.5 * u, ink(), Math.max(0.55, 0.42 * u), turn);
      crossEye(ctx, fx, eyeY + 0.1 * u, 1.0 * u, ink(), Math.max(0.55, 0.46 * u));
    }
    return;
  }

  let squash = 1;
  let lid = 0;
  let pupilS = 1;
  let pupilDy = 0.2 * u;
  let white = '#f6f2ea';
  switch (d.face) {
    case 'strained':
      squash = 0.66; lid = 0.28; pupilS = 0.9;
      break;
    case 'angry':
      squash = 0.56; lid = 0.4; pupilS = 0.74; pupilDy = -0.1 * u; white = '#f6e4dc';
      break;
    case 'exhausted':
      squash = 0.48; lid = 0.7; pupilS = 0.9; pupilDy = 0.55 * u; white = '#efe6d8';
      break;
    default:
      break;
  }
  // The swollen eye is the near one half the time and the far one the rest.
  const sw = swellAmt(r);
  const swNear = hashf(d.seed, 2) < 0.5;
  const nearSquash = squash * (1 - 0.65 * (swNear ? sw : 0));
  const farSquash = squash * (1 - 0.65 * (swNear ? 0 : sw));

  ellipse(ctx, nx, eyeY, 1.5 * u, 1.7 * u * nearSquash, 0, col(white), ink(), r.ow * 0.55);
  ellipse(
    ctx, nx + rx * 0.12, eyeY + pupilDy * nearSquash,
    0.72 * u * pupilS, 0.86 * u * nearSquash * pupilS, 0, pupil, NO,
  );
  ellipse(ctx, fx, eyeY + 0.1 * u, 1.1 * u, 1.35 * u * farSquash, 0, col('#e8e2d8'), ink(), r.ow * 0.5);
  ellipse(
    ctx, fx + rx * 0.08, eyeY + 0.28 * u * farSquash,
    0.6 * u * pupilS, 0.72 * u * farSquash * pupilS, 0, pupil, NO,
  );

  // Heavy lids, dropped ACROSS the top of the eye rather than shrinking it —
  // an eye that just gets smaller reads as a smaller eye, not as a closing one.
  // The lid's lower edge lands `lid` of the way down the eye it is covering.
  if (lid > 0.35) {
    const lc = keyCol(shadeOf(r.st.skin, 0.94));
    const nh = 1.7 * u * nearSquash;
    const ly = eyeY + nh * (2 * lid - 1) - 1.05 * u;
    capsule(ctx, nx - 1.7 * u, ly, nx + 1.6 * u, ly - 0.25 * u, 1.05 * u, lc, ink(), r.ow * 0.4);
    const fh = 1.35 * u * farSquash;
    const fy = eyeY + 0.1 * u + fh * (2 * lid - 1) - 0.85 * u;
    capsule(ctx, fx - 1.3 * u, fy, fx + 1.2 * u, fy - 0.2 * u, 0.85 * u, lc, ink(), r.ow * 0.35);
  }
}

function crossEye(ctx: C2D, x: number, y: number, s: number, c: string, w: number): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.stroke();
}

function spiralEye(ctx: C2D, x: number, y: number, s: number, c: string, w: number, turn: number): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = turn + f * TAU * 1.9;
    const px = x + Math.cos(a) * s * f;
    const py = y + Math.sin(a) * s * f;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/**
 * Bruising. Clipped to the skull so a blotch can be placed anywhere on the face
 * without a corner of it floating off the side of his head.
 */
function drawBruises(r: Rig, rx: number, ry: number): void {
  const d = r.d;
  const b = d.blood;
  if (b <= 0.02) return;
  const ctx = r.ctx;
  const seed = d.seed;
  // Fresh is red-purple; a day old and a lot of wear later it is nearly black.
  const ripe = clamp(b * 0.7 + d.wear * 0.4, 0, 1);
  const c = keyCol(mixCol(r.st.skin, BRUISE, 0.3 + 0.5 * ripe));

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
  ctx.clip();

  const sw = swellAmt(r);
  if (sw > 0.02) {
    const ex = hashf(seed, 2) < 0.5 ? rx * 0.44 : rx * 0.04;
    ellipse(ctx, ex, -ry * 0.1, (1.6 + 1.3 * sw) * r.u, (1.8 + 1.1 * sw) * r.u, 0, c, NO);
  }
  const n = b > 0.55 ? 3 : b > 0.25 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const x = rx * lerp(-0.45, 0.7, hashf(seed, 600 + i));
    const y = ry * lerp(-0.35, 0.6, hashf(seed, 610 + i));
    const s = (0.9 + 1.4 * hashf(seed, 620 + i)) * r.u * (0.55 + 0.7 * ripe);
    ellipse(ctx, x, y, s, s * 0.82, 0, c, NO);
  }
  ctx.restore();
}

/**
 * Everything on the face that has to sit ON TOP of the beard: the open mouths,
 * the bleeding and the sweat. Drawn in the same head-local space as drawHead.
 */
function drawFaceOver(r: Rig): void {
  if (!r.d.on) return;
  const ctx = r.ctx;
  const h = headFrame(r);
  ctx.save();
  ctx.translate(h.c.x, h.c.y);
  ctx.rotate(h.ang);
  drawOpenMouth(r, h.rx, h.ry);
  drawFaceBlood(r, h.rx, h.ry);
  drawSweat(r, h.rx, h.ry);
  ctx.restore();
}

/** A row of teeth hanging off an edge. `drop` down for the top row, up for the bottom. */
function toothRow(ctx: C2D, x1: number, x2: number, y: number, drop: number, n: number, c: string): void {
  const w = x2 - x1;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  for (let i = 0; i < n; i++) {
    ctx.lineTo(x1 + (w * (i + 0.5)) / n, y + drop);
    ctx.lineTo(x1 + (w * (i + 1)) / n, y);
  }
  ctx.closePath();
  ctx.fillStyle = c;
  ctx.fill();
}

const MOUTH_PTS: number[] = new Array<number>(8).fill(0);

function drawOpenMouth(r: Rig, rx: number, ry: number): void {
  const d = r.d;
  const f = d.face;
  if (f === 'calm') return;
  const ctx = r.ctx;
  const u = r.u;
  const cx = rx * 0.4;
  const cy = ry * 0.5;
  const maw = col(MAW);
  const teeth = col(TEETH);
  const tongue = col(TONGUE);

  if (f === 'strained') {
    // Jaw set. The rows are clamped together and the whole thing is a slot.
    const w = rx * 0.3;
    const hgt = 1.0 * u;
    roundRect(ctx, cx - w, cy - hgt, w * 2, hgt * 2, 0.35 * u, maw, ink(), r.ow * 0.7);
    roundRect(ctx, cx - w * 0.86, cy - hgt * 0.65, w * 1.72, hgt * 1.15, 0.2 * u, teeth, NO);
    ctx.fillStyle = maw;
    for (let i = 1; i < 4; i++) {
      ctx.fillRect(cx - w * 0.86 + (i / 4) * w * 1.72, cy - hgt * 0.65, Math.max(0.4, 0.16 * u), hgt * 1.15);
    }
    return;
  }

  if (f === 'angry') {
    // Bared. A wedge, wider at the front, with both rows showing.
    const w = rx * 0.34;
    const hgt = (1.8 + 0.25 * d.heave) * u;
    MOUTH_PTS[0] = cx - w;
    MOUTH_PTS[1] = cy - hgt * 0.8;
    MOUTH_PTS[2] = cx + w * 1.1;
    MOUTH_PTS[3] = cy - hgt;
    MOUTH_PTS[4] = cx + w * 0.95;
    MOUTH_PTS[5] = cy + hgt;
    MOUTH_PTS[6] = cx - w * 0.92;
    MOUTH_PTS[7] = cy + hgt * 0.78;
    poly(ctx, MOUTH_PTS, maw, ink(), r.ow * 0.8);
    toothRow(ctx, cx - w * 0.88, cx + w * 1.0, cy - hgt * 0.72, hgt * 0.7, 3, teeth);
    toothRow(ctx, cx - w * 0.82, cx + w * 0.88, cy + hgt * 0.7, -hgt * 0.55, 3, teeth);
    return;
  }

  if (f === 'exhausted') {
    // Gasping: the mouth opens and shuts with the breath, and it never shuts far.
    const open = 1.5 + 1.1 * Math.max(0, d.heave);
    ellipse(ctx, cx, cy, rx * 0.23, open * u, 0.1, maw, ink(), r.ow * 0.7);
    toothRow(ctx, cx - rx * 0.19, cx + rx * 0.19, cy - open * u * 0.72, open * u * 0.45, 3, teeth);
    ellipse(ctx, cx - rx * 0.02, cy + open * u * 0.45, rx * 0.15, open * u * 0.35, 0, tongue, NO);
    return;
  }

  // dazed and dead: slack, lopsided, tongue out. Nobody looks dignified here.
  const w = rx * (f === 'dead' ? 0.26 : 0.21);
  const hgt = (f === 'dead' ? 2.0 : 1.5) * u;
  ellipse(ctx, cx, cy, w, hgt, f === 'dead' ? 0.16 : -0.2, maw, ink(), r.ow * 0.7);
  const tx = cx + w * 0.35;
  const ty = cy + hgt * (f === 'dead' ? 1.0 : 0.75);
  capsule(ctx, cx, cy + hgt * 0.2, tx, ty, w * 0.5, tongue, ink(), r.ow * 0.5);
  ellipse(ctx, tx, ty, w * 0.55, w * 0.45, 0.3, tongue, ink(), r.ow * 0.5);
}

function drawFaceBlood(r: Rig, rx: number, ry: number): void {
  const d = r.d;
  const b = d.blood;
  if (b <= 0.02) return;
  const ctx = r.ctx;
  const u = r.u;
  const seed = d.seed;
  const [RAW, , WET] = leak(d);
  const bl = col(RAW);

  // Nosebleed. Straight down the front of the beard, because gravity.
  const run = (1.8 + 5.5 * b) * u;
  const nx = rx * 0.74;
  const ny = ry * 0.26;
  capsule(ctx, nx, ny, nx - 0.35 * u + hashs(seed, 630) * 0.5 * u, ny + run, 0.55 * u, bl, NO);
  ellipse(ctx, nx - 0.35 * u, ny + run, 0.62 * u, 0.72 * u, 0, col(WET), NO);
  if (b > 0.4) {
    capsule(ctx, rx * 0.58, ry * 0.28, rx * 0.55, ry * 0.28 + run * 0.6, 0.3 * u, bl, NO);
  }

  // Split lip, and the trail it leaves down the chin.
  if (b > 0.15) {
    const lx = rx * 0.16;
    const ly = ry * 0.52;
    capsule(ctx, lx - 0.6 * u, ly - 0.5 * u, lx + 0.5 * u, ly + 0.6 * u, 0.45 * u, col(WET), NO);
    capsule(ctx, lx, ly + 0.4 * u, lx - 0.4 * u, ly + run * 0.75, 0.42 * u, bl, NO);
    ellipse(ctx, lx - 0.4 * u, ly + run * 0.75, 0.5 * u, 0.6 * u, 0, bl, NO);
  }
}

function drawSweat(r: Rig, rx: number, ry: number): void {
  const d = r.d;
  const amt = clamp(d.breath * 1.25 + d.wear * 0.4 - 0.3, 0, 1);
  if (amt <= 0.02) return;
  const ctx = r.ctx;
  const u = r.u;
  const prev = ctx.globalAlpha;
  const c = col(SWEAT);
  const n = amt > 0.6 ? 3 : 2;

  for (let i = 0; i < n; i++) {
    const p = hashf(d.seed, 640 + i);
    // Beads run down the temple and start again at the top. Frozen when the
    // player has asked for less motion — a bead that sits there still reads.
    const fall = d.reduced ? 0.35 + 0.4 * p : (p + d.t * 0.5) % 1;
    const x = rx * (-0.5 + 1.0 * hashf(d.seed, 650 + i));
    const y = -ry * 0.9 + fall * ry * 1.7;
    ctx.globalAlpha = prev * clamp((1 - fall) * amt * 1.4, 0, 0.9);
    ellipse(ctx, x, y, 0.5 * u, 0.75 * u, 0, c, NO);
    ellipse(ctx, x - 0.18 * u, y - 0.2 * u, 0.18 * u, 0.24 * u, 0, col('#ffffff'), NO);
  }
  ctx.globalAlpha = prev;

  // The exhale itself, in the cold. Motion, so reduced motion drops it.
  if (!d.reduced && d.breath > 0.5) {
    const ex = clamp(-d.heave, 0, 1);
    if (ex > 0.05) {
      ctx.globalAlpha = prev * 0.2 * ex * d.breath;
      for (let i = 1; i <= 2; i++) {
        ellipse(
          ctx, rx * (0.72 + 0.3 * i) + ex * i * 1.6 * u, ry * (0.42 - 0.06 * i),
          (1.1 + 0.7 * i) * u * (0.6 + ex), (0.9 + 0.5 * i) * u * (0.6 + ex), 0,
          col('#dfe8f2'), NO,
        );
      }
      ctx.globalAlpha = prev;
    }
  }
}

interface HatF {
  base: Pt;
  axis: Pt;
  side: Pt;
  l: number;
  /** Half-width at the brim; every other measurement is a fraction of it. */
  w: number;
  /** The bone tip, before the cone flops sideways. */
  tipP: Pt;
  /** Where the cone actually ends up, pom-pom and all. */
  tip: Pt;
}

/** Profile of the floppy cone: distance along the bone, half-width, and how
 *  far back it has flopped — all as fractions, shared with the rim pass. */
const HAT_T = [0, 0.34, 0.66, 1];
const HAT_W = [1, 0.72, 0.44, 0.1];
const HAT_LAT = [0, -0.16, -0.5, -1.05];
/** Scratch buffer for the cone outline. Consumed before it can be clobbered. */
const HAT_PTS: number[] = new Array<number>(16).fill(0);

function hatFrame(r: Rig): HatF {
  const base = jp(r, 'hat');
  const tipP = tp(r, 'hat');
  const l = len2(base, tipP) || r.u;
  const axis = { x: (tipP.x - base.x) / l, y: (tipP.y - base.y) / l };
  const side = { x: -axis.y, y: axis.x };
  const w = headFrame(r).rx * 1.02;
  return {
    base,
    axis,
    side,
    l,
    w,
    tipP,
    tip: {
      x: base.x + axis.x * l + side.x * w * HAT_LAT[3],
      y: base.y + axis.y * l + side.y * w * HAT_LAT[3],
    },
  };
}

/** Writes the cone outline into `out` as a flat 16-number polygon buffer. */
function hatCone(f: HatF, pad: number, out: number[]): void {
  for (let i = 0; i < 4; i++) {
    const hw = f.w * HAT_W[i] + pad;
    const lat = f.w * HAT_LAT[i];
    const px = f.base.x + f.axis.x * f.l * HAT_T[i] + f.side.x * lat;
    const py = f.base.y + f.axis.y * f.l * HAT_T[i] + f.side.y * lat;
    out[i * 2] = px + f.side.x * hw;
    out[i * 2 + 1] = py + f.side.y * hw;
    // The far side runs back up the cone so the buffer closes cleanly.
    const k = 8 + (3 - i) * 2;
    out[k] = px - f.side.x * hw;
    out[k + 1] = py - f.side.y * hw;
  }
}

function drawHat(r: Rig): void {
  const ctx = r.ctx;
  const u = r.u;
  const f = hatFrame(r);
  const hatC = mixCol(r.st.hatColor, shadeOf(r.st.hatColor, 0.7), r.fit * 0.55);

  // floppy cone, flopping backwards
  hatCone(f, 0, HAT_PTS);
  poly(ctx, HAT_PTS, keyCol(hatC), ink(), r.ow);

  // pom-pom. Nobody has ever managed to talk him out of it.
  ellipse(
    ctx, f.tip.x, f.tip.y, f.w * 0.25, f.w * 0.25, 0,
    keyCol(shadeOf(r.st.hatColor, 1.18)), ink(), r.ow * 0.7,
  );

  // rolled brim
  const b1 = off(f.base, f.side, f.w * 1.06);
  const b2 = off(f.base, f.side, -f.w * 1.06);
  capsule(
    ctx, b1.x, b1.y, b2.x, b2.y, f.w * 0.24,
    keyCol(shadeOf(hatC, 1.18)), ink(), r.ow,
  );

  // studded band once the leather is on
  const pop = spikePop(r);
  if (pop > 0.02 && spikeCount(r) > 0) {
    const band = mid(f.base, f.tipP, 0.1);
    const s1 = off(band, f.side, f.w * 0.82);
    const s2 = off(band, f.side, -f.w * 0.82);
    capsule(ctx, s1.x, s1.y, s2.x, s2.y, 0.7 * u, col(beltCol(r)), ink(), r.ow * 0.5);
    for (let i = 0; i < 3; i++) {
      const p = mid(s1, s2, 0.2 + i * 0.3);
      ellipse(ctx, p.x, p.y, 0.55 * u * pop, 0.55 * u * pop, 0, keyCol(r.st.jacketAccent), NO);
    }
  }
}

/**
 * What is under the hat, which nobody was supposed to ever see. Drawn instead
 * of the cone once the hat has been knocked off, stolen, eaten or thrown onto a
 * roof — this is the payoff for the theft fatality, so it is allowed to be as
 * undignified as it likes. Which head he has is seeded, not random: the same
 * dwarf is bald every time.
 */
function drawFlatHair(r: Rig): void {
  const ctx = r.ctx;
  const u = r.u;
  const h = headFrame(r);
  const { rx, ry } = h;
  const seed = r.d.seed;
  const hair = keyCol(r.st.hair);
  const hairDk = keyCol(shadeOf(r.st.hair, 0.76));
  const bald = hashf(seed, 700) < 0.34;

  ctx.save();
  ctx.translate(h.c.x, h.c.y);
  ctx.rotate(h.ang);

  // The pale band where the brim lived. No forehead survives a hat.
  ellipse(ctx, rx * 0.06, -ry * 0.5, rx * 0.92, ry * 0.17, 0, keyCol(shadeOf(r.st.skin, 1.18)), NO);

  if (bald) {
    // A dome, a monk's fringe, and three heroic strands combed across it.
    ellipse(ctx, -rx * 0.04, -ry * 0.6, rx * 0.88, ry * 0.44, 0, keyCol(shadeOf(r.st.skin, 1.06)), ink(), r.ow * 0.6);
    ellipse(ctx, -rx * 0.72, -ry * 0.42, rx * 0.3, ry * 0.24, -0.5, hairDk, ink(), r.ow * 0.5);
    ellipse(ctx, rx * 0.6, -ry * 0.4, rx * 0.24, ry * 0.2, 0.5, hairDk, ink(), r.ow * 0.5);
    for (let i = 0; i < 3; i++) {
      const y = -ry * (0.86 - i * 0.08);
      capsule(ctx, -rx * 0.66, y + 0.4 * u, rx * (0.34 + i * 0.12), y, 0.4 * u, hairDk, NO);
    }
  } else {
    // A pancake. Squashed flat on top and squeezed out at the sides.
    ellipse(ctx, -rx * 0.04, -ry * 0.74, rx * 1.06, ry * 0.32, 0, hair, ink(), r.ow * 0.8);
    ellipse(ctx, -rx * 0.78, -ry * 0.5, rx * 0.32, ry * 0.22, -0.55, hairDk, ink(), r.ow * 0.5);
    ellipse(ctx, rx * 0.66, -ry * 0.48, rx * 0.28, ry * 0.2, 0.55, hairDk, ink(), r.ow * 0.5);
    // the parting, dead centre, maintained under a hat for forty years
    ctx.strokeStyle = keyCol(shadeOf(r.st.skin, 1.0));
    ctx.lineWidth = Math.max(0.5, 0.4 * u);
    ctx.beginPath();
    ctx.moveTo(-rx * 0.2, -ry * 1.0);
    ctx.lineTo(-rx * 0.12, -ry * 0.62);
    ctx.stroke();
  }

  // The one strand that no hat was ever going to hold down.
  const sway = r.d.reduced ? 0.4 * u : Math.sin(r.d.t * 3.1 + hashf(seed, 701) * TAU) * 0.9 * u;
  const bx = rx * (bald ? 0.06 : -0.12);
  const by = -ry * (bald ? 0.9 : 0.98);
  capsule(ctx, bx, by + 0.8 * u, bx + sway - 0.5 * u, by - 3.2 * u, 0.55 * u, hair, ink(), r.ow * 0.55);
  capsule(ctx, bx + sway - 0.5 * u, by - 3.2 * u, bx + sway + 1.9 * u, by - 4.2 * u, 0.42 * u, hair, ink(), r.ow * 0.45);
  ctx.restore();
}

/** Standalone hat frame, filled in place so the loose hat allocates nothing. */
const LOOSE_HAT: HatF = {
  base: { x: 0, y: 0 },
  axis: { x: 0, y: -1 },
  side: { x: 1, y: 0 },
  l: 1,
  w: 1,
  tipP: { x: 0, y: 0 },
  tip: { x: 0, y: 0 },
};

/**
 * The hat, off the head. The fatality director needs this for the theft
 * finisher — the one where an enemy takes it and EATS it, or lobs it onto a
 * roof — and for the moment it lands in the dirt afterwards.
 *
 * `rot` is the resting angle and `scale` matches the `scale` handed to
 * drawCharacter, so a hat drawn beside its owner is the same size as the one he
 * was wearing a second ago. The cone is squashed a little on the way out: a hat
 * with nobody inside it has no shape of its own.
 */
export function drawLooseHat(
  ctx: C2D,
  style: RigStyle,
  x: number,
  y: number,
  rot: number,
  scale: number,
): void {
  // Loose props draw outside any character, so take the neutral palette. This
  // is a no-op whenever drawCharacter has already reset it, which is always.
  setPalette(undefined, 0);
  const u = Math.abs(scale) * (style.scale || 1);
  if (u < 0.02) return;
  const ow = Math.max(1, 1.35 * u);
  // Mirrors DWARF_SKELETON: a 13-unit hat bone over a 13-unit head, and a brim
  // just wider than the skull it came off.
  const l = 13 * u;
  const w = 6.63 * u * (style.headSize || 1);
  const fit = clamp(style.outfit, 0, 1);
  const hatC = mixCol(style.hatColor, shadeOf(style.hatColor, 0.7), fit * 0.55);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(1, 0.84);

  const f = LOOSE_HAT;
  f.l = l;
  f.w = w;
  f.tipP.y = -l;
  f.tip.x = w * HAT_LAT[3];
  f.tip.y = -l;
  hatCone(f, 0, HAT_PTS);
  poly(ctx, HAT_PTS, keyCol(hatC), ink(), ow);

  // A crease down the collapsed side, which is the whole difference between a
  // hat lying on the floor and a cone standing on the floor.
  capsule(ctx, -w * 0.2, -l * 0.16, -w * 0.72, -l * 0.62, 0.5 * u, col(shadeOf(hatC, 0.72)), NO);

  ellipse(ctx, f.tip.x, f.tip.y, w * 0.25, w * 0.25, 0, keyCol(shadeOf(style.hatColor, 1.18)), ink(), ow * 0.7);
  capsule(ctx, w * 1.06, 0, -w * 1.06, 0, w * 0.24, keyCol(shadeOf(hatC, 1.18)), ink(), ow);

  const pop = fit <= 0.28 ? 0 : easeOutBack(clamp((fit - 0.28) / 0.42, 0, 1));
  if (pop > 0.02 && clamp(Math.round(style.spikes), 0, 9) > 0) {
    const by = -l * 0.1;
    capsule(ctx, w * 0.82, by, -w * 0.82, by, 0.7 * u, col(mixCol('#4a3320', '#141118', fit)), ink(), ow * 0.5);
    for (let i = 0; i < 3; i++) {
      const px = lerp(w * 0.82, -w * 0.82, 0.2 + i * 0.3);
      ellipse(ctx, px, by, 0.55 * u * pop, 0.55 * u * pop, 0, keyCol(style.jacketAccent), NO);
    }
  }
  ctx.restore();
}

function drawBeard(r: Rig): void {
  const style = r.st.beardStyle;
  if (style === 'none') return;
  const ctx = r.ctx;
  const u = r.u;
  const h = headFrame(r);
  const chin = jp(r, 'beard');
  // beardLength is a multiplier on the bone, clamped so a stray content value
  // cannot produce a beard longer than the dwarf
  const end = tp(r, 'beard', clamp(r.st.beardLength || 1, 0.25, 2.2));
  const l = len2(chin, end) || u;
  const axis = { x: (end.x - chin.x) / l, y: (end.y - chin.y) / l };
  const side = { x: -axis.y, y: axis.x };
  const hair = keyCol(r.st.hair);
  const hairDk = keyCol(shadeOf(r.st.hair, 0.82));
  const W = h.rx * 0.62;

  const at = (t: number, s: number): Pt => ({
    x: chin.x + axis.x * l * t + side.x * W * s,
    y: chin.y + axis.y * l * t + side.y * W * s,
  });

  if (style === 'stubble') {
    const p = at(0.24, 0);
    ellipse(
      ctx, p.x, p.y, W * 1.02, l * 0.42, Math.atan2(axis.y, axis.x) - Math.PI / 2,
      keyCol(mixCol(r.st.skin, r.st.hair, 0.55)), ink(), r.ow * 0.5,
    );
    return;
  }

  if (style === 'braided') {
    const mass = at(0.16, 0);
    ellipse(
      ctx, mass.x, mass.y, W * 1.0, l * 0.3, Math.atan2(axis.y, axis.x) - Math.PI / 2,
      hair, ink(), r.ow,
    );
    for (const s of [0.5, -0.42]) {
      const a = at(0.16, s);
      const b = at(1.0, s * 1.5);
      capsule(ctx, a.x, a.y, b.x, b.y, W * 0.3, s > 0 ? hair : hairDk, ink(), r.ow);
      for (let i = 1; i <= 3; i++) {
        const p = mid(a, b, i / 4);
        const q = off(p, side, W * 0.3);
        const q2 = off(p, side, -W * 0.3);
        capsule(ctx, q.x, q.y, q2.x, q2.y, 0.5 * u, col('#c8a24a'), ink(), r.ow * 0.4);
      }
      ellipse(ctx, b.x, b.y, W * 0.2, W * 0.2, 0, hairDk, ink(), r.ow * 0.6);
    }
  } else if (style === 'forked') {
    poly(
      ctx,
      [
        at(0, 0.95).x, at(0, 0.95).y,
        at(0.45, 1.05).x, at(0.45, 1.05).y,
        at(1.0, 0.7).x, at(1.0, 0.7).y,
        at(0.62, 0.05).x, at(0.62, 0.05).y,
        at(1.0, -0.66).x, at(1.0, -0.66).y,
        at(0.45, -1.0).x, at(0.45, -1.0).y,
        at(0, -0.9).x, at(0, -0.9).y,
      ],
      hair, ink(), r.ow,
    );
  } else if (style === 'long') {
    poly(
      ctx,
      [
        at(0, 0.9).x, at(0, 0.9).y,
        at(0.3, 0.78).x, at(0.3, 0.78).y,
        at(0.75, 0.52).x, at(0.75, 0.52).y,
        at(1.0, 0.16).x, at(1.0, 0.16).y,
        at(1.02, -0.2).x, at(1.02, -0.2).y,
        at(0.7, -0.5).x, at(0.7, -0.5).y,
        at(0.28, -0.74).x, at(0.28, -0.74).y,
        at(0, -0.86).x, at(0, -0.86).y,
      ],
      hair, ink(), r.ow,
    );
  } else {
    // bushy — wide, and ragged along the bottom
    const pts: number[] = [];
    pts.push(at(0, 0.98).x, at(0, 0.98).y, at(0.35, 1.14).x, at(0.35, 1.14).y);
    for (let i = 0; i <= 6; i++) {
      const s = 0.98 - (i / 6) * 1.96;
      const t = i % 2 === 0 ? 1.0 : 0.78;
      pts.push(at(t, s).x, at(t, s).y);
    }
    pts.push(at(0.35, -1.1).x, at(0.35, -1.1).y, at(0, -0.94).x, at(0, -0.94).y);
    poly(ctx, pts, hair, ink(), r.ow);
  }

  // moustache, mandatory
  const m1 = at(-0.16, 0.34);
  const m2 = at(-0.16, -0.28);
  ellipse(ctx, m1.x, m1.y, W * 0.42, W * 0.3, Math.atan2(axis.y, axis.x), hair, ink(), r.ow * 0.6);
  ellipse(ctx, m2.x, m2.y, W * 0.34, W * 0.26, Math.atan2(axis.y, axis.x), hairDk, ink(), r.ow * 0.6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shades and cigar — the last 10% of the transformation
// ─────────────────────────────────────────────────────────────────────────────

function drawAccessories(r: Rig): void {
  const ctx = r.ctx;
  const u = r.u;
  const h = headFrame(r);
  const { rx, ry } = h;
  const shadeT = shadesT(r);
  const cigarT = r.st.cigar ? clamp((r.fit - 0.35) / 0.3, 0, 1) : 0;
  if (shadeT <= 0.01 && cigarT <= 0.01) return;

  ctx.save();
  ctx.translate(h.c.x, h.c.y);
  ctx.rotate(h.ang);

  if (shadeT > 0.01) {
    // parked on the forehead, then slid down onto the nose
    const y = lerp(-ry * 0.92, -ry * 0.08, shadeT);
    const frame = col('#1e1b26');
    const glass = col(mixCol('#12101a', r.st.jacketAccent, 0.12));

    // temple arm back to the ear
    capsule(ctx, rx * 0.22, y, -rx * 0.72, y - 0.3 * u, 0.5 * u, frame, ink(), r.ow * 0.4);
    // bridge
    capsule(ctx, -rx * 0.02, y - 0.4 * u, rx * 0.24, y - 0.6 * u, 0.55 * u, frame, ink(), r.ow * 0.4);

    poly(
      ctx,
      [
        -rx * 0.4, y - 0.9 * u,
        rx * 0.06, y - 1.15 * u,
        rx * 0.08, y + 1.05 * u,
        -rx * 0.38, y + 0.8 * u,
      ],
      glass, ink(), r.ow * 0.6,
    );
    poly(
      ctx,
      [
        rx * 0.2, y - 1.3 * u,
        rx * 0.96, y - 1.75 * u,
        rx * 1.0, y + 1.35 * u,
        rx * 0.24, y + 1.55 * u,
      ],
      glass, ink(), r.ow * 0.6,
    );
    // a hard diagonal glint across the near lens
    poly(
      ctx,
      [
        rx * 0.34, y + 1.2 * u,
        rx * 0.58, y - 1.5 * u,
        rx * 0.74, y - 1.6 * u,
        rx * 0.5, y + 1.25 * u,
      ],
      col('#8fa6c8'), NO,
    );
    if (shadeT > 0.92) star(ctx, rx * 0.92, y - 1.4 * u, 1.4 * u, 4, col('#ffffff'), NO);

    // Most of the cast wears these, so if the expression stopped at the lens
    // then most of the cast would have no expression. The brows come back over
    // the top of the frame, and the eyes that are a JOKE — the X and the spiral
    // — are painted onto the glass, where a punchline can still be seen.
    if (shadeT >= 0.35) {
      const f = r.d.face;
      if (r.d.on && (f === 'dead' || f === 'dazed')) {
        const mark = col('#dbe3f0');
        const nlx = rx * 0.6;
        const flx = -rx * 0.16;
        if (f === 'dead') {
          crossEye(ctx, nlx, y, 1.5 * u, mark, Math.max(0.7, 0.6 * u));
          crossEye(ctx, flx, y - 0.1 * u, 1.0 * u, mark, Math.max(0.6, 0.5 * u));
        } else {
          const turn = r.d.reduced ? 0.6 : r.d.t * 2.4;
          spiralEye(ctx, nlx, y, 1.5 * u, mark, Math.max(0.55, 0.42 * u), turn);
          crossEye(ctx, flx, y - 0.1 * u, 1.0 * u, mark, Math.max(0.6, 0.48 * u));
        }
      }
      // A lens that has taken a punch. Seeded, so the crack does not travel.
      if (r.d.on && r.d.wear > 0.42) {
        const cx = rx * (0.4 + 0.5 * hashf(r.d.seed, 710));
        const cy = y + hashs(r.d.seed, 711) * 0.9 * u;
        ctx.strokeStyle = col('#c6d2e6');
        ctx.lineWidth = Math.max(0.5, 0.38 * u);
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = hashf(r.d.seed, 712 + i) * TAU;
          const l = (1.4 + 1.8 * hashf(r.d.seed, 716 + i)) * u;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l);
        }
        ctx.stroke();
      }
      drawBrows(r, rx, ry, true, y - 2.8 * u);
    }
  }

  if (cigarT > 0.01) {
    const bx = rx * 0.44;
    const by = ry * 0.48;
    const l = 6.2 * u * cigarT;
    const ex = bx + l;
    const ey = by + l * 0.24;
    capsule(ctx, bx, by, ex, ey, 1.0 * u, col('#6b4a2c'), ink(), r.ow * 0.6);
    capsule(ctx, bx + l * 0.16, by + l * 0.04, bx + l * 0.3, by + l * 0.07, 1.02 * u, col('#c8a24a'), ink(), r.ow * 0.35);
    ellipse(ctx, ex, ey, 0.9 * u, 0.9 * u, 0, col('#ff8a2a'), NO);
    if (flashAmt < 0.5) {
      burst(ctx, ex, ey, 1.25 * u, 6, col('#ffd166'), 0.4);
      ctx.save();
      ctx.globalAlpha *= 0.22 * cigarT;
      for (let i = 1; i <= 3; i++) {
        ellipse(ctx, ex + i * 1.3 * u, ey - i * 2.4 * u, 0.5 * u * i, 0.42 * u * i, 0, col('#cfd4dc'), NO);
      }
      ctx.restore();
    }
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Blood on the body
//
// Last pass of all, over cloth and skin alike, because that is where it lands.
// Every drop is placed from the seed against a BODY LANDMARK — a point along
// the spine or a limb — rather than in a box around the character, so it stays
// on him whatever the pose is doing.
// ─────────────────────────────────────────────────────────────────────────────

function drawGoreOver(r: Rig): void {
  const d = r.d;
  const b = d.blood;
  if (!d.on || b <= 0.02) return;
  const ctx = r.ctx;
  const u = r.u;
  const seed = d.seed;
  const P = jp(r, 'pelvis');
  const N = jp(r, 'neck');
  const pp = perp(P, N);
  const hw = (len2(P, N) || u) * 0.42 * r.girth;

  // The soaked patch. Blood spreads THROUGH cloth, so this one is translucent
  // and soft-edged where the spatter on top of it is neither.
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * 0.5;
  const soak = mid(P, N, 0.3 + 0.2 * hashf(seed, 720));
  const sr = hw * (0.34 + 0.8 * b);
  ellipse(
    ctx, soak.x + pp.x * hw * 0.22, soak.y + pp.y * hw * 0.22,
    sr, sr * 1.2, 0, col(leak(d)[1]), NO,
  );
  ctx.globalAlpha = prev;

  const sh = jp(r, 'armR_upper');
  const el = jp(r, 'armR_lower');
  const hip = jp(r, 'legR_upper');
  const kn = jp(r, 'legR_lower');
  const n = Math.min(12, Math.round(b * 9 * (1 + d.wear * 0.35)));
  const [RAW, DARK] = leak(d);
  const bl = col(RAW);
  const dk = col(DARK);

  for (let i = 0; i < n; i++) {
    const where = hashf(seed, 730 + i);
    const f = hashf(seed, 750 + i);
    let px: number;
    let py: number;
    if (where < 0.58) {
      const t = 0.05 + 0.85 * f;
      // Kept inside the torso capsule: a drop hanging in mid-air beside him
      // reads as a bug, not as blood.
      const lat = hw * (hashf(seed, 770 + i) * 1.25 - 0.55);
      px = lerp(P.x, N.x, t) + pp.x * lat;
      py = lerp(P.y, N.y, t) + pp.y * lat;
    } else if (where < 0.82) {
      px = lerp(sh.x, el.x, f);
      py = lerp(sh.y, el.y, f);
    } else {
      px = lerp(hip.x, kn.x, f);
      py = lerp(hip.y, kn.y, f);
    }
    const s = (0.45 + 1.2 * hashf(seed, 790 + i)) * u * (0.55 + 0.75 * b);
    ellipse(ctx, px, py, s, s * 0.85, 0, bl, NO);
    if (hashf(seed, 810 + i) < 0.55) {
      ellipse(
        ctx, px + hashs(seed, 830 + i) * 2.4 * u, py + hashs(seed, 850 + i) * 2.1 * u,
        s * 0.4, s * 0.38, 0, bl, NO,
      );
    }
    // the big ones run
    if (s > 1.1 * u) {
      capsule(ctx, px, py, px, py + s * (1.4 + 2.2 * b), s * 0.32, dk, NO);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

function drawHeldWeapon(r: Rig, w: WeaponDef): void {
  const ctx = r.ctx;
  const wr = jp(r, 'handR');
  const tipH = tp(r, 'handR');
  const grip = mid(wr, tipH, 0.35);
  ctx.save();
  ctx.translate(grip.x, grip.y);
  ctx.rotate(Math.atan2(tipH.y - wr.y, tipH.x - wr.x) - 0.35);
  weaponShape(ctx, w, r.u);
  ctx.restore();
}

export function drawWeapon(
  ctx: C2D,
  w: WeaponDef,
  x: number,
  y: number,
  rot: number,
  facing: Facing,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.rotate(rot);
  weaponShape(ctx, w, 1);
  ctx.restore();
}

/** Draws a weapon from its grip at the origin, pointing along +x. */
function weaponShape(ctx: C2D, w: WeaponDef, u: number): void {
  const art = w.art;
  const L = art.length * u;
  const T = Math.max(0.6, art.thickness * u);
  const ow = Math.max(1, 1.2 * u);
  const body = col(art.color);
  const acc = col(art.accent);
  const grip = col('#2a2430');

  switch (art.shape) {
    case 'stick': {
      capsule(ctx, 0, 0, L, 0, T * 0.5, body, ink(), ow);
      capsule(ctx, -T * 0.5, 0, L * 0.24, 0, T * 0.62, grip, ink(), ow);
      capsule(ctx, L * 0.78, 0, L * 0.94, 0, T * 0.56, acc, ink(), ow * 0.7);
      if (art.spikes) {
        studs(ctx, L * 0.96, -T * 0.45, L * 0.34, -T * 0.45, art.segments ?? 4, T * 0.95, acc);
      }
      break;
    }
    case 'blade': {
      // Short, and read almost entirely by the taper: a straight spine with one
      // ground edge, a stub crossguard and a wrapped handle. Anything longer
      // than this stops being a knife and starts being a sword.
      capsule(ctx, -T * 0.5, 0, L * 0.3, 0, T * 0.34, col(art.accent), ink(), ow);
      roundRect(ctx, L * 0.28, -T * 0.46, T * 0.34, T * 0.92, T * 0.14, col('#5d5a66'), ink(), ow * 0.8);
      poly(
        ctx,
        [L * 0.34, -T * 0.36, L, -T * 0.05, L, T * 0.08, L * 0.34, T * 0.34],
        body, ink(), ow,
      );
      // The light along the ground edge, which is what makes it read as sharp.
      poly(ctx, [L * 0.4, -T * 0.24, L * 0.94, -T * 0.03, L * 0.4, T * 0.02], acc, NO);
      break;
    }
    case 'lasso': {
      // A cable, not a chain: one continuous line that sags under its own
      // weight and ends in the open loop it is thrown with. Drawn as a curve
      // rather than as links so it reads as steel rope at fifty units.
      const n = Math.max(6, art.segments ?? 12);
      capsule(ctx, -T * 0.4, 0, L * 0.2, 0, T * 0.7, grip, ink(), ow);
      ctx.beginPath();
      ctx.moveTo(L * 0.2, 0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        // Slack in the middle, lifting again as it reaches the loop.
        ctx.lineTo(L * (0.2 + t * 0.5), Math.sin(t * Math.PI) * T * 1.9);
      }
      ctx.strokeStyle = body;
      ctx.lineWidth = T * 0.62;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = acc;
      ctx.lineWidth = T * 0.2;
      ctx.stroke();
      // The loop on the end, tilted so it is an ellipse rather than a circle.
      ellipse(ctx, L * 0.83, T * 0.5, L * 0.16, T * 1.5, 0.42, 'none', body, T * 0.5);
      ellipse(ctx, L * 0.83, T * 0.5, L * 0.16, T * 1.5, 0.42, 'none', acc, T * 0.16);
      if (art.spikes) star(ctx, L * 0.7, 0, T * 1.6, 6, acc, ink());
      break;
    }
    case 'flail': {
      capsule(ctx, -T * 0.4, 0, L * 0.26, 0, T * 0.6, grip, ink(), ow);
      const n = Math.max(3, art.segments ?? 7);
      const step = (L * 0.58) / n;
      let px = L * 0.26;
      let py = 0;
      let a = 0;
      for (let i = 0; i < n; i++) {
        // each link trails a little further behind the one before it
        a += 0.13 + i * 0.02;
        const nx = px + Math.cos(a) * step;
        const ny = py + Math.sin(a) * step;
        ellipse(
          ctx, (px + nx) / 2, (py + ny) / 2, step * 0.7, T * 0.52, a,
          i % 2 ? body : col(shadeOf(art.color, 0.78)), ink(), ow * 0.6,
        );
        px = nx;
        py = ny;
      }
      if (art.spikes) star(ctx, px, py, T * 1.9, 8, acc, ink());
      ellipse(ctx, px, py, T * 1.15, T * 1.15, 0, body, ink(), ow);
      ellipse(ctx, px - T * 0.32, py - T * 0.32, T * 0.3, T * 0.3, 0, col(shadeOf(art.color, 1.3)), NO);
      break;
    }
    case 'blocky': {
      roundRect(ctx, -L * 0.1, -T * 0.5, L, T, T * 0.22, body, ink(), ow);
      if (w.kind === 'keyboard') {
        for (let row = 0; row < 3; row++) {
          for (let i = 0; i < 7; i++) {
            roundRect(
              ctx,
              -L * 0.05 + i * L * 0.132 + row * L * 0.012,
              -T * 0.34 + row * T * 0.24,
              L * 0.1, T * 0.18, T * 0.05,
              acc, NO,
            );
          }
        }
      } else {
        // a graphics card, still worth more than the average car
        roundRect(ctx, -L * 0.06, -T * 0.34, L * 0.92, T * 0.68, T * 0.14, col(shadeOf(art.color, 0.8)), NO);
        ellipse(ctx, L * 0.22, 0, T * 0.3, T * 0.3, 0, acc, ink(), ow * 0.5);
        ellipse(ctx, L * 0.62, 0, T * 0.3, T * 0.3, 0, acc, ink(), ow * 0.5);
        for (let i = 0; i < 8; i++) {
          roundRect(ctx, -L * 0.08 + i * L * 0.03, T * 0.4, L * 0.014, T * 0.28, 0, acc, NO);
        }
      }
      break;
    }
    case 'gun': {
      const isTaser = w.kind === 'taser';
      poly(
        ctx,
        [0, T * 0.3, -L * 0.16, T * 1.5, L * 0.06, T * 1.6, L * 0.2, T * 0.4],
        grip, ink(), ow,
      );
      roundRect(ctx, -L * 0.06, -T * 0.5, L * 0.72, T, T * 0.2, body, ink(), ow);
      roundRect(ctx, L * 0.5, -T * 0.24, L * 0.5, T * 0.48, T * 0.12, col(shadeOf(art.color, 0.85)), ink(), ow);
      ctx.strokeStyle = ink();
      ctx.lineWidth = ow * 0.8;
      ctx.beginPath();
      ctx.arc(L * 0.14, T * 0.55, T * 0.42, 0, Math.PI);
      ctx.stroke();
      if (isTaser) {
        capsule(ctx, L * 0.98, -T * 0.34, L * 1.2, -T * 0.42, T * 0.1, acc, ink(), ow * 0.4);
        capsule(ctx, L * 0.98, T * 0.34, L * 1.2, T * 0.42, T * 0.1, acc, ink(), ow * 0.4);
        zigzag(ctx, L * 1.2, -T * 0.42, L * 1.2, T * 0.42, T * 0.5, 5, acc, ow * 0.7);
      } else {
        ellipse(ctx, L * 0.22, -T * 0.12, T * 0.16, T * 0.16, 0, acc, NO);
      }
      break;
    }
    case 'shield': {
      const hw = L * 0.5;
      roundRect(ctx, -L * 0.12, -hw, L * 0.42, hw * 2, L * 0.06, body, ink(), ow);
      // visor band
      roundRect(ctx, -L * 0.06, -hw * 0.78, L * 0.3, hw * 0.6, L * 0.03, col(shadeOf(art.color, 1.45)), ink(), ow * 0.6);
      // hazard stripes along the bottom
      for (let i = 0; i < 4; i++) {
        const y = hw * (0.2 + i * 0.17);
        poly(
          ctx,
          [-L * 0.11, y, L * 0.29, y - hw * 0.12, L * 0.29, y - hw * 0.03, -L * 0.11, y + hw * 0.09],
          acc, NO,
        );
      }
      capsule(ctx, 0, -hw * 0.16, 0, hw * 0.16, T * 0.4, grip, ink(), ow * 0.6);
      break;
    }
    case 'plate': {
      const hw = L * 0.46;
      poly(
        ctx,
        [-L * 0.14, -hw * 0.92, L * 0.5, -hw * 0.7, L * 0.56, hw * 0.78, -L * 0.1, hw * 0.9],
        body, ink(), ow,
      );
      poly(
        ctx,
        [-L * 0.06, -hw * 0.74, L * 0.42, -hw * 0.56, L * 0.44, -hw * 0.02, -L * 0.04, -hw * 0.08],
        col(shadeOf(art.color, 0.42)), ink(), ow * 0.7,
      );
      roundRect(ctx, L * 0.1, hw * 0.1, L * 0.24, T * 0.5, T * 0.2, acc, ink(), ow * 0.5);
      // the window that famously did not survive its own demonstration
      const cx = L * 0.24;
      const cy = -hw * 0.32;
      ellipse(ctx, cx, cy, T * 0.5, T * 0.5, 0, col('#0d0c12'), NO);
      ctx.strokeStyle = col('#c9d4e4');
      ctx.lineWidth = ow * 0.5;
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + 0.3;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * hw * 0.36, cy + Math.sin(a) * hw * 0.3);
      }
      ctx.stroke();
      break;
    }
  }
}
