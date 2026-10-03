/**
 * Procedural scenery.
 *
 * Nothing here is an asset. Every map is built at draw time from its
 * `MapPalette` plus its `MapTheme`, in four parallax bands (sky, far, mid,
 * near) plus the ground plane, with a foreground pass that draws the stuff the
 * camera is practically standing in. Over all of that goes the set dressing —
 * lamps and the light they throw, what the floor is made of, the air — which
 * is one table (`DRESSING`) rather than twelve more switch statements.
 *
 * These run in SCREEN SPACE — call them OUTSIDE `Renderer.withCamera` and hand
 * them the camera so each band can scroll at its own rate against `cam.x`.
 * Layout is stable (hashed off the tile index, never off the frame) and only
 * the animated flourishes — neon flicker, smoke, traffic, server LEDs, rain,
 * sparks — read the frame counter.
 *
 * This is presentation code: it never touches the sim and never needs the Rng.
 */

import type { MapDef, MapPalette, MapTheme } from '@/core/types';
import type { Camera } from '@/render/Camera';
import { GROUND_Y, VIEW_H, VIEW_W, Z_DEPTH, Z_SCALE } from '@/core/constants';
import { TAU, clamp, lerp } from '@/core/math';
import { capsule, ellipse, poly, roundRect, star } from '@/render/Shapes';

import { FONT_DISPLAY } from '@/ui/theme';
type C2D = CanvasRenderingContext2D;

/** The z=0 line, and where the walkable band ends at z = Z_DEPTH. */
const FLOOR_TOP = GROUND_Y;
const FLOOR_BOTTOM = GROUND_Y + Z_DEPTH * Z_SCALE;

const PAR_FAR = 0.12;
const PAR_MID = 0.34;
const PAR_NEAR = 0.62;
const PAR_FORE = 1.42;

const INK = '#141019';

// ── Depth balance ────────────────────────────────────────────────────────────
//
// The fight happens in a narrow band around the floor line, and the characters
// are deliberately dark. Everything below exists to make that band the brightest,
// calmest, most legible thing on screen without redrawing a single prop.

/**
 * Atmospheric perspective. Each band is washed toward the map's fog once it has
 * been drawn, so the far band eats both its own wash and the mid one and loses
 * contrast twice over. Purely compositional — no theme needs to know about it.
 */
const WASH_FAR_BASE = 0.24;
const WASH_FAR_FOG = 0.18;
const WASH_MID_BASE = 0.13;
const WASH_MID_FOG = 0.13;

/** Fog rising off the floor line, drawn between the mid and near bands. */
const HAZE_H = 116;
const HAZE_BASE = 0.08;
const HAZE_FOG = 0.12;

/** The quiet field painted behind the fight, above the walkable band. */
const SCRIM_H = 118;
const SCRIM_PEAK = 0.3;

/** Corner falloff. Weak by design: the HUD is composited over the top of it. */
const VIGNETTE_INNER = 0.34;
const VIGNETTE_OUTER = 0.6;
const VIGNETTE_MAX = 0.4;

/** Screen units of slack around the view, so nothing pops in at an edge. */
const OVERSCAN = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Visible area
//
// The backdrop is authored at VIEW_W x VIEW_H but painted under the fight zoom,
// so only a crop of it is ever on screen. Reading the crop back off the live
// transform keeps full-bleed fills, tiled bands and the vignette correct at any
// zoom without any of them having to know what the camera is doing.
// ─────────────────────────────────────────────────────────────────────────────

let viewX = 0;
let viewY = 0;
let viewW = VIEW_W;
let viewH = VIEW_H;
/** The horizontal run every full-width fill and every tiled band must cover. */
let spanX = 0;
let spanW = VIEW_W;
let spanTop = 0;
let spanBottom = VIEW_H;
/** Scenery-per-screen correction, so weather does not thin out when zoomed in. */
let spanDensity = 1;

function syncViewport(ctx: C2D, cam: Camera): void {
  const zoom = cam.zoom > 0.05 ? cam.zoom : 1;
  viewW = VIEW_W / zoom;
  viewH = VIEW_H / zoom;

  // Under the screen-space transform the view origin is whatever undoes the
  // remaining translation; anything we cannot make sense of falls back to a
  // centred crop rather than dragging the backdrop off screen.
  const m = ctx.getTransform();
  const ox = m.a !== 0 ? -m.e / m.a : 0;
  const oy = m.d !== 0 ? -m.f / m.d : 0;
  viewX = Number.isFinite(ox) && Math.abs(ox) <= VIEW_W ? ox : (VIEW_W - viewW) * 0.5;
  viewY = Number.isFinite(oy) && Math.abs(oy) <= VIEW_H ? oy : (VIEW_H - viewH) * 0.5;

  spanX = Math.min(0, viewX) - OVERSCAN;
  spanW = Math.max(VIEW_W, viewX + viewW) + OVERSCAN - spanX;
  spanTop = Math.min(0, viewY) - OVERSCAN;
  spanBottom = Math.max(VIEW_H, viewY + viewH) + OVERSCAN;
  spanDensity = clamp((spanW * (spanBottom - spanTop)) / (viewW * viewH), 1, 3);
}

/** Fill the full visible width at a given screen y, with overscan either side. */
function fillSpan(ctx: C2D, y: number, h: number): void {
  ctx.fillRect(spanX, y, spanW, h);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Stable hash → 0..1. Layout must not change frame to frame, so this is pure. */
function hash(n: number): number {
  let h = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 8) / 0x1000000;
}

function hrange(n: number, a: number, b: number): number {
  return a + hash(n) * (b - a);
}

/**
 * `#rgb`, `#rrggbb`, `rgb(...)` and `rgba(...)` all parse. The rgba form matters:
 * every palette states its fog that way, and without it `withAlpha(fog, 0)` used
 * to hand back an opaque fog and flatten the whole mid band into a grey slab.
 */
function parseRgb(color: string): [number, number, number] | null {
  const k = color.charCodeAt(0);
  if (k === 35 /* # */) {
    const s = color.slice(1);
    if (s.length === 3) {
      const r = parseInt(s[0] + s[0], 16);
      const g = parseInt(s[1] + s[1], 16);
      const b = parseInt(s[2] + s[2], 16);
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    if (s.length >= 6) {
      const r = parseInt(s.slice(0, 2), 16);
      const g = parseInt(s.slice(2, 4), 16);
      const b = parseInt(s.slice(4, 6), 16);
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    return null;
  }
  if (k === 114 /* r */) {
    const open = color.indexOf('(');
    if (open < 0) return null;
    const parts = color.slice(open + 1, color.lastIndexOf(')')).split(',');
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    return Number.isNaN(r + g + b) ? null : [Math.round(r), Math.round(g), Math.round(b)];
  }
  return null;
}

/** The alpha a colour carries in its own notation. Palettes use it as fog density. */
function alphaOf(color: string): number {
  if (color.charCodeAt(0) !== 114) return 1;
  const open = color.indexOf('(');
  if (open < 0) return 1;
  const parts = color.slice(open + 1, color.lastIndexOf(')')).split(',');
  if (parts.length < 4) return 1;
  const a = parseFloat(parts[3]);
  return Number.isNaN(a) ? 1 : clamp(a, 0, 1);
}

/** Rec.709 relative luminance, 0..255. The basis of every contrast decision here. */
function luma(color: string): number {
  const c = parseRgb(color);
  if (!c) return 0;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Same colour at a given alpha. Unparseable input is passed straight through. */
function withAlpha(color: string, a: number): string {
  const c = parseRgb(color);
  if (!c) return color;
  return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
}

/** k < 1 darkens, k > 1 lightens. Keeps a palette coherent across bands. */
function shade(color: string, k: number): string {
  const c = parseRgb(color);
  if (!c) return color;
  const f = (v: number): number => clamp(Math.round(v * k), 0, 255);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

/** Blend two colours; used to sit a layer between palette entries. */
function mix(a: string, b: string, t: number): string {
  const ca = parseRgb(a);
  const cb = parseRgb(b);
  if (!ca || !cb) return a;
  return `rgb(${Math.round(lerp(ca[0], cb[0], t))},${Math.round(
    lerp(ca[1], cb[1], t),
  )},${Math.round(lerp(ca[2], cb[2], t))})`;
}

/** Pulls a colour toward its own grey. Distance costs saturation, not just contrast. */
function desat(color: string, amount: number): string {
  const c = parseRgb(color);
  if (!c) return color;
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return `rgb(${Math.round(lerp(c[0], l, amount))},${Math.round(
    lerp(c[1], l, amount),
  )},${Math.round(lerp(c[2], l, amount))})`;
}

/**
 * Rescales a colour to a target luminance, keeping its hue. This is how the
 * floor gets a guaranteed step of brightness over the walls on all twelve
 * themes without a single hand-picked colour.
 */
function toneTo(color: string, targetL: number): string {
  const c = parseRgb(color);
  if (!c) return color;
  const t = clamp(targetL, 0, 255);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (l < 1) {
    const v = Math.round(t);
    return `rgb(${v},${v},${v})`;
  }
  const k = t / l;
  const f = (v: number): number => clamp(Math.round(v * k), 0, 255);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Depth tones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the depth rebalance needs, derived once per map from its palette.
 * Held in a one-entry memo: a fight only ever draws one palette, and both entry
 * points want the same numbers, so this costs one hit per frame and allocates
 * nothing while a map is running.
 */
interface Tone {
  palette: MapPalette;
  farWash: string;
  farWashA: number;
  midWash: string;
  midWashA: number;
  hazeTop: string;
  hazeBottom: string;
  scrimTop: string;
  scrimMid: string;
  scrimBottom: string;
  floorSeat: string;
  floorRise: string;
  floorPeak: string;
  floorBand: string;
  floorFront: string;
  floorKerb: string;
  vigInner: string;
  vigKnee: string;
  vigOuter: string;
}

let toneCache: Tone | null = null;

function toneFor(p: MapPalette): Tone {
  const cached = toneCache;
  if (cached && cached.palette === p) return cached;

  const fogL = luma(p.fog);
  const farL = luma(p.far);
  const midL = luma(p.mid);
  const groundL = luma(p.ground);
  const wallL = Math.max(midL, luma(p.near));

  // Each palette states its fog with an alpha, and that alpha is exactly how
  // thick the map wants its air to be. Driving the whole band off it keeps the
  // dense maps (mine, orbit) hazy and the thin ones (suburb, mars) crisp.
  const density = clamp((alphaOf(p.fog) - 0.4) / 0.22, 0, 1);

  // Wash targets sit *between* the fog and the band they cover, so distance
  // flattens contrast instead of simply crushing everything to black.
  const farWash = toneTo(desat(p.fog, 0.45), lerp(fogL, farL, 0.38));
  const midWash = toneTo(desat(p.fog, 0.32), lerp(fogL, midL, 0.44));

  // The floor has to out-read the walls it is seen against, whatever the theme.
  // Take the wall luminance the player will actually see (post-wash), step above
  // it, then keep the lift inside sane multiples of the palette's own ground.
  const dampedWallL = lerp(wallL, fogL, 0.42);
  const floorL = clamp(
    clamp(dampedWallL + 22, groundL * 1.25, groundL * 2.2),
    30,
    Math.max(128, groundL * 1.15),
  );

  const hazeL = lerp(fogL, wallL, 0.3);
  const hazeColor = toneTo(desat(p.fog, 0.3), hazeL);
  const scrimColor = toneTo(desat(p.fog, 0.45), clamp(floorL * 0.4, 10, 46));
  const vigColor = toneTo(desat(p.fog, 0.55), Math.min(fogL, 26) * 0.4);

  const tone: Tone = {
    palette: p,
    farWash,
    farWashA: WASH_FAR_BASE + WASH_FAR_FOG * density,
    midWash,
    midWashA: WASH_MID_BASE + WASH_MID_FOG * density,
    hazeTop: withAlpha(hazeColor, 0),
    hazeBottom: withAlpha(hazeColor, HAZE_BASE + HAZE_FOG * density),
    scrimTop: withAlpha(scrimColor, 0),
    scrimMid: withAlpha(scrimColor, SCRIM_PEAK * 0.42),
    scrimBottom: withAlpha(scrimColor, SCRIM_PEAK),
    floorSeat: toneTo(p.ground, floorL * 0.78),
    floorRise: toneTo(p.ground, floorL * 0.98),
    floorPeak: toneTo(p.ground, floorL),
    floorBand: toneTo(p.ground, floorL * 0.9),
    floorFront: toneTo(p.ground, floorL * 0.54),
    floorKerb: toneTo(p.ground, floorL * 0.34),
    vigInner: withAlpha(vigColor, 0),
    vigKnee: withAlpha(vigColor, VIGNETTE_MAX * 0.16),
    vigOuter: withAlpha(vigColor, VIGNETTE_MAX),
  };
  toneCache = tone;
  return tone;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walks the tiles of one parallax band that are on screen. `fn` gets the tile
 * index (stable across the whole map, so hashed detail never swims) and the
 * screen x of the tile's left edge. The run covers the overscanned span rather
 * than the authored width, so a zoomed or nudged view never finds an edge.
 */
function tiles(
  camX: number,
  parallax: number,
  spacing: number,
  pad: number,
  fn: (i: number, sx: number) => void,
): void {
  const off = camX * parallax;
  const i0 = Math.floor((off + spanX - pad) / spacing);
  const i1 = Math.ceil((off + spanX + spanW + pad) / spacing);
  for (let i = i0; i <= i1; i++) fn(i, i * spacing - off);
}

function label(
  ctx: C2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'center',
  italic = false,
): void {
  ctx.font = `${italic ? 'italic ' : ''}800 ${size}px ${FONT_DISPLAY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** A lit rectangle with a soft bloom, the workhorse of every neon sign. */
function glowRect(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  intensity: number,
): void {
  if (intensity <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp(intensity * 0.22, 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.globalAlpha = clamp(intensity, 0, 1);
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Set dressing
//
// The bands above say WHERE a map is. This says what it is like to stand in it:
// what the place is lit by, what the floor is made of, how thick the air is and
// what is hanging between the camera and the fight.
//
// It exists because twelve themes built out of flat fills on a flat floor read
// as twelve colours of the same room. None of the things that make a room a
// room — a lamp, the cone of light under it, the pool that light leaves on the
// floor, the grime in the corner — belonged to any one band, so none of the
// bands drew them. They are drawn here, once, for every theme, from one table.
//
// Everything in this section is 1:1 with the world unless it says otherwise.
// A lamp over the walkway and the pool underneath it have to move together,
// and the floor is the only band that moves at the speed the fighters do.
// ─────────────────────────────────────────────────────────────────────────────

/** How far a floor feature leans as it comes toward the camera. See `ground`. */
const FLOOR_SHEAR = 26 / (VIEW_H - FLOOR_TOP);

type LampKind = 'lantern' | 'tube' | 'highbay' | 'street' | 'flood' | 'spot' | 'panel' | 'none';
type FloorKind =
  | 'track'
  | 'forest'
  | 'asphalt'
  | 'concrete'
  | 'shopfloor'
  | 'raised'
  | 'parquet'
  | 'glass'
  | 'pad'
  | 'regolith'
  | 'deck';
type CanopyKind = 'cables' | 'pipes' | 'beams' | 'leaves' | 'wires' | 'none';

interface Dressing {
  /** What the place is lit by. `null` takes the map's own accent. */
  light: string | null;
  lamp: LampKind;
  /** World units between fixtures, and the authored y they hang at. */
  spacing: number;
  lampY: number;
  /** Half-width of a shaft where it meets the floor. */
  spread: number;
  /** Lean of the shaft, in x per y. Sunlight comes in at an angle; a lamp does not. */
  slant: number;
  /** Strength of the shaft in the air, and of the pool it leaves on the floor. */
  shaft: number;
  pool: number;
  /** Fraction of fixtures that are on their way out. */
  flicker: number;
  /** Back-light behind the far band, and what colour it is (`null` = the light). */
  glow: number;
  glowColor: string | null;
  /** 0 is matte. 1 is a floor you can see the ceiling in. */
  gloss: number;
  floor: FloorKind;
  /** How much air there is to see. Drifting, layered, and lit. */
  mist: number;
  canopy: CanopyKind;
}

const DRESSING: Record<MapTheme, Dressing> = {
  mine: {
    light: '#ffc27a', lamp: 'lantern', spacing: 148, lampY: 94, spread: 54, slant: 0,
    shaft: 0.5, pool: 0.6, flicker: 0.16, glow: 0.3, glowColor: '#ff8a3d',
    gloss: 0.2, floor: 'track', mist: 0.5, canopy: 'beams',
  },
  forest: {
    light: '#e2f7a8', lamp: 'none', spacing: 132, lampY: 30, spread: 40, slant: 0.34,
    shaft: 0.42, pool: 0.55, flicker: 0, glow: 0.55, glowColor: '#9fe6b4',
    gloss: 0, floor: 'forest', mist: 0.8, canopy: 'leaves',
  },
  suburb: {
    light: '#ffe2a6', lamp: 'street', spacing: 214, lampY: 100, spread: 62, slant: 0,
    shaft: 0.36, pool: 0.55, flicker: 0.1, glow: 0.5, glowColor: '#ff9d6a',
    gloss: 0.5, floor: 'asphalt', mist: 0.3, canopy: 'wires',
  },
  tunnel: {
    light: '#dff3ff', lamp: 'tube', spacing: 152, lampY: 88, spread: 66, slant: 0,
    shaft: 0.4, pool: 0.55, flicker: 0.2, glow: 0.22, glowColor: null,
    gloss: 0.45, floor: 'concrete', mist: 0.4, canopy: 'cables',
  },
  factory: {
    light: '#ffe9b4', lamp: 'highbay', spacing: 188, lampY: 86, spread: 64, slant: 0,
    shaft: 0.42, pool: 0.55, flicker: 0.08, glow: 0.3, glowColor: null,
    gloss: 0.2, floor: 'shopfloor', mist: 0.45, canopy: 'pipes',
  },
  gigafactory: {
    light: '#f1f6ff', lamp: 'highbay', spacing: 168, lampY: 84, spread: 60, slant: 0,
    shaft: 0.36, pool: 0.5, flicker: 0.05, glow: 0.3, glowColor: null,
    gloss: 0.3, floor: 'shopfloor', mist: 0.35, canopy: 'beams',
  },
  server_farm: {
    light: null, lamp: 'tube', spacing: 122, lampY: 86, spread: 46, slant: 0,
    shaft: 0.3, pool: 0.5, flicker: 0.05, glow: 0.4, glowColor: null,
    gloss: 0.75, floor: 'raised', mist: 0.5, canopy: 'cables',
  },
  social_feed: {
    light: null, lamp: 'panel', spacing: 164, lampY: 88, spread: 56, slant: 0,
    shaft: 0.3, pool: 0.5, flicker: 0.12, glow: 0.35, glowColor: null,
    gloss: 0.85, floor: 'glass', mist: 0.25, canopy: 'none',
  },
  boardroom: {
    light: '#ffe9c4', lamp: 'spot', spacing: 138, lampY: 82, spread: 42, slant: 0,
    shaft: 0.34, pool: 0.55, flicker: 0, glow: 0.4, glowColor: null,
    gloss: 0.8, floor: 'parquet', mist: 0.15, canopy: 'none',
  },
  launchpad: {
    light: '#fff0da', lamp: 'flood', spacing: 236, lampY: 92, spread: 84, slant: 0,
    shaft: 0.4, pool: 0.55, flicker: 0, glow: 0.65, glowColor: null,
    gloss: 0.15, floor: 'pad', mist: 0.6, canopy: 'pipes',
  },
  mars_dome: {
    light: '#ffdca6', lamp: 'none', spacing: 196, lampY: 30, spread: 58, slant: -0.3,
    shaft: 0.3, pool: 0.45, flicker: 0, glow: 0.6, glowColor: '#ffb070',
    gloss: 0, floor: 'regolith', mist: 0.5, canopy: 'beams',
  },
  orbit: {
    light: null, lamp: 'tube', spacing: 150, lampY: 88, spread: 50, slant: 0,
    shaft: 0.28, pool: 0.5, flicker: 0.04, glow: 0.35, glowColor: '#5fa8ff',
    gloss: 0.6, floor: 'deck', mist: 0, canopy: 'none',
  },
};

/** The colour a map is lit by: the table's, or the map's own accent. */
function lightOf(d: Dressing, p: MapPalette): string {
  return d.light ?? p.accent;
}

// ── Light, pre-rendered ──────────────────────────────────────────────────────
//
// A cone of light is a gradient in two directions at once, and Canvas2D has no
// such thing: built live it is a hundred and thirty fills per lamp per frame.
// So each colour of light gets its shapes painted ONCE, into a few small
// off-screen canvases, and every lamp after that is a single scaled blit. The
// softness comes free with the scaling.

interface LightSprites {
  shaft: HTMLCanvasElement;
  pool: HTMLCanvasElement;
  halo: HTMLCanvasElement;
  streak: HTMLCanvasElement;
  mist: HTMLCanvasElement;
}

const SHAFT_W = 96;
const SHAFT_H = 128;
const MIST_W = 256;
const MIST_H = 64;

/** One entry per colour of light ever asked for. A campaign has about thirty. */
const lightCache = new Map<string, LightSprites | null>();

function blank(w: number, h: number): [HTMLCanvasElement, C2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? [c, g] : null;
}

function lightSprites(color: string): LightSprites | null {
  const hit = lightCache.get(color);
  if (hit !== undefined) return hit;

  const rgb = parseRgb(color) ?? [255, 236, 200];
  const tone = (a: number): string => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;

  const shaft = blank(SHAFT_W, SHAFT_H);
  const pool = blank(128, 64);
  const halo = blank(64, 64);
  const streak = blank(16, 64);
  const mist = blank(MIST_W, MIST_H);
  if (!shaft || !pool || !halo || !streak || !mist) {
    // No DOM: a validator, a test. The scenery simply goes unlit.
    lightCache.set(color, null);
    return null;
  }

  // The shaft: narrow and bright at the fixture, wide and nearly gone at the
  // floor, and soft down both edges all the way.
  {
    const g = shaft[1];
    for (let y = 0; y < SHAFT_H; y++) {
      const t = y / (SHAFT_H - 1);
      const half = lerp(5, SHAFT_W * 0.5, t);
      const a = Math.pow(1 - t, 1.25) * 0.85 + 0.03;
      const row = g.createLinearGradient(SHAFT_W * 0.5 - half, 0, SHAFT_W * 0.5 + half, 0);
      row.addColorStop(0, tone(0));
      row.addColorStop(0.5, tone(a));
      row.addColorStop(1, tone(0));
      g.fillStyle = row;
      g.fillRect(SHAFT_W * 0.5 - half, y, half * 2, 1);
    }
  }

  // The pool: a disc, laid flat.
  {
    const g = pool[1];
    g.scale(1, 0.5);
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, tone(0.9));
    r.addColorStop(0.45, tone(0.38));
    r.addColorStop(1, tone(0));
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  }

  // The halo round a fixture: white-hot in the middle, the light's own colour
  // by the time it has faded.
  {
    const g = halo[1];
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,0.95)');
    r.addColorStop(0.2, tone(0.7));
    r.addColorStop(1, tone(0));
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  }

  // The streak: what a lamp looks like in a floor that is wet or polished.
  {
    const g = streak[1];
    for (let x = 0; x < 16; x++) {
      const a = 1 - Math.abs(x - 7.5) / 8;
      const col = g.createLinearGradient(0, 0, 0, 64);
      col.addColorStop(0, tone(0.7 * a));
      col.addColorStop(1, tone(0));
      g.fillStyle = col;
      g.fillRect(x, 0, 1, 64);
    }
  }

  // The mist: a handful of soft lumps that tile end to end, so a bank of it
  // can drift across the whole map without ever showing a seam.
  {
    const g = mist[1];
    for (let i = 0; i < 11; i++) {
      const cx = hash(i * 131 + 7) * MIST_W;
      const cy = MIST_H * (0.3 + hash(i * 137 + 3) * 0.5);
      const r = 26 + hash(i * 139 + 5) * 34;
      for (const dx of [-MIST_W, 0, MIST_W]) {
        const b = g.createRadialGradient(cx + dx, cy, 0, cx + dx, cy, r);
        b.addColorStop(0, tone(0.3));
        b.addColorStop(1, tone(0));
        g.fillStyle = b;
        g.fillRect(cx + dx - r, cy - r, r * 2, r * 2);
      }
    }
  }

  const out: LightSprites = {
    shaft: shaft[0],
    pool: pool[0],
    halo: halo[0],
    streak: streak[0],
    mist: mist[0],
  };
  lightCache.set(color, out);
  return out;
}

/**
 * How bright fixture `i` is this frame: 1, give or take a breath, unless it is
 * one of the ones that is dying — and those spend a third of their time off.
 */
function lampLevel(d: Dressing, i: number, frame: number): number {
  if (hash(i * 53 + 11) < d.flicker) {
    return hash(i * 59 + ((frame / 3) | 0) * 7) > 0.34 ? 0.9 : 0.12;
  }
  return 0.94 + 0.06 * Math.sin(frame * 0.05 + i * 1.7);
}

/**
 * Light behind the furthest thing in the shot.
 *
 * A dark silhouette on a dark sky is not a silhouette, and every far band in
 * this game is a dark shape. Putting a glow down at the horizon behind it —
 * the next chamber, the city, the dawn — is what turns that band from a stripe
 * of slightly different grey into something with an edge.
 */
function backGlow(ctx: C2D, d: Dressing, p: MapPalette): void {
  if (d.glow <= 0.01) return;
  const color = d.glowColor ?? lightOf(d, p);
  const top = FLOOR_TOP - 168;
  const g = ctx.createLinearGradient(0, top, 0, FLOOR_TOP + 6);
  g.addColorStop(0, withAlpha(color, 0));
  g.addColorStop(0.62, withAlpha(color, d.glow * 0.16));
  g.addColorStop(1, withAlpha(color, d.glow * 0.42));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  fillSpan(ctx, top, FLOOR_TOP + 6 - top);
  ctx.restore();
}

/**
 * A bank of lit air, drifting.
 *
 * Called twice, at two depths: once behind the mid band and once in front of
 * it. Two layers of fog sliding past each other at different speeds is the
 * cheapest depth cue there is, and the only one here that moves when the
 * camera does not.
 */
function mistBank(
  ctx: C2D,
  d: Dressing,
  p: MapPalette,
  camX: number,
  frame: number,
  parallax: number,
  y: number,
  h: number,
  alpha: number,
): void {
  const a = d.mist * alpha;
  if (a <= 0.01) return;
  const sprites = lightSprites(mix(d.glowColor ?? lightOf(d, p), '#ffffff', 0.25));
  if (!sprites) return;
  const w = MIST_W * (h / MIST_H);
  const drift = frame * (0.05 + parallax * 0.12);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp(a, 0, 1);
  tiles(camX + drift / Math.max(0.05, parallax), parallax, w, w, (_i, sx) => {
    ctx.drawImage(sprites.mist, sx, y, w + 0.5, h);
  });
  ctx.restore();
}

// ── The floor ────────────────────────────────────────────────────────────────

/** Screen x of a floor feature that sits at world-x `sx` and depth-y `y`. */
function lean(sx: number, y: number): number {
  return sx + (y - FLOOR_TOP) * FLOOR_SHEAR;
}

/** A seam across the floor, front to back, leaning the way the floor leans. */
function seam(ctx: C2D, sx: number, y0: number, y1: number): void {
  ctx.moveTo(lean(sx, y0), y0);
  ctx.lineTo(lean(sx, y1), y1);
}

/** A flat patch on the floor: a stain, a puddle, a plate. Leans with it. */
function patch(ctx: C2D, sx: number, y: number, rx: number, ry: number, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(lean(sx, y), y, rx, ry, 0, 0, TAU);
  ctx.fill();
}

/**
 * What the floor is made of.
 *
 * The base gradient under this makes the floor the right BRIGHTNESS; it does
 * not make it a floor. A mine and a boardroom were the same lit rectangle with
 * a different tint. This lays the material on top — boards, slabs, tiles,
 * paint, dirt — and the marks a place leaves on its own floor: the oil under a
 * machine, the wear down the middle of a path, the crack nobody has fixed.
 *
 * Kept quiet on purpose. It is drawn in the palette's own ground colours at
 * low alpha, because it is the surface the fighters are read against and has
 * to stay a surface.
 */
function floorMaterial(
  ctx: C2D,
  theme: MapTheme,
  d: Dressing,
  p: MapPalette,
  camX: number,
  frame: number,
): void {
  const bandH = FLOOR_BOTTOM - FLOOR_TOP;
  const dark = withAlpha(shade(p.ground, 0.42), 0.55);
  const pale = withAlpha(shade(p.groundLine, 1.25), 0.4);
  const light = lightOf(d, p);

  ctx.save();
  ctx.lineWidth = 1;

  switch (d.floor) {
    case 'track': {
      // Trodden dirt, with the tub rails laid along the back of it.
      const r0 = FLOOR_TOP + 9;
      const r1 = FLOOR_TOP + 19;
      // Sleepers, every one of them in a single fill.
      ctx.fillStyle = withAlpha('#59432a', 0.75);
      ctx.beginPath();
      tiles(camX, 1, 13, 30, (_i, sx) => {
        ctx.moveTo(lean(sx, r0 - 3), r0 - 3);
        ctx.lineTo(lean(sx + 5, r0 - 3), r0 - 3);
        ctx.lineTo(lean(sx + 5, r1 + 3), r1 + 3);
        ctx.lineTo(lean(sx, r1 + 3), r1 + 3);
        ctx.closePath();
      });
      ctx.fill();
      for (const y of [r0, r1]) {
        ctx.fillStyle = withAlpha('#0e0b12', 0.55);
        fillSpan(ctx, y + 1, 1.6);
        ctx.fillStyle = withAlpha(mix('#8a8f9c', light, 0.35), 0.8);
        fillSpan(ctx, y, 1.2);
      }
      // Grit, and the dip where the water collects.
      tiles(camX, 1, 17, 30, (i, sx) => {
        const y = FLOOR_TOP + 26 + hash(i * 211) * (bandH - 26);
        patch(ctx, sx + hash(i * 213) * 15, y, 1 + hash(i * 217) * 2.2, 0.8, i & 1 ? dark : pale);
      });
      tiles(camX, 1, 190, 80, (i, sx) => {
        if (hash(i * 223) < 0.4) return;
        const y = FLOOR_TOP + bandH * (0.5 + hash(i * 227) * 0.35);
        patch(ctx, sx + 60, y, 26 + hash(i * 229) * 16, 4.5, withAlpha('#0a080e', 0.5));
        patch(ctx, sx + 54, y - 1, 12, 1.3, withAlpha(light, 0.22));
      });
      break;
    }

    case 'forest': {
      // A path worn pale down the middle, and everything else trying to grow
      // back over it.
      const path = ctx.createLinearGradient(0, FLOOR_TOP, 0, FLOOR_BOTTOM);
      path.addColorStop(0, withAlpha('#6b5a3a', 0));
      path.addColorStop(0.5, withAlpha('#7a6842', 0.38));
      path.addColorStop(1, withAlpha('#6b5a3a', 0));
      ctx.fillStyle = path;
      fillSpan(ctx, FLOOR_TOP, bandH);
      // Grass along both edges, thinning toward the path. Two greens, and each
      // green is ONE stroke: a path per blade is sixty strokes a frame.
      for (let tone = 0; tone < 2; tone++) {
        ctx.strokeStyle = withAlpha(shade(p.near, tone === 0 ? 1.0 : 1.5), 0.75);
        ctx.beginPath();
        tiles(camX, 1, 9, 30, (i, sx) => {
          if ((hash(i * 251) > 0.5 ? 1 : 0) !== tone) return;
          const y = i & 1 ? FLOOR_TOP + 1 + hash(i * 233) * 12 : FLOOR_BOTTOM - hash(i * 233) * 14;
          const h = 3 + hash(i * 239) * 5;
          const x = lean(sx + hash(i * 241) * 9, y);
          ctx.moveTo(x, y);
          ctx.lineTo(x - 1.4, y - h);
          ctx.moveTo(x + 1.6, y);
          ctx.lineTo(x + 2.6, y - h * 0.8);
        });
        ctx.stroke();
      }
      tiles(camX, 1, 23, 30, (i, sx) => {
        const y = FLOOR_TOP + 5 + hash(i * 257) * (bandH - 8);
        const kind = hash(i * 263);
        if (kind < 0.5) {
          patch(ctx, sx, y, 2.6, 1.2, withAlpha(i % 3 === 0 ? '#c9a24a' : '#8a5a2c', 0.6));
        } else if (kind < 0.8) {
          patch(ctx, sx, y, 2.4 + hash(i) * 3, 1.6, withAlpha('#57606a', 0.6));
          patch(ctx, sx - 0.8, y - 0.7, 1.2, 0.6, withAlpha('#aab4bd', 0.4));
        } else {
          // A root, breaking the surface.
          ctx.strokeStyle = withAlpha('#2a1c14', 0.6);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(lean(sx, y), y);
          ctx.quadraticCurveTo(lean(sx + 9, y - 3), y - 3, lean(sx + 19, y + 1), y + 1);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      });
      break;
    }

    case 'asphalt': {
      // Pavement at the back, a kerb, then road — and the road is wet.
      ctx.fillStyle = withAlpha(shade(p.groundLine, 0.9), 0.3);
      fillSpan(ctx, FLOOR_TOP, 9);
      ctx.fillStyle = withAlpha('#0c0e16', 0.55);
      fillSpan(ctx, FLOOR_TOP + 9, 2.2);
      ctx.fillStyle = withAlpha('#cfd6e6', 0.3);
      fillSpan(ctx, FLOOR_TOP + 8.2, 1);
      ctx.strokeStyle = withAlpha('#10121a', 0.45);
      ctx.beginPath();
      tiles(camX, 1, 22, 30, (_i, sx) => seam(ctx, sx, FLOOR_TOP, FLOOR_TOP + 9));
      ctx.stroke();
      tiles(camX, 1, 250, 90, (i, sx) => {
        // A manhole, a drain, a patch somebody laid in a different decade.
        const y = FLOOR_TOP + bandH * (0.34 + hash(i * 269) * 0.4);
        const x = sx + 40 + hash(i * 271) * 150;
        if (hash(i * 277) < 0.5) {
          patch(ctx, x, y, 13, 4.2, withAlpha('#14161f', 0.75));
          ctx.strokeStyle = withAlpha('#8f98ad', 0.4);
          ctx.beginPath();
          ctx.ellipse(lean(x, y), y, 10.5, 3.2, 0, 0, TAU);
          ctx.moveTo(lean(x, y) - 7, y);
          ctx.lineTo(lean(x, y) + 7, y);
          ctx.stroke();
        } else {
          ctx.fillStyle = withAlpha('#20232f', 0.5);
          ctx.beginPath();
          ctx.moveTo(lean(x, y), y);
          ctx.lineTo(lean(x + 44, y), y);
          ctx.lineTo(lean(x + 44, y + 13), y + 13);
          ctx.lineTo(lean(x, y + 13), y + 13);
          ctx.closePath();
          ctx.fill();
        }
      });
      // Cracks, running with the grain of the road.
      ctx.strokeStyle = withAlpha('#0b0d14', 0.5);
      tiles(camX, 1, 96, 60, (i, sx) => {
        if (hash(i * 281) < 0.45) return;
        let x = sx + hash(i * 283) * 70;
        let y = FLOOR_TOP + 16 + hash(i * 293) * (bandH - 22);
        ctx.beginPath();
        ctx.moveTo(lean(x, y), y);
        for (let k = 0; k < 5; k++) {
          x += 5 + hash(i * 307 + k) * 8;
          y += (hash(i * 311 + k) - 0.5) * 6;
          ctx.lineTo(lean(x, y), y);
        }
        ctx.stroke();
      });
      break;
    }

    case 'concrete': {
      // Cast slabs, a drain down the back, and the damp the drain misses.
      ctx.fillStyle = withAlpha('#09080d', 0.6);
      fillSpan(ctx, FLOOR_TOP + 5, 4);
      ctx.strokeStyle = withAlpha('#57506a', 0.55);
      ctx.beginPath();
      tiles(camX, 1, 5, 20, (_i, sx) => seam(ctx, sx, FLOOR_TOP + 5, FLOOR_TOP + 9));
      ctx.stroke();
      ctx.strokeStyle = dark;
      ctx.beginPath();
      tiles(camX, 1, 96, 40, (_i, sx) => seam(ctx, sx, FLOOR_TOP + 10, spanBottom));
      ctx.stroke();
      tiles(camX, 1, 96, 60, (i, sx) => {
        // Water tracks across a slab toward the low side.
        if (hash(i * 313) < 0.35) return;
        const y = FLOOR_TOP + 18 + hash(i * 317) * (bandH - 26);
        patch(ctx, sx + 30 + hash(i * 331) * 40, y, 20 + hash(i * 337) * 18, 3.4, withAlpha('#07060a', 0.34));
        patch(ctx, sx + 26 + hash(i * 331) * 40, y - 0.8, 9, 1, withAlpha(light, 0.14));
      });
      // The painted edge of the walkway, mostly worn off.
      tiles(camX, 1, 26, 30, (i, sx) => {
        if (hash(i * 347) < 0.3) return;
        ctx.fillStyle = withAlpha(p.accent, 0.3);
        const y = FLOOR_BOTTOM - 7;
        ctx.beginPath();
        ctx.moveTo(lean(sx, y), y);
        ctx.lineTo(lean(sx + 19, y), y);
        ctx.lineTo(lean(sx + 19, y + 2.4), y + 2.4);
        ctx.lineTo(lean(sx, y + 2.4), y + 2.4);
        ctx.closePath();
        ctx.fill();
      });
      break;
    }

    case 'shopfloor': {
      // Poured slabs, a painted pedestrian lane nobody stays inside, and what
      // the machines have dripped on it since.
      ctx.strokeStyle = dark;
      ctx.beginPath();
      tiles(camX, 1, 120, 40, (_i, sx) => seam(ctx, sx, FLOOR_TOP, spanBottom));
      ctx.stroke();
      ctx.fillStyle = withAlpha(shade(p.ground, 0.45), 0.4);
      fillSpan(ctx, FLOOR_TOP + bandH * 0.5, 1);
      for (const y of [FLOOR_TOP + 7, FLOOR_BOTTOM - 8]) {
        tiles(camX, 1, 34, 30, (i, sx) => {
          // Worn through in places, which is most of the realism.
          if (hash(i * 349 + y) < 0.22) return;
          ctx.fillStyle = withAlpha(p.accent, 0.42);
          ctx.beginPath();
          ctx.moveTo(lean(sx, y), y);
          ctx.lineTo(lean(sx + 30, y), y);
          ctx.lineTo(lean(sx + 30, y + 2.6), y + 2.6);
          ctx.lineTo(lean(sx, y + 2.6), y + 2.6);
          ctx.closePath();
          ctx.fill();
        });
      }
      tiles(camX, 1, 210, 80, (i, sx) => {
        // An arrow, pointing the way everybody is already going.
        const y = FLOOR_TOP + bandH * 0.5;
        const x = lean(sx + 90, y);
        ctx.fillStyle = withAlpha(p.accent, 0.26);
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + 20, y - 3);
        ctx.lineTo(x + 20, y - 7);
        ctx.lineTo(x + 32, y);
        ctx.lineTo(x + 20, y + 7);
        ctx.lineTo(x + 20, y + 3);
        ctx.lineTo(x, y + 3);
        ctx.closePath();
        ctx.fill();
        // ...and the oil.
        if (hash(i * 353) > 0.35) {
          const oy = FLOOR_TOP + 16 + hash(i * 359) * (bandH - 30);
          const ox = sx + hash(i * 367) * 170;
          patch(ctx, ox, oy, 15 + hash(i * 373) * 12, 3.6, withAlpha('#06060a', 0.42));
          patch(ctx, ox + 3, oy + 0.4, 6, 1.4, withAlpha('#06060a', 0.3));
          patch(ctx, ox - 4, oy - 0.9, 5, 0.8, withAlpha(light, 0.16));
        }
      });
      // Anchor plates where something heavy used to be bolted down.
      tiles(camX, 1, 150, 40, (i, sx) => {
        if (hash(i * 379) < 0.5) return;
        const y = FLOOR_TOP + 14 + hash(i * 383) * 20;
        const x = lean(sx + 60, y);
        ctx.fillStyle = withAlpha(shade(p.near, 0.8), 0.6);
        ctx.fillRect(x, y, 9, 3.2);
        ctx.fillStyle = withAlpha('#0a0a10', 0.6);
        ctx.fillRect(x + 1, y + 1, 1.2, 1.2);
        ctx.fillRect(x + 6.6, y + 1, 1.2, 1.2);
      });
      break;
    }

    case 'raised': {
      // Access-floor tiles. Some are vent grilles, and the cold comes up lit.
      ctx.strokeStyle = withAlpha(p.groundLine, 0.34);
      for (let k = 1; k < 4; k++) {
        const y = FLOOR_TOP + (bandH * k) / 4;
        ctx.beginPath();
        ctx.moveTo(spanX, y);
        ctx.lineTo(spanX + spanW, y);
        ctx.stroke();
      }
      tiles(camX, 1, 40, 40, (i, sx) => {
        const row = (hash(i * 389) * 4) | 0;
        if (hash(i * 397) < 0.74) return;
        const y0 = FLOOR_TOP + (bandH * row) / 4 + 1.5;
        const y1 = y0 + bandH / 4 - 3;
        const breathe = 0.5 + 0.5 * Math.sin(frame * 0.03 + i);
        ctx.fillStyle = withAlpha(p.accent, 0.1 + 0.1 * breathe);
        ctx.beginPath();
        ctx.moveTo(lean(sx + 3, y0), y0);
        ctx.lineTo(lean(sx + 37, y0), y0);
        ctx.lineTo(lean(sx + 37, y1), y1);
        ctx.lineTo(lean(sx + 3, y1), y1);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = withAlpha('#04090c', 0.6);
        ctx.beginPath();
        for (let s = 0; s < 6; s++) seam(ctx, sx + 6 + s * 5.4, y0 + 1, y1 - 1);
        ctx.stroke();
      });
      break;
    }

    case 'parquet': {
      // Boards, long and narrow, and a runner down the middle for the people
      // who are allowed to walk on it.
      ctx.strokeStyle = withAlpha('#0d0c12', 0.4);
      for (let k = 1; k < 7; k++) {
        const y = FLOOR_TOP + (bandH * k) / 7;
        ctx.beginPath();
        ctx.moveTo(spanX, y);
        ctx.lineTo(spanX + spanW, y);
        ctx.stroke();
      }
      ctx.beginPath();
      tiles(camX, 1, 46, 40, (i, sx) => {
        for (let k = 0; k < 7; k++) {
          const y0 = FLOOR_TOP + (bandH * k) / 7;
          seam(ctx, sx + ((k * 17 + (i % 3) * 9) % 46), y0, y0 + bandH / 7);
        }
      });
      ctx.stroke();
      const r0 = FLOOR_TOP + bandH * 0.3;
      const r1 = FLOOR_TOP + bandH * 0.78;
      ctx.fillStyle = withAlpha(mix('#5a1620', p.accent, 0.12), 0.42);
      fillSpan(ctx, r0, r1 - r0);
      ctx.fillStyle = withAlpha(p.accent, 0.5);
      fillSpan(ctx, r0 + 2, 1);
      fillSpan(ctx, r1 - 3, 1);
      tiles(camX, 1, 28, 30, (_i, sx) => {
        const y = (r0 + r1) * 0.5;
        const x = lean(sx, y);
        ctx.fillStyle = withAlpha(p.accent, 0.2);
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
        ctx.fill();
      });
      break;
    }

    case 'glass': {
      // A screen, lying down. Things keep arriving on it.
      tiles(camX, 1, 58, 40, (i, sx) => {
        const y = FLOOR_TOP + 8 + hash(i * 401) * (bandH - 16);
        const on = hash(i * 409 + ((frame / 31) | 0)) > 0.4;
        const x = lean(sx + hash(i * 419) * 40, y);
        ctx.fillStyle = withAlpha(p.accent, on ? 0.26 : 0.08);
        ctx.fillRect(x, y, 22 + hash(i * 421) * 18, 2);
        ctx.fillRect(x, y + 4, 10 + hash(i * 431) * 14, 1.4);
        if (on && hash(i * 433) > 0.6) {
          ctx.fillStyle = withAlpha('#ff5f8d', 0.5);
          ctx.beginPath();
          ctx.ellipse(x - 4, y + 1, 2, 1.1, 0, 0, TAU);
          ctx.fill();
        }
      });
      break;
    }

    case 'pad': {
      // Refractory slabs, a flame trench under a grating, and paint that has
      // been through four launches.
      ctx.strokeStyle = dark;
      ctx.beginPath();
      tiles(camX, 1, 84, 40, (_i, sx) => seam(ctx, sx, FLOOR_TOP, spanBottom));
      ctx.stroke();
      const t0 = FLOOR_TOP + bandH * 0.42;
      ctx.fillStyle = withAlpha('#08060b', 0.72);
      fillSpan(ctx, t0, 8);
      ctx.fillStyle = withAlpha(p.accent, 0.12 + 0.05 * Math.sin(frame * 0.04));
      fillSpan(ctx, t0 + 2, 4);
      ctx.strokeStyle = withAlpha('#6b5a6e', 0.7);
      ctx.beginPath();
      tiles(camX, 1, 6, 20, (_i, sx) => seam(ctx, sx, t0, t0 + 8));
      ctx.stroke();
      tiles(camX, 1, 300, 120, (i, sx) => {
        // A painted ring and a number: where something is supposed to stand.
        const y = FLOOR_TOP + bandH * 0.72;
        ctx.strokeStyle = withAlpha('#f4eada', 0.22);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(lean(sx + 150, y), y, 46, 10, 0, 0, TAU);
        ctx.stroke();
        ctx.lineWidth = 1;
        label(ctx, `${(Math.abs(i) % 9) + 1}`, lean(sx + 150, y), y, 11, withAlpha('#f4eada', 0.22));
      });
      break;
    }

    case 'regolith': {
      // Dust that has been driven over, hit, and never rained on.
      tiles(camX, 1, 150, 80, (i, sx) => {
        // A rover went this way. Then it came back.
        ctx.fillStyle = withAlpha(shade(p.ground, 0.6), 0.5);
        for (const lane of [0.3, 0.42]) {
          const y = FLOOR_TOP + bandH * (lane + 0.04 * Math.sin(i * 1.3));
          for (let k = 0; k < 15; k++) {
            ctx.fillRect(lean(sx + k * 10, y), y + Math.sin((i * 15 + k) * 0.4) * 1.5, 6, 1.6);
          }
        }
      });
      tiles(camX, 1, 110, 60, (i, sx) => {
        if (hash(i * 439) < 0.4) return;
        const y = FLOOR_TOP + bandH * (0.55 + hash(i * 443) * 0.35);
        const x = sx + hash(i * 449) * 80;
        const r = 8 + hash(i * 457) * 10;
        patch(ctx, x, y, r, r * 0.28, withAlpha(shade(p.ground, 0.5), 0.55));
        ctx.strokeStyle = withAlpha(shade(p.groundLine, 1.3), 0.45);
        ctx.beginPath();
        ctx.ellipse(lean(x, y), y - 0.6, r, r * 0.28, 0, Math.PI, TAU);
        ctx.stroke();
      });
      // The dome's own lattice, thrown across the floor by a low sun.
      ctx.strokeStyle = withAlpha('#1c0b06', 0.2);
      ctx.lineWidth = 5;
      ctx.beginPath();
      tiles(camX, 1, 92, 120, (_i, sx) => {
        ctx.moveTo(sx, FLOOR_TOP);
        ctx.lineTo(sx - 70, FLOOR_BOTTOM + 12);
      });
      ctx.stroke();
      break;
    }

    case 'deck': {
      // Plating: panel lines, rivets, and the hatch you hope stays shut.
      ctx.strokeStyle = withAlpha('#02040a', 0.6);
      ctx.beginPath();
      tiles(camX, 1, 64, 40, (_i, sx) => seam(ctx, sx, FLOOR_TOP, spanBottom));
      ctx.stroke();
      tiles(camX, 1, 64, 40, (i, sx) => {
        ctx.fillStyle = withAlpha(shade(p.groundLine, 1.4), 0.5);
        for (const y of [FLOOR_TOP + 5, FLOOR_TOP + bandH * 0.5 - 6, FLOOR_BOTTOM - 5]) {
          ctx.fillRect(lean(sx + 4, y), y, 1.4, 1.4);
          ctx.fillRect(lean(sx + 58, y), y, 1.4, 1.4);
        }
        if (hash(i * 461) > 0.8) {
          const y0 = FLOOR_TOP + bandH * 0.6;
          const y1 = FLOOR_BOTTOM - 8;
          ctx.strokeStyle = withAlpha(p.accent, 0.4);
          ctx.beginPath();
          ctx.moveTo(lean(sx + 14, y0), y0);
          ctx.lineTo(lean(sx + 50, y0), y0);
          ctx.lineTo(lean(sx + 50, y1), y1);
          ctx.lineTo(lean(sx + 14, y1), y1);
          ctx.closePath();
          ctx.stroke();
        }
      });
      break;
    }
  }

  // Polish. A floor that is wet, waxed or glass picks up a band of whatever is
  // above it along its far edge, where the angle is shallowest.
  if (d.gloss > 0.01) {
    const g = ctx.createLinearGradient(0, FLOOR_TOP, 0, FLOOR_TOP + 26);
    g.addColorStop(0, withAlpha(mix(light, '#ffffff', 0.4), d.gloss * 0.2));
    g.addColorStop(1, withAlpha(light, 0));
    ctx.fillStyle = g;
    fillSpan(ctx, FLOOR_TOP, 26);
  }

  ctx.restore();
}

// ── The lamps ────────────────────────────────────────────────────────────────

/** The thing the light comes out of. Drawn dark: it is lit from inside, not on. */
function fixture(
  ctx: C2D,
  kind: LampKind,
  x: number,
  y: number,
  p: MapPalette,
  light: string,
  level: number,
): void {
  const body = shade(p.near, 0.5);
  const hot = mix(light, '#ffffff', 0.55);
  switch (kind) {
    case 'lantern':
      capsule(ctx, x, spanTop, x, y - 7, 0.6, '#1b1420', 'none', 0);
      roundRect(ctx, x - 4.5, y - 7, 9, 3, 1, body, INK, 1.2);
      roundRect(ctx, x - 3.5, y - 4, 7, 9, 1.5, withAlpha(hot, 0.25 + 0.7 * level), INK, 1.2);
      roundRect(ctx, x - 4.5, y + 5, 9, 2.4, 1, body, INK, 1.2);
      break;
    case 'tube':
      capsule(ctx, x - 9, spanTop, x - 9, y - 3, 0.6, '#14121a', 'none', 0);
      capsule(ctx, x + 9, spanTop, x + 9, y - 3, 0.6, '#14121a', 'none', 0);
      roundRect(ctx, x - 17, y - 4, 34, 4, 1.5, body, INK, 1.2);
      roundRect(ctx, x - 15, y, 30, 2.6, 1.3, withAlpha(hot, 0.2 + 0.8 * level), 'none', 0);
      break;
    case 'highbay':
      capsule(ctx, x, spanTop, x, y - 9, 0.7, '#14121a', 'none', 0);
      poly(ctx, [x - 4, y - 9, x + 4, y - 9, x + 12, y, x - 12, y], body, INK, 1.3);
      roundRect(ctx, x - 10, y, 20, 2.4, 1.2, withAlpha(hot, 0.2 + 0.8 * level), 'none', 0);
      break;
    case 'street':
      // A post at the back kerb with its head out over the road.
      roundRect(ctx, x - 22, y - 2, 3, FLOOR_TOP - y + 4, 1, body, INK, 1.2);
      roundRect(ctx, x - 24, FLOOR_TOP - 6, 7, 8, 1, shade(p.near, 0.6), INK, 1.2);
      capsule(ctx, x - 20.5, y - 1, x - 3, y - 4, 1.2, body, INK, 1.1);
      roundRect(ctx, x - 8, y - 5, 16, 4, 2, body, INK, 1.2);
      roundRect(ctx, x - 6, y - 1, 12, 2.2, 1.1, withAlpha(hot, 0.2 + 0.8 * level), 'none', 0);
      break;
    case 'flood':
      // A lattice mast with a bank of lamps on top of it.
      roundRect(ctx, x - 2, y, 4, FLOOR_TOP - y + 2, 1, body, INK, 1.2);
      for (let k = 0; k < 5; k++) {
        const yy = y + 14 + k * 24;
        if (yy > FLOOR_TOP - 6) break;
        capsule(ctx, x - 6, yy, x + 6, yy + 10, 0.6, body, 'none', 0);
        capsule(ctx, x + 6, yy, x - 6, yy + 10, 0.6, body, 'none', 0);
      }
      roundRect(ctx, x - 13, y - 8, 26, 9, 2, body, INK, 1.3);
      for (let k = 0; k < 3; k++) {
        roundRect(ctx, x - 11 + k * 8, y - 6, 6, 5, 1, withAlpha(hot, 0.2 + 0.8 * level), 'none', 0);
      }
      break;
    case 'spot':
      roundRect(ctx, x - 26, y - 9, 52, 2.4, 1, body, 'none', 0);
      poly(ctx, [x - 3, y - 7, x + 3, y - 7, x + 5, y, x - 5, y], body, INK, 1.1);
      ellipse(ctx, x, y, 4, 1.4, 0, withAlpha(hot, 0.2 + 0.8 * level), 'none', 0);
      break;
    case 'panel':
      // A notification, hung where a light should be.
      roundRect(ctx, x - 20, y - 12, 40, 12, 3, shade(p.mid, 0.7), INK, 1.2);
      roundRect(ctx, x - 17, y - 9, 34, 6, 2, withAlpha(hot, 0.15 + 0.6 * level), 'none', 0);
      ellipse(ctx, x + 18, y - 12, 3, 3, 0, '#ff5f8d', INK, 1);
      break;
    case 'none':
      break;
  }
}

/**
 * Every lamp over the walkway: the fixture, the shaft of lit air under it, the
 * pool on the floor, and — if the floor will take one — its reflection.
 *
 * Drawn after the ground, so the shaft can run down past the back wall and
 * land in the middle of the lane, which is where a lamp hung over a walkway
 * actually points. The fighters are drawn after this and walk through it.
 */
function lamps(ctx: C2D, d: Dressing, p: MapPalette, camX: number, frame: number): void {
  if (d.spacing <= 0) return;
  const light = lightOf(d, p);
  const sprites = lightSprites(light);
  const bandH = FLOOR_BOTTOM - FLOOR_TOP;
  const poolY = FLOOR_TOP + bandH * 0.46;
  const reach = d.spread * 2 + Math.abs(d.slant) * 260;

  tiles(camX, 1, d.spacing, reach, (i, sx) => {
    const x = sx + d.spacing * 0.5;
    const level = lampLevel(d, i, frame);
    // Where the light lands: straight down from a lamp, off to one side of a
    // gap in the canopy.
    const landX = x + (poolY - d.lampY) * d.slant;

    if (sprites) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (d.shaft > 0.01) {
        ctx.globalAlpha = clamp(d.shaft * level, 0, 1);
        ctx.save();
        ctx.transform(1, 0, d.slant, 1, x - d.lampY * d.slant, 0);
        ctx.drawImage(sprites.shaft, -d.spread, d.lampY, d.spread * 2, poolY - d.lampY);
        ctx.restore();
      }
      if (d.pool > 0.01) {
        ctx.globalAlpha = clamp(d.pool * level, 0, 1);
        ctx.drawImage(sprites.pool, landX - d.spread * 1.25, poolY - bandH * 0.52, d.spread * 2.5, bandH * 1.04);
      }
      if (d.gloss > 0.25) {
        ctx.globalAlpha = clamp(d.gloss * 0.5 * level, 0, 1);
        ctx.drawImage(sprites.streak, landX - 5, FLOOR_TOP + 1, 10, bandH * 0.9);
      }
      if (d.lamp !== 'none') {
        ctx.globalAlpha = clamp(0.75 * level, 0, 1);
        ctx.drawImage(sprites.halo, x - 20, d.lampY - 20, 40, 40);
      }
      ctx.restore();
    }

    fixture(ctx, d.lamp, x, d.lampY, p, light, level);
  });
}

// ── Against the back wall ────────────────────────────────────────────────────

/** Width of one stretch of wall. Each stretch gets a couple of things in it. */
const WALL_BAY = 210;

/**
 * The things somebody left standing along the back of the walkway.
 *
 * The near band is at 0.62 of the camera and floats; these are 1:1 and stand ON
 * the floor line, so they are the objects a fighter visibly walks past — which
 * is what makes the back of the lane read as a place rather than as a painting
 * hung behind it. Two or three things per bay, chosen off the bay's own index,
 * so a map is the same map every time you walk it and no two bays in a row
 * match.
 *
 * Drawn before the action scrim, which settles them back behind the fight.
 */
function backWall(
  ctx: C2D,
  theme: MapTheme,
  d: Dressing,
  p: MapPalette,
  camX: number,
  frame: number,
): void {
  const c = p.near;
  const dim = shade(c, 0.68);
  const lit = shade(c, 1.32);
  const light = lightOf(d, p);
  const F = FLOOR_TOP;

  tiles(camX, 1, WALL_BAY, 120, (i, sx) => {
    const a = sx + 18 + hash(i * 601) * 40;
    const b = sx + 112 + hash(i * 607) * 50;
    const pick = hash(i * 613);
    const alt = hash(i * 617);

    switch (theme) {
      case 'mine': {
        // A seam of the stuff they came down here for, showing in the rock.
        const vy = F - 70 - hash(i * 619) * 60;
        for (let k = 0; k < 5; k++) {
          const x = a + k * 9 + hash(i * 631 + k) * 6;
          const y = vy + Math.sin(k * 1.3 + i) * 8;
          const h = 5 + hash(i * 641 + k) * 9;
          poly(ctx, [x, y, x + 3, y - h, x + 6.5, y], mix(p.accent, '#ffffff', 0.25), INK, 1);
          glowRect(ctx, x + 1.5, y - h * 0.7, 3, h * 0.6, p.accent, 0.3 + 0.12 * Math.sin(frame * 0.05 + k + i));
        }
        // Stacked crates, and the pick somebody is coming back for.
        roundRect(ctx, b, F - 22, 26, 22, 2, '#6b4d2c', INK, 1.5);
        roundRect(ctx, b + 4, F - 40, 22, 18, 2, '#7a5932', INK, 1.5);
        capsule(ctx, b + 2, F - 11, b + 24, F - 11, 0.7, '#3d2c1c', 'none', 0);
        capsule(ctx, b + 7, F - 31, b + 23, F - 31, 0.7, '#3d2c1c', 'none', 0);
        if (pick > 0.4) {
          capsule(ctx, b + 36, F - 1, b + 44, F - 38, 1.3, '#8a6a3a', INK, 1.2);
          poly(ctx, [b + 33, F - 35, b + 45, F - 42, b + 56, F - 34, b + 45, F - 38], '#9aa2ad', INK, 1.2);
        }
        if (alt > 0.5) {
          // A lamp of somebody's own, on the floor, still lit.
          roundRect(ctx, a + 60, F - 9, 7, 9, 2, '#3a2d44', INK, 1.2);
          glowRect(ctx, a + 61.5, F - 7.5, 4, 5, light, 0.75);
        }
        break;
      }

      case 'forest': {
        // One of the big ones, close enough to see the bark.
        const w = 20 + hash(i * 643) * 12;
        roundRect(ctx, a, spanTop, w, F - spanTop + 4, 3, shade(p.mid, 0.52), INK, 1.8);
        ctx.strokeStyle = withAlpha('#0a140f', 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const x = a + 3 + (k * (w - 6)) / 3;
          ctx.moveTo(x, F - 150);
          ctx.quadraticCurveTo(x + 2, F - 80, x - 1, F - 4);
        }
        ctx.stroke();
        poly(ctx, [a - 9, F + 3, a + 3, F - 16, a + w - 3, F - 16, a + w + 10, F + 3], shade(p.mid, 0.52), INK, 1.6);
        // What grows at the foot of it.
        for (let k = 0; k < 3; k++) {
          const x = a + w + 8 + k * 9;
          const h = 5 + hash(i * 647 + k) * 5;
          capsule(ctx, x, F, x, F - h, 1.1, '#e9dfc8', INK, 1);
          ellipse(ctx, x, F - h, 4.2, 2.6, 0, k === 1 ? '#d8452f' : '#c9763a', INK, 1.1);
        }
        // The notice. The forest has been told.
        capsule(ctx, b + 20, F, b + 20, F - 44, 1.4, '#8a6a3a', INK, 1.2);
        roundRect(ctx, b, F - 62, 42, 22, 2, '#e8dcc0', INK, 1.5);
        label(ctx, pick > 0.5 ? 'REZONED' : 'LOT ' + ((Math.abs(i) % 40) + 3), b + 21, F - 54, 6.5, '#3a2a1c');
        label(ctx, 'LIGHT INDUSTRIAL', b + 21, F - 46, 3.6, '#6b5a3a');
        // Fern.
        for (let k = 0; k < 5; k++) {
          const ang = -2.5 + k * 0.48;
          capsule(ctx, b + 62, F, b + 62 + Math.cos(ang) * 15, F + Math.sin(ang) * 14, 1.6, shade(p.near, 1.1), INK, 1);
        }
        break;
      }

      case 'suburb': {
        // A fence, a hedge that is winning, and what goes out on Thursdays.
        ellipse(ctx, a + 34, F - 12, 40, 15, 0, '#2f4a3a', INK, 1.5);
        for (let k = 0; k < 9; k++) {
          const x = a + k * 8;
          poly(ctx, [x, F, x, F - 20, x + 2.6, F - 24, x + 5.2, F - 20, x + 5.2, F], '#dfe3ea', INK, 1.1);
        }
        roundRect(ctx, a - 2, F - 15, 76, 2.6, 1, '#c8ccd6', INK, 1);
        const bin = pick > 0.5 ? '#3f6a4a' : '#4a5a7c';
        roundRect(ctx, b, F - 27, 17, 27, 2, bin, INK, 1.5);
        roundRect(ctx, b - 2, F - 31, 21, 5, 2, shade(bin, 1.25), INK, 1.4);
        ellipse(ctx, b + 4, F - 1.5, 2.4, 2.4, 0, '#14121a', INK, 1);
        if (alt > 0.45) {
          roundRect(ctx, b + 22, F - 27, 17, 27, 2, '#5a4a3a', INK, 1.5);
          roundRect(ctx, b + 20, F - 31, 21, 5, 2, '#6f5c48', INK, 1.4);
          ellipse(ctx, b + 50, F - 6, 9, 7, 0, '#22222c', INK, 1.4);
        } else {
          // A sign on the lawn.
          capsule(ctx, b + 40, F, b + 40, F - 26, 1.1, '#c8ccd6', INK, 1);
          roundRect(ctx, b + 27, F - 40, 26, 16, 2, '#f0eadc', INK, 1.4);
          label(ctx, 'FOR SALE', b + 40, F - 35, 4.6, '#b6262c');
          label(ctx, 'ALL OF IT', b + 40, F - 29, 3.6, '#3a3a48');
        }
        break;
      }

      case 'tunnel': {
        // An emergency cabinet, lit, with nothing useful in it.
        roundRect(ctx, a, F - 64, 24, 40, 2, dim, INK, 1.5);
        roundRect(ctx, a + 3, F - 60, 18, 14, 1, '#b6262c', INK, 1.2);
        label(ctx, 'SOS', a + 12, F - 53, 6, '#f4eada');
        roundRect(ctx, a + 3, F - 42, 18, 14, 1, shade(c, 0.5), INK, 1.1);
        glowRect(ctx, a + 9, F - 70, 6, 3, '#ff4b4b', (frame + i * 17) % 70 < 35 ? 0.9 : 0.15);
        // The way out, which is further than it says.
        roundRect(ctx, b, F - 96, 44, 14, 2, '#0f3a26', INK, 1.4);
        glowRect(ctx, b + 2, F - 94, 40, 10, '#3dff9a', 0.16);
        label(ctx, pick > 0.5 ? 'EXIT 4 KM' : 'EXIT ->', b + 22, F - 89, 6.5, '#a8ffd0');
        // A jet fan in the crown, turning.
        const fx = b + 70;
        const fy = F - 132;
        ellipse(ctx, fx, fy, 15, 15, 0, dim, INK, 1.6);
        ellipse(ctx, fx, fy, 11.5, 11.5, 0, '#0c0a10', 'none', 0);
        const rot = frame * 0.16 + i;
        for (let k = 0; k < 4; k++) {
          const ang = rot + (k * TAU) / 4;
          capsule(ctx, fx, fy, fx + Math.cos(ang) * 10, fy + Math.sin(ang) * 10, 1.8, lit, 'none', 0);
        }
        ellipse(ctx, fx, fy, 2.6, 2.6, 0, lit, INK, 1);
        break;
      }

      case 'factory':
      case 'gigafactory': {
        // A control cabinet: one gauge, three lamps, no instructions.
        roundRect(ctx, a, F - 68, 30, 68, 2, dim, INK, 1.6);
        roundRect(ctx, a + 3, F - 64, 24, 20, 1, shade(c, 0.45), INK, 1.1);
        ellipse(ctx, a + 15, F - 54, 6.5, 6.5, 0, '#e8e2d2', INK, 1.2);
        const needle = -2.4 + (0.5 + 0.5 * Math.sin(frame * 0.04 + i)) * 1.7;
        capsule(ctx, a + 15, F - 54, a + 15 + Math.cos(needle) * 5, F - 54 + Math.sin(needle) * 5, 0.6, '#b6262c', 'none', 0);
        for (let k = 0; k < 3; k++) {
          const on = hash(i * 653 + k + ((frame / 22) | 0) * 3) > 0.4;
          glowRect(ctx, a + 6 + k * 7, F - 38, 4, 4, k === 0 ? '#ff5340' : k === 1 ? '#ffc247' : '#63ff9d', on ? 0.9 : 0.14);
        }
        roundRect(ctx, a + 5, F - 28, 20, 22, 1, shade(c, 0.85), INK, 1.1);
        if (theme === 'factory') {
          // A roller conveyor, and the boxes that never stop coming.
          roundRect(ctx, b - 6, F - 26, 96, 5, 2, lit, INK, 1.4);
          for (let k = 0; k < 4; k++) roundRect(ctx, b + k * 28, F - 21, 4, 21, 1, dim, INK, 1.2);
          const travel = (frame * 0.5 + i * 37) % 44;
          for (let k = -1; k < 2; k++) {
            const bx = b + k * 44 + travel;
            if (bx < b - 8 || bx > b + 70) continue;
            roundRect(ctx, bx, F - 42, 18, 16, 1.5, '#b08a55', INK, 1.4);
            capsule(ctx, bx + 2, F - 34, bx + 16, F - 34, 0.7, '#6b4d2c', 'none', 0);
          }
        } else {
          // Cell packs on a pallet, strapped, with a tower light that is amber.
          for (let k = 0; k < 3; k++) {
            roundRect(ctx, b + (k % 2) * 3, F - 16 - k * 14, 46, 13, 2, shade(c, 1.15), INK, 1.4);
            roundRect(ctx, b + 4 + (k % 2) * 3, F - 13 - k * 14, 10, 7, 1, p.accent, 'none', 0);
          }
          roundRect(ctx, b - 3, F - 3, 54, 3.4, 1, '#6b4d2c', INK, 1.1);
          capsule(ctx, b + 66, F, b + 66, F - 52, 1.2, dim, INK, 1.1);
          for (let k = 0; k < 3; k++) {
            const on = k === ((((frame / 40) | 0) + i) % 3 + 3) % 3;
            glowRect(ctx, b + 63, F - 66 + k * 5, 6, 4.4, k === 0 ? '#ff5340' : k === 1 ? '#ffc247' : '#63ff9d', on ? 0.95 : 0.14);
          }
        }
        if (alt > 0.5) {
          // The poster. Nobody has read it since it went up.
          roundRect(ctx, a + 44, F - 104, 30, 38, 1, '#e8dcc0', INK, 1.3);
          poly(ctx, [a + 59, F - 99, a + 70, F - 81, a + 48, F - 81], p.accent, INK, 1.2);
          label(ctx, '!', a + 59, F - 87, 9, INK);
          label(ctx, 'SAFETY', a + 59, F - 76, 4.4, '#3a3a48');
          label(ctx, 'THIRD', a + 59, F - 70.5, 4.4, '#b6262c');
        }
        break;
      }

      case 'server_farm': {
        // A cooling unit, working harder than anything else in the building.
        roundRect(ctx, a, F - 58, 40, 58, 2, dim, INK, 1.6);
        ellipse(ctx, a + 20, F - 36, 14, 14, 0, '#061016', INK, 1.4);
        const rot = frame * 0.22 + i;
        for (let k = 0; k < 5; k++) {
          const ang = rot + (k * TAU) / 5;
          capsule(ctx, a + 20, F - 36, a + 20 + Math.cos(ang) * 12, F - 36 + Math.sin(ang) * 12, 2, lit, 'none', 0);
        }
        ellipse(ctx, a + 20, F - 36, 3, 3, 0, lit, INK, 1);
        for (let k = 0; k < 4; k++) roundRect(ctx, a + 5, F - 16 + k * 3.6, 30, 1.6, 0.8, shade(c, 0.4), 'none', 0);
        glowRect(ctx, a + 4, F - 55, 10, 3, p.accent, 0.7);
        // A terminal on the wall, scrolling something nobody is watching.
        roundRect(ctx, b, F - 104, 48, 34, 2, '#061016', INK, 1.5);
        for (let k = 0; k < 6; k++) {
          const row = (k + ((frame / 9) | 0)) % 11;
          ctx.fillStyle = withAlpha(hash(i * 659 + row) > 0.85 ? '#ff5b4a' : p.accent, 0.75);
          ctx.fillRect(b + 4, F - 100 + k * 5, 6 + hash(i * 661 + row) * 34, 1.8);
        }
        // Cable, in the quantity it actually comes in.
        ctx.lineCap = 'round';
        for (let k = 0; k < 5; k++) {
          ctx.strokeStyle = k % 2 === 0 ? withAlpha(p.accent, 0.55) : shade(c, 0.45);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(b + 62 + k * 3, spanTop);
          ctx.bezierCurveTo(b + 62 + k * 3, F - 90, b + 54 + k * 5, F - 40, b + 60 + k * 4, F);
          ctx.stroke();
        }
        break;
      }

      case 'social_feed': {
        // Stories: a row of faces with rings round them, some of them new.
        for (let k = 0; k < 3; k++) {
          const x = a + k * 26;
          const fresh = hash(i * 673 + k + ((frame / 90) | 0)) > 0.45;
          ellipse(ctx, x, F - 92, 10.5, 10.5, 0, 'none', fresh ? '#ff5f8d' : shade(c, 1.3), 2);
          ellipse(ctx, x, F - 92, 7.4, 7.4, 0, shade(p.mid, 1.25), INK, 1.1);
          ellipse(ctx, x, F - 94.5, 2.6, 2.6, 0, shade(c, 1.5), 'none', 0);
          ellipse(ctx, x, F - 87.5, 4.6, 3, 0, shade(c, 1.5), 'none', 0);
        }
        // Reactions, coming up off the floor and going nowhere.
        for (let k = 0; k < 5; k++) {
          const t = ((frame * (0.4 + hash(i * 677 + k) * 0.4) + k * 53 + i * 31) % 150) / 150;
          const x = b + k * 16 + Math.sin(t * 7 + k) * 5;
          const y = F - 8 - t * 120;
          ctx.globalAlpha = 0.75 * (1 - t);
          if (k % 2 === 0) heartIcon(ctx, x, y, 5 + t * 3, '#ff5f8d');
          else {
            ellipse(ctx, x, y, 4.6, 4.6, 0, p.accent, 'none', 0);
            label(ctx, '+1', x, y + 0.4, 4.6, '#06202e');
          }
          ctx.globalAlpha = 1;
        }
        // The counter. It only goes one way.
        roundRect(ctx, b + 6, F - 34, 58, 16, 4, shade(c, 0.7), INK, 1.5);
        heartIcon(ctx, b + 16, F - 26.5, 4.6, '#ff5f8d');
        label(ctx, `${(((frame / 8) | 0) + i * 911) % 100000}`.padStart(5, '0'), b + 42, F - 25.6, 7.5, '#ffffff');
        break;
      }

      case 'boardroom': {
        // A ficus in a pot that costs more than the ficus.
        roundRect(ctx, a, F - 22, 22, 22, 3, '#3a3a4e', INK, 1.5);
        roundRect(ctx, a - 2, F - 25, 26, 5, 2, p.accent, INK, 1.3);
        capsule(ctx, a + 11, F - 25, a + 11, F - 58, 1.4, '#5a4632', INK, 1.1);
        for (let k = 0; k < 7; k++) {
          const ang = -2.9 + k * 0.45;
          const r = 14 + hash(i * 683 + k) * 9;
          ellipse(
            ctx, a + 11 + Math.cos(ang) * r, F - 60 + Math.sin(ang) * r * 0.9,
            7.5, 3.4, ang, k % 2 ? '#2f5a40' : '#3f7352', INK, 1.1,
          );
        }
        // The founder, in oils, looking at something only he can see.
        roundRect(ctx, b, F - 118, 40, 52, 2, p.accent, INK, 1.6);
        roundRect(ctx, b + 4, F - 114, 32, 44, 1, '#1c2030', INK, 1.1);
        ellipse(ctx, b + 20, F - 97, 7, 8, 0, '#d9b08c', INK, 1.1);
        poly(ctx, [b + 7, F - 70, b + 12, F - 86, b + 28, F - 86, b + 33, F - 70], '#14161f', INK, 1.1);
        glowRect(ctx, b + 4, F - 122, 32, 2, light, 0.5);
        if (alt > 0.4) {
          // Water cooler. The bubble is the only thing in here with a pulse.
          roundRect(ctx, b + 56, F - 38, 16, 38, 2, '#d9d5e2', INK, 1.5);
          roundRect(ctx, b + 57, F - 62, 14, 26, 5, withAlpha('#9fd8ff', 0.6), INK, 1.4);
          const t = ((frame + i * 23) % 120) / 120;
          ellipse(ctx, b + 64, F - 40 - t * 18, 1.6 + t, 1.6 + t, 0, withAlpha('#ffffff', 0.7 * (1 - t)), 'none', 0);
        }
        break;
      }

      case 'launchpad': {
        // A propellant sphere on legs, frosted, venting.
        capsule(ctx, a + 6, F, a + 12, F - 26, 1.6, dim, INK, 1.2);
        capsule(ctx, a + 46, F, a + 40, F - 26, 1.6, dim, INK, 1.2);
        ellipse(ctx, a + 26, F - 42, 25, 23, 0, '#e2e4ee', INK, 1.8);
        ellipse(ctx, a + 18, F - 50, 9, 6, -0.5, withAlpha('#ffffff', 0.6), 'none', 0);
        roundRect(ctx, a + 6, F - 44, 40, 4, 1, p.accent, INK, 1.1);
        label(ctx, pick > 0.5 ? 'LOX' : 'CH4', a + 26, F - 32, 7, '#3a3040');
        smokePlume(ctx, a + 26, F - 66, frame, i + 11, 0.2);
        // Cones, and the hose they are supposed to be keeping you off.
        ctx.strokeStyle = '#1a1420';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a + 50, F - 3);
        ctx.bezierCurveTo(a + 80, F - 14, b, F + 2, b + 40, F - 5);
        ctx.stroke();
        for (let k = 0; k < 2; k++) {
          const x = b + 10 + k * 26;
          poly(ctx, [x, F, x + 5, F - 15, x + 8, F - 15, x + 13, F], '#ff7a3d', INK, 1.3);
          roundRect(ctx, x + 3, F - 9, 7, 2.6, 0.5, '#f4eada', 'none', 0);
          roundRect(ctx, x - 2, F - 2, 17, 2.6, 1, '#ff7a3d', INK, 1.1);
        }
        // A beacon, going round.
        const sweep = 0.5 + 0.5 * Math.sin(frame * 0.14 + i * 2);
        capsule(ctx, b + 70, F, b + 70, F - 46, 1.4, dim, INK, 1.2);
        roundRect(ctx, b + 65.5, F - 55, 9, 9, 3, '#ffb347', INK, 1.3);
        glowRect(ctx, b + 62, F - 58, 16, 15, '#ffb347', 0.12 + 0.5 * sweep);
        break;
      }

      case 'mars_dome': {
        // A habitat can, half dug in, with somebody home.
        roundRect(ctx, a, F - 34, 62, 34, 12, shade(c, 1.1), INK, 1.8);
        for (let k = 0; k < 4; k++) capsule(ctx, a + 10 + k * 14, F - 33, a + 10 + k * 14, F - 2, 0.6, shade(c, 0.7), 'none', 0);
        ellipse(ctx, a + 20, F - 18, 7, 7, 0, '#1c0e0a', INK, 1.4);
        glowRect(ctx, a + 15.5, F - 22.5, 9, 9, light, 0.55 + 0.1 * Math.sin(frame * 0.03 + i));
        roundRect(ctx, a + 40, F - 22, 12, 22, 2, shade(c, 0.6), INK, 1.3);
        label(ctx, `HAB-${(Math.abs(i) % 9) + 1}`, a + 31, F - 40, 5.4, withAlpha(p.accent, 0.8));
        // A panel, tracking a sun that is a long way off.
        capsule(ctx, b + 24, F, b + 24, F - 26, 1.4, dim, INK, 1.2);
        poly(ctx, [b, F - 28, b + 44, F - 44, b + 48, F - 38, b + 4, F - 22], '#22324e', INK, 1.5);
        ctx.strokeStyle = withAlpha('#7fb0ff', 0.45);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let k = 1; k < 5; k++) {
          ctx.moveTo(b + k * 9, F - 28 - k * 3.2);
          ctx.lineTo(b + 4 + k * 9, F - 22 - k * 3.2);
        }
        ctx.stroke();
        // A mast, with a light on top to warn aircraft there are none of.
        capsule(ctx, b + 70, F, b + 70, F - 84, 0.9, dim, INK, 1);
        capsule(ctx, b + 62, F - 60, b + 78, F - 60, 0.7, dim, 'none', 0);
        glowRect(ctx, b + 68.5, F - 88, 3, 3, '#ff4b4b', (frame + i * 29) % 90 < 22 ? 0.95 : 0.1);
        break;
      }

      case 'orbit': {
        // A hatch. The wheel is the manual backup. Do not think about why.
        roundRect(ctx, a, F - 76, 46, 76, 6, dim, INK, 1.7);
        ellipse(ctx, a + 23, F - 40, 17, 22, 0, shade(c, 1.15), INK, 1.5);
        ellipse(ctx, a + 23, F - 40, 8, 8, 0, 'none', lit, 1.6);
        for (let k = 0; k < 3; k++) {
          const ang = (k * TAU) / 3 + 0.3;
          capsule(ctx, a + 23, F - 40, a + 23 + Math.cos(ang) * 8, F - 40 + Math.sin(ang) * 8, 0.8, lit, 'none', 0);
        }
        glowRect(ctx, a + 16, F - 72, 14, 3, (frame + i * 41) % 140 < 110 ? '#63ff9d' : '#ff5340', 0.85);
        // A handrail, and a panel of the readings you would rather not read.
        capsule(ctx, b - 8, F - 34, b + 78, F - 34, 1.3, lit, INK, 1.1);
        for (let k = 0; k < 3; k++) capsule(ctx, b + k * 35, F - 34, b + k * 35, F - 27, 1, lit, INK, 1);
        roundRect(ctx, b + 8, F - 100, 52, 36, 3, '#050a16', INK, 1.5);
        ctx.strokeStyle = withAlpha(p.accent, 0.8);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let k = 0; k <= 22; k++) {
          const x = b + 12 + k * 2;
          const y = F - 82 + Math.sin(k * 0.7 + frame * 0.08 + i) * 6 * (k % 7 === 3 ? 1.8 : 0.5);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        glowRect(ctx, b + 12, F - 71, 18, 2, p.accent, 0.5);
        break;
      }
    }
  });
}

// ── In front of everything ───────────────────────────────────────────────────

/**
 * What hangs between the camera and the fight.
 *
 * Bound to the VIEW, not to the authored frame: the foreground pass runs in a
 * space the fight's zoom has already cropped, and anything positioned against
 * the frame's own edges lands off the screen there. It scrolls faster than the
 * floor does, which is the whole point of it — the only band that says the
 * camera itself is somewhere, standing behind something.
 *
 * Top edge only, and dark. The bottom edge is where the front rank of the
 * fight stands, and nothing is allowed to stand in front of their feet.
 */
function canopy(ctx: C2D, d: Dressing, p: MapPalette, camX: number, frame: number): void {
  if (d.canopy === 'none') return;
  const top = viewY;
  const c = shade(p.near, 0.34);
  const edge = shade(p.near, 0.62);

  switch (d.canopy) {
    case 'cables':
      ctx.lineCap = 'round';
      tiles(camX, PAR_FORE, 170, 120, (i, sx) => {
        for (let k = 0; k < 3; k++) {
          const sag = 12 + hash(i * 467 + k) * 16;
          ctx.strokeStyle = k === 1 ? edge : c;
          ctx.lineWidth = 2.2 - k * 0.5;
          ctx.beginPath();
          ctx.moveTo(sx - 20 + k * 14, top - 4);
          ctx.quadraticCurveTo(sx + 85, top + sag + k * 3, sx + 190 + k * 14, top - 4);
          ctx.stroke();
        }
        roundRect(ctx, sx + 80, top - 3, 10, 8, 2, c, INK, 1.2);
      });
      break;
    case 'pipes':
      roundRect(ctx, spanX, top - 6, spanW, 12, 0, c, 'none', 0);
      ctx.fillStyle = edge;
      fillSpan(ctx, top + 4.5, 1.5);
      tiles(camX, PAR_FORE, 140, 60, (i, sx) => {
        roundRect(ctx, sx, top - 7, 9, 15, 2, edge, INK, 1.3);
        if (hash(i * 479) > 0.55) {
          // A valve, and the wisp that says it does not quite close.
          roundRect(ctx, sx + 58, top + 4, 6, 9, 2, c, INK, 1.2);
          ellipse(ctx, sx + 61, top + 15, 6, 2, 0, p.accent, INK, 1.1);
          const t = ((frame * 0.5 + i * 31) % 60) / 60;
          ctx.globalAlpha = 0.16 * (1 - t);
          ellipse(ctx, sx + 61 + t * 5, top + 18 + t * 16, 3 + t * 7, 3 + t * 6, 0, '#e6e2f0', 'none', 0);
          ctx.globalAlpha = 1;
        }
      });
      break;
    case 'beams':
      roundRect(ctx, spanX, top - 8, spanW, 14, 0, c, 'none', 0);
      ctx.fillStyle = edge;
      fillSpan(ctx, top + 5, 1.5);
      tiles(camX, PAR_FORE, 190, 80, (i, sx) => {
        // A knee brace down off the beam, and the bolts that hold it.
        poly(ctx, [sx, top + 5, sx + 12, top + 5, sx + 4, top + 26, sx - 3, top + 26], c, INK, 1.4);
        ctx.fillStyle = edge;
        ctx.fillRect(sx + 3, top + 1, 2, 2);
        ctx.fillRect(sx + 96 + (i % 3) * 8, top + 1, 2, 2);
      });
      break;
    case 'leaves':
      tiles(camX, PAR_FORE, 120, 120, (i, sx) => {
        // A bough, and what is still on it.
        ctx.strokeStyle = shade(p.near, 0.26);
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx - 10, top - 6);
        ctx.quadraticCurveTo(sx + 50, top + 10 + hash(i * 487) * 8, sx + 120, top - 2);
        ctx.stroke();
        for (let k = 0; k < 9; k++) {
          const lx = sx + hash(i * 491 + k) * 120;
          const ly = top + 2 + hash(i * 499 + k) * 18 + Math.sin(frame * 0.02 + i + k) * 1.2;
          ellipse(
            ctx, lx, ly,
            6 + hash(i * 503 + k) * 6, 3.4,
            hash(i * 509 + k) * 3 - 1.5,
            k % 3 === 0 ? edge : c, 'none', 0,
          );
        }
      });
      break;
    case 'wires':
      ctx.strokeStyle = c;
      ctx.lineCap = 'round';
      tiles(camX, PAR_FORE, 260, 140, (i, sx) => {
        for (let k = 0; k < 2; k++) {
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(sx, top + 2 + k * 6);
          ctx.quadraticCurveTo(sx + 130, top + 20 + k * 7, sx + 260, top + 2 + k * 6);
          ctx.stroke();
        }
        if (hash(i * 521) > 0.6) {
          // Something that has seen worse than this, and is not leaving.
          const bx = sx + 90 + hash(i * 523) * 80;
          const by = top + 15;
          ellipse(ctx, bx, by, 4.4, 3, 0, '#16131c', 'none', 0);
          ellipse(ctx, bx + 3.4, by - 2.4, 2, 1.8, 0, '#16131c', 'none', 0);
          poly(ctx, [bx + 5, by - 2.6, bx + 7.6, by - 2, bx + 5, by - 1.6], '#c9a24a', 'none', 0);
        }
      });
      break;
  }
}

/**
 * Dust in the light. Every theme has air, and the only way to draw air is to
 * put something small in it and let the lamps catch it.
 */
function motes(ctx: C2D, d: Dressing, p: MapPalette, camX: number, frame: number): void {
  if (d.mist <= 0.01) return;
  const count = Math.round(26 * spanDensity * d.mist);
  const light = lightOf(d, p);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = mix(light, '#ffffff', 0.5);
  for (let i = 0; i < count; i++) {
    const x = driftX(i * 541 + 3, -camX * (0.9 + hash(i * 547) * 0.5) + Math.sin(frame * 0.008 + i) * 16);
    const y = driftY(i * 557 + 5, -frame * (0.08 + hash(i * 563) * 0.14));
    ctx.globalAlpha = 0.1 + 0.16 * (0.5 + 0.5 * Math.sin(frame * 0.03 + i * 2.1));
    const r = 0.6 + hash(i * 569) * 0.9;
    ctx.fillRect(x, y, r, r);
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export function drawBackdrop(ctx: C2D, def: MapDef, cam: Camera, frame: number): void {
  const p = def.palette;
  const camX = cam.x;
  const tone = toneFor(p);

  ctx.save();
  ctx.textBaseline = 'middle';
  syncViewport(ctx, cam);

  const d = DRESSING[def.theme];

  sky(ctx, def.theme, p, camX, frame);
  backGlow(ctx, d, p);
  farLayer(ctx, def.theme, p, camX, frame);
  wash(ctx, tone.farWash, tone.farWashA);
  mistBank(ctx, d, p, camX, frame, 0.2, FLOOR_TOP - 96, 100, 0.5);
  midLayer(ctx, def.theme, p, camX, frame);
  wash(ctx, tone.midWash, tone.midWashA);
  haze(ctx, tone);
  mistBank(ctx, d, p, camX, frame, 0.48, FLOOR_TOP - 60, 68, 0.42);
  nearLayer(ctx, def.theme, p, camX, frame);
  backWall(ctx, def.theme, d, p, camX, frame);
  actionScrim(ctx, tone);
  ground(ctx, def.theme, p, tone, camX, frame);
  lamps(ctx, d, p, camX, frame);

  ctx.restore();
}

export function drawForeground(ctx: C2D, def: MapDef, cam: Camera, frame: number): void {
  const p = def.palette;
  const camX = cam.x;
  const tone = toneFor(p);

  ctx.save();
  ctx.textBaseline = 'middle';
  syncViewport(ctx, cam);

  const d = DRESSING[def.theme];

  foreLayer(ctx, def.theme, p, camX, frame);
  canopy(ctx, d, p, camX, frame);
  weather(ctx, def.theme, p, camX, frame);
  motes(ctx, d, p, camX, frame);
  vignette(ctx, tone);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Depth passes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step of atmospheric perspective over everything drawn so far. Only the
 * area above the floor line needs it — the ground plane is painted opaque over
 * the rest — which keeps this to a partial-height fill.
 */
function wash(ctx: C2D, color: string, alpha: number): void {
  if (alpha <= 0.004) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  fillSpan(ctx, spanTop, FLOOR_TOP + 4 - spanTop);
  ctx.restore();
}

/**
 * The band directly behind the fight, quietened. Not a grey rectangle: it fades
 * in from nothing over most of a character's height and is cut off dead at the
 * floor line, where the opaque ground takes over, so it reads as the scenery
 * receding rather than as a panel laid over it.
 */
function actionScrim(ctx: C2D, tone: Tone): void {
  const top = FLOOR_TOP - SCRIM_H;
  ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(0, top, 0, FLOOR_TOP + 2);
  g.addColorStop(0, tone.scrimTop);
  g.addColorStop(0.46, tone.scrimMid);
  g.addColorStop(1, tone.scrimBottom);
  ctx.fillStyle = g;
  fillSpan(ctx, top, SCRIM_H + 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sky
// ─────────────────────────────────────────────────────────────────────────────

function sky(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, FLOOR_TOP + 10);
  g.addColorStop(0, p.sky[0]);
  g.addColorStop(1, p.sky[1]);
  ctx.fillStyle = g;
  fillSpan(ctx, spanTop, FLOOR_TOP + 12 - spanTop);

  switch (theme) {
    case 'orbit':
      starfield(ctx, camX, frame, 150, 1);
      earthLimb(ctx, camX, frame);
      break;
    case 'mars_dome':
      starfield(ctx, camX, frame, 60, 0.5);
      distantEarth(ctx, camX, frame);
      break;
    case 'launchpad': {
      // Pre-dawn launch window: thin cloud decks and a low sun.
      const sunX = 470 - camX * 0.03;
      ctx.globalAlpha = 0.5;
      ellipse(ctx, sunX, 118, 26, 26, 0, withAlpha(p.accent, 0.5), 'none', 0);
      ctx.globalAlpha = 1;
      cloudDeck(ctx, camX, 0.05, 96, 0.16, '#ffffff');
      cloudDeck(ctx, camX, 0.09, 134, 0.12, p.accent);
      break;
    }
    case 'suburb':
      cloudDeck(ctx, camX, 0.06, 74, 0.5, '#ffffff');
      cloudDeck(ctx, camX, 0.1, 108, 0.32, '#ffffff');
      break;
    case 'forest':
      cloudDeck(ctx, camX, 0.05, 62, 0.22, '#ffffff');
      godRays(ctx, camX, frame, p);
      break;
    case 'boardroom':
      // The "sky" is what you see through the glass: a bruised city dusk.
      cloudDeck(ctx, camX, 0.04, 60, 0.14, p.accent);
      break;
    case 'social_feed':
      feedSky(ctx, camX, frame, p);
      break;
    default:
      break;
  }
}

function starfield(ctx: C2D, camX: number, frame: number, count: number, brightness: number): void {
  const off = camX * 0.02;
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = (hash(i * 3) * (VIEW_W + 200) - off) % (VIEW_W + 200);
    const sx = x < 0 ? x + VIEW_W + 200 : x;
    const sy = hash(i * 7 + 1) * (FLOOR_TOP - 20);
    const tw = 0.55 + 0.45 * Math.sin(frame * 0.04 + i * 1.7);
    const r = hrange(i * 11, 0.35, 1.15);
    ctx.globalAlpha = clamp(tw * brightness * hrange(i * 5, 0.4, 1), 0, 1);
    ctx.fillStyle = '#eaf2ff';
    ctx.fillRect(sx - 100, sy, r, r);
  }
  ctx.restore();
}

function earthLimb(ctx: C2D, camX: number, frame: number): void {
  const cx = 210 - camX * 0.04;
  const cy = 430;
  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, 200, cx, cy, 300);
  g.addColorStop(0, '#1d5fb0');
  g.addColorStop(0.72, '#2f86d8');
  g.addColorStop(1, '#0a2138');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 268, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#3f8f5c';
  for (let i = 0; i < 7; i++) {
    const a = -1.9 + hash(i * 13) * 1.6;
    const rr = 250 - hash(i * 17) * 34;
    ellipse(
      ctx,
      cx + Math.cos(a) * rr,
      cy + Math.sin(a) * rr,
      hrange(i * 23, 12, 34),
      hrange(i * 29, 6, 15),
      a,
      '#3f8f5c',
      'none',
      0,
    );
  }
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 9; i++) {
    const a = -2.4 + ((hash(i * 31) + frame * 0.00018) % 1) * 2.2;
    const rr = 258 - hash(i * 37) * 26;
    ellipse(ctx, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 26, 7, a, '#ffffff', 'none', 0);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function distantEarth(ctx: C2D, camX: number, frame: number): void {
  const x = 528 - camX * 0.02;
  const y = 62;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.35 + 0.08 * Math.sin(frame * 0.03);
  ellipse(ctx, x, y, 7, 7, 0, '#6fb7ff', 'none', 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ellipse(ctx, x, y, 2.6, 2.6, 0, '#a9d6ff', 'none', 0);
  label(ctx, 'HOME', x, y + 13, 6, 'rgba(200,225,255,0.5)');
  ctx.restore();
}

function cloudDeck(
  ctx: C2D,
  camX: number,
  parallax: number,
  y: number,
  alpha: number,
  color: string,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  tiles(camX, parallax, 190, 140, (i, sx) => {
    const cx = sx + hrange(i * 41, 0, 120);
    const cy = y + hrange(i * 43, -14, 14);
    const w = hrange(i * 47, 42, 86);
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, w * 0.3, 0, 0, TAU);
    ctx.ellipse(cx + w * 0.45, cy - 5, w * 0.5, w * 0.24, 0, 0, TAU);
    ctx.ellipse(cx - w * 0.5, cy + 2, w * 0.42, w * 0.2, 0, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
}

function godRays(ctx: C2D, camX: number, frame: number, p: MapPalette): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  tiles(camX, 0.2, 120, 80, (i, sx) => {
    const a = 0.05 + 0.03 * Math.sin(frame * 0.012 + i);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.moveTo(sx + 10, -10);
    ctx.lineTo(sx + 44, -10);
    ctx.lineTo(sx + 4, FLOOR_TOP);
    ctx.lineTo(sx - 34, FLOOR_TOP);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();
}

/** The feed never stops: a wall of posts crawling upward behind everything. */
function feedSky(ctx: C2D, camX: number, frame: number, p: MapPalette): void {
  const scroll = frame * 0.35;
  const cols = Math.ceil(spanW / 132) + 1;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let col = 0; col < cols; col++) {
    const cx = spanX + col * 132 - ((camX * 0.16) % 132) - 40;
    for (let row = -1; row < 6; row++) {
      const yy = ((row * 62 + scroll) % (FLOOR_TOP + 130)) - 60;
      const seed = col * 91 + row * 13 + Math.floor((row * 62 + scroll) / (FLOOR_TOP + 130)) * 7;
      const h = 46;
      roundRect(ctx, cx, yy, 118, h, 4, shade(p.far, 1.15), 'none', 0);
      ellipse(ctx, cx + 13, yy + 13, 6, 6, 0, p.accent, 'none', 0);
      ctx.fillStyle = withAlpha('#ffffff', 0.35);
      ctx.fillRect(cx + 24, yy + 9, hrange(seed, 30, 74), 4);
      ctx.fillRect(cx + 8, yy + 24, hrange(seed + 1, 46, 100), 3);
      ctx.fillRect(cx + 8, yy + 31, hrange(seed + 2, 30, 92), 3);
      ctx.fillStyle = withAlpha(p.accent, 0.85);
      ctx.fillRect(cx + 8, yy + 39, 22, 3);
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Far band
// ─────────────────────────────────────────────────────────────────────────────

function farLayer(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const c = p.far;
  switch (theme) {
    case 'tunnel': {
      // The bore vanishing away into the dark, with the next station glowing.
      ctx.fillStyle = shade(c, 0.6);
      fillSpan(ctx, 40, FLOOR_TOP - 40);
      tiles(camX, PAR_FAR, 260, 200, (i, sx) => {
        const cx = sx + 130;
        const glow = 0.35 + 0.2 * Math.sin(frame * 0.02 + i);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = glow * 0.5;
        ellipse(ctx, cx, 176, 54, 40, 0, p.accent, 'none', 0);
        ctx.restore();
        ellipse(ctx, cx, 176, 26, 20, 0, shade(c, 0.35), 'none', 0);
      });
      break;
    }
    case 'factory':
    case 'gigafactory': {
      skylineBlocks(ctx, camX, PAR_FAR, c, 150, 90, 26, 200);
      tiles(camX, PAR_FAR, 150, 100, (i, sx) => {
        if (hash(i * 61) < 0.45) return;
        const x = sx + hrange(i * 63, 20, 110);
        const h = hrange(i * 67, 70, 120);
        roundRect(ctx, x, FLOOR_TOP - h, 16, h, 2, shade(c, 0.85), 'none', 0);
        roundRect(ctx, x - 3, FLOOR_TOP - h, 22, 8, 2, shade(c, 1.2), 'none', 0);
        smokePlume(ctx, x + 8, FLOOR_TOP - h - 4, frame, i, 0.16);
      });
      break;
    }
    case 'server_farm': {
      ctx.fillStyle = shade(c, 0.7);
      fillSpan(ctx, 30, FLOOR_TOP - 30);
      tiles(camX, PAR_FAR, 46, 60, (i, sx) => {
        const h = 96 + (i % 3) * 8;
        roundRect(ctx, sx, FLOOR_TOP - h, 36, h, 2, shade(c, 1.1), 'none', 0);
        ledColumn(ctx, sx + 6, FLOOR_TOP - h + 8, 24, h - 16, 5, frame, i * 31, p.accent, 0.5);
      });
      break;
    }
    case 'launchpad': {
      skylineBlocks(ctx, camX, PAR_FAR, c, 210, 40, 14, 300);
      break;
    }
    case 'mars_dome': {
      // Rolling regolith hills.
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(spanX - 200, FLOOR_TOP);
      tiles(camX, PAR_FAR, 90, 120, (i, sx) => {
        ctx.lineTo(sx, FLOOR_TOP - hrange(i * 71, 22, 62));
        ctx.lineTo(sx + 45, FLOOR_TOP - hrange(i * 73, 10, 40));
      });
      ctx.lineTo(spanX + spanW + 200, FLOOR_TOP);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'boardroom': {
      citySkyline(ctx, camX, PAR_FAR, c, p.accent, frame);
      break;
    }
    case 'social_feed': {
      tiles(camX, PAR_FAR, 210, 120, (i, sx) => {
        const on = hash(i * 3 + ((frame / 26) | 0)) > 0.08;
        const cx = sx + 60;
        const cy = 96 + hrange(i * 9, -22, 22);
        heartIcon(ctx, cx, cy, 26, withAlpha(p.accent, on ? 0.4 : 0.12));
      });
      break;
    }
    case 'suburb': {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(spanX - 200, FLOOR_TOP);
      tiles(camX, PAR_FAR, 130, 140, (i, sx) => {
        ctx.lineTo(sx, FLOOR_TOP - hrange(i * 79, 30, 74));
        ctx.lineTo(sx + 65, FLOOR_TOP - hrange(i * 83, 16, 50));
      });
      ctx.lineTo(spanX + spanW + 200, FLOOR_TOP);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'mine': {
      ctx.fillStyle = shade(c, 0.55);
      fillSpan(ctx, spanTop, FLOOR_TOP - spanTop);
      caveWall(ctx, camX, PAR_FAR, c, 42, 120);
      break;
    }
    case 'forest': {
      treeLine(ctx, camX, PAR_FAR, withAlpha(c, 0.8), 150, 34, 20);
      break;
    }
    case 'orbit': {
      // A slow-turning ring station, far off the port bow.
      const x = 96 - camX * PAR_FAR * 0.3;
      const rot = frame * 0.0016;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(x, 84);
      ctx.rotate(rot);
      ellipse(ctx, 0, 0, 44, 12, 0, 'none', shade(c, 1.5), 3);
      ellipse(ctx, 0, 0, 9, 3.4, 0, shade(c, 1.3), 'none', 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      break;
    }
    default:
      break;
  }
}

function skylineBlocks(
  ctx: C2D,
  camX: number,
  par: number,
  color: string,
  spacing: number,
  hMax: number,
  hMin: number,
  pad: number,
): void {
  tiles(camX, par, spacing, pad, (i, sx) => {
    const w = hrange(i * 13, spacing * 0.45, spacing * 0.95);
    const h = hrange(i * 17, hMin, hMax);
    roundRect(ctx, sx, FLOOR_TOP - h, w, h + 4, 1.5, color, 'none', 0);
  });
}

function citySkyline(
  ctx: C2D,
  camX: number,
  par: number,
  color: string,
  accent: string,
  frame: number,
): void {
  tiles(camX, par, 62, 90, (i, sx) => {
    const w = hrange(i * 19, 26, 52);
    const h = hrange(i * 23, 60, 190);
    roundRect(ctx, sx, FLOOR_TOP - h, w, h + 4, 1, color, 'none', 0);
    const cols = Math.max(1, Math.floor(w / 9));
    const rows = Math.max(1, Math.floor(h / 12));
    for (let cx = 0; cx < cols; cx++) {
      for (let ry = 0; ry < rows; ry++) {
        const seed = i * 733 + cx * 31 + ry * 7;
        if (hash(seed) < 0.55) continue;
        const flick = hash(seed + ((frame / 47) | 0) * 13) > 0.06 ? 1 : 0.2;
        ctx.globalAlpha = 0.5 * flick;
        ctx.fillStyle = hash(seed + 3) > 0.85 ? accent : '#ffe9a8';
        ctx.fillRect(sx + 3 + cx * 9, FLOOR_TOP - h + 6 + ry * 12, 3.5, 5);
      }
    }
    ctx.globalAlpha = 1;
    // Aircraft warning light on the tall ones.
    if (h > 150) {
      const on = (frame % 84) < 26;
      if (on) glowRect(ctx, sx + w * 0.5 - 1, FLOOR_TOP - h - 4, 2, 2, '#ff4b4b', 0.9);
    }
  });
}

function caveWall(ctx: C2D, camX: number, par: number, color: string, amp: number, spacing: number): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(spanX - 200, FLOOR_TOP + 10);
  tiles(camX, par, spacing, 140, (i, sx) => {
    ctx.lineTo(sx, 40 + hrange(i * 89, 0, amp));
    ctx.lineTo(sx + spacing * 0.5, 24 + hrange(i * 97, 0, amp));
  });
  ctx.lineTo(spanX + spanW + 200, FLOOR_TOP + 10);
  ctx.closePath();
  ctx.fill();
}

function treeLine(
  ctx: C2D,
  camX: number,
  par: number,
  color: string,
  spacing: number,
  hMin: number,
  count: number,
): void {
  tiles(camX, par, spacing, 120, (i, sx) => {
    for (let k = 0; k < count; k++) {
      const x = sx + hrange(i * 101 + k * 7, 0, spacing);
      const h = hMin + hrange(i * 103 + k * 11, 20, 92);
      const w = h * 0.26;
      poly(
        ctx,
        [x, FLOOR_TOP - h, x + w, FLOOR_TOP + 6, x - w, FLOOR_TOP + 6],
        color,
        'none',
        0,
      );
    }
  });
}

function heartIcon(ctx: C2D, x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.55);
  ctx.bezierCurveTo(x - s, y - s * 0.1, x - s * 0.5, y - s * 0.72, x, y - s * 0.22);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.72, x + s, y - s * 0.1, x, y + s * 0.55);
  ctx.closePath();
  ctx.fill();
}

function smokePlume(ctx: C2D, x: number, y: number, frame: number, seed: number, alpha: number): void {
  ctx.save();
  ctx.fillStyle = '#c9c4d6';
  for (let k = 0; k < 5; k++) {
    const t = ((frame * 0.35 + k * 26 + hash(seed + k) * 40) % 130) / 130;
    const r = 5 + t * 22;
    ctx.globalAlpha = alpha * (1 - t);
    ctx.beginPath();
    ctx.arc(x + Math.sin(t * 4 + seed) * 14 * t, y - t * 78, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function ledColumn(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cols: number,
  frame: number,
  seed: number,
  accent: string,
  alpha: number,
): void {
  const rows = Math.max(1, Math.floor(h / 5));
  const step = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = seed + r * 17 + c * 5;
      const on = hash(s + ((frame / 7) | 0) * 3) > 0.42;
      if (!on) continue;
      ctx.globalAlpha = alpha * hrange(s, 0.5, 1);
      ctx.fillStyle = hash(s + 2) > 0.78 ? '#ff5b4a' : hash(s + 3) > 0.5 ? accent : '#63ff9d';
      ctx.fillRect(x + (c * w) / cols, y + r * step, 1.6, 1.6);
    }
  }
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mid band — where each theme has to be recognisable in one glance
// ─────────────────────────────────────────────────────────────────────────────

function midLayer(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const c = p.mid;
  switch (theme) {
    case 'tunnel':
      tunnelRings(ctx, c, p.accent, camX, frame);
      break;
    case 'factory':
      factoryMid(ctx, c, p.accent, camX, frame);
      break;
    case 'server_farm':
      serverMid(ctx, c, p.accent, camX, frame);
      break;
    case 'launchpad':
      launchpadMid(ctx, c, p.accent, camX, frame);
      break;
    case 'mars_dome':
      marsMid(ctx, c, p.accent, camX, frame);
      break;
    case 'boardroom':
      boardroomMid(ctx, c, p.accent, camX, frame);
      break;
    case 'social_feed':
      feedMid(ctx, c, p.accent, camX, frame);
      break;
    case 'suburb':
      suburbMid(ctx, c, p.accent, camX, frame);
      break;
    case 'mine':
      mineMid(ctx, c, p.accent, camX, frame);
      break;
    case 'forest':
      forestMid(ctx, c, p.accent, camX, frame);
      break;
    case 'gigafactory':
      gigafactoryMid(ctx, c, p.accent, camX, frame);
      break;
    case 'orbit':
      orbitMid(ctx, c, p.accent, camX, frame);
      break;
    default:
      break;
  }
}

/** Concrete bore rings and the strip light running the length of the roof. */
function tunnelRings(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  const dark = shade(c, 0.72);
  tiles(camX, PAR_MID, 76, 90, (i, sx) => {
    const ringW = 12;
    ctx.fillStyle = i % 2 === 0 ? c : dark;
    ctx.beginPath();
    ctx.moveTo(sx, FLOOR_TOP + 6);
    ctx.quadraticCurveTo(sx + 38, 4, sx + 76, FLOOR_TOP + 6);
    ctx.lineTo(sx + 76 - ringW, FLOOR_TOP + 6);
    ctx.quadraticCurveTo(sx + 38, 4 + ringW * 1.6, sx + ringW, FLOOR_TOP + 6);
    ctx.closePath();
    ctx.fill();

    // Strip light on the crown; every so often one is dying.
    const dying = hash(i * 5) > 0.82;
    const on = dying ? hash(i * 5 + ((frame / 4) | 0)) > 0.4 : true;
    glowRect(ctx, sx + 24, 26, 30, 3, '#dff3ff', on ? 0.9 : 0.08);

    if (i % 4 === 0) {
      ctx.globalAlpha = 0.55;
      label(ctx, 'BORING CO.', sx + 38, 62, 7, withAlpha(accent, 0.8));
      label(ctx, `SEG ${((i % 90) + 10).toString()}`, sx + 38, 72, 5.5, 'rgba(255,255,255,0.35)');
      ctx.globalAlpha = 1;
    }
  });
  // Hazard chevrons along the haunch of the bore.
  tiles(camX, PAR_MID, 38, 60, (i, sx) => {
    ctx.globalAlpha = 0.35;
    poly(
      ctx,
      [sx, 196, sx + 12, 190, sx + 12, 198, sx, 204],
      i % 2 === 0 ? accent : '#2a2733',
      'none',
      0,
    );
    ctx.globalAlpha = 1;
  });
}

function factoryMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  tiles(camX, PAR_MID, 128, 90, (i, sx) => {
    const h = hrange(i * 107, 74, 132);
    roundRect(ctx, sx, FLOOR_TOP - h, 104, h, 3, c, INK, 1.4);
    roundRect(ctx, sx + 10, FLOOR_TOP - h + 10, 36, 22, 2, shade(c, 0.7), 'none', 0);
    // Pumping piston.
    const t = (Math.sin(frame * 0.06 + i) + 1) * 0.5;
    roundRect(ctx, sx + 62, FLOOR_TOP - h + 14 + t * 16, 12, 30, 2, shade(c, 1.35), INK, 1.2);
    // Hazard band.
    for (let k = 0; k < 8; k++) {
      ctx.globalAlpha = 0.6;
      poly(
        ctx,
        [
          sx + 8 + k * 12,
          FLOOR_TOP - 16,
          sx + 16 + k * 12,
          FLOOR_TOP - 16,
          sx + 10 + k * 12,
          FLOOR_TOP - 6,
          sx + 2 + k * 12,
          FLOOR_TOP - 6,
        ],
        k % 2 === 0 ? accent : '#1b1720',
        'none',
        0,
      );
      ctx.globalAlpha = 1;
    }
    if (i % 3 === 0) label(ctx, 'UNIT 404', sx + 52, FLOOR_TOP - h + 46, 7, withAlpha(accent, 0.7));
  });
}

function serverMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  tiles(camX, PAR_MID, 54, 70, (i, sx) => {
    const h = 132;
    const top = FLOOR_TOP - h;
    roundRect(ctx, sx, top, 44, h, 2, c, INK, 1.5);
    roundRect(ctx, sx + 3, top + 4, 38, h - 12, 1, shade(c, 0.55), 'none', 0);
    for (let u = 0; u < 14; u++) {
      const y = top + 8 + u * ((h - 18) / 14);
      roundRect(ctx, sx + 5, y, 34, 5, 1, shade(c, 1.25), 'none', 0);
      const on = hash(i * 91 + u * 13 + ((frame / 6) | 0)) > 0.35;
      if (on) {
        ctx.fillStyle = hash(i * 7 + u) > 0.8 ? '#ff5b4a' : '#63ff9d';
        ctx.fillRect(sx + 7, y + 1.6, 1.8, 1.8);
      }
      ctx.fillStyle = withAlpha(accent, 0.6);
      ctx.fillRect(sx + 11, y + 1.6, hrange(i * 3 + u, 3, 18), 1.4);
    }
    // Cold-aisle glow between the rows.
    glowRect(ctx, sx + 45, top + 20, 8, h - 30, accent, 0.09 + 0.03 * Math.sin(frame * 0.03 + i));
    if (i % 4 === 0) label(ctx, 'GROK-11', sx + 22, top - 8, 6.5, withAlpha(accent, 0.75));
  });
}

function launchpadMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  // The rocket, sitting on the pad, is the anchor of the composition.
  const rx = 470 - camX * PAR_MID;
  const base = FLOOR_TOP + 4;
  if (rx > spanX - 140 && rx < spanX + spanW + 140) {
    roundRect(ctx, rx - 16, base - 190, 32, 190, 12, '#e7e9f0', INK, 2);
    poly(ctx, [rx, base - 232, rx + 16, base - 182, rx - 16, base - 182], '#e7e9f0', INK, 2);
    roundRect(ctx, rx - 16, base - 118, 32, 8, 2, shade(accent, 0.9), 'none', 0);
    label(ctx, 'X', rx, base - 150, 15, '#171520');
    poly(ctx, [rx - 16, base - 26, rx - 30, base, rx - 16, base], '#c9ccd8', INK, 1.6);
    poly(ctx, [rx + 16, base - 26, rx + 30, base, rx + 16, base], '#c9ccd8', INK, 1.6);
    // Venting LOX.
    smokePlume(ctx, rx + 20, base - 96, frame, 4, 0.3);
    smokePlume(ctx, rx - 22, base - 60, frame, 9, 0.22);
  }
  // Gantry towers.
  tiles(camX, PAR_MID, 190, 100, (i, sx) => {
    const h = 168;
    const top = FLOOR_TOP - h;
    roundRect(ctx, sx, top, 9, h, 1, c, INK, 1.4);
    roundRect(ctx, sx + 54, top, 9, h, 1, c, INK, 1.4);
    for (let k = 0; k < 9; k++) {
      const y = top + 8 + k * ((h - 16) / 9);
      ctx.strokeStyle = shade(c, 1.2);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx + 9, y);
      ctx.lineTo(sx + 54, y + 8);
      ctx.moveTo(sx + 54, y);
      ctx.lineTo(sx + 9, y + 8);
      ctx.stroke();
    }
    // Floodlight with a visible beam.
    const on = hash(i * 3) > 0.25;
    if (on) {
      glowRect(ctx, sx + 24, top - 8, 14, 6, '#fff3c4', 0.85);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.07 + 0.02 * Math.sin(frame * 0.05 + i);
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath();
      ctx.moveTo(sx + 24, top - 4);
      ctx.lineTo(sx + 38, top - 4);
      ctx.lineTo(sx + 96, FLOOR_TOP + 10);
      ctx.lineTo(sx - 34, FLOOR_TOP + 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  });
}

function marsMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  // The geodesic shell: triangles picked out in glass and steel.
  const cx = VIEW_W * 0.5 - camX * PAR_MID * 0.25;
  const r = 300;
  const cy = FLOOR_TOP + r - 168;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.15, Math.PI * 1.85);
  ctx.lineTo(cx + r, FLOOR_TOP);
  ctx.lineTo(cx - r, FLOOR_TOP);
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = withAlpha(accent, 0.5);
  ctx.lineWidth = 1.4;
  for (let i = -9; i <= 9; i++) {
    const a = Math.PI * 1.5 + i * 0.075;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r * 1.1, cy + Math.sin(a) * r * 1.1);
    ctx.stroke();
  }
  for (let k = 1; k <= 4; k++) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.55 + k * 0.12), Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#bfe6ff';
  ctx.fillRect(cx - r, cy - r, r * 2, r);
  ctx.restore();

  // Habitat cans dug into the dust.
  tiles(camX, PAR_MID, 150, 90, (i, sx) => {
    const w = 88;
    const h = 40;
    roundRect(ctx, sx, FLOOR_TOP - h, w, h + 6, h * 0.5, c, INK, 1.6);
    ellipse(ctx, sx + w * 0.5, FLOOR_TOP - h * 0.5, 9, 9, 0, shade(accent, 0.8), INK, 1.4);
    glowRect(ctx, sx + w * 0.5 - 3, FLOOR_TOP - h * 0.5 - 3, 6, 6, accent, 0.5);
    if (i % 2 === 0) label(ctx, 'HAB-7', sx + 20, FLOOR_TOP - h - 8, 6.5, withAlpha(accent, 0.7));
    // Dust devil.
    const t = ((frame * 0.9 + i * 90) % 460) / 460;
    ctx.save();
    ctx.globalAlpha = 0.12 * Math.sin(t * Math.PI);
    ctx.fillStyle = shade(c, 1.5);
    for (let k = 0; k < 6; k++) {
      const yy = FLOOR_TOP - k * 12;
      const rr = 5 + k * 2.2;
      ctx.beginPath();
      ctx.ellipse(sx + 120 + t * 180 + Math.sin(frame * 0.1 + k) * 4, yy, rr, rr * 0.6, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  });
}

function boardroomMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  // Floor-to-ceiling glass: mullions, a smear of reflection, and the rain.
  tiles(camX, PAR_MID, 64, 60, (i, sx) => {
    roundRect(ctx, sx, 0, 6, FLOOR_TOP, 0, c, 'none', 0);
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(sx + 8, 0);
    ctx.lineTo(sx + 34, 0);
    ctx.lineTo(sx + 12, FLOOR_TOP);
    ctx.lineTo(sx - 14, FLOOR_TOP);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  roundRect(ctx, spanX, FLOOR_TOP - 16, spanW, 16, 0, shade(c, 0.8), 'none', 0);

  // The whiteboard nobody has cleaned since the acquisition.
  const bx = 150 - camX * PAR_MID;
  if (bx > spanX - 220 && bx < spanX + spanW + 40) {
    roundRect(ctx, bx, 96, 176, 84, 3, '#e8e6ee', INK, 2);
    ctx.strokeStyle = withAlpha(accent, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx + 16, 156);
    ctx.lineTo(bx + 56, 132);
    ctx.lineTo(bx + 96, 142);
    ctx.lineTo(bx + 156, 108);
    ctx.stroke();
    label(ctx, 'HEADCOUNT', bx + 88, 112, 9, '#3a3546');
    label(ctx, '(down is good)', bx + 88, 170, 7, '#6f6a7d', 'center', true);
  }
}

function feedMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  // Engagement bait, rendered at the scale it deserves.
  const words = ['VIRAL', 'BASED', 'ENGAGE', 'RATIO', 'REPLY', 'BOOST'];
  tiles(camX, PAR_MID, 116, 80, (i, sx) => {
    const y = 96 + hrange(i * 109, -40, 46) + Math.sin(frame * 0.02 + i) * 4;
    const w = 92;
    const on = hash(i * 13 + ((frame / 31) | 0)) > 0.07;
    roundRect(ctx, sx, y, w, 34, 6, c, INK, 1.6);
    glowRect(ctx, sx + 4, y + 4, w - 8, 26, accent, on ? 0.16 : 0.04);
    label(
      ctx,
      words[((i % words.length) + words.length) % words.length],
      sx + w * 0.5,
      y + 17,
      13,
      on ? '#ffffff' : withAlpha('#ffffff', 0.3),
    );
    // The little blue tick, sold separately.
    ellipse(ctx, sx + w - 6, y + 6, 5, 5, 0, on ? accent : shade(accent, 0.4), INK, 1);
    label(ctx, '$', sx + w - 6, y + 6, 6, '#0d0c12');
  });
}

function suburbMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  tiles(camX, PAR_MID, 118, 90, (i, sx) => {
    const w = 88;
    const h = hrange(i * 127, 52, 74);
    const top = FLOOR_TOP - h;
    roundRect(ctx, sx, top, w, h, 2, c, INK, 1.6);
    poly(ctx, [sx - 6, top, sx + w + 6, top, sx + w * 0.5, top - 26], shade(c, 0.75), INK, 1.6);
    // Windows, warm unless the owner has been laid off.
    for (let k = 0; k < 3; k++) {
      const lit = hash(i * 31 + k) > 0.4;
      const flick = lit && hash(i * 31 + k + ((frame / 53) | 0)) > 0.04 ? 1 : 0.15;
      roundRect(
        ctx,
        sx + 10 + k * 26,
        top + 16,
        16,
        14,
        1.5,
        lit ? withAlpha('#ffd98a', flick) : '#201e28',
        INK,
        1.2,
      );
    }
    roundRect(ctx, sx + w * 0.5 - 8, FLOOR_TOP - 24, 16, 24, 1.5, shade(accent, 0.7), INK, 1.4);
    // Charging robotaxi on the drive, still in beta.
    if (i % 3 === 0) {
      roundRect(ctx, sx + w + 6, FLOOR_TOP - 15, 30, 12, 3, shade(accent, 0.9), INK, 1.4);
      ellipse(ctx, sx + w + 13, FLOOR_TOP - 3, 3.2, 3.2, 0, '#1c1a24', 'none', 0);
      ellipse(ctx, sx + w + 29, FLOOR_TOP - 3, 3.2, 3.2, 0, '#1c1a24', 'none', 0);
    }
  });
  passingTraffic(ctx, camX, frame, accent);
}

/** A car crossing the road behind the fight, headlights first. */
function passingTraffic(ctx: C2D, camX: number, frame: number, accent: string): void {
  for (let lane = 0; lane < 2; lane++) {
    const dir = lane === 0 ? 1 : -1;
    const period = 520 + lane * 190;
    const t = ((frame * (1.7 + lane * 0.6) + lane * 260) % period) / period;
    const run = spanW + 200;
    const x = dir > 0 ? spanX - 100 + t * run : spanX + spanW + 100 - t * run;
    const y = FLOOR_TOP - 12 - lane * 7;
    const body = lane === 0 ? shade(accent, 0.85) : '#8d93a6';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1);
    roundRect(ctx, -18, -8, 36, 9, 2, body, INK, 1.3);
    roundRect(ctx, -11, -13, 20, 6, 2, shade(body, 0.7), INK, 1.2);
    ellipse(ctx, -11, 1.5, 3, 3, 0, '#17151e', 'none', 0);
    ellipse(ctx, 11, 1.5, 3, 3, 0, '#17151e', 'none', 0);
    glowRect(ctx, 16, -6, 3, 3, '#fff6cf', 0.9);
    glowRect(ctx, -19, -6, 3, 3, '#ff5340', 0.6);
    ctx.restore();
  }
}

function mineMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  caveWall(ctx, camX, PAR_MID, c, 66, 96);
  tiles(camX, PAR_MID, 96, 70, (i, sx) => {
    // Timber sets holding the roof up. Barely.
    const top = 84 + hrange(i * 131, -14, 14);
    roundRect(ctx, sx, top, 8, FLOOR_TOP - top, 1, '#6a4a2c', INK, 1.5);
    roundRect(ctx, sx + 62, top, 8, FLOOR_TOP - top, 1, '#6a4a2c', INK, 1.5);
    roundRect(ctx, sx - 4, top - 8, 78, 9, 1, '#7d5833', INK, 1.5);
    // Hanging lantern, swinging.
    const sw = Math.sin(frame * 0.035 + i) * 5;
    ctx.strokeStyle = '#3b3340';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx + 35, top + 1);
    ctx.lineTo(sx + 35 + sw, top + 22);
    ctx.stroke();
    glowRect(ctx, sx + 32 + sw, top + 22, 6, 8, accent, 0.75);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(sx + 35 + sw, top + 26, 46, 0, TAU);
    ctx.fill();
    ctx.restore();
    if (i % 3 === 0) label(ctx, 'LITHIUM 3', sx + 35, top + 44, 6.5, withAlpha(accent, 0.55));
  });
}

function forestMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  treeLine(ctx, camX, PAR_MID, shade(c, 0.85), 120, 60, 6);
  tiles(camX, PAR_MID, 74, 70, (i, sx) => {
    const w = hrange(i * 137, 7, 13);
    const h = hrange(i * 139, 120, 210);
    const sway = Math.sin(frame * 0.014 + i) * 3;
    capsule(ctx, sx + sway * 0.3, FLOOR_TOP + 6, sx + sway, FLOOR_TOP - h, w * 0.5, c, INK, 1.4);
    // Canopy blob.
    ctx.globalAlpha = 0.85;
    ellipse(
      ctx,
      sx + sway,
      FLOOR_TOP - h - 6,
      hrange(i * 141, 26, 44),
      hrange(i * 143, 16, 26),
      0,
      shade(c, 0.7),
      'none',
      0,
    );
    ctx.globalAlpha = 1;
  });
}

function gigafactoryMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  // Roof trusses running off to a vanishing point.
  ctx.strokeStyle = shade(c, 1.25);
  ctx.lineWidth = 2;
  tiles(camX, PAR_MID, 88, 80, (i, sx) => {
    ctx.beginPath();
    ctx.moveTo(sx, 10);
    ctx.lineTo(sx + 44, 34);
    ctx.lineTo(sx + 88, 10);
    ctx.stroke();
    roundRect(ctx, sx + 30, 34, 28, 4, 1, '#ffe9a8', 'none', 0);
    glowRect(ctx, sx + 30, 34, 28, 4, '#fff4cf', 0.5);
  });

  // The line: robot arms welding car bodies that crawl past.
  const beltY = FLOOR_TOP - 30;
  roundRect(ctx, spanX, beltY, spanW, 12, 0, shade(c, 0.7), 'none', 0);
  const scroll = (frame * 0.6 - camX * PAR_MID) % 120;
  const bodies = Math.ceil(spanW / 120) + 2;
  for (let i = -1; i < bodies; i++) {
    const x = spanX + i * 120 + ((scroll % 120) + 120) % 120;
    roundRect(ctx, x, beltY - 20, 74, 20, 5, shade(accent, 0.55), INK, 1.6);
    roundRect(ctx, x + 14, beltY - 30, 44, 12, 4, shade(accent, 0.4), INK, 1.4);
  }
  tiles(camX, PAR_MID, 118, 80, (i, sx) => {
    const swing = Math.sin(frame * 0.05 + i * 1.3) * 0.5;
    const bx = sx + 20;
    const by = beltY - 44;
    roundRect(ctx, bx - 9, by, 18, 44, 3, c, INK, 1.6);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(-0.7 + swing);
    capsule(ctx, 0, 0, 34, 0, 4, shade(c, 1.3), INK, 1.5);
    ctx.translate(34, 0);
    ctx.rotate(0.9 - swing * 1.6);
    capsule(ctx, 0, 0, 26, 0, 3, shade(c, 1.1), INK, 1.4);
    // Weld flash at the tip.
    if (hash(i * 17 + ((frame / 5) | 0)) > 0.72) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9;
      star(ctx, 28, 0, 5, 4, '#dff0ff', 'none');
      ctx.globalAlpha = 0.25;
      ellipse(ctx, 28, 0, 16, 16, 0, '#9fd8ff', 'none', 0);
      ctx.restore();
    }
    ctx.restore();
  });
}

function orbitMid(ctx: C2D, c: string, accent: string, camX: number, frame: number): void {
  tiles(camX, PAR_MID, 168, 110, (i, sx) => {
    const y = 96 + hrange(i * 149, -34, 30);
    roundRect(ctx, sx, y, 124, 44, 18, c, INK, 1.8);
    roundRect(ctx, sx + 14, y + 10, 96, 6, 3, shade(c, 0.6), 'none', 0);
    for (let k = 0; k < 4; k++) {
      ellipse(ctx, sx + 24 + k * 26, y + 30, 6, 6, 0, '#0e1420', INK, 1.3);
      glowRect(ctx, sx + 21 + k * 26, y + 27, 6, 6, accent, 0.35 + 0.2 * Math.sin(frame * 0.04 + k + i));
    }
    // Solar wings, tracking a sun that is not where you think it is.
    const tilt = Math.sin(frame * 0.006 + i) * 0.18;
    for (const dir of [-1, 1]) {
      ctx.save();
      ctx.translate(sx + 62 + dir * 66, y + 22);
      ctx.rotate(tilt * dir);
      roundRect(ctx, dir > 0 ? 0 : -58, -13, 58, 26, 2, '#26406b', INK, 1.4);
      ctx.strokeStyle = withAlpha('#7fb2ff', 0.45);
      ctx.lineWidth = 0.8;
      for (let k = 1; k < 6; k++) {
        const gx = (dir > 0 ? 0 : -58) + k * 9.6;
        ctx.beginPath();
        ctx.moveTo(gx, -13);
        ctx.lineTo(gx, 13);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Near band
// ─────────────────────────────────────────────────────────────────────────────

function nearLayer(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const c = p.near;
  switch (theme) {
    case 'tunnel':
      tiles(camX, PAR_NEAR, 118, 60, (i, sx) => {
        // Cable trays bolted to the wall, sagging between hangers.
        ctx.strokeStyle = shade(c, 0.8);
        ctx.lineWidth = 3;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(sx, 206 + k * 7);
          ctx.quadraticCurveTo(sx + 59, 214 + k * 7, sx + 118, 206 + k * 7);
          ctx.stroke();
        }
        roundRect(ctx, sx - 4, 200, 8, 34, 1, c, INK, 1.4);
      });
      break;
    case 'factory':
      tiles(camX, PAR_NEAR, 96, 60, (i, sx) => {
        roundRect(ctx, sx, FLOOR_TOP - 58, 14, 58, 3, c, INK, 1.6);
        roundRect(ctx, sx - 3, FLOOR_TOP - 62, 20, 7, 2, shade(c, 1.3), INK, 1.4);
        if (hash(i * 151) > 0.6) {
          const t = (frame * 0.04 + i) % 1;
          glowRect(ctx, sx + 3, FLOOR_TOP - 44, 8, 4, t > 0.5 ? '#ff5340' : '#3b2830', 0.8);
        }
      });
      break;
    case 'server_farm':
      tiles(camX, PAR_NEAR, 160, 70, (i, sx) => {
        roundRect(ctx, sx, FLOOR_TOP - 52, 26, 52, 2, shade(c, 0.9), INK, 1.6);
        ledColumn(ctx, sx + 4, FLOOR_TOP - 46, 18, 40, 3, frame, i * 71, p.accent, 0.9);
        label(ctx, 'A-12', sx + 13, FLOOR_TOP - 58, 6, withAlpha(p.accent, 0.6));
      });
      break;
    case 'launchpad':
      tiles(camX, PAR_NEAR, 140, 70, (i, sx) => {
        roundRect(ctx, sx, FLOOR_TOP - 30, 60, 8, 3, c, INK, 1.5);
        roundRect(ctx, sx + 6, FLOOR_TOP - 22, 8, 22, 2, shade(c, 0.8), INK, 1.3);
        roundRect(ctx, sx + 46, FLOOR_TOP - 22, 8, 22, 2, shade(c, 0.8), INK, 1.3);
        if (i % 2 === 0) label(ctx, 'LOX', sx + 30, FLOOR_TOP - 26, 6, withAlpha(p.accent, 0.8));
      });
      break;
    case 'mars_dome':
      tiles(camX, PAR_NEAR, 132, 70, (i, sx) => {
        // Half-buried rovers and pressure bottles.
        ellipse(ctx, sx + 20, FLOOR_TOP - 6, 22, 9, 0, shade(c, 0.85), INK, 1.5);
        roundRect(ctx, sx + 70, FLOOR_TOP - 22, 12, 22, 5, c, INK, 1.5);
        roundRect(ctx, sx + 86, FLOOR_TOP - 16, 10, 16, 4, shade(c, 1.2), INK, 1.4);
      });
      break;
    case 'boardroom': {
      // The table. It is very long, and you are not invited to sit at it.
      const y = FLOOR_TOP - 26;
      roundRect(ctx, spanX, y, spanW, 12, 5, shade(c, 1.1), INK, 2);
      roundRect(ctx, spanX, y + 10, spanW, 5, 2, shade(c, 0.7), 'none', 0);
      tiles(camX, PAR_NEAR, 62, 40, (i, sx) => {
        roundRect(ctx, sx, y - 22, 18, 22, 4, shade(c, 0.8), INK, 1.5);
        roundRect(ctx, sx + 26, y - 5, 14, 5, 1, '#d9d5e2', INK, 1.2);
      });
      break;
    }
    case 'social_feed':
      tiles(camX, PAR_NEAR, 150, 70, (i, sx) => {
        const on = hash(i * 29 + ((frame / 19) | 0)) > 0.12;
        roundRect(ctx, sx, FLOOR_TOP - 46, 66, 26, 4, c, INK, 1.6);
        label(ctx, i % 2 === 0 ? 'SUBSCRIBE' : 'FOR YOU', sx + 33, FLOOR_TOP - 33, 8, on ? '#fff' : '#6b6579');
        glowRect(ctx, sx + 2, FLOOR_TOP - 44, 62, 22, p.accent, on ? 0.13 : 0.02);
        roundRect(ctx, sx + 26, FLOOR_TOP - 20, 14, 20, 2, shade(c, 0.7), INK, 1.4);
      });
      break;
    case 'suburb':
      tiles(camX, PAR_NEAR, 90, 50, (i, sx) => {
        // Mailboxes and a sad little hedge.
        roundRect(ctx, sx, FLOOR_TOP - 26, 4, 26, 1, '#4a4152', INK, 1.2);
        roundRect(ctx, sx - 5, FLOOR_TOP - 34, 14, 9, 3, shade(c, 1.2), INK, 1.3);
        ellipse(ctx, sx + 44, FLOOR_TOP - 8, 18, 10, 0, shade(c, 0.7), INK, 1.4);
      });
      break;
    case 'mine':
      tiles(camX, PAR_NEAR, 104, 60, (i, sx) => {
        // Rails and an abandoned cart.
        ctx.strokeStyle = shade(c, 1.3);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, FLOOR_TOP - 3);
        ctx.lineTo(sx + 104, FLOOR_TOP - 3);
        ctx.stroke();
        for (let k = 0; k < 6; k++) {
          roundRect(ctx, sx + k * 17, FLOOR_TOP - 5, 4, 5, 1, '#5c4a33', 'none', 0);
        }
        if (hash(i * 157) > 0.6) {
          roundRect(ctx, sx + 40, FLOOR_TOP - 22, 30, 16, 2, c, INK, 1.6);
          ellipse(ctx, sx + 48, FLOOR_TOP - 4, 4, 4, 0, '#2a2430', INK, 1.2);
          ellipse(ctx, sx + 62, FLOOR_TOP - 4, 4, 4, 0, '#2a2430', INK, 1.2);
        }
      });
      break;
    case 'forest':
      tiles(camX, PAR_NEAR, 86, 60, (i, sx) => {
        ellipse(ctx, sx, FLOOR_TOP - 4, hrange(i * 163, 10, 20), 7, 0, shade(c, 0.8), INK, 1.4);
        if (hash(i * 167) > 0.55) {
          for (let k = 0; k < 3; k++) {
            const x = sx + 30 + k * 7;
            capsule(ctx, x, FLOOR_TOP, x + hrange(i + k, -6, 6), FLOOR_TOP - hrange(i * 2 + k, 12, 24), 1.6, c, INK, 1.2);
          }
        }
      });
      break;
    case 'gigafactory':
      tiles(camX, PAR_NEAR, 112, 60, (i, sx) => {
        // Safety cage: the only thing between you and the press.
        ctx.strokeStyle = shade(p.accent, 0.9);
        ctx.lineWidth = 2;
        roundRect(ctx, sx, FLOOR_TOP - 40, 84, 40, 2, 'none', shade(p.accent, 0.75), 1.6);
        for (let k = 1; k < 5; k++) {
          ctx.beginPath();
          ctx.moveTo(sx + k * 17, FLOOR_TOP - 40);
          ctx.lineTo(sx + k * 17, FLOOR_TOP);
          ctx.stroke();
        }
        if (i % 2 === 0) label(ctx, 'NO HUMANS', sx + 42, FLOOR_TOP - 46, 6.5, withAlpha(p.accent, 0.8));
      });
      break;
    case 'orbit':
      tiles(camX, PAR_NEAR, 128, 60, (i, sx) => {
        roundRect(ctx, sx, FLOOR_TOP - 34, 40, 34, 4, c, INK, 1.6);
        ellipse(ctx, sx + 20, FLOOR_TOP - 18, 11, 11, 0, '#0b1220', INK, 1.6);
        ctx.globalAlpha = 0.4;
        ellipse(ctx, sx + 17, FLOOR_TOP - 21, 4, 3, -0.6, '#9fd8ff', 'none', 0);
        ctx.globalAlpha = 1;
      });
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground plane
// ─────────────────────────────────────────────────────────────────────────────

function ground(
  ctx: C2D,
  theme: MapTheme,
  p: MapPalette,
  tone: Tone,
  camX: number,
  frame: number,
): void {
  const bandH = FLOOR_BOTTOM - FLOOR_TOP;

  // The focal plane. Lifted clear of the walls behind it and brightest across
  // the walkable band, because a near-black dwarf only reads as a silhouette if
  // the thing under his boots is lighter than he is. Falls away again at the
  // front edge, which is out of play and only there to frame the action.
  const g = ctx.createLinearGradient(0, FLOOR_TOP, 0, VIEW_H);
  g.addColorStop(0, tone.floorSeat);
  g.addColorStop(0.07, tone.floorRise);
  g.addColorStop(0.3, tone.floorPeak);
  g.addColorStop(0.55, tone.floorBand);
  g.addColorStop(1, tone.floorFront);
  ctx.fillStyle = g;
  fillSpan(ctx, FLOOR_TOP, spanBottom - FLOOR_TOP);

  // The z=0 kerb, so the walkable band has a visible back edge.
  ctx.fillStyle = tone.floorKerb;
  fillSpan(ctx, FLOOR_TOP - 2, 2.5);

  // Depth lines: spaced by z so they sit exactly where a fighter's feet do.
  // Held down now that the floor is brighter — the plane should read as lit, not
  // as ruled paper competing with the fighters standing on it.
  ctx.strokeStyle = withAlpha(p.groundLine, 0.5);
  ctx.lineWidth = 1;
  for (let z = 0; z <= Z_DEPTH; z += Z_DEPTH / 4) {
    const y = FLOOR_TOP + z * Z_SCALE;
    ctx.globalAlpha = 0.18 + 0.26 * (z / Z_DEPTH);
    ctx.beginPath();
    ctx.moveTo(spanX, y);
    ctx.lineTo(spanX + spanW, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Perspective ribs, 1:1 with the world so the floor reads as moving. Run past
  // the authored bottom edge at an unchanged slope, so a view that sees further
  // forward gets more rib rather than a different perspective.
  const ribRun = (spanBottom - FLOOR_TOP) / (VIEW_H - FLOOR_TOP);
  const spacing = theme === 'boardroom' ? 34 : theme === 'orbit' ? 42 : 48;
  ctx.strokeStyle = withAlpha(p.groundLine, 0.22);
  tiles(camX, 1, spacing, 60, (i, sx) => {
    ctx.beginPath();
    ctx.moveTo(sx, FLOOR_TOP);
    ctx.lineTo(sx + 26 * ribRun, spanBottom);
    ctx.stroke();
  });

  switch (theme) {
    case 'tunnel':
      // Centre service strip.
      ctx.fillStyle = withAlpha(p.accent, 0.25);
      fillSpan(ctx, FLOOR_TOP + bandH * 0.5 - 1.5, 3);
      tiles(camX, 1, 64, 40, (i, sx) => {
        glowRect(ctx, sx, FLOOR_TOP + bandH * 0.5 - 1, 22, 2, p.accent, 0.35);
      });
      break;
    case 'factory':
    case 'gigafactory':
      tiles(camX, 1, 30, 40, (i, sx) => {
        ctx.globalAlpha = 0.16;
        poly(
          ctx,
          [
            sx,
            FLOOR_BOTTOM + 12,
            sx + 14,
            FLOOR_BOTTOM + 12,
            sx + 6,
            spanBottom,
            sx - 8,
            spanBottom,
          ],
          i % 2 === 0 ? p.accent : '#15121b',
          'none',
          0,
        );
        ctx.globalAlpha = 1;
      });
      break;
    case 'server_farm':
      tiles(camX, 1, 40, 40, (i, sx) => {
        ctx.strokeStyle = withAlpha(p.groundLine, 0.4);
        ctx.strokeRect(sx, FLOOR_TOP + 6, 40, bandH - 6);
        if (hash(i * 173) > 0.7) {
          ctx.fillStyle = withAlpha(p.accent, 0.12);
          ctx.fillRect(sx + 4, FLOOR_TOP + 10, 32, bandH - 14);
        }
      });
      break;
    case 'launchpad':
      // Scorch marks from the last four attempts.
      tiles(camX, 1, 150, 60, (i, sx) => {
        ctx.globalAlpha = 0.25;
        ellipse(ctx, sx + 40, FLOOR_TOP + bandH * 0.6, 54, 16, 0, '#0f0d14', 'none', 0);
        ctx.globalAlpha = 1;
      });
      break;
    case 'mars_dome':
      tiles(camX, 1, 26, 40, (i, sx) => {
        ctx.globalAlpha = 0.2;
        ellipse(ctx, sx, FLOOR_TOP + hrange(i * 179, 6, bandH), hrange(i * 181, 3, 9), 2, 0, shade(p.ground, 0.7), 'none', 0);
        ctx.globalAlpha = 1;
      });
      break;
    case 'boardroom': {
      // Polish: a soft reflection of the glass wall lying on the parquet.
      const rg = ctx.createLinearGradient(0, FLOOR_TOP, 0, FLOOR_BOTTOM);
      rg.addColorStop(0, withAlpha('#ffffff', 0.14));
      rg.addColorStop(1, withAlpha('#ffffff', 0));
      ctx.fillStyle = rg;
      fillSpan(ctx, FLOOR_TOP, bandH);
      break;
    }
    case 'social_feed':
      ctx.strokeStyle = withAlpha(p.accent, 0.3);
      tiles(camX, 1, 24, 40, (i, sx) => {
        ctx.beginPath();
        ctx.moveTo(sx, FLOOR_TOP);
        ctx.lineTo(sx + 14 * ribRun, spanBottom);
        ctx.stroke();
      });
      break;
    case 'suburb':
      ctx.fillStyle = withAlpha('#f4e6b0', 0.5);
      tiles(camX, 1, 46, 40, (i, sx) => {
        ctx.fillRect(sx, FLOOR_TOP + bandH * 0.55, 22, 2.5);
      });
      break;
    case 'mine':
      tiles(camX, 1, 22, 40, (i, sx) => {
        ctx.globalAlpha = 0.3;
        ellipse(ctx, sx, FLOOR_TOP + hrange(i * 191, 4, bandH), hrange(i * 193, 2, 6), 1.6, 0, '#1a1218', 'none', 0);
        ctx.globalAlpha = 1;
      });
      break;
    case 'forest':
      tiles(camX, 1, 34, 40, (i, sx) => {
        ctx.globalAlpha = 0.35;
        ellipse(ctx, sx, FLOOR_TOP + hrange(i * 197, 4, bandH), hrange(i * 199, 4, 11), 3, 0, shade(p.ground, 0.8), 'none', 0);
        ctx.globalAlpha = 1;
      });
      break;
    case 'orbit':
      tiles(camX, 1, 42, 40, (i, sx) => {
        glowRect(ctx, sx, FLOOR_TOP + bandH * 0.5, 24, 1.6, p.accent, 0.3 + 0.12 * Math.sin(frame * 0.05 + i));
      });
      break;
    default:
      break;
  }

  floorMaterial(ctx, theme, DRESSING[theme], p, camX, frame);

  // Contact shadow where the floor meets the back wall. Shorter and softer than
  // it was: it only has to seat the join now, not carry the whole separation.
  const sg = ctx.createLinearGradient(0, FLOOR_TOP, 0, FLOOR_TOP + 13);
  sg.addColorStop(0, withAlpha('#000000', 0.3));
  sg.addColorStop(1, withAlpha('#000000', 0));
  ctx.fillStyle = sg;
  fillSpan(ctx, FLOOR_TOP, 13);
}

/**
 * Fog pooling along the floor line, drawn before the near band so that band
 * stays crisp in front of it. Genuinely a gradient now: the old stops both
 * resolved to the same opaque fog, which laid a flat slab over the mid band.
 */
function haze(ctx: C2D, tone: Tone): void {
  const top = FLOOR_TOP - HAZE_H;
  const g = ctx.createLinearGradient(0, top, 0, FLOOR_TOP + 6);
  g.addColorStop(0, tone.hazeTop);
  g.addColorStop(1, tone.hazeBottom);
  ctx.fillStyle = g;
  fillSpan(ctx, top, HAZE_H + 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Foreground
// ─────────────────────────────────────────────────────────────────────────────

function foreLayer(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const c = shade(p.near, 0.5);
  const y0 = FLOOR_BOTTOM - 6;
  /** Anything that ran off the bottom of the authored frame runs off the view. */
  const below = Math.max(VIEW_H + 10, spanBottom);

  switch (theme) {
    case 'tunnel':
      tiles(camX, PAR_FORE, 210, 120, (i, sx) => {
        ctx.strokeStyle = c;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(sx - 40, below);
        ctx.quadraticCurveTo(sx + 60, y0 + 6, sx + 180, below);
        ctx.stroke();
      });
      break;
    case 'factory':
    case 'gigafactory':
      tiles(camX, PAR_FORE, 260, 140, (i, sx) => {
        roundRect(ctx, sx, y0 + 4, 200, 14, 7, c, INK, 2);
        roundRect(ctx, sx + 30, y0 + 2, 16, 18, 3, shade(c, 1.3), INK, 1.6);
      });
      sparks(ctx, camX, frame, p.accent);
      break;
    case 'server_farm':
      roundRect(ctx, spanX, VIEW_H - 26, spanW, below - VIEW_H + 26, 3, c, INK, 2);
      tiles(camX, PAR_FORE, 70, 60, (i, sx) => {
        ctx.strokeStyle = withAlpha(p.accent, 0.5);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, VIEW_H - 20);
        ctx.quadraticCurveTo(sx + 35, VIEW_H - 8, sx + 70, VIEW_H - 20);
        ctx.stroke();
      });
      break;
    case 'launchpad':
      tiles(camX, PAR_FORE, 220, 140, (i, sx) => {
        roundRect(ctx, sx, y0, 26, 60, 6, c, INK, 2);
        smokePlume(ctx, sx + 13, y0 + 4, frame, i + 3, 0.14);
      });
      break;
    case 'mars_dome':
      tiles(camX, PAR_FORE, 240, 160, (i, sx) => {
        poly(
          ctx,
          [sx, below, sx + 26, y0 + 10, sx + 58, y0 + 18, sx + 84, below],
          c,
          INK,
          2,
        );
      });
      break;
    case 'boardroom':
      roundRect(ctx, spanX, VIEW_H - 22, spanW, below - VIEW_H + 22, 6, c, INK, 2);
      break;
    case 'social_feed':
      // The ticker at the bottom of every screen, forever.
      roundRect(ctx, spanX, VIEW_H - 18, spanW, below - VIEW_H + 18, 0, shade(p.mid, 0.8), 'none', 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(spanX, VIEW_H - 18, spanW, 18);
      ctx.clip();
      {
        const msg = '  BREAKING: BILLIONAIRE ANNOUNCES BILLIONAIRE THING  •  ENGAGEMENT UP 400%  •  DWARFS STILL AT LARGE  •';
        ctx.font = `800 9px ${FONT_DISPLAY}`;
        ctx.textAlign = 'left';
        const w = Math.max(1, ctx.measureText(msg).width);
        const off = (frame * 1.1) % w;
        ctx.fillStyle = withAlpha(p.accent, 0.9);
        // Repeat until the run reaches the right edge of the view, not of the
        // authored frame — the ticker must never show a gap.
        for (let x = spanX - off - w; x < spanX + spanW; x += w) {
          ctx.fillText(msg, x, VIEW_H - 9);
        }
      }
      ctx.restore();
      break;
    case 'suburb':
      tiles(camX, PAR_FORE, 22, 60, (i, sx) => {
        poly(
          ctx,
          [sx, below, sx, y0 + 12, sx + 5, y0 + 6, sx + 10, y0 + 12, sx + 10, below],
          c,
          INK,
          1.8,
        );
      });
      break;
    case 'mine':
      tiles(camX, PAR_FORE, 300, 180, (i, sx) => {
        roundRect(ctx, sx, y0 - 10, 18, 90, 2, '#5a3f26', INK, 2);
        roundRect(ctx, sx + 120, y0 - 10, 18, 90, 2, '#5a3f26', INK, 2);
      });
      break;
    case 'forest':
      tiles(camX, PAR_FORE, 260, 170, (i, sx) => {
        for (let k = 0; k < 5; k++) {
          const a = -1.9 + k * 0.32;
          const len = 70 + hrange(i * 211 + k, 0, 40);
          const bx = sx + 20;
          const by = below + 4;
          capsule(
            ctx,
            bx,
            by,
            bx + Math.cos(a) * len,
            by + Math.sin(a) * len,
            5,
            c,
            INK,
            1.6,
          );
        }
      });
      break;
    case 'orbit':
      // Looking through a window: rounded frame biting all four corners. Bound
      // to the view rather than the authored frame, or the zoom throws it clean
      // off screen and the map loses the one thing that says "you are in orbit".
      roundRect(
        ctx,
        viewX - 14,
        viewY - 14,
        viewW + 28,
        viewH + 28,
        46,
        'none',
        c,
        13,
      );
      break;
    default:
      break;
  }
}

function sparks(ctx: C2D, camX: number, frame: number, accent: string): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  tiles(camX, PAR_MID, 170, 80, (i, sx) => {
    const cycle = (frame + i * 37) % 190;
    if (cycle > 26) return;
    const t = cycle / 26;
    ctx.globalAlpha = 1 - t;
    for (let k = 0; k < 7; k++) {
      const a = -2.6 + hash(i * 13 + k) * 2.2;
      const d = t * (18 + hash(i + k) * 26);
      const x = sx + 40 + Math.cos(a) * d;
      const y = FLOOR_TOP - 34 + Math.sin(a) * d + t * t * 18;
      ctx.fillStyle = k % 3 === 0 ? '#ffffff' : accent;
      ctx.fillRect(x, y, 1.6, 1.6);
    }
  });
  ctx.restore();
}

/**
 * Weather scatters across the visible span rather than the authored frame, and
 * its population scales with how much of that span the player can see, so rain
 * and dust keep the same on-screen density however far the camera is zoomed in.
 */
function driftX(seed: number, drift: number): number {
  const w = spanW + 60;
  const v = ((hash(seed) * w + drift) % w + w) % w;
  return spanX - 30 + v;
}

function driftY(seed: number, drift: number): number {
  const h = spanBottom - spanTop + 40;
  const v = ((hash(seed) * h + drift) % h + h) % h;
  return spanTop - 20 + v;
}

function weather(ctx: C2D, theme: MapTheme, p: MapPalette, camX: number, frame: number): void {
  const spanH = spanBottom - spanTop;

  switch (theme) {
    case 'suburb':
    case 'boardroom': {
      // Rain: a fast near layer and a slower far one.
      ctx.save();
      ctx.strokeStyle = withAlpha('#cfe4ff', 0.35);
      ctx.lineWidth = 1;
      for (let k = 0; k < 2; k++) {
        const speed = 11 + k * 7;
        const len = 9 + k * 7;
        const count = Math.round(40 * spanDensity);
        ctx.globalAlpha = 0.16 + k * 0.14;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const x = driftX(i * 3 + k * 101, -camX * (0.2 + k * 0.4));
          const y = driftY(i * 7 + k * 53, frame * speed);
          ctx.moveTo(x, y);
          ctx.lineTo(x - 3, y + len);
        }
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'mars_dome': {
      const count = Math.round(46 * spanDensity);
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = shade(p.ground, 1.3);
      for (let i = 0; i < count; i++) {
        const x = driftX(i * 5, frame * (1.4 + hash(i) * 2) - camX * 0.5);
        const y = spanTop + hash(i * 11) * spanH;
        ctx.fillRect(x, y + Math.sin(frame * 0.05 + i) * 3, 2.4, 1.2);
      }
      ctx.restore();
      break;
    }
    case 'forest': {
      // Leaves on the way down, fireflies on the way up.
      const leaves = Math.round(22 * spanDensity);
      const flies = Math.round(14 * spanDensity);
      ctx.save();
      for (let i = 0; i < leaves; i++) {
        const t = ((frame * (0.5 + hash(i) * 0.5) + i * 40) % 460) / 460;
        const x = driftX(i * 3, -camX * 0.8) + Math.sin(t * 8 + i) * 14;
        const y = spanTop - 20 + t * (spanH + 50);
        ctx.globalAlpha = 0.5;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * 7 + i);
        ellipse(ctx, 0, 0, 3.4, 1.6, 0, i % 3 === 0 ? '#c9a24a' : '#7f9a4c', 'none', 0);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < flies; i++) {
        const x = driftX(i * 17, -camX * 0.9);
        const y = FLOOR_TOP - 40 + Math.sin(frame * 0.02 + i * 2) * 34;
        ctx.globalAlpha = 0.3 + 0.3 * Math.sin(frame * 0.11 + i);
        ellipse(ctx, x + Math.sin(frame * 0.013 + i) * 20, y, 1.6, 1.6, 0, '#d8ff9a', 'none', 0);
      }
      ctx.restore();
      break;
    }
    case 'mine':
    case 'tunnel': {
      const count = Math.round(34 * spanDensity);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = '#d8d2e6';
      for (let i = 0; i < count; i++) {
        const x = driftX(i * 23, -camX * 0.7 + Math.sin(frame * 0.01 + i) * 20);
        const y = driftY(i * 29, frame * 0.3);
        ctx.fillRect(x, y, 1.3, 1.3);
      }
      ctx.restore();
      break;
    }
    case 'orbit': {
      const count = Math.round(10 * spanDensity);
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < count; i++) {
        const t = ((frame * (0.6 + hash(i) * 0.8) + i * 60) % 700) / 700;
        const x = spanX - 60 + t * (spanW + 120);
        const y = spanTop + hash(i * 31) * spanH;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(frame * 0.02 + i);
        roundRect(ctx, -3, -1.5, 6, 3, 1, shade(p.near, 1.2), INK, 1);
        ctx.restore();
      }
      ctx.restore();
      break;
    }
    default:
      break;
  }
}

/**
 * Corner falloff, sized to what is actually on screen rather than to the
 * authored frame — under the fight zoom those are not the same rectangle, and a
 * vignette drawn to the wrong one either vanishes or bites into the middle.
 *
 * Deliberately weak, and flat across the centre: the eye should be pulled in,
 * not walled in. The HUD composites over the top of this, so the corners it
 * lives in stay legible.
 */
function vignette(ctx: C2D, tone: Tone): void {
  const cx = viewX + viewW * 0.5;
  const cy = viewY + viewH * 0.48;
  const g = ctx.createRadialGradient(
    cx,
    cy,
    viewH * VIGNETTE_INNER,
    cx,
    cy,
    viewW * VIGNETTE_OUTER,
  );
  g.addColorStop(0, tone.vigInner);
  g.addColorStop(0.62, tone.vigKnee);
  g.addColorStop(1, tone.vigOuter);
  ctx.fillStyle = g;
  ctx.fillRect(spanX, spanTop, spanW, spanBottom - spanTop);
}
