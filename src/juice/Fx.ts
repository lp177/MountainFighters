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
 *
 * GORE lives here too, because gore is a *policy* as much as an effect:
 * `Settings.gore` is read live on every entry point, 'off' means nothing wet
 * ever spawns (the hits, the wear and the exhaustion still read, just
 * bloodlessly), and 'max' simply scales the same emitters up. Screen-space gore
 * — the lens spatter and the fatality grade — is additionally damped by
 * `reducedMotion`, since that is the part that happens to the player's eyes
 * rather than to the fighter.
 */

import type { FloatingTextSpec, FxBus, Settings, ShakeSpec } from '@/core/types';
import type { Camera } from '@/render/Camera';
import type { Renderer } from '@/render/Renderer';
import type { GameLoop } from '@/engine/Loop';
import type { EmitSpec, ParticleSystem } from '@/juice/Particles';
import { clamp, easeIn, easeOut, easeOutBack, lerp, TAU } from '@/core/math';
import {
  CAMERA_PUNCH,
  GROUND_Y,
  IMPACT_FLASH_FRAMES,
  VIEW_H,
  VIEW_W,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';

type C2D = CanvasRenderingContext2D;

/**
 * How wet a single moment is, matching `FatalityDef.gore`. This is the severity
 * of the *event*, not the player's setting — `Settings.gore` scales all three
 * and silences all three at 'off'.
 */
export type GoreGrade = 'light' | 'heavy' | 'absurd';

/** What is coming out of the thing. Robots leak, they do not bleed. */
export type SprayKind = 'blood' | 'oil';

const ST_DAMAGE = 0;
const ST_COMBO = 1;
const ST_BONUS = 2;
const ST_TAUNT = 3;
const ST_CRITICAL = 4;

const MAX_TEXTS = 32;
const MAX_SHOCKWAVES = 10;
const MAX_IMPACTS = 24;

/** Blobs of blood the camera lens can carry at once. */
const MAX_LENS = 26;
/** Base life of a lens blob, in frames. It runs out over several seconds. */
const LENS_LIFE = 230;

/** Frames a floating text takes to pop in. */
const POP_FRAMES = 9;
/** Fraction of a text's life spent fading out. */
const TEXT_FADE = 0.35;
/** Fraction of a slowmo's duration spent diving into the target scale. */
const SLOWMO_IN = 0.18;
/** Particle budget multiplier when the player asked for reduced motion. */
const REDUCED_PARTICLES = 0.35;

/** Fat, dark, arterial. The wet end of the palette; sparks live in Combat.ts. */
const BLOOD_DROP = ['#c2122a', '#9b0b1e', '#e3454a', '#7d0616'];
/** The fine stuff that hangs in the air for a few frames after a good hit. */
const BLOOD_MIST = ['#ff5d5d', '#e3454a', '#ffb3b3'];
/** Offal: darker than blood, with a pale fatty note. */
const GIB_MEAT = ['#a81530', '#7d0d20', '#c94a4a', '#d99a8f'];
/** Hydraulic fluid and coolant, for everything that was never alive. */
const OIL_DROP = ['#2b2731', '#181419', '#4a3f2c', '#6b5a3a'];
const OIL_MIST = ['#6b5a3a', '#4a3f2c', '#9aa3b0'];
const OIL_SCRAP = ['#8f96a3', '#5a5f6b', '#c9d3e0', '#3ad07a'];
/** On the glass, blood is nearly black until the light gets behind it. */
const LENS_BLOOD = '#8a0f1c';
const LENS_RIM = '#ff5c4e';

class LensBlob {
  active = false;
  x = 0;
  y = 0;
  r = 3;
  /** Downward slide speed in virtual pixels per frame. */
  vy = 0;
  /** Length of the smear it has dragged down the glass so far. */
  trail = 0;
  life = 0;
  maxLife = 1;
  seed = 0;
}

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

  private readonly lens: LensBlob[] = [];
  private lensCursor = 0;
  private lensLive = 0;

  private gradeStrength = 0;
  private gradeLife = 0;
  private gradeMax = 1;

  /** Set for the duration of one `renderOverlay`, read by the bound draw pass. */
  private overlayCtx: C2D | null = null;

  /** Reused when the reduced-motion budget forces a modified emission. */
  private readonly scratch: EmitSpec = {
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

  /**
   * Second scratch spec, owned by the gore emitters. They fill this and hand it
   * to `particles()`, which copies into `scratch` if the reduced-motion budget
   * applies — so the two never fight over the same buffer.
   */
  private readonly gspec: EmitSpec = {
    count: 0,
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    spread: 0,
    speed: [0, 0],
    life: [0, 0],
    size: [0, 0],
    colors: BLOOD_DROP,
    gravity: 0,
    drag: 0,
    shape: 'blood',
    additive: false,
    fade: 'ease',
    spin: 0,
  };

  constructor(cam: Camera, particles: ParticleSystem, loop: GameLoop, settings: Settings) {
    this.cam = cam;
    this.ps = particles;
    this.loop = loop;
    this.settings = settings;
    for (let i = 0; i < MAX_TEXTS; i++) this.texts.push(new FloatingText());
    for (let i = 0; i < MAX_SHOCKWAVES; i++) this.waves.push(new Shockwave());
    for (let i = 0; i < MAX_LENS; i++) this.lens.push(new LensBlob());
    this.impId.fill(-1);
  }

  // ── FxBus ──────────────────────────────────────────────────────────────────

  particles(spec: EmitSpec): void {
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

  // ── gore ───────────────────────────────────────────────────────────────────

  /**
   * The standard impact spray.
   *
   * `dir` is the direction the blow travelled: a facing (+1 right, -1 left) or,
   * if the caller has one, a world angle in radians — anything outside ±1 is
   * read as an angle, which is what lets the combat resolver hand this the same
   * cone angle it passes its own emitters.
   *
   * `amount` is a 0..1 intensity dial; a figure above 3 is read as raw damage
   * points and normalised instead, so a call site holding either number is fine.
   *
   * `gore` is the severity of THIS moment: a `FatalityDef.gore` grade, or a
   * `Settings.gore` value, or 'blood'/'oil' when all the caller knows is what
   * the thing is full of. Every one of those unions turns up at some call site;
   * 'off' always means nothing at all, and 'oil' comes out black.
   */
  blood(
    x: number,
    y: number,
    z: number,
    dir: number,
    amount: number,
    gore: GoreGrade | Settings['gore'] | SprayKind = 'light',
  ): void {
    if (this.muted || gore === 'off') return;
    const g = this.goreScale();
    if (g <= 0) return;
    const amt = intensity(amount);
    if (amt <= 0) return;
    const big = gore === 'heavy' || gore === 'absurd' || gore === 'max' || amt > 0.8;
    const oil = gore === 'oil';

    // The wet half: fat droplets thrown along the blow, which arc, tumble and
    // end their lives as stains on the floor.
    const s = this.gspec;
    s.count = Math.round(clamp((5 + amt * 15) * g, 3, 64));
    s.x = x;
    s.y = y;
    s.z = z;
    s.angle = sprayAngle(dir, 0.32);
    s.spread = 1.5;
    s.speed[0] = 1.1 + amt * 1.5;
    s.speed[1] = 2.9 + amt * 5.4;
    s.life[0] = 16;
    s.life[1] = 38 + amt * 26;
    s.size[0] = 0.8;
    s.size[1] = 1.3 + amt * 1.7;
    s.colors = oil ? OIL_DROP : BLOOD_DROP;
    s.gravity = 0.34;
    s.drag = 0.985;
    s.shape = 'blood';
    s.additive = false;
    s.fade = 'ease';
    s.spin = 0.2;
    this.particles(s);

    // The fine half: a puff of mist that never reaches the ground.
    s.count = Math.round(clamp((3 + amt * 9) * g, 2, 40));
    s.spread = 2.1;
    s.speed[0] = 1.8 + amt * 2;
    s.speed[1] = 4.4 + amt * 4;
    s.life[0] = 5;
    s.life[1] = 13;
    s.size[0] = 0.45;
    s.size[1] = 0.95;
    s.colors = oil ? OIL_MIST : BLOOD_MIST;
    s.gravity = 0.1;
    s.drag = 0.9;
    s.spin = 0.4;
    this.particles(s);

    // Only meat has pressure behind it.
    if (big && !oil) this.arterial(x, y, z, dir, amt);
  }

  /**
   * Arterial spray: a fast, tight cone of fine droplets with a handful of fat
   * ones behind them, which the pool draws as trailing ribbons because they are
   * moving several pixels a frame. For heavy hits and finishers.
   */
  arterial(x: number, y: number, z: number, dir: number, amount: number): void {
    if (this.muted) return;
    const g = this.goreScale();
    if (g <= 0) return;
    const amt = intensity(amount);
    if (amt <= 0) return;
    const s = this.gspec;

    s.count = Math.round(clamp((7 + amt * 14) * g, 4, 52));
    s.x = x;
    s.y = y;
    s.z = z;
    // Angled up and forward: a spurt has pressure behind it, unlike a splash.
    s.angle = sprayAngle(dir, 0.52);
    s.spread = 0.6;
    s.speed[0] = 4.6 + amt * 3.4;
    s.speed[1] = 8.4 + amt * 8;
    s.life[0] = 18;
    s.life[1] = 40;
    s.size[0] = 0.55;
    s.size[1] = 1.15;
    s.colors = BLOOD_DROP;
    s.gravity = 0.3;
    // Barely any drag, so the ribbons stay long for their whole flight.
    s.drag = 0.997;
    s.shape = 'blood';
    s.additive = false;
    s.fade = 'ease';
    s.spin = 0.1;
    this.particles(s);

    s.count = Math.round(clamp((2 + amt * 4) * g, 2, 12));
    s.spread = 0.35;
    s.speed[0] = 3.4 + amt * 2;
    s.speed[1] = 6 + amt * 4;
    s.life[0] = 26;
    s.life[1] = 54;
    s.size[0] = 1.5;
    s.size[1] = 2.7;
    this.particles(s);
  }

  /**
   * Chunks. Tumbling, bouncing, floor-painting pieces of somebody.
   *
   * Normally `gibs(x, y, z, amount)`. A caller that also knows which way the
   * pieces should go passes the direction fourth and the amount fifth — the
   * combat resolver's gore shim does exactly that — and the extra argument is
   * what tells the two apart.
   */
  gibs(
    x: number,
    y: number,
    z: number,
    amount: number,
    amountIfDirected?: number,
    kind: SprayKind = 'blood',
  ): void {
    if (this.muted) return;
    const g = this.goreScale();
    if (g <= 0) return;
    const directed = amountIfDirected !== undefined;
    const amt = intensity(directed ? amountIfDirected : amount);
    if (amt <= 0) return;
    const oil = kind === 'oil';

    const s = this.gspec;
    s.count = Math.round(clamp((3 + amt * 7) * g, 2, 28));
    s.x = x;
    s.y = y;
    s.z = z;
    // Up by default: a chunk does not care which way the fist went, it cares
    // about gravity. A directed call still gets thrown mostly that way.
    s.angle = directed ? sprayAngle(amount, 0.9) : Math.PI * 0.5;
    s.spread = Math.PI * 1.4;
    s.speed[0] = 1.5 + amt * 1.6;
    s.speed[1] = 4 + amt * 4.6;
    // Long lives: a chunk that has stopped moving is scenery, not an effect.
    s.life[0] = 110;
    s.life[1] = 240;
    s.size[0] = 1.5 + amt * 0.9;
    s.size[1] = 3 + amt * 2.6;
    s.colors = oil ? OIL_SCRAP : GIB_MEAT;
    s.gravity = 0.44;
    s.drag = 0.995;
    s.shape = 'gib';
    s.additive = false;
    s.fade = 'ease';
    s.spin = 0.22;
    this.particles(s);

    // Nothing comes out of a body dry.
    s.count = Math.round(clamp((4 + amt * 8) * g, 3, 36));
    s.spread = Math.PI * 1.9;
    s.speed[0] = 1.2;
    s.speed[1] = 4.2 + amt * 3;
    s.life[0] = 18;
    s.life[1] = 46;
    s.size[0] = 0.7;
    s.size[1] = 1.8;
    s.colors = oil ? OIL_DROP : BLOOD_DROP;
    s.gravity = 0.32;
    s.drag = 0.985;
    s.shape = 'blood';
    s.spin = 0.25;
    this.particles(s);
  }

  /**
   * The slow leak from a wounded fighter. Call it every frame with the wound
   * position and how badly hurt they are; it meters itself, so a hurt character
   * keeps bleeding instead of only flashing red.
   */
  drip(x: number, y: number, z: number, amount: number): void {
    if (this.muted) return;
    const g = this.goreScale();
    if (g <= 0) return;
    const amt = intensity(amount);
    if (amt <= 0.02) return;
    // Presentation-only rate limiting: a coin flip per frame, not a counter, so
    // two fighters bleeding at once never fall into step.
    if (Math.random() > (0.012 + amt * 0.07) * g) return;

    const s = this.gspec;
    s.count = 1;
    s.x = x;
    s.y = y;
    s.z = z;
    s.angle = -Math.PI * 0.5;
    s.spread = 1.1;
    s.speed[0] = 0.05;
    s.speed[1] = 0.45;
    s.life[0] = 50;
    s.life[1] = 110;
    s.size[0] = 0.9;
    s.size[1] = 1.5 + amt;
    s.colors = BLOOD_DROP;
    s.gravity = 0.2;
    s.drag = 1;
    s.shape = 'blood';
    s.additive = false;
    s.fade = 'ease';
    s.spin = 0.08;
    this.particles(s);
  }

  /**
   * Spatter on the CAMERA. Screen-space blobs that stick to the glass and slide
   * down it over the next few seconds — the cheapest way there is to make a
   * kill feel like it happened to the player rather than in front of them, so
   * use it sparingly: finishers only.
   */
  lensSplatter(amount: number): void {
    if (this.muted) return;
    const g = this.goreScale();
    if (g <= 0) return;
    const amt = intensity(amount);
    if (amt <= 0) return;
    // This one lands on the player's eyes, so reduced motion gets a light dusting.
    const damp = this.settings.reducedMotion ? 0.4 : 1;
    const n = Math.round(clamp((3 + amt * 9) * g * damp, 1, MAX_LENS));
    const fat = this.settings.gore === 'max' ? 1.3 : 1;

    for (let i = 0; i < n; i++) {
      const b = this.lens[this.lensCursor];
      this.lensCursor = (this.lensCursor + 1) % MAX_LENS;
      if (!b.active) this.lensLive++;
      b.active = true;
      b.x = VIEW_W * (0.1 + Math.random() * 0.8);
      // Weighted to the upper half, because that is where a face is.
      b.y = VIEW_H * (0.06 + Math.random() * 0.62);
      b.r = (1.8 + Math.random() * (3.5 + amt * 6.5)) * fat;
      b.vy = (0.05 + Math.random() * 0.2) * damp;
      b.trail = 0;
      b.life = Math.round(LENS_LIFE * (0.6 + Math.random() * 0.85));
      b.maxLife = b.life;
      b.seed = (Math.random() * 65536) | 0;
    }
  }

  /**
   * The moment of a fatality: the frame desaturates and a bruise of red is
   * pushed back into it. Brief by design — it is punctuation, not a filter.
   */
  fatalityGrade(frames: number, strength = 1): void {
    if (this.muted) return;
    if (frames <= 0) return;
    const s = clamp(strength, 0, 1) * (this.settings.reducedMotion ? 0.45 : 1);
    if (s <= 0.01) return;
    const current = this.gradeLife > 0 ? this.gradeStrength * (this.gradeLife / this.gradeMax) : 0;
    if (s >= current) {
      this.gradeStrength = s;
      this.gradeLife = frames;
      this.gradeMax = frames;
    } else if (frames > this.gradeLife) {
      this.gradeLife = frames;
      this.gradeMax = Math.max(this.gradeMax, frames);
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────

  /**
   * The live gore setting, so a fatality director can decline to run a finisher
   * at all rather than run a bloodless one.
   */
  get goreSetting(): Settings['gore'] {
    return this.settings.gore;
  }

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
      /*
       * Count down in REAL time, not in slowed sim steps.
       *
       * update() is driven by the simulation, and the simulation's rate is the
       * very thing this effect is throttling. Decrementing one per call meant a
       * slowmo lasted `frames / scale` of wall clock instead of `frames`: at
       * 0.1 a 26-frame flourish hit stayed slow for over four seconds, long
       * after the finisher was over, and the fight felt like it had stuck to
       * the floor while everything else carried on.
       */
      const ts = this.loop.timeScale;
      this.smoLife = Math.max(0, this.smoLife - (ts > 0.02 ? 1 / ts : 1));
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

    if (this.gradeLife > 0) {
      this.gradeLife--;
      if (this.gradeLife <= 0) this.gradeStrength = 0;
    }

    if (this.lensLive > 0) {
      for (let i = 0; i < MAX_LENS; i++) {
        const b = this.lens[i];
        if (!b.active) continue;
        b.life--;
        if (b.life <= 0) {
          b.active = false;
          this.lensLive--;
          continue;
        }
        // It runs while it is heavy, then the smear thins and it stops.
        if (b.vy > 0.004) {
          b.y += b.vy;
          b.trail = Math.min(b.trail + b.vy, b.r * 9);
          b.vy *= 0.988;
          if (b.y > VIEW_H + b.r * 2) {
            b.active = false;
            this.lensLive--;
          }
        }
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

  /**
   * Screen-space layer: full-screen flash, the fatality grade, whatever is on
   * the lens, and chromatic aberration last so it fringes all of it.
   */
  renderOverlay(r: Renderer): void {
    if (this.flashLife > 0) {
      const t = this.flashLife / this.flashMax;
      const a = this.flashAlpha * t * t * (0.6 + 0.4 * t);
      if (a > 0.004) r.flash(this.flashColor, a);
    }
    if (this.gradeLife > 0 || this.lensLive > 0) {
      this.overlayCtx = r.ctx;
      // The callback is bound once at construction: this runs every frame.
      r.withScreen(this.drawScreenGore);
      this.overlayCtx = null;
    }
    if (this.abLife > 0 && !this.settings.reducedMotion) {
      const s = this.abStrength * (this.abLife / this.abMax);
      if (s > 0.01) r.aberration(s);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private goreScale(): number {
    switch (this.settings.gore) {
      case 'off':
        return 0;
      case 'max':
        return 1.9;
      default:
        return 1;
    }
  }

  private readonly drawScreenGore = (): void => {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    if (this.gradeLife > 0) {
      const t = this.gradeLife / this.gradeMax;
      // Snap in, hang, fall away.
      const k = this.gradeStrength * (t > 0.75 ? (1 - t) * 4 : easeOut(t / 0.75));
      if (k > 0.01) this.drawGrade(ctx, k);
    }
    if (this.lensLive > 0) this.drawLens(ctx);
  };

  /**
   * Pull the colour out of the frame, then bruise it.
   *
   * The desaturation is a single 'saturation' blend fill; if the browser has
   * not implemented that separable blend mode it silently refuses the
   * assignment, in which case the red multiply alone still carries the moment.
   */
  private drawGrade(ctx: C2D, k: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    if (ctx.globalCompositeOperation === 'saturation') {
      ctx.globalAlpha = clamp(k * 0.85, 0, 1);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    // Multiplying by a warm red crushes green and blue and leaves the reds.
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = clamp(k * 0.5, 0, 1);
    ctx.fillStyle = '#ff5f4a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // A little back on top, so the shadows do not go flat black.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(k * 0.14, 0, 1);
    ctx.fillStyle = '#4a0006';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }

  /**
   * Blood on the glass. Each blob is a tapered smear behind a head, plus a rim
   * highlight — the highlight is what puts it ON the lens rather than in the
   * world, since nothing else in the frame is lit from that side.
   */
  private drawLens(ctx: C2D): void {
    ctx.save();
    for (let i = 0; i < MAX_LENS; i++) {
      const b = this.lens[i];
      if (!b.active) continue;
      const t = b.life / b.maxLife;
      const a = clamp(t > 0.3 ? 0.9 : (t / 0.3) * 0.9, 0, 1);
      if (a <= 0.01) continue;

      if (b.trail > 0.6) {
        const w = b.r * 0.75;
        ctx.globalAlpha = a * 0.42;
        ctx.fillStyle = LENS_BLOOD;
        ctx.beginPath();
        ctx.moveTo(b.x - w, b.y);
        ctx.lineTo(b.x - w * 0.28, b.y - b.trail);
        ctx.lineTo(b.x + w * 0.28, b.y - b.trail);
        ctx.lineTo(b.x + w, b.y);
        ctx.closePath();
        ctx.fill();
      }

      ctx.globalAlpha = a;
      ctx.fillStyle = LENS_BLOOD;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r, b.r * 1.1, 0, 0, TAU);
      ctx.fill();

      // Satellite droplets, stable per blob so they do not crawl.
      const h1 = hash01(b.seed);
      const h2 = hash01(b.seed + 17);
      const rr = b.r * 0.3;
      if (rr > 0.6) {
        const ax = b.x + (h1 - 0.5) * b.r * 3.4;
        const ay = b.y + (h2 - 0.5) * b.r * 2.6;
        const bx = b.x - (h2 - 0.5) * b.r * 3;
        const by = b.y - (h1 - 0.5) * b.r * 2.2;
        const br = rr * 0.7;
        ctx.beginPath();
        // moveTo between arcs, or the two droplets are joined by a hair.
        ctx.moveTo(ax + rr, ay);
        ctx.arc(ax, ay, rr, 0, TAU);
        ctx.moveTo(bx + br, by);
        ctx.arc(bx, by, br, 0, TAU);
        ctx.fill();
      }

      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = LENS_RIM;
      ctx.beginPath();
      ctx.ellipse(b.x - b.r * 0.3, b.y - b.r * 0.34, b.r * 0.34, b.r * 0.22, -0.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

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

/**
 * Gore intensity, normalised to roughly 0..1.6.
 *
 * Callers hold one of two things: a small dial (0..1, sometimes pushed to 2 or
 * so for a marquee kill) or raw damage points. Insisting on one of them at
 * every call site is how you end up with a jab that sprays like a decapitation,
 * so both are accepted and told apart by magnitude — no move in the game deals
 * three points of damage.
 */
function intensity(amount: number): number {
  if (!(amount > 0)) return 0;
  return amount <= 3 ? Math.min(amount, 1.6) : clamp(amount / 26, 0.3, 1.6);
}

/**
 * Emission angle from whatever the caller had to hand.
 *
 * Facings (±1) and world angles both turn up: a fighter knows which way it is
 * pointing, the combat resolver has already worked out a cone. Anything inside
 * ±1 is a facing and gets the lift applied; anything outside it is already an
 * angle in radians and is used as it stands.
 */
function sprayAngle(dir: number, lift: number): number {
  if (dir > 1.05 || dir < -1.05) return dir;
  return dir >= 0 ? lift : Math.PI - lift;
}

/** Stable pseudo-random in 0..1 from an integer, for per-blob detail. */
function hash01(n: number): number {
  let h = (n | 0) * 1103515245 + 12345;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 8) & 0xffff) / 65535;
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
