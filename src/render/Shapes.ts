/**
 * Bold-outline vector primitives.
 *
 * Every visible thing in the game is built from these, so they are written for
 * throughput: no arrays allocated per call, no save/restore where setting the
 * two or three properties that change is cheaper, and no transforms where the
 * geometry can be computed straight into the path.
 *
 * The house style is: stroke the path with a doubled dark line first, then fill
 * over the inner half. That leaves a clean, even ink edge on every silhouette.
 */

import { TAU, clamp } from '@/core/math';

type C2D = CanvasRenderingContext2D;

/** The ink everything is outlined with. Near-black with a bruise of violet. */
const INK = '#141019';
const DEFAULT_OUTLINE_WIDTH = 2;
/** Spec highlight on studs and chrome. */
const GLINT = '#e6ebf5';

/** Callers pass this instead of a colour to skip the stroke or the fill. */
const NONE = 'none';

function stylePath(ctx: C2D, fill: string, outline: string, ow: number): void {
  if (ow > 0 && outline !== NONE && outline !== '') {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = ow * 2;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  if (fill !== NONE && fill !== '') {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

/** A stadium between two joints, optionally tapered. Shared by capsule/limb. */
function tubePath(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r1: number,
  r2: number,
): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const q = Math.PI * 0.5;
  ctx.beginPath();
  ctx.arc(x1, y1, Math.max(0.01, r1), a + q, a - q);
  ctx.arc(x2, y2, Math.max(0.01, r2), a - q, a + q);
  ctx.closePath();
}

function frac(v: number): number {
  const s = Math.sin(v * 91.7318) * 4375.8547;
  return s - Math.floor(s);
}

export function setOutline(ctx: C2D, width: number, color: string): void {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

/** Closed polygon from a flat [x0,y0, x1,y1, ...] buffer. */
export function poly(
  ctx: C2D,
  pts: readonly number[],
  fill: string,
  outline: string = INK,
  ow: number = DEFAULT_OUTLINE_WIDTH,
): void {
  const n = pts.length;
  if (n < 6) return;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i + 1 < n; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  stylePath(ctx, fill, outline, ow);
}

export function roundRect(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  outline: string = INK,
  ow: number = DEFAULT_OUTLINE_WIDTH,
): void {
  let x0 = x;
  let y0 = y;
  let ww = w;
  let hh = h;
  if (ww < 0) {
    x0 += ww;
    ww = -ww;
  }
  if (hh < 0) {
    y0 += hh;
    hh = -hh;
  }
  const rr = Math.min(r, ww * 0.5, hh * 0.5);
  const x1 = x0 + ww;
  const y1 = y0 + hh;

  ctx.beginPath();
  if (rr <= 0) {
    ctx.rect(x0, y0, ww, hh);
  } else {
    ctx.moveTo(x0 + rr, y0);
    ctx.arcTo(x1, y0, x1, y1, rr);
    ctx.arcTo(x1, y1, x0, y1, rr);
    ctx.arcTo(x0, y1, x0, y0, rr);
    ctx.arcTo(x0, y0, x1, y0, rr);
    ctx.closePath();
  }
  stylePath(ctx, fill, outline, ow);
}

export function ellipse(
  ctx: C2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rot: number,
  fill: string,
  outline: string = INK,
  ow: number = DEFAULT_OUTLINE_WIDTH,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, Math.abs(rx)), Math.max(0.01, Math.abs(ry)), rot, 0, TAU);
  stylePath(ctx, fill, outline, ow);
}

export function capsule(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
  fill: string,
  outline: string = INK,
  ow: number = DEFAULT_OUTLINE_WIDTH,
): void {
  tubePath(ctx, x1, y1, x2, y2, r, r);
  stylePath(ctx, fill, outline, ow);
}

/** Tapered arm or leg: thickness w1 at the first joint, w2 at the second. */
export function limb(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w1: number,
  w2: number,
  fill: string,
  outline: string = INK,
): void {
  tubePath(ctx, x1, y1, x2, y2, w1, w2);
  stylePath(ctx, fill, outline, DEFAULT_OUTLINE_WIDTH);
}

export function star(
  ctx: C2D,
  x: number,
  y: number,
  r: number,
  points: number,
  fill: string,
  outline: string = INK,
): void {
  const n = Math.max(3, points | 0);
  const inner = r * 0.45;
  const step = Math.PI / n;
  ctx.beginPath();
  for (let i = 0, k = n * 2; i < k; i++) {
    const rad = i & 1 ? inner : r;
    const a = -Math.PI * 0.5 + i * step;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  stylePath(ctx, fill, outline, DEFAULT_OUTLINE_WIDTH);
}

/**
 * The studs on a leather jacket: `count` metal spikes standing off the segment,
 * pointing along its left normal.
 */
export function spikeStrip(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  count: number,
  size: number,
  color: string,
): void {
  const n = Math.max(1, count | 0);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.001 || size <= 0) return;

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const bx = ux * size * 0.62;
  const by = uy * size * 0.62;
  const tipX = nx * size * 1.15;
  const tipY = ny * size * 1.15;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : (i + 0.5) / n;
    const px = x1 + dx * t;
    const py = y1 + dy * t;

    ctx.beginPath();
    ctx.moveTo(px - bx, py - by);
    ctx.lineTo(px + tipX, py + tipY);
    ctx.lineTo(px + bx, py + by);
    ctx.closePath();
    ctx.lineWidth = Math.max(1, size * 0.5);
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();

    if (size >= 2) {
      ctx.beginPath();
      ctx.moveTo(px - bx * 0.35, py - by * 0.35);
      ctx.lineTo(px + tipX * 0.7, py + tipY * 0.7);
      ctx.lineWidth = Math.max(0.6, size * 0.2);
      ctx.strokeStyle = GLINT;
      ctx.stroke();
    }
  }
}

/** Flat contact shadow on the ground plane. */
export function shadow(ctx: C2D, x: number, y: number, rx: number, alpha: number): void {
  const r = Math.abs(rx);
  if (r < 0.01 || alpha <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp(alpha, 0, 1);
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.34, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = prev;
}

/** Bumped every call so a bolt held in one place still crackles frame to frame. */
let boltPhase = 0;

/** Taser arc: a jagged line with a glow, a body and a hot white core. */
export function zigzag(
  ctx: C2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  amp: number,
  segs: number,
  color: string,
  w: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;

  const n = Math.max(2, segs | 0);
  const nx = -dy / len;
  const ny = dx / len;
  const seed = ++boltPhase;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    // Pinned at both ends, wildest in the middle.
    const taper = Math.sin(t * Math.PI);
    const jitter = 0.55 + 0.45 * frac(i * 3.7 + seed);
    const o = (i & 1 ? amp : -amp) * jitter * taper;
    ctx.lineTo(x1 + dx * t + nx * o, y1 + dy * t + ny * o);
  }
  ctx.lineTo(x2, y2);

  const prev = ctx.globalAlpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.strokeStyle = color;
  ctx.globalAlpha = prev * 0.28;
  ctx.lineWidth = Math.max(1, w * 2.4);
  ctx.stroke();

  ctx.globalAlpha = prev;
  ctx.lineWidth = Math.max(0.75, w);
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = prev * 0.85;
  ctx.lineWidth = Math.max(0.5, w * 0.38);
  ctx.stroke();

  ctx.globalAlpha = prev;
}

/** Comic impact star — ragged spikes, inked edge, drawn on the hit. */
export function burst(
  ctx: C2D,
  x: number,
  y: number,
  r: number,
  spikes: number,
  color: string,
  rot: number,
): void {
  const n = Math.max(3, spikes | 0);
  const step = Math.PI / n;
  ctx.beginPath();
  for (let i = 0, k = n * 2; i < k; i++) {
    const j = frac(i * 1.73 + n * 0.31);
    const rad = i & 1 ? r * (0.32 + 0.14 * j) : r * (0.76 + 0.24 * j);
    const a = rot + i * step;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  stylePath(ctx, color, INK, Math.max(1.25, r * 0.06));
}
