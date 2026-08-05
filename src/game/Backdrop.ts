/**
 * Procedural scenery.
 *
 * Nothing here is an asset. Every map is built at draw time from its
 * `MapPalette` plus its `MapTheme`, in four parallax bands (sky, far, mid,
 * near) plus the ground plane, with a foreground pass that draws the stuff the
 * camera is practically standing in.
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
  ctx.font = `${italic ? 'italic ' : ''}800 ${size}px "Arial Narrow", "Helvetica Neue", system-ui, sans-serif`;
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
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export function drawBackdrop(ctx: C2D, def: MapDef, cam: Camera, frame: number): void {
  const p = def.palette;
  const camX = cam.x;
  const tone = toneFor(p);

  ctx.save();
  ctx.textBaseline = 'middle';
  syncViewport(ctx, cam);

  sky(ctx, def.theme, p, camX, frame);
  farLayer(ctx, def.theme, p, camX, frame);
  wash(ctx, tone.farWash, tone.farWashA);
  midLayer(ctx, def.theme, p, camX, frame);
  wash(ctx, tone.midWash, tone.midWashA);
  haze(ctx, tone);
  nearLayer(ctx, def.theme, p, camX, frame);
  actionScrim(ctx, tone);
  ground(ctx, def.theme, p, tone, camX, frame);

  ctx.restore();
}

export function drawForeground(ctx: C2D, def: MapDef, cam: Camera, frame: number): void {
  const p = def.palette;
  const camX = cam.x;
  const tone = toneFor(p);

  ctx.save();
  ctx.textBaseline = 'middle';
  syncViewport(ctx, cam);

  foreLayer(ctx, def.theme, p, camX, frame);
  weather(ctx, def.theme, p, camX, frame);
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
        ctx.font = '800 9px "Arial Narrow", system-ui, sans-serif';
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
