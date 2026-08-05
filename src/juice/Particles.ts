/**
 * World-space particle system.
 *
 * Particles live in the same 2.5D space the fight happens in (x, y up, z into
 * the screen) and project through the camera exactly like fighters do, so a
 * spark thrown off a jaw at the back of the belt lands on the floor back there
 * too. They collide with the ground plane and bounce.
 *
 * `render` is expected to run inside `Renderer.withCamera`, which already
 * applies the scroll, zoom and shake; so x is drawn raw and only the depth
 * fold (GROUND_Y + z * Z_SCALE - y) happens here. The camera is still needed
 * for culling.
 *
 * The pool is fixed at MAX_PARTICLES and preallocated at construction. `emit`
 * and `update` never allocate: they hand out indices from a free stack, and
 * when the pool is exhausted they recycle the oldest live particle via a
 * generation-tagged ring of spawn order.
 *
 * GORE. Blood is not just a red dot: a droplet arcs, tumbles, stretches into a
 * ribbon while it is moving fast, and when it reaches the floor it dies into a
 * persistent decal oriented along the direction it was travelling. Decals
 * accumulate through a fight from a fixed ring, so the floor gets filthier and
 * the budget never moves. `gib` chunks are the same idea with mass: they tumble
 * with real angular momentum, bounce once, paint the floor where they land and
 * again where they settle, then lie there.
 *
 * The gore level is NOT decided here — this pool draws whatever it is handed.
 * `Fx` owns Settings.gore and simply does not emit at 'off'.
 *
 * This is presentation-only code, so Math.random is fair game here.
 */

import type { ParticleSpec } from '@/core/types';
import type { Camera } from '@/render/Camera';
import { clamp, lerp, TAU } from '@/core/math';
import {
  GROUND_Y,
  MAX_PARTICLES,
  VIEW_H,
  VIEW_W,
  Z_DEPTH,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';
import { poly } from '@/render/Shapes';

type C2D = CanvasRenderingContext2D;

/**
 * Shapes this pool can draw. A superset of `ParticleSpec['shape']`: the gore
 * layer needs a chunky `gib` lump, and the shared contract in core/types.ts is
 * frozen, so the extra shape is named here instead.
 */
export type ParticleShape = ParticleSpec['shape'] | 'gib';

/**
 * `ParticleSpec` widened to the shapes the pool actually supports. Every
 * `ParticleSpec` is already a valid `EmitSpec`, so nothing that emits today
 * changes; only code that wants `gib` needs to know this type exists.
 */
export interface EmitSpec extends Omit<ParticleSpec, 'shape'> {
  shape: ParticleShape;
}

const SH_DOT = 0;
const SH_SPARK = 1;
const SH_SHARD = 2;
const SH_RING = 3;
const SH_STAR = 4;
const SH_SMOKE = 5;
const SH_BLOOD = 6;
const SH_BOLT = 7;
const SH_GIB = 8;

const SHAPE_CODE: Record<ParticleShape, number> = {
  dot: SH_DOT,
  spark: SH_SPARK,
  shard: SH_SHARD,
  ring: SH_RING,
  star: SH_STAR,
  smoke: SH_SMOKE,
  blood: SH_BLOOD,
  bolt: SH_BOLT,
  gib: SH_GIB,
};

const FADE_LINEAR = 0;
const FADE_EASE = 1;
const FADE_FLICKER = 2;

/** Floor restitution and the sideways bite a bounce takes out of a particle. */
const BOUNCE = 0.36;
const FLOOR_GRIP = 0.66;
/** Below this downward speed a particle stops bouncing and settles. */
const REST_SPEED = 0.4;
/** Buoyancy added to smoke every frame; smoke ignores gravity entirely. */
const SMOKE_LIFT = 0.035;
/** How far outside the walkable band a particle may stray before rebounding. */
const Z_SLACK = 30;

/**
 * Floor stains. A fight should leave the room a mess, so these are numerous and
 * long-lived — but the ring is fixed, so the 145th splat quietly overwrites the
 * first and the cost per frame never moves.
 */
const MAX_DECALS = 44;
/** ~25s at 60Hz: long enough to accumulate across a whole wave. */
/**
 * Frames a stain survives. Deliberately SHORTER than the corpse it came from
 * (CORPSE_FRAMES is 140): stains that outlive the body read as scenery rather
 * than as damage, and at the old 1500 (25 seconds, 144 of them) the floor and
 * the wall base silted up into one continuous red band that followed you
 * through the level.
 */
const DECAL_LIFE = 260;
/** Fraction of a decal's life spent fading out. Most of it, so none linger. */
const DECAL_FADE = 0.8;
/** The darker wet middle of a fresh stain, before it dries to the edge colour. */
const DECAL_CORE = '#5c0a15';
/** Vertices in a gib lump. Odd, so no chunk reads as symmetrical. */
const GIB_VERTS = 7;

/** Depth buckets used for a cheap allocation-free back-to-front draw order. */
const BUCKETS = 16;
const BUCKET_SCALE = BUCKETS / (Z_DEPTH + Z_SLACK * 2);

/** Cheap stable pseudo-random in 0..1 from an integer. Presentation only. */
function hash(n: number): number {
  let h = (n | 0) * 1103515245 + 12345;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 8) & 0xffff) / 65535;
}

class Particle {
  active = false;
  /** Bumped on every allocation so stale spawn-order entries can be detected. */
  gen = 0;
  x = 0;
  y = 0;
  z = 0;
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 0;
  maxLife = 1;
  size = 1;
  color = '#ffffff';
  shape = SH_DOT;
  additive = false;
  fade = FADE_LINEAR;
  gravity = 0;
  drag = 1;
  spin = 0;
  rot = 0;
  seed = 0;
  bounces = 0;
  resting = false;
  flick = 1;
}

class Decal {
  active = false;
  x = 0;
  z = 0;
  r = 1;
  /** Elongation along `rot`, taken from how fast the drop was travelling. */
  stretch = 1;
  /** Screen-space angle of travel across the floor plane. */
  rot = 0;
  color = '#8e1220';
  /** 1 when a chunk dragged this out, 0 when a droplet burst into it. */
  smear = 0;
  life = 0;
  maxLife = 1;
  seed = 0;
}

export class ParticleSystem {
  private readonly pool: Particle[] = [];
  private readonly free = new Int32Array(MAX_PARTICLES);
  private freeCount = MAX_PARTICLES;
  private live = 0;

  /** Spawn-order ring, so an exhausted pool recycles oldest-first. */
  private readonly ringIdx = new Int32Array(MAX_PARTICLES);
  private readonly ringGen = new Int32Array(MAX_PARTICLES);
  private ringHead = 0;
  private ringLen = 0;

  /** Intrusive per-bucket linked lists, rebuilt each render. */
  private readonly bucketHead = new Int32Array(BUCKETS * 2);
  private readonly nextIdx = new Int32Array(MAX_PARTICLES);

  private readonly decals: Decal[] = [];
  private decalCursor = 0;

  /** Scratch polygon buffer for shard and blood-ribbon drawing. */
  private readonly pts = [0, 0, 0, 0, 0, 0, 0, 0];
  /** Scratch polygon buffer for gib lumps, GIB_VERTS points. */
  private readonly gibPts = new Array<number>(GIB_VERTS * 2).fill(0);

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push(new Particle());
      this.free[i] = MAX_PARTICLES - 1 - i;
      this.nextIdx[i] = -1;
    }
    for (let i = 0; i < MAX_DECALS; i++) this.decals.push(new Decal());
  }

  get count(): number {
    return this.live;
  }

  emit(spec: EmitSpec): void {
    let n = spec.count | 0;
    if (n <= 0) return;
    if (n > 256) n = 256;

    const shape = SHAPE_CODE[spec.shape] ?? SH_DOT;
    const fade =
      spec.fade === 'ease' ? FADE_EASE : spec.fade === 'flicker' ? FADE_FLICKER : FADE_LINEAR;
    const additive = spec.additive === true;
    const colors = spec.colors;
    const nc = colors.length;
    // `drag` is a per-frame velocity multiplier. 0 (or unset) means "none",
    // which is what emitters that do not care about drag will pass.
    const drag = spec.drag > 0 ? Math.min(spec.drag, 1) : 1;
    // Rings and bolts are anchored effects; scattering them looks like a bug.
    const jitter = shape === SH_RING || shape === SH_BOLT ? 0 : 1;
    const spin = spec.spin ?? 0;

    for (let k = 0; k < n; k++) {
      const idx = this.alloc();
      if (idx < 0) return;
      const p = this.pool[idx];
      const ang = spec.angle + (Math.random() - 0.5) * spec.spread;
      const spd = lerp(spec.speed[0], spec.speed[1], Math.random());

      p.shape = shape;
      p.fade = fade;
      p.additive = additive;
      p.color = nc > 0 ? colors[(Math.random() * nc) | 0] : '#ffffff';
      p.maxLife = Math.max(1, Math.round(lerp(spec.life[0], spec.life[1], Math.random())));
      p.life = p.maxLife;
      p.size = Math.max(0.25, lerp(spec.size[0], spec.size[1], Math.random()));

      p.x = spec.x + (Math.random() - 0.5) * 2.4 * jitter;
      p.y = spec.y + (Math.random() - 0.5) * 2.4 * jitter;
      p.z = spec.z + (Math.random() - 0.5) * 2.0 * jitter;
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;

      // Angles are world-space: 0 = +x, PI/2 = straight up.
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.vz = (Math.random() - 0.5) * spd * 0.45;

      p.gravity = spec.gravity;
      p.drag = drag;
      p.spin = spin !== 0 ? spin * (Math.random() < 0.5 ? -1 : 1) : 0;
      // A chunk of somebody carries angular momentum of its own: the spec sets
      // the scale, the lump decides how hard it is tumbling.
      if (shape === SH_GIB) {
        const base = spin !== 0 ? spin : 0.16;
        p.spin = base * (0.45 + Math.random() * 1.3) * (Math.random() < 0.5 ? -1 : 1);
      }
      p.rot = Math.random() * TAU;
      p.seed = (Math.random() * 65536) | 0;
      p.bounces = 0;
      p.resting = false;
      p.flick = 1;
    }
  }

  update(): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.life--;
      if (p.life <= 0) {
        this.release(i);
        continue;
      }

      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;

      const isRing = p.shape === SH_RING;
      if (p.shape === SH_SMOKE) p.vy += SMOKE_LIFT;
      else if (!isRing) p.vy -= p.gravity;

      if (p.drag !== 1) {
        p.vx *= p.drag;
        p.vy *= p.drag;
        p.vz *= p.drag;
      }

      p.x += p.vx;
      p.y += p.vy;
      p.z += p.vz;
      p.rot += p.spin;

      if (p.fade === FADE_FLICKER) p.flick = 0.35 + Math.random() * 0.65;

      if (p.y <= 0 && !isRing && p.shape !== SH_SMOKE && p.shape !== SH_BOLT) {
        // A droplet does not survive the floor: it becomes the floor.
        if (p.shape === SH_BLOOD) {
          // Not every droplet stains. A spray is dozens of particles and one
          // mark each carpeted the ground in a single exchange.
          if (hash(p.seed + 91) < 0.28) this.splat(p, false);
          this.release(i);
          continue;
        }
        const gib = p.shape === SH_GIB;
        p.y = 0;
        const bounce = p.vy < -REST_SPEED && p.bounces < (gib ? 1 : 4);
        // Chunks paint the floor where they land AND where they stop rolling.
        if (gib && bounce && hash(p.seed + 37) < 0.5) this.splat(p, true);
        if (bounce) {
          p.vy = -p.vy * (gib ? BOUNCE * 1.25 : BOUNCE);
          p.vx *= FLOOR_GRIP;
          p.vz *= FLOOR_GRIP;
          p.spin *= gib ? -0.72 : -0.55;
          p.bounces++;
        } else {
          p.vy = 0;
          p.vx *= gib ? 0.72 : 0.8;
          p.vz *= gib ? 0.72 : 0.8;
          p.spin *= gib ? 0.5 : 0.7;
          if (!p.resting) {
            p.resting = true;
            // Sparks die on the floor; debris and offal are allowed to lie there.
            if (p.shape === SH_SPARK || p.shape === SH_STAR) {
              p.life = Math.min(p.life, 8);
              p.maxLife = Math.min(p.maxLife, Math.max(p.life, 1));
            }
          }
        }
      }

      if (p.z < -Z_SLACK) {
        p.z = -Z_SLACK;
        p.vz = -p.vz * 0.4;
      } else if (p.z > Z_DEPTH + Z_SLACK) {
        p.z = Z_DEPTH + Z_SLACK;
        p.vz = -p.vz * 0.4;
      }
    }

    for (let i = 0; i < MAX_DECALS; i++) {
      const d = this.decals[i];
      if (!d.active) continue;
      d.life--;
      if (d.life <= 0) d.active = false;
    }
  }

  /**
   * Stains only. Drawn with the FLOOR, before anything standing on it.
   *
   * These used to go out with the rest of the particle layer, which the fight
   * draws after the fighters — so blood on the ground was painted over the top
   * of the people standing in it, and read as floating in front of the scene.
   */
  renderGround(ctx: C2D, cam: Camera): void {
    this.renderDecals(ctx, cam);
  }

  render(ctx: C2D, cam: Camera): void {
    if (this.live === 0) return;

    this.bucketHead.fill(-1);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      const b = clamp(((p.z + Z_SLACK) * BUCKET_SCALE) | 0, 0, BUCKETS - 1);
      const key = b * 2 + (p.additive ? 1 : 0);
      this.nextIdx[i] = this.bucketHead[key];
      this.bucketHead[key] = i;
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let additive = false;
    for (let b = BUCKETS - 1; b >= 0; b--) {
      for (let s = 0; s < 2; s++) {
        let i = this.bucketHead[b * 2 + s];
        if (i < 0) continue;
        const wantAdditive = s === 1;
        if (wantAdditive !== additive) {
          ctx.globalCompositeOperation = wantAdditive ? 'lighter' : 'source-over';
          additive = wantAdditive;
        }
        while (i >= 0) {
          this.drawOne(ctx, this.pool[i], cam);
          i = this.nextIdx[i];
        }
      }
    }
    ctx.restore();
  }

  clear(): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool[i].active = false;
      this.free[i] = MAX_PARTICLES - 1 - i;
    }
    this.freeCount = MAX_PARTICLES;
    this.live = 0;
    this.ringHead = 0;
    this.ringLen = 0;
    for (let i = 0; i < MAX_DECALS; i++) this.decals[i].active = false;
    this.decalCursor = 0;
  }

  // ── pool ───────────────────────────────────────────────────────────────────

  private alloc(): number {
    let idx: number;
    if (this.freeCount > 0) {
      idx = this.free[--this.freeCount];
    } else {
      idx = this.recycleOldest();
      if (idx < 0) return -1;
    }
    const p = this.pool[idx];
    p.active = true;
    p.gen = (p.gen + 1) & 0x3fffffff;
    this.live++;
    this.ringPush(idx, p.gen);
    return idx;
  }

  private release(i: number): void {
    const p = this.pool[i];
    if (!p.active) return;
    p.active = false;
    this.live--;
    this.free[this.freeCount++] = i;
  }

  private ringPush(idx: number, gen: number): void {
    if (this.ringLen === MAX_PARTICLES) {
      this.ringHead = (this.ringHead + 1) % MAX_PARTICLES;
      this.ringLen--;
    }
    const pos = (this.ringHead + this.ringLen) % MAX_PARTICLES;
    this.ringIdx[pos] = idx;
    this.ringGen[pos] = gen;
    this.ringLen++;
  }

  /** Pops spawn-order entries until one still points at a live particle. */
  private recycleOldest(): number {
    while (this.ringLen > 0) {
      const pos = this.ringHead;
      const idx = this.ringIdx[pos];
      const gen = this.ringGen[pos];
      this.ringHead = (this.ringHead + 1) % MAX_PARTICLES;
      this.ringLen--;
      const p = this.pool[idx];
      if (p.active && p.gen === gen) {
        p.active = false;
        this.live--;
        return idx;
      }
    }
    return -1;
  }

  // ── decals ─────────────────────────────────────────────────────────────────

  /**
   * Turn a particle that has just reached the floor into a stain.
   *
   * The splat is oriented along the direction the thing was travelling —
   * projected onto the floor plane, where a unit of depth is only Z_SCALE
   * screen pixels — and stretched by how fast it got there, which is what makes
   * a thrown drop read as thrown rather than dropped.
   */
  private splat(p: Particle, smear: boolean): void {
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    const fx = p.vx;
    const fz = p.vz * Z_SCALE;
    const flat = Math.hypot(fx, fz);
    const speed = flat + Math.abs(p.vy);
    d.active = true;
    d.x = p.x;
    d.z = clamp(p.z, -Z_SLACK, Z_DEPTH + Z_SLACK);
    d.r = clamp(p.size * (smear ? 0.9 : 1.1) + speed * 0.18, 1, smear ? 6.5 : 5);
    d.stretch = clamp(1 + flat * (smear ? 0.28 : 0.2), 1, smear ? 2.1 : 1.7);
    d.rot = flat > 0.08 ? Math.atan2(fz, fx) : hash(p.seed + 5) * TAU;
    d.color = p.color;
    d.smear = smear ? 1 : 0;
    d.maxLife = DECAL_LIFE;
    d.life = DECAL_LIFE;
    d.seed = p.seed;
  }

  /**
   * One stain is a pool, a directional tail and a few flecks. All of it goes
   * into a single path so the whole splat costs one fill, which is what lets
   * the floor carry 144 of them.
   */
  private renderDecals(ctx: C2D, cam: Camera): void {
    let any = false;
    for (let i = 0; i < MAX_DECALS; i++) {
      const d = this.decals[i];
      if (!d.active) continue;
      const onScreen = d.x - cam.x;
      if (onScreen < -80 || onScreen > VIEW_W + 80) continue;
      if (!any) {
        ctx.save();
        any = true;
      }
      const t = d.life / d.maxLife;
      const a = (t > DECAL_FADE ? 1 : t / DECAL_FADE) * 0.42;
      const sx = d.x;
      const sy = GROUND_Y + d.z * Z_SCALE;
      const rx = d.r * d.stretch;
      const ry = d.r * 0.34;
      const cs = Math.cos(d.rot);
      const sn = Math.sin(d.rot);

      ctx.globalAlpha = a;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      // moveTo the ellipse's own start point first: an ellipse appended to a
      // live subpath would be joined to the previous decal by a stray line, and
      // any other seed point would leave a spur across this one.
      ctx.moveTo(sx + rx * cs, sy + rx * sn);
      ctx.ellipse(sx, sy, rx, ry, d.rot, 0, TAU);
      const reach = d.smear > 0 ? 1.5 : 1;
      for (let k = 0; k < 4; k++) {
        const h1 = hash(d.seed + k * 31);
        const h2 = hash(d.seed + k * 57 + 11);
        // Mostly thrown forwards along the travel, occasionally kicked back.
        const along = (0.6 + h1 * 0.95 * reach) * rx * (h2 < 0.22 ? -0.5 : 1);
        const side = (h2 - 0.5) * d.r * 1.3;
        const fx = sx + cs * along - sn * side;
        const fy = sy + (sn * along + cs * side) * 0.34;
        const fr = d.r * (0.13 + h1 * 0.3);
        ctx.moveTo(fx + fr, fy);
        ctx.ellipse(fx, fy, fr, fr * 0.4, 0, 0, TAU);
      }
      ctx.fill();

      // A fresh stain is still wet in the middle; it dries as it fades.
      if (t > 0.55 && d.r > 1.8) {
        ctx.globalAlpha = a * (t - 0.55) * 1.1;
        ctx.fillStyle = DECAL_CORE;
        ctx.beginPath();
        ctx.moveTo(sx + rx * 0.5 * cs, sy + rx * 0.5 * sn);
        ctx.ellipse(sx, sy, rx * 0.5, ry * 0.58, d.rot, 0, TAU);
        ctx.fill();
      }
    }
    if (any) ctx.restore();
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  private drawOne(ctx: C2D, p: Particle, cam: Camera): void {
    const sx = p.x;
    const sy = GROUND_Y + p.z * Z_SCALE - p.y;
    const onScreen = p.x - cam.x;
    if (onScreen < -70 || onScreen > VIEW_W + 70 || sy < -90 || sy > VIEW_H + 90) return;

    const t = p.life / p.maxLife;
    let a: number;
    if (p.fade === FADE_EASE) a = 1 - (1 - t) * (1 - t);
    else if (p.fade === FADE_FLICKER) a = t * p.flick;
    else a = t;

    const age = p.maxLife - p.life;
    if (p.shape === SH_SMOKE && age < 8) a *= (age + 1) / 9;
    a = clamp(a, 0, 1);
    if (a <= 0.004) return;

    const ps = clamp(1 - p.z * Z_PERSPECTIVE, 0.6, 1.25);
    ctx.globalAlpha = a;

    switch (p.shape) {
      case SH_SPARK:
        this.drawSpark(ctx, p, sx, sy, ps, a);
        break;
      case SH_SHARD:
        this.drawShard(ctx, p, sx, sy, ps);
        break;
      case SH_RING:
        this.drawRing(ctx, p, sx, sy, ps, t);
        break;
      case SH_STAR:
        this.drawStar(ctx, p, sx, sy, ps);
        break;
      case SH_SMOKE:
        this.drawSmoke(ctx, p, sx, sy, ps, t, a);
        break;
      case SH_BLOOD:
        this.drawBlood(ctx, p, sx, sy, ps);
        break;
      case SH_GIB:
        this.drawGib(ctx, p, sx, sy, ps);
        break;
      case SH_BOLT:
        this.drawBolt(ctx, p, sx, sy, ps, a);
        break;
      default:
        this.drawDot(ctx, p, sx, sy, ps, a);
        break;
    }
  }

  private drawDot(ctx: C2D, p: Particle, sx: number, sy: number, ps: number, a: number): void {
    const r = p.size * ps;
    ctx.fillStyle = p.color;
    if (r <= 0.9) {
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      return;
    }
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, TAU);
    ctx.fill();
    if (p.additive && r > 1.4) {
      ctx.globalAlpha = a * 0.75;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.42, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a;
    }
  }

  private drawSpark(ctx: C2D, p: Particle, sx: number, sy: number, ps: number, a: number): void {
    // Velocity projected into screen space, so the streak follows the same
    // path the eye sees the particle take.
    const vsx = p.vx;
    const vsy = p.vz * Z_SCALE - p.vy;
    const len = Math.hypot(vsx, vsy);
    const w = Math.max(0.6, p.size * ps);
    let nx = 1;
    let ny = 0;
    if (len > 0.0001) {
      nx = vsx / len;
      ny = vsy / len;
    }
    const stretch = clamp(len * 2.1, w * 1.5, 26) * ps;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - nx * stretch, sy - ny * stretch);
    ctx.stroke();
    if (w > 0.9) {
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = w * 0.42;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - nx * stretch * 0.45, sy - ny * stretch * 0.45);
      ctx.stroke();
      ctx.globalAlpha = a;
    }
  }

  private drawShard(ctx: C2D, p: Particle, sx: number, sy: number, ps: number): void {
    const s = p.size * ps;
    const q = this.pts;
    q[0] = -s;
    q[1] = -s * 0.55;
    q[2] = s * 0.9;
    q[3] = -s * 0.25;
    q[4] = s * 0.62;
    q[5] = s * 0.72;
    q[6] = -s * 0.8;
    q[7] = s * 0.42;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    poly(ctx, q, p.color, p.additive ? undefined : '#15121c', Math.max(0.55, s * 0.2));
    ctx.restore();
  }

  private drawRing(ctx: C2D, p: Particle, sx: number, sy: number, ps: number, t: number): void {
    const grow = 0.2 + 2.1 * (1 - t);
    const r = Math.max(0.6, p.size * ps * grow);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(0.5, p.size * ps * 0.34 * t + 0.35);
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 0.85, p.rot, 0, TAU);
    ctx.stroke();
  }

  private drawStar(ctx: C2D, p: Particle, sx: number, sy: number, ps: number): void {
    const r = p.size * ps;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const rr = (k & 1) === 0 ? r : r * 0.44;
      const ang = (k / 10) * TAU - Math.PI / 2;
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.fill();
    if (!p.additive && r > 1.6) {
      ctx.lineWidth = Math.max(0.55, r * 0.18);
      ctx.strokeStyle = '#15121c';
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSmoke(
    ctx: C2D,
    p: Particle,
    sx: number,
    sy: number,
    ps: number,
    t: number,
    a: number,
  ): void {
    const r = p.size * ps * (1 + 1.7 * (1 - t));
    const h1 = hash(p.seed);
    const h2 = hash(p.seed + 7);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a * 0.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = a * 0.32;
    ctx.beginPath();
    ctx.arc(sx + (h1 - 0.5) * r * 1.1, sy - r * 0.45 * h2, r * 0.74, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx - (h2 - 0.5) * r * 0.95, sy + r * 0.3, r * 0.6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = a;
  }

  /**
   * Blood reads two ways. Moving fast it is a ribbon — a tapered smear drawn
   * between where it was last frame and where it is now, which is what turns an
   * arterial spurt into a trailing streak instead of a line of dots. Moving
   * slowly it is a tumbling droplet, fattest across its short axis.
   */
  private drawBlood(ctx: C2D, p: Particle, sx: number, sy: number, ps: number): void {
    const r = Math.max(0.35, p.size * ps);
    const psx = p.px;
    const psy = GROUND_Y + p.pz * Z_SCALE - p.py;
    const dx = sx - psx;
    const dy = sy - psy;
    const travel = Math.hypot(dx, dy);

    if (travel > r * 1.1) {
      const nx = -dy / travel;
      const ny = dx / travel;
      const tw = r * 0.2;
      const hw = r * 0.9;
      const q = this.pts;
      q[0] = psx + nx * tw;
      q[1] = psy + ny * tw;
      q[2] = sx + nx * hw;
      q[3] = sy + ny * hw;
      q[4] = sx - nx * hw;
      q[5] = sy - ny * hw;
      q[6] = psx - nx * tw;
      q[7] = psy - ny * tw;
      poly(ctx, q, p.color, 'none', 0);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.9, 0, TAU);
      ctx.fillStyle = p.color;
      ctx.fill();
      return;
    }

    const wob = 0.68 + 0.32 * Math.cos(p.rot);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * wob, p.rot * 0.4, 0, TAU);
    ctx.fill();
  }

  /**
   * A chunk of somebody. Irregular by seed so no two lumps match, outlined in
   * the house ink like every other solid in the game, with a wet glint that
   * sells it as something that used to be inside a person.
   */
  private drawGib(ctx: C2D, p: Particle, sx: number, sy: number, ps: number): void {
    const s = Math.max(0.9, p.size * ps);
    const q = this.gibPts;
    for (let k = 0; k < GIB_VERTS; k++) {
      const h = hash(p.seed + k * 41);
      const ang = (k / GIB_VERTS) * TAU;
      const rr = s * (0.58 + h * 0.66);
      q[k * 2] = Math.cos(ang) * rr;
      q[k * 2 + 1] = Math.sin(ang) * rr * 0.84;
    }
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    poly(ctx, q, p.color, '#26060d', Math.max(0.45, s * 0.14));
    ctx.globalAlpha *= 0.4;
    ctx.fillStyle = '#ffb0a8';
    ctx.beginPath();
    ctx.ellipse(-s * 0.2, -s * 0.24, s * 0.3, s * 0.18, -0.55, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private drawBolt(ctx: C2D, p: Particle, sx: number, sy: number, ps: number, a: number): void {
    const vsx = p.vx;
    const vsy = p.vz * Z_SCALE - p.vy;
    const spd = Math.hypot(vsx, vsy);
    let nx: number;
    let ny: number;
    if (spd > 0.0001) {
      nx = vsx / spd;
      ny = vsy / spd;
    } else {
      nx = Math.cos(p.rot);
      ny = Math.sin(p.rot);
    }
    const len = (p.size * 5.5 + spd * 3.2) * ps;
    const amp = p.size * 1.5 * ps;
    const ex = sx + nx * len;
    const ey = sy + ny * len;
    const salt = p.seed + p.life * 977;

    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(0.8, p.size * ps * 0.9);
    ctx.globalAlpha = a * 0.6;
    this.boltPath(ctx, sx, sy, ex, ey, amp, 6, salt);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(0.45, p.size * ps * 0.35);
    ctx.globalAlpha = a;
    this.boltPath(ctx, sx, sy, ex, ey, amp * 0.8, 6, salt);
    ctx.stroke();

    // A short fork off the middle sells the arc as electricity.
    const mx = sx + (ex - sx) * 0.45;
    const my = sy + (ey - sy) * 0.45;
    const fa = (hash(salt + 313) - 0.5) * 1.9;
    const fl = len * 0.42;
    ctx.globalAlpha = a * 0.75;
    this.boltPath(
      ctx,
      mx,
      my,
      mx + (nx * Math.cos(fa) - ny * Math.sin(fa)) * fl,
      my + (nx * Math.sin(fa) + ny * Math.cos(fa)) * fl,
      amp * 0.6,
      3,
      salt + 91,
    );
    ctx.stroke();
    ctx.globalAlpha = a;
  }

  private boltPath(
    ctx: C2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    amp: number,
    segs: number,
    salt: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const px = -dy / l;
    const py = dx / l;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let k = 1; k < segs; k++) {
      const f = k / segs;
      const j = (hash(salt + k * 131) - 0.5) * 2 * amp * (1 - Math.abs(f - 0.5) * 1.2);
      ctx.lineTo(x0 + dx * f + px * j, y0 + dy * f + py * j);
    }
    ctx.lineTo(x1, y1);
  }
}
