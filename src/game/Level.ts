/**
 * One map, from the first step to the boss lying on the floor.
 *
 * The Level owns the beat-em-up rhythm that everything else hangs off:
 *
 *   walk right → camera locks → a wave drops in → clear it → "GO ->" → repeat
 *   → the last gate is the boss, with phases, adds and a title card.
 *
 * It also owns the furniture: destructible props that cough up drops, weapons
 * lying on the floor, and whatever `SimContext.spawn` asks for (bullets, taser
 * bolts, dropped bats).
 *
 * WIRING NOTE — the Level updates the entities it created (enemies, the boss,
 * props, pickups, projectiles). It does NOT update the player fighters: the
 * scene owns the InputManager and steps those itself, then calls
 * `level.update(ctx)`. `render` draws everyone, players included, because the
 * whole point is that they interleave by depth.
 *
 * `renderBackground` and `render` both neutralise the camera translation where
 * they need screen space, so it does not matter whether the caller wrapped them
 * in `Renderer.withCamera`.
 */

import type {
  AudioBus,
  BossDef,
  BossPhase,
  EnemyDef,
  EnemyKind,
  Facing,
  FxBus,
  HitProperties,
  InputFrame,
  MapDef,
  PropSpawn,
  Rng,
  SimContext,
  Team,
  VoiceProfile,
  WeaponKind,
} from '@/core/types';
import type { Camera } from '@/render/Camera';
import { Fighter } from '@/game/Fighter';
import type { FighterInit } from '@/game/Fighter';
import { EnemyAI } from '@/game/ai/EnemyAI';
import type { AiTuning } from '@/game/ai/EnemyAI';
import { ENEMIES } from '@/content/enemies';
import { BOSSES } from '@/content/bosses';
import { WEAPONS } from '@/content/weapons';
import { DWARF_SKELETON, HUMAN_SKELETON } from '@/render/rig/Skeleton';
import { drawWeapon } from '@/render/rig/CharacterRig';
import { drawBackdrop, drawForeground } from '@/game/Backdrop';
import { capsule, ellipse, poly, roundRect, shadow, star } from '@/render/Shapes';
import { clamp, easeOut, easeOutBack } from '@/core/math';
import {
  DEFAULT_CHIP,
  GRAVITY,
  GROUND_Y,
  STARTING_LIVES,
  VIEW_W,
  Z_HIT_TOLERANCE,
  Z_SCALE,
} from '@/core/constants';

type C2D = CanvasRenderingContext2D;

const INK = '#141019';

/** Enemies stream in a few at a time, like a corridor of bad decisions. */
const SPAWN_INTERVAL = 34;
const BASE_CONCURRENT = 3;
/** Frames a corpse lies there before it is swept off the roster. */
const CORPSE_FRAMES = 140;
/** Frames the "GO ->" arrow stays up after a wave is cleared. */
const GO_FRAMES = 150;
const BOSS_CARD_FRAMES = 190;
/** Frames between the boss dying and the level being declared over. */
const OUTRO_FRAMES = 110;
const PICKUP_LIFE = 1500;
const PICKUP_REACH_X = 15;
const PICKUP_REACH_Z = 13;
/** How far in front of a swing a prop can be and still get wrecked. */
const PROP_REACH_X = 40;
const PROP_REACH_Z = 24;
const RESPAWN_FRAMES = 90;

const PROJ_KIND_BULLET = 0;
const PROJ_KIND_BOLT = 1;
const PROJ_KIND_LOB = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Enemy construction data that does not live on EnemyDef
// ─────────────────────────────────────────────────────────────────────────────

const ENEMY_VOICES: Record<EnemyKind, VoiceProfile> = {
  suit_guard: { pitch: 118, timbre: 'gruff', wobble: 0.1 },
  taser_guard: { pitch: 132, timbre: 'nasal', wobble: 0.14 },
  gunman: { pitch: 104, timbre: 'deep', wobble: 0.08 },
  riot_guard: { pitch: 92, timbre: 'deep', wobble: 0.06 },
  security_bot: { pitch: 210, timbre: 'squeak', wobble: 0.3 },
  vacuum_bot: { pitch: 240, timbre: 'squeak', wobble: 0.42 },
  iot_fridge: { pitch: 78, timbre: 'wheeze', wobble: 0.2 },
  iot_speaker: { pitch: 196, timbre: 'nasal', wobble: 0.35 },
  delivery_drone: { pitch: 268, timbre: 'squeak', wobble: 0.26 },
  intern: { pitch: 168, timbre: 'nasal', wobble: 0.18 },
  lobbyist: { pitch: 126, timbre: 'wheeze', wobble: 0.12 },
};

const SQUAT_ENEMIES: ReadonlySet<EnemyKind> = new Set<EnemyKind>([
  'security_bot',
  'vacuum_bot',
  'iot_fridge',
  'iot_speaker',
  'delivery_drone',
]);

function moveSet(light: string, heavy: string | undefined, ranged: string | undefined): Record<string, string> {
  const h = heavy ?? light;
  const r = ranged ?? h;
  return {
    light,
    heavy: h,
    special: r,
    ranged: r,
    airLight: light,
    airHeavy: h,
    grab: light,
    dashAttack: h,
  };
}

/** A property may be exposed through a getter with no setter; check first. */
function writable(obj: object, key: string): boolean {
  let o: object | null = obj;
  while (o) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return d.writable === true || typeof d.set === 'function';
    o = Object.getPrototypeOf(o) as object | null;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entities the Level owns outright
// ─────────────────────────────────────────────────────────────────────────────

interface Unit {
  f: Fighter;
  ai: EnemyAI;
  def: EnemyDef | null;
  /** Wave this unit belongs to; -1 for boss adds and script spawns. */
  wave: number;
  prev: number;
  dead: boolean;
  corpse: number;
}

interface Prop {
  kind: PropSpawn['kind'];
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  drop: PropSpawn['drop'];
  flash: number;
  wobble: number;
  broken: boolean;
  seed: number;
}

interface Pickup {
  kind: 'weapon' | 'health' | 'meter';
  weapon: WeaponKind | null;
  amount: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  life: number;
  spin: number;
}

interface Projectile {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  kind: number;
  team: Team;
  owner: Fighter | null;
  damage: number;
  life: number;
  color: string;
}

interface DrawItem {
  z: number;
  type: number;
  i: number;
}

const D_PROP = 0;
const D_PICKUP = 1;
const D_FIGHTER = 2;
const D_PROJ = 3;

// ─────────────────────────────────────────────────────────────────────────────

export class Level {
  readonly fighters: Fighter[] = [];

  private readonly def: MapDef;
  private readonly players: Fighter[];
  private readonly fx: FxBus;
  private readonly audio: AudioBus;
  private readonly cam: Camera;
  private readonly rng: Rng;

  private readonly units: Unit[] = [];
  private readonly props: Prop[] = [];
  private readonly pickups: Pickup[] = [];
  private readonly projectiles: Projectile[] = [];

  private readonly lives = new Map<number, number>();
  private readonly respawn = new Map<number, number>();
  private readonly playerDead = new Map<number, boolean>();
  private readonly propSwing = new Map<number, number>();

  private readonly drawItems: DrawItem[] = [];
  /** Reused so following the party does not allocate every frame. */
  private readonly camTargets: { x: number; facing: Facing }[] = [];

  /** Queue of enemies waiting off-camera for their turn to walk on. */
  private readonly queue: { kind: EnemyKind; wave: number }[] = [];
  private spawnTimer = 0;

  private tick = 0;
  private nextId = 100;

  private waveIndex = 0;
  private gated = false;
  private gateCenter = 0;
  private goTimer = 0;

  private bossDef: BossDef | null = null;
  private boss: Unit | null = null;
  private bossMoves: Record<string, string> = {};
  private bossTuning: AiTuning | null = null;
  private phase = 0;
  private cardTimer = 0;
  private outro = 0;

  private _complete = false;
  private _failed = false;
  private _score = 0;

  constructor(
    def: MapDef,
    players: Fighter[],
    deps: { fx: FxBus; audio: AudioBus; cam: Camera; rng: Rng },
  ) {
    this.def = def;
    this.players = players;
    this.fx = deps.fx;
    this.audio = deps.audio;
    this.cam = deps.cam;
    this.rng = deps.rng;

    for (const p of players) {
      this.lives.set(p.id, STARTING_LIVES);
      this.playerDead.set(p.id, false);
      this.respawn.set(p.id, 0);
      if (p.id >= this.nextId) this.nextId = p.id + 1;
    }

    for (const s of def.props ?? []) {
      this.props.push({
        kind: s.kind,
        x: s.x,
        z: clamp(s.z, 2, def.depth - 2),
        hp: s.health,
        maxHp: Math.max(1, s.health),
        drop: s.drop,
        flash: 0,
        wobble: 0,
        broken: false,
        seed: (s.x * 7919 + s.z * 104729) | 0,
      });
    }

    this.bossDef = def.boss ? (BOSSES.find((b) => b.id === def.boss) ?? null) : null;
    this.rebuildRoster();
    this.audio.music(def.music);
  }

  get complete(): boolean {
    return this._complete;
  }

  get failed(): boolean {
    return this._failed;
  }

  get bossActive(): boolean {
    return this.boss !== null && this.boss.f.alive;
  }

  /** Waves cleared so far, for the HUD's progress pips. */
  get waveProgress(): number {
    return this.waveIndex;
  }

  get waveTotal(): number {
    return this.def.waves.length;
  }

  get score(): number {
    return this._score;
  }

  /** Lives left for a player slot; the HUD draws these as little heads. */
  livesFor(id: number): number {
    return this.lives.get(id) ?? 0;
  }

  // ── simulation ─────────────────────────────────────────────────────────────

  update(ctx: SimContext): void {
    this.tick++;

    this.updatePlayerLives();

    if (!this._failed) {
      this.updateGates(ctx);
      this.drainQueue();
    }

    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      this.stepUnit(u, ctx);
      if (u.dead && ++u.corpse > CORPSE_FRAMES) {
        this.units.splice(i, 1);
        this.rebuildRoster();
      }
    }

    if (this.boss) this.updateBoss(ctx);

    this.updateProps(ctx);
    this.updatePickups();
    this.updateProjectiles(ctx);

    if (this.goTimer > 0) this.goTimer--;
    if (this.cardTimer > 0) this.cardTimer--;
    if (this.outro > 0 && --this.outro === 0) this._complete = true;

    this.followCamera();
  }

  /**
   * Entity spawn requests routed from `SimContext.spawn`. Bind it straight
   * through when building the context: `spawn: (k, x, y, z, d) => level.spawn(...)`.
   */
  spawn(kind: string, x: number, y: number, z: number, data?: unknown): void {
    const d = (data ?? {}) as Record<string, unknown>;
    const zz = clamp(z, 0, this.def.depth);

    switch (kind) {
      case 'projectile':
      case 'bullet':
      case 'bolt': {
        const owner = this.fighterById(numberOf(d.ownerId ?? d.owner, -1));
        const facing = numberOf(d.facing, owner ? owner.facing : 1) >= 0 ? 1 : -1;
        const speed = numberOf(d.speed, kind === 'bolt' ? 6 : 8.5);
        this.projectiles.push({
          x,
          y,
          z: zz,
          vx: numberOf(d.vx, speed * facing),
          vy: numberOf(d.vy, 0),
          kind: kind === 'bolt' ? PROJ_KIND_BOLT : numberOf(d.vy, 0) > 0 ? PROJ_KIND_LOB : PROJ_KIND_BULLET,
          team: owner ? owner.team : ((d.team as Team) ?? 'enemy'),
          owner,
          damage: numberOf(d.damage, 8),
          life: numberOf(d.life, 120),
          color: typeof d.color === 'string' ? d.color : kind === 'bolt' ? '#8fe3ff' : '#ffe08a',
        });
        this.audio.play(kind === 'bolt' ? 'taser' : 'gunshot', { pan: this.pan(x) });
        break;
      }
      case 'weapon': {
        const w = weaponOf(d.kind ?? d.weapon);
        if (w) this.dropWeapon(w, x, y, zz, numberOf(d.vy, 3));
        break;
      }
      case 'health':
        this.dropHealth(x, y, zz, numberOf(d.amount ?? d.health, 25));
        break;
      case 'meter':
        this.dropMeter(x, y, zz, numberOf(d.amount, 0.5));
        break;
      case 'enemy':
      case 'add': {
        const k = d.kind;
        if (typeof k === 'string' && k in ENEMIES) {
          this.spawnEnemy(k as EnemyKind, -1, x, zz);
        }
        break;
      }
      default:
        break;
    }
  }

  // ── waves & gates ──────────────────────────────────────────────────────────

  private updateGates(ctx: SimContext): void {
    const def = this.def;
    const lead = this.leadX();

    if (this.gated) {
      if (this.boss) return;
      if (this.queue.length > 0) return;
      if (this.waveAlive(this.waveIndex)) return;
      this.clearWave();
      return;
    }

    if (this.waveIndex < def.waves.length) {
      if (lead >= this.triggerX(this.waveIndex)) this.startWave();
      return;
    }

    if (this.bossDef && !this.boss) {
      if (lead >= def.width - VIEW_W * 0.55) this.startBoss(ctx);
      return;
    }

    if (!this.bossDef && !this._complete && this.outro === 0 && lead >= def.width - 46) {
      this.outro = 30;
    }
  }

  private triggerX(index: number): number {
    const w = this.def.waves[index];
    const at = clamp(w ? w.at : 1, 0, 1);
    return clamp(this.def.width * at, VIEW_W * 0.5, this.def.width - VIEW_W * 0.5);
  }

  private startWave(): void {
    const wave = this.def.waves[this.waveIndex];
    this.gated = true;
    this.gateCenter = this.triggerX(this.waveIndex);
    this.goTimer = 0;

    for (const group of wave.enemies) {
      for (let i = 0; i < group.count; i++) this.queue.push({ kind: group.kind, wave: this.waveIndex });
    }
    this.spawnTimer = 0;

    this.fx.shake({ magnitude: 2.4, duration: 12 });
    this.audio.play('ui_error', { pitch: 0.7 });
    this.audio.music(this.waveIndex >= this.def.waves.length - 1 ? 'fight_high' : this.def.music);
  }

  private clearWave(): void {
    const wave = this.def.waves[this.waveIndex];
    this.gated = false;
    this.waveIndex++;
    this.goTimer = GO_FRAMES;

    const reward = wave?.reward;
    if (reward) {
      const x = clamp(this.leadX() + 40, 30, this.def.width - 30);
      const z = this.def.depth * 0.5;
      if (reward.weapon) this.dropWeapon(reward.weapon, x, 26, z, 3.4);
      if (reward.health) this.dropHealth(x + 18, 26, z + 8, reward.health);
      if (reward.meter) this.dropMeter(x - 18, 26, z - 8, reward.meter);
    }

    this.fx.text({
      text: 'CLEAR',
      x: this.cam.x + VIEW_W * 0.5,
      y: 84,
      z: this.def.depth * 0.5,
      color: '#ffe14a',
      size: 22,
      life: 70,
      rise: 0.35,
      style: 'bonus',
    });
    this.audio.play('coin');
  }

  private waveAlive(index: number): boolean {
    for (const u of this.units) {
      if (u.wave === index && !u.dead) return true;
    }
    return false;
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return;
    if (this.spawnTimer > 0) {
      this.spawnTimer--;
      return;
    }
    const cap = BASE_CONCURRENT + this.players.length;
    let live = 0;
    for (const u of this.units) if (!u.dead) live++;
    if (live >= cap) return;

    const next = this.queue.shift();
    if (!next) return;
    this.spawnTimer = SPAWN_INTERVAL;
    const at = this.pickSpawnPos();
    this.spawnEnemy(next.kind, next.wave, at.x, at.z);
  }

  /** Just off the visible edge, on a plane no player is standing on. */
  private pickSpawnPos(): { x: number; z: number } {
    const camX = this.cam.x;
    let side = this.rng.chance(0.5) ? 1 : -1;
    // Never walk them on through a wall.
    if (camX <= 4) side = 1;
    else if (camX >= this.def.width - VIEW_W - 4) side = -1;

    for (let attempt = 0; attempt < 4; attempt++) {
      const x = side > 0 ? camX + VIEW_W + 22 + attempt * 14 : camX - 22 - attempt * 14;
      const z = this.rng.range(6, Math.max(8, this.def.depth - 6));
      let ok = true;
      for (const p of this.players) {
        if (!p.alive) continue;
        if (Math.abs(p.pos.x - x) < 64 && Math.abs(p.pos.z - z) < 26) {
          ok = false;
          break;
        }
      }
      if (ok) return { x: clamp(x, 6, this.def.width - 6), z };
      side = -side as 1 | -1;
    }
    return {
      x: clamp(camX + VIEW_W + 30, 6, this.def.width - 6),
      z: this.rng.range(6, Math.max(8, this.def.depth - 6)),
    };
  }

  private spawnEnemy(kind: EnemyKind, wave: number, x: number, z: number): Unit | null {
    const def = ENEMIES[kind];
    if (!def) return null;

    const init: FighterInit = {
      id: this.nextId++,
      team: 'enemy',
      x: clamp(x, 4, this.def.width - 4),
      z: clamp(z, 1, this.def.depth - 1),
      style: def.style,
      skeleton: SQUAT_ENEMIES.has(kind) ? DWARF_SKELETON : HUMAN_SKELETON,
      health: def.health,
      speed: def.speed,
      power: def.power,
      moves: moveSet(def.moves.light, def.moves.heavy, def.moves.ranged),
      voice: ENEMY_VOICES[kind],
      archetype: kind,
    };

    const f = new Fighter(init);
    if (def.weapon) f.giveWeapon(def.weapon);

    const tuning: AiTuning = {
      reactionFrames: def.ai.reactionFrames,
      blockSkill: def.ai.blockSkill,
      comboSkill: def.ai.comboSkill,
      swarm: def.ai.swarm,
      behaviour: def.ai.behaviour,
      spacing: def.spacing,
      aggression: def.aggression,
      seed: this.rng.int(0, 0xffff),
    };

    const unit: Unit = {
      f,
      ai: new EnemyAI(f, tuning, () => this.fighters),
      def,
      wave,
      prev: 0,
      dead: false,
      corpse: 0,
    };
    this.units.push(unit);
    this.rebuildRoster();
    return unit;
  }

  private stepUnit(u: Unit, ctx: SimContext): void {
    const held = u.ai.sample(ctx.frame);
    const input: InputFrame = { held, pressed: held & ~u.prev, released: u.prev & ~held };
    u.prev = held;
    u.f.update(input, ctx);

    if (!u.dead && !u.f.alive) {
      u.dead = true;
      this.onUnitDeath(u);
    }
  }

  private onUnitDeath(u: Unit): void {
    const def = u.def;
    const p = u.f.pos;
    this._score += def ? def.points : 500;

    this.fx.particles({
      count: 14,
      x: p.x,
      y: 18,
      z: p.z,
      angle: Math.PI * 0.5,
      spread: Math.PI * 1.4,
      speed: [1.4, 4.6],
      life: [18, 40],
      size: [1, 2.6],
      colors: ['#ffe14a', '#ff8a3d', '#ffffff'],
      gravity: 0.24,
      drag: 0.97,
      shape: 'spark',
      additive: true,
    });
    this.fx.text({
      text: `${def ? def.points : 500}`,
      x: p.x,
      y: 34,
      z: p.z,
      color: '#ffe14a',
      size: 9,
      life: 46,
      rise: 0.5,
      style: 'bonus',
    });

    if (def?.weapon && this.rng.chance(0.5)) {
      this.dropWeapon(def.weapon, p.x, 14, p.z, 2.6);
    } else if (this.rng.chance(0.12)) {
      this.dropHealth(p.x, 14, p.z, 22);
    }
  }

  // ── boss ───────────────────────────────────────────────────────────────────

  private startBoss(ctx: SimContext): void {
    const bd = this.bossDef;
    if (!bd) return;

    this.gated = true;
    this.gateCenter = this.def.width - VIEW_W * 0.5;
    this.phase = 0;

    const first = bd.phases[0];
    this.bossMoves = moveSet(first?.moves[0] ?? 'punch1', first?.moves[1], first?.moves[2]);

    const init: FighterInit = {
      id: this.nextId++,
      team: 'enemy',
      x: clamp(this.def.width - 70, 10, this.def.width - 10),
      z: this.def.depth * 0.5,
      style: bd.style,
      skeleton: bd.rigOverride === 'shiba' ? DWARF_SKELETON : HUMAN_SKELETON,
      health: bd.health,
      speed: 1.05,
      power: 1.35,
      moves: this.bossMoves,
      voice: { pitch: 96, timbre: 'gruff', wobble: 0.09 },
      archetype: bd.id,
      isBoss: true,
    };

    const f = new Fighter(init);
    this.bossTuning = {
      reactionFrames: 13,
      blockSkill: 0.34,
      comboSkill: 0.62,
      swarm: 1,
      behaviour: 'rusher',
      spacing: 44,
      aggression: first?.aggression ?? 0.7,
      seed: this.rng.int(0, 0xffff),
    };

    this.boss = {
      f,
      ai: new EnemyAI(f, this.bossTuning, () => this.fighters),
      def: null,
      wave: -1,
      prev: 0,
      dead: false,
      corpse: 0,
    };
    this.units.push(this.boss);
    this.rebuildRoster();

    this.cardTimer = BOSS_CARD_FRAMES;
    this.audio.music(bd.music);
    this.audio.play('super_charge');
    this.fx.flash('#ffffff', 8, 0.5);
    this.fx.shake({ magnitude: 6, duration: 30 });
    ctx.requestHitstop(14);
  }

  private updateBoss(ctx: SimContext): void {
    const bd = this.bossDef;
    const boss = this.boss;
    if (!bd || !boss) return;

    if (boss.dead) {
      if (this.outro === 0 && !this._complete) {
        this.outro = OUTRO_FRAMES;
        this.gated = false;
        this.audio.music('victory');
        this.fx.slowmo(0.25, 70);
        this.fx.flash('#ffffff', 12, 0.75);
        this.fx.shake({ magnitude: 10, duration: 40 });
        this.fx.text({
          text: `${bd.name.toUpperCase()} DOWN`,
          x: boss.f.pos.x,
          y: 90,
          z: boss.f.pos.z,
          color: '#ff4d6d',
          size: 20,
          life: 110,
          rise: 0.2,
          style: 'critical',
        });
        this._score += bd.points;
      }
      return;
    }

    const frac = boss.f.maxHealth > 0 ? boss.f.health / boss.f.maxHealth : 0;
    while (this.phase + 1 < bd.phases.length && frac <= bd.phases[this.phase + 1].healthThreshold) {
      this.phase++;
      this.enterPhase(bd, bd.phases[this.phase], ctx);
    }
  }

  private enterPhase(bd: BossDef, ph: BossPhase, ctx: SimContext): void {
    const boss = this.boss;
    if (!boss) return;

    // Swap the pool in place: the Fighter holds this same record.
    const next = moveSet(ph.moves[0] ?? this.bossMoves.light, ph.moves[1], ph.moves[2]);
    for (const key of Object.keys(next)) this.bossMoves[key] = next[key];

    if (this.bossTuning) {
      this.bossTuning.aggression = ph.aggression;
      this.bossTuning.reactionFrames = Math.max(5, Math.round(13 - ph.aggression * 6));
      this.bossTuning.behaviour = ph.aggression > 0.75 ? 'rusher' : ph.aggression > 0.45 ? 'spacer' : 'turtle';
    }

    for (const add of ph.spawns ?? []) {
      for (let i = 0; i < add.count; i++) this.queue.push({ kind: add.kind, wave: -1 });
    }

    const p = boss.f.pos;
    ctx.requestHitstop(16);
    this.fx.slowmo(0.32, 44);
    this.fx.flash('#ff2d55', 10, 0.6);
    this.fx.shake({ magnitude: 9, duration: 30 });
    this.fx.aberration(0.55, 22);
    this.fx.shockwave(p.x, 24, p.z, 70, 26);
    this.fx.particles({
      count: 26,
      x: p.x,
      y: 20,
      z: p.z,
      angle: Math.PI * 0.5,
      spread: Math.PI * 2,
      speed: [2, 6.5],
      life: [20, 46],
      size: [1.2, 3],
      colors: ['#ff2d55', '#ffe14a', '#ffffff'],
      gravity: 0.18,
      drag: 0.96,
      shape: 'spark',
      additive: true,
    });
    if (ph.bark) {
      this.fx.text({
        text: ph.bark,
        x: p.x,
        y: 76,
        z: p.z,
        color: '#ffffff',
        size: 12,
        life: 110,
        rise: 0.16,
        style: 'taunt',
      });
    }
    this.audio.play('super_charge', { pitch: 1.2 });
    this.audio.music(this.phase >= bd.phases.length - 1 ? 'final_boss' : bd.music);
  }

  // ── players ────────────────────────────────────────────────────────────────

  private updatePlayerLives(): void {
    let anyAlive = false;
    let anyLives = false;

    for (const p of this.players) {
      const wasDead = this.playerDead.get(p.id) === true;
      if (p.alive) {
        anyAlive = true;
        if (wasDead) this.playerDead.set(p.id, false);
      } else if (!wasDead) {
        this.playerDead.set(p.id, true);
        const left = (this.lives.get(p.id) ?? 0) - 1;
        this.lives.set(p.id, Math.max(0, left));
        this.respawn.set(p.id, left > 0 ? RESPAWN_FRAMES : 0);
        this.audio.play('ko');
        this.fx.text({
          text: left > 0 ? `${left} LEFT` : 'GAME OVER',
          x: p.pos.x,
          y: 70,
          z: p.pos.z,
          color: '#ff4d6d',
          size: 12,
          life: 80,
          rise: 0.3,
          style: 'critical',
        });
      }

      const wait = this.respawn.get(p.id) ?? 0;
      if (wait > 0) {
        const next = wait - 1;
        this.respawn.set(p.id, next);
        if (next === 0) this.revive(p);
      }
      if ((this.lives.get(p.id) ?? 0) > 0) anyLives = true;
    }

    if (!anyAlive && !anyLives) this._failed = true;
  }

  /**
   * Put a player back on their feet. The Fighter API has no documented revive,
   * so we use one if it exists and otherwise refill health directly; if neither
   * is possible the remaining lives are forfeit rather than leaving the level
   * unwinnable and unloseable.
   */
  private revive(p: Fighter): void {
    const x = clamp(this.cam.x + VIEW_W * 0.35, 12, this.def.width - 12);
    const z = this.def.depth * 0.55;
    const hook = p as unknown as { respawn?: (x: number, z: number) => void };

    if (typeof hook.respawn === 'function') {
      hook.respawn(x, z);
    } else if (writable(p, 'health')) {
      (p as unknown as { health: number }).health = p.maxHealth;
      p.pos.x = x;
      p.pos.z = z;
      p.pos.y = 0;
    } else {
      this.lives.set(p.id, 0);
      return;
    }

    this.playerDead.set(p.id, false);
    this.fx.flash('#ffffff', 6, 0.3);
    this.fx.shockwave(x, 20, z, 40, 20);
    this.audio.play('coin', { pitch: 1.4 });
  }

  private leadX(): number {
    let lead = -Infinity;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.pos.x > lead) lead = p.pos.x;
    }
    return lead === -Infinity ? this.cam.x + VIEW_W * 0.5 : lead;
  }

  private followCamera(): void {
    const limit = this.gated
      ? Math.min(this.def.width, this.gateCenter + VIEW_W * 0.5)
      : this.def.width;

    this.camTargets.length = 0;
    for (const p of this.players) {
      if (p.alive) this.camTargets.push({ x: p.pos.x, facing: p.facing });
    }
    if (this.camTargets.length === 0) {
      for (const p of this.players) this.camTargets.push({ x: p.pos.x, facing: p.facing });
    }
    this.cam.follow(this.camTargets, limit);

    // The gate is only real if the players cannot stroll through it.
    const left = this.cam.x + 10;
    const right = this.cam.x + VIEW_W - 10;
    for (const p of this.players) {
      const min = this.gated ? left : 6;
      const max = this.gated ? right : this.def.width - 6;
      if (p.pos.x < min) p.pos.x = min;
      else if (p.pos.x > max) p.pos.x = max;
    }
    for (const u of this.units) {
      if (u.dead) continue;
      const p = u.f.pos;
      if (p.x < 2) p.x = 2;
      else if (p.x > this.def.width - 2) p.x = this.def.width - 2;
    }
  }

  // ── props, pickups, projectiles ─────────────────────────────────────────────

  private updateProps(ctx: SimContext): void {
    for (const pr of this.props) {
      if (pr.flash > 0) pr.flash--;
      if (pr.wobble !== 0) pr.wobble *= 0.86;
    }

    for (const f of this.players) {
      if (!f.alive || f.state !== 'attack') continue;
      if (f.stateFrame < 3 || f.stateFrame > 14) continue;
      const tag = ctx.frame - f.stateFrame;
      if (this.propSwing.get(f.id) === tag) continue;

      for (const pr of this.props) {
        if (pr.broken) continue;
        const dx = (pr.x - f.pos.x) * f.facing;
        if (dx < -14 || dx > PROP_REACH_X) continue;
        if (Math.abs(pr.z - f.pos.z) > PROP_REACH_Z) continue;
        this.propSwing.set(f.id, tag);
        this.damageProp(pr, f.weapon ? 22 : 13);
        break;
      }
    }
  }

  private damageProp(pr: Prop, amount: number): void {
    pr.hp -= amount;
    pr.flash = 5;
    pr.wobble = 3.2;
    const y = 16;

    if (pr.hp > 0) {
      this.audio.play(pr.kind === 'vending' || pr.kind === 'sign' ? 'glass' : 'hit_metal', {
        pan: this.pan(pr.x),
      });
      this.fx.particles({
        count: 6,
        x: pr.x,
        y,
        z: pr.z,
        angle: Math.PI * 0.55,
        spread: 1.6,
        speed: [1, 3.2],
        life: [12, 26],
        size: [0.8, 2],
        colors: ['#c9c4d6', '#8f8aa0'],
        gravity: 0.32,
        drag: 0.97,
        shape: 'shard',
      });
      return;
    }

    pr.broken = true;
    this.fx.shake({ magnitude: 4.5, duration: 16 });
    this.fx.particles({
      count: 22,
      x: pr.x,
      y,
      z: pr.z,
      angle: Math.PI * 0.5,
      spread: Math.PI * 1.7,
      speed: [1.6, 5.4],
      life: [18, 44],
      size: [1, 3.2],
      colors: propColors(pr.kind),
      gravity: 0.36,
      drag: 0.97,
      shape: 'shard',
      spin: 0.24,
    });
    this.audio.play(pr.kind === 'barrel' ? 'explosion' : pr.kind === 'vending' ? 'glass' : 'hit_metal', {
      pan: this.pan(pr.x),
    });
    if (pr.kind === 'barrel') this.fx.shockwave(pr.x, 12, pr.z, 46, 20);

    if (pr.drop?.weapon) this.dropWeapon(pr.drop.weapon, pr.x, 18, pr.z, 3.2);
    if (pr.drop?.health) this.dropHealth(pr.x + 8, 18, pr.z, pr.drop.health);
    this._score += 50;
  }

  private dropWeapon(kind: WeaponKind, x: number, y: number, z: number, vy: number): void {
    this.pickups.push({
      kind: 'weapon',
      weapon: kind,
      amount: 0,
      x,
      y,
      z: clamp(z, 0, this.def.depth),
      vy,
      life: PICKUP_LIFE,
      spin: 0,
    });
    this.audio.play('drop', { pan: this.pan(x) });
  }

  private dropHealth(x: number, y: number, z: number, amount: number): void {
    this.pickups.push({
      kind: 'health',
      weapon: null,
      amount,
      x,
      y,
      z: clamp(z, 0, this.def.depth),
      vy: 3,
      life: PICKUP_LIFE,
      spin: 0,
    });
  }

  private dropMeter(x: number, y: number, z: number, amount: number): void {
    this.pickups.push({
      kind: 'meter',
      weapon: null,
      amount,
      x,
      y,
      z: clamp(z, 0, this.def.depth),
      vy: 3,
      life: PICKUP_LIFE,
      spin: 0,
    });
  }

  private updatePickups(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const it = this.pickups[i];
      if (it.y > 0 || it.vy !== 0) {
        it.vy -= GRAVITY * 0.6;
        it.y += it.vy;
        it.spin += 0.16;
        if (it.y <= 0) {
          it.y = 0;
          it.vy = it.vy < -1.4 ? -it.vy * 0.32 : 0;
          if (it.vy === 0) it.spin = 0;
        }
      }
      if (--it.life <= 0) {
        this.pickups.splice(i, 1);
        continue;
      }
      if (it.y > 2) continue;

      for (const p of this.players) {
        if (!p.alive || !p.grounded) continue;
        if (Math.abs(p.pos.x - it.x) > PICKUP_REACH_X) continue;
        if (Math.abs(p.pos.z - it.z) > PICKUP_REACH_Z) continue;
        if (it.kind === 'weapon' && p.weapon) continue;
        this.collect(it, p);
        this.pickups.splice(i, 1);
        break;
      }
    }
  }

  private collect(it: Pickup, p: Fighter): void {
    if (it.kind === 'weapon' && it.weapon) {
      p.giveWeapon(it.weapon);
      this.fx.text({
        text: WEAPONS[it.weapon]?.name.toUpperCase() ?? 'WEAPON',
        x: p.pos.x,
        y: 60,
        z: p.pos.z,
        color: '#8fe3ff',
        size: 9,
        life: 46,
        rise: 0.4,
        style: 'bonus',
      });
    } else if (it.kind === 'health') {
      this.heal(p, it.amount);
      this.fx.text({
        text: `+${Math.round(it.amount)}`,
        x: p.pos.x,
        y: 60,
        z: p.pos.z,
        color: '#63ff9d',
        size: 10,
        life: 46,
        rise: 0.45,
        style: 'bonus',
      });
    } else {
      p.addMeter(it.amount);
      this.fx.text({
        text: 'METER',
        x: p.pos.x,
        y: 60,
        z: p.pos.z,
        color: '#ffe14a',
        size: 9,
        life: 46,
        rise: 0.45,
        style: 'bonus',
      });
    }
    this.audio.play('pickup', { pan: this.pan(p.pos.x) });
    this.fx.particles({
      count: 8,
      x: p.pos.x,
      y: 14,
      z: p.pos.z,
      angle: Math.PI * 0.5,
      spread: 1.2,
      speed: [1, 2.6],
      life: [14, 26],
      size: [1, 2],
      colors: ['#ffffff', '#63ff9d'],
      gravity: 0.1,
      drag: 0.94,
      shape: 'star',
      additive: true,
    });
  }

  private heal(p: Fighter, amount: number): void {
    const hook = p as unknown as { heal?: (n: number) => void };
    if (typeof hook.heal === 'function') {
      hook.heal(amount);
      return;
    }
    if (writable(p, 'health')) {
      const h = p as unknown as { health: number };
      h.health = Math.min(p.maxHealth, p.health + amount);
      return;
    }
    // Nowhere to put the health: give it back as meter rather than nothing.
    p.addMeter(clamp(amount / 100, 0, 1));
  }

  private updateProjectiles(ctx: SimContext): void {
    const camL = this.cam.x - 90;
    const camR = this.cam.x + VIEW_W + 90;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pj = this.projectiles[i];
      pj.x += pj.vx;
      pj.y += pj.vy;
      if (pj.kind === PROJ_KIND_LOB) pj.vy -= GRAVITY * 0.5;

      let done = --pj.life <= 0 || pj.x < camL || pj.x > camR || pj.y < -4;

      if (!done) {
        for (const f of this.fighters) {
          if (!f.alive || f.team === pj.team) continue;
          if (Math.abs(f.pos.x - pj.x) > 12) continue;
          if (Math.abs(f.pos.z - pj.z) > Z_HIT_TOLERANCE) continue;
          if (pj.y > 46) continue;
          const owner = pj.owner ?? f;
          f.takeHit(projectileHit(pj), pj.x, ctx, owner);
          this.fx.particles({
            count: 7,
            x: pj.x,
            y: pj.y + 24,
            z: pj.z,
            angle: pj.vx > 0 ? Math.PI : 0,
            spread: 1.5,
            speed: [1.2, 3.4],
            life: [10, 22],
            size: [0.8, 1.8],
            colors: [pj.color, '#ffffff'],
            gravity: 0.2,
            drag: 0.94,
            shape: 'spark',
            additive: true,
          });
          done = true;
          break;
        }
      }

      if (done) this.projectiles.splice(i, 1);
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  renderBackground(ctx: C2D, cam: Camera): void {
    screenSpace(ctx, () => drawBackdrop(ctx, this.def, cam, this.tick));
  }

  render(ctx: C2D, cam: Camera, alpha: number): void {
    const items = this.collectDrawItems();

    for (const it of items) {
      switch (it.type) {
        case D_PROP:
          this.drawProp(ctx, this.props[it.i]);
          break;
        case D_PICKUP:
          this.drawPickup(ctx, this.pickups[it.i]);
          break;
        case D_FIGHTER:
          this.fighters[it.i].render(ctx, cam, alpha);
          break;
        case D_PROJ:
          this.drawProjectile(ctx, this.projectiles[it.i]);
          break;
        default:
          break;
      }
    }

    screenSpace(ctx, () => {
      drawForeground(ctx, this.def, cam, this.tick);
      this.drawGoArrow(ctx);
      this.drawBossCard(ctx);
    });
  }

  /** Back to front: higher z is further away, so it is painted first. */
  private collectDrawItems(): DrawItem[] {
    let n = 0;
    const push = (z: number, type: number, i: number): void => {
      const slot = this.drawItems[n];
      if (slot) {
        slot.z = z;
        slot.type = type;
        slot.i = i;
      } else {
        this.drawItems.push({ z, type, i });
      }
      n++;
    };

    for (let i = 0; i < this.props.length; i++) {
      const pr = this.props[i];
      if (pr.broken) continue;
      push(pr.z, D_PROP, i);
    }
    for (let i = 0; i < this.pickups.length; i++) push(this.pickups[i].z, D_PICKUP, i);
    for (let i = 0; i < this.fighters.length; i++) push(this.fighters[i].pos.z, D_FIGHTER, i);
    for (let i = 0; i < this.projectiles.length; i++) push(this.projectiles[i].z, D_PROJ, i);

    const items = this.drawItems.slice(0, n);
    items.sort((a, b) => b.z - a.z);
    return items;
  }

  private drawProp(ctx: C2D, pr: Prop): void {
    const sx = pr.x + Math.sin(this.tick * 0.9) * pr.wobble;
    const sy = GROUND_Y + pr.z * Z_SCALE;
    const hurt = pr.hp / pr.maxHp;
    const body = pr.flash > 0 ? '#ffffff' : null;

    shadow(ctx, sx, sy, 12, 0.3);

    switch (pr.kind) {
      case 'barrel': {
        roundRect(ctx, sx - 10, sy - 34, 20, 34, 5, body ?? '#b8452f', INK, 1.8);
        roundRect(ctx, sx - 11, sy - 27, 22, 4, 2, body ?? '#8d3324', 'none', 0);
        roundRect(ctx, sx - 11, sy - 14, 22, 4, 2, body ?? '#8d3324', 'none', 0);
        if (!body) {
          ctx.fillStyle = '#f5d14a';
          ctx.font = '800 6px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('FLAM', sx, sy - 19);
        }
        break;
      }
      case 'crate': {
        roundRect(ctx, sx - 12, sy - 24, 24, 24, 2, body ?? '#9a6b3a', INK, 1.8);
        ctx.strokeStyle = body ?? '#6f4a25';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx - 11, sy - 23);
        ctx.lineTo(sx + 11, sy - 1);
        ctx.moveTo(sx + 11, sy - 23);
        ctx.lineTo(sx - 11, sy - 1);
        ctx.stroke();
        break;
      }
      case 'vending': {
        roundRect(ctx, sx - 12, sy - 46, 24, 46, 3, body ?? '#2b2f4a', INK, 1.8);
        roundRect(ctx, sx - 9, sy - 42, 14, 30, 2, body ?? '#0f1524', 'none', 0);
        for (let k = 0; k < 6; k++) {
          const on = ((this.tick / 9) | 0) % 7 !== k;
          roundRect(
            ctx,
            sx - 8 + (k % 3) * 5,
            sy - 40 + ((k / 3) | 0) * 8,
            3.4,
            6,
            1,
            body ?? (on ? '#ff4d6d' : '#5a2233'),
            'none',
            0,
          );
        }
        roundRect(ctx, sx + 6, sy - 40, 4, 12, 1, body ?? '#8fe3ff', 'none', 0);
        break;
      }
      case 'server_rack': {
        roundRect(ctx, sx - 11, sy - 48, 22, 48, 2, body ?? '#22242e', INK, 1.8);
        for (let k = 0; k < 8; k++) {
          const y = sy - 45 + k * 5.4;
          roundRect(ctx, sx - 9, y, 18, 3.6, 1, body ?? '#33364a', 'none', 0);
          if (!body && ((this.tick / 7 + k * 3) | 0) % 3 !== 0) {
            ctx.fillStyle = k % 3 === 0 ? '#ff5b4a' : '#63ff9d';
            ctx.fillRect(sx - 8, y + 1, 1.8, 1.8);
          }
        }
        break;
      }
      case 'scooter': {
        capsule(ctx, sx - 10, sy - 4, sx + 10, sy - 6, 2, body ?? '#3c4152', INK, 1.6);
        capsule(ctx, sx + 8, sy - 6, sx + 10, sy - 26, 1.8, body ?? '#3c4152', INK, 1.6);
        roundRect(ctx, sx + 4, sy - 30, 12, 3, 1.5, body ?? '#5b6178', INK, 1.4);
        ellipse(ctx, sx - 10, sy - 3, 4, 4, 0, body ?? '#1b1a22', INK, 1.4);
        ellipse(ctx, sx + 10, sy - 3, 4, 4, 0, body ?? '#1b1a22', INK, 1.4);
        break;
      }
      case 'sign':
      default: {
        roundRect(ctx, sx - 1.5, sy - 34, 3, 34, 1, body ?? '#4a4152', INK, 1.4);
        const lit = ((this.tick / 11) | 0) % 9 !== 0;
        roundRect(ctx, sx - 16, sy - 52, 32, 20, 3, body ?? '#1d1b26', INK, 1.8);
        if (!body) {
          ctx.fillStyle = lit ? this.def.palette.accent : '#3a3546';
          ctx.font = '800 8px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('X', sx, sy - 39);
        }
        break;
      }
    }

    if (hurt < 0.5 && !pr.broken) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 6, sy - 26);
      ctx.lineTo(sx - 1, sy - 18);
      ctx.lineTo(sx - 5, sy - 12);
      ctx.stroke();
    }
  }

  private drawPickup(ctx: C2D, it: Pickup): void {
    const sy = GROUND_Y + it.z * Z_SCALE - it.y;
    const gy = GROUND_Y + it.z * Z_SCALE;
    const blink = it.life < 200 && ((it.life / 6) | 0) % 2 === 0;
    if (blink) return;

    shadow(ctx, it.x, gy, 7, 0.28);
    const bob = it.y <= 0 ? Math.sin(this.tick * 0.11) * 1.6 : 0;

    if (it.kind === 'weapon' && it.weapon) {
      const w = WEAPONS[it.weapon];
      if (w) drawWeapon(ctx, w, it.x, sy - 3 + bob, it.y > 0 ? it.spin : -0.35, 1);
      return;
    }

    if (it.kind === 'health') {
      // A roast chicken, because some traditions are sacred.
      const y = sy - 6 + bob;
      ellipse(ctx, it.x, y, 7, 5.4, 0, '#d9a05b', INK, 1.6);
      ellipse(ctx, it.x - 2, y - 2, 3, 2.2, -0.4, '#f0c184', 'none', 0);
      capsule(ctx, it.x + 5, y + 1, it.x + 10, y - 3, 1.4, '#f3e8d2', INK, 1.2);
      return;
    }

    const y = sy - 6 + bob;
    roundRect(ctx, it.x - 4, y - 7, 8, 14, 2, '#2a2b3a', INK, 1.5);
    roundRect(ctx, it.x - 2.4, y - 9, 4.8, 2.4, 1, '#8f8aa0', INK, 1.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(this.tick * 0.2);
    roundRect(ctx, it.x - 2.6, y - 5, 5.2, 10, 1, '#ffe14a', 'none', 0);
    ctx.restore();
  }

  private drawProjectile(ctx: C2D, pj: Projectile): void {
    const sy = GROUND_Y + pj.z * Z_SCALE - pj.y - 24;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ellipse(ctx, pj.x, sy, 7, 4, 0, pj.color, 'none', 0);
    ctx.globalAlpha = 1;
    if (pj.kind === PROJ_KIND_BOLT) {
      star(ctx, pj.x, sy, 5, 4, '#ffffff', 'none');
      ctx.globalAlpha = 0.7;
      star(ctx, pj.x, sy, 8, 4, pj.color, 'none');
    } else {
      const dir = pj.vx >= 0 ? 1 : -1;
      capsule(ctx, pj.x - dir * 7, sy, pj.x, sy, 1.6, pj.color, 'none', 0);
      ellipse(ctx, pj.x, sy, 2.2, 2.2, 0, '#ffffff', 'none', 0);
    }
    ctx.restore();
  }

  private drawGoArrow(ctx: C2D): void {
    if (this.gated || this._complete || this._failed) return;

    const pulse = (this.tick % 46) / 46;
    if (pulse > 0.72) return;
    const x = VIEW_W - 74 + easeOut(pulse / 0.72) * 10;
    const y = 58;

    ctx.save();
    // Brighter for a moment right after a wave falls, then it settles down.
    ctx.globalAlpha = this.goTimer > 0 ? 1 : 0.7;
    ctx.font = '900 20px Impact, "Arial Black", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.strokeText('GO', x, y);
    ctx.fillStyle = '#ffe14a';
    ctx.fillText('GO', x, y);
    for (let k = 0; k < 3; k++) {
      const a = clamp(1 - Math.abs(((this.tick * 0.05 + k * 0.33) % 1) - 0.35) * 2.4, 0, 1);
      ctx.globalAlpha = 0.3 + a * 0.7;
      poly(
        ctx,
        [x + 32 + k * 11, y - 7, x + 41 + k * 11, y, x + 32 + k * 11, y + 7],
        '#ffe14a',
        INK,
        1.6,
      );
    }
    ctx.restore();
  }

  private drawBossCard(ctx: C2D): void {
    if (this.cardTimer <= 0 || !this.bossDef) return;
    const bd = this.bossDef;
    const t = 1 - this.cardTimer / BOSS_CARD_FRAMES;
    const inT = clamp(t / 0.16, 0, 1);
    const outT = clamp((t - 0.86) / 0.14, 0, 1);
    const h = easeOutBack(inT) * 72 * (1 - outT);
    if (h <= 1) return;

    const cy = 118;
    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = '#0d0b12';
    ctx.fillRect(0, cy - h * 0.5, VIEW_W, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ff2d55';
    ctx.fillRect(0, cy - h * 0.5, VIEW_W, 2);
    ctx.fillRect(0, cy + h * 0.5 - 2, VIEW_W, 2);

    // Hazard chevrons crawling along the top rule.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, cy - h * 0.5, VIEW_W, 2);
    ctx.clip();
    for (let i = -1; i < 32; i++) {
      const x = i * 22 + ((this.tick * 0.8) % 22);
      ctx.fillStyle = i % 2 === 0 ? '#ffe14a' : '#ff2d55';
      ctx.fillRect(x, cy - h * 0.5, 11, 2);
    }
    ctx.restore();

    if (h > 30) {
      const a = clamp((h - 30) / 30, 0, 1);
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 26px Impact, "Arial Black", system-ui, sans-serif';
      ctx.lineWidth = 5;
      ctx.strokeStyle = INK;
      ctx.strokeText(bd.name.toUpperCase(), VIEW_W * 0.5, cy - 10);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(bd.name.toUpperCase(), VIEW_W * 0.5, cy - 10);
      ctx.font = 'italic 800 10px "Arial Narrow", system-ui, sans-serif';
      ctx.fillStyle = '#ff8fa6';
      ctx.fillText(`"${bd.quote}"`, VIEW_W * 0.5, cy + 14);
    }
    ctx.restore();
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private rebuildRoster(): void {
    this.fighters.length = 0;
    for (const p of this.players) this.fighters.push(p);
    for (const u of this.units) this.fighters.push(u.f);
  }

  private fighterById(id: number): Fighter | null {
    if (id < 0) return null;
    for (const f of this.fighters) if (f.id === id) return f;
    return null;
  }

  /** Stereo placement from world x, so a shot off-screen left sounds left. */
  private pan(x: number): number {
    return clamp((x - this.cam.x - VIEW_W * 0.5) / (VIEW_W * 0.5), -1, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Free helpers
// ─────────────────────────────────────────────────────────────────────────────

function numberOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function weaponOf(v: unknown): WeaponKind | null {
  if (typeof v === 'string' && v in WEAPONS) return v as WeaponKind;
  return null;
}

function propColors(kind: PropSpawn['kind']): string[] {
  switch (kind) {
    case 'barrel':
      return ['#b8452f', '#f5d14a', '#8d3324'];
    case 'crate':
      return ['#9a6b3a', '#6f4a25', '#c79a63'];
    case 'vending':
      return ['#8fe3ff', '#2b2f4a', '#ffffff'];
    case 'server_rack':
      return ['#33364a', '#63ff9d', '#c9c4d6'];
    case 'scooter':
      return ['#3c4152', '#5b6178', '#c9c4d6'];
    default:
      return ['#4a4152', '#c9c4d6', '#ffe14a'];
  }
}

function projectileHit(pj: Projectile): HitProperties {
  const bolt = pj.kind === PROJ_KIND_BOLT;
  return {
    damage: pj.damage,
    hitstun: bolt ? 30 : 16,
    blockstun: 11,
    hitstop: bolt ? 6 : 4,
    knockback: { x: bolt ? 0.8 : 2.6, y: bolt ? 0 : 0.4 },
    pushback: 0,
    reaction: bolt ? 'stun' : 'light',
    level: 'mid',
    chip: DEFAULT_CHIP,
    meterGain: 0.03,
    meterGainVictim: 0.05,
    shake: bolt ? 3 : 2,
    sfx: bolt ? 'taser' : 'hit_flesh',
  };
}

/**
 * Runs `fn` with the current transform's translation cancelled, so drawing at
 * (0,0) lands at the top-left of the view whether or not the caller wrapped us
 * in the camera transform.
 */
function screenSpace(ctx: C2D, fn: () => void): void {
  const m = ctx.getTransform();
  ctx.save();
  if (m.a !== 0 && m.d !== 0) ctx.translate(-m.e / m.a, -m.f / m.d);
  try {
    fn();
  } finally {
    ctx.restore();
  }
}
