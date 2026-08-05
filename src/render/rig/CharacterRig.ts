/**
 * The whole cast, drawn from vector geometry. Dwarfs, guards, robots and
 * bosses all come through here — the only thing that changes is the RigStyle
 * and the skeleton.
 *
 * `style.outfit` is a continuous 0..1 blend from the classic film dwarf (tunic,
 * soft cap, rosy cheeks) to the bad boy (spiked leather, studded belt, shades,
 * cigar). The hat survives at both ends: it is the one thing that keeps each
 * dwarf recognisable as himself.
 */

import type { Bone, BoneName, Facing, Pose, RigStyle, WeaponDef } from '@/core/types';
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
  },
): void {
  const u = (opts?.scale ?? 1) * (style.scale || 1);
  const bones = resolvePose(skeleton, pose, u);

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
  drawHat(r);
  drawBeard(r);
  drawAccessories(r);

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

  const f = hatFrame(r);
  hatCone(f, pad, HAT_PTS);
  poly(ctx, HAT_PTS, c, NO);
  const b1 = off(f.base, f.side, f.w * 1.06);
  const b2 = off(f.base, f.side, -f.w * 1.06);
  capsule(ctx, b1.x, b1.y, b2.x, b2.y, f.w * 0.24 + pad, c, NO);
  ellipse(ctx, f.tip.x, f.tip.y, f.w * 0.25 + pad, f.w * 0.25 + pad, 0, c, NO);

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
function spikePop(r: Rig): number {
  const t = clamp((r.fit - 0.28) / 0.42, 0, 1);
  return t <= 0 ? 0 : easeOutBack(t);
}

function spikeCount(r: Rig): number {
  return clamp(Math.round(r.st.spikes), 0, 9);
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

  const pants = pantsCol(r);
  limb(ctx, hip.x, hip.y, knee.x, knee.y, 3.7 * u * g, 3.0 * u * g, tone(pants), ink());
  limb(ctx, knee.x, knee.y, ankle.x, ankle.y, 3.0 * u * g, 2.4 * u * g, tone(pants), ink());

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
  const sleeve = garmentCol(r);
  limb(ctx, sh.x, sh.y, el.x, el.y, 3.5 * u * g, 2.8 * u * g, tone(sleeve), ink());
  limb(ctx, el.x, el.y, wr.x, wr.y, 2.7 * u * g, 2.3 * u * g, flesh(r.st.skin), ink());

  // cuff at the elbow
  const pp = perp(el, wr);
  const ca = off(el, pp, 2.9 * u * g);
  const cb = off(el, pp, -2.9 * u * g);
  capsule(
    ctx, ca.x, ca.y, cb.x, cb.y, 1.0 * u,
    tone(mixCol(shadeOf(r.st.tunicColor, 1.2), r.st.jacketAccent, r.fit)), ink(), r.ow * 0.7,
  );

  const pop = spikePop(r);
  const count = spikeCount(r);
  if (pop > 0.02 && count > 0) {
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
  const P = jp(r, 'pelvis');
  const N = jp(r, 'neck');
  const spineLen = len2(P, N) || u;
  const hw = spineLen * 0.42 * r.girth;
  const pp = perp(P, N); // points forward (+x when facing right)

  // body mass
  const a = mid(P, N, 0.02);
  const b = mid(P, N, 0.84);
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

  // neck
  const H = jp(r, 'head');
  capsule(ctx, N.x, N.y, H.x, H.y, 2.1 * u * r.girth, keyCol(shadeOf(r.st.skin, 0.9)), ink(), r.ow);

  drawJacket(r, P, N, hw, pp);
  drawBelt(r, P, hw, pp);

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

function drawJacket(r: Rig, P: Pt, N: Pt, hw: number, pp: Pt): void {
  const cover = clamp(r.fit * 1.25, 0, 1);
  if (cover < 0.02) return;
  const ctx = r.ctx;
  const u = r.u;
  const jc = col(r.st.jacketColor);

  // the hem crawls down over the tunic as the outfit blend rises
  const top = mid(P, N, 0.9);
  const bot = mid(P, N, lerp(0.9, -0.04, cover));
  const tw = hw * 1.08;
  const bw = hw * 1.0;
  poly(
    ctx,
    [
      top.x + pp.x * tw, top.y + pp.y * tw,
      bot.x + pp.x * bw, bot.y + pp.y * bw,
      bot.x - pp.x * bw, bot.y - pp.y * bw,
      top.x - pp.x * tw, top.y - pp.y * tw,
    ],
    jc,
    ink(),
    r.ow,
  );

  if (cover > 0.3) {
    // open front: lapel folded back, zip running down the middle
    const lapTop = off(top, pp, hw * 1.0);
    const lapIn = off(top, pp, hw * 0.05);
    const lapEnd = off(mid(top, bot, 0.5), pp, hw * 0.62);
    poly(
      ctx,
      [lapTop.x, lapTop.y, lapEnd.x, lapEnd.y, lapIn.x, lapIn.y],
      col(shadeOf(r.st.jacketColor, 1.35)),
      ink(),
      r.ow * 0.8,
    );
    const z1 = off(mid(top, bot, 0.86), pp, hw * 0.1);
    const z2 = off(mid(top, bot, 0.12), pp, hw * 0.16);
    capsule(ctx, z1.x, z1.y, z2.x, z2.y, 0.55 * u, keyCol(r.st.jacketAccent), ink(), r.ow * 0.5);

    // popped collar
    const cA = off(top, pp, hw * 0.95);
    const cB = off(top, pp, -hw * 0.95);
    const upA = { x: cA.x + pp.x * 1.2 * u, y: cA.y - 3.4 * u };
    const upB = { x: cB.x - pp.x * 1.2 * u, y: cB.y - 3.0 * u };
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

  // brow ridge — level and friendly at 0, dropped and mean at 1
  const browY = -ry * 0.36;
  const meanness = r.fit * 0.5;
  capsule(
    ctx, rx * 0.08, browY + meanness * ry * 0.22, rx * 0.72, browY - ry * 0.06,
    0.95 * u, hair, ink(), r.ow * 0.6,
  );
  capsule(
    ctx, -rx * 0.34, browY + meanness * ry * 0.16, -rx * 0.02, browY - ry * 0.02,
    0.8 * u, keyCol(shadeOf(r.st.hair, 0.8)), ink(), r.ow * 0.5,
  );

  // eyes: the near one reads, the far one is a hint
  const eyeY = -ry * 0.1;
  ellipse(ctx, rx * 0.44, eyeY, 1.5 * u, 1.7 * u, 0, col('#f6f2ea'), ink(), r.ow * 0.55);
  ellipse(ctx, rx * 0.56, eyeY + 0.2 * u, 0.72 * u, 0.86 * u, 0, col('#1a1622'), NO);
  ellipse(ctx, rx * 0.04, eyeY + 0.1 * u, 1.1 * u, 1.35 * u, 0, col('#e8e2d8'), ink(), r.ow * 0.5);
  ellipse(ctx, rx * 0.12, eyeY + 0.28 * u, 0.6 * u, 0.72 * u, 0, col('#1a1622'), NO);

  // the nose. It is a potato and it is load-bearing.
  ellipse(ctx, rx * 0.7, ry * 0.06, rx * 0.36, ry * 0.3, -0.15, dark, ink(), r.ow);
  ellipse(ctx, rx * 0.66, -ry * 0.02, rx * 0.13, ry * 0.1, 0, keyCol(shadeOf(r.st.skin, 1.12)), NO);

  // mouth, only where a beard is not already covering it
  const bs = r.st.beardStyle;
  if (bs === 'none' || bs === 'stubble') {
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
  const shadeT = r.st.shades ? clamp((r.fit - 0.42) / 0.34, 0, 1) : 0;
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
