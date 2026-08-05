/**
 * The robot holding the controller.
 *
 * An enemy is not a special kind of entity: it is an ordinary `Fighter` whose
 * `InputSource` happens to be this class. Everything the player can do it can
 * do, through the same button mask, which is why an `EnemyAI` can be dropped
 * into a player slot (and a player into an enemy slot) without the game layer
 * noticing.
 *
 * Two rules make the difference between "beat-em-up AI" and "broken game":
 *
 *  1. A decision is HELD for `AiProfile.reactionFrames`. Re-deciding every
 *     frame produces enemies that vibrate on the spot and never commit.
 *  2. Depth before distance. In a belt-scroller an enemy that charges along x
 *     while its z is off by twenty units will whiff forever and look stupid.
 *     So: line up on the target's plane, THEN close, and only swing once
 *     inside `Z_HIT_TOLERANCE`.
 *
 * Randomness comes from a per-enemy mulberry32 seeded from the fighter id, so
 * it is bit-identical on every peer. `Math.random` is never called here.
 */

import type { AiProfile, BtnMask, FighterState, InputSource, Rng } from '@/core/types';
import { Btn } from '@/core/types';
import type { Fighter } from '@/game/Fighter';
import { clamp, hashNumber } from '@/core/math';
import { makeRng } from '@/engine/Rng';
import { Z_HIT_TOLERANCE } from '@/core/constants';

/**
 * `AiProfile` plus the two numbers that live on `EnemyDef`/`BossPhase` rather
 * than on the profile itself. A plain `AiProfile` is still a valid argument.
 */
export type AiTuning = AiProfile & {
  /** Preferred stand-off distance in world units. */
  spacing?: number;
  /** 0..1 willingness to close and swing. */
  aggression?: number;
  /** Extra entropy so two identical enemies do not move as one. */
  seed?: number;
};

type Plan =
  | 'approach'
  | 'space'
  | 'circle'
  | 'retreat'
  | 'ranged'
  | 'guard'
  | 'feint'
  | 'leap'
  | 'grab'
  | 'idle';

/** States in which no input can be expressed, so we save the rng the trouble. */
const HELPLESS: ReadonlySet<FighterState> = new Set<FighterState>([
  'hurt',
  'launched',
  'knockdown',
  'getup',
  'grabbed',
  'thrown',
  'stunned',
  'dead',
  'entering',
  'victory',
]);

/** States where a move is already committed and only a follow-up matters. */
const COMMITTED: ReadonlySet<FighterState> = new Set<FighterState>([
  'attack',
  'grabbing',
  'super',
  'blockstun',
]);

/** States that mean "this one is currently swinging at somebody". */
const SWINGING: ReadonlySet<FighterState> = new Set<FighterState>(['attack', 'grabbing', 'super']);

const REACH_LIGHT = 30;
const REACH_HEAVY = 40;
const REACH_GRAB = 22;
/** Below this the sniper stops shooting and starts walking backwards. */
const RANGED_MIN = 78;
const RANGED_MAX = 300;
/** Depth error we are willing to swing through. */
const Z_ALIGNED = Z_HIT_TOLERANCE * 0.8;
/** Inside this x gap the enemy must finish lining up before it may close. */
const CLOSE_X = 76;
const PRESS_FRAMES = 3;
const BLOCK_HOLD = 15;
/** Frames a threat has to be in startup for us to still react to it. */
const THREAT_STARTUP = 8;
const THREAT_RANGE = 56;
const DASH_TOTAL = 20;

/**
 * Which button walks a fighter toward a LARGER z.
 *
 * z=0 is the back wall and z=Z_DEPTH is nearest the camera, so growing z means
 * walking toward the viewer, which is Down. Having this written out three
 * times is how the AI ended up steering away from its target when the axis was
 * corrected — every consumer now goes through here.
 */
function zButton(delta: number): BtnMask {
  return delta > 0 ? Btn.Down : Btn.Up;
}

export class EnemyAI implements InputSource {
  readonly kind = 'ai' as const;
  readonly id: string;

  private readonly self: Fighter;
  private readonly p: AiTuning;
  private readonly world: () => Fighter[];
  private readonly rng: Rng;

  private frame = 0;
  private timer = 0;
  private plan: Plan = 'approach';
  /** Distance the current plan wants to hold. */
  private standoff = 34;
  /** Which side of the target we are trying to occupy. */
  private side: 1 | -1 = 1;
  /** Depth offset from the target, so a pack does not stack in one line. */
  private lane = 0;

  private targetId = -1;
  private targetHold = 0;

  private atkBtn = 0;
  private atkLeft = 0;
  private atkGap = 0;
  private comboArmed = false;

  private blockLeft = 0;
  private lastThreat = -1;
  private counterWindow = 0;

  private dashDir = 0;
  private dashFrame = -1;
  private jumpLeft = 0;

  constructor(self: Fighter, profile: AiTuning, world: () => Fighter[]) {
    this.self = self;
    this.p = profile;
    this.world = world;
    this.id = `ai:${self.id}`;

    let s = hashNumber(0x9e3779b9, self.id);
    s = hashNumber(s, profile.seed ?? 0);
    s = hashNumber(s, profile.reactionFrames);
    s = hashNumber(s, profile.blockSkill * 1000);
    s = hashNumber(s, profile.behaviour.length * 31);
    this.rng = makeRng(s);

    this.side = this.rng.chance(0.5) ? 1 : -1;
    this.lane = this.rng.range(-Z_HIT_TOLERANCE * 0.55, Z_HIT_TOLERANCE * 0.55);
    this.standoff = profile.spacing ?? REACH_LIGHT;
    this.timer = 1 + this.rng.int(0, Math.max(1, profile.reactionFrames));
  }

  label(): string {
    return `${this.p.behaviour} AI`;
  }

  sample(frame: number): BtnMask {
    this.frame = frame;
    const self = this.self;

    if (!self.alive || HELPLESS.has(self.state)) {
      this.timer = 0;
      this.blockLeft = 0;
      this.atkLeft = 0;
      this.atkGap = 0;
      this.comboArmed = false;
      this.dashFrame = -1;
      this.jumpLeft = 0;
      return 0;
    }

    const target = this.acquire();

    if (COMMITTED.has(self.state)) {
      // Mid-move. The only input worth sending is a cancel into the follow-up.
      return this.followUp(target);
    }

    this.senseThreats(target);

    if (this.blockLeft > 0) {
      this.blockLeft--;
      if (this.blockLeft === 0) this.counterWindow = 12;
      return this.guardMask(target);
    }
    if (this.counterWindow > 0) this.counterWindow--;

    if (!target) return this.wander();

    if (--this.timer <= 0) this.decide(target);

    return this.drive(target);
  }

  // ── target selection ───────────────────────────────────────────────────────

  private acquire(): Fighter | null {
    const self = this.self;
    const list = this.world();

    if (this.targetHold > 0) {
      this.targetHold--;
      const held = this.byId(list, this.targetId);
      if (held && held.alive) return held;
    }

    let best: Fighter | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === self || !f.alive || !this.hostile(f)) continue;
      const dx = f.pos.x - self.pos.x;
      const dz = f.pos.z - self.pos.z;
      // Depth is cheap to fix, distance is not; weight it accordingly.
      let score = Math.abs(dx) + Math.abs(dz) * 0.45;
      // Gently prefer whoever fewer of my friends are already chewing on.
      score += this.crowding(f) * 26;
      if (f.id === this.targetId) score -= 18;
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }

    if (best && best.id !== this.targetId) {
      this.targetId = best.id;
      this.targetHold = this.p.reactionFrames * 4 + this.rng.int(0, 40);
    }
    return best;
  }

  private byId(list: Fighter[], id: number): Fighter | null {
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  private hostile(f: Fighter): boolean {
    return f.team !== this.self.team && f.team !== 'neutral';
  }

  private crowding(t: Fighter): number {
    const self = this.self;
    const list = this.world();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === self || !f.alive || f.team !== self.team) continue;
      if (Math.abs(f.pos.x - t.pos.x) < 70 && Math.abs(f.pos.z - t.pos.z) < 34) n++;
    }
    return n;
  }

  /** How many of my side are already committed to a swing near the target. */
  private busy(t: Fighter): number {
    const self = this.self;
    const list = this.world();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === self || !f.alive || f.team !== self.team) continue;
      if (!SWINGING.has(f.state)) continue;
      if (Math.abs(f.pos.x - t.pos.x) < 110) n++;
    }
    return n;
  }

  // ── deciding ───────────────────────────────────────────────────────────────

  private decide(target: Fighter): void {
    const p = this.p;
    const self = this.self;
    const spacing = p.spacing ?? REACH_LIGHT + 12;
    const aggr = clamp(p.aggression ?? 0.6, 0, 1);
    const adx = Math.abs(target.pos.x - self.pos.x);
    const queued = this.busy(target);
    // Swarm control: if a friend is already on them, most enemies wait their
    // turn — but they wait by circling and feinting, never by standing still.
    const mayEngage = queued === 0 || this.rng.next() < p.swarm;

    this.timer = Math.max(4, p.reactionFrames + this.rng.int(-2, 4));
    this.side = target.pos.x >= self.pos.x ? -1 : 1;
    if (this.rng.chance(0.25)) this.lane = this.rng.range(-Z_HIT_TOLERANCE * 0.7, Z_HIT_TOLERANCE * 0.7);

    switch (p.behaviour) {
      case 'rusher': {
        this.standoff = REACH_LIGHT * 0.82;
        if (!mayEngage) {
          this.plan = this.rng.chance(0.5) ? 'circle' : 'feint';
          this.standoff = spacing;
        } else if (adx > 150 && this.rng.chance(aggr * 0.5)) {
          this.plan = 'approach';
          this.startDash(target.pos.x > self.pos.x ? 1 : -1);
        } else if (adx < REACH_GRAB + 10 && this.rng.chance(0.18)) {
          this.plan = 'grab';
        } else if (adx > 70 && adx < 130 && this.rng.chance(aggr * 0.22)) {
          this.plan = 'leap';
        } else {
          this.plan = 'approach';
        }
        break;
      }
      case 'spacer': {
        this.standoff = spacing;
        const punish = target.state === 'attack' && target.stateFrame > 4;
        if (punish && mayEngage && this.rng.chance(0.5 + aggr * 0.4)) {
          this.plan = 'approach';
          this.standoff = REACH_LIGHT * 0.78;
        } else if (adx < spacing * 0.62) {
          this.plan = 'retreat';
        } else if (mayEngage && this.rng.chance(aggr * 0.4)) {
          // Poke now and then, so holding the spacing is a threat rather than
          // a stalemate the player can walk away from.
          this.plan = 'approach';
          this.standoff = REACH_LIGHT * 0.9;
        } else {
          this.plan = this.rng.chance(0.55) ? 'space' : 'circle';
        }
        break;
      }
      case 'sniper': {
        this.standoff = Math.max(spacing, RANGED_MIN + 24);
        if (adx < RANGED_MIN) this.plan = 'retreat';
        else if (adx > RANGED_MAX) this.plan = 'approach';
        else this.plan = mayEngage ? 'ranged' : 'circle';
        break;
      }
      case 'turtle': {
        this.standoff = Math.max(REACH_LIGHT, spacing * 0.7);
        const threatened = adx < REACH_HEAVY + 14;
        if (this.counterWindow > 0 && mayEngage) this.plan = 'approach';
        else if (threatened && this.rng.chance(clamp(p.blockSkill + 0.2, 0, 0.92))) this.plan = 'guard';
        else if (adx > spacing * 1.6) this.plan = 'approach';
        else this.plan = this.rng.chance(0.4) ? 'space' : 'guard';
        break;
      }
      case 'erratic': {
        const roll = this.rng.next();
        this.standoff = this.rng.range(REACH_LIGHT * 0.7, Math.max(spacing, 60));
        if (roll < 0.34) {
          this.plan = 'approach';
          if (adx > 120 && this.rng.chance(0.55)) this.startDash(target.pos.x > self.pos.x ? 1 : -1);
        } else if (roll < 0.5) this.plan = 'leap';
        else if (roll < 0.62) this.plan = 'retreat';
        else if (roll < 0.74) this.plan = 'feint';
        else if (roll < 0.86) this.plan = 'circle';
        else this.plan = 'grab';
        this.timer = Math.max(3, (p.reactionFrames >> 1) + this.rng.int(0, 14));
        break;
      }
      case 'support': {
        this.standoff = spacing * 1.55;
        if (queued > 0 && this.rng.next() < p.swarm * 0.8) {
          // The friend is committed — pile in behind them.
          this.plan = 'approach';
          this.standoff = REACH_LIGHT * 0.9;
        } else if (adx < spacing) {
          this.plan = 'retreat';
        } else if (adx > 200) {
          this.plan = 'approach';
        } else {
          this.plan = this.rng.chance(0.6) ? 'circle' : 'ranged';
        }
        break;
      }
      default:
        this.plan = 'approach';
        break;
    }

    // Meter is not a resource an enemy hoards for a rainy day.
    if (self.meter >= 1 && mayEngage && adx < REACH_HEAVY + 20 && this.rng.chance(0.14 + aggr * 0.2)) {
      this.startPress(Btn.Super, PRESS_FRAMES + 1, 40);
    }
  }

  // ── acting ─────────────────────────────────────────────────────────────────

  private drive(target: Fighter): BtnMask {
    const self = this.self;
    const dx = target.pos.x - self.pos.x;
    const dz = target.pos.z - self.pos.z;
    const adx = Math.abs(dx);
    const toward = dx >= 0 ? 1 : -1;

    let wantX = self.pos.x;
    let wantZ = target.pos.z + this.lane;

    switch (this.plan) {
      case 'approach':
      case 'grab':
        wantX = target.pos.x - toward * (this.plan === 'grab' ? REACH_GRAB * 0.7 : this.standoff);
        break;
      case 'space':
      case 'ranged':
        wantX = target.pos.x - toward * this.standoff;
        wantZ = this.plan === 'ranged' ? target.pos.z : wantZ;
        break;
      case 'retreat':
        wantX = self.pos.x - toward * 70;
        wantZ = self.pos.z + this.lane * 0.4;
        break;
      case 'circle': {
        // Orbit: hold the ring distance and slide through depth.
        const phase = Math.sin((this.frame + self.id * 37) * 0.035);
        wantX = target.pos.x - toward * this.standoff;
        wantZ = target.pos.z + phase * Z_HIT_TOLERANCE * 1.9 + this.lane;
        break;
      }
      case 'feint': {
        const bob = Math.sin((this.frame + self.id * 53) * 0.09);
        wantX = target.pos.x - toward * (this.standoff + bob * 22);
        break;
      }
      case 'leap':
        wantX = target.pos.x - toward * REACH_LIGHT * 0.6;
        if (this.jumpLeft === 0 && self.grounded) this.jumpLeft = 3;
        break;
      case 'guard':
        wantX = target.pos.x - toward * this.standoff;
        break;
      default:
        break;
    }

    let mask = this.steer(wantX, wantZ, dz, adx);
    if (this.plan === 'guard' && adx < REACH_HEAVY + 18) mask |= Btn.Block;

    if (this.jumpLeft > 0) {
      this.jumpLeft--;
      mask |= Btn.Jump;
    }

    mask |= this.attackMask(target, dx, dz, adx);
    return mask;
  }

  /**
   * Depth first, then distance. X input is withheld until the depth error is
   * inside the hit tolerance, unless the target is still far enough away that
   * closing and lining up can honestly happen at the same time.
   */
  private steer(wantX: number, wantZ: number, dz: number, adx: number): BtnMask {
    const self = this.self;
    let mask = 0;

    if (this.dashFrame >= 0) {
      const f = this.dashFrame++;
      const dir = this.dashDir > 0 ? Btn.Right : Btn.Left;
      if (this.dashFrame >= DASH_TOTAL) this.dashFrame = -1;
      // tap - gap - hold: what a human does to make the game dash.
      if (f < 2 || f >= 4) mask |= dir;
      return mask;
    }

    const ddz = wantZ - self.pos.z;
    if (Math.abs(ddz) > 2.2) mask |= zButton(ddz);

    const aligned = Math.abs(dz) <= Z_ALIGNED;
    const allowX = aligned || adx > CLOSE_X || this.plan === 'retreat' || this.plan === 'ranged';
    const ddx = wantX - self.pos.x;
    if (allowX && Math.abs(ddx) > 3) mask |= ddx > 0 ? Btn.Right : Btn.Left;

    return mask;
  }

  private attackMask(target: Fighter, dx: number, dz: number, adx: number): BtnMask {
    if (this.atkLeft > 0) {
      this.atkLeft--;
      if (this.atkLeft === 0) this.comboArmed = this.rng.chance(this.p.comboSkill);
      return this.atkBtn;
    }
    if (this.atkGap > 0) {
      this.atkGap--;
      return 0;
    }
    if (!this.self.grounded && this.plan !== 'leap') return 0;
    if (Math.abs(dz) > Z_HIT_TOLERANCE) return 0;

    const aggr = clamp(this.p.aggression ?? 0.6, 0, 1);

    if (this.plan === 'ranged') {
      if (adx < RANGED_MIN * 0.55 || adx > RANGED_MAX) return 0;
      this.startPress(Btn.Special, PRESS_FRAMES, 26 + this.rng.int(0, 22));
      return this.atkBtn;
    }

    if (this.plan === 'grab' && adx <= REACH_GRAB) {
      this.startPress(Btn.Grab, PRESS_FRAMES, 30);
      return this.atkBtn;
    }

    const reach = this.self.weapon ? REACH_HEAVY + 8 : REACH_HEAVY;
    if (adx > reach) return 0;
    if (this.plan === 'retreat' || this.plan === 'guard') return 0;

    // A stunned or reeling target is an invitation; otherwise commit by
    // aggression so a timid enemy does not machine-gun jabs.
    const openings =
      target.state === 'hurt' ||
      target.state === 'stunned' ||
      target.state === 'launched' ||
      target.state === 'blockstun';
    if (!openings && !this.rng.chance(0.35 + aggr * 0.6)) {
      this.atkGap = 6;
      return 0;
    }

    // Swarm control, checked at the moment of truth rather than only at the
    // last decision: while a friend is mid-swing, most of the pack must wait
    // its turn — and it waits by circling, not by piling on for a stunlock.
    const contested = this.busy(target);
    if (contested > 0 && this.rng.next() > this.p.swarm / (contested + 1)) {
      this.atkGap = 14;
      this.plan = 'circle';
      this.standoff = Math.max(this.p.spacing ?? REACH_HEAVY, REACH_HEAVY + 6);
      return 0;
    }

    const heavy =
      openings || adx > REACH_LIGHT ? this.rng.chance(0.55 + aggr * 0.25) : this.rng.chance(0.2);
    this.startPress(heavy ? Btn.Heavy : Btn.Light, PRESS_FRAMES, heavy ? 16 : 10);
    return this.atkBtn;
  }

  /** Cancel pressure while a move is already running. */
  private followUp(target: Fighter | null): BtnMask {
    const self = this.self;
    if (this.atkLeft > 0) {
      this.atkLeft--;
      return this.atkBtn;
    }
    if (!target || !this.comboArmed) return 0;
    if (self.stateFrame < 4) return 0;
    if (Math.abs(target.pos.x - self.pos.x) > REACH_HEAVY + 6) return 0;
    if (Math.abs(target.pos.z - self.pos.z) > Z_HIT_TOLERANCE) return 0;
    // Only chain off something that actually landed.
    if (target.state !== 'hurt' && target.state !== 'blockstun' && target.state !== 'launched') {
      return 0;
    }
    this.comboArmed = false;
    this.startPress(this.rng.chance(0.4) ? Btn.Heavy : Btn.Light, PRESS_FRAMES, 12);
    return this.atkBtn;
  }

  /**
   * Look for a hostile startup nearby and roll `blockSkill` against it once —
   * an enemy that re-rolls every frame blocks everything, which is miserable.
   */
  private senseThreats(target: Fighter | null): void {
    const p = this.p;
    if (p.blockSkill <= 0) return;
    if (this.blockLeft > 0) return;

    const self = this.self;
    const list = this.world();
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === self || !f.alive || !this.hostile(f)) continue;
      if (!SWINGING.has(f.state) || f.stateFrame > THREAT_STARTUP) continue;
      if (Math.abs(f.pos.x - self.pos.x) > THREAT_RANGE) continue;
      if (Math.abs(f.pos.z - self.pos.z) > Z_HIT_TOLERANCE * 1.4) continue;

      // One roll per attack instance, identified by the frame it started on.
      const tag = f.id * 100003 + (this.frame - f.stateFrame);
      if (tag === this.lastThreat) return;
      this.lastThreat = tag;

      const bonus = this.p.behaviour === 'turtle' ? 0.2 : 0;
      if (this.rng.next() < clamp(p.blockSkill + bonus, 0, 0.95)) {
        this.blockLeft = BLOCK_HOLD;
        this.atkLeft = 0;
        this.atkGap = 4;
      }
      return;
    }

    // Turtles also guard on principle when someone is standing on top of them.
    if (this.plan === 'guard' && target) {
      if (Math.abs(target.pos.x - self.pos.x) < REACH_HEAVY + 10 && this.rng.chance(0.08)) {
        this.blockLeft = BLOCK_HOLD;
      }
    }
  }

  private guardMask(target: Fighter | null): BtnMask {
    let mask = Btn.Block;
    if (!target) return mask;
    // Hold away from the attacker: a guard, not a statue.
    const away = this.self.pos.x < target.pos.x ? Btn.Left : Btn.Right;
    if (this.p.behaviour === 'turtle' || this.rng.chance(0.35)) mask |= away;
    const dz = target.pos.z - this.self.pos.z;
    if (Math.abs(dz) > Z_ALIGNED) mask |= zButton(dz);
    return mask;
  }

  /** Nobody left to fight: shuffle about instead of freezing mid-stride. */
  private wander(): BtnMask {
    if (--this.timer > 0) return this.plan === 'idle' ? 0 : this.wanderMask();
    this.timer = 30 + this.rng.int(0, 60);
    this.plan = this.rng.chance(0.45) ? 'idle' : 'circle';
    this.side = this.rng.chance(0.5) ? 1 : -1;
    this.lane = this.rng.range(-1, 1);
    return 0;
  }

  private wanderMask(): BtnMask {
    let mask = this.side > 0 ? Btn.Right : Btn.Left;
    if (this.lane > 0.4) mask |= zButton(1);
    else if (this.lane < -0.4) mask |= zButton(-1);
    return mask;
  }

  private startPress(btn: number, frames: number, gap: number): void {
    this.atkBtn = btn;
    this.atkLeft = frames;
    this.atkGap = gap;
  }

  private startDash(dir: 1 | -1): void {
    this.dashDir = dir;
    this.dashFrame = 0;
  }
}
