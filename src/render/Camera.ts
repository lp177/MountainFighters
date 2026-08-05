/**
 * The 2.5D belt-scroller camera.
 *
 * Everything here is presentation-side: shake, lookahead and the zoom punch are
 * deliberately outside the deterministic sim, so wall-clock-ish frame counting
 * and non-sim maths are fine. No Math.random all the same — a rumble built from
 * value noise reads far better than white noise, and it stays reproducible.
 */

import type { Facing, ShakeSpec } from '@/core/types';
import { clamp, lerp } from '@/core/math';
import {
  CAMERA_LERP,
  CAMERA_LOOKAHEAD,
  SHAKE_DECAY,
  SHAKE_SCALE,
  VIEW_W,
} from '@/core/constants';

/** A full-trauma shake fades out over roughly this many frames at SHAKE_DECAY. */
const SHAKE_REF_FRAMES = 14;
/** Noise steps per frame at frequency 1. Tuned to read as a rumble, not static. */
const SHAKE_BASE_FREQ = 0.42;
/** Below this the shake is invisible, so it is snapped off entirely. */
const TRAUMA_EPSILON = 0.004;
const PUNCH_DECAY = 0.87;
const MAX_PUNCH = 0.5;

function hash1(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smooth 1D value noise in [-1, 1]. */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  return lerp(hash1(i + seed), hash1(i + 1 + seed), f * f * (3 - 2 * f));
}

export class Camera {
  /** World x of the left edge of the view. */
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0;

  private _trauma = 0;
  private _amp = 0;
  private _freq = 1;
  private _dirX = 1;
  private _dirY = 1;
  private _shakeX = 0;
  private _shakeY = 0;
  private _t = 0;

  private _punch = 0;
  private _zoomBase = 1;
  private _lastZoom = 1;

  private _lead = 0;
  private _lastMid = 0;
  private _hasMid = false;

  /**
   * Centre on the midpoint of the targets, leading in the direction they face
   * (or, when the caller only hands us positions, the direction they move).
   * The view is clamped so the map edge is never crossed.
   */
  follow(targets: readonly { x: number; facing?: Facing }[], mapWidth: number): void {
    const n = targets.length;
    if (n === 0) return;

    let min = targets[0].x;
    let max = min;
    let face = 0;
    for (let i = 0; i < n; i++) {
      const t = targets[i];
      if (t.x < min) min = t.x;
      if (t.x > max) max = t.x;
      if (t.facing) face += t.facing;
    }

    const mid = (min + max) * 0.5;
    if (!this._hasMid) {
      this._lastMid = mid;
      this._hasMid = true;
    }
    if (face === 0) {
      const drift = mid - this._lastMid;
      if (drift > 0.05) face = 1;
      else if (drift < -0.05) face = -1;
    }
    this._lastMid = mid;

    const wantLead = face > 0 ? CAMERA_LOOKAHEAD : face < 0 ? -CAMERA_LOOKAHEAD : 0;
    this._lead = lerp(this._lead, wantLead, CAMERA_LERP * 0.5);

    // Bounds are in *visible* width, not VIEW_W: see viewMargin().
    const margin = this.viewMargin();
    const minX = -margin;
    const maxX = Math.max(minX, mapWidth - VIEW_W + margin);
    const want = clamp(mid + this._lead - VIEW_W * 0.5, minX, maxX);
    this.x = clamp(lerp(this.x, want, CAMERA_LERP), minX, maxX);
  }

  /**
   * Half the width the zoom crops off the view.
   *
   * `Renderer.withCamera` scales about the middle of the frame, so at zoom z
   * only VIEW_W / z world units are on screen and the middle of the view is
   * still `x + VIEW_W / 2`. The camera may therefore travel this far past each
   * end of the old [0, mapWidth - VIEW_W] range before the edge of the map
   * actually comes into shot — clamping to the old range instead leaves the
   * players walking off the side of a view that has stopped following them.
   * Zero at 1x, so the default framing is bit-for-bit what it always was.
   */
  private viewMargin(): number {
    const z = this.zoom > 0.05 ? this.zoom : 1;
    return (VIEW_W - VIEW_W / z) * 0.5;
  }

  /**
   * The zoom the scene asked for, ignoring the hit-kick riding on top of it.
   *
   * An external write is adopted immediately rather than on the next update(),
   * so the play area is correct on the very first frame of a scene instead of
   * being a frame late and letting a fighter start out of bounds.
   */
  get baseZoom(): number {
    const z = this.zoom !== this._lastZoom ? this.zoom : this._zoomBase;
    return z > 0.05 ? z : 1;
  }

  /**
   * World x of the left and right edges of what is ACTUALLY on screen.
   *
   * Deliberately measured off baseZoom, not zoom: the camera punch would
   * otherwise breathe the play area in and out on every heavy hit, and a
   * boundary that moves while you are being knocked into it is worse than no
   * boundary at all.
   */
  get playLeft(): number {
    return this.x + (VIEW_W - VIEW_W / this.baseZoom) * 0.5;
  }

  get playRight(): number {
    return this.x + VIEW_W - (VIEW_W - VIEW_W / this.baseZoom) * 0.5;
  }

  addShake(spec: ShakeSpec): void {
    const mag = spec.magnitude * SHAKE_SCALE;
    if (!(mag > 0)) return;

    const duration = spec.duration > 0 ? spec.duration : SHAKE_REF_FRAMES;
    this._trauma = clamp(this._trauma + clamp(duration / SHAKE_REF_FRAMES, 0.2, 1), 0, 1);
    this._amp = Math.max(this._amp, mag);
    this._freq = spec.frequency && spec.frequency > 0 ? spec.frequency : 1;

    const directed = spec.dirX !== undefined || spec.dirY !== undefined;
    let dx = directed ? Math.abs(spec.dirX ?? 0) : 1;
    let dy = directed ? Math.abs(spec.dirY ?? 0) : 1;
    if (dx === 0 && dy === 0) {
      dx = 1;
      dy = 1;
    }
    this._dirX = dx;
    this._dirY = dy;
  }

  punch(amount: number): void {
    this._punch = clamp(this._punch + amount, -MAX_PUNCH, MAX_PUNCH);
  }

  update(): void {
    this._t++;

    if (this._trauma > 0) {
      // Squared trauma so the tail of a shake dies away perceptually, not linearly.
      const m = this._amp * this._trauma * this._trauma;
      const p = this._t * SHAKE_BASE_FREQ * this._freq;
      this._shakeX = m * this._dirX * noise1(p, 0);
      this._shakeY = m * this._dirY * noise1(p * 1.13 + 17, 31.7);

      this._trauma *= SHAKE_DECAY;
      if (this._trauma < TRAUMA_EPSILON) {
        this._trauma = 0;
        this._amp = 0;
        this._shakeX = 0;
        this._shakeY = 0;
      }
    } else if (this._shakeX !== 0 || this._shakeY !== 0) {
      this._shakeX = 0;
      this._shakeY = 0;
    }

    // A kick rides on top of whatever zoom the scene asked for. Anything that
    // writes `zoom` directly (cutscenes, the select screen) becomes the new
    // resting value rather than being clobbered by the kick that is in flight.
    if (this.zoom !== this._lastZoom) this._zoomBase = this.zoom;
    if (this._punch !== 0) {
      this._punch *= PUNCH_DECAY;
      if (Math.abs(this._punch) < 0.0004) this._punch = 0;
    }
    this.zoom = this._zoomBase + this._punch;
    this._lastZoom = this.zoom;
  }

  /** Jump the view so world x sits in the centre. No smoothing, no lead. */
  snapTo(x: number): void {
    this.x = Math.max(-this.viewMargin(), x - VIEW_W * 0.5);
    this._lastMid = x;
    this._hasMid = true;
    this._lead = 0;
  }

  get shakeX(): number {
    return this._shakeX;
  }

  get shakeY(): number {
    return this._shakeY;
  }
}
