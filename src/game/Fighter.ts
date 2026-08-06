/**
 * The shared body for players, enemies and bosses.
 *
 * A Fighter owns its physics, its state machine, its move execution and every
 * defensive/offensive resource (health, meter, stun, weapon durability). It has
 * no idea whether the InputFrame it is handed came from a keyboard, a gamepad,
 * an AI or a network peer — which is the whole point.
 *
 * DETERMINISM: everything in `update`, `takeHit`, `startMove` and the weapon
 * plumbing is sim code. No Math.random, no wall clock. Presentation calls go
 * through ctx.fx / ctx.audio, which are inert during rollback.
 *
 * `render` is the only method allowed to be sloppy, and even it is not: the
 * whole thing is a pure function of the interpolated sim state.
 */

import type {
  Bone,
  FaceState,
  Facing,
  FighterState,
  FighterView,
  HitProperties,
  HitReaction,
  HitWindow,
  InputFrame,
  MoveDef,
  RigDamage,
  RigStyle,
  Settings,
  SimContext,
  Team,
  Vec3,
  VoiceProfile,
  WeaponDef,
  WeaponKind,
} from '@/core/types';
import { Btn } from '@/core/types';
import type { Camera } from '@/render/Camera';
import { approach, clamp, hashNumber, lerp, sign } from '@/core/math';
import {
  AIR_FRICTION,
  COMBO_RESET_FRAMES,
  COMBO_SCALING,
  COYOTE_FRAMES,
  DASH_FRAMES,
  DASH_SPEED,
  DEFAULT_CHIP,
  DOUBLE_TAP_FRAMES,
  GRAVITY,
  GROUND_FRICTION,
  GROUND_Y,
  IMPACT_FLASH_FRAMES,
  INPUT_BUFFER_FRAMES,
  JUMP_VELOCITY,
  KNOCKDOWN_FRAMES,
  KO_HITSTOP,
  KO_SLOWMO_FRAMES,
  KO_SLOWMO_SCALE,
  MAX_FALL_SPEED,
  MAX_METER_BARS,
  MIN_DAMAGE_SCALE,
  PARRY_FRAMES,
  PARRY_METER,
  RUN_SPEED,
  SEPARATION_FORCE,
  STUN_DECAY_PER_FRAME,
  STUN_DURATION,
  STUN_THRESHOLD,
  VIEW_W,
  WAKEUP_INVULN,
  WALK_SPEED,
  WALL_BOUNCE,
  Z_DEPTH,
  Z_FRICTION,
  Z_HIT_TOLERANCE,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { drawBossRig, hasBossRig } from '@/render/rig/BossRigs';
import type { BossRigKind } from '@/render/rig/BossRigs';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { getMove } from '@/game/combat/Moves';
import { WEAPONS } from '@/content/weapons';

type C2D = CanvasRenderingContext2D;

/**
 * The rig's draw options, plus the damage channel.
 *
 * Intersected rather than redeclared so this stays exactly one type: whatever
 * `drawCharacter` accepts today, plus `damage`. When the rig grows the option
 * itself the intersection collapses to the rig's own declaration and nothing
 * here has to change.
 */
type RigOpts = NonNullable<Parameters<typeof drawCharacter>[7]> & { damage?: RigDamage };

export interface FighterInit {
  id: number;
  team: Team;
  x: number;
  z: number;
  style: RigStyle;
  skeleton: Bone[];
  health: number;
  speed: number;
  power: number;
  jump?: number;
  moves: Record<string, string>;
  voice: VoiceProfile;
  archetype: string;
  isBoss?: boolean;
  /**
   * Bespoke body for a boss that is not a person — a dog, a car, a rocket.
   *
   * BossDef.rigOverride existed for seventy maps and was consulted for nothing
   * but the choice of skeleton, so the Shiba Inu was a spiky orange dwarf
   * skeleton at 1.7 scale. Set this and the fighter is drawn by BossRigs
   * instead of by drawCharacter.
   */
  bossRig?: BossRigKind;
}

/** Buffered action slots. These map to move ids through `moves`. */
type Action = 'light' | 'heavy' | 'special' | 'grab' | 'super' | 'jump';

export type GoreLevel = Settings['gore'];

/**
 * How much viscera the player asked for.
 *
 * A Fighter must not reach into `Game` or a `Settings` object it does not own —
 * it is constructed by content code, long before anybody knows which save file
 * is loaded — so the preference lives here as one module-level value the game
 * sets once at boot and whenever the option changes. It is deliberately NOT
 * part of the simulation: it never touches physics, damage or the checksum, so
 * two peers with different gore settings still agree on the fight.
 */
let goreSetting: GoreLevel = 'on';

/** Called by the game when settings load or change. */
export function setGoreLevel(level: GoreLevel): void {
  goreSetting = level === 'off' || level === 'max' ? level : 'on';
}

export function goreLevel(): GoreLevel {
  return goreSetting;
}

/** Particle-count multiplier for the current gore setting. */
export function goreScale(): number {
  return goreSetting === 'max' ? 1.8 : goreSetting === 'off' ? 0.75 : 1;
}

/** Wet palettes, and the dry ones that stand in for them when gore is off. */
const BLOOD_COLORS = ['#e8514f', '#b6262c', '#f2a3a0'];
const BLOOD_DEEP = ['#e8514f', '#b6262c', '#3b2f35'];
const SPARK_COLORS = ['#ffe08a', '#ffb03a', '#9fd8ff'];
const DEBRIS_COLORS = ['#ffd166', '#ff8a2a', '#9fd8ff', '#5a5f6b'];
/** Dust and sweat: what a hit throws when the player wants no blood. */
const DRY_COLORS = ['#f4f0e6', '#cfc6b8', '#a89e90'];

const ACTION_PRIORITY: readonly [number, Action][] = [
  [Btn.Super, 'super'],
  [Btn.Special, 'special'],
  [Btn.Grab, 'grab'],
  [Btn.Heavy, 'heavy'],
  [Btn.Light, 'light'],
  [Btn.Jump, 'jump'],
];

/**
 * Frames a direction must be held before a walk rolls into a run.
 *
 * This is the KEYBOARD rule, and only the keyboard rule: a digital direction has
 * no magnitude, so the only thing left to read intent from is time. An analog
 * stick says it outright through `Btn.Run` and never waits (see `wantsRun`).
 */
const RUN_HOLD_FRAMES = 12;
/** Landing recovery. Short, and cancellable out of. */
const LAND_FRAMES = 8;
/** Matches the `getup` clip so the animation lands exactly on actionable. */
const GETUP_FRAMES = 30;
/** Frames a grabbed fighter is held before slipping free on their own. */
const GRAB_HOLD_FRAMES = 70;
/** Default walk-on for spawned enemies. */
const ENTRY_FRAMES = 34;
/** Body half-width used for shoving fighters apart. */
const BODY_HALF_W = 9;
/** Air acceleration per frame while holding a direction. */
const AIR_ACCEL = 0.34;
/** Depth movement is slower than horizontal — belt-scroller convention. */
const Z_SPEED_SCALE = 0.62;
/** Extra pop given to a launch so a juggle always gets off the ground. */
const MIN_LAUNCH_VELOCITY = 7.6;
/** Each subsequent air hit in a juggle carries this much less knockback. */
const JUGGLE_DECAY = 0.42;
const MIN_JUGGLE_SCALE = 0.22;

// ── Interaction & riding ─────────────────────────────────────────────────────
// A Fighter cannot see the floor it is standing on: what is within reach is the
// Level's business. So the interact button is LATCHED here and answered there,
// which keeps "am I able to reach for something" (a body question) apart from
// "is there anything to reach for" (a world question).

/**
 * Frames a `Btn.Interact` press waits for the Level to answer it.
 *
 * Edge-triggered on purpose. Holding the key must never pinball between two
 * weapons lying next to each other on consecutive frames — one press, one
 * exchange, and the buffer only exists so a press a few frames before you get
 * in range still lands.
 */
const INTERACT_BUFFER_FRAMES = 8;

/** Top speed on a vehicle: twice a run, and it is meant to feel like it. */
const RIDE_TOP_SPEED = 7.4;
const RIDE_ACCEL = 0.42;
/** Hard on the anchors — braking and turning are the same act to a tyre. */
const RIDE_BRAKE = 0.66;
/** Coasting is deliberately lazy. A vehicle carries momentum; legs do not. */
const RIDE_COAST = 0.055;
const RIDE_Z_SPEED = 1.9;
/** Above this a turn or a brake tears rubber off, audibly. */
const RIDE_SCREECH_SPEED = 3.6;
const RIDE_SCREECH_FRAMES = 14;
/** Frames between engine barks. Roughly the length of the cue itself. */
const RIDE_ENGINE_INTERVAL = 56;
/** Throttle blip: what an attack from the saddle is, physically. */
const RIDE_LUNGE = 3.4;
const RIDE_SWING_FRAMES = 13;
/** Frames the front wheel stays up. Purely so the player can show off. */
const RIDE_WHEELIE_FRAMES = 30;
/** Speed the wheelie itself adds, because of course it does. */
const RIDE_WHEELIE_BOOST = 1.6;
/** Dizzy meter added per hit, by reaction. */
const STUN_BUILD: Record<HitReaction, number> = {
  light: 1,
  heavy: 2.2,
  launch: 2.6,
  sweep: 1.8,
  crumple: 3.4,
  blowback: 3,
  stun: 0,
};

// ── Damage state tuning ──────────────────────────────────────────────────────
// Everything here drives how chewed up a fighter LOOKS. None of it feeds back
// into the fight.

/**
 * Extra wear per hit, as a multiple of the fraction of max health it took.
 * Health alone sets a floor; this is what puts a fighter who has been through a
 * meat grinder ahead of one who was chipped down politely.
 */
const WEAR_PER_HIT = 0.55;
/** Blood picked up per hit, as a multiple of the fraction of health it took. */
const BLOOD_PER_HIT = 1.3;
/** Blood at the 'max' setting soaks in faster. */
const BLOOD_GORE_MAX = 1.7;
/** Breath chases health this fast, so a burst of damage lands before the gasp. */
const BREATH_LAG = 0.009;
/** Breath kicked up by a hit (scaled by how hard) and by spending a dash. */
const BREATH_HIT_SPIKE = 0.34;
const BREATH_BLOCK_SPIKE = 0.06;
const BREATH_DASH_SPIKE = 0.16;
const BREATH_SPIKE_MAX = 0.55;
const BREATH_SPIKE_DECAY = 0.008;
/** Frames a hard knock keeps the jaw set, even at full health. */
const STRAIN_FRAMES = 48;
/** A hit worth this fraction of max health reads as "hard". */
const HARD_HIT_FRAC = 0.06;
/** ...and one worth this much takes the hat with it. */
const HAT_HIT_FRAC = 0.16;
/** Reactions violent enough to send the hat flying on their own. */
const HAT_LOSING: Record<HitReaction, boolean> = {
  light: false,
  heavy: false,
  launch: true,
  sweep: false,
  crumple: true,
  blowback: true,
  stun: true,
};

const STATE_CODE: Record<FighterState, number> = {
  idle: 0,
  walk: 1,
  run: 2,
  dash: 3,
  jump: 4,
  fall: 5,
  land: 6,
  attack: 7,
  block: 8,
  blockstun: 9,
  hurt: 10,
  launched: 11,
  knockdown: 12,
  getup: 13,
  grabbing: 14,
  grabbed: 15,
  thrown: 16,
  stunned: 17,
  super: 18,
  riding: 19,
  entering: 20,
  victory: 21,
  dead: 22,
};

/** Name segments that mean "appliance": these spark and leak instead of bleed. */
const MECHANICAL_PARTS = new Set([
  'bot',
  'robot',
  'drone',
  'iot',
  'fridge',
  'speaker',
  'vacuum',
  'truck',
  'cybertruck',
  'rocket',
  'machine',
  'turret',
]);

/**
 * Bosses whose names give nothing away. Lane Assist is a car, the Boring
 * Machine is a drill, Optimus and Grok are robots and Starship is a rocket —
 * all of which should be throwing sparks. Subject P-47 and Snow White Mk. II
 * are not on this list on purpose: an implant and a clone are still meat.
 */
const MECHANICAL_IDS = new Set(['fsd', 'boring', 'optimus', 'grok', 'starship']);

/**
 * Does this thing bleed, or does it spark?
 *
 * Matched on whole underscore-separated segments rather than as a substring,
 * because `riot_guard` contains "iot" and a naive search turns a man in a
 * helmet into an internet-connected fridge.
 */
export function isMechanicalArchetype(archetype: string): boolean {
  const a = archetype.toLowerCase();
  if (MECHANICAL_IDS.has(a)) return true;
  let start = 0;
  for (let i = 0; i <= a.length; i++) {
    if (i < a.length && a.charCodeAt(i) !== 95 /* _ */) continue;
    if (i > start && MECHANICAL_PARTS.has(a.slice(start, i))) return true;
    start = i + 1;
  }
  return false;
}

/** Moves are authored by other modules; a bad id must not take the game down. */
function lookupMove(id: string): MoveDef | null {
  if (!id) return null;
  try {
    const m = getMove(id);
    return m ?? null;
  } catch {
    return null;
  }
}

export class Fighter implements FighterView {
  readonly id: number;
  readonly team: Team;
  readonly archetype: string;
  readonly isBoss: boolean;

  readonly pos: Vec3;
  readonly vel: Vec3 = { x: 0, y: 0, z: 0 };
  facing: Facing = 1;
  state: FighterState = 'idle';
  stateFrame = 0;
  grounded = true;

  health: number;
  readonly maxHealth: number;
  meter = 0;
  comboCount = 0;

  weapon: WeaponKind | null = null;

  readonly style: RigStyle;
  readonly skeleton: Bone[];
  readonly voice: VoiceProfile;
  readonly moves: Record<string, string>;

  /** Ambient tint from the map palette, set by the Level. */
  tint: string | null = null;
  /** Map walls. Blowback bounces off these; Infinity means "no wall here". */
  minX = Number.NEGATIVE_INFINITY;
  maxX = Number.POSITIVE_INFINITY;
  /** Score awarded to whoever kills this one. Filled in by content. */
  points = 0;
  /**
   * Where `render()` last put this body, with the renderer's interpolation
   * already applied.
   *
   * Presentation only: written by the renderer, never read by the simulation and
   * never checksummed. It exists so screen-space overlays (the HUD's player
   * markers) can hang off the fighter the renderer actually drew rather than off
   * `pos`, which is a whole sim step ahead of it — a full step is eleven world
   * units at the top of a jump, and a marker that far off the head reads as a
   * bug.
   */
  readonly drawPos: Vec3;

  /**
   * How wrecked this body looks. Maintained here, consumed by the rig — the
   * simulation never reads it back, which is what lets it hold a local setting
   * (gore) without putting a netplay desync in the checksum.
   */
  readonly damage: RigDamage;

  private readonly baseMoves: Record<string, string>;
  private readonly speedStat: number;
  private readonly powerStat: number;
  private readonly jumpStat: number;
  /**
   * Made of metal rather than meat. Public because the fatality director needs
   * it too: a fridge should shower sparks when it is torn open, not blood.
   */
  readonly mechanical: boolean;
  /** Non-humanoid boss body, when this fighter has one. */
  readonly bossRig: BossRigKind | null;

  private readonly prevPos: Vec3;
  private age = 0;

  private currentMove: MoveDef | null = null;
  private moveConnected = false;
  private whiffed = false;

  private hitstunTimer = 0;
  private knockdownTimer = 0;
  private parryTimer = 0;
  private invulnFrames = 0;
  private dizzyMeter = 0;
  private dizzyTimer = 0;
  private comboTimer = 0;
  private juggleCount = 0;
  private wallBounce = false;
  private pendingKnockdown = false;
  private hurtClip: 'hurt_light' | 'hurt_heavy' = 'hurt_light';

  private bufAction: Action | null = null;
  private bufFrames = 0;
  private wantDash = 0;
  private coyote = COYOTE_FRAMES;
  private dashTimer = 0;
  private dashDir: Facing = 1;
  private holdDir = 0;
  private holdFrames = 0;
  /** `Btn.Run` on this frame: the stick is pushed near its limit. */
  private runHeld = false;
  /**
   * True once this fighter is known to be driven by something with a magnitude.
   *
   * `Btn.Run` is the only analog signal that fits on the wire, so its first
   * appearance is also the proof that this input HAS an analog axis — from that
   * point on the hold timer is ignored and the stick alone decides walk or run.
   * A keyboard never sets the bit, never latches this, and keeps its
   * hold-to-run behaviour untouched.
   *
   * Latched from the input mask alone, and deliberately not settable from
   * outside: the mask is what lockstep transmits, so every peer derives this
   * from the same frames and reaches the same answer. A setter called only on
   * the machine the pad is plugged into would be a desync waiting for the first
   * player who walks before they run.
   */
  private analogMove = false;
  private tapDir = 0;
  private tapAge = 999;
  private heldMask = 0;
  private inX = 0;
  private inZ = 0;
  private entryTimer = 0;

  private weaponDurability = 0;
  private weaponAmmo = 0;
  private weaponSpeed = 1;
  private pickupFrames = 0;

  /** Frames left on an unanswered interact press. See INTERACT_BUFFER_FRAMES. */
  private interactFrames = 0;
  /**
   * The vehicle's own horizontal speed.
   *
   * Held separately from `vel.x` because ground friction eats `vel.x` every
   * frame — that is correct for a pair of legs and wrong for a machine with
   * momentum, so the ride writes its speed into `vel.x` fresh each frame and
   * keeps the real value here.
   */
  private rideVel = 0;
  /** Speed multiplier for the thing being ridden. A pod is not a moto. */
  private rideBoost = 1;
  private rideWheelie = 0;
  private rideSwing = 0;
  /**
   * The live hitbox of a swing from the saddle. A FRESH object per swing: the
   * combat registry keys "already hit" on window identity, and reusing one
   * object would let a rider connect with each enemy exactly once per ride.
   */
  private rideWindow: HitWindow | null = null;
  /** Frames of tyre smoke owed. Presentation reads it; nothing else does. */
  private rideScreech = 0;
  private rideEngine = 0;

  private grabHolder: Fighter | null = null;
  private grabTimer = 0;

  private flash = 0;
  private animClip = 'idle';
  private animFrame = 0;
  private prevAnimFrame = 0;

  /** Monotonic: a torn jacket does not mend when a burger restores health. */
  private wearAccum = 0;
  private bloodAccum = 0;
  private breathBase = 0;
  private breathSpike = 0;
  private strainTimer = 0;

  /**
   * Reused draw options. `render` runs sixty times a second for every body on
   * screen, so it hands the rig the same object every frame instead of minting
   * a fresh one for the garbage collector.
   */
  private readonly rigOpts: RigOpts = {
    weapon: null,
    flash: 0,
    tint: undefined,
    alpha: 1,
    scale: 1,
    damage: undefined,
  };

  constructor(init: FighterInit) {
    this.id = init.id;
    this.team = init.team;
    this.archetype = init.archetype;
    this.isBoss = init.isBoss === true;
    this.pos = { x: init.x, y: 0, z: clamp(init.z, 0, Z_DEPTH) };
    this.prevPos = { x: this.pos.x, y: 0, z: this.pos.z };
    this.drawPos = { x: this.pos.x, y: 0, z: this.pos.z };
    this.maxHealth = Math.max(1, init.health);
    this.health = this.maxHealth;
    this.style = init.style;
    this.skeleton = init.skeleton;
    this.voice = init.voice;
    this.moves = { ...init.moves };
    this.baseMoves = { ...init.moves };
    this.speedStat = clamp(init.speed || 1, 0.2, 3);
    this.powerStat = clamp(init.power || 1, 0.1, 5);
    this.jumpStat = clamp(init.jump ?? 1, 0.4, 2.5);
    this.mechanical = isMechanicalArchetype(init.archetype);
    this.bossRig = init.bossRig ?? null;
    this.damage = {
      wear: 0,
      breath: 0,
      face: 'calm',
      // Stable for the life of this body, so its tears and stains sit in the
      // same places every frame instead of crawling across the cloth.
      seed: hashNumber(0x9e3779b9, init.id) >>> 0,
      blood: 0,
      hatless: false,
    };
  }

  // ── queries ────────────────────────────────────────────────────────────────

  get alive(): boolean {
    return this.health > 0 && this.state !== 'dead';
  }

  /** True while nothing can touch this fighter. */
  get invulnerable(): boolean {
    return this.invulnFrames > 0 || this.state === 'entering' || this.state === 'dead';
  }

  get weaponDef(): WeaponDef | null {
    return this.weapon ? (WEAPONS[this.weapon] ?? null) : null;
  }

  /** Damage multiplier this fighter applies to every hit it lands. */
  get damageMul(): number {
    const w = this.weaponDef;
    return this.powerStat * (w ? w.damageScale : 1);
  }

  private get moveSpeed(): number {
    return this.speedStat * this.weaponSpeed;
  }

  // ── per-frame simulation ───────────────────────────────────────────────────

  update(input: InputFrame, ctx: SimContext): void {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevPos.z = this.pos.z;
    this.prevAnimFrame = this.animFrame;
    this.age++;

    this.tickTimers();

    if (this.state === 'dead') {
      this.physics(ctx);
      this.updateAnim();
      this.updateDamage();
      return;
    }

    this.readInput(input);

    switch (this.state) {
      case 'idle':
      case 'walk':
      case 'run':
      case 'land':
        this.updateGround(ctx);
        break;
      case 'dash':
        this.updateDash(ctx);
        break;
      case 'jump':
      case 'fall':
        this.updateAir(ctx);
        break;
      case 'attack':
      case 'super':
      case 'grabbing':
        this.updateMove(ctx);
        break;
      case 'block':
        this.updateBlock(ctx);
        break;
      case 'blockstun':
        this.updateBlockstun();
        break;
      case 'hurt':
        this.updateHurt(ctx);
        break;
      case 'launched':
      case 'thrown':
        this.stateFrame++;
        break;
      case 'knockdown':
        this.updateKnockdown();
        break;
      case 'getup':
        this.updateGetup(ctx);
        break;
      case 'grabbed':
        this.updateGrabbed(ctx);
        break;
      case 'stunned':
        this.updateStunned();
        break;
      case 'riding':
        this.updateRiding(ctx);
        break;
      case 'entering':
        this.updateEntering();
        break;
      case 'victory':
        this.stateFrame++;
        break;
    }

    this.physics(ctx);
    this.separate(ctx);
    this.updateAnim();
    this.updateDamage();
  }

  // ── damage state ───────────────────────────────────────────────────────────

  /**
   * Derives the whole `RigDamage` block from this frame's sim state.
   *
   * Deterministic — it reads health, state and its own accumulators and nothing
   * else — but its output is presentation only, so the local gore setting can
   * safely reach in here and zero the blood without any peer noticing.
   */
  private updateDamage(): void {
    const d = this.damage;
    const hp = clamp(this.health / this.maxHealth, 0, 1);

    // Health sets a floor; hits taken push above it. The value only ever
    // climbs, so healing patches the health bar and not the jacket.
    const floor = 1 - hp;
    if (floor > this.wearAccum) this.wearAccum = floor;
    d.wear = clamp(this.wearAccum, 0, 1);

    // Breath lags health rather than tracking it, and spikes on exertion, so a
    // fighter is still catching up on air a second after the exchange ended.
    this.breathBase = approach(this.breathBase, 1 - hp, BREATH_LAG);
    if (this.breathSpike > 0) {
      this.breathSpike = Math.max(0, this.breathSpike - BREATH_SPIKE_DECAY);
    }
    d.breath = clamp(this.breathBase + this.breathSpike, 0, 1);

    if (this.strainTimer > 0) this.strainTimer--;
    d.face = this.faceState(hp);
    d.blood = goreSetting === 'off' ? 0 : clamp(this.bloodAccum, 0, 1);
  }

  private faceState(hp: number): FaceState {
    if (this.health <= 0 || this.state === 'dead') return 'dead';
    if (this.state === 'stunned' || this.dizzyTimer > 0) return 'dazed';
    if (hp < 0.15) return 'exhausted';
    if (hp < 0.35) return 'angry';
    if (hp < 0.65) return 'strained';
    // Even a fresh fighter grits their teeth for a moment after a real one.
    return this.strainTimer > 0 ? 'strained' : 'calm';
  }

  /** Books the cosmetic cost of a hit: wear, blood, breath, hat. */
  private recordDamage(
    amount: number,
    reaction: HitReaction,
    ctx: SimContext,
  ): void {
    const frac = clamp(amount / this.maxHealth, 0, 1);
    this.wearAccum = clamp(this.wearAccum + frac * WEAR_PER_HIT, 0, 1);
    const soak = goreSetting === 'max' ? BLOOD_GORE_MAX : 1;
    this.bloodAccum = clamp(this.bloodAccum + frac * BLOOD_PER_HIT * soak, 0, 1);
    this.breathSpike = Math.min(
      BREATH_SPIKE_MAX,
      this.breathSpike + BREATH_HIT_SPIKE * (0.45 + frac * 3),
    );

    const hard = frac >= HARD_HIT_FRAC || reaction !== 'light';
    if (hard) this.strainTimer = STRAIN_FRAMES;
    if (!this.damage.hatless && (frac >= HAT_HIT_FRAC || HAT_LOSING[reaction])) {
      this.knockHatOff(ctx);
    }
  }

  /**
   * The hat comes off for good — knocked loose here, or taken by the fatality
   * director when something eats it or puts it on a roof.
   */
  knockHatOff(ctx?: SimContext): void {
    if (this.damage.hatless) return;
    this.damage.hatless = true;
    if (!ctx) return;
    ctx.fx.particles({
      count: 5,
      x: this.pos.x,
      y: this.pos.y + 46,
      z: this.pos.z,
      // Up and behind: the hat leaves in the direction the blow was going.
      angle: this.facing > 0 ? Math.PI * 0.68 : Math.PI * 0.32,
      spread: 1.1,
      speed: [1.4, 3.6],
      life: [14, 30],
      size: [1.4, 3],
      colors: [this.style.hatColor, this.style.hair, '#2b2229'],
      gravity: 0.2,
      drag: 0.94,
      shape: 'shard',
      fade: 'ease',
      spin: 0.4,
    });
  }

  /** Smears more blood on. For the fatality director's benefit. */
  addBlood(amount: number): void {
    if (amount <= 0) return;
    this.bloodAccum = clamp(this.bloodAccum + amount, 0, 1);
  }

  private tickTimers(): void {
    if (this.bufFrames > 0) {
      this.bufFrames--;
      if (this.bufFrames === 0) this.bufAction = null;
    }
    if (this.invulnFrames > 0) this.invulnFrames--;
    if (this.parryTimer > 0) this.parryTimer--;
    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer === 0) this.comboCount = 0;
    }
    if (this.pickupFrames > 0) this.pickupFrames--;
    if (this.interactFrames > 0) this.interactFrames--;
    if (this.rideScreech > 0) this.rideScreech--;
    if (this.rideWheelie > 0) this.rideWheelie--;
    if (this.tapAge < 999) this.tapAge++;
    if (this.dizzyMeter > 0) {
      this.dizzyMeter = Math.max(0, this.dizzyMeter - STUN_DECAY_PER_FRAME);
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.14);
  }

  private readInput(input: InputFrame): void {
    this.heldMask = input.held;
    let dx = 0;
    if (input.held & Btn.Left) dx -= 1;
    if (input.held & Btn.Right) dx += 1;
    let dz = 0;
    // z=0 is the BACK of the walkable band and z=Z_DEPTH is nearest the camera
    // (see Backdrop's FLOOR_TOP/FLOOR_BOTTOM, which is what the art is drawn
    // against). Walking "up" therefore means walking away from the camera, into
    // smaller z. Having these the other way round inverted the whole d-pad.
    if (input.held & Btn.Up) dz -= 1;
    if (input.held & Btn.Down) dz += 1;
    this.inX = dx;
    this.inZ = dz;

    // "I mean it": the stick is at its limit. A source that has ever said this
    // is analog, and an analog source is never asked to hold a direction to
    // prove it wants to run.
    this.runHeld = (input.held & Btn.Run) !== 0;
    // Per frame, not latched: before this, a stick held gently still rolled
    // into a run after RUN_HOLD_FRAMES for the whole opening of a fight,
    // because the fighter did not yet know its input was analog.
    this.analogMove = (input.held & Btn.Analog) !== 0;

    if (dx !== 0 && dx === this.holdDir) this.holdFrames++;
    else {
      this.holdDir = dx;
      this.holdFrames = dx === 0 ? 0 : 1;
    }

    // double tap -> dash
    const pressedDir = input.pressed & Btn.Left ? -1 : input.pressed & Btn.Right ? 1 : 0;
    if (pressedDir !== 0) {
      if (pressedDir === this.tapDir && this.tapAge <= DOUBLE_TAP_FRAMES) {
        this.tapDir = 0;
        this.tapAge = 999;
        this.wantDash = pressedDir;
      } else {
        this.tapDir = pressedDir;
        this.tapAge = 0;
      }
    }

    // Latched, never held: one press is one exchange. The Level clears it the
    // moment it acts on it; otherwise it simply expires.
    if (input.pressed & Btn.Interact) this.interactFrames = INTERACT_BUFFER_FRAMES;

    for (const [mask, act] of ACTION_PRIORITY) {
      if (input.pressed & mask) {
        this.bufAction = act;
        this.bufFrames = INPUT_BUFFER_FRAMES;
        break;
      }
    }
  }

  // ── interaction ────────────────────────────────────────────────────────────

  /** True while an interact press is still waiting for the Level to answer. */
  get interactPending(): boolean {
    return this.interactFrames > 0;
  }

  /** The Level has acted on the press (or refused it for good). Drop it. */
  consumeInteract(): void {
    this.interactFrames = 0;
  }

  /**
   * Are both hands free and both feet on the floor?
   *
   * Nobody swaps a bat mid-uppercut, mid-flinch, off the floor or in the air.
   * Riding is deliberately absent: getting off is handled by the Level, which
   * is the only thing that knows what is being ridden.
   */
  get canInteract(): boolean {
    if (!this.alive || !this.grounded) return false;
    switch (this.state) {
      case 'idle':
      case 'walk':
      case 'run':
      case 'land':
      case 'block':
        return this.hitstunTimer <= 0;
      default:
        return false;
    }
  }

  /** True while this fighter is on a vehicle. */
  get riding(): boolean {
    return this.state === 'riding';
  }

  /** Signed speed of the thing being ridden. Zero when on foot. */
  get rideSpeed(): number {
    return this.state === 'riding' ? this.rideVel : 0;
  }

  /** Frames of tyre smoke still owed, for whoever is drawing the vehicle. */
  get rideSkid(): number {
    return this.rideScreech;
  }

  /** 0..1: how far the front wheel is off the floor. */
  get rideWheelieAmount(): number {
    return this.rideWheelie > 0 ? clamp(this.rideWheelie / RIDE_WHEELIE_FRAMES, 0, 1) : 0;
  }

  // ── physics ────────────────────────────────────────────────────────────────

  private physics(ctx: SimContext): void {
    const p = this.pos;
    const v = this.vel;
    const wasGrounded = this.grounded;

    if (!this.grounded) {
      v.y -= GRAVITY;
      if (v.y < -MAX_FALL_SPEED) v.y = -MAX_FALL_SPEED;
    }

    p.x += v.x;
    p.z += v.z;
    p.y += v.y;

    if (p.x < this.minX) {
      p.x = this.minX;
      this.hitWall(ctx, 1);
    } else if (p.x > this.maxX) {
      p.x = this.maxX;
      this.hitWall(ctx, -1);
    }

    if (p.z < 0) {
      p.z = 0;
      if (v.z < 0) v.z = 0;
    } else if (p.z > Z_DEPTH) {
      p.z = Z_DEPTH;
      if (v.z > 0) v.z = 0;
    }

    if (p.y <= 0 && v.y <= 0) {
      const impact = -v.y;
      p.y = 0;
      v.y = 0;
      this.grounded = true;
      this.coyote = COYOTE_FRAMES;
      if (!wasGrounded) this.onLand(ctx, impact);
    } else {
      this.grounded = false;
      if (this.coyote > 0) this.coyote--;
    }

    v.x *= this.grounded ? GROUND_FRICTION : AIR_FRICTION;
    v.z *= Z_FRICTION;
    if (Math.abs(v.x) < 0.012) v.x = 0;
    if (Math.abs(v.z) < 0.012) v.z = 0;
  }

  private hitWall(ctx: SimContext, into: Facing): void {
    const v = this.vel;
    if (this.wallBounce && !this.grounded && Math.abs(v.x) > 2.2) {
      this.wallBounce = false;
      v.x = into * Math.abs(v.x) * WALL_BOUNCE;
      v.y = Math.max(v.y, 3.4);
      this.hitstunTimer = Math.max(this.hitstunTimer, 18);
      ctx.fx.shake({ magnitude: 7, duration: 12 });
      ctx.fx.particles({
        count: 12,
        x: this.pos.x,
        y: this.pos.y + 16,
        z: this.pos.z,
        angle: into > 0 ? 0 : Math.PI,
        spread: 1.5,
        speed: [1.4, 4.6],
        life: [10, 26],
        size: [1, 2.6],
        colors: ['#d9d2c4', '#8e8578', '#5c5449'],
        gravity: 0.16,
        drag: 0.94,
        shape: 'shard',
      });
      ctx.audio.play('hit_metal', { pitch: 0.8 });
      ctx.audio.voice(this.voice, 'hit');
    } else if ((into > 0 && v.x < 0) || (into < 0 && v.x > 0)) {
      v.x = 0;
    }
  }

  private onLand(ctx: SimContext, impact: number): void {
    this.juggleCount = 0;
    this.wallBounce = false;
    const heavy = impact > 7;

    ctx.fx.particles({
      count: heavy ? 10 : 5,
      x: this.pos.x,
      y: 1,
      z: this.pos.z,
      angle: 0,
      spread: Math.PI,
      speed: [0.5, heavy ? 2.6 : 1.5],
      life: [10, 24],
      size: [1.2, heavy ? 3.4 : 2.2],
      colors: ['#cfc6b8', '#a89e90', '#7d7468'],
      gravity: 0.04,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
    });
    ctx.audio.play('land', { gain: heavy ? 1 : 0.6, pitch: heavy ? 0.9 : 1.1 });
    if (heavy) ctx.fx.shake({ magnitude: 2.4, duration: 8, dirY: 1 });

    switch (this.state) {
      case 'launched':
      case 'thrown':
        this.toKnockdown(ctx);
        break;
      case 'hurt':
        if (this.hitstunTimer > 0 || this.pendingKnockdown) this.toKnockdown(ctx);
        else this.setState('land');
        break;
      case 'attack':
      case 'super':
      case 'grabbing':
        if (this.currentMove?.airOnly) {
          this.endMove(ctx);
          this.setState('land');
        }
        break;
      case 'dead':
      case 'riding':
      case 'grabbed':
      case 'knockdown':
      case 'getup':
        break;
      default:
        this.setState('land');
        break;
    }
  }

  /** Belt-scrollers live or die on bodies not occupying the same pixel. */
  private separate(ctx: SimContext): void {
    if (!this.grounded || !this.alive) return;
    if (this.state === 'knockdown' || this.state === 'getup' || this.state === 'grabbed') return;
    // A vehicle shoves people; people do not shove a vehicle. Enemies still run
    // their own separation against the rider, so the crowd parts around it.
    if (this.state === 'riding') return;

    for (const other of ctx.fighters) {
      if (other.id === this.id) continue;
      if (other.state === 'dead' || other.state === 'knockdown' || other.state === 'entering') {
        continue;
      }
      if (Math.abs(other.pos.z - this.pos.z) > Z_HIT_TOLERANCE) continue;
      if (Math.abs(other.pos.y - this.pos.y) > 22) continue;

      const dx = this.pos.x - other.pos.x;
      const span = BODY_HALF_W * 2;
      if (Math.abs(dx) >= span) continue;

      // Ties are broken by id so both sides agree which way to shove.
      const dir = dx === 0 ? (this.id > other.id ? 1 : -1) : sign(dx);
      const overlap = (span - Math.abs(dx)) / span;
      this.pos.x += dir * SEPARATION_FORCE * overlap;
    }
  }

  // ── state handlers ─────────────────────────────────────────────────────────

  private setState(s: FighterState, restart = false): void {
    if (this.state === s && !restart) return;
    this.state = s;
    this.stateFrame = 0;
  }

  /**
   * Walk or run, from whatever this fighter is actually being driven by.
   *
   * Three answers, in the order they are asked:
   *
   *   1. `Btn.Run` is held — the stick is pushed to its limit, and the source
   *      has said so outright. Run this frame, no wind-up.
   *   2. The source is analog but the bit is clear — the stick is somewhere in
   *      the middle, and the player asked to walk. Never roll into a run; a
   *      half-deflected stick that accelerated on its own would be exactly the
   *      "why is my character sprinting" bug the hold timer was written for.
   *   3. Otherwise it is a keyboard, and hold-to-run is the only intent channel
   *      there is. Unchanged, down to the frame.
   */
  private wantsRun(): boolean {
    if (this.runHeld) return true;
    // An analog source has already said how hard it is pushing; asking it to
    // also hold a direction for twelve frames would override that answer.
    if (this.analogMove) return false;
    return this.holdFrames > RUN_HOLD_FRAMES;
  }

  private updateGround(ctx: SimContext): void {
    this.stateFrame++;

    if (this.state === 'land' && this.stateFrame >= LAND_FRAMES) this.setState('idle');

    if (this.consumeBuffer(ctx)) return;

    if (this.wantDash !== 0) {
      const dir: Facing = this.wantDash > 0 ? 1 : -1;
      this.wantDash = 0;
      this.startDash(dir, ctx);
      return;
    }

    if (this.heldMask & Btn.Block) {
      this.vel.x *= 0.5;
      // The parry window only opens on a freshly raised guard, never off the
      // back of blockstun — otherwise blocking a string would auto-parry it.
      this.parryTimer = PARRY_FRAMES;
      this.setState('block');
      return;
    }

    const spd = this.moveSpeed;
    const running = this.wantsRun();

    if (this.inX !== 0) {
      this.facing = this.inX > 0 ? 1 : -1;
      this.vel.x = this.inX * (running ? RUN_SPEED : WALK_SPEED) * spd;
    }
    if (this.inZ !== 0) {
      this.vel.z = this.inZ * (running ? RUN_SPEED : WALK_SPEED) * spd * Z_SPEED_SCALE;
    }

    if (this.state !== 'land') {
      if (this.inX !== 0 || this.inZ !== 0) this.setState(running ? 'run' : 'walk');
      else this.setState('idle');
    }
  }

  private updateDash(ctx: SimContext): void {
    this.stateFrame++;
    this.dashTimer--;

    if (this.consumeBuffer(ctx)) return;

    if (this.dashTimer <= 0) {
      this.vel.x *= 0.4;
      // Holding the direction out of a dash rolls straight into a run — the
      // timer is pre-satisfied so a keyboard does not have to earn it twice.
      // A stick still decides for itself: leaning out of a dash walks out of it,
      // pushing out of it runs.
      if (this.inX === this.dashDir) {
        this.holdFrames = RUN_HOLD_FRAMES + 1;
        this.setState(this.wantsRun() ? 'run' : 'walk');
      } else {
        this.setState('idle');
      }
      return;
    }

    this.vel.x = this.dashDir * DASH_SPEED * this.moveSpeed;
    if (this.inZ !== 0) this.vel.z = this.inZ * WALK_SPEED * this.moveSpeed * Z_SPEED_SCALE;
  }

  private updateAir(ctx: SimContext): void {
    this.stateFrame++;
    if (this.consumeBuffer(ctx)) return;

    const cap = WALK_SPEED * this.moveSpeed * 1.15;
    if (this.inX !== 0) {
      this.vel.x = clamp(this.vel.x + this.inX * AIR_ACCEL, -cap, cap);
    }
    if (this.inZ !== 0) {
      const zcap = cap * Z_SPEED_SCALE;
      this.vel.z = clamp(this.vel.z + this.inZ * AIR_ACCEL * 0.5, -zcap, zcap);
    }

    if (this.vel.y <= 0 && this.state === 'jump') this.setState('fall');
  }

  private updateBlock(ctx: SimContext): void {
    this.stateFrame++;
    if (this.consumeBuffer(ctx)) return;
    if (!(this.heldMask & Btn.Block) || !this.grounded) {
      this.setState('idle');
      return;
    }
    // A blocking fighter may still shuffle in depth, slowly.
    if (this.inZ !== 0) this.vel.z = this.inZ * WALK_SPEED * this.moveSpeed * 0.3;
    if (this.inX !== 0) this.facing = this.inX > 0 ? 1 : -1;
  }

  private updateBlockstun(): void {
    this.stateFrame++;
    if (this.hitstunTimer > 0) this.hitstunTimer--;
    if (this.hitstunTimer <= 0) {
      this.setState(this.heldMask & Btn.Block ? 'block' : 'idle');
    }
  }

  private updateHurt(ctx: SimContext): void {
    this.stateFrame++;
    if (this.hitstunTimer > 0) this.hitstunTimer--;
    if (this.hitstunTimer > 0) return;
    if (!this.grounded) {
      this.setState('fall');
      return;
    }
    if (this.pendingKnockdown) {
      this.toKnockdown(ctx);
      return;
    }
    if (this.dizzyTimer > 0) {
      this.setState('stunned');
      return;
    }
    this.setState('idle');
  }

  private updateKnockdown(): void {
    this.stateFrame++;
    if (this.knockdownTimer > 0) this.knockdownTimer--;
    if (this.knockdownTimer <= 0 && this.grounded) {
      this.setState('getup');
      this.invulnFrames = Math.max(this.invulnFrames, WAKEUP_INVULN);
      this.pendingKnockdown = false;
      this.dizzyMeter = 0;
      this.dizzyTimer = 0;
    }
  }

  private updateGetup(ctx: SimContext): void {
    this.stateFrame++;
    // A wake-up reversal is the whole point of invincible getup frames.
    if (this.stateFrame > GETUP_FRAMES * 0.5 && this.consumeBuffer(ctx)) return;
    if (this.stateFrame >= GETUP_FRAMES) this.setState('idle');
  }

  private updateGrabbed(ctx: SimContext): void {
    this.stateFrame++;
    const holder = this.grabHolder;
    if (!holder || !holder.alive || holder.state !== 'grabbing') {
      this.releaseGrab();
      return;
    }
    this.pos.x = holder.pos.x + holder.facing * 15;
    this.pos.z = holder.pos.z;
    this.facing = holder.facing === 1 ? -1 : 1;
    this.vel.x = 0;
    this.vel.z = 0;

    // Mashing shortens the hold, exactly as it should.
    if (this.bufAction) {
      this.grabTimer -= 4;
      this.bufAction = null;
      this.bufFrames = 0;
    }
    if (--this.grabTimer <= 0) {
      this.releaseGrab();
      ctx.audio.play('whiff');
    }
  }

  private updateStunned(): void {
    this.stateFrame++;
    if (this.dizzyTimer > 0) this.dizzyTimer--;
    // Mash out of the dizzy.
    if (this.bufAction || this.inX !== 0) {
      this.dizzyTimer -= 2;
      this.bufAction = null;
      this.bufFrames = 0;
    }
    if (this.dizzyTimer <= 0) {
      this.dizzyTimer = 0;
      this.dizzyMeter = 0;
      this.setState('idle');
    }
  }

  /**
   * On a vehicle.
   *
   * The whole state is a throttle, a brake and a wheelie. Speed lives in
   * `rideVel` and is written into `vel.x` every frame, so ground friction —
   * which is a fact about boots, not about tyres — never gets to eat it.
   *
   * Deterministic throughout: the only non-sim things here are the engine note
   * and the smoke, both of which go through ctx and are dropped on rollback.
   */
  private updateRiding(ctx: SimContext): void {
    this.stateFrame++;

    // Held off the floor by the vehicle, not by the ground. `physics` clears
    // this again at the end of the step; re-asserting it here each frame is
    // what keeps gravity out of the saddle.
    this.grounded = true;
    this.pos.y = 0;
    this.vel.y = 0;

    const top = RIDE_TOP_SPEED * this.rideBoost + (this.rideWheelie > 0 ? RIDE_WHEELIE_BOOST : 0);
    const braking = (this.heldMask & Btn.Block) !== 0;
    const turning = this.inX !== 0 && this.rideVel !== 0 && this.inX > 0 !== this.rideVel > 0;

    if (braking) {
      this.rideVel = approach(this.rideVel, this.inX * top * 0.5, RIDE_BRAKE);
    } else if (turning) {
      this.rideVel = approach(this.rideVel, this.inX * top, RIDE_BRAKE);
    } else if (this.inX !== 0) {
      this.rideVel = approach(this.rideVel, this.inX * top, RIDE_ACCEL);
    } else {
      this.rideVel = approach(this.rideVel, 0, RIDE_COAST);
    }
    if (Math.abs(this.rideVel) < 0.02) this.rideVel = 0;
    this.vel.x = this.rideVel;

    if ((braking || turning) && Math.abs(this.rideVel) > RIDE_SCREECH_SPEED) this.screech(ctx);

    if (this.inZ !== 0) this.vel.z = this.inZ * RIDE_Z_SPEED * this.rideBoost;

    // A vehicle points where it is going, not where the stick is: shoving left
    // at forty miles an hour is a skid, not a pirouette.
    if (Math.abs(this.rideVel) > 0.5) this.facing = this.rideVel > 0 ? 1 : -1;
    else if (this.inX !== 0) this.facing = this.inX > 0 ? 1 : -1;

    this.rideEngineNote(ctx, top);
    this.tickRideSwing(ctx);
    this.rideAction(ctx);
  }

  /** Re-barks the engine every so often, pitched by how hard it is working. */
  private rideEngineNote(ctx: SimContext, top: number): void {
    if (this.rideEngine > 0) {
      this.rideEngine--;
      return;
    }
    this.rideEngine = RIDE_ENGINE_INTERVAL;
    const load = clamp(Math.abs(this.rideVel) / Math.max(1, top), 0, 1);
    ctx.audio.play('engine', { pitch: 0.72 + load * 0.75, gain: 0.2 + load * 0.34 });
    if (load < 0.25) return;
    ctx.fx.particles({
      count: 4,
      x: this.pos.x - this.facing * 16,
      y: 7,
      z: this.pos.z,
      angle: this.facing > 0 ? Math.PI : 0,
      spread: 0.5,
      speed: [0.5, 1.8],
      life: [12, 26],
      size: [1.4, 3.2],
      colors: ['#8f8aa0', '#5c5566', '#c9c4d6'],
      gravity: -0.02,
      drag: 0.92,
      shape: 'smoke',
      fade: 'ease',
    });
  }

  /** Rubber, complaining. Rate-limited so a long slide is one sound, not sixty. */
  private screech(ctx: SimContext): void {
    if (this.rideScreech > 0) return;
    this.rideScreech = RIDE_SCREECH_FRAMES;
    ctx.audio.play('tyres', { pitch: 0.94, gain: 0.7 });
    ctx.fx.particles({
      count: 8,
      x: this.pos.x - this.facing * 10,
      y: 2,
      z: this.pos.z,
      angle: this.rideVel > 0 ? Math.PI : 0,
      spread: 0.9,
      speed: [0.8, 2.8],
      life: [14, 30],
      size: [1.6, 3.6],
      colors: ['#d8d0c2', '#a29a8c', '#6f6a62'],
      gravity: -0.01,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
    });
  }

  /**
   * What the attack buttons mean in the saddle.
   *
   * Light/heavy/special are all the same gesture at this speed: crack the
   * throttle and put a boot out. Jump is a wheelie, because a vehicle section
   * that cannot be shown off on is just a corridor with a longer stride.
   */
  private rideAction(ctx: SimContext): void {
    const act = this.bufAction;
    if (!act || this.bufFrames <= 0) return;
    this.clearBuffer();

    if (act === 'jump') {
      this.rideWheelie = RIDE_WHEELIE_FRAMES;
      ctx.audio.play('engine', { pitch: 1.45, gain: 0.4 });
      ctx.audio.voice(this.voice, 'taunt');
      return;
    }
    if (this.rideSwing > 0) return;

    this.rideSwing = RIDE_SWING_FRAMES;
    this.rideWindow = this.makeRideWindow();
    this.rideVel += this.facing * RIDE_LUNGE;
    const wd = this.weaponDef;
    ctx.audio.play(wd ? wd.sfx.swing : 'whiff', { gain: 0.8 });
    ctx.audio.voice(this.voice, 'attack');
  }

  private tickRideSwing(ctx: SimContext): void {
    if (this.rideSwing <= 0 || !this.rideWindow) return;
    ctx.spawnHit(this.id, this.rideWindow);
    if (--this.rideSwing > 0) return;
    this.rideSwing = 0;
    this.rideWindow = null;
  }

  /**
   * A boot from the saddle. Modest damage on purpose — the vehicle itself is
   * the weapon, and this is only the answer to somebody standing right there.
   */
  private makeRideWindow(): HitWindow {
    return {
      start: 0,
      end: RIDE_SWING_FRAMES,
      box: { ox: 21, oy: 20, oz: 0, hw: 15, hh: 17, hd: 12 },
      props: {
        damage: 9,
        hitstun: 20,
        blockstun: 12,
        hitstop: 5,
        knockback: { x: 6.4, y: 3.2 },
        pushback: 0,
        reaction: 'heavy',
        level: 'mid',
        chip: DEFAULT_CHIP,
        meterGain: 0.05,
        meterGainVictim: 0.03,
        shake: 4,
        sfx: 'kick',
      },
      anchor: 'footR',
    };
  }

  private updateEntering(): void {
    this.stateFrame++;
    this.entryTimer--;
    this.invulnFrames = Math.max(this.invulnFrames, 2);
    this.vel.x = this.facing * WALK_SPEED * this.moveSpeed * 0.85;
    if (this.entryTimer <= 0) this.setState('idle');
  }

  // ── movement helpers ───────────────────────────────────────────────────────

  private startDash(dir: Facing, ctx: SimContext): void {
    this.dashDir = dir;
    this.facing = dir;
    this.dashTimer = DASH_FRAMES;
    this.vel.x = dir * DASH_SPEED * this.moveSpeed;
    this.setState('dash', true);
    // A dash is spent effort, and it should read that way a moment later.
    this.breathSpike = Math.min(BREATH_SPIKE_MAX, this.breathSpike + BREATH_DASH_SPIKE);
    ctx.audio.play('dash', { pan: 0 });
    ctx.fx.particles({
      count: 6,
      x: this.pos.x - dir * 6,
      y: 2,
      z: this.pos.z,
      angle: dir > 0 ? Math.PI : 0,
      spread: 0.7,
      speed: [0.6, 2.2],
      life: [8, 18],
      size: [1.2, 2.6],
      colors: ['#d8d0c2', '#a29a8c'],
      gravity: 0.02,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
    });
  }

  private tryJump(ctx: SimContext): boolean {
    if (!this.grounded && this.coyote <= 0) return false;
    this.vel.y = JUMP_VELOCITY * this.jumpStat;
    this.grounded = false;
    this.coyote = 0;
    this.setState('jump', true);
    if (this.inX !== 0) {
      this.facing = this.inX > 0 ? 1 : -1;
      this.vel.x = this.inX * WALK_SPEED * this.moveSpeed * 1.1;
    }
    ctx.audio.play('jump');
    ctx.audio.voice(this.voice, 'jump');
    return true;
  }

  // ── input buffer ───────────────────────────────────────────────────────────

  private clearBuffer(): void {
    this.bufAction = null;
    this.bufFrames = 0;
  }

  private moveIdForAction(act: Action): string | null {
    switch (act) {
      case 'light':
        if (!this.grounded) return this.moves.airLight ?? this.moves.light ?? null;
        if (this.state === 'dash') return this.moves.dashAttack ?? this.moves.light ?? null;
        return this.moves.light ?? null;
      case 'heavy':
        if (!this.grounded) return this.moves.airHeavy ?? this.moves.heavy ?? null;
        if (this.state === 'dash') return this.moves.dashAttack ?? this.moves.heavy ?? null;
        return this.moves.heavy ?? null;
      case 'special':
        return this.moves.special ?? null;
      case 'grab':
        return this.moves.grab ?? null;
      case 'super':
        return this.moves.super ?? null;
      case 'jump':
        return null;
    }
  }

  /** Fires the buffered action if it is legal right now. */
  private consumeBuffer(ctx: SimContext): boolean {
    if (!this.bufAction || this.bufFrames <= 0) return false;
    const act = this.bufAction;

    if (act === 'jump') {
      if (this.tryJump(ctx)) {
        this.clearBuffer();
        return true;
      }
      return false;
    }

    const id = this.moveIdForAction(act);
    if (!id) {
      this.clearBuffer();
      return false;
    }
    if (this.startMove(id, ctx)) {
      this.clearBuffer();
      this.tickMove(ctx);
      return true;
    }
    return false;
  }

  // ── move execution ─────────────────────────────────────────────────────────

  startMove(id: string, ctx: SimContext): boolean {
    if (!this.alive) return false;
    const m = lookupMove(id);
    if (!m) return false;

    if (m.airOnly && this.grounded) return false;
    if (!m.airOk && !m.airOnly && !this.grounded) return false;
    if (!this.canStart(m)) return false;

    // Validate every resource before spending any of them.
    const cost = m.meterCost ?? 0;
    const wd = this.weaponDef;
    const spendsAmmo = wd !== null && wd.ammo !== undefined && m.weapon === this.weapon;
    if (cost > this.meter || (spendsAmmo && this.weaponAmmo <= 0)) {
      if (this.team === 'player') ctx.audio.play('ui_error', { gain: 0.4 });
      return false;
    }
    this.meter -= cost;
    if (spendsAmmo) this.weaponAmmo--;

    this.currentMove = m;
    this.moveConnected = false;
    this.whiffed = false;
    this.stateFrame = 0;
    this.state = cost >= 1 ? 'super' : m.isGrab ? 'grabbing' : 'attack';
    if (this.inX !== 0 && this.grounded) this.facing = this.inX > 0 ? 1 : -1;

    if (m.sfx) ctx.audio.play(m.sfx);
    ctx.audio.voice(this.voice, 'attack');
    if (cost >= 1) {
      ctx.audio.play('super_charge');
      ctx.fx.flash('#ffffff', 4, 0.35);
      ctx.fx.slowmo(0.35, 12);
    }
    return true;
  }

  private canStart(m: MoveDef): boolean {
    switch (this.state) {
      case 'idle':
      case 'walk':
      case 'run':
      case 'dash':
      case 'land':
      case 'block':
        return true;
      case 'jump':
      case 'fall':
        return m.airOk === true || m.airOnly === true;
      case 'getup':
        return this.stateFrame > GETUP_FRAMES * 0.5;
      case 'attack':
      case 'super':
      case 'grabbing':
        return this.hasCancelInto(m.id);
      default:
        return false;
    }
  }

  /** A cancel is only ever legal off a move that actually touched someone. */
  private hasCancelInto(id: string): boolean {
    const cur = this.currentMove;
    if (!cur || !cur.cancels || !this.moveConnected) return false;
    for (const rule of cur.cancels) {
      if (this.stateFrame >= rule.from && rule.into.indexOf(id) >= 0) return true;
    }
    return false;
  }

  private updateMove(ctx: SimContext): void {
    // A cancel replaces the move and runs its first frame immediately.
    if (this.bufAction && this.bufFrames > 0 && this.bufAction !== 'jump') {
      const id = this.moveIdForAction(this.bufAction);
      if (id && this.hasCancelInto(id) && this.startMove(id, ctx)) {
        this.clearBuffer();
        this.tickMove(ctx);
        return;
      }
    }
    this.tickMove(ctx);
  }

  private tickMove(ctx: SimContext): void {
    const m = this.currentMove;
    if (!m) {
      this.setState(this.grounded ? 'idle' : 'fall');
      return;
    }

    const f = this.stateFrame;

    if (m.motion) {
      for (const mo of m.motion) {
        if (mo.frame !== f) continue;
        this.vel.x += mo.x * this.facing;
        this.vel.y += mo.y;
        if (mo.z) this.vel.z += mo.z;
        if (mo.y > 0) {
          this.grounded = false;
          this.coyote = 0;
        }
      }
    }

    this.invulnFrames = Math.max(
      this.invulnFrames,
      m.invuln && f >= m.invuln.start && f <= m.invuln.end ? 1 : 0,
    );

    let lastWindowEnd = -1;
    for (const w of m.windows) {
      if (f >= w.start && f <= w.end) ctx.spawnHit(this.id, w);
      if (w.end > lastWindowEnd) lastWindowEnd = w.end;
    }

    if (m.onFrame) m.onFrame(this, f, ctx);

    if (!this.whiffed && !this.moveConnected && lastWindowEnd >= 0 && f === lastWindowEnd + 1) {
      this.whiffed = true;
      ctx.audio.play('whiff', { gain: 0.5 });
    }

    this.stateFrame = f + 1;
    if (this.stateFrame >= m.duration) {
      this.endMove(ctx);
      this.setState(this.grounded ? 'idle' : 'fall');
    }
  }

  private endMove(ctx: SimContext): void {
    const m = this.currentMove;
    if (m && !this.moveConnected && !this.whiffed && m.windows.length > 0) {
      ctx.audio.play('whiff', { gain: 0.5 });
    }
    // Anyone this fighter was holding notices the grip open next frame.
    this.currentMove = null;
    this.moveConnected = false;
    this.whiffed = false;
  }

  // ── taking damage ──────────────────────────────────────────────────────────

  takeHit(props: HitProperties, fromX: number, ctx: SimContext, attacker: Fighter): boolean {
    if (!this.alive) return false;
    if (this.invulnerable) return false;
    if (this.state === 'knockdown' && props.level !== 'low') return false;

    // dir points from the attacker toward this fighter: knockback goes that way.
    const dir: Facing = fromX <= this.pos.x ? 1 : -1;
    const facingAttacker = this.facing === (dir === 1 ? -1 : 1);
    const canBlock =
      props.level !== 'unblockable' &&
      facingAttacker &&
      (this.state === 'block' || this.state === 'blockstun');

    if (canBlock && this.state === 'block' && this.parryTimer > 0) {
      return this.parry(props, ctx, attacker);
    }
    if (canBlock) return this.blockHit(props, dir, ctx, attacker);

    const scale = comboScale(attacker.comboCount);
    const juggle = this.grounded ? 1 : Math.max(MIN_JUGGLE_SCALE, 1 - this.juggleCount * JUGGLE_DECAY);
    const resist = this.isBoss ? 0.45 : 1;
    const damage = props.damage * attacker.damageMul * scale;

    this.health = Math.max(0, this.health - damage);
    this.flash = 1;
    this.hitstunTimer = Math.max(this.hitstunTimer, props.hitstun);
    this.addMeter(props.meterGainVictim, ctx);
    if (!this.grounded) this.juggleCount++;

    if (this.grounded && this.state !== 'launched' && this.state !== 'thrown') {
      this.facing = dir === 1 ? -1 : 1;
    }

    const kbx = props.knockback.x * dir * juggle * resist;
    const kby = props.knockback.y * juggle * resist;
    this.vel.x = kbx;
    if (kby > 0) {
      this.vel.y = kby;
      this.grounded = false;
    }

    this.dizzyMeter += STUN_BUILD[props.reaction] ?? 1;
    this.pendingKnockdown = false;

    this.recordDamage(damage, props.reaction, ctx);
    this.applyReaction(props.reaction, dir, juggle * resist, ctx);
    this.hitFx(props, dir, damage, ctx, attacker);

    attacker.registerHitLanded(props, dir, false, ctx);

    if (this.health <= 0) {
      this.die(ctx);
    } else if (this.dizzyMeter >= STUN_THRESHOLD && this.grounded) {
      this.dizzyMeter = 0;
      this.dizzyTimer = STUN_DURATION;
      ctx.fx.text({
        text: 'DIZZY',
        x: this.pos.x,
        y: 54,
        z: this.pos.z,
        color: '#ffd166',
        size: 9,
        life: 46,
        rise: 0.4,
        style: 'bonus',
      });
    }

    return true;
  }

  private applyReaction(
    reaction: HitReaction,
    dir: Facing,
    scale: number,
    ctx: SimContext,
  ): void {
    /*
     * A jab does not stop a moving vehicle.
     *
     * Everything heavier than a flinch still takes the rider out of the saddle
     * — being shot off a bike is exactly the risk that makes riding one worth
     * anything — but a mook getting a hand to you at speed should cost you
     * momentum and nothing else. Without this a vehicle section is one poke
     * long, which is not a treat, it is a tax.
     */
    if (this.state === 'riding' && reaction === 'light') {
      this.hitstunTimer = 0;
      this.rideVel *= 0.78;
      return;
    }

    const heavyDrop =
      reaction === 'heavy' ||
      reaction === 'launch' ||
      reaction === 'sweep' ||
      reaction === 'crumple' ||
      reaction === 'blowback';
    if (heavyDrop && this.weapon) this.dropWeapon(ctx);

    switch (reaction) {
      case 'light':
        this.hurtClip = 'hurt_light';
        this.setState(this.grounded ? 'hurt' : 'launched', true);
        break;
      case 'heavy':
        this.hurtClip = 'hurt_heavy';
        this.setState(this.grounded ? 'hurt' : 'launched', true);
        break;
      case 'launch':
        this.hurtClip = 'hurt_heavy';
        this.vel.y = Math.max(this.vel.y, MIN_LAUNCH_VELOCITY * scale);
        this.grounded = false;
        this.setState('launched', true);
        break;
      case 'sweep':
        this.hurtClip = 'hurt_heavy';
        this.vel.y = Math.max(this.vel.y, 3.2 * scale);
        this.grounded = false;
        this.setState('launched', true);
        this.pendingKnockdown = true;
        break;
      case 'crumple':
        this.hurtClip = 'hurt_heavy';
        this.vel.x *= 0.25;
        this.pendingKnockdown = true;
        this.setState('hurt', true);
        break;
      case 'blowback':
        this.hurtClip = 'hurt_heavy';
        this.vel.x = dir * Math.max(Math.abs(this.vel.x), 8.5 * scale);
        this.vel.y = Math.max(this.vel.y, 5.5 * scale);
        this.grounded = false;
        this.wallBounce = true;
        this.setState('launched', true);
        break;
      case 'stun':
        this.hurtClip = 'hurt_heavy';
        this.dizzyTimer = STUN_DURATION;
        this.setState(this.grounded ? 'stunned' : 'launched', true);
        break;
    }
  }

  private hitFx(
    props: HitProperties,
    dir: Facing,
    damage: number,
    ctx: SimContext,
    attacker: Fighter,
  ): void {
    const big = props.reaction !== 'light';
    const hx = this.pos.x - dir * 6;
    const hy = this.pos.y + 24;
    // Sparks are machine damage, not viscera: a robot still throws them with
    // gore off. Flesh gets dust and sweat instead, so the hit still reads.
    const dry = goreSetting === 'off' && !this.mechanical;
    const gs = goreScale();

    ctx.fx.particles({
      count: Math.max(3, Math.round((big ? 14 : 8) * gs)),
      x: hx,
      y: hy,
      z: this.pos.z,
      angle: dir > 0 ? 0 : Math.PI,
      spread: 1.1,
      speed: [1.2, big ? 5.2 : 3.2],
      life: [8, big ? 26 : 16],
      size: [1, big ? 3.2 : 2],
      colors: this.mechanical ? SPARK_COLORS : dry ? DRY_COLORS : BLOOD_COLORS,
      gravity: this.mechanical ? 0.22 : 0.14,
      drag: 0.93,
      shape: this.mechanical ? 'spark' : dry ? 'dot' : 'blood',
      additive: this.mechanical,
      fade: 'ease',
    });

    if (props.shake > 0) {
      ctx.fx.shake({ magnitude: props.shake, duration: big ? 14 : 8, dirX: 1, dirY: 0.6 });
    }
    if (big) {
      ctx.fx.impactFrame(this.id, IMPACT_FLASH_FRAMES);
      ctx.fx.aberration(0.4, 6);
    }
    if (props.hitstop > 0) ctx.requestHitstop(props.hitstop);

    ctx.audio.play(props.sfx ?? (this.mechanical ? 'hit_metal' : 'hit_flesh'), {
      pitch: big ? 0.85 : 1.1,
    });
    ctx.audio.voice(this.voice, 'hit');

    const combo = attacker.comboCount + 1;
    ctx.fx.text({
      text: `${Math.max(1, Math.round(damage))}`,
      x: this.pos.x,
      y: 40,
      z: this.pos.z,
      color: big ? '#ffcf5c' : '#f4f0e6',
      size: big ? 9 : 7,
      life: 34,
      rise: 0.6,
      style: big ? 'critical' : 'damage',
    });
    if (combo >= 3) {
      ctx.fx.text({
        text: `${combo} HITS`,
        x: this.pos.x,
        y: 58,
        z: this.pos.z,
        color: '#7fe0ff',
        size: 8,
        life: 40,
        rise: 0.45,
        style: 'combo',
      });
    }
  }

  private parry(props: HitProperties, ctx: SimContext, attacker: Fighter): boolean {
    this.addMeter(PARRY_METER, ctx);
    this.hitstunTimer = 0;
    ctx.audio.play('parry');
    ctx.fx.flash('#dff6ff', 3, 0.5);
    ctx.fx.slowmo(0.25, 10);
    ctx.requestHitstop(Math.max(6, props.hitstop));
    ctx.fx.particles({
      count: 14,
      x: this.pos.x + this.facing * 10,
      y: this.pos.y + 24,
      z: this.pos.z,
      angle: this.facing > 0 ? 0 : Math.PI,
      spread: 2.4,
      speed: [1.5, 4],
      life: [10, 22],
      size: [1, 2.4],
      colors: ['#ffffff', '#9fe6ff', '#4fb8ff'],
      gravity: 0,
      drag: 0.9,
      shape: 'star',
      additive: true,
    });
    ctx.fx.text({
      text: 'PARRY',
      x: this.pos.x,
      y: 52,
      z: this.pos.z,
      color: '#9fe6ff',
      size: 9,
      life: 40,
      rise: 0.5,
      style: 'bonus',
    });
    attacker.registerHitLanded(props, this.facing === 1 ? -1 : 1, true, ctx);
    return true;
  }

  private blockHit(
    props: HitProperties,
    dir: Facing,
    ctx: SimContext,
    attacker: Fighter,
  ): boolean {
    const chip = props.chip > 0 ? props.chip : DEFAULT_CHIP;
    const damage = props.damage * attacker.damageMul * chip;
    this.health = Math.max(0, this.health - damage);
    this.hitstunTimer = Math.max(this.hitstunTimer, props.blockstun);
    this.setState('blockstun', true);
    this.vel.x = dir * Math.abs(props.knockback.x) * 0.35;
    this.addMeter(props.meterGainVictim * 0.5, ctx);
    this.flash = 0.4;
    // Holding a guard against something heavy still costs you air.
    this.breathSpike = Math.min(BREATH_SPIKE_MAX, this.breathSpike + BREATH_BLOCK_SPIKE);

    ctx.audio.play('block');
    ctx.fx.particles({
      count: 6,
      x: this.pos.x - dir * 8,
      y: this.pos.y + 22,
      z: this.pos.z,
      angle: dir > 0 ? 0 : Math.PI,
      spread: 1.2,
      speed: [1, 2.6],
      life: [8, 16],
      size: [1, 2],
      colors: ['#cfe4ff', '#7fa8d8'],
      gravity: 0.05,
      drag: 0.9,
      shape: 'spark',
      additive: true,
    });
    if (props.shake > 0) ctx.fx.shake({ magnitude: props.shake * 0.4, duration: 6 });
    ctx.requestHitstop(Math.max(2, Math.round(props.hitstop * 0.5)));

    attacker.registerHitLanded(props, dir, true, ctx);
    if (this.health <= 0) this.die(ctx);
    return true;
  }

  /** Called on the ATTACKER by the victim it just connected with. */
  registerHitLanded(props: HitProperties, dir: Facing, blocked: boolean, ctx: SimContext): void {
    this.moveConnected = true;
    this.comboCount++;
    this.comboTimer = COMBO_RESET_FRAMES;
    this.addMeter(props.meterGain * (blocked ? 0.4 : 1), ctx);
    if (props.pushback > 0) this.vel.x -= dir * props.pushback;
    this.spendDurability(ctx);
  }

  private toKnockdown(ctx: SimContext): void {
    if (!this.alive) {
      this.die(ctx);
      return;
    }
    this.setState('knockdown', true);
    this.knockdownTimer = KNOCKDOWN_FRAMES;
    this.pendingKnockdown = false;
    this.hitstunTimer = 0;
    this.juggleCount = 0;
    this.vel.x *= 0.3;
    if (this.weapon) this.dropWeapon(ctx);

    ctx.fx.shake({ magnitude: 4.5, duration: 10, dirY: 1 });
    ctx.fx.particles({
      count: 10,
      x: this.pos.x,
      y: 1,
      z: this.pos.z,
      angle: 0,
      spread: Math.PI,
      speed: [0.8, 2.8],
      life: [12, 26],
      size: [1.4, 3.2],
      colors: ['#cfc6b8', '#a89e90'],
      gravity: 0.03,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
    });
    ctx.audio.play('bone_crack', { pitch: 0.9 });
  }

  private die(ctx: SimContext): void {
    if (this.state === 'dead') return;
    this.health = 0;
    this.setState('dead', true);
    this.currentMove = null;
    this.hitstunTimer = 0;
    this.dizzyTimer = 0;
    this.vel.x *= 0.5;
    if (this.weapon) this.dropWeapon(ctx);

    ctx.audio.play(this.mechanical ? 'robot_death' : 'ko');
    ctx.audio.voice(this.voice, 'ko');
    const dry = goreSetting === 'off' && !this.mechanical;
    ctx.fx.particles({
      count: Math.max(6, Math.round((this.mechanical ? 22 : 14) * goreScale())),
      x: this.pos.x,
      y: this.pos.y + 20,
      z: this.pos.z,
      angle: -Math.PI / 2,
      spread: Math.PI,
      speed: [1.5, 5],
      life: [16, 40],
      size: [1.4, 3.6],
      colors: this.mechanical ? DEBRIS_COLORS : dry ? DRY_COLORS : BLOOD_DEEP,
      gravity: 0.24,
      drag: 0.94,
      shape: this.mechanical ? 'shard' : dry ? 'smoke' : 'blood',
      additive: false,
      fade: 'ease',
    });

    if (this.isBoss || this.team === 'player') {
      ctx.requestHitstop(KO_HITSTOP);
      ctx.fx.slowmo(KO_SLOWMO_SCALE, KO_SLOWMO_FRAMES);
      ctx.fx.shake({ magnitude: 9, duration: 22 });
      ctx.fx.flash('#ffffff', 4, 0.5);
      ctx.fx.text({
        text: this.isBoss ? 'DOWN HE GOES' : 'K.O.',
        x: this.pos.x,
        y: 60,
        z: this.pos.z,
        color: '#ff5a4f',
        size: 14,
        life: 70,
        rise: 0.3,
        style: 'critical',
      });
    }
  }

  // ── meter ──────────────────────────────────────────────────────────────────

  addMeter(v: number, ctx?: SimContext): void {
    if (v === 0) return;
    const before = Math.floor(this.meter);
    this.meter = clamp(this.meter + v, 0, MAX_METER_BARS);
    const after = Math.floor(this.meter);
    if (after > before && ctx) ctx.audio.play('meter_full');
  }

  // ── weapons ────────────────────────────────────────────────────────────────

  /**
   * Take a weapon.
   *
   * `durability` and `ammo` exist so a weapon that has already been swung a
   * dozen times stays swung: drop a spent chain to take the bat at your feet
   * and the chain on the floor is still spent when you come back for it.
   * Omitted, they come off the definition — a fresh one out of a crate.
   */
  giveWeapon(kind: WeaponKind, durability?: number, ammo?: number): void {
    const def = WEAPONS[kind];
    if (!def) return;
    this.weapon = kind;
    this.weaponDurability =
      durability !== undefined && Number.isFinite(durability) ? durability : def.durability;
    this.weaponAmmo = ammo !== undefined && Number.isFinite(ammo) ? ammo : (def.ammo ?? 0);
    this.weaponSpeed = def.speedScale > 0 ? def.speedScale : 1;
    this.moves.light = def.moves.light;
    this.moves.heavy = def.moves.heavy;
    if (def.moves.throw) this.moves.weaponThrow = def.moves.throw;
    this.pickupFrames = 22;
  }

  dropWeapon(ctx: SimContext): void {
    const kind = this.weapon;
    if (!kind) return;
    const durability = this.weaponDurability;
    const ammo = this.weaponAmmo;
    this.clearWeapon();
    // The Level plays the clatter as it puts the thing on the floor, panned to
    // where it actually landed. Playing one here as well was two drops for one
    // weapon — barely noticeable when only a knockdown could cause it, and very
    // noticeable now that swapping weapons is a button.
    ctx.spawn('weapon', this.pos.x + this.facing * 10, Math.max(6, this.pos.y + 10), this.pos.z, {
      kind,
      durability,
      ammo,
    });
  }

  private clearWeapon(): void {
    this.weapon = null;
    this.weaponDurability = 0;
    this.weaponAmmo = 0;
    this.weaponSpeed = 1;
    this.moves.light = this.baseMoves.light;
    this.moves.heavy = this.baseMoves.heavy;
    delete this.moves.weaponThrow;
  }

  /** Weapons wear out on contact, not on swings that hit nothing. */
  private spendDurability(ctx: SimContext): void {
    const def = this.weaponDef;
    if (!def || def.durability < 0) return;
    const m = this.currentMove;
    if (m && m.weapon !== undefined && m.weapon !== this.weapon) return;
    if (this.weaponDurability <= 0) return;
    this.weaponDurability--;
    if (this.weaponDurability > 0) return;

    const art = def.art;
    ctx.fx.particles({
      count: 16,
      x: this.pos.x + this.facing * 12,
      y: this.pos.y + 22,
      z: this.pos.z,
      angle: -Math.PI / 2,
      spread: Math.PI,
      speed: [1.6, 5.4],
      life: [14, 34],
      size: [1, 3],
      colors: [art.color, art.accent, '#f4f0e6'],
      gravity: 0.26,
      drag: 0.93,
      shape: 'shard',
      spin: 0.3,
    });
    ctx.fx.shake({ magnitude: 3, duration: 8 });
    ctx.audio.play('glass');
    ctx.fx.text({
      text: 'BROKEN',
      x: this.pos.x,
      y: 48,
      z: this.pos.z,
      color: '#ff9c5a',
      size: 7,
      life: 34,
      rise: 0.5,
      style: 'bonus',
    });
    this.clearWeapon();
  }

  // ── grabs, entries, cutscene states ────────────────────────────────────────

  /** Puts `victim` in this fighter's grip for the duration of the grab move. */
  seizeGrab(victim: Fighter): boolean {
    if (this.state !== 'grabbing' || !victim.alive || victim.isBoss) return false;
    if (victim.state === 'grabbed' || victim.invulnerable) return false;
    victim.grabHolder = this;
    victim.grabTimer = GRAB_HOLD_FRAMES;
    victim.setState('grabbed', true);
    victim.vel.x = 0;
    victim.vel.y = 0;
    victim.vel.z = 0;
    victim.grounded = true;
    return true;
  }

  private releaseGrab(): void {
    this.grabHolder = null;
    this.grabTimer = 0;
    this.setState(this.grounded ? 'idle' : 'fall', true);
  }

  /** Hurls a held victim. Used by throw moves through `onFrame`. */
  throwHeld(vx: number, vy: number, ctx: SimContext): void {
    for (const view of ctx.fighters) {
      const f = view as Fighter;
      if (f.grabHolder !== this) continue;
      f.grabHolder = null;
      f.vel.x = vx * this.facing;
      f.vel.y = vy;
      f.grounded = false;
      f.wallBounce = true;
      f.hitstunTimer = 30;
      f.setState('thrown', true);
      ctx.audio.play('hit_flesh', { pitch: 0.8 });
    }
  }

  /** Walk-on entrance for a freshly spawned enemy. */
  beginEntry(frames = ENTRY_FRAMES, facing: Facing = -1): void {
    this.facing = facing;
    this.entryTimer = Math.max(1, frames);
    this.setState('entering', true);
  }

  celebrate(): void {
    if (!this.alive) return;
    this.currentMove = null;
    this.vel.x = 0;
    this.vel.z = 0;
    this.setState('victory', true);
  }

  /**
   * Get on, or get off.
   *
   * `speedScale` is the vehicle's own character — a hyperloop pod is not a
   * moto — and is ignored on dismount. Getting off is written so it is safe to
   * call at ANY time and from any state: the Level calls it unconditionally
   * when a rider dies, is blown out of the saddle or simply stops being in the
   * riding state, and every one of those has to leave a clean body behind.
   */
  setRiding(on: boolean, speedScale = 1): void {
    if (on) {
      if (!this.alive) return;
      this.currentMove = null;
      this.clearBuffer();
      this.rideBoost = clamp(speedScale, 0.4, 2.4);
      // Whatever you were carrying in comes with you.
      this.rideVel = clamp(this.vel.x, -RIDE_TOP_SPEED, RIDE_TOP_SPEED);
      this.rideWheelie = 0;
      this.rideSwing = 0;
      this.rideWindow = null;
      // The mount already barks; the loop starts one interval later.
      this.rideEngine = RIDE_ENGINE_INTERVAL;
      this.pos.y = 0;
      this.vel.y = 0;
      this.grounded = true;
      this.setState('riding', true);
      return;
    }

    // Step off at speed and you stumble on for a moment; step off a wreck and
    // you do not. Either way nothing ride-shaped survives the dismount.
    if (this.state === 'riding') {
      this.vel.x = this.rideVel * 0.35;
      this.setState('idle', true);
    }
    this.rideVel = 0;
    this.rideBoost = 1;
    this.rideWheelie = 0;
    this.rideSwing = 0;
    this.rideWindow = null;
  }

  heal(v: number): void {
    this.health = clamp(this.health + v, 0, this.maxHealth);
  }

  // ── animation ──────────────────────────────────────────────────────────────

  private clipForState(): string {
    if (this.pickupFrames > 0 && (this.state === 'idle' || this.state === 'walk')) {
      return 'pickup';
    }
    switch (this.state) {
      case 'idle':
        return 'idle';
      case 'walk':
        return 'walk';
      case 'run':
        return 'run';
      case 'dash':
        return 'run';
      case 'jump':
        return 'jump';
      case 'fall':
        return 'fall';
      case 'land':
        return 'land';
      case 'attack':
      case 'super':
        return this.currentMove?.anim ?? 'punch1';
      case 'grabbing':
        return this.currentMove?.anim ?? 'grab';
      case 'block':
      case 'blockstun':
        return 'block';
      case 'hurt':
        return this.hurtClip;
      case 'launched':
      case 'thrown':
        return 'launched';
      case 'knockdown':
        return 'knockdown';
      case 'getup':
        return 'getup';
      case 'grabbed':
        return 'hurt_light';
      case 'stunned':
        return 'stunned';
      case 'riding':
        return 'ride';
      case 'entering':
        return 'walk';
      case 'victory':
        return 'victory';
      case 'dead':
        return 'dead';
    }
  }

  private animRate(clipDuration: number): number {
    switch (this.state) {
      case 'walk': {
        const s = Math.abs(this.vel.x) + Math.abs(this.vel.z);
        return clamp(s / Math.max(0.3, WALK_SPEED * this.moveSpeed), 0.4, 2);
      }
      case 'run': {
        const s = Math.abs(this.vel.x) + Math.abs(this.vel.z);
        return clamp(s / Math.max(0.3, RUN_SPEED * this.moveSpeed), 0.5, 2);
      }
      case 'dash':
        return 1.7;
      case 'land':
        return clipDuration / LAND_FRAMES;
      case 'attack':
      case 'super':
      case 'grabbing': {
        const d = this.currentMove?.duration ?? clipDuration;
        return d > 0 ? clipDuration / d : 1;
      }
      case 'getup':
        return clipDuration / GETUP_FRAMES;
      case 'knockdown':
        return 1;
      default:
        return 1;
    }
  }

  private updateAnim(): void {
    const name = this.clipForState();
    const clip = CLIPS[name] ?? CLIPS.idle;
    const duration = clip ? Math.max(1, clip.duration) : 1;
    if (name !== this.animClip) {
      this.animClip = name;
      this.animFrame = 0;
      this.prevAnimFrame = 0;
      return;
    }
    this.animFrame += this.animRate(duration);
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  render(ctx: C2D, cam: Camera, alpha: number): void {
    const a = clamp(alpha, 0, 1);
    const x = lerp(this.prevPos.x, this.pos.x, a);
    const y = lerp(this.prevPos.y, this.pos.y, a);
    const z = lerp(this.prevPos.z, this.pos.z, a);

    // Recorded before the cull, so an overlay that anchors to it never latches
    // onto a stale position for a fighter who was briefly off the side.
    this.drawPos.x = x;
    this.drawPos.y = y;
    this.drawPos.z = z;

    const onScreen = x - cam.x;
    if (onScreen < -110 || onScreen > VIEW_W + 110) return;

    const clip = CLIPS[this.animClip] ?? CLIPS.idle;
    if (!clip) return;
    const pose = sampleClip(clip, lerp(this.prevAnimFrame, this.animFrame, a));

    // Invulnerability reads as a strobe; a solid ghost would look like a bug.
    const strobe = this.invulnFrames > 0 && (this.age & 2) !== 0 ? 0.45 : 1;

    const o = this.rigOpts;
    o.weapon = this.weaponDef;
    o.flash = this.flash;
    o.tint = this.tint ?? undefined;
    o.alpha = strobe;
    // Far things are smaller, and far is z=0 — so the falloff is measured from
    // the back wall, not from the origin.
    o.scale = clamp(1 - (Z_DEPTH - z) * Z_PERSPECTIVE, 0.75, 1);
    o.damage = this.damage;

    const sy = GROUND_Y + z * Z_SCALE - y;
    if (this.bossRig && hasBossRig(this.bossRig)) {
      drawBossRig(ctx, this.bossRig, this.style, x, sy, this.facing, {
        state: this.state,
        frame: this.stateFrame,
        flash: o.flash,
        tint: o.tint,
        alpha: o.alpha,
        scale: o.scale,
        damage: this.damage,
      });
      return;
    }

    drawCharacter(ctx, this.style, pose, this.skeleton, x, sy, this.facing, o);
  }

  // ── netcode ────────────────────────────────────────────────────────────────

  checksum(): number {
    let h = hashNumber(0x9e3779b9, this.id);
    h = hashNumber(h, this.pos.x);
    h = hashNumber(h, this.pos.y);
    h = hashNumber(h, this.pos.z);
    h = hashNumber(h, this.vel.x);
    h = hashNumber(h, this.vel.y);
    h = hashNumber(h, this.vel.z);
    h = hashNumber(h, this.facing);
    h = hashNumber(h, STATE_CODE[this.state]);
    h = hashNumber(h, this.stateFrame);
    h = hashNumber(h, this.health);
    h = hashNumber(h, this.meter);
    h = hashNumber(h, this.comboCount);
    h = hashNumber(h, this.weapon === null ? -1 : this.weaponDurability);
    // A vehicle carries its speed outside vel.x, so without this two peers
    // could disagree about how fast a bike is going and never find out.
    h = hashNumber(h, this.rideVel);
    return h >>> 0;
  }
}

/** Long combos have to stop being lethal, or nothing else in the game matters. */
function comboScale(hits: number): number {
  const i = clamp(hits, 0, COMBO_SCALING.length - 1) | 0;
  return Math.max(MIN_DAMAGE_SCALE, COMBO_SCALING[i]);
}
