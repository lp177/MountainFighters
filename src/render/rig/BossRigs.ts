/**
 * Bosses that are not people.
 *
 * `BossDef.rigOverride` has always named four non-human bodies and never had
 * one. Everything went through `drawCharacter`, which knows exactly one
 * silhouette — a biped with a head, two arms and two legs — so the fifteen
 * billion dollar Shiba was a large orange man with spikes, the Cybertruck was a
 * large grey man with spikes, and the Starship was a large chrome man with
 * spikes. This file is the missing half: real bodies for the four kinds that
 * are not a person, drawn from the same vector primitives and lit by the same
 * ink-and-fill house style as the rest of the cast.
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────
 *
 * `drawBossRig` is a drop-in swap for `drawCharacter`: it takes the SAME ground
 * point in screen space, the same facing, the same flash/tint/alpha/scale, and
 * the same `RigDamage`. A caller does:
 *
 *     if (hasBossRig(bossKind)) drawBossRig(ctx, bossKind, style, x, y, facing, o);
 *     else                      drawCharacter(ctx, style, pose, skel, x, y, facing, o);
 *
 * and nothing else changes. `state` and `frame` are the fighter's state machine
 * verbatim, so the art walks, winds up, gets hurt and dies off the same clock
 * the combat does — no second animation system, no clip table to keep in sync.
 *
 * ── HOW THE STYLE IS READ ───────────────────────────────────────────────────
 *
 * A `RigStyle` describes a dwarf, so half of it is meaningless on a dog and all
 * of it is meaningless on a rocket. The parts that survive are the ones that are
 * really just a palette:
 *
 *     skin / skinShade  → the primary body colour and its shade
 *     hair / tunicColor → the secondary: cream fur, bright panel, hull white
 *     jacketColor       → the dark trim: collar leather, tyre, heat tile
 *     jacketAccent      → the hot accent: brass studs, light bar, flame
 *     scale / girth     → size and how heavy the thing sits
 *     headSize          → head proportion, where there is a head
 *
 * `beardStyle`, `shades`, `spikes`, `cigar`, `outfit` and `tattoo` are ignored.
 * Nothing here needs a beard.
 *
 * ── DRAW-PATH RULES ─────────────────────────────────────────────────────────
 *
 * No allocation once a frame is running: every point buffer, every drive value
 * and every damage struct is a module-level scratch filled in place, exactly as
 * `CharacterRig` does. Colours go through a small cached tint/lift/flash
 * pipeline so a boss sits in the map's light like everyone else, and so that
 * `flash: 1` produces a real solid-white silhouette — outlines included —
 * rather than a pale character with dark lines still drawn through it.
 */

import type {
  BoneName,
  FaceState,
  Facing,
  Pose,
  RigDamage,
  RigStyle,
} from '@/core/types';
import { TAU, clamp, lerp } from '@/core/math';
import { burst, capsule, ellipse, poly, roundRect, spikeStrip } from '@/render/Shapes';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { HUMAN_SKELETON } from '@/render/rig/Skeleton';

type C2D = CanvasRenderingContext2D;

/** Matches CharacterRig's ink exactly — these things stand next to dwarfs. */
const INK = '#191320';
/** Shapes.ts sentinel: skip the stroke, or skip the fill. */
const NO = 'none';
/** Contact shadow ink. Cool near-black, never pure black. */
const SHADOW = '#0e0b16';

/**
 * Outline half-width in RIG units. Everything below draws inside
 * `ctx.scale(facing * u, u)`, so this lands at `OW * u` pixels of ink — the
 * same rule CharacterRig uses (`max(1, 1.35 * u)`), which is what keeps a boss
 * inked like the fighter standing next to it instead of like a sticker.
 */
const OW = 1.05;

// ─────────────────────────────────────────────────────────────────────────────
// Colour: ambient tint, black lift, hit flash
//
// Lifted wholesale from CharacterRig, minus the parts only a wardrobe needs.
// The three rules are the same and for the same reasons: a map tint must not
// crush a dark boss into the floor, true black must read as a surface rather
// than a hole, and the identifiers a player tracks mid-fight — the Shiba's
// orange, the light bar, the flame — shrug most of the tint off.
// ─────────────────────────────────────────────────────────────────────────────

const MODE_FILL = 0;
const MODE_KEY = 1;
const MODE_INK = 2;

const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

const TINT_MIX = 0.5;
const KEY_TINT_MIX = 0.22;
const TINT_FULL_AT = 150;
const LIFT_KNEE = 70;
const LIFT_GAIN = 0.45;
const KEY_LIFT_KNEE = 95;
const KEY_LIFT_GAIN = 0.5;
const LIFT_R = 0.79;
const LIFT_G = 1.01;
const LIFT_B = 1.49;

let flashAmt = 0;
let tintR = 255;
let tintG = 255;
let tintB = 255;
let tinted = false;

const parseCache = new Map<string, number>();
const colCache = new Map<string, string>();

let kFill = '||0';
let kKey = '||1';
let kInk = '||2';
let inkCol = INK;
let lastTint: string | null = null;
let lastFlash = -1;

/** Packed 0xRRGGBB, parsed once per literal for the life of the page. */
function rgbOf(c: string): number {
  const hit = parseCache.get(c);
  if (hit !== undefined) return hit;
  let out = 0x888888;
  if (c.charCodeAt(0) === 35) {
    if (c.length >= 7) out = parseInt(c.slice(1, 7), 16);
    else if (c.length >= 4) {
      const r = parseInt(c[1], 16);
      const g = parseInt(c[2], 16);
      const b = parseInt(c[3], 16);
      out = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
    }
  }
  if (!Number.isFinite(out) || Number.isNaN(out)) out = 0x888888;
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

/** Darkens (f < 1) or lifts toward white (f > 1). The far-side-limb trick. */
function shadeOf(c: string, f: number): string {
  const p = rgbOf(c);
  const r = (p >> 16) & 255;
  const g = (p >> 8) & 255;
  const b = p & 255;
  return f <= 1
    ? hex(r * f, g * f, b * f)
    : hex(lerp(r, 255, f - 1), lerp(g, 255, f - 1), lerp(b, 255, f - 1));
}

function mixCol(a: string, b: string, t: number): string {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return hex(
    lerp((A >> 16) & 255, (B >> 16) & 255, t),
    lerp((A >> 8) & 255, (B >> 8) & 255, t),
    lerp(A & 255, B & 255, t),
  );
}

function shadeCol(c: string, mode: number): string {
  const key = c + (mode === MODE_FILL ? kFill : mode === MODE_KEY ? kKey : kInk);
  const hit = colCache.get(key);
  if (hit !== undefined) return hit;

  const p = rgbOf(c);
  let r = (p >> 16) & 255;
  let g = (p >> 8) & 255;
  let b = p & 255;

  if (tinted) {
    const lum0 = r * LUM_R + g * LUM_G + b * LUM_B;
    const m =
      mode === MODE_KEY ? KEY_TINT_MIX : lerp(TINT_MIX, 1, clamp(lum0 / TINT_FULL_AT, 0, 1));
    r *= (255 - (255 - tintR) * m) / 255;
    g *= (255 - (255 - tintG) * m) / 255;
    b *= (255 - (255 - tintB) * m) / 255;
  }

  if (mode !== MODE_INK) {
    const knee = mode === MODE_KEY ? KEY_LIFT_KNEE : LIFT_KNEE;
    const lum = r * LUM_R + g * LUM_G + b * LUM_B;
    if (lum < knee) {
      const dd = knee - lum;
      const add = ((dd * dd) / knee) * (mode === MODE_KEY ? KEY_LIFT_GAIN : LIFT_GAIN);
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

/** Ordinary surface. */
function col(c: string): string {
  return shadeCol(c, MODE_FILL);
}

/** An identifier: fur, light bar, flame. Keeps its read in any lighting. */
function keyCol(c: string): string {
  return shadeCol(c, MODE_KEY);
}

function ink(): string {
  return inkCol;
}

function setPalette(tint: string | undefined, flash: number): void {
  const t = tint ?? '';
  if (t === lastTint && flash === lastFlash) return;
  lastTint = t;
  lastFlash = flash;
  flashAmt = flash;
  tinted = !!tint;
  if (tinted) {
    const p = rgbOf(tint as string);
    tintR = (p >> 16) & 255;
    tintG = (p >> 8) & 255;
    tintB = p & 255;
  }
  const pre = `|${t}|${flash > 0 ? flash.toFixed(2) : ''}`;
  kFill = `${pre}0`;
  kKey = `${pre}1`;
  kInk = `${pre}2`;
  if (colCache.size > 2048) colCache.clear();
  inkCol = shadeCol(INK, MODE_INK);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch geometry — every buffer below is allocated exactly once
// ─────────────────────────────────────────────────────────────────────────────

const P3: number[] = [0, 0, 0, 0, 0, 0];
const P4: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
const P5: number[] = new Array<number>(10).fill(0);
const P7: number[] = new Array<number>(14).fill(0);
/** Local-space templates for the leg chain and the ear triangle. */
const GX = new Float64Array(4);
const GY = new Float64Array(4);
const EX = new Float64Array(3);
const EY = new Float64Array(3);

/** Nine samples down the spiral, doubled into a closed outline. */
const TAIL_N = 9;
const TAIL_PTS: number[] = new Array<number>(TAIL_N * 4).fill(0);
const TAIL_TRIM: number[] = new Array<number>(TAIL_N * 4).fill(0);

/** One quadruped limb: hip/shoulder, mid, low, toe. */
const LX = new Float64Array(4);
const LY = new Float64Array(4);

function tri(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  fill: string, outline: string, ow: number,
): void {
  P3[0] = ax; P3[1] = ay; P3[2] = bx; P3[3] = by; P3[4] = cx; P3[5] = cy;
  poly(ctx, P3, fill, outline, ow);
}

function quad(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
  fill: string, outline: string, ow: number,
): void {
  P4[0] = ax; P4[1] = ay; P4[2] = bx; P4[3] = by;
  P4[4] = cx; P4[5] = cy; P4[6] = dx; P4[7] = dy;
  poly(ctx, P4, fill, outline, ow);
}

/**
 * Shapes.ts keeps its tapered tube private and `limb()` hard-codes its outline
 * width, which is 2 PIXELS in CharacterRig's space and 2 RIG UNITS in this
 * file's — a slab of ink on a boss drawn at scale 2.6. Same geometry, outline
 * width the caller's business.
 */
function tube(
  ctx: C2D,
  x1: number, y1: number, x2: number, y2: number,
  r1: number, r2: number,
  fill: string, outline: string, ow: number,
): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const q = Math.PI * 0.5;
  ctx.beginPath();
  ctx.arc(x1, y1, Math.max(0.01, r1), a + q, a - q);
  ctx.arc(x2, y2, Math.max(0.01, r2), a - q, a + q);
  ctx.closePath();
  if (ow > 0 && outline !== NO) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = ow * 2;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  if (fill !== NO) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

/**
 * Two soft rings rather than one flat disc, and sized to the FOOTPRINT rather
 * than the height — a truck sixty units long that casts the same little puddle
 * as a dwarf is a truck floating an inch off the floor.
 */
function contactShadow(ctx: C2D, x: number, y: number, rx: number, a: number): void {
  const r = Math.abs(rx);
  if (r < 0.01 || a <= 0) return;
  const prev = ctx.globalAlpha;
  // Raw, never through col(): a hit flash must not turn the shadow white.
  ctx.globalAlpha = prev * clamp(a * 0.45, 0, 1);
  ellipse(ctx, x, y, r * 1.3, r * 0.4, 0, SHADOW, NO, 0);
  ctx.globalAlpha = prev * clamp(a * 0.9, 0, 1);
  ellipse(ctx, x, y, r * 0.72, r * 0.22, 0, SHADOW, NO, 0);
  ctx.globalAlpha = prev;
}

/**
 * spikeStrip inks its own outlines, which would punch dark lines through the
 * hit-flash silhouette — so above half flash the studs go on flat.
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
    tri(
      ctx,
      px - ux * size * 0.62, py - uy * size * 0.62,
      px - uy * size * 1.15, py + ux * size * 1.15,
      px + ux * size * 0.62, py + uy * size * 0.62,
      color, color, size * 0.3,
    );
  }
}

/** Stable hash in [0,1) from a seed and a slot. Marks must not crawl. */
function hashf(seed: number, i: number): number {
  let x = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 1, 0x85ebca77);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 13), 0x297a2d39);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function hashs(seed: number, i: number): number {
  return hashf(seed, i) * 2 - 1;
}

function nowSec(): number {
  return typeof performance === 'undefined' ? 0 : performance.now() * 0.001;
}

/** 0 → 1 → 0 across [a, b]. The shape of every wind-up and every lunge. */
function pulse(t: number, a: number, b: number): number {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return Math.sin(u * Math.PI);
}

function ramp(t: number, a: number, b: number): number {
  return clamp((t - a) / (b - a), 0, 1);
}

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage — the same rules CharacterRig plays by
// ─────────────────────────────────────────────────────────────────────────────

const BLOOD = '#9e1420';
const BLOOD_DK = '#5c0a12';
const BLOOD_WET = '#cf2230';
const DIRT = '#2f2833';

interface Dmg {
  on: boolean;
  wear: number;
  blood: number;
  breath: number;
  seed: number;
  face: FaceState;
  /** For a dog this is the COLLAR: knocked off, stolen, or eaten. */
  hatless: boolean;
  reduced: boolean;
  /** -1..1 breathing oscillation, already reduced-motion aware. */
  heave: number;
  /** Wear stages, overlapping: scuffed, dented, coming apart. */
  t1: number;
  t2: number;
  t3: number;
  /** Wall-clock seconds. Presentation only. */
  t: number;
}

const DMG: Dmg = {
  on: false, wear: 0, blood: 0, breath: 0, seed: 0, face: 'calm', hatless: false,
  reduced: false, heave: 0, t1: 0, t2: 0, t3: 0, t: 0,
};

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

function stage(v: number, a: number, b: number): number {
  return clamp((v - a) / (b - a), 0, 1);
}

function fillDamage(src: RigDamage | undefined): Dmg {
  const t = nowSec();
  DMG.t = t;
  DMG.reduced = domReducedMotion(t);
  if (!src) {
    DMG.on = false;
    DMG.wear = 0;
    DMG.blood = 0;
    DMG.breath = 0;
    DMG.seed = 0;
    DMG.face = 'calm';
    DMG.hatless = false;
    DMG.heave = 0;
    DMG.t1 = 0;
    DMG.t2 = 0;
    DMG.t3 = 0;
    return DMG;
  }
  const breath = clamp(src.breath, 0, 1);
  const wear = clamp(src.wear, 0, 1);
  DMG.on = true;
  DMG.wear = wear;
  DMG.blood = clamp(src.blood, 0, 1);
  DMG.breath = breath;
  DMG.seed = src.seed | 0;
  DMG.face = src.face;
  DMG.hatless = src.hatless === true;
  DMG.t1 = stage(wear, 0.1, 0.4);
  DMG.t2 = stage(wear, 0.36, 0.68);
  DMG.t3 = stage(wear, 0.62, 0.96);
  const ph = hashf(DMG.seed, 3) * TAU;
  const slow = Math.sin(t * 2.5 + ph);
  const fast = Math.sin(t * 9.6 + ph * 1.7);
  DMG.heave = lerp(slow, fast, breath * breath) * (0.2 + 0.8 * breath) * (DMG.reduced ? 0.28 : 1);
  return DMG;
}

/** Ground-in scratches along a line. Dirt, not blood: survives gore 'off'. */
function scuffs(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number,
  wide: number, n: number, salt: number, w: number,
): void {
  const t = DMG.t1;
  if (t <= 0.05 || n <= 0) return;
  const seed = DMG.seed;
  const cnt = Math.max(1, Math.round(n * t));
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l;
  const ny = dx / l;
  ctx.strokeStyle = col(DIRT);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < cnt; i++) {
    const f = 0.12 + 0.76 * hashf(seed, salt + i);
    const s = hashs(seed, salt + 41 + i) * wide;
    const px = ax + dx * f + nx * s;
    const py = ay + dy * f + ny * s;
    const a = hashf(seed, salt + 83 + i) * TAU;
    const len = 0.9 + 1.6 * hashf(seed, salt + 127 + i);
    ctx.moveTo(px - Math.cos(a) * len, py - Math.sin(a) * len);
    ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
  }
  ctx.stroke();
}

/** Spatter around a landmark. Placed off the seed so it stays put. */
function spatter(
  ctx: C2D, cx: number, cy: number, spread: number, n: number, salt: number, sz: number,
): void {
  const b = DMG.blood;
  if (b <= 0.02) return;
  const seed = DMG.seed;
  const cnt = Math.max(1, Math.round(n * b));
  for (let i = 0; i < cnt; i++) {
    const a = hashf(seed, salt + i) * TAU;
    const r = spread * (0.2 + 0.8 * hashf(seed, salt + 61 + i));
    const rr = sz * (0.35 + 0.9 * hashf(seed, salt + 97 + i));
    ellipse(
      ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.7, rr, rr * 0.82, 0,
      col(i & 1 ? BLOOD : BLOOD_DK), NO, 0,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive — the fighter state machine, read as animation
//
// There is no clip table here. A boss body has nothing in common with the
// twenty-bone humanoid the clips are authored against, so instead the state and
// its frame counter are boiled down to a dozen scalars that ANY of these bodies
// can interpret: how fast the gait is turning, how coiled it is, how far it has
// lunged, how flat it is on the floor. A dog reads `coil` as ears back and
// hackles up; a truck reads it as squatting on its suspension. Same number.
// ─────────────────────────────────────────────────────────────────────────────

interface Drive {
  /** Frames into the current state. */
  f: number;
  /** Wall-clock seconds, for free-running idles. Presentation only. */
  t: number;
  /** 0..1 gait phase, wrapped. */
  gait: number;
  /** 0..1 how much energy is in the gait. 0 = standing still. */
  run: number;
  /** 0..1 compression: haunches down, suspension loaded. */
  crouch: number;
  /** -1..1 along facing. Negative is the anticipation, positive the lunge. */
  push: number;
  /** 0..1 wind-up tension. Ears back, hackles up, brakes on. */
  coil: number;
  /** 0..1 off the ground. */
  air: number;
  /** Body pitch in radians. Negative tips the nose UP. */
  pitch: number;
  /** Vertical offset in rig units. Negative is up. */
  bob: number;
  /** -1..1 tail / antenna / flap oscillator. */
  wag: number;
  /** 0..1 on the floor. */
  down: number;
  /** 0..1 flinch from a hit, decaying. */
  flinch: number;
  /** 0..1 showing off. */
  show: number;
  /** 0..1 dizzy. */
  dizzy: number;
}

const DRV: Drive = {
  f: 0, t: 0, gait: 0, run: 0, crouch: 0, push: 0, coil: 0, air: 0,
  pitch: 0, bob: 0, wag: 0, down: 0, flinch: 0, show: 0, dizzy: 0,
};

function fillDrive(state: string | undefined, frame: number | undefined, reduced: boolean): Drive {
  const d = DRV;
  const f = frame ?? 0;
  const t = nowSec();
  d.f = f;
  d.t = t;
  d.gait = 0;
  d.run = 0;
  d.crouch = 0;
  d.push = 0;
  d.coil = 0;
  d.air = 0;
  d.pitch = 0;
  d.bob = 0;
  d.wag = 0;
  d.down = 0;
  d.flinch = 0;
  d.show = 0;
  d.dizzy = 0;

  const osc = reduced ? 0 : Math.sin(t * 2.1);
  const fast = reduced ? 0 : Math.sin(t * 9.0);

  switch (state) {
    case 'walk':
    case 'entering':
      d.gait = wrap01(f / 26);
      d.run = 0.5;
      d.bob = -Math.abs(Math.sin(d.gait * TAU)) * 0.55;
      break;

    case 'run':
    case 'dash':
      d.gait = wrap01(f / 13);
      d.run = 1;
      d.push = 0.3;
      d.pitch = -0.07;
      d.bob = -Math.abs(Math.sin(d.gait * TAU)) * 1.2;
      break;

    case 'riding':
      d.gait = wrap01(f / 16);
      d.run = 0.8;
      break;

    case 'jump':
      d.air = 1;
      d.crouch = 1 - ramp(f, 0, 5);
      d.pitch = -0.16;
      d.push = 0.2;
      break;

    case 'fall':
    case 'thrown':
      d.air = 1;
      d.pitch = 0.12;
      d.push = -0.1;
      break;

    case 'launched':
      d.air = 1;
      d.pitch = 0.34;
      d.flinch = 0.7;
      d.push = -0.4;
      break;

    case 'land':
      d.crouch = 1 - ramp(f, 0, 9);
      break;

    case 'attack':
    case 'super':
      // A generic anticipation-then-commit envelope. Every boss move in the
      // game front-loads its startup, so a shape rather than per-move data is
      // both right often enough and impossible to get out of sync.
      d.coil = f < 12 ? ramp(f, 0, 11) : clamp(1 - (f - 12) / 9, 0, 1);
      d.push = -0.32 * d.coil + pulse(f, 11, 34) * 1.15;
      d.crouch = d.coil * 0.7;
      d.pitch = -0.1 * pulse(f, 11, 30);
      d.run = pulse(f, 11, 30) * 0.8;
      d.gait = wrap01(f / 10);
      break;

    case 'grabbing':
      d.coil = 0.55;
      d.push = 0.3;
      break;

    case 'grabbed':
      d.flinch = 0.5;
      d.push = -0.25;
      break;

    case 'block':
    case 'blockstun':
      d.crouch = 0.42;
      d.coil = 0.6;
      d.push = -0.16;
      break;

    case 'hurt':
      d.flinch = clamp(1 - f / 13, 0, 1);
      d.push = -0.5 * d.flinch;
      d.pitch = 0.14 * d.flinch;
      d.crouch = 0.3 * d.flinch;
      break;

    case 'knockdown':
      d.down = ramp(f, 0, 7);
      d.crouch = d.down;
      break;

    case 'getup':
      d.down = 1 - ramp(f, 0, 22);
      d.crouch = d.down * 0.8;
      break;

    case 'dead':
      d.down = ramp(f, 0, 12);
      d.crouch = 1;
      break;

    case 'stunned':
      d.dizzy = 1;
      d.crouch = 0.28;
      d.wag = fast * 0.4;
      d.bob = osc * 0.7;
      break;

    case 'victory':
      d.show = 1;
      d.wag = reduced ? 0.4 : Math.sin(t * 11);
      d.bob = osc * 0.8;
      break;

    default:
      // idle, and anything the state machine grows later
      d.bob = osc * 0.5;
      d.wag = osc * 0.45;
      break;
  }

  if (DMG.on) d.bob += DMG.heave * 0.4;
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type BossRigKind = 'shiba' | 'cybertruck' | 'rocket' | 'robot_giant' | 'humanoid';

/** True when this kind has bespoke art here and should NOT go through drawCharacter. */
export function hasBossRig(kind: string | undefined): boolean {
  return (
    kind === 'shiba' || kind === 'cybertruck' || kind === 'rocket' || kind === 'robot_giant'
  );
}

/**
 * Draw a boss at its ground point. (x, y) is the feet/base in SCREEN space,
 * exactly as drawCharacter receives it, so the caller swaps one for the other.
 */
export function drawBossRig(
  ctx: CanvasRenderingContext2D,
  kind: BossRigKind,
  style: RigStyle,
  x: number,
  y: number,
  facing: Facing,
  opts?: {
    /** Animation state, so the art can walk, wind up and be hurt. */
    state?: string;
    /** Frames into that state. */
    frame?: number;
    flash?: number;
    tint?: string;
    alpha?: number;
    scale?: number;
    damage?: RigDamage;
  },
): void {
  if (kind === 'humanoid') return;

  const u = Math.max(0.05, (opts?.scale ?? 1) * (style.scale || 1));
  setPalette(opts?.tint, clamp(opts?.flash ?? 0, 0, 1));
  const d = fillDamage(opts?.damage);
  const dr = fillDrive(opts?.state, opts?.frame, d.reduced);

  if (kind === 'robot_giant') {
    drawRobotGiant(ctx, style, x, y, facing, u, dr, opts);
    setPalette(undefined, 0);
    return;
  }

  ctx.save();
  ctx.globalAlpha *= clamp(opts?.alpha ?? 1, 0, 1);
  // Everything below is authored in RIG UNITS with the origin at the ground
  // contact point and +x forward, so the facing flip and the boss's scale are
  // one transform and never appear in the geometry again.
  ctx.translate(x, y);
  ctx.scale(facing * u, u);

  if (kind === 'shiba') drawShiba(ctx, style, dr);
  else if (kind === 'cybertruck') drawCybertruck(ctx, style, dr);
  else drawRocket(ctx, style, dr);

  ctx.restore();
  setPalette(undefined, 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// FLOKI — the fifteen-billion-dollar dog
//
// The brief for this one is short: it has to be CUTE. A Shiba is read by four
// things and nothing else — the upright triangular ears, the curled tail over
// the back, the cream mask under an orange coat, and the smirk. Miss any one
// and you have drawn a fox, a corgi or a husky; miss two and you have drawn a
// generic dog. Everything else on this body is negotiable and all four of those
// are not.
//
// It is also a QUADRUPED, which is the whole reason the old one failed: a dog
// standing on two legs is a mascot costume. The body is horizontal, the legs
// are under it in two pairs, and the head is out in front on a thick neck.
//
// The threat comes entirely from CONTRAST. He is a small smug dog wearing a
// studded collar with a coin on it and a security earpiece, and he is going to
// put you through a wall. A cute thing trying to kill you is funnier — and
// reads better at 60 pixels — than an ugly thing trying to kill you.
// ═════════════════════════════════════════════════════════════════════════════

const COLLAR_LEATHER = '#241c26';
const DOG_NOSE = '#2b2330';
const DOG_EYE = '#1d1720';
const TONGUE = '#e2707f';
const TONGUE_DK = '#bd4f60';
const EAR_PINK = '#e8a3a0';
const LASER = '#ff3b4a';
const GLINT = '#f4f8ff';

/**
 * One leg, four joints, rotated about the top one and lifted through its swing.
 * Front and rear both come through here; the rear just arrives with the dog's
 * zig-zag hock already in the rest positions.
 */
function dogLeg(
  ctx: C2D,
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  ang: number, lift: number, dx: number, dy: number,
  fur: string, cream: string, ow: number,
): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  LX[0] = x0 + dx;
  LY[0] = y0 + dy;
  // Joints 1..3 swing about the shoulder or hip; the body's rise and fall is
  // graded down the leg so the paw stays planted while the animal breathes.
  GX[1] = x1 - x0; GX[2] = x2 - x0; GX[3] = x3 - x0;
  GY[1] = y1 - y0; GY[2] = y2 - y0; GY[3] = y3 - y0;
  for (let i = 1; i < 4; i++) {
    const px = GX[i] * c - GY[i] * s;
    const py = GX[i] * s + GY[i] * c;
    const grade = 1 - i / 3;
    LX[i] = x0 + px + dx * (0.35 + 0.65 * grade);
    LY[i] = y0 + py + dy * grade - lift * (i === 1 ? 0.3 : i === 2 ? 0.75 : 1);
  }
  tube(ctx, LX[0], LY[0], LX[1], LY[1], 3.1, 2.3, fur, ink(), ow);
  tube(ctx, LX[1], LY[1], LX[2], LY[2], 2.2, 1.5, fur, ink(), ow);
  // The socks. Cream from the hock down is as much a Shiba marking as the mask.
  tube(ctx, LX[2], LY[2], LX[3], LY[3], 1.5, 1.35, cream, ink(), ow);
  ellipse(ctx, LX[3] + 0.6, LY[3] + 0.2, 2.1, 1.45, -0.12, cream, ink(), ow);
}

/** An upright triangular ear, rotated about its base. The single best tell. */
function dogEar(
  ctx: C2D,
  bx: number, by: number, ang: number, w: number, h: number,
  outer: string, innerC: string, ow: number,
): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  // local: base -w/2..+w/2 on y=0, tip a little forward of centre
  EX[0] = -w * 0.5; EX[1] = w * 0.5; EX[2] = w * 0.16;
  EY[0] = 0; EY[1] = 0; EY[2] = -h;
  for (let i = 0; i < 3; i++) {
    P3[i * 2] = bx + EX[i] * c - EY[i] * s;
    P3[i * 2 + 1] = by + EX[i] * s + EY[i] * c;
  }
  poly(ctx, P3, outer, ink(), ow);
  // inner ear, inset on all three sides so the outer reads as a rim of fur
  for (let i = 0; i < 3; i++) {
    const ix = EX[i] * 0.5 + w * 0.04;
    const iy = EY[i] * 0.58 - h * 0.06;
    P3[i * 2] = bx + ix * c - iy * s;
    P3[i * 2 + 1] = by + ix * s + iy * c;
  }
  poly(ctx, P3, innerC, NO, 0);
}

/**
 * The curled tail, built as one closed outline down a shrinking spiral so it
 * gets a single clean ink edge instead of a chain of visible segment seams.
 * `wag` rotates the whole curl about its base.
 */
function buildTail(
  out: number[], bx: number, by: number, cx: number, cy: number,
  th0: number, sweep: number, r0: number, r1: number,
  w0: number, w1: number, inner: number, wag: number,
): void {
  const wc = Math.cos(wag);
  const ws = Math.sin(wag);
  for (let i = 0; i < TAIL_N; i++) {
    const t = i / (TAIL_N - 1);
    const th = th0 + sweep * t;
    const R = lerp(r0, r1, t);
    const nx = Math.cos(th);
    const ny = Math.sin(th);
    const px = cx + nx * R;
    const py = cy + ny * R;
    const w = lerp(w0, w1, t);
    // The width normal on a spiral is the radial direction, which is exactly
    // perpendicular to the tangent — no derivative needed.
    let ax = px + nx * w;
    let ay = py + ny * w;
    let bx2 = px + nx * w * inner;
    let by2 = py + ny * w * inner;
    // rotate both edges about the tail root
    const a1 = ax - bx;
    const a2 = ay - by;
    ax = bx + a1 * wc - a2 * ws;
    ay = by + a1 * ws + a2 * wc;
    const b1 = bx2 - bx;
    const b2 = by2 - by;
    bx2 = bx + b1 * wc - b2 * ws;
    by2 = by + b1 * ws + b2 * wc;
    out[i * 2] = ax;
    out[i * 2 + 1] = ay;
    const j = TAIL_N * 2 - 1 - i;
    out[j * 2] = bx2;
    out[j * 2 + 1] = by2;
  }
}

function drawShiba(ctx: C2D, st: RigStyle, d: Drive): void {
  const dm = DMG;
  const ow = OW;

  // ── palette ────────────────────────────────────────────────────────────────
  const fur = keyCol(st.skin);
  const furDk = keyCol(st.skinShade);
  const furFar = keyCol(shadeOf(st.skin, 0.74));
  const creamSrc = mixCol(st.hair, st.tunicColor, 0.5);
  const cream = keyCol(creamSrc);
  const creamDk = keyCol(shadeOf(creamSrc, 0.86));
  const creamFar = keyCol(shadeOf(creamSrc, 0.76));
  const brass = keyCol(st.jacketAccent);
  const leather = col(mixCol(COLLAR_LEATHER, st.jacketColor, 0.18));

  // ── proportions ────────────────────────────────────────────────────────────
  const fat = 1 + (clamp(st.girth || 1, 0.6, 2) - 1) * 0.18;
  const hs = 1 + ((st.headSize || 1) - 1) * 0.5;

  // ── drive ──────────────────────────────────────────────────────────────────
  const down = d.down;
  const crouch = clamp(d.crouch + down * 0.9, 0, 1.4);
  const bodyDy = crouch * 4.2 + d.bob - d.air * 1.4;
  const bodyDx = d.push * 3.4;
  const pitch = d.pitch + down * 0.22 + d.flinch * 0.1;
  const coil = d.coil;
  const hackle = clamp(Math.max(coil, d.flinch * 0.45, d.show * 0.35), 0, 1);
  const earBack = clamp(Math.max(coil * 0.95, d.flinch, down, d.dizzy * 0.4), 0, 1);
  // Ears also flatten when he is nearly out — a tired dog stops holding them up.
  const earDrop = clamp(earBack + (dm.on ? dm.breath * 0.35 : 0), 0, 1);
  const swingAmp = 0.16 + 0.5 * d.run;
  const liftAmp = 0.7 + 3.0 * d.run;
  // Floored, the legs go out from under him instead of staying tucked neatly
  // beneath a body that is now lying on the ground.
  const splayF = -down * 0.75;
  const splayB = down * 0.8;

  // ── shadow, sized to the whole length of the animal ────────────────────────
  contactShadow(ctx, -1.5 + bodyDx * 0.4, 0, 17 * fat * (1 - d.air * 0.45), 0.36 * (1 - d.air * 0.5));

  ctx.save();
  ctx.rotate(pitch * 0.35);

  // ── far pair, behind everything and pushed back in tone ────────────────────
  const pf = d.gait;
  const pb = wrap01(d.gait + 0.5);
  const swF = Math.sin(pb * TAU) * swingAmp;
  const lfF = Math.max(0, Math.sin(pb * TAU + 1.6)) * liftAmp;
  const swB = Math.sin(pf * TAU) * swingAmp;
  const lfB = Math.max(0, Math.sin(pf * TAU + 1.6)) * liftAmp;

  ctx.save();
  ctx.translate(-2.4, -0.7);
  dogLeg(ctx, -10.6, -18.2, -8.4, -12.6, -11.6, -7.0, -9.0, -1.0,
    swB * 0.9 + splayB, lfB * 0.8, bodyDx * 0.7, bodyDy, furFar, creamFar, ow * 0.85);
  dogLeg(ctx, 7.6, -18.0, 8.2, -12.6, 7.6, -6.4, 9.4, -1.0,
    swF * 0.9 + splayF, lfF * 0.8, bodyDx * 0.7, bodyDy, furFar, creamFar, ow * 0.85);
  ctx.restore();

  ctx.save();
  ctx.translate(bodyDx, bodyDy);

  // ── barrel ─────────────────────────────────────────────────────────────────
  const heave = dm.on ? dm.heave * 0.35 : 0;
  ellipse(ctx, -2.0, -17.0, 14.5 * fat, (7.2 + heave) * fat, -0.05, fur, ink(), ow);
  // pale belly and a slightly darker saddle, both kept comfortably inside the
  // barrel outline so they read as markings rather than as separate shapes
  ellipse(ctx, -2.0, -13.6, 11.6 * fat, 2.9, -0.04, cream, NO, 0);
  ellipse(ctx, -3.4, -20.4, 10.6 * fat, 2.5, -0.05, furDk, NO, 0);

  if (dm.on) {
    scuffs(ctx, -13, -19, 9, -15, 3.2, 6, 900, 0.42);
    if (dm.blood > 0.03) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * 0.5;
      ellipse(ctx, -5.0 + hashs(dm.seed, 901) * 3, -17.5, 5.5 * dm.blood + 2, 3.4 * dm.blood + 1.6, 0, col(BLOOD_DK), NO, 0);
      ctx.globalAlpha = prev;
      spatter(ctx, -3, -18, 9, 7, 910, 0.75);
    }
  }

  // ── hackles ────────────────────────────────────────────────────────────────
  if (hackle > 0.04) {
    const h = 2.9 * hackle;
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const bx = lerp(6.5, -11.5, t);
      const by = -23.0 - Math.sin(t * Math.PI) * 1.1;
      const j = 0.7 + 0.6 * hashf(dm.seed + 7, i);
      tri(ctx, bx - 1.5, by + 0.6, bx + 1.5, by + 0.6, bx - 0.4, by - h * j, furDk, ink(), ow * 0.5);
    }
  }

  // ── the curled tail: after the body, because it lies ON the back ───────────
  const wag = d.wag * (0.10 + 0.30 * (d.show + (d.run > 0 ? 0.4 : 0)));
  buildTail(TAIL_PTS, -13.5, -20.5, -10.5, -24.0, 2.28, 4.4, 4.6, 2.6, 2.8, 1.1, -1, wag);
  poly(ctx, TAIL_PTS, fur, ink(), ow);
  buildTail(TAIL_TRIM, -13.5, -20.5, -10.5, -24.0, 2.28, 4.4, 4.6, 2.6, 2.55, 1.0, 0.3, wag);
  poly(ctx, TAIL_TRIM, cream, NO, 0);
  // cream tip, and a fur tuft over the root so the tail/rump seam disappears
  {
    const th = 2.28 + 4.4;
    const tx = -10.5 + Math.cos(th) * 2.6;
    const ty = -24.0 + Math.sin(th) * 2.6;
    const c = Math.cos(wag);
    const s = Math.sin(wag);
    const rx = -13.5 + (tx + 13.5) * c - (ty + 20.5) * s;
    const ry = -20.5 + (tx + 13.5) * s + (ty + 20.5) * c;
    ellipse(ctx, rx, ry, 1.35, 1.25, 0, cream, NO, 0);
  }
  ellipse(ctx, -13.2, -20.6, 3.4, 3.0, 0.3, fur, NO, 0);

  // ── near pair ──────────────────────────────────────────────────────────────
  ctx.restore();
  dogLeg(ctx, -10.6, -18.2, -8.4, -12.6, -11.6, -7.0, -9.0, -1.0,
    swB + splayB, lfB, bodyDx, bodyDy, fur, cream, ow);

  ctx.save();
  ctx.translate(bodyDx, bodyDy);

  // ── chest blaze, then the neck, then the collar over the seam ─────────────
  ellipse(ctx, 10.2, -16.4, 3.6, 4.0, -0.2, cream, ink(), ow * 0.7);

  const neckLean = -coil * 0.1 + d.push * 0.06;
  ctx.save();
  ctx.translate(7.5, -19.5);
  ctx.rotate(neckLean);
  ctx.translate(-7.5, 19.5);

  tube(ctx, 7.5, -19.5, 14.5, -25.5, 5.0 * fat, 4.4 * fat, fur, ink(), ow);
  tube(ctx, 10.0, -19.0, 15.0, -23.5, 2.2, 2.0, cream, NO, 0);

  // ── the collar, which also hides the neck/body seam ───────────────────────
  //
  // Drawn inside the neck transform so it travels with the neck it is buckled
  // around, and before the head so the earpiece lead can run down into it.
  if (!dm.hatless) {
    // band across the neck: nape at one end, throat at the other
    const nx = 6.6;
    const ny = -25.5;
    const tx = 13.4;
    const ty = -17.7;
    capsule(ctx, nx, ny, tx, ty, 1.55, leather, ink(), ow * 0.8);
    const studCount = Math.max(2, 5 - Math.round(dm.t2 * 3));
    studs(ctx, tx, ty, nx, ny, studCount, 1.5, brass);
    // the tag: a coin, obviously
    ctx.strokeStyle = ink();
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(13.5, -17.4);
    ctx.lineTo(13.9, -15.2);
    ctx.stroke();
    ellipse(ctx, 14.0, -13.4, 2.0, 2.0, 0, brass, ink(), ow * 0.55);
    ellipse(ctx, 14.0, -13.4, 1.4, 1.4, 0, keyCol(shadeOf(st.jacketAccent, 1.18)), NO, 0);
    // a Ð, drawn rather than typed, because there are no fonts in this repo
    ctx.strokeStyle = ink();
    ctx.lineWidth = 0.36;
    ctx.beginPath();
    ctx.moveTo(13.5, -14.4);
    ctx.lineTo(13.5, -12.4);
    ctx.moveTo(13.5, -14.4);
    ctx.quadraticCurveTo(15.1, -13.4, 13.5, -12.4);
    ctx.moveTo(12.9, -13.4);
    ctx.lineTo(14.3, -13.4);
    ctx.stroke();
  } else {
    // the collar is gone and a pale band of flattened fur is left where it was
    capsule(ctx, 6.6, -25.5, 13.4, -17.7, 1.2, keyCol(shadeOf(creamSrc, 0.94)), NO, 0);
  }

  // ── head ───────────────────────────────────────────────────────────────────
  const skullX = 18.0;
  const skullY = -29.0;
  const rx = 6.8 * hs;
  const ry = 6.0 * hs;

  // Ear bases are pinned to the skull surface rather than to hand-picked
  // numbers, so a different headSize does not leave the ears floating.
  const earNearY = skullY - ry * 0.80;
  const earFarY = skullY - ry * 0.76;

  // far ear first: it belongs behind the skull
  dogEar(ctx, 15.0, earFarY, -0.12 - earDrop * 1.9, 4.1 * hs, 6.0 * hs * (1 - 0.28 * earDrop), furDk, keyCol(shadeOf(EAR_PINK, 0.8)), ow * 0.75);
  // far cheek ruff
  ellipse(ctx, 12.6, -27.4, 2.3, 2.0, 0.4, creamDk, ink(), ow * 0.55);

  ellipse(ctx, skullX, skullY, rx, ry, 0, fur, ink(), ow);
  // the pale mask spreading up the cheeks — the second half of the Shiba face
  ellipse(ctx, skullX + 1.4, skullY + 3.0, rx * 0.72, ry * 0.42, -0.1, cream, NO, 0);
  // near cheek ruff, two overlapping bumps so the edge is scalloped, not round
  ellipse(ctx, 15.4, -25.8, 3.0, 2.3, 0.28, cream, ink(), ow * 0.6);
  ellipse(ctx, 13.4, -27.6, 2.4, 2.0, 0.5, cream, ink(), ow * 0.55);

  // muzzle: short and wedge-shaped, cream, with the tan bridge over the top
  P4[0] = 21.0; P4[1] = -24.6;
  P4[2] = 29.2; P4[3] = -26.4;
  P4[4] = 29.6; P4[5] = -28.6;
  P4[6] = 21.5; P4[7] = -31.6;
  poly(ctx, P4, cream, ink(), ow);
  quad(ctx, 21.5, -31.6, 29.4, -28.9, 29.2, -27.9, 21.5, -30.2, fur, NO, 0);

  const panting =
    dm.on && (dm.face === 'exhausted' || dm.breath > 0.55 || dm.face === 'dead');
  const open = panting || dm.face === 'angry';

  if (open) {
    // an open mouth: the dark of the maw, teeth on the top edge, tongue out
    P4[0] = 22.6; P4[1] = -26.2;
    P4[2] = 28.6; P4[3] = -27.0;
    P4[4] = 28.0; P4[5] = -23.4;
    P4[6] = 22.9; P4[7] = -23.9;
    poly(ctx, P4, col('#3a1420'), ink(), ow * 0.6);
    if (dm.face === 'angry') {
      tri(ctx, 27.6, -26.6, 26.4, -26.4, 27.0, -24.2, col('#f4efe2'), NO, 0);
      tri(ctx, 25.4, -26.2, 24.2, -26.0, 24.8, -24.1, col('#f4efe2'), NO, 0);
    }
    if (panting) {
      const lo = dm.reduced ? 0.4 : 0.5 + 0.5 * Math.sin(dm.t * 7.4);
      const ty = -23.2 + lo * 1.6;
      tube(ctx, 25.4, -25.0, 26.2, ty + 2.4, 1.7, 1.5, col(TONGUE), ink(), ow * 0.55);
      ctx.strokeStyle = col(TONGUE_DK);
      ctx.lineWidth = 0.35;
      ctx.beginPath();
      ctx.moveTo(25.7, -24.4);
      ctx.lineTo(26.1, ty + 1.6);
      ctx.stroke();
    }
  } else {
    // THE SMIRK. Out from under the nose, a shallow dip, and then it turns up
    // at the corner. Everything else on this head is anatomy; this is the joke.
    ctx.strokeStyle = ink();
    ctx.lineWidth = 0.85;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(28.4, -27.2);
    ctx.quadraticCurveTo(25.6, -25.4, 22.0, -26.9);
    ctx.stroke();
  }

  // nose
  ellipse(ctx, 29.0, -28.4, 1.6, 1.35, -0.35, col(DOG_NOSE), ink(), ow * 0.6);
  if (flashAmt < 0.5) ellipse(ctx, 28.6, -28.9, 0.42, 0.34, 0, col(GLINT), NO, 0);
  if (dm.blood > 0.05) spatter(ctx, 27.4, -26.4, 2.6, 5, 940, 0.5);

  // eyes — small, wide-set and half-lidded, which is the entire expression
  dogEye(ctx, 15.4, -32.0, 1.2 * hs, 1.1 * hs, fur, false, d, dm);
  dogEye(ctx, 20.4, -31.2, 1.55 * hs, 1.4 * hs, fur, true, d, dm);

  // the cream brow spots. Without these he is a fox.
  ellipse(ctx, 15.9, -34.2, 1.25, 0.85, -0.12, cream, NO, 0);
  ellipse(ctx, 21.2, -33.5, 1.5, 0.95, -0.1, cream, NO, 0);
  if (dm.face === 'angry' || coil > 0.4) {
    // brows driven down and in over the spots
    ctx.strokeStyle = ink();
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(19.3, -34.0);
    ctx.lineTo(22.2, -32.6);
    ctx.moveTo(14.4, -34.6);
    ctx.lineTo(16.9, -33.4);
    ctx.stroke();
  }

  // near ear, over the skull
  dogEar(ctx, 20.2, earNearY, 0.18 - earDrop * 1.95, 4.7 * hs, 6.6 * hs * (1 - 0.3 * earDrop), fur, keyCol(EAR_PINK), ow);
  // a notch out of it once he has been in enough fights
  if (dm.on && dm.t2 > 0.3) {
    tri(ctx, 21.6, -39.0, 23.0, -37.4, 21.4, -37.2, fur, NO, 0);
  }

  // ── the security detail: earpiece and its coiled lead ─────────────────────
  ctx.strokeStyle = ink();
  ctx.lineWidth = 0.62;
  ctx.beginPath();
  ctx.arc(18.6, -31.0, 1.5, -0.5, 3.1);
  ctx.stroke();
  ellipse(ctx, 18.2, -29.7, 0.95, 0.85, 0, col('#2c2a34'), ink(), ow * 0.45);
  ctx.strokeStyle = col('#2c2a34');
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(18.0, -28.9);
  ctx.quadraticCurveTo(16.2, -26.4, 14.4, -24.2);
  ctx.quadraticCurveTo(13.2, -22.6, 12.0, -21.4);
  ctx.stroke();

  ctx.restore(); // neck lean
  ctx.restore(); // body translate

  // ── near front leg last: it is in front of the chest ──────────────────────
  dogLeg(ctx, 7.6, -18.0, 8.2, -12.6, 7.6, -6.4, 9.4, -1.0,
    swF + splayF, lfF, bodyDx, bodyDy, fur, cream, ow);

  // ── the laser sight, which is not on the dog ──────────────────────────────
  if (coil > 0.2 && flashAmt < 0.5 && !DMG.reduced) {
    const prev = ctx.globalAlpha;
    const a = coil * 0.9;
    // Emitted from the earpiece, so it travels with the head, not with the map.
    const ox = 29.5 + bodyDx;
    const oy = -28.0 + bodyDy;
    ctx.globalAlpha = prev * 0.28 * a;
    ctx.strokeStyle = col(LASER);
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(52.0, -6.0);
    ctx.stroke();
    ctx.globalAlpha = prev * a;
    ellipse(ctx, 52.0, -6.0, 1.5, 1.0, 0, col(LASER), NO, 0);
    ctx.globalAlpha = prev * 0.35 * a;
    ellipse(ctx, 52.0, -6.0, 3.4, 2.2, 0, col(LASER), NO, 0);
    ctx.globalAlpha = prev;
  }

  ctx.restore(); // pitch
}

/**
 * A Shiba eye: small, dark, and mostly covered by its own upper lid, which is
 * what makes the animal look permanently unimpressed with you.
 */
function dogEye(
  ctx: C2D, x: number, y: number, rx: number, ry: number,
  lid: string, near: boolean, d: Drive, dm: Dmg,
): void {
  const f = dm.on ? dm.face : 'calm';
  if (f === 'dead') {
    ctx.strokeStyle = ink();
    ctx.lineWidth = near ? 0.75 : 0.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - rx, y - ry);
    ctx.lineTo(x + rx, y + ry);
    ctx.moveTo(x + rx, y - ry);
    ctx.lineTo(x - rx, y + ry);
    ctx.stroke();
    return;
  }

  ellipse(ctx, x, y, rx, ry, 0, col(DOG_EYE), NO, 0);

  if (f === 'dazed' || d.dizzy > 0.5) {
    const turn = dm.reduced ? 0.7 : dm.t * 2.4;
    ctx.strokeStyle = col(GLINT);
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const a = turn + t * TAU * 1.4;
      const r = rx * 0.95 * t;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    return;
  }

  // The lid. Half-closed by default (smug), further down when he is tired,
  // pulled back into a hard stare when he is angry or winding up.
  let close = 0.42;
  if (f === 'angry') close = 0.16;
  else if (f === 'strained') close = 0.55;
  else if (f === 'exhausted') close = 0.66;
  close = clamp(close - d.coil * 0.2 + (dm.on ? dm.breath * 0.12 : 0), 0.05, 0.85);
  ellipse(ctx, x, y - ry * (1 - close) - ry * 0.02, rx * 1.28, ry * 1.05, 0, lid, NO, 0);

  if (near && flashAmt < 0.5) {
    ellipse(ctx, x + rx * 0.3, y + ry * 0.22, rx * 0.28, ry * 0.24, 0, col(GLINT), NO, 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LANE ASSIST — the angular wedge
//
// Two straight lines meeting at an apex, and nothing else. The silhouette is
// the entire design, so there is not one curve anywhere on the body: every
// panel is a flat plane, every join is a hard crease, and the only round things
// on the vehicle are the wheels and the crack in the window.
//
// It sells its weight by moving badly. It squats on its rear suspension before
// it commits, tips its nose down when it stops, and the indicator is always on
// — which, as the boss's phase notes put it, is never a lie about the timing,
// only about the direction.
// ═════════════════════════════════════════════════════════════════════════════

const GLASS = '#1b2431';
const GLASS_LIT = '#3d5570';
const TYRE = '#16151b';
const CRACK = '#cfe0f2';

function drawCybertruck(ctx: C2D, st: RigStyle, d: Drive): void {
  const dm = DMG;
  const ow = OW;

  const steel = keyCol(st.skin);
  const steelDk = col(st.skinShade);
  const steelLo = col(shadeOf(st.skinShade, 0.72));
  const panel = col(st.tunicColor);
  const accent = keyCol(st.jacketAccent);
  const rubber = col(mixCol(TYRE, st.jacketColor, 0.18));

  // Suspension: loaded by the wind-up, dumped by the lunge, bouncing on impact.
  const squat = d.crouch * 2.6 + d.flinch * 1.6 + d.down * 3.2;
  const pitch = -d.pitch + d.push * 0.075 - d.crouch * 0.06 + d.down * 0.16 + d.flinch * 0.05;
  const dx = d.push * 4.5;
  const roll = d.f * (0.09 + 0.34 * d.run) * d.run + d.push * 3.5;

  contactShadow(ctx, dx * 0.5, 0, 33, 0.4);

  // ── far wheels, behind the body ────────────────────────────────────────────
  ctx.save();
  ctx.translate(-3.4, -1.2);
  truckWheel(ctx, 18.5 + dx * 0.3, -8.0 + squat * 0.4, 7.0, roll, col(shadeOf(TYRE, 0.7)), steelLo, ow * 0.8);
  truckWheel(ctx, -18.5 + dx * 0.3, -8.0 + squat * 0.6, 7.0, roll, col(shadeOf(TYRE, 0.7)), steelLo, ow * 0.8);
  ctx.restore();

  ctx.save();
  ctx.translate(dx, squat);
  ctx.rotate(pitch);

  // ── the wedge ──────────────────────────────────────────────────────────────
  P7[0] = 34.0; P7[1] = -11.5;   // nose, top of the bumper
  P7[2] = 1.0; P7[3] = -30.0;    // apex
  P7[4] = -33.0; P7[5] = -17.0;  // tail top
  P7[6] = -34.0; P7[7] = -8.2;   // tail bottom
  P7[8] = -24.0; P7[9] = -5.6;
  P7[10] = 24.0; P7[11] = -5.6;
  P7[12] = 33.5; P7[13] = -8.6;  // nose bottom
  poly(ctx, P7, steel, ink(), ow);

  // A single hard crease down the flank. Flat planes need one break or the
  // whole side reads as a sheet of card.
  ctx.strokeStyle = col(shadeOf(st.skinShade, 0.9));
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(33.0, -10.4);
  ctx.lineTo(-32.0, -13.6);
  ctx.moveTo(-14.0, -19.6);
  ctx.lineTo(-32.5, -16.2);
  ctx.stroke();

  // lower body in shade, so the wedge has a top plane and a side plane
  quad(ctx, 33.2, -9.6, -33.4, -12.6, -33.6, -8.2, 33.4, -8.4, steelDk, NO, 0);
  // the bed, behind the cabin: a recess, drawn as a dark slot with a lip
  quad(ctx, -13.0, -18.4, -31.8, -15.2, -31.8, -13.6, -13.0, -16.8, steelLo, NO, 0);

  // ── greenhouse and the famous window ──────────────────────────────────────
  P4[0] = 22.0; P4[1] = -16.2;
  P4[2] = 1.5; P4[3] = -26.6;
  P4[4] = -13.5; P4[5] = -20.6;
  P4[6] = -13.5; P4[7] = -15.6;
  poly(ctx, P4, col(GLASS), ink(), ow * 0.8);
  // reflection: one straight bright plane, no gradient
  quad(ctx, 18.0, -16.6, 3.0, -24.4, -1.0, -22.8, 14.0, -15.9, col(GLASS_LIT), NO, 0);

  // The crack. Present from the first frame, because it always was.
  {
    const ix = 9.0;
    const iy = -21.0;
    const grow = 1 + (dm.on ? dm.t2 * 1.5 : 0);
    ctx.strokeStyle = col(CRACK);
    ctx.lineWidth = 0.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.4;
      const l = (2.4 + 3.6 * hashf(1337, i)) * grow;
      ctx.moveTo(ix, iy);
      ctx.lineTo(ix + Math.cos(a) * l, iy + Math.sin(a) * l * 0.62);
    }
    for (let ring = 1; ring <= 2; ring++) {
      const rr = ring * 2.1 * grow;
      for (let i = 0; i < 7; i++) {
        const a0 = (i / 7) * TAU + 0.4;
        const a1 = ((i + 1) / 7) * TAU + 0.4;
        const j0 = 0.8 + 0.4 * hashf(1337, ring * 11 + i);
        const j1 = 0.8 + 0.4 * hashf(1337, ring * 11 + i + 1);
        ctx.moveTo(ix + Math.cos(a0) * rr * j0, iy + Math.sin(a0) * rr * 0.62 * j0);
        ctx.lineTo(ix + Math.cos(a1) * rr * j1, iy + Math.sin(a1) * rr * 0.62 * j1);
      }
    }
    ctx.stroke();
    if (flashAmt < 0.5) burst(ctx, ix, iy, 1.5 * grow, 6, col(CRACK), 0.5);
  }

  // ── light bar and indicator ───────────────────────────────────────────────
  capsule(ctx, 33.4, -12.4, 27.6, -15.2, 0.85, accent, ink(), ow * 0.55);
  if (flashAmt < 0.5) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.3;
    capsule(ctx, 33.4, -12.4, 27.6, -15.2, 2.4, accent, NO, 0);
    ctx.globalAlpha = prev;
  }
  // The indicator, on during every wind-up, pointing wherever it likes.
  const blink = d.coil > 0.15 && (Math.floor(d.f / 8) & 1) === 0;
  if (blink) {
    ellipse(ctx, 31.6, -10.2, 1.5, 1.0, 0, keyCol('#ffb02e'), ink(), ow * 0.4);
    if (flashAmt < 0.5) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * 0.35;
      ellipse(ctx, 31.6, -10.2, 3.4, 2.4, 0, keyCol('#ffb02e'), NO, 0);
      ctx.globalAlpha = prev;
    }
  }
  // tail light, brighter under braking
  capsule(ctx, -33.4, -15.6, -33.4, -12.4, 0.8, keyCol(d.push < -0.05 ? '#ff4438' : '#8c2a24'), ink(), ow * 0.5);

  // ── wheel arches: angular cut-outs, never round ───────────────────────────
  truckArch(ctx, 18.5, steelDk, ow);
  truckArch(ctx, -18.5, steelDk, ow);

  // ── damage ─────────────────────────────────────────────────────────────────
  if (dm.on) {
    scuffs(ctx, 28, -11, -28, -14, 3.0, 8, 1200, 0.45);
    if (dm.t2 > 0.06) {
      // dents: flat angular facets punched into the flank
      const n = Math.round(1 + dm.t2 * 4);
      for (let i = 0; i < n; i++) {
        const px = lerp(26, -28, hashf(dm.seed, 1220 + i));
        const py = -10 - hashf(dm.seed, 1240 + i) * 8;
        const s = 2.2 + 3.0 * hashf(dm.seed, 1260 + i);
        quad(ctx, px - s, py, px, py - s * 0.7, px + s * 0.8, py + s * 0.2, px - s * 0.2, py + s * 0.6,
          steelLo, ink(), ow * 0.45);
      }
    }
    if (dm.t3 > 0.35) {
      // the door has given up and is hanging off its lower hinge
      const swing = 0.5 + 0.35 * dm.t3 + (dm.reduced ? 0 : Math.sin(dm.t * 1.6) * 0.06);
      ctx.save();
      ctx.translate(2.0, -8.0);
      ctx.rotate(swing);
      quad(ctx, 0, 0, 12.5, -1.2, 12.5, -11.0, 0, -10.0, steelDk, ink(), ow);
      ctx.restore();
      quad(ctx, 2.0, -8.6, 14.0, -9.4, 14.0, -18.0, 2.0, -17.4, col('#0e0d13'), ink(), ow * 0.6);
    }
    if (dm.blood > 0.04) {
      // it has been over somebody, and it went over the front
      spatter(ctx, 30.0, -10.5, 5.0, 8, 1300, 0.8);
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * 0.55;
      for (let i = 0; i < 4; i++) {
        const sx = 24 + hashf(dm.seed, 1320 + i) * 9;
        capsule(ctx, sx, -11.0, sx - 1.2, -6.4 - hashf(dm.seed, 1340 + i) * 2, 0.6,
          col(BLOOD_WET), NO, 0);
      }
      ctx.globalAlpha = prev;
    }
  }

  ctx.restore();

  // ── near wheels, over the body ─────────────────────────────────────────────
  truckWheel(ctx, 18.5 + dx * 0.55, -8.0 + squat * 0.5, 7.6, roll, rubber, steel, ow);
  truckWheel(ctx, -18.5 + dx * 0.55, -8.0 + squat * 0.75, 7.6, roll, rubber, steel, ow);

  // ── it does not stop cleanly ───────────────────────────────────────────────
  if (d.run > 0.2 && flashAmt < 0.5 && !dm.reduced) {
    const prev = ctx.globalAlpha;
    for (let i = 0; i < 3; i++) {
      const t = (d.f * 0.1 + i * 0.33) % 1;
      ctx.globalAlpha = prev * 0.22 * (1 - t) * d.run;
      ellipse(ctx, -26 - t * 20, -3.0 - t * 5, 3.5 + t * 7, 2.4 + t * 5, 0, col('#8d8a96'), NO, 0);
    }
    ctx.globalAlpha = prev;
  }
}

/** An angular arch over a wheel. Trapezoid, because a curve would be wrong. */
function truckArch(ctx: C2D, cx: number, c: string, ow: number): void {
  P5[0] = cx - 10.0; P5[1] = -5.6;
  P5[2] = cx - 8.0; P5[3] = -13.0;
  P5[4] = cx; P5[5] = -14.6;
  P5[6] = cx + 8.0; P5[7] = -13.0;
  P5[8] = cx + 10.0; P5[9] = -5.6;
  poly(ctx, P5, c, ink(), ow * 0.6);
}

function truckWheel(
  ctx: C2D, cx: number, cy: number, r: number, ang: number,
  rubber: string, rim: string, ow: number,
): void {
  ellipse(ctx, cx, cy, r, r, 0, rubber, ink(), ow);
  ellipse(ctx, cx, cy, r * 0.52, r * 0.52, 0, rim, ink(), ow * 0.7);
  ctx.strokeStyle = ink();
  ctx.lineWidth = 0.7;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = ang + (i / 5) * TAU;
    ctx.moveTo(cx + Math.cos(a) * r * 0.16, cy + Math.sin(a) * r * 0.16);
    ctx.lineTo(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5);
  }
  ctx.stroke();
  ellipse(ctx, cx, cy, r * 0.16, r * 0.16, 0, col(shadeOf('#8f96a0', 1.1)), ink(), ow * 0.4);
}

// ═════════════════════════════════════════════════════════════════════════════
// STARSHIP — a pressure vessel with engines on one end
//
// Tall, chrome, and only ever a few seconds from being a different shape. The
// read is: bare stainless cylinder, ogive nose, two grid fins up top, two aft
// flaps down low, a ring of engines underneath, and the black tile line down
// the far side. It hovers rather than walks, tips instead of turning, and
// everything it does starts with the exhaust.
// ═════════════════════════════════════════════════════════════════════════════

function drawRocket(ctx: C2D, st: RigStyle, d: Drive): void {
  const dm = DMG;
  const ow = OW;

  const hull = keyCol(st.skin);
  const hullDk = col(st.skinShade);
  const hullLo = col(shadeOf(st.skinShade, 0.7));
  const hullLit = col(shadeOf(st.tunicColor, 1.06));
  const tile = col(st.hatColor);
  const flame = keyCol(st.jacketAccent);

  const wide = 8.0 * (1 + ((st.girth || 1) - 1) * 0.12);

  // Hover: it is never quite still, and it is never quite level.
  const idleHover = dm.reduced ? 0 : Math.sin(d.t * 1.5) * 0.9;
  const hover = idleHover + d.air * 3.0 - d.crouch * 2.0 + d.bob * 0.6;
  const tip = d.pitch * 0.8 + d.push * 0.10 - d.flinch * 0.14 + d.wag * 0.03 + d.down * 1.35;
  const thrust = clamp(d.air * 0.9 + d.run * 0.7 + Math.max(0, d.push) * 0.8 + 0.12, 0, 1);

  contactShadow(ctx, 0, 0, 15 * (1 - clamp(hover, 0, 6) * 0.06), 0.4);

  ctx.save();
  // It tips about a point down at the engine bay, so a tilt swings the NOSE.
  ctx.translate(0, -6 - hover);
  ctx.rotate(tip);
  ctx.translate(0, 6 + hover);
  ctx.translate(0, -hover);

  // ── far grid fin and far flap, behind the hull ────────────────────────────
  gridFin(ctx, -wide, -36.0, -1, hullLo, ow * 0.7);
  aftFlap(ctx, -wide, -16.0, -1, hullLo, ow * 0.7, d);

  // ── hull ───────────────────────────────────────────────────────────────────
  roundRect(ctx, -wide, -38.0, wide * 2, 28.0, 1.2, hull, ink(), ow);
  // the black tile line, on the far side of the vehicle
  quad(ctx, -wide, -38.0, -wide + 3.4, -38.0, -wide + 3.4, -10.0, -wide, -10.0, tile, NO, 0);
  // chrome: one bright vertical strip and one dark one, no gradients
  quad(ctx, wide - 3.6, -37.6, wide - 1.4, -37.6, wide - 1.4, -10.2, wide - 3.6, -10.2, hullLit, NO, 0);
  quad(ctx, wide - 1.2, -37.6, wide, -37.6, wide, -10.2, wide - 1.2, -10.2, hullDk, NO, 0);

  // ring welds
  ctx.strokeStyle = col(shadeOf(st.skinShade, 0.86));
  ctx.lineWidth = 0.45;
  ctx.beginPath();
  for (let i = 1; i <= 5; i++) {
    const y = -10.0 - (i / 6) * 28.0;
    ctx.moveTo(-wide + 0.6, y);
    ctx.lineTo(wide - 0.6, y);
  }
  ctx.stroke();

  // ── nose cone ──────────────────────────────────────────────────────────────
  P5[0] = -wide; P5[1] = -37.4;
  P5[2] = -wide * 0.78; P5[3] = -44.2;
  P5[4] = 0; P5[5] = -50.5;
  P5[6] = wide * 0.78; P5[7] = -44.2;
  P5[8] = wide; P5[9] = -37.4;
  poly(ctx, P5, hull, ink(), ow);
  quad(ctx, wide * 0.2, -47.6, wide * 0.62, -43.4, wide * 0.5, -38.0, wide * 0.1, -38.0, hullLit, NO, 0);

  // ── near grid fin, near flap ───────────────────────────────────────────────
  gridFin(ctx, wide, -36.0, 1, hullDk, ow);
  aftFlap(ctx, wide, -16.0, 1, hullDk, ow, d);

  // ── skirt and engines ──────────────────────────────────────────────────────
  quad(ctx, -wide, -10.4, wide, -10.4, wide * 0.82, -5.4, -wide * 0.82, -5.4, hullDk, ink(), ow);
  const bells = 3;
  for (let i = 0; i < bells; i++) {
    const bx = lerp(-wide * 0.55, wide * 0.55, i / (bells - 1));
    quad(ctx, bx - 1.9, -5.6, bx + 1.9, -5.6, bx + 2.8, -0.6, bx - 2.8, -0.6,
      col(shadeOf(st.skinShade, 0.55)), ink(), ow * 0.6);
  }

  // ── the exhaust ────────────────────────────────────────────────────────────
  if (thrust > 0.05 && flashAmt < 0.5) {
    const prev = ctx.globalAlpha;
    const flick = dm.reduced ? 1 : 0.82 + 0.18 * Math.sin(d.t * 41);
    const L = (7 + 22 * thrust) * flick;
    for (let i = 0; i < bells; i++) {
      const bx = lerp(-wide * 0.55, wide * 0.55, i / (bells - 1));
      ctx.globalAlpha = prev * 0.45 * thrust;
      tri(ctx, bx - 3.2, -0.8, bx + 3.2, -0.8, bx, L * 0.9, flame, NO, 0);
      ctx.globalAlpha = prev * 0.9 * thrust;
      tri(ctx, bx - 1.6, -0.8, bx + 1.6, -0.8, bx, L * 0.55, keyCol('#ffd98a'), NO, 0);
      ctx.globalAlpha = prev * 0.85 * thrust;
      tri(ctx, bx - 0.7, -0.8, bx + 0.7, -0.8, bx, L * 0.3, keyCol('#dff0ff'), NO, 0);
    }
    ctx.globalAlpha = prev * 0.25 * thrust;
    ellipse(ctx, 0, 1.0, 12 + 8 * thrust, 3.2 + 2 * thrust, 0, flame, NO, 0);
    ctx.globalAlpha = prev;
  }

  // ── damage ─────────────────────────────────────────────────────────────────
  if (dm.on) {
    scuffs(ctx, -wide + 1, -14, wide - 1, -34, 3.4, 8, 1500, 0.42);
    if (dm.t1 > 0.1) {
      // scorching climbs the hull from the engine bay
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * 0.45 * dm.t1;
      ellipse(ctx, 0, -11.0, wide * 1.05, 4.5 + 5 * dm.t1, 0, col('#211c22'), NO, 0);
      ctx.globalAlpha = prev;
    }
    if (dm.t2 > 0.1) {
      // a crumpled ring: the vehicle is losing its shape before it loses anything else
      const n = Math.round(2 + dm.t2 * 3);
      for (let i = 0; i < n; i++) {
        const y = -14 - hashf(dm.seed, 1520 + i) * 22;
        const s = 2.0 + 2.6 * hashf(dm.seed, 1540 + i);
        const sx = hashf(dm.seed, 1560 + i) < 0.5 ? -wide : wide;
        tri(ctx, sx, y, sx - Math.sign(sx) * s * 1.5, y - s * 0.6, sx - Math.sign(sx) * s * 0.5, y + s,
          hullLo, ink(), ow * 0.5);
      }
    }
    if (dm.breath > 0.35 && flashAmt < 0.5 && !dm.reduced) {
      // venting. Historically this part goes badly for everyone.
      const prev = ctx.globalAlpha;
      for (let i = 0; i < 3; i++) {
        const t = ((dm.t * 0.7 + i * 0.34) % 1);
        ctx.globalAlpha = prev * 0.3 * (1 - t) * dm.breath;
        ellipse(ctx, wide + 2 + t * 9, -30 + i * 5, 1.5 + t * 4, 1.2 + t * 3, 0, col('#dfe6ef'), NO, 0);
      }
      ctx.globalAlpha = prev;
    }
    if (dm.blood > 0.05) spatter(ctx, 0, -12, wide, 6, 1580, 0.8);
  }

  ctx.restore();
}

/** A grid fin: a small slab with an actual grid in it. `side` is ±1. */
function gridFin(ctx: C2D, x: number, y: number, side: number, c: string, ow: number): void {
  const w = 5.6 * side;
  quad(ctx, x, y + 1.0, x + w, y - 1.6, x + w, y - 5.4, x, y - 4.8, c, ink(), ow);
  ctx.strokeStyle = ink();
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    ctx.moveTo(x + w * t, lerp(y + 1.0, y - 1.6, t));
    ctx.lineTo(x + w * t, lerp(y - 4.8, y - 5.4, t));
  }
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    ctx.moveTo(x, lerp(y + 1.0, y - 4.8, t));
    ctx.lineTo(x + w, lerp(y - 1.6, y - 5.4, t));
  }
  ctx.stroke();
}

/** An aft flap. It moves, which is the only reason the thing stays upright. */
function aftFlap(ctx: C2D, x: number, y: number, side: number, c: string, ow: number, d: Drive): void {
  const a = d.pitch * 0.8 + d.push * 0.25 + (d.air > 0.4 ? 0.35 : 0);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a * side * -1);
  quad(ctx, 0, 2.6, 8.2 * side, 6.4, 9.4 * side, -1.0, 0, -4.4, c, ink(), ow);
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════════════════════
// ROBOT_GIANT — the one that IS a humanoid
//
// The Boring Machine, Optimus, Grok and the clone are all bipeds, so this kind
// deliberately REUSES `drawCharacter` rather than re-deriving a body that
// already exists: same skeleton, same wardrobe pipeline, same damage passes.
// What this function adds is everything that makes it a MACHINE rather than a
// large man — a chromed copy of the style with the human flourishes stripped
// out (no beard, no shades, no cigar), and then a hardware pass on top: a
// glowing visor across the face, panel seams down the chest, and exposed
// actuators at the shoulder and hip.
//
// The overlay is placed by walking the spine chain analytically with the same
// arithmetic `resolvePose` uses, so the visor lands on the face for any pose
// without allocating a second bone map.
// ═════════════════════════════════════════════════════════════════════════════

const SPINE: BoneName[] = ['root', 'pelvis', 'torso', 'chest', 'neck', 'head'];
const SP_X = new Float64Array(6);
const SP_Y = new Float64Array(6);
const SP_R = new Float64Array(6);
const SP_LEN = new Float64Array(6);
/** Resolved spine, canvas-local: y already flipped, x still un-mirrored. */
const OX = new Float64Array(6);
const OY = new Float64Array(6);
const OR = new Float64Array(6);

for (let i = 0; i < SPINE.length; i++) {
  for (const b of HUMAN_SKELETON) {
    if (b.name === SPINE[i]) {
      SP_X[i] = b.x;
      SP_Y[i] = b.y;
      SP_R[i] = b.rot;
      SP_LEN[i] = b.length;
      break;
    }
  }
}

const ROBOT_BONES: BoneName[] = [
  'root', 'pelvis', 'torso', 'chest', 'neck', 'head', 'hat', 'beard',
  'armL_upper', 'armL_lower', 'handL', 'armR_upper', 'armR_lower', 'handR',
  'legL_upper', 'legL_lower', 'footL', 'legR_upper', 'legR_lower', 'footR',
];

interface Bp {
  rot: number;
  x: number;
  y: number;
  scale: number;
}

const RB = {} as Record<BoneName, Bp>;
const ROBOT_POSE: Pose = {};
for (const n of ROBOT_BONES) {
  const bp: Bp = { rot: 0, x: 0, y: 0, scale: 1 };
  RB[n] = bp;
  ROBOT_POSE[n] = bp;
}

/** Filled per call, never allocated. drawBossRig is not re-entrant. */
const ROBOT_STYLE: RigStyle = {
  scale: 1, girth: 1, headSize: 1, beardLength: 0, beardStyle: 'none',
  skin: '#cccccc', skinShade: '#888888', hair: '#222222', hatColor: '#333333',
  tunicColor: '#bbbbbb', jacketColor: '#999999', jacketAccent: '#66eeff',
  spikes: 0, shades: false, outfit: 1, tattoo: 'none', cigar: false,
};

function resetRobotPose(): void {
  for (let i = 0; i < ROBOT_BONES.length; i++) {
    const bp = RB[ROBOT_BONES[i]];
    bp.rot = 0;
    bp.x = 0;
    bp.y = 0;
    bp.scale = 1;
  }
}

/**
 * The same recurrence `resolvePose` runs, for the six bones the overlay needs.
 * Uniform scale and no per-bone pose scale, so `parentScale` is constant.
 */
function solveSpine(u: number): void {
  let px = 0;
  let py = 0;
  let pr = 0;
  for (let i = 0; i < 6; i++) {
    const bp = RB[SPINE[i]];
    const ox = (SP_X[i] + bp.x) * u;
    const oy = (SP_Y[i] + bp.y) * u;
    const c = Math.cos(pr);
    const s = Math.sin(pr);
    px = px + ox * c - oy * s;
    py = py + ox * s + oy * c;
    pr = pr + SP_R[i] + bp.rot;
    OX[i] = px;
    OY[i] = -py; // rig +y is up, canvas +y is down
    OR[i] = pr;
  }
}

function drawRobotGiant(
  ctx: C2D,
  st: RigStyle,
  x: number,
  y: number,
  facing: Facing,
  u: number,
  d: Drive,
  opts: { flash?: number; tint?: string; alpha?: number; scale?: number; damage?: RigDamage } | undefined,
): void {
  const dm = DMG;

  // ── pose ───────────────────────────────────────────────────────────────────
  resetRobotPose();
  const swing = Math.sin(d.gait * TAU) * (0.25 + 0.55 * d.run);
  const lean = -d.crouch * 0.16 + d.push * 0.14 - d.flinch * 0.3 + d.bob * 0.01;
  const armWind = -d.coil * 1.3 + Math.max(0, d.push) * 1.5;

  RB.root.rot = d.down * 1.45 * -1;
  RB.root.y = -d.crouch * 4.0 - d.air * 1.0;
  RB.pelvis.rot = lean * 0.4;
  RB.torso.rot = lean * 0.5 + d.bob * 0.004;
  RB.chest.rot = lean * 0.4;
  RB.neck.rot = -lean * 0.3;
  RB.head.rot = -lean * 0.5 + d.dizzy * (dm.reduced ? 0.1 : Math.sin(dm.t * 1.9) * 0.2);

  RB.armR_upper.rot = swing * 0.7 + armWind;
  RB.armL_upper.rot = -swing * 0.7 + armWind * 0.55;
  RB.armR_lower.rot = -0.2 - d.coil * 0.5;
  RB.armL_lower.rot = 0.2 - d.coil * 0.4;
  RB.legR_upper.rot = -swing;
  RB.legL_upper.rot = swing;
  RB.legR_lower.rot = Math.max(0, swing) * 0.7 + d.crouch * 0.5;
  RB.legL_lower.rot = Math.max(0, -swing) * 0.7 + d.crouch * 0.5;

  // ── a chromed copy of the style: same identity, no human flourishes ───────
  const s = ROBOT_STYLE;
  s.scale = st.scale || 1;
  s.girth = st.girth || 1;
  s.headSize = st.headSize || 1;
  s.beardLength = 0;
  s.beardStyle = 'none';
  s.skin = mixCol(st.skin, '#dfe6ef', 0.28);
  s.skinShade = mixCol(st.skinShade, '#7c848f', 0.28);
  s.hair = st.hair;
  s.hatColor = st.hatColor;
  s.tunicColor = st.tunicColor;
  s.jacketColor = st.jacketColor;
  s.jacketAccent = st.jacketAccent;
  s.spikes = Math.min(2, st.spikes);
  s.shades = false;
  s.outfit = 1;
  s.tattoo = 'none';
  s.cigar = false;

  drawCharacter(ctx, s, ROBOT_POSE, HUMAN_SKELETON, x, y, facing, {
    flash: opts?.flash ?? 0,
    tint: opts?.tint,
    alpha: opts?.alpha ?? 1,
    scale: opts?.scale ?? 1,
    damage: opts?.damage,
  });

  // ── the hardware pass ──────────────────────────────────────────────────────
  solveSpine(u);
  const ow = Math.max(0.8, 1.0 * u);
  const glow = keyCol(st.jacketAccent);
  const seam = col(shadeOf(st.skinShade, 0.62));
  const steel = col(shadeOf(st.skinShade, 0.85));

  ctx.save();
  ctx.globalAlpha *= clamp(opts?.alpha ?? 1, 0, 1);
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  // Head frame, matching CharacterRig's headFrame(): centre 46% up the bone,
  // rx = len/2 * headSize, local +x forward. Travelling `L` along a bone moves
  // (-L·sin r, -L·cos r) in canvas space — rig +y is up and canvas +y is down.
  const hl = SP_LEN[5] * u;
  const hAng = OR[5];
  const hcx = OX[5] - Math.sin(hAng) * hl * 0.46;
  const hcy = OY[5] - Math.cos(hAng) * hl * 0.46;
  const hrx = hl * 0.5 * (st.headSize || 1);
  const hry = hl * 0.54 * (st.headSize || 1);

  ctx.save();
  ctx.translate(hcx, hcy);
  // headFrame's `ang`: 0 when the head is upright, growing as the head tips.
  ctx.rotate(-hAng);

  // The visor. One glowing bar where a face would be, which is the cheapest
  // and most reliable way to say "there is nobody in here".
  roundRect(ctx, -hrx * 0.62, -hry * 0.24, hrx * 1.5, hry * 0.44, hry * 0.2, col('#0d1016'), ink(), ow * 0.7);
  roundRect(ctx, -hrx * 0.5, -hry * 0.16, hrx * 1.28, hry * 0.26, hry * 0.13, glow, NO, 0);
  if (flashAmt < 0.5) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (dm.on && dm.face === 'dead' ? 0.05 : 0.3);
    roundRect(ctx, -hrx * 0.7, -hry * 0.34, hrx * 1.7, hry * 0.62, hry * 0.3, glow, NO, 0);
    ctx.globalAlpha = prev;
  }
  // a jaw seam and the crown plate line
  ctx.strokeStyle = seam;
  ctx.lineWidth = Math.max(0.5, 0.28 * u);
  ctx.beginPath();
  ctx.moveTo(-hrx * 0.72, hry * 0.42);
  ctx.lineTo(hrx * 0.78, hry * 0.36);
  ctx.moveTo(-hrx * 0.62, -hry * 0.6);
  ctx.lineTo(hrx * 0.7, -hry * 0.58);
  ctx.stroke();
  ctx.restore();

  // Chest: panel seams and a status light, laid along the spine so they follow
  // whatever the torso is doing.
  const chx = OX[3];
  const chy = OY[3];
  const cr = OR[3];
  const cs = Math.sin(cr);
  const cc = Math.cos(cr);
  // Up the bone: (-sin, -cos). Across it: (cos, -sin).
  ctx.strokeStyle = seam;
  ctx.lineWidth = Math.max(0.5, 0.32 * u);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const up = (2.5 + i * 3.4) * u;
    const half = (2.6 - i * 0.3) * u;
    const bx = chx - cs * up;
    const by = chy - cc * up;
    ctx.moveTo(bx - cc * half, by + cs * half);
    ctx.lineTo(bx + cc * half, by - cs * half);
  }
  ctx.stroke();
  {
    const up = 6.5 * u;
    const side = 1.4 * u;
    ellipse(
      ctx, chx - cs * up + cc * side, chy - cc * up - cs * side,
      0.95 * u, 0.95 * u, 0, glow, ink(), ow * 0.5,
    );
  }

  // Exposed actuators. armR_upper hangs off chest at local (2.6, 9.4) and
  // legR_upper off pelvis at (3.2, 0), so both joints are one rotation away
  // from bones the spine solve already produced.
  const shx = chx + (2.6 * cc - 9.4 * cs) * u;
  const shy = chy - (2.6 * cs + 9.4 * cc) * u;
  capsule(ctx, shx, shy, shx - cc * 3.4 * u, shy + 4.2 * u, 1.5 * u, steel, ink(), ow * 0.7);
  ellipse(ctx, shx, shy, 2.0 * u, 2.0 * u, 0, col(shadeOf(st.skinShade, 1.05)), ink(), ow * 0.7);
  ellipse(ctx, shx, shy, 0.7 * u, 0.7 * u, 0, seam, NO, 0);

  const pr = OR[1];
  const ps = Math.sin(pr);
  const pc = Math.cos(pr);
  const hipx = OX[1] + pc * 3.2 * u;
  const hipy = OY[1] - ps * 3.2 * u;
  capsule(ctx, hipx, hipy, hipx, hipy + 4.6 * u, 1.25 * u, steel, ink(), ow * 0.6);
  ellipse(ctx, hipx, hipy, 1.7 * u, 1.7 * u, 0, col(shadeOf(st.skinShade, 1.05)), ink(), ow * 0.6);

  // Sparks out of a machine that has been opened up. Wear, not blood, so this
  // survives gore: 'off' exactly as the scuffs on everyone else do.
  if (dm.on && dm.t2 > 0.3 && flashAmt < 0.5 && !dm.reduced) {
    const prev = ctx.globalAlpha;
    const beat = (dm.t * 3.1 + hashf(dm.seed, 90)) % 1;
    if (beat < 0.22) {
      ctx.globalAlpha = prev * (1 - beat / 0.22);
      for (let i = 0; i < 4; i++) {
        const a = hashf(dm.seed, 91 + i) * TAU;
        const l = (1.5 + 3.0 * hashf(dm.seed, 95 + i)) * u;
        ellipse(ctx, shx + Math.cos(a) * l, shy + Math.sin(a) * l, 0.5 * u, 0.5 * u, 0, keyCol('#ffe08a'), NO, 0);
      }
      ctx.globalAlpha = prev;
    }
  }

  ctx.restore();
}
