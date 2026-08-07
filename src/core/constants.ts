/**
 * Tuning constants. Anything a designer might want to twiddle lives here so
 * the feel of the game can be adjusted without hunting through systems.
 */

// ── Simulation ───────────────────────────────────────────────────────────────

/** The sim runs at a fixed 60Hz. Rendering is decoupled and interpolated. */
export const SIM_HZ = 60;
export const FIXED_DT = 1 / SIM_HZ;
/** Never simulate more than this many catch-up steps in one frame. */
export const MAX_CATCHUP_STEPS = 5;

// ── Virtual resolution ───────────────────────────────────────────────────────

/** The game renders to this virtual size and is letterboxed to fit. */
export const VIEW_W = 640;
export const VIEW_H = 360;

/** Screen y of the z=0 ground line. */
export const GROUND_Y = 250;
/** Screen pixels of vertical offset per unit of world depth. */
export const Z_SCALE = 0.55;
/** Depth of the walkable band in world units. */
export const Z_DEPTH = 110;
/** Characters shrink slightly as they walk away from the camera. */
export const Z_PERSPECTIVE = 0.0011;

// ── Physics ──────────────────────────────────────────────────────────────────

export const GRAVITY = 0.62;
export const MAX_FALL_SPEED = 14;
/** Horizontal friction applied on the ground per frame. */
export const GROUND_FRICTION = 0.78;
export const AIR_FRICTION = 0.96;
/** Friction applied to depth movement. */
export const Z_FRICTION = 0.7;
/** Fighters push each other apart at this rate when overlapping. */
export const SEPARATION_FORCE = 0.55;
/**
 * How close in z two fighters must be to touch each other at all.
 *
 * This is a brawler, not a precision game. At 14 you had to line up almost
 * exactly to connect, and whiffing because you were one pixel off the enemy's
 * lane is the single most frustrating thing a belt-scroller can do. Widened
 * deliberately: swinging in roughly the right place should land.
 */
export const Z_HIT_TOLERANCE = 26;

export const WALK_SPEED = 1.75;
export const RUN_SPEED = 3.6;
export const DASH_SPEED = 6.2;
export const DASH_FRAMES = 14;
export const JUMP_VELOCITY = 11.2;
/** Frames within which a second tap counts as a double-tap dash. */
export const DOUBLE_TAP_FRAMES = 14;
/** Input buffer window — a button pressed this many frames early still fires. */
export const INPUT_BUFFER_FRAMES = 6;
/** Coyote time: frames after leaving the ground where jump still works. */
export const COYOTE_FRAMES = 4;

// ── Combat ───────────────────────────────────────────────────────────────────

/** Damage is scaled down as a combo grows, so long combos are not lethal. */
export const COMBO_SCALING = [1.0, 1.0, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5, 0.44, 0.38, 0.3];
export const MIN_DAMAGE_SCALE = 0.25;
/** Frames of grace after a combo's last hit before the counter resets. */
export const COMBO_RESET_FRAMES = 45;
/** Meter is 0..1 per bar; the player holds this many bars. */
export const MAX_METER_BARS = 3;
/** Hits taken before a fighter is dizzied. */
export const STUN_THRESHOLD = 28;
export const STUN_DECAY_PER_FRAME = 0.06;
export const STUN_DURATION = 110;
/**
 * Frames of invulnerability after getting up from a knockdown.
 *
 * 18 frames was not enough to clear the getup animation, so an enemy standing
 * over you — especially a gunman, who does not even have to close in — could
 * knock you straight back down before you had control. Being juggled between
 * knockdowns with no input is not difficulty, it is a broken loop. Now long
 * enough to walk out of the situation you woke up in.
 */
export const WAKEUP_INVULN = 52;
/** Frames a fighter lies on the floor before getting up. */
export const KNOCKDOWN_FRAMES = 48;
/** Fraction of blocked damage that still lands as chip. */
export const DEFAULT_CHIP = 0.12;
/** Perfect-block window at the very start of a block. */
export const PARRY_FRAMES = 4;
/** Bonus meter for a successful parry. */
export const PARRY_METER = 0.25;
/** Wall bounce restitution for blowback hits. */
export const WALL_BOUNCE = 0.45;

// ── Juice ────────────────────────────────────────────────────────────────────

/** Extra hitstop applied on the final blow of a fight, for the KO slam. */
export const KO_HITSTOP = 26;
export const KO_SLOWMO_SCALE = 0.22;
export const KO_SLOWMO_FRAMES = 36;
/** Global multiplier applied to every shake, scaled again by user settings. */
export const SHAKE_SCALE = 1.0;
export const SHAKE_DECAY = 0.86;
/** Max simultaneous particles before the pool starts recycling oldest-first. */
export const MAX_PARTICLES = 900;
/** Frames the white impact flash lasts on a heavy hit. */
export const IMPACT_FLASH_FRAMES = 3;
/** Camera punch (zoom kick) applied on heavy hits. */
export const CAMERA_PUNCH = 0.028;
export const CAMERA_LERP = 0.11;
/**
 * Base zoom during a fight. A ~50-unit dwarf on a 360-unit-tall view is only
 * 14% of screen height; the genre (Final Fight, Streets of Rage) sits nearer
 * 25%. Zooming the camera rather than scaling the rig keeps world units — and
 * therefore every hitbox — untouched.
 */
export const FIGHT_ZOOM = 1.45;
/** How far ahead of the player the camera leads, in world units. */
export const CAMERA_LOOKAHEAD = 34;

/**
 * How far a bullet flies, as a fraction of the width the player can actually
 * SEE (VIEW_W / FIGHT_ZOOM), not of the map.
 *
 * Gunmen used to out-range the screen, so the only counter to one was to walk
 * the length of the level while he backed away — which is why they read as
 * "run in all directions and waste your time". A shooter now has to come to
 * you to be a threat at all.
 */
export const PROJECTILE_RANGE_FRAC = 0.4;

/**
 * Bodies a single bullet passes through before it stops.
 *
 * With friendly fire on, this cuts both ways: a line of guards is a gift to
 * whoever shoots down it, and standing behind your own gunman is a mistake.
 */
export const PROJECTILE_PIERCE = 3;

/**
 * Bodies a vehicle can run over before it is scrap.
 *
 * A ride used to clear a whole map on its own, which is fun exactly once and
 * then removes the fight. Twenty is enough to feel like a rampage and short
 * enough that it ends in a wreck rather than at the boss door.
 */
export const VEHICLE_HP = 20;
/**
 * Bodies left when the machine catches fire.
 *
 * Fire is not just a warning light: from here it eats the vehicle on its own,
 * so a burning ride is a countdown you are riding rather than a state you can
 * sit in.
 */
export const VEHICLE_FIRE_AT = 5;
/** Frames between fire eating one more body. 180 = three seconds. */
export const VEHICLE_FIRE_TICK = 180;
/** Bodies left when it starts smoking — the warning before the fire. */
export const VEHICLE_SMOKE_AT = 12;

/** Damage the wreck deals to the driver and to everyone stood around it. */
export const VEHICLE_BLAST_DAMAGE = 9;
/** Reach of that blast, in world units. */
export const VEHICLE_BLAST_RADIUS = 74;

// ── Progression ──────────────────────────────────────────────────────────────

export const TOTAL_MAPS = 70;
/** A boss guards every Nth map. 70 / 5 = 14 bosses. */
export const BOSS_EVERY = 5;
export const TOTAL_BOSSES = TOTAL_MAPS / BOSS_EVERY;
export const MAX_LOCAL_PLAYERS = 4;
export const STARTING_LIVES = 3;

// ── Networking ───────────────────────────────────────────────────────────────

/** Wire-format version; peers refuse to connect across a mismatch. */
export const NET_VERSION = '1';
/** Default frames of input delay for lockstep. ~50ms at 60Hz. */
export const DEFAULT_INPUT_DELAY = 3;
/** Send a state checksum every N frames to catch desyncs early. */
export const SYNC_INTERVAL = 60;
/** Give up waiting for a peer's input after this many frames stalled. */
export const NET_TIMEOUT_FRAMES = 600;
/** Prefix for generated room codes, keeps our ids out of other apps' space. */
export const PEER_PREFIX = 'mtnfight-';

// ── Storage ──────────────────────────────────────────────────────────────────

export const SAVE_KEY = 'mountainfighters.save.v1';
export const SAVE_VERSION = 1;
