/**
 * Mountain Fighters — shared type contract.
 *
 * Every module in the game compiles against this file. It is deliberately
 * dependency-free so it can be imported from anywhere without cycles.
 *
 * COORDINATE SYSTEM (2.5D belt-scroller, Final Fight style with Street Fighter
 * combat depth):
 *
 *     x — world horizontal, grows right, unbounded within a map
 *     z — depth, 0 = FAR (the back wall), Z_DEPTH = nearest the camera
 *     y — height above the ground plane, grows UP, 0 = standing on floor
 *
 * Screen projection (see render/Camera.ts):
 *     screenX = x - camera.x
 *     screenY = GROUND_Y + z * Z_SCALE - y
 *
 * Entities draw back to front, i.e. ascending z (z=0, the back wall, first).
 *
 * DETERMINISM CONTRACT — the simulation must be bit-identical across peers:
 *   - No Math.random(). Use the seeded Rng passed through SimContext.
 *   - No Date.now() / performance.now() inside sim code.
 *   - No iteration over unordered collections (Set/Map insertion order is fine,
 *     object key order is not).
 *   - Rendering, particles, audio and camera shake are NON-deterministic-safe:
 *     they live outside the sim and may use wall-clock time and Math.random.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Math primitives
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/** World position. y is height above ground, z is depth into the screen. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned box in world space used for hit/hurt/collision volumes. */
export interface Box3 {
  /** Centre offset from the entity origin, in entity-facing space. */
  ox: number;
  oy: number;
  oz: number;
  /** Half-extents. */
  hw: number;
  hh: number;
  hd: number;
}

export type Facing = 1 | -1;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG
// ─────────────────────────────────────────────────────────────────────────────

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Current internal state, for netcode checksums and save/restore. */
  getState(): number;
  setState(state: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One frame of input, packed into a bitmask so it can be sent over the wire as
 * a single integer and compared cheaply for rollback/desync checks.
 */
export const Btn = {
  Left: 1 << 0,
  Right: 1 << 1,
  Up: 1 << 2,
  Down: 1 << 3,
  Light: 1 << 4,
  Heavy: 1 << 5,
  Jump: 1 << 6,
  Special: 1 << 7,
  Grab: 1 << 8,
  Block: 1 << 9,
  Super: 1 << 10,
  Pause: 1 << 11,
} as const;

export type BtnMask = number;

/** Per-player input for a single simulation frame. */
export interface InputFrame {
  /** Currently-held buttons. */
  held: BtnMask;
  /** Buttons that went down THIS frame (derived, not transmitted). */
  pressed: BtnMask;
  /** Buttons that went up THIS frame (derived, not transmitted). */
  released: BtnMask;
}

export const EMPTY_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

/**
 * A source of input for one player slot. Keyboard, gamepad and network peers
 * all implement this, which is what lets a remote player slot into an
 * otherwise-local game without the game layer knowing the difference.
 */
export interface InputSource {
  readonly id: string;
  readonly kind: 'keyboard' | 'gamepad' | 'net' | 'ai' | 'replay';
  /** Called once per SIM frame. Must return the input for that frame. */
  sample(frame: number): BtnMask;
  /** Human-readable label for the UI ("Keyboard (WASD)", "Gamepad 1"). */
  label(): string;
  dispose?(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combat: frame data & moves
// ─────────────────────────────────────────────────────────────────────────────

export type HitLevel = 'low' | 'mid' | 'high' | 'overhead' | 'unblockable';

/** How the victim reacts. Drives the hurt animation and the juice. */
export type HitReaction =
  | 'light' // small flinch, keeps footing
  | 'heavy' // big stagger
  | 'launch' // pops into the air, juggle state
  | 'sweep' // legs taken out, knockdown
  | 'crumple' // slow slump to the floor
  | 'blowback' // flies horizontally, wall-bounces
  | 'stun'; // dizzy, free hits

export interface HitProperties {
  damage: number;
  /** Frames the victim cannot act for. */
  hitstun: number;
  /** Frames the victim cannot act for when they blocked. */
  blockstun: number;
  /** Frames the ATTACKER is frozen on connect — the core of hit feel. */
  hitstop: number;
  /** Impulse applied to the victim, in entity-facing space. */
  knockback: Vec2;
  /** Extra push applied to the attacker (recoil). */
  pushback: number;
  reaction: HitReaction;
  level: HitLevel;
  /** Chip damage dealt on block, as a fraction of damage. */
  chip: number;
  /** Meter granted to the attacker on connect. */
  meterGain: number;
  /** Meter granted to the victim for being hit. */
  meterGainVictim: number;
  /** Screen shake magnitude in pixels. */
  shake: number;
  /** Optional named sfx cue, resolved by the audio synth. */
  sfx?: SfxCue;
}

/** One active-frame window of a move. A move may have several. */
export interface HitWindow {
  /** First frame (inclusive) of the move on which this box is live. */
  start: number;
  /** Last frame (inclusive). */
  end: number;
  box: Box3;
  props: HitProperties;
  /** Which limb/bone this window is anchored to, for particle placement. */
  anchor?: BoneName;
}

export interface MoveDef {
  id: string;
  name: string;
  /** Total frames from first frame to actionable again. */
  duration: number;
  /** Frames before the first hit window (for AI and UI display). */
  startup: number;
  windows: HitWindow[];
  /** Move ids this move may cancel into, and from which frame. */
  cancels?: { into: string[]; from: number }[];
  /** Meter cost. Supers cost 1.0 (a full bar). */
  meterCost?: number;
  /** Horizontal impulse applied to the attacker on a given frame. */
  motion?: { frame: number; x: number; y: number; z?: number }[];
  /** True if the move can be performed in the air. */
  airOk?: boolean;
  /** True if the move must be performed in the air. */
  airOnly?: boolean;
  /** True if this is a throw — uses grab detection instead of hitboxes. */
  isGrab?: boolean;
  /** Invulnerability window, e.g. for wake-up reversals. */
  invuln?: { start: number; end: number };
  /** Which weapon this move belongs to, if any. Unarmed moves omit this. */
  weapon?: WeaponKind;
  /** Animation clip name driven by the rig. */
  anim: string;
  sfx?: SfxCue;
  /** Called for bespoke behaviour (projectiles, summons). Non-deterministic
   *  code is forbidden here — use ctx.rng. */
  onFrame?: (self: FighterView, frame: number, ctx: SimContext) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fighter state
// ─────────────────────────────────────────────────────────────────────────────

export type FighterState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'dash'
  | 'jump'
  | 'fall'
  | 'land'
  | 'attack'
  | 'block'
  | 'blockstun'
  | 'hurt'
  | 'launched'
  | 'knockdown'
  | 'getup'
  | 'grabbing'
  | 'grabbed'
  | 'thrown'
  | 'stunned'
  | 'super'
  | 'riding'
  | 'entering'
  | 'victory'
  | 'dead';

export type Team = 'player' | 'enemy' | 'neutral';

/**
 * Read-only view of a fighter handed to move callbacks and AI so they cannot
 * reach into engine internals. The concrete Fighter class implements this.
 */
export interface FighterView {
  readonly id: number;
  readonly team: Team;
  readonly pos: Vec3;
  readonly vel: Vec3;
  readonly facing: Facing;
  readonly state: FighterState;
  readonly health: number;
  readonly maxHealth: number;
  readonly meter: number;
  readonly stateFrame: number;
  readonly grounded: boolean;
  readonly weapon: WeaponKind | null;
  readonly comboCount: number;
  readonly archetype: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

export type WeaponKind =
  | 'chain'
  | 'bat'
  | 'ironbar'
  | 'pipe'
  | 'taser'
  | 'pistol'
  | 'riotshield'
  | 'cybertruck_door'
  | 'keyboard'
  | 'gpu';

export interface WeaponDef {
  kind: WeaponKind;
  name: string;
  /** Hits before it breaks. -1 = never breaks. */
  durability: number;
  /** Damage multiplier applied on top of each move's base damage. */
  damageScale: number;
  /** Movement speed multiplier while carrying it. */
  speedScale: number;
  /** Move ids that replace the unarmed light/heavy while held. */
  moves: { light: string; heavy: string; throw?: string };
  /** Vector art parameters, consumed by the rig renderer. */
  art: WeaponArt;
  /** True if it is a ranged weapon that spends ammo. */
  ammo?: number;
  /**
   * How the weapon sounds. `art` says what it looks like; this says what it is.
   * Used for the select-screen reveal and anywhere a weapon needs a voice of
   * its own — without it every weapon reveal played the same generic cue.
   */
  sfx: WeaponSfx;
}

export interface WeaponSfx {
  /** Played when the weapon is first produced or picked up. */
  reveal: SfxCue;
  /**
   * Played as it moves through the air. Deliberately distinct per weapon —
   * when eight of ten shared one generic swoosh, every reveal ended on the
   * same note and the whole roster sounded the same.
   */
  swing: SfxCue;
  /** Played when it connects with something solid. */
  impact: SfxCue;
  /** Multiplies the playback rate, so a crowbar reads heavier than a pipe. */
  pitch?: number;
  /** Playback rate for `swing` alone, when it wants a different one. */
  swingPitch?: number;
}

export interface WeaponArt {
  /** Base silhouette the vector renderer builds from. */
  shape: 'stick' | 'flail' | 'blocky' | 'gun' | 'shield' | 'plate';
  length: number;
  thickness: number;
  color: string;
  accent: string;
  /** Chain/flail links, spikes, etc. */
  segments?: number;
  spikes?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector rig (procedural character art)
// ─────────────────────────────────────────────────────────────────────────────

export type BoneName =
  | 'root'
  | 'pelvis'
  | 'torso'
  | 'chest'
  | 'neck'
  | 'head'
  | 'hat'
  | 'beard'
  | 'armL_upper'
  | 'armL_lower'
  | 'handL'
  | 'armR_upper'
  | 'armR_lower'
  | 'handR'
  | 'legL_upper'
  | 'legL_lower'
  | 'footL'
  | 'legR_upper'
  | 'legR_lower'
  | 'footR';

export interface Bone {
  name: BoneName;
  parent: BoneName | null;
  /** Rest offset from the parent joint, in rig-local units. */
  x: number;
  y: number;
  length: number;
  /** Rest rotation in radians. */
  rot: number;
}

/** A single bone's animated deviation from rest pose. */
export interface BonePose {
  rot?: number;
  x?: number;
  y?: number;
  scale?: number;
}

export type Pose = Partial<Record<BoneName, BonePose>>;

export interface AnimKeyframe {
  /** Frame index within the clip. */
  t: number;
  pose: Pose;
  /** Optional easing into this keyframe. */
  ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'snap';
}

export interface AnimClip {
  name: string;
  frames: AnimKeyframe[];
  duration: number;
  loop: boolean;
}

/**
 * Everything needed to draw one character procedurally. The transformation
 * cutscene works by tweening `outfit` from 0 (classic Disney-ish dwarf) to 1
 * (leather-and-spikes bad boy) while the rig plays a dressing animation.
 */
export interface RigStyle {
  /** Body proportions. */
  scale: number;
  girth: number;
  headSize: number;
  beardLength: number;
  beardStyle: 'bushy' | 'long' | 'braided' | 'stubble' | 'forked' | 'none';
  /** Palette. */
  skin: string;
  skinShade: string;
  hair: string;
  hatColor: string;
  tunicColor: string;
  /** Bad-boy layer, revealed as outfit -> 1. */
  jacketColor: string;
  jacketAccent: string;
  spikes: number;
  shades: boolean;
  /** 0 = classic film outfit, 1 = full bad boy. Tweened by the cutscene. */
  outfit: number;
  /** Extra flourishes. */
  tattoo?: 'none' | 'anchor' | 'skull' | 'heart' | 'barcode';
  cigar?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Characters
// ─────────────────────────────────────────────────────────────────────────────

export interface DwarfDef {
  id: string;
  /** Display name, bad-boy alias. */
  name: string;
  /** The classic film name, shown struck through on the select screen. */
  bornAs: string;
  tagline: string;
  /** One-line character bio for the select screen. */
  bio: string;
  stats: {
    health: number;
    speed: number;
    jump: number;
    power: number;
    /** 1 = average. Higher = faster recovery frames. */
    tech: number;
  };
  style: RigStyle;
  /** Move ids owned by this dwarf, resolved from the shared move table. */
  moves: {
    light: string;
    heavy: string;
    special: string;
    airLight: string;
    airHeavy: string;
    grab: string;
    dashAttack: string;
  };
  super: SuperPowerDef;
  /** Preferred starting weapon shown during the transformation. */
  signatureWeapon: WeaponKind;
  voice: VoiceProfile;
}

/**
 * The collectible activatable ultimate. Themed per dwarf — the "air support"
 * of the original, reskinned to each character's personality.
 */
export interface SuperPowerDef {
  id: string;
  name: string;
  description: string;
  /** Total frames the cinematic runs. Sim is paused for opponents. */
  duration: number;
  /** Damage dealt to every valid target. */
  damage: number;
  /** Radius in world units. -1 = whole screen. */
  radius: number;
  /** Drives which bespoke renderer draws the cinematic. */
  visual:
    | 'sneeze_shockwave'
    | 'sleep_dream_crush'
    | 'grump_quake'
    | 'doc_lecture'
    | 'bashful_blush_nova'
    | 'happy_disco_inferno'
    | 'dopey_chaos_rain';
  sfx: SfxCue;
}

export interface VoiceProfile {
  /** Base pitch in Hz for the procedural voice grunts. */
  pitch: number;
  /** Formant character. */
  timbre: 'gruff' | 'nasal' | 'deep' | 'squeak' | 'wheeze';
  /** Random pitch wobble. */
  wobble: number;
}

export type EnemyKind =
  | 'suit_guard'
  | 'taser_guard'
  | 'gunman'
  | 'riot_guard'
  | 'security_bot'
  | 'vacuum_bot'
  | 'iot_fridge'
  | 'iot_speaker'
  | 'delivery_drone'
  | 'intern'
  | 'lobbyist';

export interface EnemyDef {
  id: EnemyKind;
  name: string;
  health: number;
  speed: number;
  power: number;
  /** How aggressively the AI closes distance, 0..1. */
  aggression: number;
  /** Preferred stand-off distance in world units. */
  spacing: number;
  style: RigStyle;
  moves: { light: string; heavy?: string; ranged?: string };
  /** Weapon carried, dropped on death for the player to pick up. */
  weapon?: WeaponKind;
  /** Score awarded. */
  points: number;
  ai: AiProfile;
}

export interface AiProfile {
  /** Frames between decisions. Lower = twitchier. */
  reactionFrames: number;
  /** Probability of blocking an incoming attack, 0..1. */
  blockSkill: number;
  /** Probability of attempting a combo follow-up. */
  comboSkill: number;
  /** Willingness to attack while another enemy is already attacking. */
  swarm: number;
  behaviour: 'rusher' | 'spacer' | 'sniper' | 'turtle' | 'erratic' | 'support';
}

export interface BossDef {
  id: string;
  name: string;
  /** The taunt shown on the pre-fight title card. */
  quote: string;
  /** Which map index (1-based) this boss terminates. */
  atMap: number;
  health: number;
  style: RigStyle;
  /** Bosses are built from phases; each phase swaps the move pool. */
  phases: BossPhase[];
  /** Bespoke renderer id for non-humanoid bosses (cars, dogs). */
  rigOverride?: 'shiba' | 'cybertruck' | 'rocket' | 'humanoid' | 'robot_giant';
  points: number;
  music: MusicMood;
}

export interface BossPhase {
  /** Phase begins when health drops below this fraction. */
  healthThreshold: number;
  moves: string[];
  aggression: number;
  /** Optional adds spawned when the phase begins. */
  spawns?: { kind: EnemyKind; count: number }[];
  /** One-liner barked on phase entry. */
  bark?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Maps & progression
// ─────────────────────────────────────────────────────────────────────────────

export type MapTheme =
  | 'tunnel'
  | 'factory'
  | 'server_farm'
  | 'launchpad'
  | 'mars_dome'
  | 'boardroom'
  | 'social_feed'
  | 'suburb'
  | 'mine'
  | 'forest'
  | 'gigafactory'
  | 'orbit';

export interface MapDef {
  /** 1-based index, 1..70. */
  index: number;
  name: string;
  theme: MapTheme;
  /** World width in units. The camera scrolls across this. */
  width: number;
  /** Depth of the walkable band. */
  depth: number;
  /** Waves of enemies, cleared in order. */
  waves: WaveDef[];
  /** Boss fought at the end, if any. Every 5th map has one. */
  boss?: string;
  /** Palette + parallax layer config for the procedural backdrop. */
  palette: MapPalette;
  /** Interactive props (barrels, vending machines) that drop items. */
  props?: PropSpawn[];
  /** Optional vehicle section. */
  vehicle?: VehicleSection;
  music: MusicMood;
}

export interface WaveDef {
  /** Enemies in this wave. */
  enemies: { kind: EnemyKind; count: number }[];
  /** X position along the map where the wave triggers, 0..1 of width. */
  at: number;
  /** Items that drop when the wave is cleared. */
  reward?: { weapon?: WeaponKind; health?: number; meter?: number };
}

export interface MapPalette {
  sky: [string, string];
  far: string;
  mid: string;
  near: string;
  ground: string;
  groundLine: string;
  fog: string;
  /** Accent used for neon signage, hazard stripes, etc. */
  accent: string;
  /** Ambient light tint multiplied over characters. */
  tint: string;
}

export interface PropSpawn {
  kind: 'barrel' | 'crate' | 'vending' | 'server_rack' | 'scooter' | 'sign';
  x: number;
  z: number;
  health: number;
  drop?: { weapon?: WeaponKind; health?: number };
}

export interface VehicleSection {
  kind: 'moto' | 'cybertruck' | 'hyperloop_pod' | 'rocket';
  /** X range of the map this section covers, as fractions of width. */
  from: number;
  to: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every sound is synthesised at runtime — the repo ships zero audio files.
 * These cues name a synthesis recipe in audio/Synth.ts.
 */
export type SfxCue =
  | 'punch_light'
  | 'punch_heavy'
  | 'kick'
  | 'whiff'
  | 'block'
  | 'parry'
  | 'hit_flesh'
  | 'hit_metal'
  | 'bone_crack'
  | 'weapon_swing'
  | 'chain_whip'
  | 'bat_crack'
  | 'gunshot'
  | 'taser'
  | 'explosion'
  | 'robot_death'
  | 'glass'
  | 'pickup'
  | 'drop'
  | 'jump'
  | 'land'
  | 'dash'
  | 'ko'
  | 'super_charge'
  | 'super_blast'
  | 'meter_full'
  | 'ui_move'
  | 'ui_select'
  | 'ui_back'
  | 'ui_error'
  | 'coin'
  | 'sneeze'
  | 'snore'
  | 'laugh'
  | 'grunt'
  | 'engine'
  | 'tyres';

export type MusicMood =
  | 'menu'
  | 'select'
  | 'fight_low'
  | 'fight_high'
  | 'boss'
  | 'final_boss'
  | 'victory'
  | 'defeat'
  | 'cutscene';

// ─────────────────────────────────────────────────────────────────────────────
// Juice
// ─────────────────────────────────────────────────────────────────────────────

export interface ParticleSpec {
  count: number;
  /** World position. */
  x: number;
  y: number;
  z: number;
  /** Emission cone. */
  angle: number;
  spread: number;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  colors: string[];
  gravity: number;
  drag: number;
  /** Shape drawn per particle. */
  shape: 'dot' | 'spark' | 'shard' | 'ring' | 'star' | 'smoke' | 'blood' | 'bolt';
  /** Additive blending for energy effects. */
  additive?: boolean;
  /** Fade curve. */
  fade?: 'linear' | 'ease' | 'flicker';
  /** Spin speed in radians per frame. */
  spin?: number;
}

export interface ShakeSpec {
  magnitude: number;
  /** Frames. */
  duration: number;
  /** Higher = faster oscillation. */
  frequency?: number;
  /** Directional bias; omit for omnidirectional. */
  dirX?: number;
  dirY?: number;
}

export interface FloatingTextSpec {
  text: string;
  x: number;
  y: number;
  z: number;
  color: string;
  size: number;
  /** Frames. */
  life: number;
  /** Upward drift speed. */
  rise: number;
  style?: 'damage' | 'combo' | 'bonus' | 'taunt' | 'critical';
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handed to every sim-side update. Anything reachable from here is safe to use
 * inside deterministic code; anything NOT here (wall clock, Math.random, DOM)
 * is not.
 */
export interface SimContext {
  readonly frame: number;
  readonly rng: Rng;
  /** Fighters currently alive, in stable id order. */
  readonly fighters: readonly FighterView[];
  /** Queue a hit for resolution this frame. */
  spawnHit(attackerId: number, window: HitWindow): void;
  /** Request an entity spawn (projectile, pickup, add). */
  spawn(kind: string, x: number, y: number, z: number, data?: unknown): void;
  /** Deterministic. Applies globally, gates the whole sim. */
  requestHitstop(frames: number): void;
  /**
   * Presentation-only effects. These are recorded but never affect the sim,
   * so they are safe to call from deterministic code and are skipped entirely
   * during rollback re-simulation.
   */
  readonly fx: FxBus;
  readonly audio: AudioBus;
}

export interface FxBus {
  particles(spec: ParticleSpec): void;
  shake(spec: ShakeSpec): void;
  text(spec: FloatingTextSpec): void;
  flash(color: string, frames: number, alpha?: number): void;
  /** Radial distortion pulse centred on a world point. */
  shockwave(x: number, y: number, z: number, radius: number, frames: number): void;
  /** Slow motion. scale 0..1, for `frames`. */
  slowmo(scale: number, frames: number): void;
  /** Freeze-frame silhouette flash on a fighter, used for big hits. */
  impactFrame(fighterId: number, frames: number): void;
  /** Chromatic aberration pulse. */
  aberration(strength: number, frames: number): void;
  /** True while re-simulating for rollback; effects should be dropped. */
  readonly muted: boolean;
}

export interface AudioBus {
  play(cue: SfxCue, opts?: { pitch?: number; gain?: number; pan?: number }): void;
  music(mood: MusicMood): void;
  /** Procedural voice grunt driven by a character's VoiceProfile. */
  voice(profile: VoiceProfile, kind: 'hit' | 'attack' | 'ko' | 'taunt' | 'jump'): void;
  readonly muted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenes
// ─────────────────────────────────────────────────────────────────────────────

export interface Scene {
  readonly name: string;
  /** Called when the scene becomes active. */
  enter(params?: unknown): void;
  /** Fixed-timestep simulation update. dt is always FIXED_DT. */
  update(dt: number): void;
  /** Called once per animation frame. `alpha` is the interpolation factor
   *  between the previous and current sim frame, 0..1. */
  render(alpha: number): void;
  /** Called when the scene is replaced. */
  exit(): void;
  /** Optional: handle a raw DOM key event for UI navigation. */
  onKey?(e: KeyboardEvent): void;
}

export type SceneName =
  | 'boot'
  | 'home'
  | 'select'
  | 'fight'
  | 'pause'
  | 'victory'
  | 'gameover'
  | 'lobby'
  | 'cutscene';

// ─────────────────────────────────────────────────────────────────────────────
// Networking
// ─────────────────────────────────────────────────────────────────────────────

export type NetRole = 'host' | 'guest' | 'offline';

export interface NetPlayer {
  peerId: string;
  slot: number;
  name: string;
  dwarfId: string | null;
  ready: boolean;
  /** Round-trip time in ms, for the UI. */
  ping: number;
}

/** Messages exchanged over the WebRTC data channel. */
export type NetMessage =
  | { t: 'hello'; name: string; version: string }
  | { t: 'welcome'; slot: number; players: NetPlayer[]; seed: number }
  | { t: 'roster'; players: NetPlayer[] }
  | { t: 'pick'; slot: number; dwarfId: string }
  | { t: 'ready'; slot: number; ready: boolean }
  | { t: 'start'; mapIndex: number; seed: number; startFrame: number }
  /** Input for a range of frames; batched to cut packet count. */
  | { t: 'in'; slot: number; from: number; inputs: number[] }
  /** Periodic state checksum so desyncs are detected loudly, not silently. */
  | { t: 'sync'; frame: number; checksum: number }
  | { t: 'pause'; paused: boolean; by: number }
  | { t: 'bye'; slot: number }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number };

export interface NetConfig {
  /** Frames of input delay. Higher = more lag but fewer stalls. */
  inputDelay: number;
  /** PeerJS broker. Defaults to the public cloud broker. */
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Save data
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveData {
  version: number;
  /** Highest map index unlocked, 1..70. */
  progress: number;
  /** Per-dwarf high scores. */
  scores: Record<string, number>;
  settings: Settings;
  /** Dwarf ids the player has cleared the game with. */
  cleared: string[];
  /**
   * True once the opening cinematic has played to the end or been skipped.
   * Retrying map 1 after a game over should not replay 33 seconds of story.
   */
  seenIntro: boolean;
}

export interface Settings {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  screenShake: number;
  /** Honour prefers-reduced-motion; when true, juice is toned down. */
  reducedMotion: boolean;
  showHitboxes: boolean;
  difficulty: 'easy' | 'normal' | 'hard' | 'musk';
  /** Keyboard bindings per local player slot. */
  bindings: Record<number, Record<string, number>>;
}
