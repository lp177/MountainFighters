/**
 * Canvas2D front end.
 *
 * The whole game is authored at a virtual VIEW_W x VIEW_H. The backing store is
 * sized to the window times devicePixelRatio and a base transform scales the
 * virtual units up, so nothing is ever resampled: lines land on real device
 * pixels and the vector art stays crisp at any window size.
 */

import type { Vec2 } from '@/core/types';
import type { Camera } from '@/render/Camera';
import { clamp } from '@/core/math';
import { GROUND_Y, VIEW_H, VIEW_W, Z_SCALE } from '@/core/constants';

/** Maximum channel displacement of the aberration pass, in virtual pixels. */
const ABERRATION_MAX = 4;
/** Beyond 3x the extra pixels cost more than they show. */
const MAX_DPR = 3;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;

  private readonly canvas: HTMLCanvasElement;
  /** Device pixels per virtual pixel. */
  private sx = 1;
  private sy = 1;
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Mountain Fighters needs a 2D canvas context.');
    this.ctx = ctx;
    this.resize();
  }

  get width(): number {
    return VIEW_W;
  }

  get height(): number {
    return VIEW_H;
  }

  resize(): void {
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DPR);
    const availW = Math.max(1, window.innerWidth || VIEW_W);
    const availH = Math.max(1, window.innerHeight || VIEW_H);

    // Uniform fit, letterboxed: the canvas element *is* the pillar/letterboxed
    // rect, so the page background shows through around it.
    const fit = Math.min(availW / VIEW_W, availH / VIEW_H) * dpr;
    const bw = Math.max(1, Math.round(VIEW_W * fit));
    const bh = Math.max(1, Math.round(VIEW_H * fit));

    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    const style = this.canvas.style;
    style.width = `${bw / dpr}px`;
    style.height = `${bh / dpr}px`;
    style.display = 'block';
    style.margin = 'auto';

    this.sx = bw / VIEW_W;
    this.sy = bh / VIEW_H;
    this.applyBase();
  }

  begin(): void {
    this.ctx.save();
    this.applyBase();
  }

  end(): void {
    this.ctx.restore();
  }

  clear(color: string): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  withCamera(cam: Camera, fn: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    // Zoom and roll happen about the middle of the view, not its corner.
    ctx.translate(VIEW_W * 0.5, VIEW_H * 0.5);
    if (cam.rotation !== 0) ctx.rotate(cam.rotation);
    if (cam.zoom !== 1) ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-VIEW_W * 0.5, -VIEW_H * 0.5);
    ctx.translate(-cam.x + cam.shakeX, cam.shakeY);
    try {
      fn();
    } finally {
      ctx.restore();
    }
  }

  withScreen(fn: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    this.applyBase();
    try {
      fn();
    } finally {
      ctx.restore();
    }
  }

  project(x: number, y: number, z: number, cam: Camera): Vec2 {
    return { x: x - cam.x, y: GROUND_Y + z * Z_SCALE - y };
  }

  flash(color: string, alpha: number): void {
    if (!(alpha > 0)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  /**
   * Chromatic aberration on the frame that has just been drawn.
   *
   * Cheap by construction: the cyan half is a single multiply fill straight onto
   * the frame, and only the red half needs a copy. One offscreen, two fills, two
   * blits — screening the shifted red back over the cyan reconstructs the exact
   * original image wherever the two align, so the seam only shows at the fringe.
   */
  aberration(strength: number): void {
    if (!(strength > 0)) return;

    const c = this.canvas;
    const w = c.width;
    const h = c.height;
    if (w < 2 || h < 2) return;

    const shift = Math.round(clamp(strength, 0, 1) * ABERRATION_MAX * this.sx);
    if (shift < 1) return;

    const off = this.off ?? this.createOffscreen();
    const octx = this.offCtx;
    if (!off || !octx) return;
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, w, h);
    octx.drawImage(c, 0, 0);

    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#00ffff';
    ctx.fillRect(0, 0, w, h);

    octx.globalCompositeOperation = 'multiply';
    octx.fillStyle = '#ff0000';
    octx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(off, shift, 0);

    ctx.restore();
  }

  private applyBase(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  private createOffscreen(): HTMLCanvasElement | null {
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    if (!octx) return null;
    this.off = off;
    this.offCtx = octx;
    return off;
  }
}
