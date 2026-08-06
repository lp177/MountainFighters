/**
 * Map covers — one poster per map, for the gallery on the home screen.
 *
 * THIS IS A POSTER, NOT A SCREENSHOT. The player asked for a wall of covers
 * that suggest a place without spoiling it, so nothing here renders the level:
 * there is no camera, no parallax band from `game/Backdrop.ts`, no prop layout
 * and no boss portrait. Every cover is a deliberate composition — a sky, a fog
 * band, a ground line, two or three large theme silhouettes, and the map's own
 * accent used once or twice — built entirely from that map's `MapPalette` so it
 * is unmistakably that place's colours and nothing else.
 *
 * The rules that keep it a poster:
 *
 *   - Silhouettes are ABSTRACTED. A tunnel is an arch and a light at the end of
 *     it, not the bore rings the fight is drawn against. They have to read at
 *     90x60, so everything scales off w/h and detail is dropped below a
 *     thumbnail's worth of pixels rather than turning to mush.
 *   - A BOSS is a looming dark shape and two lit eyes, chosen by `rigOverride`:
 *     low and four-legged, an angular wedge, a tall finned column, or a broad
 *     humanoid. It has to read as a threat and stay unidentifiable — that is
 *     the whole spoiler rule.
 *   - A LOCKED map gives away nothing at all, not even its colours: a flat
 *     plate in the UI neutrals with a blanked-out panel and a question mark.
 *   - A CLEARED map earns a brighter accent and a stamp, so the wall visibly
 *     fills in behind the player.
 *
 * MOTION. Every animated term is `base + amplitude * focus * sin(frame)`, so a
 * card at focus 0 is perfectly static and settles smoothly rather than snapping
 * when the highlight leaves it. Seventy cards redrawing every frame must not
 * thrash, so blinking lights freeze when a card is not highlighted.
 *
 * ALLOCATION. Nothing in the draw path allocates. Every derived colour string
 * is computed once per palette into a `CoverTone` and cached against the
 * palette object; the three gradients are cached beside them and only rebuilt
 * when the card size (or the canvas) changes. Scene state lives in one
 * module-level struct rather than an options object per call.
 *
 * COST. A cover is 60–130 fills and strokes, so all seventy at 90x60 come to
 * about 5,000 rasterising calls — a fraction of what one fight frame draws, and
 * cheap enough to paint live. A caller that wants it cheaper should cache the
 * unfocused cards into an offscreen canvas and repaint one card on focus,
 * because a cover only changes when `frame` moves and `focus` is above zero.
 *
 * NO TYPE. A cover draws no text at all — not the map's name, not its number.
 * The gallery owns its own typography and needs the whole card to lay it over.
 *
 * This module is presentation-only: it never touches the sim, the save file or
 * the audio bus, and it draws in the caller's current transform.
 */

import type { BossDef, MapDef, MapPalette, MapTheme } from '@/core/types';
import { TAU, clamp, lerp } from '@/core/math';
import { BOSSES } from '@/content/bosses';
import { capsule, ellipse, roundRect, star } from '@/render/Shapes';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// The neutral palette a locked cover is drawn in. Deliberately the UI's own
// colours (see scenes/HomeScene.ts, scenes/SelectScene.ts) and NOT the map's:
// an unplayed map may not leak so much as its hue.
// ─────────────────────────────────────────────────────────────────────────────

const N_SURFACE = '#0d1018';
const N_DEEP = '#080a0f';
const N_PLATE = '#11151f';
const N_HATCH = '#151a26';
const N_OUTLINE = '#2c3242';
const N_FAINT = '#6d768a';
const N_DIM = '#a2aabb';

/** Bosses by id, built once. `MapDef.boss` is a string reference into this. */
const BOSS_BY_ID = new Map<string, BossDef>();
for (const b of BOSSES) BOSS_BY_ID.set(b.id, b);

// ─────────────────────────────────────────────────────────────────────────────
// Colour maths. Used only when a palette's tone is built, never per frame.
// ─────────────────────────────────────────────────────────────────────────────

/** `#rgb`, `#rrggbb`, `rgb()` and `rgba()` → packed 0xRRGGBB, or -1. */
function rgbOf(color: string): number {
  const k = color.charCodeAt(0);
  if (k === 35 /* # */) {
    const s = color.slice(1);
    if (s.length === 3) {
      const v = parseInt(s, 16);
      if (Number.isNaN(v)) return -1;
      const r = (v >> 8) & 0xf;
      const g = (v >> 4) & 0xf;
      const b = v & 0xf;
      return ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
    }
    if (s.length >= 6) {
      const v = parseInt(s.slice(0, 6), 16);
      return Number.isNaN(v) ? -1 : v;
    }
    return -1;
  }
  if (k === 114 /* r */) {
    const open = color.indexOf('(');
    if (open < 0) return -1;
    const parts = color.slice(open + 1, color.lastIndexOf(')')).split(',');
    if (parts.length < 3) return -1;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    if (Number.isNaN(r + g + b)) return -1;
    return (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);
  }
  return -1;
}

function pack(r: number, g: number, b: number): string {
  return `rgb(${clamp(Math.round(r), 0, 255)},${clamp(Math.round(g), 0, 255)},${clamp(
    Math.round(b),
    0,
    255,
  )})`;
}

/** k < 1 darkens, k > 1 lightens, hue intact. */
function shade(color: string, k: number): string {
  const c = rgbOf(color);
  if (c < 0) return color;
  return pack(((c >> 16) & 255) * k, ((c >> 8) & 255) * k, (c & 255) * k);
}

function mix(a: string, b: string, t: number): string {
  const ca = rgbOf(a);
  const cb = rgbOf(b);
  if (ca < 0 || cb < 0) return a;
  return pack(
    lerp((ca >> 16) & 255, (cb >> 16) & 255, t),
    lerp((ca >> 8) & 255, (cb >> 8) & 255, t),
    lerp(ca & 255, cb & 255, t),
  );
}

function withAlpha(color: string, a: number): string {
  const c = rgbOf(color);
  if (c < 0) return color;
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${clamp(a, 0, 1).toFixed(3)})`;
}

/** Rec.709 luminance, 0..255. */
function luma(color: string): number {
  const c = rgbOf(color);
  if (c < 0) return 0;
  return 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
}

/** Rescale to a target luminance, hue intact. How every accent is made to read. */
function toneTo(color: string, target: number): string {
  const c = rgbOf(color);
  if (c < 0) return color;
  const l = luma(color);
  if (l < 1) {
    const v = clamp(target, 0, 255);
    return pack(v, v, v);
  }
  const k = clamp(target, 0, 255) / l;
  return pack(((c >> 16) & 255) * k, ((c >> 8) & 255) * k, (c & 255) * k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-palette tone
//
// Every string a cover can need, derived once from the map's own palette and
// held against it. `MAPS` is seventy fixed objects, so this settles at seventy
// entries and never grows again.
// ─────────────────────────────────────────────────────────────────────────────

interface CoverTone {
  skyTop: string;
  skyBot: string;
  far: string;
  farDim: string;
  mid: string;
  midDim: string;
  midDeep: string;
  midLit: string;
  near: string;
  nearDim: string;
  nearLit: string;
  ground: string;
  groundLo: string;
  line: string;
  fogClear: string;
  fogDense: string;
  accent: string;
  accentMid: string;
  accentSoft: string;
  /** Opaque darkened accent, for painted metal rather than for light. */
  accentDeep: string;
  accentDeeper: string;
  stamp: string;
  glass: string;
  warm: string;
  ink: string;
  inkSoft: string;
  rim: string;
  /** Warm lift painted over a cleared cover, so the wall brightens as it fills. */
  clearWash: string;
  /** The opposite, for a map visited but not yet beaten. */
  dullWash: string;

  // Gradient cache. Rebuilt only when the card size or the canvas changes.
  gctx: C2D | null;
  gw: number;
  gh: number;
  sky: CanvasGradient | null;
  fog: CanvasGradient | null;
  floor: CanvasGradient | null;
}

const TONES = new WeakMap<MapPalette, CoverTone>();

function toneFor(p: MapPalette): CoverTone {
  const hit = TONES.get(p);
  if (hit) return hit;

  const skyL = luma(p.sky[0]);
  const accentL = luma(p.accent);
  const ink = mix(p.sky[0], '#0a0810', 0.55);

  const tone: CoverTone = {
    // A poster is lit better than the level it advertises: the sky is opened up
    // a little at the top so the silhouettes below it have something to sit on.
    skyTop: shade(p.sky[0], 0.92),
    skyBot: mix(p.sky[1], p.fog, 0.25),
    far: mix(p.far, p.fog, 0.42),
    farDim: mix(p.far, ink, 0.4),
    mid: p.mid,
    midDim: shade(p.mid, 0.72),
    midDeep: mix(p.mid, ink, 0.45),
    midLit: shade(p.mid, 1.28),
    near: p.near,
    nearDim: mix(p.near, ink, 0.5),
    nearLit: shade(p.near, 1.24),
    ground: toneTo(p.ground, clamp(luma(p.ground) * 1.35, 26, 120)),
    groundLo: toneTo(p.ground, clamp(luma(p.ground) * 0.7, 12, 70)),
    line: withAlpha(p.groundLine, 0.7),
    fogClear: withAlpha(p.fog, 0),
    fogDense: withAlpha(p.fog, 0.55),
    accent: p.accent,
    accentMid: withAlpha(p.accent, 0.55),
    accentSoft: withAlpha(p.accent, 0.42),
    accentDeep: shade(p.accent, 0.5),
    accentDeeper: shade(p.accent, 0.34),
    stamp: toneTo(p.accent, clamp(accentL * 1.18, 150, 235)),
    glass: withAlpha(mix(p.accent, '#dff2ff', 0.72), 0.14),
    warm: mix('#ffd98a', p.accent, 0.25),
    ink,
    inkSoft: withAlpha(ink, 0.55),
    rim: withAlpha(toneTo(p.accent, clamp(accentL * 0.9, 90, 200)), 0.5),
    clearWash: withAlpha(toneTo(p.accent, 200), 0.07),
    // Scaled off the sky, so a bright map dulls as much as a dark one does.
    dullWash: withAlpha(mix(ink, '#000000', 0.4), skyL > 40 ? 0.2 : 0.14),

    gctx: null,
    gw: -1,
    gh: -1,
    sky: null,
    fog: null,
    floor: null,
  };

  TONES.set(p, tone);
  return tone;
}

function ensureGradients(ctx: C2D, tone: CoverTone, w: number, h: number, hz: number, fogH: number): void {
  if (tone.gctx === ctx && tone.gw === w && tone.gh === h && tone.sky) return;
  tone.gctx = ctx;
  tone.gw = w;
  tone.gh = h;

  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, tone.skyTop);
  sky.addColorStop(1, tone.skyBot);
  tone.sky = sky;

  const fog = ctx.createLinearGradient(0, hz - fogH, 0, hz);
  fog.addColorStop(0, tone.fogClear);
  fog.addColorStop(1, tone.fogDense);
  tone.fog = fog;

  const floor = ctx.createLinearGradient(0, hz, 0, h);
  floor.addColorStop(0, tone.ground);
  floor.addColorStop(1, tone.groundLo);
  tone.floor = floor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stable noise. Layout must never change frame to frame, so this is pure and is
// only ever fed the map's own seed.
// ─────────────────────────────────────────────────────────────────────────────

function hash(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 8) / 0x1000000;
}

function hr(n: number, a: number, b: number): number {
  return a + hash(n) * (b - a);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene state
//
// One struct, filled per call. Themes read it instead of taking an options
// object, which is what keeps the draw path allocation-free.
// ─────────────────────────────────────────────────────────────────────────────

interface CoverScene {
  w: number;
  h: number;
  /** Screen y of the ground line. */
  hz: number;
  /** The unit everything scales off: the short side of the card. */
  u: number;
  /** Ink width for outlined shapes at this size. */
  ow: number;
  frame: number;
  focus: number;
  /** Slow phase for every drifting term. */
  t: number;
  /** -1..1, already multiplied by focus. The parallax and sway driver. */
  drift: number;
  /** A second, slower driver so two layers never move in lockstep. */
  drift2: number;
  /** Frozen at 0 unless the card is highlighted, so idle cards do not blink. */
  blink: number;
  /** Per-map layout seed. Two maps of one theme are never laid out alike. */
  seed: number;
  /** False on thumbnails too small for small print. */
  detail: boolean;
  tone: CoverTone;
}

const S: CoverScene = {
  w: 0,
  h: 0,
  hz: 0,
  u: 0,
  ow: 1,
  frame: 0,
  focus: 0,
  t: 0,
  drift: 0,
  drift2: 0,
  blink: 0,
  seed: 0,
  detail: true,
  tone: null as unknown as CoverTone,
};

/** Parallax offset for a layer, in pixels. `depth` 0 = far, 1 = near. */
function par(depth: number): number {
  return S.drift * S.w * 0.02 * depth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives that do not allocate
//
// render/Shapes.ts `poly` takes a flat array, which means an array literal per
// call; at seventy cards a frame that is the one thing worth avoiding. These
// build the path straight into the context instead.
// ─────────────────────────────────────────────────────────────────────────────

const NONE = 'none';

function paint(ctx: C2D, fill: string, outline: string, ow: number): void {
  if (ow > 0 && outline !== NONE) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = ow * 2;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  if (fill !== NONE) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

function tri(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  fill: string,
  outline: string = NONE,
  ow = 0,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.closePath();
  paint(ctx, fill, outline, ow);
}

function quad(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
  fill: string,
  outline: string = NONE,
  ow = 0,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  paint(ctx, fill, outline, ow);
}

function line(ctx: C2D, x1: number, y1: number, x2: number, y2: number, color: string, w: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.4, w);
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** Rounded-rect PATH only — the clip and the rim both need it unpainted. */
function rrPath(ctx: C2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  if (rr <= 0.01) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A doorway: flat sides, semicircular head. The tunnel and the mine live on it. */
function archPath(ctx: C2D, cx: number, halfW: number, topY: number, baseY: number): void {
  const r = Math.max(0.5, Math.min(halfW, (baseY - topY) * 0.86));
  ctx.moveTo(cx - halfW, baseY);
  ctx.lineTo(cx - halfW, topY + r);
  ctx.arc(cx, topY + r, r, Math.PI, 0);
  ctx.lineTo(cx + halfW, baseY);
  ctx.closePath();
}

/** Soft bloom without a gradient: three additive discs. */
function glow(ctx: C2D, x: number, y: number, r: number, color: string, a: number): void {
  if (a <= 0.005 || r <= 0.2) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = color;
  ctx.globalAlpha = a * 0.14;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = a * 0.22;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.55, r * 0.55, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = a * 0.45;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.24, r * 0.24, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** A lit panel: the workhorse of every window, LED and strip light. */
function lit(ctx: C2D, x: number, y: number, w: number, h: number, color: string, a: number): void {
  if (a <= 0.01 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = color;
  const b = Math.max(0.6, Math.min(w, h) * 0.8);
  ctx.globalAlpha = a * 0.18;
  ctx.fillRect(x - b, y - b, w + b * 2, h + b * 2);
  ctx.globalAlpha = clamp(a, 0, 1);
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** True when a light seeded `n` is on this instant. Frozen while unfocused. */
function on(n: number, p = 0.5): boolean {
  return hash(n + S.blink * 131) > p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared passes
// ─────────────────────────────────────────────────────────────────────────────

function drawSky(ctx: C2D): void {
  const { w, hz, tone } = S;
  ctx.fillStyle = tone.sky ?? tone.skyTop;
  ctx.fillRect(-1, -1, w + 2, hz + 2);
  // A single soft light high in the sky, drifting when the card is highlighted.
  glow(ctx, w * (0.3 + 0.12 * S.drift2), hz * 0.34, S.u * 0.4, tone.accent, 0.1 + 0.08 * S.focus);
  ctx.globalAlpha = 1;
}

function drawFog(ctx: C2D): void {
  const { w, hz, h, tone } = S;
  const fogH = h * 0.24;
  ctx.fillStyle = tone.fog ?? tone.fogDense;
  ctx.fillRect(-1, hz - fogH, w + 2, fogH + 1);
}

function drawGround(ctx: C2D): void {
  const { w, h, hz, u, tone } = S;
  ctx.fillStyle = tone.floor ?? tone.ground;
  ctx.fillRect(-1, hz, w + 2, h - hz + 1);

  // The line itself: the one hard edge on the whole cover.
  ctx.fillStyle = tone.line;
  ctx.fillRect(-1, hz - Math.max(0.5, u * 0.008), w + 2, Math.max(0.7, u * 0.014));

  // Two depth marks, enough to say "a floor you walk along" and no more.
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = tone.line;
  ctx.fillRect(-1, hz + (h - hz) * 0.34, w + 2, Math.max(0.4, u * 0.006));
  ctx.globalAlpha = 0.12;
  ctx.fillRect(-1, hz + (h - hz) * 0.72, w + 2, Math.max(0.4, u * 0.006));
  ctx.globalAlpha = 1;
}

/**
 * The drifting light every highlighted card gets: one wide, very faint diagonal
 * sweep. Cheap, calm, and identical for all twelve themes so the wall breathes
 * together instead of twelve different ways.
 */
function drawSheen(ctx: C2D): void {
  const { w, h, focus } = S;
  if (focus <= 0.02) return;
  const cx = w * (0.5 + 0.42 * Math.sin(S.t * 0.6));
  const halfW = w * 0.16;
  const lean = h * 0.34;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.05 * focus;
  quad(ctx, cx - halfW + lean, -2, cx + halfW + lean, -2, cx + halfW - lean, h + 2, cx - halfW - lean, h + 2, '#ffffff');
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme art
//
// Each theme is a `back` (everything above and behind the ground line) and a
// `front` (the near frame the fight would happen inside). The pipeline drops
// the fog and the ground between them, so the near band always sits in front of
// the floor and the far band always sits behind the haze.
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeArt {
  back(ctx: C2D): void;
  front(ctx: C2D): void;
}

function noFront(_ctx: C2D): void {
  /* some themes are all distance */
}

// ── tunnel ───────────────────────────────────────────────────────────────────
// A mouth you are standing in, a bore receding away, and the light at the end.

const TUNNEL: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    const vx = w * (0.46 + hr(seed, -0.04, 0.08)) + par(0.25);
    const vy = hz - h * 0.3;

    // Four nested arches, each darker, walking away into the hill.
    for (let i = 0; i < 4; i++) {
      const k = 1 - i * 0.21;
      const c = i === 0 ? tone.mid : i === 1 ? tone.midDim : i === 2 ? tone.farDim : tone.ink;
      ctx.beginPath();
      archPath(ctx, vx, w * 0.3 * k, vy - h * 0.16 * k, hz + h * 0.04);
      ctx.fillStyle = c;
      ctx.fill();
    }

    // The strip light on the crown, converging on the far end.
    for (let i = 0; i < 5; i++) {
      const k = 1 - i * 0.19;
      const lw = w * 0.1 * k;
      const ly = vy - h * 0.13 * k;
      lit(ctx, vx - lw * 0.5, ly, lw, Math.max(0.7, u * 0.018 * k), '#e8f4ff', on(seed + i * 7, 0.14) ? 0.75 * k : 0.08);
    }

    glow(ctx, vx, vy, u * 0.16, tone.accent, 0.5 + 0.2 * S.drift2);
  },
  front(ctx) {
    const { w, h, u, hz, tone } = S;
    // The wall we are looking through, punched out with an even-odd fill.
    ctx.beginPath();
    ctx.rect(-2, -2, w + 4, h + 4);
    archPath(ctx, w * 0.5 + par(0.9), w * 0.4, h * 0.08, h + 4);
    ctx.fillStyle = tone.nearDim;
    ctx.fill('evenodd');

    if (!S.detail) return;
    // Hazard chevrons on the haunch, the one place the accent is allowed to shout.
    const cy = hz + (h - hz) * 0.42;
    for (let i = 0; i < 4; i++) {
      const x = w * (0.12 + i * 0.07);
      ctx.globalAlpha = 0.5;
      quad(ctx, x, cy, x + u * 0.06, cy - u * 0.05, x + u * 0.1, cy - u * 0.05, x + u * 0.04, cy, i % 2 === 0 ? tone.accent : tone.ink);
      ctx.globalAlpha = 1;
    }
  },
};

// ── factory ──────────────────────────────────────────────────────────────────
// A sawtooth shed, two stacks, and a shift that never ends.

const FACTORY: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    const p1 = par(0.3);
    for (let i = 0; i < 5; i++) {
      const bh = h * hr(seed + i * 13, 0.1, 0.24);
      ctx.fillStyle = tone.farDim;
      ctx.fillRect(w * (0.02 + i * 0.2) + p1, hz - bh, w * 0.15, bh);
    }

    const p2 = par(0.6);
    const bx = w * 0.08 + p2;
    const bw = w * 0.6;
    const by = hz - h * 0.26;
    ctx.fillStyle = tone.mid;
    ctx.fillRect(bx, by, bw, hz - by);

    // North-light roof: four teeth, glass on the shaded face.
    const teeth = 4;
    for (let i = 0; i < teeth; i++) {
      const x = bx + (i * bw) / teeth;
      const tw = bw / teeth;
      tri(ctx, x, by, x + tw, by, x + tw, by - h * 0.11, tone.midDim);
      line(ctx, x + tw * 0.08, by - h * 0.01, x + tw * 0.94, by - h * 0.1, tone.glass, u * 0.02);
    }

    // Stacks. One is still working.
    for (let i = 0; i < 2; i++) {
      const sx = bx + bw * (0.16 + i * 0.62);
      const sh = h * hr(seed + i * 31, 0.34, 0.46);
      ctx.fillStyle = tone.midDim;
      ctx.fillRect(sx, hz - sh, u * 0.05, sh);
      ctx.fillStyle = tone.mid;
      ctx.fillRect(sx - u * 0.012, hz - sh, u * 0.074, u * 0.03);
      if (i === 0) {
        for (let k = 0; k < 3; k++) {
          const rise = k * 0.32 + 0.14 + 0.06 * S.drift2;
          ctx.globalAlpha = 0.16 * (1 - rise);
          ellipse(ctx, sx + u * 0.03 + rise * u * 0.16, hz - sh - rise * h * 0.26, u * (0.03 + rise * 0.07), u * (0.026 + rise * 0.06), 0, tone.fogDense, NONE, 0);
          ctx.globalAlpha = 1;
        }
      }
    }

    // The shift.
    if (!S.detail) return;
    for (let i = 0; i < 7; i++) {
      const wx = bx + bw * (0.06 + i * 0.13);
      lit(ctx, wx, hz - h * 0.16, u * 0.055, u * 0.05, tone.warm, on(seed + i * 5, 0.28) ? 0.5 : 0.08);
    }
  },
  front(ctx) {
    const { w, h, u, tone } = S;
    // Hazard band across the floor: the factory's signature and its warning.
    // The dark bed goes down first — painted over the chevrons it only made
    // them muddy, and this is the one place the accent is meant to shout.
    const y = h - u * 0.11;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = tone.ink;
    ctx.fillRect(-1, y, w + 2, u * 0.11 + 1);
    ctx.globalAlpha = 0.85;
    for (let i = -1; i < 12; i++) {
      const x = w * i * 0.1 + par(1.2);
      quad(ctx, x, y + u * 0.1, x + u * 0.06, y, x + u * 0.12, y, x + u * 0.06, y + u * 0.1, i % 2 === 0 ? tone.accent : tone.midDeep);
    }
    ctx.globalAlpha = 1;
  },
};

// ── server_farm ──────────────────────────────────────────────────────────────
// Rack rows, a cold aisle between them, and ninety decibels of nothing.

const SERVER: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // The far row, higher and smaller: the aisle runs away from you.
    const farTop = hz - h * 0.34;
    for (let i = 0; i < 5; i++) {
      const x = w * (0.54 + i * 0.1) + par(0.35);
      ctx.fillStyle = i % 2 === 0 ? tone.farDim : tone.far;
      ctx.fillRect(x, farTop, w * 0.085, hz - farTop - h * 0.04);
    }

    // The near row: taller, closer, and blinking.
    const top = hz - h * 0.52;
    for (let i = 0; i < 4; i++) {
      const x = w * (0.04 + i * 0.12) + par(0.75);
      const cw = w * 0.1;
      ctx.fillStyle = tone.mid;
      ctx.fillRect(x, top, cw, hz - top);
      ctx.fillStyle = tone.midDim;
      ctx.fillRect(x + cw * 0.1, top + h * 0.02, cw * 0.8, hz - top - h * 0.05);
      if (!S.detail) continue;
      for (let u2 = 0; u2 < 7; u2++) {
        const ly = top + h * 0.045 + u2 * ((hz - top) * 0.115);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = tone.nearLit;
        ctx.fillRect(x + cw * 0.16, ly, cw * 0.66, Math.max(0.5, u * 0.012));
        ctx.globalAlpha = 1;
        if (on(seed + i * 91 + u2 * 13, 0.42)) {
          lit(ctx, x + cw * 0.2, ly, Math.max(0.7, u * 0.022), Math.max(0.7, u * 0.02), hash(seed + i + u2) > 0.78 ? '#ff5b4a' : '#63ff9d', 0.8);
        }
      }
    }

    // Cold aisle.
    lit(ctx, w * 0.5, top + h * 0.06, Math.max(0.8, u * 0.02), hz - top - h * 0.08, tone.accent, 0.22 + 0.1 * S.drift2);
  },
  front: noFront,
};

// ── launchpad ────────────────────────────────────────────────────────────────
// A gantry, a distant vehicle, and a window that closes in four minutes.

const LAUNCHPAD: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // Cloud decks, because a pad is always photographed at dawn.
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w * 0.05 + par(0.15), hz - h * 0.5, w * 0.5, u * 0.03);
    ctx.fillRect(w * 0.42 + par(0.2), hz - h * 0.42, w * 0.45, u * 0.026);
    ctx.globalAlpha = 1;

    // The vehicle, far off and small. It is not the subject; the pad is.
    const rx = w * (0.2 + hr(seed, -0.03, 0.05)) + par(0.4);
    const rh = h * 0.42;
    const rw = u * 0.05;
    ctx.fillStyle = tone.nearLit;
    ctx.fillRect(rx - rw * 0.5, hz - rh, rw, rh);
    tri(ctx, rx, hz - rh - u * 0.11, rx + rw * 0.5, hz - rh, rx - rw * 0.5, hz - rh, tone.nearLit);
    tri(ctx, rx - rw * 0.5, hz - u * 0.09, rx - rw * 1.5, hz, rx - rw * 0.5, hz, tone.midDim);
    tri(ctx, rx + rw * 0.5, hz - u * 0.09, rx + rw * 1.5, hz, rx + rw * 0.5, hz, tone.midDim);
    for (let k = 0; k < 3; k++) {
      const t = k * 0.3 + 0.1 + 0.08 * S.drift2;
      ctx.globalAlpha = 0.2 * (1 - t);
      ellipse(ctx, rx + rw * 1.2 + t * u * 0.14, hz - rh * 0.5 - t * h * 0.16, u * (0.03 + t * 0.06), u * (0.024 + t * 0.05), 0, '#ffffff', NONE, 0);
      ctx.globalAlpha = 1;
    }

    // The gantry. Two legs, six braces, one arm reaching for the vehicle.
    const gx = w * 0.62 + par(0.7);
    const gw = w * 0.24;
    const gt = h * 0.1;
    ctx.fillStyle = tone.mid;
    ctx.fillRect(gx, gt, u * 0.05, hz - gt);
    ctx.fillRect(gx + gw - u * 0.05, gt, u * 0.05, hz - gt);
    for (let i = 0; i < 6; i++) {
      const y0 = gt + i * ((hz - gt) / 6);
      const y1 = y0 + (hz - gt) / 6;
      line(ctx, gx, y0, gx + gw, y1, tone.midLit, u * 0.016);
      line(ctx, gx + gw, y0, gx, y1, tone.midLit, u * 0.016);
      ctx.fillStyle = tone.midDim;
      ctx.fillRect(gx, y0 - u * 0.008, gw, Math.max(0.5, u * 0.016));
    }
    ctx.fillStyle = tone.midDim;
    ctx.fillRect(gx - gw * 0.5, gt + h * 0.16, gw * 0.55, Math.max(0.8, u * 0.03));

    // Floodlight, and the cone it throws across the pad.
    const on1 = on(seed + 3, 0.12);
    if (on1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.07;
      quad(ctx, gx, gt, gx + gw * 0.4, gt, gx + gw * 0.9, hz, gx - gw * 1.1, hz, '#fff3c4');
      ctx.restore();
      glow(ctx, gx + gw * 0.18, gt, u * 0.1, '#fff3c4', 0.7);
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone } = S;
    // Scorch from the last four attempts, all of them officially successes.
    ctx.globalAlpha = 0.3;
    ellipse(ctx, w * 0.34, hz + (h - hz) * 0.55, w * 0.3, (h - hz) * 0.4, 0, tone.ink, NONE, 0);
    ctx.globalAlpha = 1;
    // A hold-down clamp, cropped, close enough to touch.
    ctx.fillStyle = tone.nearDim;
    ctx.fillRect(-u * 0.05, hz + (h - hz) * 0.1, u * 0.22, h);
  },
};

// ── mars_dome ────────────────────────────────────────────────────────────────
// A geodesic shell, a rust sky, and a small blue dot you cannot afford to reach.

const MARS: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // Home, from here.
    const ex = w * 0.16;
    const ey = h * 0.16;
    glow(ctx, ex, ey, u * 0.08, '#7fc0ff', 0.55 + 0.15 * S.drift2);
    ellipse(ctx, ex, ey, Math.max(0.8, u * 0.018), Math.max(0.8, u * 0.018), 0, '#bcdcff', NONE, 0);

    // Regolith hills.
    ctx.beginPath();
    ctx.moveTo(-2, hz + 2);
    for (let i = 0; i <= 6; i++) {
      ctx.lineTo(w * (i / 6) + par(0.25), hz - h * hr(seed + i * 17, 0.03, 0.13));
    }
    ctx.lineTo(w + 2, hz + 2);
    ctx.closePath();
    ctx.fillStyle = tone.farDim;
    ctx.fill();

    // The shell.
    const cx = w * (0.58 + hr(seed + 5, -0.05, 0.05)) + par(0.5);
    const r = Math.min(w * 0.34, h * 0.46);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - r, hz);
    ctx.arc(cx, hz, r, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = tone.glass;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = tone.accentSoft;
    ctx.lineWidth = Math.max(0.5, u * 0.014);
    for (let i = -3; i <= 3; i++) {
      const a = Math.PI * 1.5 + i * 0.34;
      ctx.beginPath();
      ctx.moveTo(cx, hz);
      ctx.lineTo(cx + Math.cos(a) * r * 1.1, hz + Math.sin(a) * r * 1.1);
      ctx.stroke();
    }
    for (let k = 1; k <= 2; k++) {
      ctx.beginPath();
      ctx.arc(cx, hz, r * (0.34 + k * 0.3), Math.PI, 0);
      ctx.stroke();
    }
    ctx.restore();
    // The rib of the shell itself, the one line that has to survive at 90x60.
    ctx.beginPath();
    ctx.arc(cx, hz, r, Math.PI, 0);
    ctx.lineWidth = Math.max(0.8, u * 0.024);
    ctx.strokeStyle = tone.midLit;
    ctx.stroke();
  },
  front(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    // A habitat can, half buried, with somebody still awake in it.
    const hx = w * 0.05;
    const hy = hz + (h - hz) * 0.18;
    const hw = w * 0.3;
    const hh = Math.max(3, (h - hy) * 0.62);
    roundRect(ctx, hx, hy, hw, hh, hh * 0.5, tone.nearDim, tone.ink, S.ow);
    lit(ctx, hx + hw * 0.62, hy + hh * 0.3, Math.max(1, u * 0.035), Math.max(1, u * 0.035), tone.accent, on(seed + 9, 0.1) ? 0.7 : 0.2);
    // Dust, low and moving.
    if (S.focus > 0.02) {
      ctx.globalAlpha = 0.1;
      ellipse(ctx, w * (0.6 + 0.18 * Math.sin(S.t * 0.5)), hz + (h - hz) * 0.4, w * 0.16, (h - hz) * 0.22, 0, tone.midLit, NONE, 0);
      ctx.globalAlpha = 1;
    }
  },
};

// ── boardroom ────────────────────────────────────────────────────────────────
// A table you are not invited to sit at, and a city that pays for it.

const BOARDROOM: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // The city, through the glass.
    const p = par(0.3);
    for (let i = 0; i < 8; i++) {
      const bw = w * hr(seed + i * 7, 0.06, 0.12);
      const bh = h * hr(seed + i * 11, 0.12, 0.42);
      const x = w * (i * 0.13 - 0.02) + p;
      ctx.fillStyle = tone.farDim;
      ctx.fillRect(x, hz - bh, bw, bh);
      if (!S.detail) continue;
      for (let k = 0; k < 3; k++) {
        if (!on(seed + i * 41 + k, 0.55)) continue;
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = tone.warm;
        ctx.fillRect(x + bw * 0.2, hz - bh + h * (0.05 + k * 0.08), bw * 0.24, Math.max(0.5, u * 0.014));
        ctx.globalAlpha = 1;
      }
    }

    // Mullions. The window is the room's only wall.
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = tone.mid;
      ctx.fillRect(w * (0.04 + i * 0.19) + par(0.55), -1, Math.max(0.8, u * 0.024), hz + 1);
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone } = S;
    // Chair backs, then the slab.
    const ty = hz + (h - hz) * 0.28;
    for (let i = 0; i < 5; i++) {
      const cx = w * (0.1 + i * 0.2) + par(0.9);
      roundRect(ctx, cx, ty - (h - hz) * 0.34, w * 0.1, (h - hz) * 0.4, u * 0.02, tone.nearDim, tone.ink, S.ow * 0.6);
    }
    quad(ctx, w * 0.1, ty, w * 0.9, ty, w * 1.06, h + 2, w * -0.06, h + 2, tone.near, tone.ink, S.ow);
    // One gold edge, which is the whole of this theme's accent budget.
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = tone.accent;
    ctx.fillRect(w * 0.1, ty, w * 0.8, Math.max(0.6, u * 0.016));
    ctx.globalAlpha = 1;
  },
};

// ── social_feed ──────────────────────────────────────────────────────────────
// Posts, rising forever, and a heart that costs eight dollars.

const FEED: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    for (let i = 0; i < 3; i++) {
      const cw = w * 0.46;
      const ch = h * 0.17;
      const cx = w * (i % 2 === 0 ? 0.06 : 0.44) + par(0.4 + i * 0.14);
      const cy = h * (0.1 + i * 0.21) + Math.sin(S.t + i * 1.4) * h * 0.016 * S.focus;
      roundRect(ctx, cx, cy, cw, ch, u * 0.04, i === 1 ? tone.mid : tone.midDim, tone.ink, S.ow * 0.7);
      ellipse(ctx, cx + ch * 0.34, cy + ch * 0.34, ch * 0.2, ch * 0.2, 0, tone.accentSoft, NONE, 0);
      if (!S.detail) continue;
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx + ch * 0.66, cy + ch * 0.24, cw * hr(seed + i * 3, 0.3, 0.5), Math.max(0.5, u * 0.016));
      ctx.fillRect(cx + ch * 0.28, cy + ch * 0.64, cw * hr(seed + i * 5, 0.4, 0.7), Math.max(0.4, u * 0.012));
      ctx.globalAlpha = 1;
      // Verified, on the one that is lying.
      if (i === 1) {
        const bx = cx + cw - ch * 0.34;
        ellipse(ctx, bx, cy + ch * 0.3, ch * 0.16, ch * 0.16, 0, on(seed + 17, 0.1) ? tone.accent : tone.midDim, tone.ink, S.ow * 0.5);
      }
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone } = S;
    // The heart, enormous and empty.
    const hx = w * 0.78;
    const hy = hz - h * 0.02;
    const s = u * 0.3;
    ctx.beginPath();
    ctx.moveTo(hx, hy + s * 0.5);
    ctx.bezierCurveTo(hx - s, hy - s * 0.12, hx - s * 0.48, hy - s * 0.7, hx, hy - s * 0.2);
    ctx.bezierCurveTo(hx + s * 0.48, hy - s * 0.7, hx + s, hy - s * 0.12, hx, hy + s * 0.5);
    ctx.closePath();
    ctx.lineWidth = Math.max(0.8, u * 0.022);
    ctx.strokeStyle = tone.accentSoft;
    ctx.stroke();
    // The scrollbar that never reaches the bottom.
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = tone.accent;
    ctx.fillRect(w - u * 0.05, h * (0.2 + 0.16 * S.drift2), Math.max(0.8, u * 0.022), h * 0.3);
    ctx.globalAlpha = 1;
  },
};

// ── suburb ───────────────────────────────────────────────────────────────────
// Gables, a street lamp, and something in beta idling on the drive.

const SUBURB: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w * 0.08 + par(0.14), h * 0.16, w * 0.34, u * 0.036);
    ctx.fillRect(w * 0.52 + par(0.18), h * 0.26, w * 0.3, u * 0.028);
    ctx.globalAlpha = 1;

    // Hedges, far off.
    for (let i = 0; i < 7; i++) {
      ellipse(ctx, w * (i * 0.16 - 0.02) + par(0.3), hz - h * 0.02, w * 0.09, h * hr(seed + i * 9, 0.03, 0.07), 0, tone.farDim, NONE, 0);
    }

    // The street.
    const p = par(0.7);
    for (let i = 0; i < 3; i++) {
      const bw = w * 0.28;
      const x = w * (0.04 + i * 0.34) + p;
      const bh = h * hr(seed + i * 23, 0.2, 0.28);
      ctx.fillStyle = i === 1 ? tone.mid : tone.midDim;
      ctx.fillRect(x, hz - bh, bw, bh);
      tri(ctx, x - bw * 0.08, hz - bh, x + bw * 1.08, hz - bh, x + bw * 0.5, hz - bh - h * 0.11, tone.midDeep);
      if (!S.detail) continue;
      for (let k = 0; k < 2; k++) {
        const wl = on(seed + i * 13 + k, 0.4);
        lit(ctx, x + bw * (0.16 + k * 0.44), hz - bh * 0.6, bw * 0.24, bh * 0.24, tone.warm, wl ? 0.55 : 0.06);
      }
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone } = S;
    // A lamp, and the pool it puts on the road.
    const lx = w * 0.12;
    const lh = h * 0.44;
    ctx.fillStyle = tone.nearDim;
    ctx.fillRect(lx, hz - lh, Math.max(0.8, u * 0.024), lh + (h - hz) * 0.4);
    ctx.fillRect(lx - u * 0.05, hz - lh, u * 0.13, Math.max(0.8, u * 0.024));
    glow(ctx, lx + u * 0.02, hz - lh + u * 0.03, u * 0.24, tone.accent, 0.45);
    ctx.globalAlpha = 0.1;
    ellipse(ctx, lx, hz + (h - hz) * 0.5, w * 0.16, (h - hz) * 0.4, 0, tone.accent, NONE, 0);
    ctx.globalAlpha = 1;

    // Something with nobody in it.
    const cx = w * 0.68;
    const cy = hz + (h - hz) * 0.34;
    const cw = w * 0.26;
    roundRect(ctx, cx, cy - u * 0.09, cw, u * 0.09, u * 0.02, tone.nearDim, tone.ink, S.ow * 0.7);
    roundRect(ctx, cx + cw * 0.2, cy - u * 0.15, cw * 0.5, u * 0.07, u * 0.02, tone.ink, NONE, 0);
    ellipse(ctx, cx + cw * 0.22, cy, u * 0.032, u * 0.032, 0, tone.ink, NONE, 0);
    ellipse(ctx, cx + cw * 0.78, cy, u * 0.032, u * 0.032, 0, tone.ink, NONE, 0);
  },
};

// ── mine ─────────────────────────────────────────────────────────────────────
// A headframe, its wheels, and a roof held up by optimism.

const MINE: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // The roof, coming down to meet you.
    ctx.beginPath();
    ctx.moveTo(-2, -2);
    ctx.lineTo(w + 2, -2);
    for (let i = 6; i >= 0; i--) {
      ctx.lineTo(w * (i / 6) + par(0.2), h * hr(seed + i * 19, 0.1, 0.28));
    }
    ctx.closePath();
    ctx.fillStyle = tone.farDim;
    ctx.fill();

    // Headframe: a tower, a brace, and the wheel that lifts everything out.
    const cx = w * (0.36 + hr(seed + 3, -0.04, 0.06)) + par(0.6);
    const top = hz - h * 0.5;
    const hw = w * 0.09;
    quad(ctx, cx - hw, hz, cx + hw, hz, cx + hw * 0.55, top, cx - hw * 0.55, top, tone.mid, tone.ink, S.ow * 0.7);
    line(ctx, cx + hw * 0.5, top + h * 0.04, cx + hw * 2.6, hz, tone.midDim, u * 0.05);
    line(ctx, cx + hw * 1.6, top + h * 0.2, cx + hw * 2.2, hz, tone.midDim, u * 0.03);

    // Wheels. They rock rather than spin, and only when the card is looked at.
    const rot = Math.sin(S.t * 0.7) * 0.9 * S.focus;
    for (let k = 0; k < 2; k++) {
      const wr = u * (k === 0 ? 0.14 : 0.09);
      const wx = cx + (k === 0 ? 0 : hw * 1.15);
      const wy = top - (k === 0 ? wr * 0.5 : wr * 0.1);
      ellipse(ctx, wx, wy, wr, wr, 0, NONE, tone.midLit, Math.max(0.5, u * 0.014));
      for (let sp = 0; sp < 3; sp++) {
        const a = rot + sp * (Math.PI / 3);
        line(ctx, wx - Math.cos(a) * wr, wy - Math.sin(a) * wr, wx + Math.cos(a) * wr, wy + Math.sin(a) * wr, tone.midDim, u * 0.014);
      }
    }
  },
  front(ctx) {
    const { w, h, u, tone } = S;
    // A timber set on the near side, and the lamp hanging off it.
    const px0 = w * 0.78;
    const top = h * 0.14;
    ctx.fillStyle = tone.nearDim;
    ctx.fillRect(px0, top, u * 0.06, h - top);
    ctx.fillRect(w * 0.98, top, u * 0.06, h - top);
    ctx.fillRect(px0 - u * 0.03, top - u * 0.03, w * 0.24, u * 0.07);

    const sway = Math.sin(S.t * 1.3) * u * 0.05 * S.focus;
    const lx = px0 + w * 0.09 + sway;
    const ly = top + h * 0.16;
    line(ctx, px0 + w * 0.09, top, lx, ly, tone.ink, u * 0.01);
    glow(ctx, lx, ly, u * 0.2, tone.accent, 0.6);
    ellipse(ctx, lx, ly, Math.max(0.8, u * 0.02), Math.max(1, u * 0.028), 0, tone.warm, tone.ink, S.ow * 0.5);
  },
};

// ── forest ───────────────────────────────────────────────────────────────────
// Conifers at three distances, and a light coming through them.

const FOREST: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // A shaft of light, drifting.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.05 + 0.03 * S.drift2;
    quad(ctx, w * 0.3, -2, w * 0.44, -2, w * 0.2, hz, w * -0.02, hz, tone.accent);
    ctx.restore();

    // The far line.
    for (let i = 0; i < 11; i++) {
      const x = w * (i * 0.1 - 0.02) + par(0.25);
      const th = h * hr(seed + i * 7, 0.1, 0.2);
      tri(ctx, x, hz - th, x + w * 0.05, hz + 1, x - w * 0.05, hz + 1, tone.farDim);
    }

    // Three that mean it.
    for (let i = 0; i < 3; i++) {
      const x = w * (0.2 + i * 0.3) + par(0.55);
      const th = h * hr(seed + i * 29, 0.4, 0.56);
      const tw = th * 0.3;
      for (let k = 0; k < 3; k++) {
        const ky = hz - th * (k * 0.3);
        const kw = tw * (0.6 + k * 0.24);
        tri(ctx, x, ky - th * (0.52 - k * 0.12), x + kw, ky, x - kw, ky, k === 1 ? tone.mid : tone.midDim);
      }
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone, seed } = S;
    // One trunk, cropped by the frame, close enough to lean on.
    ctx.fillStyle = tone.nearDim;
    ctx.fillRect(-u * 0.02, -1, u * 0.14, h + 2);
    ctx.fillStyle = tone.ink;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(u * 0.08, -1, u * 0.04, h + 2);
    ctx.globalAlpha = 1;
    // A stump, and whatever grew back.
    ellipse(ctx, w * 0.72, hz + (h - hz) * 0.4, u * 0.09, u * 0.045, 0, tone.nearDim, tone.ink, S.ow * 0.6);
    for (let k = 0; k < 3; k++) {
      const fx = w * (0.42 + k * 0.08);
      capsule(ctx, fx, hz + (h - hz) * 0.35, fx + hr(seed + k, -u * 0.05, u * 0.05), hz - u * 0.09, Math.max(0.5, u * 0.012), tone.near, NONE, 0);
    }
  },
};

// ── gigafactory ──────────────────────────────────────────────────────────────
// A roof with no end, an arm that never tires, and a cage between you and it.

const GIGAFACTORY: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    // Roof trusses running off to a vanishing point somebody else owns.
    const ry = h * 0.2;
    ctx.fillStyle = tone.farDim;
    ctx.fillRect(-1, -1, w + 2, ry);
    for (let i = 0; i < 6; i++) {
      const x = w * (i * 0.18 - 0.04) + par(0.2);
      line(ctx, x, ry * 0.4, x + w * 0.09, ry, tone.far, u * 0.018);
      line(ctx, x + w * 0.18, ry * 0.4, x + w * 0.09, ry, tone.far, u * 0.018);
      lit(ctx, x + w * 0.05, ry, w * 0.08, Math.max(0.6, u * 0.016), '#fff4cf', 0.35);
    }

    // The line, and the shells crawling along it.
    const beltY = hz - h * 0.08;
    ctx.fillStyle = tone.midDim;
    ctx.fillRect(-1, beltY, w + 2, h * 0.05);
    for (let i = -1; i < 4; i++) {
      const x = w * (i * 0.34 + 0.05) + par(0.9);
      roundRect(ctx, x, beltY - h * 0.11, w * 0.24, h * 0.11, u * 0.03, tone.accentDeep, tone.ink, S.ow * 0.7);
      roundRect(ctx, x + w * 0.05, beltY - h * 0.17, w * 0.14, h * 0.07, u * 0.025, tone.accentDeeper, tone.ink, S.ow * 0.6);
    }

    // The arm.
    const ax = w * 0.72 + par(0.7);
    const ay = beltY - h * 0.2;
    const swing = Math.sin(S.t * 1.1) * 0.32 * S.focus;
    ctx.fillStyle = tone.mid;
    ctx.fillRect(ax - u * 0.05, ay, u * 0.1, h * 0.2);
    const e1x = ax + Math.cos(-2.2 + swing) * u * 0.26;
    const e1y = ay + Math.sin(-2.2 + swing) * u * 0.26;
    const e2x = e1x + Math.cos(-0.5 - swing) * u * 0.2;
    const e2y = e1y + Math.sin(-0.5 - swing) * u * 0.2;
    capsule(ctx, ax, ay, e1x, e1y, Math.max(1, u * 0.032), tone.midLit, tone.ink, S.ow * 0.7);
    capsule(ctx, e1x, e1y, e2x, e2y, Math.max(0.8, u * 0.024), tone.mid, tone.ink, S.ow * 0.6);
    if (on(seed + 5, 0.6)) {
      star(ctx, e2x, e2y, u * 0.06, 4, '#dff0ff', NONE);
      glow(ctx, e2x, e2y, u * 0.16, '#9fd8ff', 0.6);
    }
  },
  front(ctx) {
    const { w, h, hz, u, tone } = S;
    // The cage. It is the only thing here that is for you.
    const top = hz - h * 0.16;
    ctx.strokeStyle = tone.accentMid;
    ctx.lineWidth = Math.max(0.6, u * 0.018);
    for (let i = 0; i < 5; i++) {
      const x = w * (0.04 + i * 0.11);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(w * 0.02, top);
    ctx.lineTo(w * 0.5, top);
    ctx.stroke();
  },
};

// ── orbit ────────────────────────────────────────────────────────────────────
// A module, its wings, and the curve of somewhere you used to live.

const ORBIT: ThemeArt = {
  back(ctx) {
    const { w, h, hz, u, tone, seed } = S;

    for (let i = 0; i < 18; i++) {
      const sx = w * hash(seed + i * 3);
      const sy = hz * hash(seed + i * 7 + 1);
      ctx.globalAlpha = clamp(hr(seed + i * 11, 0.25, 0.9) * (on(seed + i, 0.25) ? 1 : 0.35), 0, 1);
      ctx.fillStyle = '#eaf2ff';
      ctx.fillRect(sx, sy, Math.max(0.5, u * 0.012), Math.max(0.5, u * 0.012));
    }
    ctx.globalAlpha = 1;

    // The limb of a planet, cropped by the frame the way it is by a window.
    const pr = h * 0.9;
    const pcx = w * 1.1;
    const pcy = -h * 0.35;
    ctx.beginPath();
    ctx.arc(pcx, pcy, pr, 0, TAU);
    ctx.fillStyle = tone.farDim;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pcx, pcy, pr, 0, TAU);
    ctx.lineWidth = Math.max(0.8, u * 0.02);
    ctx.strokeStyle = tone.accentSoft;
    ctx.stroke();

    // The module.
    const mx = w * 0.1 + par(0.6);
    const my = hz - h * 0.34;
    const mw = w * 0.44;
    const mh = h * 0.16;
    roundRect(ctx, mx, my, mw, mh, mh * 0.5, tone.mid, tone.ink, S.ow * 0.8);
    ctx.fillStyle = tone.midDim;
    ctx.fillRect(mx + mw * 0.12, my + mh * 0.3, mw * 0.76, Math.max(0.6, u * 0.018));
    for (let k = 0; k < 3; k++) {
      const px1 = mx + mw * (0.24 + k * 0.24);
      ellipse(ctx, px1, my + mh * 0.66, Math.max(0.8, u * 0.024), Math.max(0.8, u * 0.024), 0, tone.ink, NONE, 0);
      if (on(seed + k * 23, 0.4)) lit(ctx, px1 - u * 0.014, my + mh * 0.66 - u * 0.014, u * 0.028, u * 0.028, tone.accent, 0.6);
    }
    // Wings, tracking a sun that is not where you think it is.
    const tilt = Math.sin(S.t * 0.5) * 0.14 * S.focus;
    for (let d = -1; d <= 1; d += 2) {
      const wx = mx + mw * 0.5 + d * mw * 0.78;
      const wy = my + mh * 0.5;
      const ww = mw * 0.5;
      const wh2 = mh * 0.7 + tilt * mh * d * 2;
      quad(ctx, wx - ww * 0.5, wy - wh2 * 0.5, wx + ww * 0.5, wy - wh2 * 0.5 + tilt * mh, wx + ww * 0.5, wy + wh2 * 0.5 + tilt * mh, wx - ww * 0.5, wy + wh2 * 0.5, '#26406b', tone.ink, S.ow * 0.6);
    }
  },
  front(ctx) {
    const { w, h, u, tone } = S;
    // A truss across the corner, close and unlit.
    ctx.save();
    ctx.globalAlpha = 0.95;
    quad(ctx, -2, h * 0.72, w * 0.34, h + 2, w * 0.16, h + 2, -2, h * 0.86, tone.ink);
    ctx.restore();
    lit(ctx, w * 0.06, h * 0.8, Math.max(0.8, u * 0.02), Math.max(0.8, u * 0.02), tone.accent, 0.5);
  },
};

const THEME_ART: Record<MapTheme, ThemeArt> = {
  tunnel: TUNNEL,
  factory: FACTORY,
  server_farm: SERVER,
  launchpad: LAUNCHPAD,
  mars_dome: MARS,
  boardroom: BOARDROOM,
  social_feed: FEED,
  suburb: SUBURB,
  mine: MINE,
  forest: FOREST,
  gigafactory: GIGAFACTORY,
  orbit: ORBIT,
};

// ─────────────────────────────────────────────────────────────────────────────
// The boss
//
// A shape, not a portrait. `rigOverride` picks the family and nothing else about
// the boss reaches the poster: no palette, no proportions, no face. It has to
// say "something is waiting at the end of this one" and stop there.
// ─────────────────────────────────────────────────────────────────────────────

function drawBoss(ctx: C2D, boss: BossDef): void {
  const { w, h, hz, u, tone, focus } = S;
  const rig = boss.rigOverride ?? 'humanoid';
  const bob = Math.sin(S.t * 0.8) * h * 0.012 * focus;
  const base = hz + (h - hz) * 0.18 + bob;
  const cx = w * 0.7;
  const ink = tone.ink;
  const rim = tone.rim;
  const ow = S.ow;

  // Backlight, so a black shape survives on a black palette.
  glow(ctx, cx, base - h * 0.24, u * 0.55, tone.accent, 0.12 + 0.1 * focus);
  ctx.globalAlpha = 0.4;
  ellipse(ctx, cx, base, u * 0.3, u * 0.05, 0, '#000000', NONE, 0);
  ctx.globalAlpha = 1;

  let eyeX = cx;
  let eyeY = base;
  let eyeGap = u * 0.05;

  switch (rig) {
    case 'shiba': {
      // Low, long, and already closer than it was.
      const bh = h * 0.3;
      const bl = w * 0.44;
      const y = base - bh * 0.62;
      for (let i = 0; i < 4; i++) {
        const lx = cx - bl * 0.34 + (i % 2) * bl * 0.56 + (i > 1 ? bl * 0.08 : 0);
        capsule(ctx, lx, y + bh * 0.2, lx + (i > 1 ? u * 0.02 : -u * 0.02), base, u * 0.035, ink, NONE, 0);
      }
      capsule(ctx, cx - bl * 0.4, y, cx + bl * 0.34, y - bh * 0.06, bh * 0.42, ink, rim, ow * 0.5);
      // Head, wedge-first.
      const hx = cx - bl * 0.5;
      const hy = y - bh * 0.34;
      ellipse(ctx, hx, hy, bh * 0.34, bh * 0.3, -0.2, ink, rim, ow * 0.5);
      tri(ctx, hx - bh * 0.34, hy + bh * 0.04, hx - bh * 0.72, hy + bh * 0.18, hx - bh * 0.3, hy + bh * 0.26, ink);
      tri(ctx, hx - bh * 0.1, hy - bh * 0.22, hx - bh * 0.02, hy - bh * 0.62, hx + bh * 0.16, hy - bh * 0.18, ink);
      tri(ctx, hx + bh * 0.14, hy - bh * 0.24, hx + bh * 0.32, hy - bh * 0.6, hx + bh * 0.4, hy - bh * 0.16, ink);
      // Tail, curled over the back.
      capsule(ctx, cx + bl * 0.3, y - bh * 0.1, cx + bl * 0.46, y - bh * 0.7, u * 0.04, ink, NONE, 0);
      eyeX = hx - bh * 0.1;
      eyeY = hy - bh * 0.02;
      eyeGap = bh * 0.2;
      break;
    }

    case 'cybertruck': {
      // An angular wedge that has never once been indicated.
      const bw = w * 0.5;
      const bh = h * 0.3;
      const x0 = cx - bw * 0.5;
      const y0 = base - bh;
      ctx.beginPath();
      ctx.moveTo(x0, base - bh * 0.12);
      ctx.lineTo(x0 + bw * 0.06, base - bh * 0.46);
      ctx.lineTo(x0 + bw * 0.52, y0);
      ctx.lineTo(x0 + bw, base - bh * 0.34);
      ctx.lineTo(x0 + bw, base - bh * 0.06);
      ctx.closePath();
      paint(ctx, ink, rim, ow * 0.6);
      for (let i = 0; i < 2; i++) {
        const wx = x0 + bw * (0.22 + i * 0.54);
        ellipse(ctx, wx, base - bh * 0.06, u * 0.075, u * 0.075, 0, ink, rim, ow * 0.5);
      }
      // A light bar, which is the only part of it that works.
      lit(ctx, x0 + bw * 0.06, base - bh * 0.44, bw * 0.42, Math.max(0.8, u * 0.02), tone.accent, 0.6);
      eyeX = x0 + bw * 0.14;
      eyeY = base - bh * 0.3;
      eyeGap = bw * 0.1;
      break;
    }

    case 'rocket': {
      // Tall enough that the frame cannot hold all of it.
      const bh = h * 0.78;
      const bw = u * 0.22;
      const top = base - bh;
      quad(ctx, cx - bw * 0.5, base, cx + bw * 0.5, base, cx + bw * 0.34, top + bh * 0.16, cx - bw * 0.34, top + bh * 0.16, ink, rim, ow * 0.6);
      tri(ctx, cx, top, cx + bw * 0.34, top + bh * 0.2, cx - bw * 0.34, top + bh * 0.2, ink, rim, ow * 0.5);
      tri(ctx, cx - bw * 0.5, base - bh * 0.24, cx - bw * 1.25, base, cx - bw * 0.5, base, ink, NONE, 0);
      tri(ctx, cx + bw * 0.5, base - bh * 0.24, cx + bw * 1.25, base, cx + bw * 0.5, base, ink, NONE, 0);
      glow(ctx, cx, base + u * 0.02, u * 0.2, tone.accent, 0.4 + 0.2 * focus);
      eyeX = cx;
      eyeY = top + bh * 0.3;
      eyeGap = bw * 0.22;
      break;
    }

    default: {
      // Broad humanoid. `robot_giant` is the same silhouette, wider and squarer,
      // because at a thumbnail the difference between a man and a machine is
      // shoulders — and it should stay that vague.
      const heavy = rig === 'robot_giant';
      const bh = h * (heavy ? 0.7 : 0.62);
      const top = base - bh;
      const sw = bh * (heavy ? 0.56 : 0.44);
      const hipY = base - bh * 0.42;
      const shY = top + bh * 0.24;

      capsule(ctx, cx - sw * 0.28, hipY, cx - sw * 0.32, base, bh * 0.1, ink, NONE, 0);
      capsule(ctx, cx + sw * 0.28, hipY, cx + sw * 0.32, base, bh * 0.1, ink, NONE, 0);
      quad(ctx, cx - sw * 0.34, hipY, cx + sw * 0.34, hipY, cx + sw * 0.5, shY, cx - sw * 0.5, shY, ink, rim, ow * 0.6);
      capsule(ctx, cx - sw * 0.46, shY + bh * 0.04, cx - sw * (heavy ? 0.66 : 0.58), hipY + bh * 0.1, bh * 0.09, ink, NONE, 0);
      capsule(ctx, cx + sw * 0.46, shY + bh * 0.04, cx + sw * (heavy ? 0.66 : 0.58), hipY + bh * 0.1, bh * 0.09, ink, NONE, 0);
      if (heavy) {
        roundRect(ctx, cx - bh * 0.11, top, bh * 0.22, bh * 0.2, bh * 0.05, ink, rim, ow * 0.5);
      } else {
        ellipse(ctx, cx, top + bh * 0.12, bh * 0.13, bh * 0.14, 0, ink, rim, ow * 0.5);
      }
      eyeX = cx;
      eyeY = top + bh * (heavy ? 0.1 : 0.11);
      eyeGap = bh * 0.07;
      break;
    }
  }

  // Two lights where a face would be. That is as much as anyone gets.
  const er = Math.max(0.7, u * 0.018);
  for (let d = -1; d <= 1; d += 2) {
    glow(ctx, eyeX + d * eyeGap, eyeY, u * 0.07, tone.accent, 0.75);
    ellipse(ctx, eyeX + d * eyeGap, eyeY, er, er, 0, tone.stamp, NONE, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small per-map tells
//
// Two maps of one theme share a composition, so the things that differ — the
// props on the floor and whether the map has something with an engine on it —
// are worth a silhouette each. Tiny, dark, and dropped on small thumbnails.
// ─────────────────────────────────────────────────────────────────────────────

function drawProps(ctx: C2D, map: MapDef): void {
  const props = map.props;
  if (!props || props.length === 0) return;
  const { w, h, hz, u, tone } = S;
  const y = hz + (h - hz) * 0.46;
  const n = Math.min(3, props.length);
  const s = u * 0.09;

  for (let i = 0; i < n; i++) {
    const kind = props[(i * 2 + 1) % props.length].kind;
    const x = w * (0.08 + hr(S.seed + i * 37, 0, 0.34) + i * 0.2);
    switch (kind) {
      case 'barrel':
        roundRect(ctx, x, y - s, s * 0.7, s, s * 0.16, tone.nearDim, tone.ink, S.ow * 0.5);
        break;
      case 'crate':
        roundRect(ctx, x, y - s * 0.85, s * 0.85, s * 0.85, s * 0.08, tone.nearDim, tone.ink, S.ow * 0.5);
        line(ctx, x, y - s * 0.85, x + s * 0.85, y, tone.ink, u * 0.008);
        break;
      case 'vending':
        roundRect(ctx, x, y - s * 1.3, s * 0.7, s * 1.3, s * 0.1, tone.nearDim, tone.ink, S.ow * 0.5);
        lit(ctx, x + s * 0.14, y - s * 1.1, s * 0.42, s * 0.6, tone.accent, 0.35);
        break;
      case 'server_rack':
        roundRect(ctx, x, y - s * 1.4, s * 0.6, s * 1.4, s * 0.06, tone.nearDim, tone.ink, S.ow * 0.5);
        lit(ctx, x + s * 0.14, y - s * 1.1, s * 0.14, s * 0.14, '#63ff9d', 0.6);
        break;
      case 'scooter':
        ellipse(ctx, x, y, s * 0.2, s * 0.2, 0, tone.nearDim, tone.ink, S.ow * 0.4);
        ellipse(ctx, x + s * 0.8, y, s * 0.2, s * 0.2, 0, tone.nearDim, tone.ink, S.ow * 0.4);
        line(ctx, x, y - s * 0.1, x + s * 0.8, y - s * 0.1, tone.nearDim, u * 0.012);
        line(ctx, x + s * 0.8, y - s * 0.1, x + s * 0.7, y - s * 0.9, tone.nearDim, u * 0.012);
        break;
      default:
        // sign
        line(ctx, x + s * 0.3, y, x + s * 0.3, y - s * 1.1, tone.nearDim, u * 0.014);
        roundRect(ctx, x - s * 0.1, y - s * 1.5, s * 0.8, s * 0.45, s * 0.06, tone.nearDim, tone.ink, S.ow * 0.5);
        break;
    }
  }
}

function drawVehicleMark(ctx: C2D, map: MapDef): void {
  const v = map.vehicle;
  if (!v) return;
  const { w, h, hz, u, tone } = S;
  const y = hz + (h - hz) * 0.76;
  const x = w * 0.06;
  const s = u * 0.16;

  switch (v.kind) {
    case 'moto':
      ellipse(ctx, x, y, s * 0.24, s * 0.24, 0, tone.ink, tone.rim, S.ow * 0.4);
      ellipse(ctx, x + s, y, s * 0.24, s * 0.24, 0, tone.ink, tone.rim, S.ow * 0.4);
      line(ctx, x, y - s * 0.1, x + s * 0.55, y - s * 0.42, tone.ink, u * 0.022);
      line(ctx, x + s * 0.55, y - s * 0.42, x + s, y - s * 0.1, tone.ink, u * 0.022);
      break;
    case 'cybertruck':
      ctx.beginPath();
      ctx.moveTo(x - s * 0.1, y);
      ctx.lineTo(x + s * 0.16, y - s * 0.3);
      ctx.lineTo(x + s * 0.72, y - s * 0.52);
      ctx.lineTo(x + s * 1.1, y - s * 0.2);
      ctx.lineTo(x + s * 1.1, y);
      ctx.closePath();
      paint(ctx, tone.ink, tone.rim, S.ow * 0.5);
      break;
    case 'hyperloop_pod':
      roundRect(ctx, x, y - s * 0.42, s * 1.2, s * 0.42, s * 0.21, tone.ink, tone.rim, S.ow * 0.5);
      lit(ctx, x + s * 1.05, y - s * 0.3, s * 0.12, s * 0.12, tone.accent, 0.6);
      break;
    default:
      // rocket
      quad(ctx, x + s * 0.3, y, x + s * 0.62, y, x + s * 0.56, y - s * 0.7, x + s * 0.36, y - s * 0.7, tone.ink, tone.rim, S.ow * 0.5);
      tri(ctx, x + s * 0.46, y - s * 1.0, x + s * 0.6, y - s * 0.66, x + s * 0.32, y - s * 0.66, tone.ink, tone.rim, S.ow * 0.4);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Locked
//
// No theme, no palette, no shape from the map at all. A plate with the lights
// off, which is exactly how much an unplayed map is entitled to give away.
// ─────────────────────────────────────────────────────────────────────────────

function drawLocked(ctx: C2D, w: number, h: number, frame: number, focus: number): void {
  const u = Math.min(w, h);

  ctx.fillStyle = N_SURFACE;
  ctx.fillRect(-1, -1, w + 2, h + 2);

  // A hatch, faint enough to be texture rather than pattern.
  ctx.strokeStyle = N_HATCH;
  ctx.lineWidth = Math.max(0.6, u * 0.014);
  const step = Math.max(4, u * 0.16);
  for (let x = -h; x < w + h; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.stroke();
  }

  // The blanked plate.
  const pw = w * 0.56;
  const ph = h * 0.5;
  roundRect(ctx, (w - pw) * 0.5, (h - ph) * 0.5, pw, ph, u * 0.05, N_PLATE, N_OUTLINE, Math.max(0.4, u * 0.008));

  // A question mark, in geometry rather than type, so it is exact at any size.
  const r = u * 0.1;
  const cx = w * 0.5;
  const cy = h * 0.5 - r * 0.5;
  const lw = Math.max(1, r * 0.4);
  ctx.strokeStyle = focus > 0.02 ? N_DIM : N_FAINT;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI * 2.25);
  ctx.quadraticCurveTo(cx + r * 0.62, cy + r * 1.24, cx, cy + r * 1.62);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 2.3);
  ctx.lineTo(cx, cy + r * 2.32);
  ctx.stroke();

  // Bottom edge shadow, so the plate has a floor to sit on.
  ctx.fillStyle = N_DEEP;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(-1, h - u * 0.1, w + 2, u * 0.1 + 1);
  ctx.globalAlpha = 1;

  // The only life a locked card gets: a slow breath on the plate when selected.
  if (focus > 0.02) {
    ctx.globalAlpha = 0.05 * focus * (0.6 + 0.4 * Math.sin(frame * 0.03));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((w - pw) * 0.5, (h - ph) * 0.5, pw, ph);
    ctx.globalAlpha = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleared
// ─────────────────────────────────────────────────────────────────────────────

function drawStamp(ctx: C2D): void {
  const { w, h, u, tone } = S;
  const r = u * 0.13;
  if (r < 3) return;
  const cx = w - r - u * 0.11;
  const cy = h - r - u * 0.11;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.17);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = tone.stamp;

  ctx.globalAlpha = 0.28;
  ctx.lineWidth = Math.max(0.5, r * 0.1);
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.24, 0, TAU);
  ctx.stroke();

  ctx.globalAlpha = 0.92;
  ctx.lineWidth = Math.max(0.8, r * 0.16);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();

  ctx.lineWidth = Math.max(1, r * 0.24);
  ctx.beginPath();
  ctx.moveTo(-r * 0.44, 0);
  ctx.lineTo(-r * 0.1, r * 0.38);
  ctx.lineTo(r * 0.46, -r * 0.4);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw one map's cover into `x, y, w, h` of the current transform.
 *
 * Reads only the map and the options — no camera, no save file, no globals — so
 * the same call works for a 90x60 thumbnail on a wall of seventy and for a
 * large preview panel beside it. Every dimension is derived from `w`/`h`.
 */
export function drawMapCover(
  ctx: CanvasRenderingContext2D,
  map: MapDef,
  x: number,
  y: number,
  w: number,
  h: number,
  opts?: {
    /** false = never visited: draw the locked treatment instead. */
    unlocked?: boolean;
    /** true once the map has been cleared; may show a little more. */
    cleared?: boolean;
    /** Frame counter for subtle motion on the highlighted card. */
    frame?: number;
    /** 0..1, how much the card is highlighted. Drives parallax and glow. */
    focus?: number;
  },
): void {
  if (!(w > 1) || !(h > 1)) return;

  const unlocked = opts?.unlocked !== false;
  const cleared = opts?.cleared === true;
  const frame = opts?.frame ?? 0;
  const focus = clamp(opts?.focus ?? 0, 0, 1);
  const u = Math.min(w, h);
  const rad = u * 0.075;

  ctx.save();
  ctx.translate(x, y);
  rrPath(ctx, 0, 0, w, h, rad);
  ctx.clip();

  if (!unlocked) {
    drawLocked(ctx, w, h, frame, focus);
    drawRim(ctx, w, h, rad, u, focus, N_OUTLINE, N_DIM);
    ctx.restore();
    return;
  }

  const tone = toneFor(map.palette);
  const hz = Math.round(h * 0.7);

  S.w = w;
  S.h = h;
  S.hz = hz;
  S.u = u;
  S.ow = clamp(u * 0.012, 0.35, 2);
  S.frame = frame;
  S.focus = focus;
  S.t = frame * 0.013;
  S.drift = Math.sin(frame * 0.013) * focus;
  S.drift2 = Math.sin(frame * 0.0071 + 1.1) * focus;
  S.blink = focus > 0.02 ? (frame / 9) | 0 : 0;
  S.seed = map.index * 2654435761;
  S.detail = u >= 40;
  S.tone = tone;

  ensureGradients(ctx, tone, w, h, hz, h * 0.24);

  const art = THEME_ART[map.theme];
  drawSky(ctx);
  art.back(ctx);
  drawFog(ctx);
  drawGround(ctx);

  const boss = map.boss ? BOSS_BY_ID.get(map.boss) : undefined;
  if (boss) drawBoss(ctx, boss);

  art.front(ctx);
  if (S.detail) {
    drawProps(ctx, map);
    drawVehicleMark(ctx, map);
  }

  drawSheen(ctx);

  // Cleared covers are simply lit better than the ones still owed. Both washes
  // are single flat fills, which is what makes the difference read across a
  // whole wall at once instead of card by card.
  ctx.fillStyle = cleared ? tone.clearWash : tone.dullWash;
  ctx.fillRect(-1, -1, w + 2, h + 2);
  if (cleared) drawStamp(ctx);

  // Vignette: three strokes of the card's own outline, clipped to their inner
  // halves. No gradient, no allocation, and it darkens the corners exactly.
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = tone.ink;
  for (let i = 3; i > 0; i--) {
    rrPath(ctx, 0, 0, w, h, rad);
    ctx.lineWidth = u * 0.09 * i;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  drawRim(ctx, w, h, rad, u, focus, tone.inkSoft, tone.accent);
  ctx.restore();
}

/** The card's edge: a dull hairline, then the highlight faded in over it. */
function drawRim(
  ctx: C2D,
  w: number,
  h: number,
  rad: number,
  u: number,
  focus: number,
  dull: string,
  hot: string,
): void {
  const lw = Math.max(0.8, u * 0.014);
  rrPath(ctx, lw * 0.5, lw * 0.5, w - lw, h - lw, rad);
  ctx.lineWidth = lw;
  ctx.strokeStyle = dull;
  ctx.stroke();
  if (focus <= 0.02) return;
  ctx.globalAlpha = clamp(focus, 0, 1) * 0.85;
  ctx.strokeStyle = hot;
  ctx.lineWidth = lw * 1.6;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
