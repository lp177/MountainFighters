/**
 * The juice layer.
 *
 * Everything that makes a punch feel like it landed on something that has a
 * skeleton: screen shake, colour flashes, slow motion, impact silhouettes,
 * shockwaves, floating damage numbers and chromatic aberration.
 *
 * Sim code talks to this through the `FxBus` interface, which means it is safe
 * to call from deterministic code: when `muted` is true (rollback / lockstep
 * re-simulation) every entry point returns immediately without touching state
 * and without allocating.
 *
 * Particles are emitted through here but are updated and drawn by whoever owns
 * the `ParticleSystem` — this class only forwards emission so it can apply the
 * reduced-motion budget.
 */

import type {
  FloatingTextSpec,
  FxBus,
  ParticleSpec,
  Settings,
  ShakeSpec,
} from '@/core/types';
import type { Camera } from '@/render/Camera';
import type { Renderer } from '@/render/Renderer';
import type { GameLoop } from '@/engine/Loop';
import type { ParticleSystem } from '@/juice/Particles';
import { clamp, easeIn, easeOut, easeOutBack, lerp, TAU } from '@/core/math';
import {
  CAMERA_PUNCH,
  GROUND_Y,
  IMPACT_FLASH_FRAMES,
  VIEW_W,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';

type C2D = CanvasRenderingContext2D;

const ST_DAMAGE = 0;
const ST_COMBO = 1;
const ST_BONUS = 2;
const ST_TAUNT = 3;
const ST_CRITICAL = 4;

const MAX_TEXTS = 32;
const MAX_SHOCKWAVES = 10;
const MAX_IMPACTS = 24;

/** Frames a floating text takes to pop in. */
const POP_FRAMES = 9;
/** Fraction of a text's life spent fading out. */
const TEXT_FADE = 0.35;
/** Fraction of a slowmo's duration spent diving into the target scale. */
const SLOWMO_IN = 0.18;
/** Particle budget multiplier when the player asked for reduced motion. */
const REDUCED_PARTICLES = 0.35;

class FloatingText {
  active = false;
  text = '';
  x = 0;
  y = 0;
  z = 0;
  oy = 0;
  color = '#ffffff';
  size = 12;
  life = 0;
  maxLife = 1;
  rise = 0;
  style = ST_DAMAGE;
  seed = 0;
}

class Shockwave {
  active = false;
  x = 0;
  y = 0;
  z = 0;
  radius = 0;
  life = 0;
  maxLife = 1;
}

export class Fx implements FxBus {
  muted = false;

  private readonly cam: Camera;
  private readonly ps: ParticleSystem;
  private readonly loop: GameLoop;
  private readonly settings: Settings;

  private flashColor = '#ffffff';
  private flashAlpha = 0;
  private flashLife = 0;
  private flashMax = 1;

  private abStrength = 0;
  private abLife = 0;
  private abMax = 1;

  private smoScale = 1;
  private smoLife = 0;
  private smoMax = 1;

  private readonly impId = new Int32Array(MAX_IMPACTS);
  private readonly impLife = new Float32Array(MAX_IMPACTS);
  private readonly impMax = new Float32Array(MAX_IMPACTS);

  private readonly texts: FloatingText[] = [];
  private readonly waves: Shockwave[] = [];
  private textCursor = 0;
  private waveCursor = 0;

  /** Reused when the reduced-motion budget forces a modified emission. */
  private readonly scratch: ParticleSpec = {
    count: 0,
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    spread: 0,
    speed: [0, 0],
    life: [0, 0],
    size: [0, 0],
    colors: [],
    gravity: 0,
    drag: 0,
    shape: 'dot',
  };

  constructor(cam: Camera, particles: ParticleSystem, loop: GameLoop, settings: Settings) {
    this.cam = cam;
    this.ps = particles;
    this.loop = loop;
    this.settings = settings;
    for (let i = 0; i < MAX_TEXTS; i++) this.texts.push(new FloatingText());
    for (let i = 0; i < MAX_SHOCKWAVES; i++) this.waves.push(new Shockwave());
    this.impId.fill(-1);
  }

  // ── FxBus ──────────────────────────────────────────────────────────────────

  particles(spec: ParticleSpec): void {
    if (this.muted) return;
    if (!this.settings.reducedMotion) {
      this.ps.emit(spec);
      return;
    }
    const s = this.scratch;
    s.count = Math.max(1, Math.round(spec.count * REDUCED_PARTICLES));
    s.x = spec.x;
    s.y = spec.y;
    s.z = spec.z;
    s.angle = spec.angle;
    s.spread = spec.spread;
    s.speed = spec.speed;
    s.life = spec.life;
    s.size = spec.size;
    s.colors = spec.colors;
    s.gravity = spec.gravity;
    s.drag = spec.drag;
    s.shape = spec.shape;
    s.additive = spec.additive;
    s.fade = spec.fade;
    s.spin = spec.spin;
    this.ps.emit(s);
  }

  shake(spec: ShakeSpec): void {
    if (this.muted) return;
    if (this.settings.reducedMotion) return;
    // Camera.addShake applies the global SHAKE_SCALE itself; here we only
    // apply the player's own preference.
    const scale = clamp(this.settings.screenShake, 0, 2);
    if (scale <= 0) return;
    const mag = spec.magnitude * scale;
    if (mag <= 0.02 || spec.duration <= 0) return;
    this.cam.addShake({
      magnitude: mag,
      duration: spec.duration,
      frequency: spec.frequency,
      dirX: spec.dirX,
      dirY: spec.dirY,
    });
    // Heavy hits get a zoom kick on top of the translation, which is what
    // makes a launcher read as a launcher.
    if (spec.magnitude >= 4.5) {
      this.cam.punch(CAMERA_PUNCH * clamp(spec.magnitude / 8, 0.4, 2.4) * scale);
    }
  }

  text(spec: FloatingTextSpec): void {
    if (this.muted) return;
    const t = this.allocText();
    const style = styleCode(spec.style);
    t.active = true;
    t.text = spec.text;
    t.x = spec.x;
    t.y = spec.y;
    t.z = spec.z;
    t.oy = 0;
    t.color = spec.color;
    t.maxLife = Math.max(2, Math.round(spec.life));
    t.life = t.maxLife;
    t.rise = spec.rise;
    t.style = style;
    t.seed = (Math.random() * 65536) | 0;

    let size = spec.size;
    if (style === ST_CRITICAL) size *= 1.6;
    else if (style === ST_COMBO) size *= 1 + clamp(digits(spec.text), 0, 40) * 0.028;
    t.size = Math.max(5, size);
  }

  flash(color: string, frames: number, alpha?: number): void {
    if (this.muted) return;
    if (frames <= 0) return;
    const cap = this.settings.reducedMotion ? 0.22 : 1;
    const a = clamp(alpha === undefined ? 1 : alpha, 0, 1) * cap;
    if (a <= 0.005) return;
    const current = this.flashLife > 0 ? this.flashAlpha * (this.flashLife / this.flashMax) : 0;
    if (a >= current) {
      this.flashColor = color;
      this.flashAlpha = a;
      this.flashLife = frames;
      this.flashMax = frames;
    } else if (frames > this.flashLife) {
      this.flashLife = frames;
      this.flashMax = Math.max(this.flashMax, frames);
    }
  }

  shockwave(x: number, y: number, z: number, radius: number, frames: number): void {
    if (this.muted) return;
    if (frames <= 0 || radius <= 0) return;
    const w = this.waves[this.waveCursor];
    this.waveCursor = (this.waveCursor + 1) % MAX_SHOCKWAVES;
    w.active = true;
    w.x = x;
    w.y = y;
    w.z = z;
    w.radius = radius;
    w.maxLife = Math.max(2, Math.round(frames));
    w.life = w.maxLife;
  }

  slowmo(scale: number, frames: number): void {
    if (this.muted) return;
    if (this.settings.reducedMotion) return;
    if (frames <= 0) return;
    const s = clamp(scale, 0.05, 1);
    if (s >= 0.999) return;
    if (this.smoLife <= 0) {
      this.smoScale = s;
      this.smoLife = frames;
      this.smoMax = frames;
    } else {
      this.smoScale = Math.min(this.smoScale, s);
      this.smoLife = Math.max(this.smoLife, frames);
      this.smoMax = Math.max(this.smoMax, this.smoLife);
    }
  }

  impactFrame(fighterId: number, frames: number): void {
    if (this.muted) return;
    const n = frames > 0 ? frames : IMPACT_FLASH_FRAMES;
    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.impId[i] === fighterId && this.impLife[i] > 0) {
        this.impLife[i] = Math.max(this.impLife[i], n);
        this.impMax[i] = Math.max(this.impMax[i], this.impLife[i]);
        return;
      }
    }
    let slot = -1;
    let weakest = Infinity;
    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.impLife[i] <= 0) {
        slot = i;
        break;
      }
      if (this.impLife[i] < weakest) {
        weakest = this.impLife[i];
        slot = i;
      }
    }
    if (slot < 0) return;
    this.impId[slot] = fighterId;
    this.impLife[slot] = n;
    this.impMax[slot] = n;
  }

  aberration(strength: number, frames: number): void {
    if (this.muted) return;
    if (this.settings.reducedMotion) return;
    if (frames <= 0 || strength <= 0) return;
    const current = this.abLife > 0 ? this.abStrength * (this.abLife / this.abMax) : 0;
    if (strength >= current) {
      this.abStrength = strength;
      this.abLife = frames;
      this.abMax = frames;
    } else if (frames > this.abLife) {
      this.abLife = frames;
      this.abMax = Math.max(this.abMax, frames);
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────

  /**
   * How hard a fighter should be drawn as a flat white silhouette this frame,
   * 0..1. `Fighter.render` reads this to blow out its own art on a big hit.
   */
  isImpactFlashing(id: number): number {
    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.impId[i] === id && this.impLife[i] > 0) {
        return clamp(this.impLife[i] / Math.max(1, this.impMax[i]), 0, 1);
      }
    }
    return 0;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(): void {
    if (this.flashLife > 0) this.flashLife--;

    if (this.abLife > 0) {
      this.abLife--;
      if (this.abLife <= 0) this.abStrength = 0;
    }

    if (this.smoLife > 0) {
      this.smoLife--;
      const t = 1 - this.smoLife / this.smoMax;
      let s: number;
      if (t < SLOWMO_IN) s = lerp(1, this.smoScale, easeOut(t / SLOWMO_IN));
      else s = lerp(this.smoScale, 1, easeIn((t - SLOWMO_IN) / (1 - SLOWMO_IN)));
      this.loop.timeScale = this.smoLife <= 0 ? 1 : s;
    }

    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.impLife[i] > 0) {
        this.impLife[i]--;
        if (this.impLife[i] <= 0) this.impId[i] = -1;
      }
    }

    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const w = this.waves[i];
      if (!w.active) continue;
      w.life--;
      if (w.life <= 0) w.active = false;
    }

    for (let i = 0; i < MAX_TEXTS; i++) {
      const t = this.texts[i];
      if (!t.active) continue;
      t.life--;
      if (t.life <= 0) {
        t.active = false;
        continue;
      }
      // Decelerating rise, so the number pops away then hangs before it fades.
      t.oy += t.rise * (0.28 + 0.72 * (t.life / t.maxLife));
    }
  }

  /**
   * World-space layer: shockwaves and floating text. Call inside
   * `Renderer.withCamera` — the scroll, zoom and shake are already in the
   * transform there, so x is drawn raw and the camera is only used to cull.
   */
  render(ctx: C2D, cam: Camera): void {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const w = this.waves[i];
      if (w.active) this.drawShockwave(ctx, w, cam);
    }
    let any = false;
    for (let i = 0; i < MAX_TEXTS; i++) {
      const t = this.texts[i];
      if (!t.active) continue;
      if (!any) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        any = true;
      }
      this.drawText(ctx, t, cam);
    }
    if (any) ctx.restore();
  }

  /** Screen-space layer: full-screen flash and chromatic aberration. */
  renderOverlay(r: Renderer): void {
    if (this.flashLife > 0) {
      const t = this.flashLife / this.flashMax;
      const a = this.flashAlpha * t * t * (0.6 + 0.4 * t);
      if (a > 0.004) r.flash(this.flashColor, a);
    }
    if (this.abLife > 0 && !this.settings.reducedMotion) {
      const s = this.abStrength * (this.abLife / this.abMax);
      if (s > 0.01) r.aberration(s);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private allocText(): FloatingText {
    for (let i = 0; i < MAX_TEXTS; i++) {
      const t = this.texts[i];
      if (!t.active) return t;
    }
    const t = this.texts[this.textCursor];
    this.textCursor = (this.textCursor + 1) % MAX_TEXTS;
    return t;
  }

  private drawText(ctx: C2D, t: FloatingText, cam: Camera): void {
    const age = t.maxLife - t.life;
    const life = t.life / t.maxLife;
    const ps = clamp(1 - t.z * Z_PERSPECTIVE * 0.5, 0.75, 1.1);

    let scale = age < POP_FRAMES ? easeOutBack(clamp((age + 1) / POP_FRAMES, 0, 1)) : 1;
    if (t.style === ST_COMBO && age < 24) scale *= 1 + 0.09 * Math.sin(age * 0.55);

    let sx = t.x;
    let sy = GROUND_Y + t.z * Z_SCALE - t.y - t.oy;
    if (t.style === ST_BONUS) sx += Math.sin(age * 0.18) * 2.4;
    if (t.style === ST_CRITICAL && !this.settings.reducedMotion) {
      const jitter = 2.6 * Math.max(0, 1 - age / 18);
      sx += (Math.random() - 0.5) * jitter;
      sy += (Math.random() - 0.5) * jitter;
    }

    const size = Math.max(5, t.size * scale * ps);
    const onScreen = t.x - cam.x;
    if (onScreen < -140 || onScreen > VIEW_W + 140) return;

    const alpha = clamp(life > TEXT_FADE ? 1 : life / TEXT_FADE, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.font =
      (t.style === ST_TAUNT ? 'italic 900 ' : '900 ') +
      size.toFixed(1) +
      'px Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif';

    const fill = t.style === ST_CRITICAL ? '#ffe14a' : t.color;

    if (t.style === ST_CRITICAL) {
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = '#ff3b12';
      ctx.lineWidth = size * 0.46;
      ctx.strokeText(t.text, sx, sy);
      ctx.globalAlpha = alpha;
    }

    ctx.globalAlpha = alpha * 0.45;
    ctx.fillStyle = '#000000';
    ctx.fillText(t.text, sx + 1.2, sy + 1.6);

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = t.style === ST_CRITICAL ? '#3a0800' : '#15121c';
    ctx.lineWidth = Math.max(1.4, size * 0.2);
    ctx.strokeText(t.text, sx, sy);
    ctx.fillStyle = fill;
    ctx.fillText(t.text, sx, sy);
  }

  private drawShockwave(ctx: C2D, w: Shockwave, cam: Camera): void {
    const t = 1 - w.life / w.maxLife;
    const sx = w.x;
    const sy = GROUND_Y + w.z * Z_SCALE - w.y;
    const r = Math.max(2, w.radius * easeOut(t));
    const onScreen = w.x - cam.x;
    if (onScreen + r < -40 || onScreen - r > VIEW_W + 40) return;
    const a = (1 - t) * (1 - t);

    if (!this.settings.reducedMotion && t < 0.9) {
      this.warp(ctx, sx, sy, r, 1 + 0.11 * (1 - t));
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    ctx.globalAlpha = a * 0.85;
    ctx.strokeStyle = '#bfe3ff';
    ctx.lineWidth = Math.max(0.8, w.radius * 0.09 * (1 - t));
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 0.9, 0, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = a * 0.6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(0.5, w.radius * 0.035 * (1 - t));
    ctx.beginPath();
    ctx.ellipse(sx, sy, r * 0.84, r * 0.76, 0, 0, TAU);
    ctx.stroke();

    // A flat ripple on the floor plane ties the blast to the ground.
    ctx.globalAlpha = a * 0.4;
    ctx.strokeStyle = '#8fc6ff';
    ctx.lineWidth = Math.max(0.6, w.radius * 0.05 * (1 - t));
    ctx.beginPath();
    ctx.ellipse(sx, GROUND_Y + w.z * Z_SCALE, r * 1.15, r * 0.3, 0, 0, TAU);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Fake refraction: re-draw the already-composited frame into an annulus,
   * scaled up slightly. One drawImage instead of a per-pixel displacement pass.
   */
  private warp(ctx: C2D, cx: number, cy: number, r: number, k: number): void {
    const canvas = ctx.canvas;
    const m = ctx.getTransform();
    const x0 = cx - r;
    const y0 = cy - r;
    const size = r * 2;
    const dx0 = m.a * x0 + m.c * y0 + m.e;
    const dy0 = m.b * x0 + m.d * y0 + m.f;
    const dw = m.a * size;
    const dh = m.d * size;
    if (!(dw > 1) || !(dh > 1)) return;
    if (dx0 + dw <= 0 || dy0 + dh <= 0 || dx0 >= canvas.width || dy0 >= canvas.height) return;
    const g = r * (k - 1);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.moveTo(cx + r * 0.6, cy);
    ctx.arc(cx, cy, r * 0.6, 0, TAU, true);
    ctx.clip('evenodd');
    ctx.drawImage(canvas, dx0, dy0, dw, dh, x0 - g, y0 - g, size + g * 2, size + g * 2);
    ctx.restore();
  }
}

function styleCode(s: FloatingTextSpec['style']): number {
  switch (s) {
    case 'combo':
      return ST_COMBO;
    case 'bonus':
      return ST_BONUS;
    case 'taunt':
      return ST_TAUNT;
    case 'critical':
      return ST_CRITICAL;
    default:
      return ST_DAMAGE;
  }
}

/** First run of digits in a string, e.g. "12 HITS" -> 12. */
function digits(s: string): number {
  let n = 0;
  let seen = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48);
      seen = true;
      if (n > 999) break;
    } else if (seen) {
      break;
    }
  }
  return seen ? n : 0;
}
