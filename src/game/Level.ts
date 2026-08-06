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
 * FINISHERS — while the fatality director has a kill on stage the map is put on
 * hold: see `beginFatality`. Nothing walks on, nothing shoots, nothing lands,
 * and the two performers are struck from the draw list because the director is
 * drawing them itself.
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
  RigStyle,
  Rng,
  SimContext,
  Team,
  VehicleSection,
  VoiceProfile,
  WeaponKind,
} from '@/core/types';
import type { Camera } from '@/render/Camera';
import { Fighter } from '@/game/Fighter';
import type { FighterInit, RideSeat } from '@/game/Fighter';
import { EnemyAI } from '@/game/ai/EnemyAI';
import type { AiTuning } from '@/game/ai/EnemyAI';
import { ENEMIES } from '@/content/enemies';
import { BOSSES } from '@/content/bosses';
import { WEAPONS } from '@/content/weapons';
import { DWARF_SKELETON, HUMAN_SKELETON } from '@/render/rig/Skeleton';
import { drawWeapon } from '@/render/rig/CharacterRig';
import { drawBackdrop, drawForeground } from '@/game/Backdrop';
import { capsule, ellipse, poly, roundRect, shadow, star } from '@/render/Shapes';
import { clamp, easeOut, easeOutBack, lerp } from '@/core/math';
import {
  DEFAULT_CHIP,
  GRAVITY,
  GROUND_Y,
  STARTING_LIVES,
  FIGHT_ZOOM,
  PROJECTILE_PIERCE,
  PROJECTILE_RANGE_FRAC,
  VEHICLE_BLAST_DAMAGE,
  VEHICLE_BLAST_RADIUS,
  VEHICLE_HP,
  VIEW_W,
  WALL_BOUNCE,
  Z_DEPTH,
  Z_HIT_TOLERANCE,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';

type C2D = CanvasRenderingContext2D;

const INK = '#141019';

/** Enemies stream in a few at a time, like a corridor of bad decisions. */
const SPAWN_INTERVAL = 34;

/**
 * How far inside the visible edge a fighter is held. Roughly a body's
 * half-width, so nobody ends up sliced in half by the frame.
 */
const STAGE_EDGE_PAD = 14;
const BASE_CONCURRENT = 3;
/** Frames a corpse lies there before it is swept off the roster. */
const CORPSE_FRAMES = 140;
/** Frames the "GO ->" arrow stays up after a wave is cleared. */
const GO_FRAMES = 150;
const BOSS_CARD_FRAMES = 190;
/** Frames between the boss dying and the level being declared over. */
const OUTRO_FRAMES = 110;
const PICKUP_LIFE = 1500;
/** Frames a just-dropped weapon refuses to be walked back into your hands. */
const DROP_GRAB_LOCK = 48;
const PICKUP_REACH_X = 15;
const PICKUP_REACH_Z = 13;
/**
 * How far a deliberate reach goes.
 *
 * Wider than PICKUP_REACH, which is the radius at which health walks into you
 * by itself. This one is answering a button press, so it may be generous: a
 * prompt that is visible and a key that does nothing is the worst of both.
 */
const INTERACT_REACH_X = 26;
const INTERACT_REACH_Z = 18;
const VEHICLE_REACH_X = 38;
const VEHICLE_REACH_Z = 26;
/** Below this the vehicle is parking, not ramming. */
const RAM_SPEED = 3.2;
/** Frames before the same body may be run over again. */
const RAM_COOLDOWN = 26;
/** Gap between vehicles when a whole couch turns up wanting one each. */
const VEHICLE_SPACING = 54;
/**
 * How far in front of a swing a prop can be and still get wrecked.
 *
 * Generous on purpose. Props were unreliable enough to hit that they read as
 * scenery rather than as loot: you had to be inside a 54-unit-wide window, on
 * a 24-unit depth line, during five specific frames of a swing. This is a
 * brutal brawler, not a precision game — if the barrel is roughly in front of
 * you and you swing, it should break.
 */
const PROP_REACH_X = 58;
const PROP_REACH_Z = 34;
/** How far BEHIND you a prop can be and still catch the swing. */
const PROP_REACH_BACK = 26;
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

/** Alternates so a wave is not ten identical chains. */
const WEAPON_POOL: Partial<Record<EnemyKind, WeaponKind[]>> = {
  suit_guard: ['chain', 'bat', 'ironbar', 'pipe'],
  taser_guard: ['taser', 'pipe'],
  gunman: ['pistol', 'pistol', 'bat'],
  riot_guard: ['riotshield', 'ironbar'],
  intern: ['keyboard', 'gpu'],
  lobbyist: ['briefcase' as WeaponKind, 'bat'].filter((w) => w in WEAPONS) as WeaponKind[],
};

const BEARDS: RigStyle['beardStyle'][] = ['none', 'stubble', 'bushy', 'forked'];

// ─────────────────────────────────────────────────────────────────────────────
// Vehicles
// ─────────────────────────────────────────────────────────────────────────────

interface VehicleTuning {
  /** Speed multiplier handed to `Fighter.setRiding`. */
  speed: number;
  /** Shown on the pickup prompt and on the mount flourish. */
  name: string;
  /** How far in front of the middle the business end reaches. */
  nose: number;
  /** Damage multiplier for running somebody over. */
  ram: number;
  /** Chassis, trim and lamp. */
  body: string;
  trim: string;
  lamp: string;
}

/**
 * The four things a map may put in your way, and how each of them drives.
 *
 * Only `moto` is used by the hand-authored maps, so it is the one that had to
 * be good; the other three are on the generated campaign cadence and each gets
 * a silhouette of its own rather than a bike with a different label.
 */
const VEHICLE_KINDS: Record<VehicleSection['kind'], VehicleTuning> = {
  moto: { speed: 1, name: 'MOTO', nose: 24, ram: 1, body: '#c8402f', trim: '#f2f0ea', lamp: '#ffe6a8' },
  // Slower and weedier than the moto, and funnier for it: a dwarf in a spiked
  // leather jacket on a rented e-scooter is the correct image.
  scooter: {
    speed: 0.72,
    name: 'SCOOTER',
    nose: 16,
    ram: 0.6,
    body: '#3fb7a4',
    trim: '#20303a',
    lamp: '#ffe6a8',
  },
  cybertruck: {
    speed: 0.88,
    name: 'TRUCK',
    nose: 34,
    ram: 1.5,
    body: '#b9bec8',
    trim: '#7d8492',
    lamp: '#ff5b4a',
  },
  hyperloop_pod: {
    speed: 1.2,
    name: 'POD',
    nose: 30,
    ram: 1.15,
    body: '#dfe6f2',
    trim: '#5fd0ff',
    lamp: '#8fe3ff',
  },
  rocket: {
    speed: 1.4,
    name: 'ROCKET',
    nose: 32,
    ram: 1.35,
    body: '#eef1f6',
    trim: '#2f3644',
    lamp: '#ff9c3d',
  },
};

/**
 * Where each machine puts its rider, and how it makes him hold on.
 *
 * These are the numbers the chassis art below is drawn AROUND, not decoration
 * on top of it: `x`/`y` are the point the rig stands on — the saddle, the deck,
 * the cab floor — and the joint deltas bend the single `ride` clip into a pose
 * that suits this particular machine. Both are in vehicle-local units, so a
 * grip drawn at (20, -28) is a grip the hands actually close on.
 *
 * Nothing here touches the simulation. See RideSeat.
 */
const SEATS: Record<VehicleSection['kind'], RideSeat> = {
  // Crouched over the bars, backside on the saddle, boots on the pegs — the
  // clip was authored for exactly this, so only the legs are let down a little
  // to reach the pegs.
  moto: { x: -2, y: 18, lean: 0, arm: 0, elbow: 0, thigh: -0.35, knee: -0.45, spine: 0 },
  // Standing on the deck with both hands on the stem. Nobody crouches on one
  // of these; the whole comedy is how upright and how slow it is.
  scooter: { x: -4, y: 9, lean: -0.14, arm: -0.15, elbow: 0.1, thigh: -0.9, knee: -1.2, spine: -0.6 },
  // Sunk into a cab built for somebody twice his height: everything below the
  // window line is inside the door, and what is left is a hat and two fists on
  // a wheel he can barely see over.
  cybertruck: { x: -2, y: 6, lean: 0, arm: -0.55, elbow: 1, thigh: 0.3, knee: -0.5, spine: -0.45 },
  // Reclined in the tube and set well back under the peak of the canopy, knees
  // up, hands down on a sidestick below the coaming.
  hyperloop_pod: { x: -10, y: 6, lean: 0, arm: -0.35, elbow: 0.4, thigh: 0.45, knee: -0.7, spine: -0.25 },
  // Not seated in anything. Astride the hull with both fists on a grab bar,
  // which is the only honest way to draw a man on a firework.
  rocket: { x: -4, y: 19, lean: 0.06, arm: 0.15, elbow: -0.15, thigh: -0.15, knee: -0.1, spine: 0.2 },
};

/**
 * The window a closed machine lets you see its driver through.
 *
 * Used for BOTH the clip region around the rider and the glass drawn over him,
 * from the same numbers, so the two can never disagree about where the cabin
 * is. Anything of him outside this outline is inside the bodywork and is simply
 * not drawn — which is the whole difference between a man in a truck and a man
 * standing in front of one.
 *
 * Vehicle-local, flat [x0,y0, x1,y1, ...], mirrored with the machine.
 */
const TRUCK_GLASS: readonly number[] = [-24, -24, -1, -48, 19, -46.5, 26, -24];
const POD_CANOPY: readonly number[] = [
  -15, -26, -13, -42, -4, -53, 8, -55, 17, -46, 19, -26,
];

/** Kinds that hide what they cover. Open frames are absent on purpose. */
const CABINS: Partial<Record<VehicleSection['kind'], readonly number[]>> = {
  cybertruck: TRUCK_GLASS,
  hyperloop_pod: POD_CANOPY,
};

/** Contact shadow half-width. A scooter does not cast a truck's shadow. */
const VEHICLE_FOOTPRINT: Record<VehicleSection['kind'], number> = {
  moto: 19,
  scooter: 15,
  cybertruck: 30,
  hyperloop_pod: 24,
  rocket: 22,
};

/** What a fighter would interact with right now. Consumed by the HUD prompt. */
export interface InteractTarget {
  kind: 'weapon' | 'vehicle';
  /** Short noun for the thing itself: 'BAT', 'MOTO'. */
  label: string;
  /** What the press would actually do, for a prompt that wants a verb. */
  action: 'take' | 'swap' | 'drop' | 'mount' | 'dismount';
}

/**
 * Wardrobe. Scaling a near-black suit only ever produces another near-black
 * suit, so variation has to come from actually different cloth, not from
 * nudging one colour. Everything here is still office-issue miserable.
 */
const SUITS: string[] = ['#1a1a22', '#242a3a', '#2b2622', '#1f2b28', '#31303a', '#22283044'.slice(0, 7)];
const SHIRTS: string[] = ['#3d4250', '#5a6272', '#7a6a58', '#46566a', '#6a5060', '#2f3a46'];
const SKINS: [string, string][] = [
  ['#d8a682', '#a9784f'],
  ['#f0c9a8', '#c09468'],
  ['#a9764e', '#7c5232'],
  ['#7a5334', '#563820'],
  ['#e8b892', '#b78455'],
  ['#5f3f28', '#412a19'],
];
const HAIRS: string[] = ['#241d1a', '#0f0d0c', '#4a3527', '#6b5a44', '#8a8a90', '#2e1f1a'];

/** Nudge a #rrggbb toward lighter/darker and warmer/cooler. */
function shift(hex: string, mul: number, warm: number): string {
  if (hex.length !== 7 || hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const ch = (v: number, bias: number): number =>
    Math.max(0, Math.min(255, Math.round(v * mul + bias)));
  const r = ch((n >> 16) & 255, warm);
  const g = ch((n >> 8) & 255, 0);
  const b = ch(n & 255, -warm);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

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
  /**
   * Wear carried by THIS instance. A chain dropped with two swings left is
   * still a chain with two swings left when it is picked back up — otherwise
   * dropping and retaking a weapon would be a free repair.
   */
  durability: number;
  ammo: number;
  /**
   * Frames before this can be hoovered up by walking over it.
   *
   * Set when a fighter puts a weapon DOWN. Without it, deliberately dropping
   * one was impossible: the moment your hands were empty the auto-pickup
   * grabbed the same weapon straight back off the floor, so a spent taser could
   * never be got rid of. The interact key can still take it back immediately —
   * that is a decision, not an accident.
   */
  grabLock: number;
}

interface Vehicle {
  kind: VehicleSection['kind'];
  /** Bodies it can still take. Every ram costs one; at zero it is scrap. */
  hp: number;
  maxHp: number;
  /** Frames of shake left from the last impact, for the damage read. */
  jolt: number;
  x: number;
  z: number;
  /**
   * Where it was at the end of the previous step.
   *
   * A ridden machine is pinned to `rider.pos` every frame, so interpolating it
   * from here with the SAME alpha the rider's own renderer uses puts the two on
   * the same spot at every point between two sim steps. Without it a bike at
   * speed slid up to seven units out from under its rider and back again, sixty
   * times a second, which is most of what "stacked images" looked like.
   */
  prevX: number;
  prevZ: number;
  facing: Facing;
  /** Signed speed. Mirrors the rider while ridden, coasts to a stop after. */
  vx: number;
  rider: Fighter | null;
  /** Wheel rotation, kept inside one turn so it cannot drift into the floats. */
  spin: number;
  /** Mirrored off the rider each frame; presentation only. */
  wheelie: number;
  skid: number;
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
  /** World units still to travel before it drops. See PROJECTILE_RANGE_FRAC. */
  range: number;
  /** Bodies already passed through. Stops at PROJECTILE_PIERCE. */
  pierced: number;
  /** Ids already hit, so one body cannot be hit twice by the same round. */
  hit: number[];
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
/** The chassis, drawn under its rider. */
const D_VEHICLE = 4;
/** Bars, glass and light bar — the bits that belong IN FRONT of the rider. */
const D_VEHICLE_FRONT = 5;

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
  private readonly vehicles: Vehicle[] = [];

  /** Frames before a given body may be run over again, by fighter id. */
  private readonly ramCooldown = new Map<number, number>();

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
  /** Set once when the boss walks on; consumed by takeBossStart(). */
  private bossStarted = false;
  private outro = 0;

  private _complete = false;
  private _failed = false;
  private _score = 0;

  /** True while a finisher is on stage; see `beginFatality`. */
  private finisher = false;
  /** The two performers the director draws itself. -1 when there is no show. */
  private stagedKiller = -1;
  private stagedVictim = -1;
  /** Enemy ids whose death was claimed by a finisher, pending their own step. */
  private readonly fatalIds = new Set<number>();

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

    this.buildVehicles();

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

  /**
   * Returns the boss exactly once, on the frame it arrives, so the scene can
   * play its introduction. Consuming it clears the flag.
   */
  takeBossStart(): BossDef | null {
    if (!this.bossStarted) return null;
    this.bossStarted = false;
    return this.bossDef ?? null;
  }

  /** Where the boss is standing, for the introduction to frame it. */
  get bossPos(): { x: number; z: number } | null {
    return this.boss ? { x: this.boss.f.pos.x, z: this.boss.f.pos.z } : null;
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

  // ── finishers ──────────────────────────────────────────────────────────────

  /** True while the fatality director owns the frame. */
  get finisherActive(): boolean {
    return this.finisher;
  }

  /**
   * Put the map on hold: a finisher has taken this kill.
   *
   * Two jobs, both of them about not being in the director's way.
   *
   * The performers are struck from the draw list, because the director draws
   * them itself out of the same rig — leave them in and the frozen originals sit
   * underneath the performance in their last combat pose, and every finisher
   * reads as a duplication bug.
   *
   * And the map stops: `update` returns immediately, so no wave triggers, no
   * queue drains, no boss phase turns over and no respawn timer ticks down
   * behind the letterbox. Anything already in the air is dropped outright,
   * because the director zooms to better than two times and a bullet hanging
   * motionless across the shot is an artifact rather than a bullet.
   *
   * The victim is NOT removed here. A player has to stay on the roster to lose
   * a life and come back; an enemy stays until its own `stepUnit` notices it is
   * dead, books the score and the drop, and — because the joke has already
   * disposed of the body far better than a corpse timer can — sweeps it on the
   * very next frame instead of leaving it lying there for another two seconds.
   */
  beginFatality(killerId: number, victimId: number): void {
    this.finisher = true;
    this.stagedKiller = killerId;
    this.stagedVictim = victimId;

    for (const u of this.units) {
      if (u.f.id === victimId && !u.dead) {
        this.fatalIds.add(victimId);
        break;
      }
    }

    this.projectiles.length = 0;
  }

  /** The performance is over. Hand the map back. */
  endFatality(): void {
    this.finisher = false;
    this.stagedKiller = -1;
    this.stagedVictim = -1;
  }

  private isStaged(id: number): boolean {
    return id === this.stagedKiller || id === this.stagedVictim;
  }

  // ── simulation ─────────────────────────────────────────────────────────────

  update(ctx: SimContext): void {
    // Nothing happens inside somebody else's punchline: no waves, no adds, no
    // bullets in flight, no respawn clock, and above all no hits landing on two
    // bodies the director has already moved somewhere else. The scene freezes
    // us anyway while a finisher runs; this is the belt to that pair of braces.
    if (this.finisher) return;

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
    // Reaching for something happens before the vehicles move, so mounting is
    // answered on the frame it was asked for rather than one behind.
    this.updateInteract(ctx);
    this.updateVehicles(ctx);
    this.updatePickups();
    this.updateProjectiles(ctx);

    if (this.goTimer > 0) this.goTimer--;
    if (this.cardTimer > 0) this.cardTimer--;
    if (this.outro > 0 && --this.outro === 0) this._complete = true;

    this.followCamera();
    // Last word of the step, because `followCamera` is allowed to shove a body
    // back inside the stage — and a machine that settled a frame before its
    // rider did is a machine the rider is standing next to.
    this.seatVehicles();
  }

  /** Pin every ridden machine to the body on it, after everything has moved. */
  private seatVehicles(): void {
    for (const v of this.vehicles) {
      const r = v.rider;
      if (!r) continue;
      v.x = r.pos.x;
      v.z = r.pos.z;
      v.facing = r.facing;
    }
  }

  /**
   * Entity spawn requests routed from `SimContext.spawn`. Bind it straight
   * through when building the context: `spawn: (k, x, y, z, d) => level.spawn(...)`.
   */
  spawn(kind: string, x: number, y: number, z: number, data?: unknown): void {
    // A move that was mid-flight when the kill landed does not get to finish
    // its thought during the finisher.
    if (this.finisher) return;
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
          // 40% of the width the player can SEE, not of the map — a shooter who
          // can out-range the screen can only be answered by walking to him.
          range: numberOf(d.range, (VIEW_W / FIGHT_ZOOM) * PROJECTILE_RANGE_FRAC),
          pierced: 0,
          hit: [],
        });
        this.audio.play(kind === 'bolt' ? 'taser' : 'gunshot', { pan: this.pan(x) });
        break;
      }
      case 'weapon': {
        const w = weaponOf(d.kind ?? d.weapon);
        // Durability and ammo ride along when a fighter throws one down, so a
        // weapon that has been used stays used.
        if (w) {
          this.dropWeapon(
            w,
            x,
            y,
            zz,
            numberOf(d.vy, 3),
            typeof d.durability === 'number' && Number.isFinite(d.durability)
              ? d.durability
              : undefined,
            typeof d.ammo === 'number' && Number.isFinite(d.ammo) ? d.ammo : undefined,
          );
        }
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

  /**
   * How many of a wave's enemies actually turn up.
   *
   * Waves are authored for a single player. Two people on one screen were
   * fighting the same four guards each, which is limp; four people made it
   * trivial. Scale with the party, but sub-linearly — a crowd helps each other
   * more than the numbers suggest — and shave the opening maps, which are
   * meant to teach rather than to kill.
   */
  private waveCount(base: number): number {
    let live = 0;
    for (const p of this.players) if (p.alive) live++;
    const party = Math.max(1, live);
    let n = base * (1 + (party - 1) * 0.55);
    if (this.def.index <= 3) n *= 0.7;
    return Math.max(1, Math.round(n));
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
      const n = this.waveCount(group.count);
      for (let i = 0; i < n; i++) this.queue.push({ kind: group.kind, wave: this.waveIndex });
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

  /** Odds a given enemy walks on armed. Early maps mostly send fists. */
  private armedChance(): number {
    return clamp(0.12 + this.def.index * 0.04, 0.12, 0.72);
  }

  /**
   * A per-instance copy of the kind's look.
   *
   * Every enemy of a kind previously shared ONE RigStyle object, so a wave was
   * the same man three times — and any per-fighter tint would have written
   * through to the shared object. This clones it and nudges build and palette,
   * so a line of corporate security reads as several different people who
   * happen to shop at the same place.
   */
  private variantStyle(base: RigStyle, kind: EnemyKind): RigStyle {
    const r = this.rng;
    const lit = r.range(0.82, 1.24);
    const warm = r.range(-12, 12);
    const s: RigStyle = { ...base };

    s.scale = base.scale * r.range(0.92, 1.09);
    s.girth = base.girth * r.range(0.88, 1.14);
    s.headSize = base.headSize * r.range(0.95, 1.06);

    if (SQUAT_ENEMIES.has(kind)) {
      // Machines come off one line: chassis tint only.
      s.skin = shift(base.skin, lit, warm);
      s.tunicColor = shift(base.tunicColor, lit, warm);
      s.jacketColor = shift(base.jacketColor, lit, warm);
      s.jacketAccent = shift(base.jacketAccent, r.range(0.8, 1.4), warm);
      s.hatColor = shift(base.hatColor, lit, warm);
      return s;
    }

    // People are people: different faces, different hair, different suits.
    const skin = r.pick(SKINS);
    s.skin = shift(skin[0], r.range(0.94, 1.06), 0);
    s.skinShade = shift(skin[1], r.range(0.94, 1.06), 0);
    s.hair = r.pick(HAIRS);

    const suit = shift(r.pick(SUITS), lit, warm);
    s.tunicColor = suit;
    s.jacketColor = suit;
    s.jacketAccent = shift(r.pick(SHIRTS), r.range(0.85, 1.2), warm);
    s.hatColor = r.chance(0.5) ? suit : shift(suit, r.range(0.6, 1.5), warm);

    if (base.shades) s.shades = r.chance(0.72);
    if (r.chance(0.34)) {
      s.beardStyle = r.pick(BEARDS);
      s.beardLength = s.beardStyle === 'none' ? 0 : r.range(2, 6);
    }
    return s;
  }

  private spawnEnemy(kind: EnemyKind, wave: number, x: number, z: number): Unit | null {
    const def = ENEMIES[kind];
    if (!def) return null;

    const init: FighterInit = {
      id: this.nextId++,
      team: 'enemy',
      x: clamp(x, 4, this.def.width - 4),
      z: clamp(z, 1, this.def.depth - 1),
      style: this.variantStyle(def.style, kind),
      skeleton: SQUAT_ENEMIES.has(kind) ? DWARF_SKELETON : HUMAN_SKELETON,
      health: def.health,
      speed: def.speed,
      power: def.power,
      moves: moveSet(def.moves.light, def.moves.heavy, def.moves.ranged),
      voice: ENEMY_VOICES[kind],
      archetype: kind,
    };

    const f = new Fighter(init);
    // Not every guard is issued a weapon. Arming all of them made the opening
    // of map 1 three chain-swingers abreast, which is not a tutorial.
    if (def.weapon && this.rng.chance(this.armedChance())) {
      const pool = WEAPON_POOL[kind];
      f.giveWeapon(pool && pool.length > 0 ? this.rng.pick(pool) : def.weapon);
    }

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

    // A finisher already had its say about this body: it does not need a cloud
    // of sparks on top, and the corpse goes on the next frame rather than lying
    // in a combat pose the performance just contradicted.
    const claimed = this.fatalIds.delete(u.f.id);
    if (claimed) u.corpse = CORPSE_FRAMES;

    if (!claimed) {
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
    }
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
      // What actually draws this boss. Without it every non-humanoid boss was
      // rendered as a person: the Shiba was a spiky orange dwarf.
      bossRig: bd.rigOverride,
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

    // The old card was a 190-frame text plate over a fight that had already
    // started behind it — unreadable, and it hid the thing you needed to watch.
    // FightScene now plays a cinematic instead and waits for a keypress.
    this.cardTimer = 0;
    this.bossStarted = true;
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

    // Nobody fights off-screen.
    //
    // Bounds come from cam.playLeft/playRight, which account for the zoom —
    // cam.x is the left edge of the UNZOOMED frame, so at FIGHT_ZOOM the real
    // picture is ~100 units narrower on each side. Clamping to cam.x + VIEW_W
    // instead used to park a knocked-back fighter well outside the shot, where
    // enemies happily carried on hitting them.
    //
    // This applies to enemies too, and always — not only while gated. An enemy
    // standing off-screen landing hits is the same unfairness from the other
    // side, and being knocked off the left edge between waves is no better than
    // being knocked off it during one.
    let min = Math.max(6, this.cam.playLeft + STAGE_EDGE_PAD);
    let max = Math.min(this.def.width - 6, this.cam.playRight - STAGE_EDGE_PAD);
    if (min > max) min = max = (min + max) * 0.5;

    for (const p of this.players) this.confine(p, min, max);
    for (const u of this.units) {
      if (u.dead) continue;
      this.confine(u.f, min, max);
    }
  }

  /**
   * Hold a fighter inside the visible stage.
   *
   * Anyone airborne or in hitstun rebounds off the edge with WALL_BOUNCE so it
   * reads as hitting something solid and the combo can continue off the wall.
   * Anyone on their feet simply stops dead: bouncing a walking player off thin
   * air feels like a bug, not a wall.
   */
  private confine(f: Fighter, min: number, max: number): void {
    const rebounds = !f.grounded || f.state === 'launched' || f.state === 'hurt';
    if (f.pos.x < min) {
      f.pos.x = min;
      if (f.vel.x < 0) f.vel.x = rebounds ? -f.vel.x * WALL_BOUNCE : 0;
    } else if (f.pos.x > max) {
      f.pos.x = max;
      if (f.vel.x > 0) f.vel.x = rebounds ? -f.vel.x * WALL_BOUNCE : 0;
    }
  }

  // ── interaction ────────────────────────────────────────────────────────────

  /**
   * Answer whatever the interact button asked for.
   *
   * Weapons used to be hoovered up by walking over them, and the collection was
   * skipped outright once your hands were full — so an armed player could not
   * trade a spent chain for the bat at their feet, and there was no way to get
   * on anything at all. This is that key.
   *
   * The order of the answers is the order of the stakes: get off the thing you
   * are riding, get on the thing next to you, take (or trade) the weapon at
   * your feet, and failing all three, put down what you are holding. That last
   * one is not a fallback for its own sake — going bare-fisted on purpose is a
   * real choice, and a key that always does SOMETHING is a key players trust.
   *
   * A press that finds nothing is deliberately NOT consumed: it sits in the
   * fighter's buffer for a few frames, so pressing just before you reach the
   * bat still picks the bat up.
   */
  private updateInteract(ctx: SimContext): void {
    for (const p of this.players) {
      if (!p.interactPending) continue;

      if (p.riding) {
        const v = this.vehicleOf(p);
        if (v) this.dismount(v);
        else p.setRiding(false);
        p.consumeInteract();
        continue;
      }

      // Mid-swing, mid-flinch, on the floor or in the air: not now. The press
      // stays buffered and lands the moment the body is free.
      if (!p.canInteract) continue;

      const v = this.vehicleNear(p);
      if (v) {
        this.mount(p, v, ctx);
        p.consumeInteract();
        continue;
      }

      const i = this.weaponNear(p);
      if (i >= 0) {
        this.takeWeapon(i, p, ctx);
        p.consumeInteract();
        continue;
      }

      if (p.weapon) {
        p.dropWeapon(ctx);
        p.consumeInteract();
      }
    }
  }

  /**
   * What this fighter would interact with right now, or null.
   *
   * Cheap enough to call once per player per frame from the HUD: two short
   * linear scans over things there are single digits of.
   */
  interactTargetFor(f: Fighter): InteractTarget | null {
    if (f.riding) {
      const v = this.vehicleOf(f);
      return { kind: 'vehicle', label: v ? VEHICLE_KINDS[v.kind].name : 'RIDE', action: 'dismount' };
    }
    if (!f.canInteract) return null;

    const v = this.vehicleNear(f);
    if (v) return { kind: 'vehicle', label: VEHICLE_KINDS[v.kind].name, action: 'mount' };

    const i = this.weaponNear(f);
    if (i >= 0) {
      return {
        kind: 'weapon',
        label: weaponName(this.pickups[i].weapon),
        action: f.weapon ? 'swap' : 'take',
      };
    }
    if (f.weapon) return { kind: 'weapon', label: weaponName(f.weapon), action: 'drop' };
    return null;
  }

  /** Index of the nearest weapon lying within reach, or -1. */
  private weaponNear(f: Fighter): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.pickups.length; i++) {
      const it = this.pickups[i];
      if (it.kind !== 'weapon' || !it.weapon) continue;
      // Still bouncing: let it land first.
      if (it.y > 10) continue;
      const dx = Math.abs(it.x - f.pos.x);
      if (dx > INTERACT_REACH_X) continue;
      const dz = Math.abs(it.z - f.pos.z);
      if (dz > INTERACT_REACH_Z) continue;
      const d = dx + dz * 0.8;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Take the weapon at index `i`, trading away whatever is already in hand.
   *
   * The old one is dropped as a REAL pickup — same entity, same wear — before
   * the new one is taken, which is the whole point of the exchange. Order
   * matters only in that the drop appends to `pickups`, so `i` still refers to
   * the weapon being taken when it is spliced out.
   */
  private takeWeapon(i: number, p: Fighter, ctx: SimContext): void {
    const it = this.pickups[i];
    if (!it || it.kind !== 'weapon' || !it.weapon) return;
    if (p.weapon) p.dropWeapon(ctx);
    this.collect(it, p);
    const at = this.pickups.indexOf(it);
    if (at >= 0) this.pickups.splice(at, 1);
  }

  // ── vehicles ───────────────────────────────────────────────────────────────

  /**
   * Park the map's vehicles in its VehicleSection.
   *
   * One each. A four-player couch fighting over a single bike is not a treat,
   * it is a queue — and the section is wide enough that spacing them out costs
   * nothing.
   */
  private buildVehicles(): void {
    // Scooters are scattered as props all over the campaign. Riding one should
    // always be an option — smashing it is still allowed, it just has to be a
    // choice rather than the only thing it is for.
    for (const pr of this.props) {
      if (pr.kind !== 'scooter' || pr.broken) continue;
      pr.broken = true;
      this.vehicles.push({
        kind: 'scooter',
        x: pr.x,
        z: pr.z,
        prevX: pr.x,
        prevZ: pr.z,
        facing: 1,
        vx: 0,
        rider: null,
        spin: 0,
        wheelie: 0,
        skid: 0,
        hp: VEHICLE_HP,
        maxHp: VEHICLE_HP,
        jolt: 0,
      });
    }

    const spec = this.def.vehicle;
    if (!spec) return;
    if (!(spec.kind in VEHICLE_KINDS)) return;

    const w = this.def.width;
    const from = clamp(Math.min(spec.from, spec.to), 0, 1) * w;
    const to = clamp(Math.max(spec.from, spec.to), 0, 1) * w;
    const last = Math.max(from, to - 24);
    const n = clamp(this.players.length, 1, 4);

    for (let i = 0; i < n; i++) {
      const x = clamp(Math.min(from + 34 + i * VEHICLE_SPACING, last), 20, w - 20);
      const z = clamp(this.def.depth * (0.42 + i * 0.13), 4, this.def.depth - 4);
      this.vehicles.push({
        kind: spec.kind,
        x,
        z,
        prevX: x,
        prevZ: z,
        facing: 1,
        vx: 0,
        rider: null,
        spin: 0,
        wheelie: 0,
        skid: 0,
        hp: VEHICLE_HP,
        maxHp: VEHICLE_HP,
        jolt: 0,
      });
    }
  }

  private vehicleOf(f: Fighter): Vehicle | null {
    for (const v of this.vehicles) {
      if (v.rider === f) return v;
    }
    return null;
  }

  /** The nearest unridden vehicle within reach, or null. */
  private vehicleNear(f: Fighter): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const v of this.vehicles) {
      if (v.rider) continue;
      const dx = Math.abs(v.x - f.pos.x);
      if (dx > VEHICLE_REACH_X) continue;
      const dz = Math.abs(v.z - f.pos.z);
      if (dz > VEHICLE_REACH_Z) continue;
      const d = dx + dz * 0.8;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  private mount(p: Fighter, v: Vehicle, ctx: SimContext): void {
    const tune = VEHICLE_KINDS[v.kind];
    v.rider = p;
    v.x = p.pos.x;
    v.z = p.pos.z;
    // The chassis teleports to the body; without this it interpolates across
    // the gap and the bike slides out of a hedge to meet him.
    v.prevX = v.x;
    v.prevZ = v.z;
    v.facing = p.facing;
    v.vx = 0;
    p.setRiding(true, tune.speed, SEATS[v.kind]);

    this.audio.play('engine', { pan: this.pan(v.x), gain: 0.9 });
    this.fx.text({
      text: tune.name,
      x: p.pos.x,
      y: 62,
      z: p.pos.z,
      color: tune.lamp,
      size: 11,
      life: 46,
      rise: 0.4,
      style: 'bonus',
    });
    this.fx.shake({ magnitude: 3, duration: 12 });
    this.fx.particles({
      count: 10,
      x: v.x - v.facing * 16,
      y: 6,
      z: v.z,
      angle: v.facing > 0 ? Math.PI : 0,
      spread: 0.8,
      speed: [0.8, 2.6],
      life: [14, 30],
      size: [1.6, 3.4],
      colors: ['#c9c4d6', '#8f8aa0', '#5c5566'],
      gravity: -0.02,
      drag: 0.92,
      shape: 'smoke',
      fade: 'ease',
    });
    // Anything that was in the queue for this frame is not what they meant.
    ctx.audio.voice(p.voice, 'taunt');
  }

  /**
   * Hand the body back.
   *
   * Safe to call for any reason — the button, a hit that took the rider out of
   * the saddle, or death — because every one of those has to leave a fighter
   * who can walk and a vehicle somebody can get back on.
   */
  private dismount(v: Vehicle): void {
    const r = v.rider;
    v.rider = null;
    v.vx = 0;
    v.wheelie = 0;
    if (!r) return;

    r.setRiding(false);
    // Step the chassis forward so the two silhouettes come apart. It is put
    // there, not driven there, so the renderer must not tween across the gap.
    v.x = clamp(v.x + v.facing * 14, 8, this.def.width - 8);
    v.prevX = v.x;
    v.prevZ = v.z;
    this.audio.play('tyres', { pan: this.pan(v.x), gain: 0.5, pitch: 1.1 });
    this.fx.particles({
      count: 6,
      x: v.x,
      y: 3,
      z: v.z,
      angle: v.facing > 0 ? Math.PI : 0,
      spread: 1.1,
      speed: [0.6, 2],
      life: [10, 22],
      size: [1.4, 2.8],
      colors: ['#d8d0c2', '#a29a8c'],
      gravity: -0.01,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
    });
  }

  private updateVehicles(ctx: SimContext): void {
    if (this.ramCooldown.size > 0) {
      for (const id of Array.from(this.ramCooldown.keys())) {
        const n = (this.ramCooldown.get(id) ?? 0) - 1;
        if (n <= 0) this.ramCooldown.delete(id);
        else this.ramCooldown.set(id, n);
      }
    }

    for (const v of this.vehicles) {
      // Last frame's resting place, for the renderer to interpolate from.
      v.prevX = v.x;
      v.prevZ = v.z;

      const r = v.rider;
      // Knocked out of the saddle, or knocked out entirely.
      if (r && (!r.alive || !r.riding)) this.dismount(v);

      if (v.rider) {
        const p = v.rider;
        v.x = p.pos.x;
        v.z = p.pos.z;
        v.facing = p.facing;
        v.vx = p.rideSpeed;
        v.wheelie = p.rideWheelieAmount;
        v.skid = p.rideSkid;
        this.ram(v, ctx);
      } else {
        // Let go at speed, it rolls to a stop rather than stopping dead.
        v.vx *= 0.9;
        if (Math.abs(v.vx) < 0.05) v.vx = 0;
        v.x = clamp(v.x + v.vx, 8, this.def.width - 8);
        if (v.skid > 0) v.skid--;
      }

      if (v.jolt > 0) v.jolt--;
      v.spin = (v.spin + v.vx * 0.09) % (Math.PI * 2);
    }
  }

  /**
   * Running people over.
   *
   * Deliberately not a hitbox: it belongs to the vehicle, not to any move the
   * rider is doing, and it fires from speed alone. One body may only be hit
   * every RAM_COOLDOWN frames, so ploughing through a wave is a series of
   * separate impacts rather than sixty in a second.
   */
  private ram(v: Vehicle, ctx: SimContext): void {
    const rider = v.rider;
    if (!rider) return;
    const speed = Math.abs(v.vx);
    if (speed < RAM_SPEED) return;

    const tune = VEHICLE_KINDS[v.kind];
    const dir = v.vx > 0 ? 1 : -1;

    // Furniture does not survive this at all, which is the point of putting a
    // bike on a map that opens with nine breakables in a row.
    for (const pr of this.props) {
      if (pr.broken) continue;
      const dx = (pr.x - v.x) * dir;
      if (dx < -8 || dx > tune.nose) continue;
      if (Math.abs(pr.z - v.z) > PROP_REACH_Z) continue;
      this.damageProp(pr, pr.maxHp + 1);
    }

    for (const u of this.units) {
      if (u.dead) continue;
      const f = u.f;
      if (!f.alive) continue;
      if ((this.ramCooldown.get(f.id) ?? 0) > 0) continue;
      const dx = (f.pos.x - v.x) * dir;
      if (dx < -8 || dx > tune.nose) continue;
      if (Math.abs(f.pos.z - v.z) > Z_HIT_TOLERANCE) continue;
      if (f.pos.y > 40) continue;

      this.ramCooldown.set(f.id, RAM_COOLDOWN);
      if (!f.takeHit(ramHit(speed, tune.ram), v.x, ctx, rider)) continue;

      this.fx.shake({ magnitude: 6, duration: 14, dirX: 1, dirY: 0.4 });
      this.fx.particles({
        count: 14,
        x: f.pos.x,
        y: 20,
        z: f.pos.z,
        angle: dir > 0 ? 0 : Math.PI,
        spread: 1.3,
        speed: [2, 6],
        life: [14, 32],
        size: [1.2, 3],
        colors: ['#ffe14a', '#ff8a3d', '#ffffff'],
        gravity: 0.2,
        drag: 0.94,
        shape: 'spark',
        additive: true,
      });
      this.audio.play('tyres', { pan: this.pan(v.x), gain: 0.4, pitch: 1.2 });
      ctx.requestHitstop(4);

      // Bodies are not free. Twenty of them and it is scrap — which is what
      // stops one bike clearing a whole map and turning the level into a
      // corridor you drive down.
      v.hp--;
      v.jolt = 10;
      if (v.hp <= 0) {
        this.wreck(v, ctx);
        return;
      }
    }
  }

  /**
   * The vehicle gives out.
   *
   * Everyone within reach goes down, the driver included — riding it into the
   * twentieth man is a decision with a bill attached, and being thrown off your
   * own bike is a funnier ending than it quietly vanishing.
   */
  private wreck(v: Vehicle, ctx: SimContext): void {
    const rider = v.rider;
    const x = v.x;
    const z = v.z;

    if (rider) this.dismount(v);

    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);

    const caught: Fighter[] = [];
    for (const u of this.units) {
      if (!u.dead && u.f.alive) caught.push(u.f);
    }
    for (const p of this.players) if (p.alive) caught.push(p);

    for (const f of caught) {
      const dx = f.pos.x - x;
      const dz = (f.pos.z - z) * 0.7;
      if (Math.hypot(dx, dz) > VEHICLE_BLAST_RADIUS) continue;
      f.takeHit(blastHit(f === rider), x, ctx, rider ?? f);
    }

    this.fx.shake({ magnitude: 14, duration: 30 });
    this.fx.flash('#ffd08a', 5, 0.55);
    this.audio.play('explosion', { pan: this.pan(x), gain: 0.9 });
    ctx.requestHitstop(10);
    this.fx.particles({
      count: 46,
      x,
      y: 22,
      z,
      angle: -Math.PI / 2,
      spread: Math.PI * 1.6,
      speed: [2, 8],
      life: [20, 52],
      size: [1.4, 4],
      colors: ['#ffe14a', '#ff8a3d', '#c9c4d6', '#4a4152'],
      gravity: 0.26,
      drag: 0.93,
      shape: 'shard',
    });
    this.fx.particles({
      count: 22,
      x,
      y: 26,
      z,
      angle: -Math.PI / 2,
      spread: 1.2,
      speed: [0.6, 2.4],
      life: [40, 90],
      size: [4, 10],
      colors: ['#3a3448', '#6a6478'],
      gravity: -0.02,
      drag: 0.95,
      shape: 'smoke',
    });
  }

  // ── props, pickups, projectiles ─────────────────────────────────────────────

  private updateProps(ctx: SimContext): void {
    for (const pr of this.props) {
      if (pr.flash > 0) pr.flash--;
      if (pr.wobble !== 0) pr.wobble *= 0.86;
    }

    for (const f of this.players) {
      if (!f.alive || f.state !== 'attack') continue;
      // Most of the swing counts, not five frames in the middle of it.
      if (f.stateFrame < 2 || f.stateFrame > 22) continue;
      const tag = ctx.frame - f.stateFrame;
      if (this.propSwing.get(f.id) === tag) continue;

      for (const pr of this.props) {
        if (pr.broken) continue;
        const dx = (pr.x - f.pos.x) * f.facing;
        if (dx < -PROP_REACH_BACK || dx > PROP_REACH_X) continue;
        if (Math.abs(pr.z - f.pos.z) > PROP_REACH_Z) continue;
        this.propSwing.set(f.id, tag);
        this.damageProp(pr, f.weapon ? 26 : 16);
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

  private dropWeapon(
    kind: WeaponKind,
    x: number,
    y: number,
    z: number,
    vy: number,
    durability?: number,
    ammo?: number,
  ): void {
    const def = WEAPONS[kind];
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
      durability: durability !== undefined ? durability : (def?.durability ?? -1),
      ammo: ammo !== undefined ? ammo : (def?.ammo ?? 0),
      grabLock: DROP_GRAB_LOCK,
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
      durability: 0,
      ammo: 0,
      grabLock: 0,
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
      durability: 0,
      ammo: 0,
      grabLock: 0,
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
      if (it.grabLock > 0) it.grabLock--;
      if (--it.life <= 0) {
        this.pickups.splice(i, 1);
        continue;
      }
      if (it.y > 2) continue;
      /*
       * Who picks up what, by walking over it:
       *
       *   health / meter  — always. Not a choice, and asking for a keypress to
       *                     take a health pack would be a downgrade.
       *   weapon, unarmed — always. Arming yourself should never be a chore.
       *   weapon, armed   — never. This is the case the interact key exists
       *                     for: you choose between what you are holding and
       *                     what is at your feet, and the HUD prompts you.
       *                     See `updateInteract`.
       *
       * The original bug was that the armed case silently did nothing at all —
       * no pickup, no prompt, no way to trade.
       */
      for (const p of this.players) {
        if (!p.alive || !p.grounded) continue;
        // Empty hands take what they walk over. Making somebody press a key to
        // arm themselves at all was the wrong half of the rule: the press is
        // there so you can CHOOSE between the chain you are holding and the bat
        // at your feet, not so that picking anything up is a chore.
        //
        // Anyone already carrying something walks over it untouched, and trades
        // deliberately through `updateInteract`.
        if (it.kind === 'weapon' && (p.weapon || it.grabLock > 0)) continue;
        if (Math.abs(p.pos.x - it.x) > PICKUP_REACH_X) continue;
        if (Math.abs(p.pos.z - it.z) > PICKUP_REACH_Z) continue;
        this.collect(it, p);
        this.pickups.splice(i, 1);
        break;
      }
    }
  }

  private collect(it: Pickup, p: Fighter): void {
    if (it.kind === 'weapon' && it.weapon) {
      p.giveWeapon(it.weapon, it.durability, it.ammo);
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

      // Range is spent by distance, not by time, so a fast round and a slow one
      // reach equally far. A shooter has to close in to be a threat at all.
      pj.range -= Math.abs(pj.vx);
      let done = --pj.life <= 0 || pj.range <= 0 || pj.x < camL || pj.x > camR || pj.y < -4;

      if (!done) {
        for (const f of this.fighters) {
          // FRIENDLY FIRE. A bullet does not check whose side you are on — it
          // only refuses to hit the man who fired it, because a gun that kills
          // its owner on frame one is a bug rather than satire. Standing behind
          // your own gunman is now a decision.
          if (!f.alive || f === pj.owner) continue;
          if (pj.hit.includes(f.id)) continue;
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
          // Rounds punch through. With friendly fire on this cuts both ways:
          // a line of guards is a gift to whoever shoots down it.
          pj.hit.push(f.id);
          if (++pj.pierced >= PROJECTILE_PIERCE) {
            done = true;
            break;
          }
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
        case D_FIGHTER: {
          const f = this.fighters[it.i];
          // A rider is drawn inside its machine's frame, and clipped by it.
          const v = f.riding ? this.vehicleOf(f) : null;
          if (v) this.drawRider(ctx, cam, alpha, f, v);
          else f.render(ctx, cam, alpha);
          break;
        }
        case D_PROJ:
          this.drawProjectile(ctx, this.projectiles[it.i]);
          break;
        case D_VEHICLE:
          this.drawVehicle(ctx, this.vehicles[it.i], false, alpha);
          break;
        case D_VEHICLE_FRONT:
          this.drawVehicle(ctx, this.vehicles[it.i], true, alpha);
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
    // Pushed before the fighters and at the same depth: the sort is stable, so
    // the chassis lands under its rider. The front layer is nudged a hair
    // nearer the camera so bars and glass land in front of them.
    for (let i = 0; i < this.vehicles.length; i++) {
      push(this.vehicles[i].z, D_VEHICLE, i);
      push(this.vehicles[i].z + 0.05, D_VEHICLE_FRONT, i);
    }
    for (let i = 0; i < this.fighters.length; i++) {
      // The director draws its own two. See beginFatality().
      if (this.finisher && this.isStaged(this.fighters[i].id)) continue;
      push(this.fighters[i].pos.z, D_FIGHTER, i);
    }
    for (let i = 0; i < this.projectiles.length; i++) push(this.projectiles[i].z, D_PROJ, i);

    const items = this.drawItems.slice(0, n);
    // Back to front. z=0 is the back wall, so ascending z — sorting the other
    // way drew whoever stood nearest the camera UNDERNEATH the people behind
    // them.
    items.sort((a, b) => a.z - b.z);
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

  /**
   * The vehicle, in the same bold-outline vector house style as the props.
   *
   * Drawn in two passes around its rider: `front` is the handful of parts that
   * belong in FRONT of a body sitting on the thing — the flank a knee grips,
   * the pipe across a shin, the bars, the glass, the straps — without which the
   * rider reads as standing on top of a shape rather than riding it.
   *
   * Local space inside the transform: x=0 is the middle of the vehicle, y=0 the
   * ground line at its depth, +x forward whichever way it is pointing. The same
   * units the seats above are written in, because the two have to agree.
   */
  private drawVehicle(ctx: C2D, v: Vehicle, front: boolean, alpha: number): void {
    if (!v) return;
    const vx = lerp(v.prevX, v.x, alpha);
    const vz = lerp(v.prevZ, v.z, alpha);
    const sy = GROUND_Y + vz * Z_SCALE;
    const s = depthScale(vz);
    const tune = VEHICLE_KINDS[v.kind];

    if (!front) {
      // A scooter has a smaller footprint than a motorbike, which is most of
      // what sells it as a different machine at this size.
      const foot = VEHICLE_FOOTPRINT[v.kind] * s;
      shadow(ctx, vx, sy, foot, 0.32);
      if (v.skid > 0) this.drawSkid(ctx, v, vx, sy, s);
    }

    ctx.save();
    this.vehicleFrame(ctx, v, vx, sy, s);
    // The rig shrinks with depth and the machine has to shrink with it, or a
    // bike at the back wall is a bike with a smaller man on it.
    ctx.scale(s * v.facing, s);
    if (v.wheelie > 0) {
      // Pivot on the back wheel, which is what a wheelie is.
      ctx.translate(-16, 0);
      ctx.rotate(-v.wheelie * 0.5);
      ctx.translate(16, 0);
    }

    switch (v.kind) {
      case 'cybertruck':
        if (front) this.drawTruckFront(ctx, tune);
        else this.drawTruckBody(ctx, v, tune);
        break;
      case 'hyperloop_pod':
        if (front) this.drawPodFront(ctx, v, tune);
        else this.drawPodBody(ctx, v, tune);
        break;
      case 'rocket':
        if (front) this.drawRocketFront(ctx, tune);
        else this.drawRocketBody(ctx, v, tune);
        break;
      case 'scooter':
        if (front) this.drawScooterFront(ctx, v, tune);
        else this.drawScooterBody(ctx, v, tune);
        break;
      case 'moto':
      default:
        if (front) this.drawMotoFront(ctx, v, tune);
        else this.drawMotoBody(ctx, v, tune);
        break;
    }

    // Once, on the chassis pass. Drawing it in both used to double every
    // scorch mark and emit two plumes of smoke per frame.
    if (!front) this.drawVehicleWear(ctx, v);
    ctx.restore();
  }

  /**
   * The frame the machine lives in: where it stands, how it lists as it is
   * wrecked, and the float under anything that does not use wheels.
   *
   * Shared by the chassis and by the body riding it — a rider who does not list
   * with the bodywork is a sticker on it — so it leaves the origin at the
   * machine's ground point, unscaled and unflipped, and each caller applies
   * whatever else it needs from there.
   */
  private vehicleFrame(ctx: C2D, v: Vehicle, vx: number, sy: number, s: number): void {
    ctx.translate(vx, sy);
    // Wear reads before it matters: a machine on its last bodies limps, lists
    // and shakes, so the wreck is something you saw coming rather than
    // something that happened to you.
    const wear = 1 - clamp(v.hp / Math.max(1, v.maxHp), 0, 1);
    if (wear > 0.001) {
      const jolt = v.jolt > 0 ? v.jolt / 10 : 0;
      ctx.rotate(wear * 0.07 * (v.facing > 0 ? 1 : -1) + Math.sin(this.tick * 0.9) * wear * 0.02);
      ctx.translate(0, (Math.abs(Math.sin(this.tick * 0.55)) * wear * 1.6 + jolt * 1.4) * s);
    }
    const float = this.vehicleFloat(v);
    if (float !== 0) ctx.translate(0, -float * s);
  }

  /** How far off the road a machine sits when it is not standing on tyres. */
  private vehicleFloat(v: Vehicle): number {
    return v.kind === 'hyperloop_pod' ? 7 + Math.sin(this.tick * 0.12) * 1.4 : 0;
  }

  /**
   * The body on the machine.
   *
   * Two jobs the fighter's own renderer cannot do, because a Fighter has never
   * heard of a motorbike:
   *
   *   - it is drawn inside the machine's frame, so it lists with the bodywork,
   *     floats with a pod and pivots with a wheelie instead of sitting bolt
   *     upright while the bike stands on its back wheel underneath it;
   *   - on a CLOSED machine it is clipped to the cabin, so everything the
   *     bodywork covers is genuinely not drawn. A dwarf in a truck is a head
   *     and two fists behind glass; a dwarf in a pod is a silhouette in a
   *     canopy. Neither of them is a man painted over a shell.
   *
   * The seat itself — the lift onto the saddle and the pose that goes with it —
   * belongs to the Fighter, which applies it in its own render. See RideSeat.
   */
  private drawRider(ctx: C2D, cam: Camera, alpha: number, f: Fighter, v: Vehicle): void {
    const vx = lerp(v.prevX, v.x, alpha);
    const vz = lerp(v.prevZ, v.z, alpha);
    const sy = GROUND_Y + vz * Z_SCALE;
    const s = depthScale(vz);

    ctx.save();
    this.vehicleFrame(ctx, v, vx, sy, s);
    if (v.wheelie > 0) {
      const px = -16 * v.facing * s;
      ctx.translate(px, 0);
      ctx.rotate(-v.wheelie * 0.5 * v.facing);
      ctx.translate(-px, 0);
    }
    // Back to world space: the frame is now a rotation about the machine, and
    // the fighter still draws itself wherever it thinks it is.
    ctx.translate(-vx, -sy);

    const cabin = CABINS[v.kind];
    if (cabin) {
      ctx.beginPath();
      for (let i = 0; i + 1 < cabin.length; i += 2) {
        const cx = vx + cabin[i] * v.facing * s;
        const cy = sy + cabin[i + 1] * s;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.closePath();
      ctx.clip();
    }

    f.render(ctx, cam, alpha);
    ctx.restore();
  }

  /**
   * Dents, scorch, smoke and fire, in that order, as the bodies add up.
   *
   * Drawn inside the vehicle's own transform so it lists with the bodywork.
   */
  private drawVehicleWear(ctx: C2D, v: Vehicle): void {
    const wear = 1 - clamp(v.hp / Math.max(1, v.maxHp), 0, 1);
    if (wear < 0.15) return;

    // Scorching, from the front backwards.
    ctx.save();
    ctx.globalAlpha = clamp(wear * 0.85, 0, 0.7);
    // Fixed per vehicle, so the scorch sits still instead of crawling.
    const seed = Math.abs(Math.round(v.maxHp * 13 + v.kind.length * 7));
    for (let i = 0; i < 5; i++) {
      const h = ((Math.sin(seed + i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      if (h > wear) continue;
      const px = -14 + i * 9 + h * 5;
      ellipse(ctx, px, -12 - h * 9, 3 + h * 3, 2 + h * 2, h * 2, '#181420', 'none', 0);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Smoke once it is past halfway, fire on the last few bodies.
    if (wear > 0.5 && (this.tick & 3) === 0) {
      this.fx.particles({
        count: 1,
        x: v.x - v.facing * 6,
        y: 22,
        z: v.z,
        angle: -Math.PI / 2,
        spread: 0.5,
        speed: [0.3, 0.9],
        life: [26, 54],
        size: [2.5, 5],
        colors: wear > 0.8 ? ['#ff8a3d', '#4a4152'] : ['#4a4152', '#6a6478'],
        gravity: -0.03,
        drag: 0.96,
        shape: 'smoke',
      });
    }
    if (wear > 0.8 && (this.tick & 1) === 0) {
      this.fx.particles({
        count: 1,
        x: v.x - v.facing * 4,
        y: 20,
        z: v.z,
        angle: -Math.PI / 2,
        spread: 0.7,
        speed: [0.8, 2],
        life: [8, 18],
        size: [1.2, 2.6],
        colors: ['#ffe14a', '#ff8a3d'],
        gravity: -0.05,
        drag: 0.94,
        shape: 'spark',
        additive: true,
      });
    }
  }

  /** Two black streaks where the rubber went. */
  private drawSkid(ctx: C2D, v: Vehicle, vx: number, sy: number, s: number): void {
    const dir = v.vx >= 0 ? 1 : -1;
    ctx.save();
    ctx.globalAlpha = clamp(v.skid / 14, 0, 1) * 0.5;
    ctx.strokeStyle = '#100d14';
    ctx.lineWidth = 2.6 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(vx - dir * 40 * s, sy + 1);
    ctx.lineTo(vx - dir * 12 * s, sy + 1);
    ctx.moveTo(vx - dir * 34 * s, sy + 3);
    ctx.lineTo(vx - dir * 8 * s, sy + 3);
    ctx.stroke();
    ctx.restore();
  }

  /** A spoked wheel at (x, y) with radius r, turned by `spin`. */
  private drawWheel(ctx: C2D, x: number, y: number, r: number, spin: number, rim: string): void {
    ellipse(ctx, x, y, r, r, 0, '#17151c', INK, 2);
    ellipse(ctx, x, y, r * 0.42, r * 0.42, 0, rim, INK, 1.4);
    ctx.save();
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = spin + (k * Math.PI) / 3;
      ctx.moveTo(x - Math.cos(a) * r * 0.82, y - Math.sin(a) * r * 0.82);
      ctx.lineTo(x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The bike, built around the seat rather than beside it.
   *
   * The top line is a rear cowl, the dip he sits in, and then the tank hump his
   * knees close on — so there is somewhere to sit, and the thing sat on is
   * between his legs. Everything on the near side of him is in the FRONT pass.
   */
  private drawMotoBody(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    this.drawWheel(ctx, -17, -8, 8, v.spin, '#8f8aa0');
    this.drawWheel(ctx, 17, -7.5, 7.5, v.spin, '#8f8aa0');

    // swingarm, forks, and the pipe that runs down the far side
    capsule(ctx, -17, -8, -4, -14, 2.4, '#3c4152', INK, 1.6);
    capsule(ctx, 17, -7.5, 13, -25, 2.2, t.trim, INK, 1.6);
    capsule(ctx, 2, -18, -20, -9, 2.2, '#8f8aa0', INK, 1.4);

    // tank, saddle and tail, one continuous slab of colour
    poly(
      ctx,
      [-21, -20, -19, -26, -6, -25.5, 2, -26, 9, -29, 15, -24, 13, -15, -4, -13, -18, -15],
      t.body,
      INK,
      1.8,
    );
    // a lick of flame down the flank, because of course
    poly(ctx, [-14, -21.5, -4, -22.5, 4, -20, -6, -18.5], t.lamp, 'none', 0);
    // the saddle itself, which is the whole point
    roundRect(ctx, -18, -26.5, 20, 4, 2, '#241f28', INK, 1.6);
    roundRect(ctx, -10, -18, 15, 7, 2, '#4a4152', INK, 1.6);
  }

  private drawMotoFront(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    // The near side of the machine, over the near leg: the flank his knee grips,
    // the pipe under his boot, the crank cover behind his heel and the peg that
    // boot stands on. A darker shade, so the tank's top ridge still reads.
    capsule(ctx, 2, -14, -18, -9, 2.2, '#c9c4d6', INK, 1.4);
    ellipse(ctx, -3, -15.5, 4.2, 4.2, 0, '#5b6178', INK, 1.4);
    poly(ctx, [2, -24, 9, -28.5, 15, -24, 13, -18, 3, -18], shift(t.body, 0.84, 4), INK, 1.6);
    capsule(ctx, 1, -15, 8, -15, 1.5, '#c9c4d6', INK, 1.2);

    // bars and grips, closed on by the hands underneath them
    capsule(ctx, 13, -26, 20, -28, 2, '#2b2731', INK, 1.6);
    capsule(ctx, 18.5, -28.5, 23, -28, 1.7, t.trim, INK, 1.2);
    ellipse(ctx, 19, -21, 4.2, 4.6, 0, t.lamp, INK, 1.6);

    if (Math.abs(v.vx) > 1.2) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.34;
      poly(ctx, [22, -25, 54, -31, 56, -11, 22, -17], t.lamp, 'none', 0);
      ctx.restore();
    }
  }

  /**
   * The rented e-scooter. Stood on, not sat on — the deck is the seat, the
   * stem is the only thing to hold, and the near lip of the deck crosses in
   * front of both boots so he is standing ON it rather than behind it.
   */
  private drawScooterBody(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    this.drawWheel(ctx, -15, -4, 4, v.spin, '#8f8aa0');
    this.drawWheel(ctx, 13, -4, 4, v.spin, '#8f8aa0');

    capsule(ctx, -16, -9.5, -9, -9.5, 2.2, '#3c4152', INK, 1.4);
    roundRect(ctx, -17, -8, 30, 4.5, 2, t.trim, INK, 1.6);
    // the column, raked back exactly as far as nobody asked for
    capsule(ctx, 13, -5, 15, -30, 2.2, '#5b6178', INK, 1.6);
    capsule(ctx, 9, -30, 20, -30.5, 1.8, '#3c4152', INK, 1.5);
  }

  private drawScooterFront(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    // The near lip of the deck, over the soles standing on it — and the only
    // part of the thing that carries the rental company's colour.
    roundRect(ctx, -17, -7.4, 30, 3.4, 1.6, t.body, INK, 1.4);
    // grips at both ends of the bar, closed on by the hands underneath
    capsule(ctx, 9, -30, 12.5, -30.2, 1.8, '#241f28', INK, 1.2);
    capsule(ctx, 16.5, -30.4, 20, -30.5, 1.8, '#241f28', INK, 1.2);
    roundRect(ctx, 12, -34.5, 7, 4.5, 1.5, '#1d1b26', INK, 1.3);
    ellipse(ctx, 17, -27, 2.4, 2.6, 0, t.lamp, INK, 1.2);
    // the rental sticker, which is the joke
    roundRect(ctx, 12.5, -24, 5, 5, 1, t.body, INK, 1);

    if (Math.abs(v.vx) > 1.2) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.26;
      poly(ctx, [20, -28, 40, -31, 41, -18, 20, -21], t.lamp, 'none', 0);
      ctx.restore();
    }
  }

  /**
   * One wedge. That is the entire design, and it is the joke — but now it is
   * tall enough to have somebody inside it, which is what the greenhouse is
   * for: the rider is clipped to TRUCK_GLASS, so everything below the window
   * line is in the door where it belongs.
   */
  private drawTruckBody(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    this.drawWheel(ctx, -19, -9.5, 9.5, v.spin, '#6f6a7c');
    this.drawWheel(ctx, 19, -9.5, 9.5, v.spin, '#6f6a7c');

    poly(ctx, [-31, -11, -29, -32, -2, -52, 20, -50, 33, -26, 33, -11], t.body, INK, 2);
    // the cabin, unlit, so a silhouette in it reads at any distance
    poly(ctx, TRUCK_GLASS, '#171a22', 'none', 0);
    poly(ctx, [-31, -13, 33, -13, 33, -11, -31, -11], t.trim, 'none', 0);

    // The panel gaps nobody could close.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, -46);
    ctx.lineTo(-6, -13);
    ctx.moveTo(17, -45);
    ctx.lineTo(19, -13);
    ctx.stroke();
  }

  private drawTruckFront(ctx: C2D, t: VehicleTuning): void {
    // The wheel, on this side of the fists closed around it.
    ellipse(ctx, 14, -28, 4.4, 5.6, 0.35, 'none', t.trim, 1.5);

    // Glass over the driver rather than the driver over the truck.
    ctx.save();
    ctx.globalAlpha = 0.34;
    poly(ctx, TRUCK_GLASS, '#bfe8ff', 'none', 0);
    ctx.globalAlpha = 0.18;
    poly(ctx, [-16, -25, 0, -46, 8, -46, -6, -25], '#ffffff', 'none', 0);
    ctx.restore();

    // The beltline, which is also what covers the clip's cut edge.
    roundRect(ctx, -27, -25.5, 55, 2.8, 1.3, t.trim, INK, 1.2);
    capsule(ctx, -1, -47, -3, -25, 1.6, t.trim, INK, 1.2);
    roundRect(ctx, 23, -23, 10, 2.4, 1.2, t.lamp, INK, 1.2);
  }

  /**
   * The pod, rebuilt as something with an inside.
   *
   * It used to be a smooth tube with a bubble stuck on the top and the
   * passenger standing in front of the whole arrangement with a strut through
   * his face. Now the hull is a cockpit with a coaming, the rider is clipped to
   * POD_CANOPY, and the canopy goes over him translucent — so he is in there,
   * and you can see he is in there.
   */
  private drawPodBody(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    // The cushion of air it rides on, left down on the road where it belongs.
    const f = this.vehicleFloat(v);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.4;
    ellipse(ctx, 0, f - 3, 26, 4.5, 0, t.trim, 'none', 0);
    ctx.restore();

    capsule(ctx, -20, -16, 14, -16, 10, t.body, INK, 2);
    poly(ctx, [14, -26, 34, -17, 34, -11, 14, -6], t.body, INK, 1.8);
    poly(ctx, [-20, -26, -30, -32, -28, -10, -20, -4], t.trim, INK, 1.6);
    // headrest, seen behind him through the glass
    roundRect(ctx, -13, -42, 7, 16, 3, shift(t.trim, 0.7, 0), INK, 1.4);
    roundRect(ctx, -14, -14, 26, 3, 1.5, t.trim, 'none', 0);
    ellipse(ctx, 31, -16, 2.6, 2.6, 0, t.lamp, INK, 1.2);

    if (Math.abs(v.vx) > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(Math.abs(v.vx) / 9, 0.2, 0.7);
      ellipse(ctx, -32, -16, 9, 5, 0, t.trim, 'none', 0);
      ellipse(ctx, -28, -16, 5, 3, 0, '#ffffff', 'none', 0);
      ctx.restore();
    }
  }

  private drawPodFront(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    ctx.save();
    ctx.globalAlpha = 0.34;
    poly(ctx, POD_CANOPY, '#cdf1ff', 'none', 0);
    ctx.globalAlpha = 0.22;
    poly(ctx, [-11, -30, -6, -49, 1, -52, -4, -30], '#ffffff', 'none', 0);
    ctx.restore();

    // The frame of the canopy, and the coaming that hides the clip's cut edge.
    poly(ctx, POD_CANOPY, 'none', t.trim, 1.4);
    roundRect(ctx, -17, -27.5, 36, 3, 1.5, t.trim, INK, 1.4);
    if (Math.abs(v.vx) > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.3;
      poly(ctx, [19, -30, 44, -34, 45, -18, 19, -22], t.trim, 'none', 0);
      ctx.restore();
    }
  }

  /**
   * Not a cockpit: a man astride a firework, holding a bar.
   *
   * Nothing is clipped here — he is on TOP of the hull and meant to be seen —
   * so the occlusion is the straps and the grab bar going over his lap, his
   * shin and his fists in the front pass.
   */
  private drawRocketBody(ctx: C2D, v: Vehicle, t: VehicleTuning): void {
    // The sled it is bolted to, since nobody thought about landing.
    this.drawWheel(ctx, -18, -5, 5, v.spin, '#6f6a7c');
    this.drawWheel(ctx, 14, -5, 5, v.spin, '#6f6a7c');
    capsule(ctx, -20, -7, 18, -7, 2.4, t.trim, INK, 1.6);

    if (Math.abs(v.vx) > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 + 0.25 * Math.sin(this.tick * 0.6);
      poly(ctx, [-22, -22, -44, -17, -22, -12], t.lamp, 'none', 0);
      poly(ctx, [-22, -20, -34, -17, -22, -14], '#ffffff', 'none', 0);
      ctx.restore();
    }

    capsule(ctx, -18, -18, 14, -18, 9, t.body, INK, 2);
    poly(ctx, [14, -27, 32, -18, 14, -9], t.body, INK, 1.8);
    poly(ctx, [-18, -27, -26, -32, -24, -12, -18, -9], t.trim, INK, 1.6);
    // the pad he is sitting on, such as it is
    roundRect(ctx, -9, -29.5, 17, 3.5, 1.7, '#241f28', INK, 1.4);
    ellipse(ctx, 26, -18, 2.4, 2.4, 0, t.lamp, INK, 1.2);
  }

  private drawRocketFront(ctx: C2D, t: VehicleTuning): void {
    // Two straps over the lap and the shin, and a bar to hang on to. This is
    // not a cockpit; it is a man tied to a firework.
    capsule(ctx, -7, -30.5, 6, -26, 2, t.trim, INK, 1.3);
    capsule(ctx, -5, -22, 7, -20, 1.8, t.trim, INK, 1.2);
    capsule(ctx, 12.5, -29.2, 21, -27.5, 1.8, '#2b2731', INK, 1.4);
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

/**
 * The rig's depth perspective, exactly as `Fighter.render` applies it.
 *
 * A machine is drawn through this too, so a bike and the body on it shrink
 * together as they walk away from the camera instead of the rider quietly
 * losing a tenth of his height while the bike keeps all of its own.
 */
function depthScale(z: number): number {
  return clamp(1 - (Z_DEPTH - z) * Z_PERSPECTIVE, 0.75, 1);
}

function weaponOf(v: unknown): WeaponKind | null {
  if (typeof v === 'string' && v in WEAPONS) return v as WeaponKind;
  return null;
}

function weaponName(kind: WeaponKind | null): string {
  if (!kind) return 'WEAPON';
  return WEAPONS[kind]?.name.toUpperCase() ?? 'WEAPON';
}

/**
 * Being hit by a moving vehicle.
 *
 * Blowback, so it launches and then bounces off the wall, and damage that
 * climbs with speed — the difference between being nudged in a car park and
 * being taken off your feet at forty is the entire appeal.
 */
function ramHit(speed: number, mul: number): HitProperties {
  const power = clamp(speed / 8, 0.25, 1.25);
  return {
    damage: (8 + speed * 2.1) * mul,
    hitstun: 28,
    blockstun: 16,
    hitstop: 6,
    knockback: { x: 7 + speed * 0.7, y: 4.4 + power * 2 },
    pushback: 0,
    reaction: 'blowback',
    level: 'mid',
    chip: DEFAULT_CHIP,
    meterGain: 0.04,
    meterGainVictim: 0.06,
    shake: 6,
    sfx: 'bone_crack',
  };
}

/**
 * The wreck going up.
 *
 * Light damage and a knockdown rather than a kill: this is a punctuation mark
 * on a rampage, not a punishment for having enjoyed one. The driver takes the
 * same hit as everyone else, which is only fair — he was sitting on it.
 */
function blastHit(isRider: boolean): HitProperties {
  return {
    damage: isRider ? VEHICLE_BLAST_DAMAGE * 0.7 : VEHICLE_BLAST_DAMAGE,
    hitstun: 30,
    blockstun: 18,
    hitstop: 6,
    knockback: { x: 6.5, y: 6 },
    pushback: 0,
    reaction: 'sweep',
    level: 'mid',
    chip: DEFAULT_CHIP,
    meterGain: 0,
    meterGainVictim: 0.08,
    shake: 10,
    sfx: 'explosion',
  };
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
