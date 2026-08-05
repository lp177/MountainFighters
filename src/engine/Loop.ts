/**
 * Fixed-timestep game loop.
 *
 * The simulation always advances in whole SIM_HZ steps; rendering happens once
 * per animation frame with an interpolation factor, so a 144Hz display gets
 * smooth motion out of a 60Hz sim. Anything that touches sim state must live in
 * `update()`; anything that reads it for display lives in `render(alpha)`.
 */

import { MAX_CATCHUP_STEPS, SIM_HZ } from '@/core/constants';
import { clamp } from '@/core/math';

export interface LoopCallbacks {
  /** One fixed sim step. */
  update(): void;
  /** alpha 0..1 interpolation between the previous and current sim frame. */
  render(alpha: number): void;
}

/** A gap larger than this means the tab stalled; we resync instead of catching up. */
const STALL_MS = 250;

export class GameLoop {
  /** Global time scale for slow-motion. 1 = normal. */
  timeScale = 1;
  /** Frames of global hitstop remaining; the sim skips while > 0. */
  hitstop = 0;

  private readonly cb: LoopCallbacks;
  private readonly stepMs = 1000 / SIM_HZ;
  private raf = 0;
  private running = false;
  private suspended = false;
  private last = 0;
  private acc = 0;
  private _frame = 0;
  private _fps = SIM_HZ;

  constructor(cb: LoopCallbacks) {
    this.cb = cb;
  }

  get fps(): number {
    return this._fps;
  }

  get frame(): number {
    return this._frame;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.suspended = false;
    this.acc = 0;
    this.last = performance.now();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.suspended = false;
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running || this.suspended) return;
    this.raf = requestAnimationFrame(this.tick);

    let elapsed = now - this.last;
    this.last = now;
    if (!(elapsed > 0)) elapsed = 0;
    if (elapsed >= 1) this._fps += (1000 / elapsed - this._fps) * 0.08;
    // A backgrounded or hitched tab must not produce a wall of catch-up steps.
    if (elapsed > STALL_MS) elapsed = this.stepMs;

    this.acc += elapsed * (this.timeScale > 0 ? this.timeScale : 0);

    let steps = 0;
    while (this.acc >= this.stepMs) {
      if (steps >= MAX_CATCHUP_STEPS) {
        // Spiral-of-death guard: drop the backlog rather than fall further behind.
        this.acc = 0;
        break;
      }
      this.acc -= this.stepMs;
      steps++;
      if (this.hitstop > 0) {
        // Freeze-frame: real time passes, the sim does not. This is what makes
        // a heavy hit land with weight.
        this.hitstop--;
        continue;
      }
      this._frame++;
      this.cb.update();
    }

    this.cb.render(clamp(this.acc / this.stepMs, 0, 1));
  };

  private readonly onVisibility = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      if (this.suspended) return;
      this.suspended = true;
      if (this.raf !== 0) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    } else if (this.suspended) {
      this.suspended = false;
      this.last = performance.now();
      this.acc = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  };
}
