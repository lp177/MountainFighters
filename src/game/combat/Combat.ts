/**
 * Hit resolution — the layer that turns frame data into contact.
 *
 * Fighters publish their live hitboxes through `SimContext.spawnHit` every
 * frame a window is open. This resolver drains that queue (and, for any fighter
 * that exposes its move object directly, scans it too), builds the world-space
 * box, and tests it against every opposing hurtbox. Three rules matter:
 *
 *   1. **Depth gating.** A hitbox only reaches things within Z_HIT_TOLERANCE of
 *      the attacker's own plane. That single rule is what makes this a
 *      belt-scroller rather than a very wide fighting game.
 *   2. **One hit per window per target.** The registry is keyed by attacker,
 *      window identity and target, so a 20-frame flamethrower window — which is
 *      queued twenty separate times — burns you exactly once.
 *   3. **Level beats guard.** A `low` that lands on a standing guard, or an
 *      `overhead` on a crouching one, is downgraded to `unblockable` before it
 *      is handed over. That is how the guard button stays honest: block covers
 *      most things, but not everything, and the other answer is the z-axis.
 *
 * DIVISION OF LABOUR with `Fighter.takeHit`: the victim owns everything that is
 * about the victim — damage, combo scaling, blockstun, knockback, its own hit
 * spark, its damage number, its grunt, its hitstop. This resolver owns
 * everything that is about the *contact*: where the boxes actually met, which
 * direction the blow travelled, the impact ring, and the KO shockwave. Nothing
 * here duplicates a cue the victim already plays.
 *
 * Everything runs inside the deterministic sim: randomness comes from `ctx.rng`
 * only, and the FxBus/AudioBus calls are dropped during rollback.
 */

import { PARRY_FRAMES, Z_HIT_TOLERANCE } from '@/core/constants';
import { boxOverlap, clamp } from '@/core/math';
import { MOVES } from '@/game/combat/Moves';
import type { Fighter } from '@/game/Fighter';
import type {
  AudioBus,
  Box3,
  FighterState,
  FxBus,
  HitProperties,
  HitWindow,
  MoveDef,
  SimContext,
  Team,
} from '@/core/types';

export interface PendingHit {
  attackerId: number;
  window: HitWindow;
  frame: number;
}

/**
 * What the resolver needs off a fighter. The required members are all in the
 * module manifest; the optional ones are refinements it uses when a particular
 * fighter offers them and falls back sanely when it does not.
 */
interface CombatBody {
  readonly id: number;
  readonly team: Team;
  readonly pos: { x: number; y: number; z: number };
  readonly vel: { x: number; y: number; z: number };
  readonly facing: 1 | -1;
  readonly state: FighterState;
  readonly health: number;
  readonly stateFrame: number;
  readonly grounded: boolean;
  readonly archetype: string;
  readonly alive: boolean;
  takeHit(props: HitProperties, fromX: number, ctx: SimContext, attacker: unknown): boolean;

  /** True while nothing can touch this fighter. */
  readonly invulnerable?: boolean;
  readonly isBoss?: boolean;
  /** The move currently executing, for fighters that publish it. */
  readonly move?: MoveDef | null;
  readonly moveId?: string | null;
  readonly hurtbox?: Box3 | null;
  readonly crouching?: boolean;
  /** Takes a victim into this fighter's grip. Present on the real Fighter. */
  seizeGrab?(victim: unknown): boolean;
  /** Optional punish hook: extra recovery frames after being parried. */
  addRecovery?(frames: number): void;
}

interface AttackRecord {
  /** Attacker `stateFrame` at the last resolve; a drop means a new move. */
  frame: number;
  hits: Set<string>;
}

// ── Palettes ─────────────────────────────────────────────────────────────────

const BLOOD = ['#e8514f', '#b6262c', '#f2a3a0', '#ffffff'];
const SPARK = ['#fff6cf', '#ffc247', '#ff8a2b', '#9fd8ff'];
const GUARD = ['#dff1ff', '#7fc4ff', '#ffffff'];
const PARRY = ['#ffffff', '#ffe9a0', '#8ff0ff'];

/** Archetype fragments that throw sparks and oil instead of blood. */
const MECHANICAL = [
  'bot',
  'drone',
  'robot',
  'iot',
  'fridge',
  'speaker',
  'vacuum',
  'truck',
  'rocket',
  'machine',
  'turret',
];

/** States in which a fighter is definitely not swinging at anybody. */
const IDLE_STATES = new Set<FighterState>([
  'hurt',
  'launched',
  'knockdown',
  'getup',
  'stunned',
  'blockstun',
  'block',
  'grabbed',
  'thrown',
  'dead',
  'entering',
  'victory',
]);

/** States in which a fighter cannot be struck at all. */
const UNHITTABLE = new Set<FighterState>(['dead', 'entering', 'victory']);

const STAND_HURT: Box3 = { ox: 0, oy: 25, oz: 0, hw: 10, hh: 26, hd: 10 };
const LOW_HURT: Box3 = { ox: 0, oy: 11, oz: 0, hw: 12, hh: 12, hd: 10 };

function isMechanical(archetype: string): boolean {
  const a = archetype.toLowerCase();
  for (let i = 0; i < MECHANICAL.length; i++) {
    if (a.indexOf(MECHANICAL[i]) >= 0) return true;
  }
  return false;
}

function hurtboxOf(f: CombatBody): Box3 {
  const hb = f.hurtbox;
  if (hb) return hb;
  if (f.crouching === true || f.state === 'knockdown' || f.state === 'getup') return LOW_HURT;
  return STAND_HURT;
}

// ── Window identity ──────────────────────────────────────────────────────────

/**
 * Every `HitWindow` in the table is a singleton object, so identity is a
 * perfectly good key — and far cheaper than trying to describe a box in a
 * string. Ids are handed out lazily and only ever used as Set keys, never
 * iterated, so they cannot affect determinism.
 */
const windowIds = new WeakMap<HitWindow, number>();
let nextWindowId = 1;

function windowId(w: HitWindow): number {
  let id = windowIds.get(w);
  if (id === undefined) {
    id = nextWindowId++;
    windowIds.set(w, id);
  }
  return id;
}

/**
 * Reverse index from a hit window back to the move that owns it, so a queued
 * hitbox still knows whether it is a grab, which weapon swung it, and so on.
 */
let owners: WeakMap<HitWindow, MoveDef> | null = null;
let indexedMoves = -1;

function buildOwnerIndex(): WeakMap<HitWindow, MoveDef> {
  const map = new WeakMap<HitWindow, MoveDef>();
  const ids = Object.keys(MOVES);
  for (let i = 0; i < ids.length; i++) {
    const m = MOVES[ids[i]];
    for (let j = 0; j < m.windows.length; j++) map.set(m.windows[j], m);
  }
  indexedMoves = ids.length;
  return map;
}

function moveForWindow(w: HitWindow): MoveDef | null {
  if (!owners) owners = buildOwnerIndex();
  let m = owners.get(w);
  if (!m && Object.keys(MOVES).length !== indexedMoves) {
    owners = buildOwnerIndex();
    m = owners.get(w);
  }
  return m ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────

export class CombatResolver {
  private readonly fx: FxBus;
  private readonly audio: AudioBus;
  private readonly reg = new Map<number, AttackRecord>();
  private readonly pending: PendingHit[] = [];

  constructor(fx: FxBus, audio: AudioBus) {
    this.fx = fx;
    this.audio = audio;
  }

  /**
   * The `SimContext.spawnHit` hook. Fighters call this once per frame for every
   * window they have open; deduplication happens at resolve time.
   */
  spawnHit(attackerId: number, window: HitWindow, frame = 0): void {
    this.pending.push({ attackerId, window, frame });
  }

  /** Same thing, for callers that already hold a `PendingHit`. */
  enqueue(hit: PendingHit): void {
    this.pending.push(hit);
  }

  reset(): void {
    this.reg.clear();
    this.pending.length = 0;
  }

  resolve(fighters: Fighter[], ctx: SimContext): void {
    const bodies = fighters as unknown as CombatBody[];

    // Path A — fighters that expose their active move object directly.
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a) continue;
      const mv = this.moveOf(a);
      if (!mv || mv.windows.length === 0) continue;
      for (let w = 0; w < mv.windows.length; w++) {
        const hw = mv.windows[w];
        if (a.stateFrame < hw.start || a.stateFrame > hw.end) continue;
        this.attempt(a, hw, mv, bodies, ctx);
      }
    }

    // Path B — the queue fed by SimContext.spawnHit. Shares the registry with
    // path A, so a fighter doing both cannot land the same window twice.
    for (let p = 0; p < this.pending.length; p++) {
      const ph = this.pending[p];
      const a = this.find(bodies, ph.attackerId);
      if (!a) continue;
      this.attempt(a, ph.window, moveForWindow(ph.window), bodies, ctx);
    }
    this.pending.length = 0;
    if (this.reg.size > bodies.length + 8) this.prune(bodies);
  }

  /** Drops records for fighters that have left the level. Memory only. */
  private prune(bodies: CombatBody[]): void {
    const live = new Set<number>();
    for (let i = 0; i < bodies.length; i++) if (bodies[i]) live.add(bodies[i].id);
    for (const id of this.reg.keys()) {
      if (!live.has(id)) this.reg.delete(id);
    }
  }

  // ── Detection ──────────────────────────────────────────────────────────────

  private find(bodies: CombatBody[], id: number): CombatBody | null {
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i] && bodies[i].id === id) return bodies[i];
    }
    return null;
  }

  private attempt(
    a: CombatBody,
    hw: HitWindow,
    mv: MoveDef | null,
    bodies: CombatBody[],
    ctx: SimContext,
  ): void {
    if (!a.alive) return;
    const rec = this.record(a);
    const wid = windowId(hw);

    for (let j = 0; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b || b.id === a.id) continue;
      const key = `${wid}:${b.id}`;
      if (rec.hits.has(key)) continue;
      if (!this.canConnect(a, b, hw, mv)) continue;
      rec.hits.add(key);
      this.connect(a, b, hw, mv, ctx);
    }
  }

  private canConnect(
    a: CombatBody,
    b: CombatBody,
    hw: HitWindow,
    mv: MoveDef | null,
  ): boolean {
    if (!b.alive || a.team === b.team) return false;
    if (UNHITTABLE.has(b.state)) return false;
    if (b.invulnerable === true) return false;
    // A body on the floor is only reachable by something that goes low.
    if (b.state === 'knockdown' && hw.props.level !== 'low') return false;

    if (mv && mv.isGrab && hw.props.damage <= 0) {
      // A grab attempt, not a throw. Airborne or already-held targets slip it.
      if (!b.grounded) return false;
      if (b.state === 'grabbed' || b.state === 'thrown' || b.state === 'launched') return false;
      if (b.isBoss === true) return false;
    }

    // The belt-scroller rule: only things sharing your walking plane exist.
    if (Math.abs(a.pos.z - b.pos.z) > Z_HIT_TOLERANCE) return false;

    return boxOverlap(hw.box, a.pos, a.facing, hurtboxOf(b), b.pos, b.facing);
  }

  private moveOf(f: CombatBody): MoveDef | null {
    if (IDLE_STATES.has(f.state)) return null;
    const m = f.move;
    if (m && Array.isArray(m.windows)) return f.stateFrame <= m.duration ? m : null;
    const id = f.moveId;
    if (typeof id === 'string' && id.length > 0) {
      const mv = MOVES[id];
      if (mv) return f.stateFrame <= mv.duration ? mv : null;
    }
    return null;
  }

  private record(a: CombatBody): AttackRecord {
    let rec = this.reg.get(a.id);
    if (!rec) {
      rec = { frame: a.stateFrame, hits: new Set<string>() };
      this.reg.set(a.id, rec);
      return rec;
    }
    // `stateFrame` climbs monotonically inside a move and resets to zero when a
    // new one starts, so a drop is exactly the signal for "fresh attack".
    if (a.stateFrame < rec.frame) rec.hits.clear();
    rec.frame = a.stateFrame;
    return rec;
  }

  // ── Guard rules ────────────────────────────────────────────────────────────

  /** Whether the defender is in a stance that could block this at all. */
  private guarding(d: CombatBody, a: CombatBody, p: HitProperties): boolean {
    if (p.level === 'unblockable') return false;
    if (d.state !== 'block' && d.state !== 'blockstun') return false;
    const dx = a.pos.x - d.pos.x;
    return dx === 0 || (dx > 0 ? 1 : -1) === d.facing;
  }

  /**
   * The level rule. A guard that is standing eats lows; a guard that is
   * crouching eats overheads. There is no crouch stance yet, which makes lows
   * the universal guard-breaker — and the z-axis the answer to them.
   */
  private levelBeatsGuard(d: CombatBody, p: HitProperties): boolean {
    const crouch = d.crouching === true;
    if (p.level === 'overhead' && crouch) return true;
    if (p.level === 'low' && !crouch) return true;
    return false;
  }

  private isParry(d: CombatBody): boolean {
    return d.state === 'block' && d.stateFrame < PARRY_FRAMES;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  private connect(
    a: CombatBody,
    b: CombatBody,
    hw: HitWindow,
    mv: MoveDef | null,
    ctx: SimContext,
  ): void {
    const base = hw.props;

    // A grab is a seizure, not a strike.
    if (mv && mv.isGrab && base.damage <= 0) {
      if (a.seizeGrab && a.seizeGrab(b)) this.grabJuice(a, b, ctx);
      return;
    }

    const guarding = this.guarding(b, a, base);
    const broken = guarding && this.levelBeatsGuard(b, base);
    const blocked = guarding && !broken;
    const parried = blocked && this.isParry(b);

    // Contact point: halfway between the leading edge of the hitbox and the
    // body it landed on, pinned to somewhere plausible on that body.
    const cx = (a.pos.x + hw.box.ox * a.facing + b.pos.x) * 0.5;
    const cy = clamp(a.pos.y + hw.box.oy, b.pos.y + 8, b.pos.y + 46);
    const cz = b.pos.z;
    const dir: 1 | -1 = b.pos.x === a.pos.x ? a.facing : b.pos.x > a.pos.x ? 1 : -1;

    const props = broken ? withLevel(base, 'unblockable') : base;
    const before = b.health;
    if (!b.takeHit(props, a.pos.x, ctx, a)) return;

    if (parried) {
      this.parryJuice(a, b, cx, cy, cz, dir);
      return;
    }
    if (blocked) {
      this.blockJuice(b, cx, cy, cz, dir);
      return;
    }

    const dealt = Math.max(0, before - b.health);
    this.impactJuice(b, props, dealt, cx, cy, cz, dir);
    if (!b.alive) this.koJuice(b, cx, cy, cz);
  }

  // ── Presentation ───────────────────────────────────────────────────────────

  /**
   * The contact burst. The victim draws its own generic hit spark; this is the
   * directional half — a cone thrown along the line the blow actually
   * travelled, from the point where the boxes met.
   */
  private impactJuice(
    b: CombatBody,
    props: HitProperties,
    damage: number,
    cx: number,
    cy: number,
    cz: number,
    dir: 1 | -1,
  ): void {
    const heavy = props.reaction !== 'light';
    const metal = isMechanical(b.archetype);
    const d = damage > 0 ? damage : props.damage;

    this.fx.particles({
      count: Math.round(clamp(4 + d * 0.7, 4, 22)),
      x: cx,
      y: cy,
      z: cz,
      angle: dir > 0 ? 0.3 : Math.PI - 0.3,
      spread: 1.45,
      speed: [1.1 + d * 0.05, 2.4 + d * 0.16],
      life: [6, 18],
      size: [1, 1.2 + d * 0.07],
      colors: metal ? SPARK : BLOOD,
      gravity: metal ? 0.2 : 0.28,
      drag: 0.9,
      shape: metal ? 'spark' : 'blood',
      additive: metal,
      fade: 'ease',
      spin: 0.25,
    });

    if (!heavy) return;

    // Expanding ring at the point of contact, plus a directional nudge on the
    // shake so the camera leans the way the punch went.
    this.fx.particles({
      count: 1,
      x: cx,
      y: cy,
      z: cz,
      angle: 0,
      spread: 0,
      speed: [0, 0],
      life: [6, 10],
      size: [8 + d * 0.35, 13 + d * 0.55],
      colors: metal ? ['#9fd8ff'] : ['#ffffff'],
      gravity: 0,
      drag: 1,
      shape: 'ring',
      additive: true,
      fade: 'ease',
    });
    this.fx.shake({
      magnitude: props.shake * 0.4,
      duration: 8,
      frequency: 1.2,
      dirX: dir,
      dirY: 0.3,
    });
    this.fx.aberration(clamp(d * 0.02, 0.1, 0.5), 8);
    if (d >= 18) this.fx.shockwave(cx, cy, cz, 26 + d, 12);
  }

  /**
   * The victim already announces its own death. What it cannot do is describe
   * the space around it, so the resolver adds the pressure wave and the lens
   * pull — and only for a kill that is worth the theatre.
   */
  private koJuice(b: CombatBody, cx: number, cy: number, cz: number): void {
    const marquee = b.isBoss === true || b.team === 'player';
    this.fx.shockwave(cx, cy, cz, marquee ? 110 : 46, marquee ? 30 : 14);
    this.fx.aberration(marquee ? 0.95 : 0.35, marquee ? 26 : 10);
    if (!marquee) return;
    this.fx.particles({
      count: 20,
      x: cx,
      y: cy,
      z: cz,
      angle: Math.PI * 0.5,
      spread: Math.PI * 2,
      speed: [2, 6.5],
      life: [18, 44],
      size: [1.6, 4.2],
      colors: isMechanical(b.archetype) ? SPARK : BLOOD,
      gravity: 0.26,
      drag: 0.93,
      shape: isMechanical(b.archetype) ? 'shard' : 'blood',
      fade: 'ease',
      spin: 0.35,
    });
  }

  private blockJuice(
    b: CombatBody,
    cx: number,
    cy: number,
    cz: number,
    dir: 1 | -1,
  ): void {
    this.fx.particles({
      count: 5,
      x: cx,
      y: cy,
      z: cz,
      angle: dir > 0 ? 0.55 : Math.PI - 0.55,
      spread: 1.0,
      speed: [1.2, 3.4],
      life: [5, 13],
      size: [1, 2.2],
      colors: GUARD,
      gravity: 0.06,
      drag: 0.9,
      shape: 'spark',
      additive: true,
      fade: 'ease',
    });
    this.fx.impactFrame(b.id, 2);
  }

  /**
   * A parry is the loudest four frames in the game. The victim handles the
   * meter, flash and slow-motion; here we add the ring, the shrapnel of stars,
   * the aberration pull, and — the part that actually matters competitively —
   * shoving the attacker off so the defender gets their turn.
   */
  private parryJuice(
    a: CombatBody,
    b: CombatBody,
    cx: number,
    cy: number,
    cz: number,
    dir: 1 | -1,
  ): void {
    if (a.addRecovery) a.addRecovery(PARRY_FRAMES * 4);
    // Deterministic, sim-side punish: the whiffed attacker is thrown backwards,
    // which is what buys the defender the space to answer.
    a.vel.x -= dir * 3.6;

    this.fx.aberration(0.55, 14);
    this.fx.shockwave(cx, cy, cz, 34, 14);
    this.fx.impactFrame(b.id, 5);
    this.fx.particles({
      count: 2,
      x: cx,
      y: cy,
      z: cz,
      angle: 0,
      spread: 0,
      speed: [0, 0],
      life: [9, 15],
      size: [12, 28],
      colors: PARRY,
      gravity: 0,
      drag: 1,
      shape: 'ring',
      additive: true,
      fade: 'ease',
    });
    this.fx.particles({
      count: 12,
      x: cx,
      y: cy,
      z: cz,
      angle: dir > 0 ? Math.PI - 0.2 : 0.2,
      spread: 2.2,
      speed: [2, 5.2],
      life: [10, 24],
      size: [1, 2.6],
      colors: PARRY,
      gravity: 0.04,
      drag: 0.93,
      shape: 'star',
      additive: true,
      fade: 'flicker',
      spin: 0.4,
    });
  }

  private grabJuice(a: CombatBody, b: CombatBody, ctx: SimContext): void {
    this.fx.particles({
      count: 6,
      x: b.pos.x,
      y: b.pos.y + 24,
      z: b.pos.z,
      angle: Math.PI * 0.5,
      spread: 1.6,
      speed: [0.8, 2.2],
      life: [8, 16],
      size: [1, 2.4],
      colors: ['#f4f0e6', '#cfc6b8'],
      gravity: 0.04,
      drag: 0.9,
      shape: 'dot',
      fade: 'ease',
    });
    this.fx.shake({ magnitude: 1.6, duration: 5, dirX: a.facing, dirY: 0.2 });
    this.fx.impactFrame(b.id, 2);
    this.audio.play('grunt', { pitch: 1 + ctx.rng.range(-0.05, 0.05), gain: 0.8 });
    ctx.requestHitstop(4);
  }
}

/** Copy of a props block with a different level. Never mutates the table. */
function withLevel(p: HitProperties, level: HitProperties['level']): HitProperties {
  return {
    damage: p.damage,
    hitstun: p.hitstun,
    blockstun: p.blockstun,
    hitstop: p.hitstop,
    knockback: { x: p.knockback.x, y: p.knockback.y },
    pushback: p.pushback,
    reaction: p.reaction,
    level,
    chip: p.chip,
    meterGain: p.meterGain,
    meterGainVictim: p.meterGainVictim,
    shake: p.shake,
    sfx: p.sfx,
  };
}
