/**
 * The frame-data table for the whole game.
 *
 * Everything a fighter can do — unarmed normals, per-dwarf specials, weapon
 * swings, enemy pokes and boss set-pieces — is one entry in `MOVES`. Frames are
 * sim frames at 60Hz, so a 4f jab really is ~66ms of startup.
 *
 * House rules, applied consistently so the game teaches itself:
 *   - `hitstun` is always meaningfully larger than `blockstun`. Blocking always
 *     buys you your turn back; that is the whole point of a block button.
 *   - `hitstop` scales with the weight of the blow. A jab barely stutters, a
 *     Cybertruck door stops time.
 *   - Lights chain into lights and into heavies (target combos); heavies cancel
 *     into specials. Nothing cancels out of a special.
 *   - Reach costs startup. Anything that reaches past ~30 units is 12f+.
 *
 * Box space: `ox` is FORWARD in the attacker's facing space, `oy` is height
 * above the feet, `oz` is depth. A dwarf is ~46 units tall, a guard ~72, which
 * is why every enemy box is taller than it looks like it needs to be — a suit
 * has to be able to punch something that only comes up to his belt.
 */

import { DEFAULT_CHIP } from '@/core/constants';
import { clamp } from '@/core/math';
import type {
  BoneName,
  Box3,
  FighterView,
  HitLevel,
  HitProperties,
  HitReaction,
  HitWindow,
  MoveDef,
  ParticleSpec,
  SfxCue,
  SimContext,
  WeaponKind,
} from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Authoring helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default half-depth of a hitbox. Slightly under Z_HIT_TOLERANCE. */
const HD = 13;

function box(ox: number, oy: number, hw: number, hh: number, hd = HD, oz = 0): Box3 {
  return { ox, oy, oz, hw, hh, hd };
}

interface HitOpts {
  /** Base damage before combo scaling and weapon multipliers. */
  dmg: number;
  /** Frames the victim is locked down on hit. */
  stun: number;
  /** Frames the victim is locked down on block. Defaults to ~55% of `stun`. */
  block?: number;
  /** Frames the attacker freezes on connect. Defaults to a weight curve. */
  stop?: number;
  /** Knockback in the attacker's facing space. */
  kx?: number;
  ky?: number;
  /** Recoil pushed back onto the attacker. */
  push?: number;
  react?: HitReaction;
  level?: HitLevel;
  chip?: number;
  meter?: number;
  vmeter?: number;
  shake?: number;
  sfx?: SfxCue;
}

/** Weight curve for hitstop. Heavier reactions hang on the frame longer. */
function reactionWeight(r: HitReaction): number {
  switch (r) {
    case 'light':
      return 0;
    case 'sweep':
      return 2;
    case 'stun':
      return 1.5;
    case 'heavy':
      return 2.5;
    case 'launch':
      return 3.5;
    case 'blowback':
      return 4;
    case 'crumple':
      return 5;
  }
}

/** Shake multiplier per reaction; >= 4.5 magnitude also earns a camera punch. */
function reactionShake(r: HitReaction): number {
  switch (r) {
    case 'light':
      return 1;
    case 'stun':
      return 1.1;
    case 'sweep':
      return 1.5;
    case 'heavy':
      return 1.45;
    case 'launch':
      return 1.65;
    case 'blowback':
      return 1.75;
    case 'crumple':
      return 1.7;
  }
}

function round(v: number, places: number): number {
  const m = Math.pow(10, places);
  return Math.round(v * m) / m;
}

function hit(o: HitOpts): HitProperties {
  const react = o.react ?? 'light';
  const stun = o.stun;
  // Blocking must always be better than eating it, so blockstun is clamped
  // strictly under hitstun no matter what an entry asks for.
  const wanted = o.block ?? Math.round(stun * 0.55);
  const blockstun = stun > 7 ? clamp(wanted, 4, stun - 3) : Math.max(2, Math.min(wanted, stun - 1));
  const stop = o.stop ?? Math.round(clamp(2.5 + o.dmg * 0.42 + reactionWeight(react), 3, 18));
  const shake = o.shake ?? round(clamp(o.dmg * 0.26 * reactionShake(react), 0.6, 9), 2);
  return {
    damage: o.dmg,
    hitstun: stun,
    blockstun,
    hitstop: stop,
    knockback: { x: o.kx ?? round(0.9 + o.dmg * 0.17, 2), y: o.ky ?? 0 },
    pushback: o.push ?? round(0.25 + o.dmg * 0.055, 2),
    reaction: react,
    level: o.level ?? 'mid',
    chip: o.chip ?? DEFAULT_CHIP,
    meterGain: o.meter ?? round(0.0045 * o.dmg + 0.006, 4),
    meterGainVictim: o.vmeter ?? round(0.0055 * o.dmg + 0.004, 4),
    shake,
    sfx: o.sfx,
  };
}

function win(start: number, end: number, b: Box3, p: HitProperties, anchor?: BoneName): HitWindow {
  return { start, end, box: b, props: p, anchor };
}

export const MOVES: Record<string, MoveDef> = {};

function def(m: MoveDef): MoveDef {
  MOVES[m.id] = m;
  return m;
}

/**
 * Last-resort move handed back for an unknown id. It is a real, harmless poke
 * rather than a crash, so a content typo costs you a weak jab instead of the
 * whole run.
 */
export const FALLBACK_MOVE_ID = '__unknown';

const FALLBACK: MoveDef = {
  id: FALLBACK_MOVE_ID,
  name: '???',
  duration: 18,
  startup: 6,
  anim: 'punch1',
  windows: [win(6, 8, box(18, 26, 10, 10), hit({ dmg: 3, stun: 12, sfx: 'punch_light' }), 'handR')],
};

/**
 * Missing-id bookkeeping.
 *
 * The fallback is what keeps a live session playable, but a *silent* fallback is
 * precisely how dozens of unimplemented ids once hid in the content files: every
 * dwarf punched identically, every boss poked, and nothing ever crashed. So the
 * fallback stays and the silence goes.
 *
 *   - the first miss on an id is a `console.error`, not a warning — you are
 *     meant to trip over it the moment you play the fight;
 *   - repeats are throttled so a 60Hz whiff loop cannot bury the rest of the
 *     console, but they still resurface with a running count;
 *   - the tally is exported so the content validator can assert on it instead of
 *     scraping the console.
 */
const unknownIds = new Map<string, number>();
let unknownLookups = 0;

/** Misses of a single id between console reports, after the first. */
const REPEAT_EVERY = 120;

/** True if `id` names a real entry. Never records a miss — safe for validators. */
export function hasMove(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOVES, id);
}

/** Every id that resolved to the fallback, in first-seen (deterministic) order. */
export function unknownMoveIds(): string[] {
  return [...unknownIds.keys()];
}

/** Miss count per unknown id, for a validator that wants to report the worst. */
export function unknownMoveCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of unknownIds) out[id] = n;
  return out;
}

/** Total failed lookups since the last clear. */
export function unknownMoveLookups(): number {
  return unknownLookups;
}

/** Resets the tally. For tests and validators that check one content set at a time. */
export function clearUnknownMoves(): void {
  unknownIds.clear();
  unknownLookups = 0;
}

export function getMove(id: string): MoveDef {
  if (hasMove(id)) return MOVES[id];

  unknownLookups++;
  const seen = (unknownIds.get(id) ?? 0) + 1;
  unknownIds.set(id, seen);

  if (seen === 1) {
    console.error(
      `[Moves] MISSING MOVE "${id}" — content asked for a move this table does not ` +
        'implement. Falling back to a stock poke: the fight will LOOK fine and PLAY ' +
        'wrong. Implement it in src/game/combat/Moves.ts, or fix the id in src/content.',
    );
  } else if (seen % REPEAT_EVERY === 0) {
    console.error(`[Moves] MISSING MOVE "${id}" — used ${seen} times and still not implemented.`);
  }
  return FALLBACK;
}

export function registerMove(m: MoveDef): void {
  MOVES[m.id] = m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projectile / summon callbacks
// ─────────────────────────────────────────────────────────────────────────────

interface ShotOpts {
  kind: string;
  damage: number;
  /** Forward speed in world units per frame. */
  speed: number;
  /** Muzzle offset, forward and up. */
  ox?: number;
  oy?: number;
  /** Depth drift, mirrored by the rng spread when `spread` is set. */
  vz?: number;
  /** Random depth spread applied through ctx.rng. */
  spread?: number;
  /** Base vertical speed. Positive lobs it under gravity, negative drops it. */
  vy?: number;
  /** Random vertical speed spread, added to `vy`. */
  arc?: number;
  /** Cue played on the frame the shot leaves the muzzle. */
  sfx?: SfxCue;
}

/**
 * Fires `o` on each of `frames`. Deterministic: all variance comes from ctx.rng.
 * `MoveDef.sfx` is played at move START by the Fighter, so anything that should
 * be heard at the moment of release belongs here instead.
 */
function shots(frames: readonly number[], o: ShotOpts) {
  return (self: FighterView, frame: number, ctx: SimContext): void => {
    if (!frames.includes(frame)) return;
    const spread = o.spread ?? 0;
    const vz = (o.vz ?? 0) + (spread > 0 ? ctx.rng.range(-spread, spread) : 0);
    const arc = o.arc ?? 0;
    ctx.spawn(
      'projectile',
      self.pos.x + (o.ox ?? 18) * self.facing,
      self.pos.y + (o.oy ?? 26),
      self.pos.z,
      {
        vx: o.speed * self.facing,
        vz,
        vy: (o.vy ?? 0) + (arc > 0 ? ctx.rng.range(0, arc) : 0),
        damage: o.damage,
        owner: self.id,
        kind: o.kind,
      },
    );
    if (o.sfx) ctx.audio.play(o.sfx, { pitch: 1 + ctx.rng.range(-0.06, 0.06) });
  };
}

/**
 * Hurls whoever the fighter is currently holding. Throw moves keep `isGrab` so
 * the holder stays in the `grabbing` state — that is what keeps the victim
 * pinned — and this releases them on the frame the animation lets go.
 */
function hurl(atFrame: number, vx: number, vy: number) {
  return (self: FighterView, frame: number, ctx: SimContext): void => {
    if (frame !== atFrame) return;
    const holder = self as unknown as {
      throwHeld?: (x: number, y: number, c: SimContext) => void;
    };
    if (holder.throwHeld) holder.throwHeld(vx, vy, ctx);
  };
}

/** Boss adds. Picks from a fixed, ordered pool so replays stay identical. */
function summon(frames: readonly number[], pool: readonly string[], reach: number) {
  return (self: FighterView, frame: number, ctx: SimContext): void => {
    if (!frames.includes(frame)) return;
    const kind = ctx.rng.pick(pool);
    const side = ctx.rng.chance(0.5) ? 1 : -1;
    ctx.spawn(
      'enemy',
      self.pos.x + side * ctx.rng.range(reach * 0.5, reach),
      0,
      clamp(self.pos.z + ctx.rng.range(-24, 24), 4, 104),
      { kind },
    );
  };
}

type FrameFn = (self: FighterView, frame: number, ctx: SimContext) => void;

/** Runs several callbacks off one `onFrame` slot, in a fixed order. */
function sequence(...fns: FrameFn[]): FrameFn {
  return (self, frame, ctx) => {
    for (let i = 0; i < fns.length; i++) fns[i](self, frame, ctx);
  };
}

interface BurstOpts {
  count: number;
  shape: ParticleSpec['shape'];
  colors: string[];
  /** Offset from the fighter's origin: forward (facing space) and up. */
  ox?: number;
  oy?: number;
  /** Emission cone. Defaults to a full sphere. */
  angle?: number;
  spread?: number;
  speed?: [number, number];
  life?: [number, number];
  size?: [number, number];
  gravity?: number;
  drag?: number;
  additive?: boolean;
  spin?: number;
  sfx?: SfxCue;
}

/**
 * Presentation garnish on chosen frames — sparks, dust, cash, steam. Everything
 * here goes through FxBus/AudioBus, which are inert during rollback, so it is
 * safe to hang off a deterministic move.
 */
function burst(frames: readonly number[], o: BurstOpts): FrameFn {
  return (self, frame, ctx) => {
    if (!frames.includes(frame)) return;
    ctx.fx.particles({
      count: o.count,
      x: self.pos.x + (o.ox ?? 0) * self.facing,
      y: self.pos.y + (o.oy ?? 26),
      z: self.pos.z,
      angle: o.angle ?? Math.PI * 0.5,
      spread: o.spread ?? Math.PI,
      speed: o.speed ?? [1.2, 3.6],
      life: o.life ?? [8, 20],
      size: o.size ?? [1, 2.4],
      colors: o.colors,
      gravity: o.gravity ?? 0.12,
      drag: o.drag ?? 0.92,
      shape: o.shape,
      additive: o.additive,
      fade: 'ease',
      spin: o.spin,
    });
    if (o.sfx) ctx.audio.play(o.sfx, { pitch: 1 + ctx.rng.range(-0.06, 0.06) });
  };
}

interface PoundOpts {
  /** Radius of the distortion ring in world units. */
  radius: number;
  frames?: number;
  shake?: number;
  /** Dust thrown up off the floor. */
  dust?: number;
  colors?: string[];
  sfx?: SfxCue;
}

/**
 * The radial wave under a ground pound. Purely presentational: the damage still
 * belongs to a normal hit window, so what you see and what hits you stay in
 * step and neither one depends on the effect layer being alive.
 */
function groundPound(atFrame: number, o: PoundOpts): FrameFn {
  return (self, frame, ctx) => {
    if (frame !== atFrame) return;
    ctx.fx.shockwave(self.pos.x, self.pos.y + 6, self.pos.z, o.radius, o.frames ?? 16);
    ctx.fx.shake({ magnitude: o.shake ?? 6, duration: 14, frequency: 1.15, dirY: 1 });
    ctx.fx.particles({
      count: o.dust ?? 14,
      x: self.pos.x,
      y: self.pos.y + 3,
      z: self.pos.z,
      angle: Math.PI * 0.5,
      spread: Math.PI * 0.9,
      speed: [1.4, 4.6],
      life: [12, 30],
      size: [1.4, 3.6],
      colors: o.colors ?? ['#d9cfbd', '#a89c88', '#ffffff'],
      gravity: 0.2,
      drag: 0.9,
      shape: 'smoke',
      fade: 'ease',
      spin: 0.12,
    });
    if (o.sfx) ctx.audio.play(o.sfx, { pitch: 1 + ctx.rng.range(-0.05, 0.05) });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel routes
// ─────────────────────────────────────────────────────────────────────────────

const SPECIALS = [
  'sp_sneeze',
  'sp_snore',
  'sp_grump',
  'sp_doc',
  'sp_bashful',
  'sp_happy',
  'sp_dopey',
];

// ─────────────────────────────────────────────────────────────────────────────
// Ground normals
//
// There is no shared unarmed light/heavy pair. There used to be — `jab`,
// `straight`, `lowkick`, `roundhouse`, `uppercut`, `sweep` — and every dwarf
// pointed at the same two of them, which is the bug this file exists to keep
// fixed. Ground normals are generated per character further down; the only
// unarmed moves shared by the whole roster are the aerials, the run-in, the
// grab and the throws.

// The three shared aerial/run-in normals. Every dwarf keeps these — a jump-in
// and a run-in read the same on all seven, which is what makes the per-character
// ground normals below legible in the first place.

def({
  id: 'air_light',
  name: 'Air Stomp',
  duration: 20,
  startup: 5,
  anim: 'kick',
  airOnly: true,
  windows: [
    win(
      5,
      12,
      box(17, 12, 13, 11),
      hit({
        dmg: 7,
        stun: 17,
        block: 9,
        stop: 5,
        kx: 1.7,
        ky: -1,
        level: 'overhead',
        sfx: 'kick',
      }),
      'footR',
    ),
  ],
  cancels: [{ into: ['air_heavy'], from: 5 }],
});

def({
  id: 'air_heavy',
  name: 'Anvil Drop',
  duration: 28,
  startup: 8,
  anim: 'heavy_swing',
  airOnly: true,
  windows: [
    win(
      8,
      15,
      box(19, 9, 15, 13),
      hit({
        dmg: 13,
        stun: 23,
        block: 12,
        kx: 3.0,
        ky: -4.5,
        react: 'heavy',
        level: 'overhead',
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'dash_attack',
  name: 'Shoulder Charge',
  duration: 29,
  startup: 6,
  anim: 'punch2',
  sfx: 'dash',
  motion: [
    { frame: 1, x: 7.2, y: 0 },
    { frame: 6, x: 3.0, y: 0 },
  ],
  windows: [
    win(
      6,
      11,
      box(23, 24, 16, 14),
      hit({
        dmg: 12,
        stun: 23,
        block: 11,
        kx: 6.0,
        ky: 1.5,
        push: 1.4,
        react: 'heavy',
        sfx: 'punch_heavy',
      }),
      'chest',
    ),
  ],
  cancels: [{ into: SPECIALS, from: 8 }],
});

def({
  id: 'grab',
  // Long on purpose: the tail of the move IS the hold, and a whiffed grab
  // leaving you stood there for half a second is the price of a command throw.
  name: 'Collar Grab',
  duration: 42,
  startup: 3,
  anim: 'grab',
  isGrab: true,
  windows: [
    win(
      3,
      6,
      box(18, 24, 12, 16),
      hit({
        dmg: 0,
        stun: 46,
        block: 46,
        stop: 3,
        kx: 0,
        ky: 0,
        push: 0,
        react: 'stun',
        level: 'unblockable',
        chip: 0,
        meter: 0.01,
        vmeter: 0.008,
        shake: 0.8,
      }),
      'handL',
    ),
  ],
  cancels: [{ into: ['throwFwd', 'throwBack'], from: 8 }],
});

def({
  id: 'throwFwd',
  name: 'Faceplant',
  duration: 31,
  startup: 8,
  anim: 'throw',
  isGrab: true,
  sfx: 'grunt',
  onFrame: hurl(8, 9.0, 6.5),
  windows: [
    win(
      8,
      9,
      box(14, 22, 16, 20),
      hit({
        dmg: 16,
        stun: 34,
        block: 34,
        kx: 8.5,
        ky: 6.0,
        push: 0,
        react: 'blowback',
        level: 'unblockable',
        chip: 0,
        shake: 5.2,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'throwBack',
  name: 'Over The Shoulder',
  duration: 33,
  startup: 9,
  anim: 'throw',
  isGrab: true,
  sfx: 'grunt',
  onFrame: hurl(9, -8.5, 6.0),
  windows: [
    win(
      9,
      10,
      box(10, 24, 16, 20),
      hit({
        dmg: 14,
        stun: 34,
        block: 34,
        kx: -8.0,
        ky: 5.5,
        push: 0,
        react: 'blowback',
        level: 'unblockable',
        chip: 0,
        shake: 5.0,
        sfx: 'bone_crack',
      }),
      'handL',
    ),
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-dwarf normals
//
// This is where picking a dwarf starts to mean something. Everyone shares the
// jump-in, the run-in, the grab and the throws; nobody shares a punch. The
// generator below is deliberately narrow — it owns the *cancel discipline* so
// all seven obey the same grammar (light chains into itself, into its own heavy
// and into a grab; heavy cancels into the special) — while the boxes, frames,
// animation and reaction stay bespoke per character. Uniform rules, different
// characters: that is the whole design.
//
// Reading the roster off `content/dwarfs.ts`:
//   doc      tech 1.4   — precise, shortest recovery, cancels out of everything
//   grumpy   power 1.45 — slowest hands, biggest numbers, sends you to the wall
//   happy    speed 1.32 — 3f light that links into itself, hits like a rumour
//   sleepy   power 1.36 — startup measured in seasons, hitstop measured in years
//   bashful  tech 1.12  — short reach, and an invincible answer to your turn
//   sneezy   reach      — longest normals in the game, all of them push you off
//   dopey    speed 1.46 — fast, low, and arriving from an angle nobody ordered
// ─────────────────────────────────────────────────────────────────────────────

interface DwarfNormal {
  name: string;
  duration: number;
  startup: number;
  /** Active frames AFTER the first, so `active: 2` is a 3-frame window. */
  active: number;
  anim: string;
  box: Box3;
  hit: HitProperties;
  anchor?: BoneName;
  motion?: { frame: number; x: number; y: number }[];
  invuln?: { start: number; end: number };
  sfx?: SfxCue;
  /** Frame the cancel window opens. Defaults to the first active frame. */
  cancelFrom?: number;
  /** Routes on top of the shared grammar. */
  into?: string[];
}

interface DwarfNormals {
  /** Dwarf id from `content/dwarfs.ts`. Produces `<id>_light` and `<id>_heavy`. */
  id: string;
  light: DwarfNormal;
  heavy: DwarfNormal;
}

function dwarfNormals(s: DwarfNormals): void {
  const l = s.light;
  def({
    id: `${s.id}_light`,
    name: l.name,
    duration: l.duration,
    startup: l.startup,
    anim: l.anim,
    motion: l.motion,
    invuln: l.invuln,
    sfx: l.sfx,
    windows: [win(l.startup, l.startup + l.active, l.box, l.hit, l.anchor ?? 'handR')],
    cancels: [
      {
        into: [`${s.id}_light`, `${s.id}_heavy`, 'grab', ...(l.into ?? [])],
        from: l.cancelFrom ?? l.startup,
      },
    ],
  });

  const h = s.heavy;
  def({
    id: `${s.id}_heavy`,
    name: h.name,
    duration: h.duration,
    startup: h.startup,
    anim: h.anim,
    motion: h.motion,
    invuln: h.invuln,
    sfx: h.sfx,
    windows: [win(h.startup, h.startup + h.active, h.box, h.hit, h.anchor ?? 'handR')],
    cancels: [{ into: [...SPECIALS, ...(h.into ?? [])], from: h.cancelFrom ?? h.startup }],
  });
}

// ── Doc — SAWBONES ───────────────────────────────────────────────────────────
// Nothing wasted. Average damage, average reach, and the shortest recovery on
// the roster, so he is the only one whose LIGHT already sees the special.
dwarfNormals({
  id: 'doc',
  light: {
    name: 'Scalpel Jab',
    duration: 14,
    startup: 4,
    active: 2,
    anim: 'punch1',
    box: box(21, 30, 11, 9),
    hit: hit({ dmg: 5, stun: 15, block: 8, stop: 4, kx: 1.5, push: 0.4, sfx: 'punch_light' }),
    into: SPECIALS,
  },
  heavy: {
    name: 'Second Opinion',
    duration: 26,
    startup: 8,
    active: 3,
    anim: 'punch2',
    anchor: 'handL',
    box: box(27, 29, 14, 11),
    hit: hit({
      dmg: 13,
      stun: 24,
      block: 11,
      kx: 3.6,
      push: 0.7,
      react: 'heavy',
      sfx: 'punch_heavy',
    }),
  },
});

// ── Grumpy — MALICE ──────────────────────────────────────────────────────────
// Slow hands, landslide payload. The heavy is a full second of commitment and
// puts you in the wall from most of the screen.
dwarfNormals({
  id: 'grumpy',
  light: {
    name: 'Backhand',
    duration: 22,
    startup: 7,
    active: 3,
    anim: 'punch1',
    box: box(24, 31, 13, 10),
    hit: hit({ dmg: 9, stun: 19, block: 9, kx: 3.4, sfx: 'punch_heavy' }),
  },
  heavy: {
    name: 'Grudge',
    duration: 42,
    startup: 15,
    active: 4,
    anim: 'heavy_swing',
    motion: [{ frame: 13, x: 1.8, y: 0 }],
    box: box(32, 28, 18, 15),
    hit: hit({
      dmg: 23,
      stun: 35,
      block: 15,
      kx: 8.6,
      ky: 2.6,
      push: 1.6,
      react: 'blowback',
      shake: 6.8,
      sfx: 'bone_crack',
    }),
  },
});

// ── Happy — RIOT ─────────────────────────────────────────────────────────────
// The fastest button in the game and the weakest. It links into itself, so his
// whole plan is a wall of 4-damage nothing that never gives your turn back.
dwarfNormals({
  id: 'happy',
  light: {
    name: 'Party Trick',
    duration: 12,
    startup: 3,
    active: 2,
    anim: 'punch1',
    box: box(19, 29, 10, 9),
    hit: hit({ dmg: 4, stun: 12, block: 6, stop: 3, kx: 1.0, push: 0.3, sfx: 'punch_light' }),
  },
  heavy: {
    name: 'Encore',
    duration: 27,
    startup: 8,
    active: 3,
    anim: 'kick',
    anchor: 'footR',
    box: box(26, 26, 14, 12),
    hit: hit({ dmg: 11, stun: 22, block: 10, kx: 3.8, ky: 1.0, react: 'heavy', sfx: 'kick' }),
  },
});

// ── Sleepy — COMA ────────────────────────────────────────────────────────────
// Twenty frames of startup and eighteen of hitstop. You will see it coming; the
// question is whether there is anywhere to be instead.
dwarfNormals({
  id: 'sleepy',
  light: {
    name: 'Wake Up Call',
    duration: 27,
    startup: 9,
    active: 3,
    anim: 'punch1',
    box: box(24, 30, 13, 11),
    hit: hit({ dmg: 11, stun: 21, block: 10, stop: 8, kx: 2.8, sfx: 'punch_heavy' }),
  },
  heavy: {
    name: 'Lights Out',
    duration: 50,
    startup: 20,
    active: 4,
    anim: 'heavy_swing',
    motion: [{ frame: 18, x: 1.2, y: 0 }],
    box: box(30, 26, 18, 17),
    hit: hit({
      dmg: 27,
      stun: 42,
      block: 16,
      stop: 18,
      kx: 6.4,
      ky: 3.2,
      push: 1.4,
      react: 'crumple',
      shake: 7.4,
      sfx: 'bone_crack',
    }),
  },
});

// ── Bashful — BASH ───────────────────────────────────────────────────────────
// Everything is short. The heavy is invincible through its startup, which is how
// a man who will not look at you still wins the exchange he did not start.
dwarfNormals({
  id: 'bashful',
  light: {
    name: 'Flinch',
    duration: 16,
    startup: 5,
    active: 3,
    anim: 'punch1',
    box: box(17, 28, 10, 10),
    hit: hit({ dmg: 6, stun: 17, block: 8, stop: 4, kx: 1.6, sfx: 'punch_light' }),
  },
  heavy: {
    name: 'Sorry About This',
    duration: 34,
    startup: 10,
    active: 5,
    anim: 'uppercut',
    invuln: { start: 1, end: 6 },
    motion: [
      { frame: 8, x: 0.8, y: 0 },
      { frame: 10, x: 0.4, y: 3.4 },
    ],
    box: box(19, 32, 13, 20),
    hit: hit({
      dmg: 16,
      stun: 31,
      block: 13,
      kx: 2.6,
      ky: 8.0,
      push: 0.6,
      react: 'launch',
      shake: 5.4,
      sfx: 'punch_heavy',
    }),
  },
});

// ── Sneezy — PATIENT ZERO ────────────────────────────────────────────────────
// The longest normals in the game, and both of them are about distance rather
// than damage: everything he lands puts the fight back where he wants it.
dwarfNormals({
  id: 'sneezy',
  light: {
    name: 'Keep Back',
    duration: 24,
    startup: 8,
    active: 3,
    anim: 'kick',
    anchor: 'footR',
    box: box(29, 26, 15, 10),
    hit: hit({ dmg: 7, stun: 17, block: 9, kx: 4.2, push: 1.0, sfx: 'kick' }),
  },
  heavy: {
    name: 'Contagion',
    duration: 38,
    startup: 13,
    active: 4,
    anim: 'heavy_swing',
    box: box(35, 28, 19, 14),
    hit: hit({
      dmg: 15,
      stun: 26,
      block: 12,
      kx: 8.0,
      ky: 1.6,
      push: 2.0,
      react: 'blowback',
      shake: 5.0,
      sfx: 'sneeze',
    }),
  },
});

// ── Dopey — SILENT D ─────────────────────────────────────────────────────────
// A 4f low from the floor and a heavy that leaves the ground, so his heavy
// cancels into the AIR normals — nobody else's does, and nobody else lands where
// he does either.
dwarfNormals({
  id: 'dopey',
  light: {
    name: 'Whoops',
    duration: 14,
    startup: 4,
    active: 3,
    anim: 'kick',
    anchor: 'footR',
    box: box(22, 15, 12, 11),
    hit: hit({ dmg: 5, stun: 14, block: 7, stop: 3, kx: 1.8, level: 'low', sfx: 'kick' }),
  },
  heavy: {
    name: 'Hat Trick',
    duration: 30,
    startup: 9,
    active: 4,
    anim: 'uppercut',
    motion: [{ frame: 6, x: 3.0, y: 3.6 }],
    box: box(19, 25, 14, 19),
    hit: hit({
      dmg: 13,
      stun: 25,
      block: 12,
      kx: 3.2,
      ky: 5.0,
      react: 'launch',
      level: 'overhead',
      shake: 4.6,
      sfx: 'punch_heavy',
    }),
    into: ['air_light', 'air_heavy'],
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Specials — one per dwarf, 0.3 bar each
// ─────────────────────────────────────────────────────────────────────────────

def({
  id: 'sp_sneeze',
  name: 'Weaponised Sneeze',
  duration: 46,
  startup: 14,
  anim: 'heavy_swing',
  meterCost: 0.3,
  sfx: 'sneeze',
  invuln: { start: 1, end: 10 },
  motion: [{ frame: 14, x: -2.4, y: 0 }],
  windows: [
    win(
      14,
      19,
      box(28, 26, 21, 21),
      hit({
        dmg: 16,
        stun: 28,
        block: 14,
        kx: 7.0,
        ky: 3.5,
        push: 2.4,
        react: 'blowback',
        chip: 0.16,
        shake: 5.4,
        sfx: 'explosion',
      }),
      'head',
    ),
  ],
  onFrame: shots([16], { kind: 'snot', damage: 12, speed: 5.4, ox: 24, oy: 30, spread: 2.5 }),
});

def({
  id: 'sp_snore',
  name: 'Narcolepsy Slam',
  duration: 52,
  startup: 18,
  anim: 'heavy_swing',
  meterCost: 0.3,
  sfx: 'snore',
  motion: [{ frame: 16, x: 2.8, y: 3.0 }],
  windows: [
    win(
      18,
      24,
      box(9, 17, 23, 20),
      hit({
        dmg: 18,
        stun: 34,
        block: 15,
        kx: 3.0,
        ky: 2.0,
        react: 'crumple',
        level: 'overhead',
        chip: 0.15,
        shake: 6.0,
        sfx: 'bone_crack',
      }),
      'torso',
    ),
  ],
});

def({
  id: 'sp_grump',
  name: 'Ground Zero Grump',
  duration: 48,
  startup: 12,
  anim: 'sweep',
  meterCost: 0.3,
  sfx: 'grunt',
  invuln: { start: 1, end: 9 },
  windows: [
    win(
      12,
      17,
      box(0, 5, 44, 11, 20),
      hit({
        dmg: 15,
        stun: 30,
        block: 14,
        kx: 4.0,
        ky: 4.5,
        react: 'sweep',
        level: 'low',
        chip: 0.14,
        shake: 6.5,
        sfx: 'explosion',
      }),
      'footR',
    ),
  ],
});

def({
  id: 'sp_doc',
  name: 'Mandatory Explainer',
  duration: 46,
  startup: 13,
  anim: 'punch2',
  meterCost: 0.3,
  sfx: 'super_charge',
  windows: [
    win(
      13,
      17,
      box(24, 30, 14, 13),
      hit({
        dmg: 9,
        stun: 20,
        block: 11,
        kx: 2.0,
        react: 'heavy',
        chip: 0.1,
        sfx: 'punch_light',
      }),
      'handR',
    ),
  ],
  onFrame: shots([15, 22, 29], {
    kind: 'slide',
    damage: 8,
    speed: 6.6,
    ox: 22,
    oy: 30,
    spread: 6,
  }),
});

def({
  id: 'sp_bashful',
  name: 'Blush Nova',
  duration: 50,
  startup: 16,
  anim: 'uppercut',
  meterCost: 0.3,
  sfx: 'super_charge',
  invuln: { start: 1, end: 14 },
  windows: [
    win(
      16,
      22,
      box(0, 24, 34, 27, 22),
      hit({
        dmg: 17,
        stun: 32,
        block: 15,
        kx: 4.5,
        ky: 8.5,
        react: 'launch',
        chip: 0.15,
        shake: 5.8,
        sfx: 'explosion',
      }),
      'chest',
    ),
  ],
});

def({
  id: 'sp_happy',
  name: 'Disco Inferno',
  duration: 56,
  startup: 10,
  anim: 'heavy_swing',
  meterCost: 0.3,
  sfx: 'laugh',
  motion: [
    { frame: 10, x: 1.6, y: 0 },
    { frame: 20, x: 1.6, y: 0 },
    { frame: 30, x: 1.6, y: 0 },
  ],
  windows: [
    win(
      10,
      13,
      box(26, 26, 16, 18),
      hit({ dmg: 6, stun: 15, block: 8, stop: 4, kx: 1.2, chip: 0.08, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      18,
      21,
      box(26, 26, 16, 18),
      hit({ dmg: 6, stun: 15, block: 8, stop: 4, kx: 1.2, chip: 0.08, sfx: 'punch_light' }),
      'handL',
    ),
    win(
      26,
      29,
      box(26, 26, 16, 18),
      hit({ dmg: 6, stun: 15, block: 8, stop: 4, kx: 1.2, chip: 0.08, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      34,
      38,
      box(29, 24, 18, 20),
      hit({
        dmg: 11,
        stun: 28,
        block: 13,
        kx: 6.5,
        ky: 4.0,
        react: 'blowback',
        chip: 0.14,
        shake: 5.0,
        sfx: 'punch_heavy',
      }),
      'footR',
    ),
  ],
});

def({
  id: 'sp_dopey',
  name: 'Chaos Rain',
  duration: 46,
  startup: 12,
  anim: 'punch1',
  meterCost: 0.3,
  airOk: true,
  sfx: 'super_charge',
  windows: [
    win(
      12,
      15,
      box(18, 28, 13, 14),
      hit({ dmg: 7, stun: 18, block: 10, kx: 2.0, chip: 0.1, sfx: 'punch_light' }),
      'handR',
    ),
  ],
  onFrame: shots([12, 18, 24, 30], {
    kind: 'junk',
    damage: 9,
    speed: 4.4,
    ox: 16,
    oy: 34,
    spread: 9,
    arc: 5,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

interface WeaponSet {
  kind: WeaponKind;
  label: string;
  light: {
    name: string;
    duration: number;
    startup: number;
    active: number;
    box: Box3;
    hit: HitProperties;
  };
  heavy: {
    name: string;
    duration: number;
    startup: number;
    active: number;
    box: Box3;
    hit: HitProperties;
    motion?: { frame: number; x: number; y: number }[];
  };
  thrown: {
    name: string;
    duration: number;
    release: number;
    damage: number;
    speed: number;
    projectile: string;
    sfx: SfxCue;
  };
}

function weaponSet(s: WeaponSet): void {
  const l = s.light;
  def({
    id: `${s.kind}_light`,
    name: l.name,
    duration: l.duration,
    startup: l.startup,
    weapon: s.kind,
    anim: 'weapon_swing',
    sfx: 'weapon_swing',
    windows: [win(l.startup, l.startup + l.active, l.box, l.hit, 'handR')],
    cancels: [{ into: [`${s.kind}_heavy`, `${s.kind}_throw`, 'grab'], from: l.startup }],
  });

  const h = s.heavy;
  def({
    id: `${s.kind}_heavy`,
    name: h.name,
    duration: h.duration,
    startup: h.startup,
    weapon: s.kind,
    anim: 'weapon_heavy',
    sfx: 'weapon_swing',
    motion: h.motion,
    windows: [win(h.startup, h.startup + h.active, h.box, h.hit, 'handR')],
    cancels: [{ into: SPECIALS, from: h.startup }],
  });

  const t = s.thrown;
  def({
    id: `${s.kind}_throw`,
    name: t.name,
    duration: t.duration,
    startup: t.release,
    weapon: s.kind,
    anim: 'throw',
    sfx: t.sfx,
    windows: [],
    onFrame: shots([t.release], {
      kind: t.projectile,
      damage: t.damage,
      speed: t.speed,
      ox: 20,
      oy: 28,
    }),
  });
}

weaponSet({
  kind: 'chain',
  label: 'Bike Chain',
  light: {
    name: 'Chain Lash',
    duration: 26,
    startup: 8,
    active: 4,
    box: box(34, 27, 19, 12),
    hit: hit({ dmg: 9, stun: 19, block: 10, kx: 3.2, react: 'light', sfx: 'chain_whip' }),
  },
  heavy: {
    name: 'Chain Windmill',
    duration: 45,
    startup: 15,
    active: 7,
    box: box(38, 28, 23, 20),
    hit: hit({
      dmg: 16,
      stun: 28,
      block: 14,
      kx: 6.5,
      ky: 2.2,
      react: 'blowback',
      shake: 5.0,
      sfx: 'chain_whip',
    }),
    motion: [{ frame: 15, x: 1.2, y: 0 }],
  },
  thrown: {
    name: 'Chain Toss',
    duration: 30,
    release: 9,
    damage: 13,
    speed: 7.0,
    projectile: 'chain',
    sfx: 'chain_whip',
  },
});

weaponSet({
  kind: 'bat',
  label: 'Baseball Bat',
  light: {
    name: 'Bat Poke',
    duration: 24,
    startup: 7,
    active: 3,
    box: box(28, 28, 15, 12),
    hit: hit({ dmg: 10, stun: 19, block: 10, kx: 3.0, sfx: 'bat_crack' }),
  },
  heavy: {
    name: 'Home Run',
    duration: 41,
    startup: 13,
    active: 4,
    box: box(31, 29, 17, 17),
    hit: hit({
      dmg: 18,
      stun: 32,
      block: 15,
      kx: 4.2,
      ky: 8.4,
      react: 'launch',
      shake: 5.6,
      sfx: 'bat_crack',
    }),
    motion: [{ frame: 12, x: 1.8, y: 0 }],
  },
  thrown: {
    name: 'Bat Throw',
    duration: 28,
    release: 8,
    damage: 14,
    speed: 8.0,
    projectile: 'bat',
    sfx: 'weapon_swing',
  },
});

weaponSet({
  kind: 'ironbar',
  label: 'Iron Bar',
  light: {
    name: 'Bar Jab',
    duration: 27,
    startup: 9,
    active: 3,
    box: box(30, 28, 15, 12),
    hit: hit({ dmg: 11, stun: 20, block: 11, kx: 3.0, sfx: 'hit_metal' }),
  },
  heavy: {
    name: 'Overhead Crush',
    duration: 47,
    startup: 16,
    active: 4,
    box: box(26, 24, 16, 24),
    hit: hit({
      dmg: 21,
      stun: 36,
      block: 16,
      kx: 3.4,
      ky: 1.0,
      react: 'crumple',
      level: 'overhead',
      shake: 6.4,
      sfx: 'bone_crack',
    }),
    motion: [{ frame: 15, x: 1.4, y: 0 }],
  },
  thrown: {
    name: 'Bar Javelin',
    duration: 30,
    release: 9,
    damage: 15,
    speed: 7.6,
    projectile: 'ironbar',
    sfx: 'weapon_swing',
  },
});

weaponSet({
  kind: 'pipe',
  label: 'Lead Pipe',
  light: {
    name: 'Pipe Swipe',
    duration: 25,
    startup: 8,
    active: 3,
    box: box(28, 27, 15, 12),
    hit: hit({ dmg: 10, stun: 19, block: 10, kx: 3.0, sfx: 'hit_metal' }),
  },
  heavy: {
    name: 'Kneecapper',
    duration: 43,
    startup: 14,
    active: 4,
    box: box(29, 14, 17, 14),
    hit: hit({
      dmg: 18,
      stun: 30,
      block: 14,
      kx: 4.4,
      ky: 3.2,
      react: 'sweep',
      level: 'low',
      shake: 5.2,
      sfx: 'bone_crack',
    }),
    motion: [{ frame: 13, x: 1.6, y: 0 }],
  },
  thrown: {
    name: 'Pipe Toss',
    duration: 28,
    release: 8,
    damage: 13,
    speed: 7.2,
    projectile: 'pipe',
    sfx: 'weapon_swing',
  },
});

weaponSet({
  kind: 'taser',
  label: 'Compliance Taser',
  light: {
    name: 'Zap',
    duration: 22,
    startup: 6,
    active: 3,
    box: box(21, 27, 12, 12),
    hit: hit({
      dmg: 6,
      stun: 42,
      block: 12,
      stop: 5,
      kx: 0.8,
      react: 'stun',
      chip: 0.06,
      sfx: 'taser',
    }),
  },
  heavy: {
    name: 'Full Discharge',
    duration: 39,
    startup: 12,
    active: 5,
    box: box(24, 26, 14, 16),
    hit: hit({
      dmg: 12,
      stun: 62,
      block: 16,
      kx: 1.4,
      react: 'stun',
      chip: 0.1,
      shake: 3.2,
      sfx: 'taser',
    }),
  },
  thrown: {
    name: 'Taser Toss',
    duration: 26,
    release: 8,
    damage: 8,
    speed: 6.8,
    projectile: 'taser',
    sfx: 'taser',
  },
});

// The pistol is the one weapon that is genuinely ranged, so it does not use the
// melee template: light is a single aimed shot, heavy is a burst, and the throw
// is what you do once the magazine is empty.
def({
  id: 'pistol_light',
  name: 'Single Shot',
  duration: 22,
  startup: 5,
  weapon: 'pistol',
  anim: 'weapon_swing',
  windows: [],
  onFrame: shots([5], {
    kind: 'bullet',
    damage: 12,
    speed: 12.0,
    ox: 22,
    oy: 30,
    sfx: 'gunshot',
  }),
  cancels: [{ into: ['pistol_heavy', 'pistol_throw'], from: 6 }],
});

def({
  id: 'pistol_heavy',
  name: 'Three Round Burst',
  duration: 40,
  startup: 9,
  weapon: 'pistol',
  anim: 'weapon_heavy',
  windows: [],
  onFrame: shots([9, 14, 19], {
    kind: 'bullet',
    damage: 9,
    speed: 12.5,
    ox: 22,
    oy: 30,
    spread: 2,
    sfx: 'gunshot',
  }),
  cancels: [{ into: SPECIALS, from: 20 }],
});

def({
  id: 'pistol_throw',
  name: 'Out Of Ammo',
  duration: 24,
  startup: 7,
  weapon: 'pistol',
  anim: 'throw',
  sfx: 'drop',
  windows: [],
  onFrame: shots([7], { kind: 'pistol', damage: 7, speed: 8.4, ox: 20, oy: 28 }),
});

weaponSet({
  kind: 'riotshield',
  label: 'Riot Shield',
  light: {
    name: 'Shield Shove',
    duration: 24,
    startup: 7,
    active: 3,
    box: box(22, 26, 14, 18),
    hit: hit({ dmg: 8, stun: 18, block: 10, kx: 4.5, push: 1.4, react: 'heavy', sfx: 'hit_metal' }),
  },
  heavy: {
    name: 'Kettling Charge',
    duration: 42,
    startup: 14,
    active: 7,
    box: box(24, 26, 17, 22),
    hit: hit({
      dmg: 15,
      stun: 27,
      block: 13,
      kx: 7.2,
      ky: 1.6,
      react: 'blowback',
      shake: 4.9,
      sfx: 'hit_metal',
    }),
    motion: [
      { frame: 12, x: 4.6, y: 0 },
      { frame: 17, x: 2.2, y: 0 },
    ],
  },
  thrown: {
    name: 'Shield Frisbee',
    duration: 30,
    release: 10,
    damage: 12,
    speed: 6.4,
    projectile: 'riotshield',
    sfx: 'hit_metal',
  },
});

weaponSet({
  kind: 'cybertruck_door',
  label: 'Cybertruck Door',
  light: {
    name: 'Panel Gap Slap',
    duration: 34,
    startup: 12,
    active: 4,
    box: box(29, 26, 18, 20),
    hit: hit({
      dmg: 14,
      stun: 24,
      block: 12,
      kx: 4.6,
      react: 'heavy',
      shake: 4.6,
      sfx: 'hit_metal',
    }),
  },
  heavy: {
    name: 'Recall Notice',
    duration: 58,
    startup: 20,
    active: 7,
    box: box(32, 26, 22, 26),
    hit: hit({
      dmg: 26,
      stun: 40,
      block: 18,
      kx: 10.0,
      ky: 4.0,
      push: 2.2,
      react: 'blowback',
      chip: 0.22,
      shake: 8.0,
      sfx: 'glass',
    }),
    motion: [{ frame: 18, x: 2.4, y: 0 }],
  },
  thrown: {
    name: 'Door Yeet',
    duration: 40,
    release: 14,
    damage: 22,
    speed: 6.0,
    projectile: 'cybertruck_door',
    sfx: 'hit_metal',
  },
});

weaponSet({
  kind: 'keyboard',
  label: 'Mechanical Keyboard',
  light: {
    name: 'Hot Take',
    duration: 18,
    startup: 4,
    active: 3,
    box: box(21, 29, 12, 10),
    hit: hit({ dmg: 5, stun: 14, block: 8, stop: 4, kx: 1.5, sfx: 'punch_light' }),
  },
  heavy: {
    name: 'Ratio',
    duration: 31,
    startup: 10,
    active: 4,
    box: box(26, 28, 15, 13),
    hit: hit({ dmg: 10, stun: 22, block: 11, kx: 4.0, react: 'heavy', sfx: 'punch_heavy' }),
  },
  thrown: {
    name: 'Keyboard Warrior',
    duration: 22,
    release: 6,
    damage: 7,
    speed: 6.6,
    projectile: 'keyboard',
    sfx: 'drop',
  },
});

weaponSet({
  kind: 'gpu',
  label: 'Datacentre GPU',
  light: {
    name: 'Rack Swipe',
    duration: 28,
    startup: 9,
    active: 3,
    box: box(27, 27, 15, 13),
    hit: hit({ dmg: 12, stun: 21, block: 11, kx: 3.2, sfx: 'hit_metal' }),
  },
  heavy: {
    name: 'Compute Overrun',
    duration: 49,
    startup: 17,
    active: 5,
    box: box(29, 25, 18, 20),
    hit: hit({
      dmg: 22,
      stun: 36,
      block: 16,
      kx: 5.0,
      ky: 2.0,
      react: 'crumple',
      shake: 6.6,
      sfx: 'glass',
    }),
    motion: [{ frame: 16, x: 1.4, y: 0 }],
  },
  thrown: {
    name: 'Depreciating Asset',
    duration: 34,
    release: 11,
    damage: 20,
    speed: 5.6,
    projectile: 'gpu',
    sfx: 'glass',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Enemy moves — boxes are tall because guards are tall and dwarfs are not
// ─────────────────────────────────────────────────────────────────────────────

def({
  id: 'e_jab',
  name: 'Corporate Jab',
  duration: 22,
  startup: 7,
  anim: 'punch1',
  windows: [
    win(
      7,
      10,
      box(24, 32, 12, 17),
      hit({ dmg: 6, stun: 15, block: 9, stop: 4, kx: 2.0, sfx: 'punch_light' }),
      'handR',
    ),
  ],
  cancels: [{ into: ['e_swing'], from: 7 }],
});

def({
  id: 'e_swing',
  name: 'Baton Swing',
  duration: 35,
  startup: 12,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      12,
      16,
      box(30, 30, 16, 21),
      hit({ dmg: 12, stun: 23, block: 12, kx: 4.4, react: 'heavy', sfx: 'hit_metal' }),
      'handR',
    ),
  ],
});

def({
  id: 'e_shoot',
  name: 'Warning Shot',
  duration: 38,
  startup: 12,
  anim: 'weapon_swing',
  windows: [],
  onFrame: shots([12], {
    kind: 'bullet',
    damage: 10,
    speed: 11.5,
    ox: 22,
    oy: 42,
    sfx: 'gunshot',
  }),
});

def({
  id: 'e_shield_bash',
  name: 'Shield Bash',
  duration: 31,
  startup: 9,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  motion: [{ frame: 8, x: 3.2, y: 0 }],
  windows: [
    win(
      9,
      13,
      box(22, 30, 15, 22),
      hit({
        dmg: 9,
        stun: 19,
        block: 10,
        kx: 5.0,
        push: 1.5,
        react: 'heavy',
        sfx: 'hit_metal',
      }),
      'handL',
    ),
  ],
});

def({
  id: 'e_bot_slam',
  name: 'Servo Slam',
  duration: 47,
  startup: 16,
  anim: 'heavy_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      16,
      21,
      box(24, 16, 20, 18),
      hit({
        dmg: 16,
        stun: 29,
        block: 14,
        kx: 4.0,
        ky: 3.6,
        react: 'sweep',
        shake: 5.4,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
  ],
});

// ── Suits: corporate security, close protection ──────────────────────────────

def({
  id: 'e_haymaker',
  name: 'Performance Review',
  duration: 40,
  startup: 14,
  anim: 'heavy_swing',
  sfx: 'grunt',
  motion: [{ frame: 12, x: 1.6, y: 0 }],
  windows: [
    win(
      14,
      18,
      box(29, 30, 16, 20),
      hit({
        dmg: 15,
        stun: 27,
        block: 13,
        kx: 5.6,
        ky: 1.8,
        push: 1.0,
        react: 'heavy',
        shake: 5.0,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'e_pistol_whip',
  name: 'Pistol Whip',
  duration: 26,
  startup: 8,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      8,
      11,
      box(23, 32, 13, 17),
      hit({ dmg: 9, stun: 19, block: 10, kx: 2.4, sfx: 'hit_metal' }),
      'handR',
    ),
  ],
  // Whip you off him, then take the step back and shoot. Close Protection has
  // exactly one plan and this is both halves of it.
  cancels: [{ into: ['e_haymaker', 'e_shoot'], from: 8 }],
});

// ── Compliance Officer: nothing hurts much, everything lasts forever ─────────

def({
  id: 'e_taser_jab',
  name: 'Verbal Warning',
  duration: 24,
  startup: 7,
  anim: 'weapon_swing',
  sfx: 'taser',
  windows: [
    win(
      7,
      10,
      box(20, 30, 11, 16),
      hit({
        dmg: 5,
        stun: 38,
        block: 11,
        stop: 5,
        kx: 0.8,
        push: 0.2,
        react: 'stun',
        chip: 0.06,
        shake: 2.0,
        sfx: 'taser',
      }),
      'handR',
    ),
  ],
  onFrame: burst([7], {
    count: 5,
    shape: 'bolt',
    colors: ['#9ff2ff', '#ffffff', '#5ce1e6'],
    ox: 20,
    oy: 30,
    speed: [0.6, 2.2],
    life: [5, 12],
    size: [1, 2.2],
    gravity: 0,
    additive: true,
  }),
  cancels: [{ into: ['e_taser_zap'], from: 7 }],
});

def({
  id: 'e_taser_zap',
  name: 'Final Written Warning',
  duration: 42,
  startup: 12,
  anim: 'weapon_swing',
  sfx: 'taser',
  windows: [
    win(
      12,
      17,
      box(22, 30, 13, 18),
      hit({
        dmg: 10,
        stun: 58,
        block: 15,
        kx: 1.4,
        push: 0.3,
        react: 'stun',
        chip: 0.1,
        shake: 3.0,
        sfx: 'taser',
      }),
      'handR',
    ),
  ],
  onFrame: burst([12, 16, 20, 24], {
    count: 7,
    shape: 'bolt',
    colors: ['#9ff2ff', '#ffffff', '#6ee4ff'],
    ox: 22,
    oy: 28,
    speed: [1.0, 3.4],
    life: [6, 16],
    size: [1, 2.8],
    gravity: 0,
    additive: true,
    spin: 0.4,
  }),
});

// ── Public Order Unit ────────────────────────────────────────────────────────

def({
  id: 'e_shield_charge',
  name: 'Kettle',
  duration: 48,
  startup: 15,
  anim: 'weapon_swing',
  sfx: 'dash',
  motion: [
    { frame: 12, x: 5.8, y: 0 },
    { frame: 18, x: 2.8, y: 0 },
    { frame: 24, x: 1.4, y: 0 },
  ],
  windows: [
    win(
      15,
      28,
      box(24, 30, 16, 22),
      hit({
        dmg: 16,
        stun: 28,
        block: 14,
        kx: 7.5,
        ky: 1.6,
        push: 0.8,
        react: 'blowback',
        shake: 5.4,
        sfx: 'hit_metal',
      }),
      'handL',
    ),
  ],
});

def({
  id: 'e_baton',
  name: 'Extendable Baton',
  duration: 28,
  startup: 9,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      9,
      12,
      box(27, 30, 14, 18),
      hit({ dmg: 10, stun: 20, block: 10, kx: 3.0, sfx: 'hit_metal' }),
      'handR',
    ),
  ],
  cancels: [{ into: ['e_bot_slam'], from: 9 }],
});

// ── Autonomous Floor Care: knee-high, faster than you, entirely sincere ──────

def({
  id: 'e_vac_ram',
  name: 'Cleaning In Progress',
  duration: 24,
  startup: 6,
  anim: 'run',
  sfx: 'engine',
  motion: [
    { frame: 4, x: 4.4, y: 0 },
    { frame: 8, x: 2.0, y: 0 },
  ],
  windows: [
    win(
      6,
      13,
      box(13, 6, 13, 8),
      hit({
        dmg: 6,
        stun: 16,
        block: 8,
        stop: 4,
        kx: 2.4,
        ky: 2.4,
        react: 'sweep',
        level: 'low',
        sfx: 'hit_metal',
      }),
      'root',
    ),
  ],
});

def({
  id: 'e_vac_spin',
  name: 'Spot Clean',
  duration: 42,
  startup: 10,
  anim: 'sweep',
  sfx: 'engine',
  windows: [
    win(
      10,
      12,
      box(0, 6, 20, 8, 18),
      hit({
        dmg: 5,
        stun: 14,
        block: 7,
        stop: 3,
        kx: 1.8,
        ky: 1.4,
        react: 'sweep',
        level: 'low',
        sfx: 'hit_metal',
      }),
      'root',
    ),
    win(
      17,
      19,
      box(0, 6, 21, 8, 18),
      hit({
        dmg: 5,
        stun: 14,
        block: 7,
        stop: 3,
        kx: 1.8,
        ky: 1.4,
        react: 'sweep',
        level: 'low',
        sfx: 'hit_metal',
      }),
      'root',
    ),
    win(
      24,
      27,
      box(0, 7, 23, 9, 19),
      hit({
        dmg: 8,
        stun: 22,
        block: 10,
        kx: 3.4,
        ky: 3.6,
        react: 'sweep',
        level: 'low',
        shake: 3.4,
        sfx: 'hit_metal',
      }),
      'root',
    ),
  ],
});

// ── Smart Refrigerator: 210hp of white goods with an opinion ────────────────

def({
  id: 'e_door_swing',
  name: 'Door Ajar',
  duration: 38,
  startup: 11,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      11,
      15,
      box(28, 26, 17, 20),
      hit({
        dmg: 12,
        stun: 22,
        block: 11,
        kx: 4.6,
        react: 'heavy',
        shake: 4.4,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
    // …and the door shuts again, which drags you back in with it.
    win(
      23,
      26,
      box(20, 26, 13, 19),
      hit({
        dmg: 6,
        stun: 16,
        block: 8,
        stop: 4,
        kx: -2.2,
        push: 0,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'e_fridge_crush',
  name: 'Scheduled Maintenance',
  duration: 76,
  startup: 26,
  anim: 'heavy_swing',
  sfx: 'engine',
  // Twenty-six frames of a fridge leaning over you. There is no ambiguity about
  // what is going to happen; the whole joke is how long you have to think about it.
  motion: [{ frame: 24, x: 2.0, y: 0 }],
  windows: [
    win(
      26,
      33,
      box(20, 10, 22, 26),
      hit({
        dmg: 30,
        stun: 46,
        block: 18,
        stop: 18,
        kx: 3.0,
        ky: 2.0,
        push: 0,
        react: 'crumple',
        level: 'overhead',
        chip: 0.2,
        shake: 8.6,
        sfx: 'explosion',
      }),
      'chest',
    ),
    // Everything on the shelves arrives a moment after the fridge does.
    win(
      34,
      38,
      box(14, 5, 26, 8, 20),
      hit({
        dmg: 6,
        stun: 20,
        block: 9,
        kx: 2.6,
        ky: 3.0,
        react: 'sweep',
        level: 'low',
        sfx: 'glass',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    groundPound(26, { radius: 84, frames: 20, shake: 8.5, dust: 18, sfx: 'explosion' }),
    burst([27], {
      count: 12,
      shape: 'shard',
      colors: ['#dfe6ee', '#9fd8ff', '#ffffff'],
      ox: 16,
      oy: 8,
      speed: [1.6, 5.0],
      life: [12, 28],
      size: [1.2, 3.0],
      gravity: 0.3,
      spin: 0.35,
    }),
  ),
});

def({
  id: 'e_ice_spit',
  name: 'Ice And Water Dispenser',
  duration: 44,
  startup: 13,
  anim: 'weapon_swing',
  sfx: 'engine',
  windows: [],
  onFrame: shots([13, 18, 23], {
    kind: 'ice',
    damage: 7,
    speed: 7.4,
    ox: 22,
    oy: 30,
    spread: 3,
    sfx: 'glass',
  }),
});

// ── Always-Listening Speaker: the only enemy that fights with pressure ───────

def({
  id: 'e_speaker_shove',
  name: 'Bump',
  duration: 26,
  startup: 8,
  anim: 'punch1',
  sfx: 'engine',
  motion: [{ frame: 7, x: 2.2, y: 0 }],
  windows: [
    win(
      8,
      12,
      box(18, 22, 14, 18),
      hit({ dmg: 8, stun: 17, block: 9, kx: 3.4, sfx: 'hit_metal' }),
      'chest',
    ),
  ],
});

def({
  id: 'e_bass_drop',
  name: 'Bass Drop',
  duration: 58,
  startup: 20,
  anim: 'heavy_swing',
  sfx: 'super_charge',
  // Twenty frames of the cone travelling backwards, then the room moves.
  windows: [
    win(
      20,
      27,
      box(34, 24, 26, 22),
      hit({
        dmg: 15,
        stun: 26,
        block: 13,
        kx: 8.0,
        ky: 2.6,
        push: 1.2,
        react: 'blowback',
        chip: 0.18,
        shake: 7.0,
        sfx: 'explosion',
      }),
      'chest',
    ),
  ],
  onFrame: sequence(
    groundPound(20, {
      radius: 96,
      frames: 22,
      shake: 7.5,
      dust: 10,
      colors: ['#37e6c8', '#9ff2ff', '#ffffff'],
    }),
    shots([20], { kind: 'bass', damage: 10, speed: 3.4, ox: 26, oy: 22, sfx: 'explosion' }),
  ),
});

def({
  id: 'e_sonic_blast',
  name: 'Are You Still Listening',
  duration: 48,
  startup: 14,
  anim: 'weapon_swing',
  sfx: 'super_charge',
  windows: [
    win(
      14,
      24,
      box(44, 26, 34, 10, 10),
      hit({
        dmg: 9,
        stun: 20,
        block: 10,
        kx: 5.0,
        react: 'blowback',
        chip: 0.2,
        shake: 3.6,
        sfx: 'super_blast',
      }),
      'chest',
    ),
  ],
  onFrame: shots([14, 19, 24], {
    kind: 'sonic',
    damage: 6,
    speed: 9.0,
    ox: 28,
    oy: 26,
    spread: 2,
  }),
});

// ── Last-Mile Drone: everything it does, it does from above ─────────────────

def({
  id: 'e_rotor_slash',
  name: 'Rotor Slash',
  duration: 32,
  startup: 8,
  anim: 'fall',
  airOk: true,
  sfx: 'engine',
  motion: [
    { frame: 6, x: 3.2, y: -1.2 },
    { frame: 12, x: 1.6, y: -0.8 },
  ],
  windows: [
    win(
      8,
      10,
      box(16, 20, 14, 16),
      hit({
        dmg: 8,
        stun: 18,
        block: 9,
        stop: 4,
        kx: 2.6,
        ky: -1.0,
        level: 'overhead',
        sfx: 'weapon_swing',
      }),
      'handR',
    ),
    win(
      14,
      16,
      box(16, 20, 14, 16),
      hit({
        dmg: 8,
        stun: 18,
        block: 9,
        stop: 4,
        kx: 2.6,
        ky: -1.0,
        level: 'overhead',
        sfx: 'weapon_swing',
      }),
      'handL',
    ),
  ],
});

def({
  id: 'e_package_drop',
  name: 'Delivered To Your Safe Place',
  duration: 44,
  startup: 12,
  anim: 'throw',
  airOk: true,
  sfx: 'engine',
  windows: [],
  // Released from well above head height and dropped, not thrown: the parcel is
  // only dangerous once it has fallen far enough to be somebody's problem.
  onFrame: shots([12], {
    kind: 'package',
    damage: 14,
    speed: 0.8,
    ox: 8,
    oy: 74,
    vy: -3.2,
    sfx: 'drop',
  }),
});

// ── Unpaid Intern: no training, no notice period, no fear ───────────────────

def({
  id: 'e_slap',
  name: 'Open-Handed Slap',
  duration: 18,
  startup: 5,
  anim: 'punch1',
  windows: [
    win(
      5,
      7,
      box(20, 30, 11, 14),
      hit({ dmg: 4, stun: 13, block: 7, stop: 3, kx: 1.2, sfx: 'punch_light' }),
      'handR',
    ),
  ],
  cancels: [{ into: ['e_slap', 'e_laptop_swing'], from: 5 }],
});

def({
  id: 'e_laptop_swing',
  name: 'Company Laptop',
  duration: 34,
  startup: 11,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      11,
      15,
      box(26, 29, 15, 14),
      hit({
        dmg: 11,
        stun: 22,
        block: 11,
        kx: 4.0,
        react: 'heavy',
        shake: 3.8,
        sfx: 'glass',
      }),
      'handR',
    ),
  ],
  onFrame: burst([12], {
    count: 6,
    shape: 'shard',
    colors: ['#8be0c8', '#dfe6ee', '#ffffff'],
    ox: 24,
    oy: 29,
    speed: [1.4, 4.0],
    life: [10, 22],
    size: [0.8, 2.0],
    gravity: 0.26,
    spin: 0.4,
  }),
});

def({
  id: 'e_coffee_throw',
  name: 'Not Your Order',
  duration: 34,
  startup: 10,
  anim: 'throw',
  windows: [],
  onFrame: shots([10], {
    kind: 'coffee',
    damage: 8,
    speed: 5.6,
    ox: 20,
    oy: 36,
    arc: 2.4,
    sfx: 'drop',
  }),
});

// ── Government Affairs: never lands a punch, always wins the meeting ────────

def({
  id: 'e_briefcase',
  name: 'Briefcase Swat',
  duration: 26,
  startup: 8,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      8,
      11,
      box(25, 30, 14, 16),
      hit({ dmg: 9, stun: 19, block: 10, kx: 3.4, sfx: 'punch_heavy' }),
      'handR',
    ),
  ],
  cancels: [{ into: ['e_handshake'], from: 8 }],
});

def({
  id: 'e_handshake',
  name: 'Firm Handshake',
  duration: 44,
  startup: 13,
  anim: 'grab',
  sfx: 'grunt',
  // Not a throw — he never lets go and he never stops talking. Almost no
  // knockback, enormous hitstun: the damage is the half-second of your life.
  windows: [
    win(
      13,
      18,
      box(22, 28, 13, 18),
      hit({
        dmg: 13,
        stun: 40,
        block: 14,
        kx: 1.0,
        push: 0,
        react: 'stun',
        chip: 0.08,
        shake: 2.6,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'e_donation',
  name: 'Campaign Contribution',
  duration: 40,
  startup: 12,
  anim: 'taunt',
  sfx: 'coin',
  // Four damage. Thirty-four frames of standing there covered in it.
  windows: [
    win(
      12,
      20,
      box(26, 26, 16, 20),
      hit({
        dmg: 4,
        stun: 34,
        block: 10,
        stop: 4,
        kx: 0.6,
        push: 0,
        react: 'stun',
        chip: 0.03,
        vmeter: 0.05,
        shake: 1.2,
        sfx: 'coin',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    shots([12, 17, 22], {
      kind: 'cash',
      damage: 3,
      speed: 4.2,
      ox: 20,
      oy: 38,
      spread: 7,
      arc: 3,
      sfx: 'coin',
    }),
    burst([12, 18, 24], {
      count: 8,
      shape: 'star',
      colors: ['#d9b451', '#f4e2a0', '#7ea36a'],
      ox: 20,
      oy: 40,
      speed: [0.8, 2.6],
      life: [24, 50],
      size: [1.2, 2.6],
      gravity: 0.06,
      drag: 0.94,
      spin: 0.3,
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Boss set-pieces
// ─────────────────────────────────────────────────────────────────────────────

def({
  id: 'b_slam',
  name: 'Shareholder Value',
  duration: 55,
  startup: 18,
  anim: 'heavy_swing',
  sfx: 'grunt',
  windows: [
    win(
      18,
      23,
      box(28, 20, 23, 24),
      hit({
        dmg: 20,
        stun: 32,
        block: 15,
        kx: 5.4,
        ky: 4.5,
        react: 'sweep',
        chip: 0.16,
        shake: 7.0,
        sfx: 'explosion',
      }),
      'handR',
    ),
  ],
  cancels: [{ into: ['b_stomp'], from: 30 }],
});

def({
  id: 'b_summon',
  name: 'Hire More Interns',
  duration: 72,
  startup: 22,
  anim: 'taunt',
  sfx: 'super_charge',
  windows: [],
  onFrame: summon([22, 34, 46], ['intern', 'suit_guard', 'iot_speaker', 'security_bot'], 150),
});

def({
  id: 'b_stomp',
  name: 'Down Round',
  duration: 50,
  startup: 16,
  anim: 'sweep',
  sfx: 'grunt',
  windows: [
    win(
      16,
      21,
      box(0, 6, 46, 11, 24),
      hit({
        dmg: 17,
        stun: 30,
        block: 14,
        kx: 4.2,
        ky: 5.0,
        react: 'sweep',
        level: 'low',
        chip: 0.15,
        shake: 8.0,
        sfx: 'explosion',
      }),
      'footR',
    ),
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Boss verbs
//
// The set-pieces above are one boss each. These twelve are the shared vocabulary
// that all fourteen bosses are built from — `content/bosses.ts` picks three to
// five per phase — so they are written to be READ rather than reacted to: long
// telegraphs, one unmistakable silhouette per verb, and recovery you can
// actually punish. A boss that kills you with something you never saw is not
// difficult, it is just rude.
//
// None of them costs meter: bosses never build any, and a phase whose move
// silently failed to start would leave the fight standing still.
// ─────────────────────────────────────────────────────────────────────────────

def({
  id: 'b_charge',
  name: 'All In',
  duration: 78,
  startup: 20,
  anim: 'run',
  sfx: 'dash',
  // The committed one: a full twenty frames of loading up, armoured through the
  // run, and then thirty frames of standing in the open having missed.
  invuln: { start: 12, end: 38 },
  motion: [
    { frame: 18, x: 8.8, y: 0 },
    { frame: 26, x: 4.4, y: 0 },
    { frame: 34, x: 2.4, y: 0 },
  ],
  windows: [
    win(
      20,
      40,
      box(24, 26, 20, 26),
      hit({
        dmg: 21,
        stun: 33,
        block: 16,
        kx: 10.0,
        ky: 2.8,
        push: 1.2,
        react: 'blowback',
        chip: 0.16,
        shake: 7.0,
        sfx: 'punch_heavy',
      }),
      'chest',
    ),
  ],
  cancels: [{ into: ['b_slam', 'b_uppercut'], from: 44 }],
});

def({
  id: 'b_dash',
  name: 'Closing Statement',
  duration: 40,
  startup: 9,
  anim: 'run',
  sfx: 'dash',
  // The cheap one. Half a b_charge, a quarter of the commitment, and the tool a
  // boss uses to make the screen small again.
  motion: [
    { frame: 7, x: 7.4, y: 0 },
    { frame: 12, x: 3.0, y: 0 },
  ],
  windows: [
    win(
      9,
      18,
      box(22, 26, 17, 24),
      hit({
        dmg: 13,
        stun: 24,
        block: 12,
        kx: 5.4,
        ky: 1.2,
        push: 0.8,
        react: 'heavy',
        chip: 0.12,
        shake: 4.4,
        sfx: 'punch_heavy',
      }),
      'chest',
    ),
  ],
  cancels: [{ into: ['b_slam', 'b_sweep', 'b_grab'], from: 20 }],
});

def({
  id: 'b_leap',
  name: 'Overhead Review',
  duration: 64,
  startup: 22,
  anim: 'jump',
  sfx: 'jump',
  motion: [
    { frame: 6, x: 4.2, y: 8.4 },
    { frame: 26, x: 1.4, y: -3.0 },
  ],
  windows: [
    // On the way down he is a falling object…
    win(
      22,
      30,
      box(16, 16, 16, 20),
      hit({
        dmg: 14,
        stun: 25,
        block: 12,
        kx: 3.2,
        ky: -2.2,
        react: 'heavy',
        level: 'overhead',
        chip: 0.14,
        shake: 5.0,
        sfx: 'punch_heavy',
      }),
      'footR',
    ),
    // …and where he lands, the floor is briefly not a safe place to stand.
    win(
      32,
      38,
      box(0, 6, 36, 10, 24),
      hit({
        dmg: 18,
        stun: 30,
        block: 14,
        kx: 4.6,
        ky: 5.0,
        react: 'sweep',
        level: 'low',
        chip: 0.15,
        shake: 7.6,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: groundPound(32, { radius: 92, frames: 20, shake: 7.5, dust: 20, sfx: 'explosion' }),
});

def({
  id: 'b_shockwave',
  name: 'Market Correction',
  duration: 70,
  startup: 20,
  anim: 'heavy_swing',
  sfx: 'grunt',
  windows: [
    // The pound itself, straight down and close in.
    win(
      20,
      24,
      box(0, 8, 30, 14, 24),
      hit({
        dmg: 20,
        stun: 32,
        block: 15,
        kx: 3.6,
        ky: 4.6,
        react: 'sweep',
        level: 'low',
        chip: 0.16,
        shake: 8.5,
        sfx: 'explosion',
      }),
      'handR',
    ),
    // Then the ring, which is the half that catches everyone who backed off.
    win(
      26,
      32,
      box(0, 6, 62, 10, 30),
      hit({
        dmg: 12,
        stun: 26,
        block: 13,
        kx: 7.4,
        ky: 4.2,
        react: 'blowback',
        level: 'low',
        chip: 0.22,
        shake: 5.8,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    groundPound(20, { radius: 70, frames: 14, shake: 8.5, dust: 22, sfx: 'explosion' }),
    groundPound(26, { radius: 150, frames: 26, shake: 5.0, dust: 14 }),
  ),
});

def({
  id: 'b_sweep',
  name: 'Restructuring',
  duration: 46,
  startup: 13,
  anim: 'sweep',
  sfx: 'grunt',
  windows: [
    win(
      13,
      18,
      box(30, 7, 22, 9, 22),
      hit({
        dmg: 16,
        stun: 28,
        block: 13,
        kx: 4.0,
        ky: 4.2,
        react: 'sweep',
        level: 'low',
        chip: 0.14,
        shake: 5.4,
        sfx: 'kick',
      }),
      'footL',
    ),
  ],
  cancels: [{ into: ['b_slam', 'b_stomp'], from: 22 }],
});

def({
  id: 'b_spin',
  name: 'Full Rotation',
  duration: 60,
  startup: 12,
  anim: 'heavy_swing',
  sfx: 'weapon_swing',
  // Hits on both sides, so there is no free side to stand on — the answer is the
  // z-axis, which is what a belt-scroller wants you to remember.
  windows: [
    win(
      12,
      14,
      box(0, 24, 30, 20, 24),
      hit({ dmg: 7, stun: 16, block: 8, stop: 5, kx: 2.2, chip: 0.1, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      20,
      22,
      box(0, 24, 31, 20, 24),
      hit({ dmg: 7, stun: 16, block: 8, stop: 5, kx: 2.2, chip: 0.1, sfx: 'punch_light' }),
      'handL',
    ),
    win(
      28,
      30,
      box(0, 24, 32, 20, 25),
      hit({ dmg: 7, stun: 16, block: 8, stop: 5, kx: 2.2, chip: 0.1, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      36,
      40,
      box(0, 24, 34, 22, 26),
      hit({
        dmg: 15,
        stun: 30,
        block: 14,
        kx: 7.8,
        ky: 3.2,
        push: 0.6,
        react: 'blowback',
        chip: 0.16,
        shake: 6.2,
        sfx: 'punch_heavy',
      }),
      'handL',
    ),
  ],
});

def({
  id: 'b_grab',
  name: 'Acqui-hire',
  duration: 56,
  startup: 5,
  anim: 'throw',
  isGrab: true,
  sfx: 'grunt',
  // A boss command throw, fused: the catch is a zero-damage grab window (which
  // the resolver treats as a seizure and which cannot touch another boss), and
  // the slam that follows is an ordinary unblockable strike on the frame the
  // animation lets go. Blocking does not help. Not being there does.
  onFrame: hurl(18, 8.5, 6.0),
  windows: [
    win(
      5,
      9,
      box(20, 26, 14, 22),
      hit({
        dmg: 0,
        stun: 58,
        block: 58,
        stop: 3,
        kx: 0,
        ky: 0,
        push: 0,
        react: 'stun',
        level: 'unblockable',
        chip: 0,
        meter: 0.01,
        vmeter: 0.01,
        shake: 1.0,
      }),
      'handR',
    ),
    win(
      18,
      19,
      box(14, 20, 14, 20),
      hit({
        dmg: 24,
        stun: 38,
        block: 38,
        kx: 9.0,
        ky: 6.0,
        push: 0,
        react: 'blowback',
        level: 'unblockable',
        chip: 0,
        shake: 7.4,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'b_uppercut',
  name: 'Promoted',
  duration: 50,
  startup: 11,
  anim: 'uppercut',
  sfx: 'grunt',
  invuln: { start: 1, end: 8 },
  motion: [
    { frame: 9, x: 1.2, y: 0 },
    { frame: 11, x: 0.8, y: 5.0 },
  ],
  windows: [
    win(
      11,
      17,
      box(18, 34, 16, 24),
      hit({
        dmg: 21,
        stun: 34,
        block: 15,
        kx: 3.0,
        ky: 11.0,
        push: 0.6,
        react: 'launch',
        chip: 0.15,
        shake: 6.2,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
});

def({
  id: 'b_beam',
  name: 'Full Self-Delivery',
  duration: 88,
  startup: 26,
  anim: 'weapon_swing',
  sfx: 'super_charge',
  // Twenty-six frames of charge, then a beam that re-hits three times. Enormous
  // chip: blocking survives it, but blocking all of it is not a plan.
  windows: [
    win(
      26,
      31,
      box(52, 28, 44, 13, 11),
      hit({
        dmg: 11,
        stun: 22,
        block: 11,
        kx: 3.0,
        react: 'heavy',
        chip: 0.3,
        shake: 4.0,
        sfx: 'super_blast',
      }),
      'head',
    ),
    win(
      34,
      39,
      box(54, 28, 46, 13, 11),
      hit({
        dmg: 11,
        stun: 22,
        block: 11,
        kx: 3.0,
        react: 'heavy',
        chip: 0.3,
        shake: 4.0,
        sfx: 'super_blast',
      }),
      'head',
    ),
    win(
      42,
      48,
      box(56, 28, 48, 14, 11),
      hit({
        dmg: 14,
        stun: 28,
        block: 13,
        kx: 6.6,
        ky: 2.4,
        react: 'blowback',
        chip: 0.3,
        shake: 6.0,
        sfx: 'super_blast',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    burst([14, 18, 22], {
      count: 8,
      shape: 'spark',
      colors: ['#9ff2ff', '#ffffff', '#6ee4ff'],
      ox: 26,
      oy: 30,
      angle: Math.PI * 0.5,
      spread: Math.PI,
      speed: [0.6, 2.0],
      life: [8, 18],
      size: [1, 2.4],
      gravity: -0.04,
      additive: true,
    }),
    shots([26, 32, 38, 44], {
      kind: 'beam',
      damage: 9,
      speed: 13.5,
      ox: 34,
      oy: 30,
      sfx: 'super_blast',
    }),
  ),
});

def({
  id: 'b_projectile',
  name: 'Shipped To Production',
  duration: 54,
  startup: 16,
  anim: 'weapon_heavy',
  sfx: 'super_charge',
  windows: [],
  onFrame: shots([16, 26], {
    kind: 'boss_shot',
    damage: 16,
    speed: 7.6,
    ox: 28,
    oy: 32,
    spread: 4,
    sfx: 'explosion',
  }),
});

def({
  id: 'b_rage',
  name: 'Hardcore Mode',
  duration: 84,
  startup: 30,
  anim: 'taunt',
  sfx: 'super_charge',
  // No hitbox at all. It is a roar, and the payoff is fifty-five frames of not
  // being able to touch him — which is exactly the phase-change beat every boss
  // in the game needs and none of them should have to author twice.
  invuln: { start: 6, end: 60 },
  windows: [],
  onFrame: sequence(
    burst([10, 18, 26, 34, 42, 50], {
      count: 10,
      shape: 'spark',
      colors: ['#ff4d4d', '#ffcf5c', '#ffffff'],
      oy: 28,
      angle: Math.PI * 0.5,
      spread: Math.PI,
      speed: [1.2, 4.2],
      life: [12, 26],
      size: [1.2, 3.0],
      gravity: -0.06,
      additive: true,
      spin: 0.3,
    }),
    (self, frame, ctx) => {
      if (frame !== 30) return;
      ctx.fx.shockwave(self.pos.x, self.pos.y + 24, self.pos.z, 120, 26);
      ctx.fx.shake({ magnitude: 6.5, duration: 30, frequency: 1.4 });
      ctx.fx.flash('#ff5a4d', 6, 0.3);
      ctx.fx.aberration(0.7, 22);
      ctx.audio.play('explosion', { pitch: 0.7 + ctx.rng.range(-0.04, 0.04) });
    },
  ),
});

def({
  id: 'b_taunt',
  name: 'Thoughts On This',
  duration: 62,
  startup: 18,
  anim: 'taunt',
  sfx: 'laugh',
  // Two damage and a very long look. Being talked down to fills your meter
  // faster than anything else in the game, which is the only justice on offer.
  windows: [
    win(
      18,
      26,
      box(0, 26, 42, 26, 26),
      hit({
        dmg: 2,
        stun: 22,
        block: 8,
        stop: 4,
        kx: 3.2,
        push: 0,
        react: 'stun',
        chip: 0.02,
        meter: 0,
        vmeter: 0.18,
        shake: 2.2,
        sfx: 'laugh',
      }),
      'head',
    ),
  ],
  onFrame: burst([18, 30, 42], {
    count: 6,
    shape: 'star',
    colors: ['#ffd166', '#ffffff', '#ff8fae'],
    oy: 42,
    angle: Math.PI * 0.5,
    spread: 1.4,
    speed: [0.8, 2.4],
    life: [18, 34],
    size: [1.4, 3.0],
    gravity: -0.02,
    additive: true,
    spin: 0.25,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Boss signatures
//
// The verbs above are the shared vocabulary every boss can still reach for.
// Everything below is an accent: two to four moves each, so that fourteen
// marquee fights stop being one fight in fourteen costumes. A boss opens with
// its OWN kit and only falls back on the common pool when the common pool is
// genuinely the right sentence.
//
// The house rules from the top of this file get STRICTER down here, because a
// boss hits hard enough that readability is the only thing making it fair:
//
//   - anything over ~20 damage buys that damage with wind-up frames you can
//     see from across the screen, and pays for the miss with recovery you can
//     actually punish. Nothing in this section is a coin flip;
//   - the wind-up is DRAWN, not implied — `windup()` throws sparks on the
//     charge frames so the tell survives a busy screen full of adds;
//   - hitstop scales with the body doing the hitting. A dog bite stutters, a
//     boring machine stops the clock.
//
// Slot ORDER in `content/bosses.ts` matters as much as the frame data here:
// `Level.enterPhase` binds a phase's first three ids to light / heavy /
// special, so index 0 is the move you will see most, index 1 is the one that
// hurts, and index 2 is the set-piece. See the header of that file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tell. Sparks off the body on the charge frames of a big move so the
 * wind-up reads even when the screen is full of adds — presentation only, so
 * the move is exactly as dangerous with the effect layer switched off.
 */
function windup(frames: readonly number[], colors: string[], oy = 30, count = 8): FrameFn {
  return burst(frames, {
    count,
    shape: 'spark',
    colors,
    oy,
    angle: Math.PI * 0.5,
    spread: Math.PI,
    speed: [0.7, 2.8],
    life: [8, 20],
    size: [1, 2.6],
    gravity: -0.03,
    drag: 0.9,
    additive: true,
  });
}

// ── 5 · CRUNCH ──────────────────────────────────────────
// He does not fight, he ships. Every move is a change nobody reviewed: fast,
// confident, and followed a moment later by the thing it broke.

def({
  id: 'b_dev_ship',
  name: 'Ship It',
  duration: 32,
  startup: 10,
  anim: 'weapon_swing',
  sfx: 'weapon_swing',
  windows: [
    win(
      10,
      13,
      box(26, 28, 15, 15),
      hit({ dmg: 12, stun: 22, block: 11, kx: 3.8, react: 'heavy', chip: 0.12, sfx: 'glass' }),
      'handR',
    ),
  ],
  onFrame: burst([10], {
    count: 7,
    shape: 'shard',
    colors: ['#8be0c8', '#dfe6ee', '#ffffff'],
    ox: 24,
    oy: 28,
    speed: [1.4, 4.0],
    life: [10, 22],
    size: [0.8, 2.0],
    gravity: 0.26,
    spin: 0.4,
  }),
  cancels: [{ into: ['b_dev_hotfix', 'b_dev_standup'], from: 12 }],
});

def({
  id: 'b_dev_hotfix',
  name: 'Hotfix In Prod',
  duration: 50,
  startup: 16,
  anim: 'heavy_swing',
  sfx: 'grunt',
  // Two windows: the fix, and — fourteen frames later, behind him, where he is
  // not looking — the thing the fix broke. Standing behind a boss is normally
  // the safe answer. Not this one.
  windows: [
    win(
      16,
      21,
      box(28, 26, 17, 18),
      hit({
        dmg: 17,
        stun: 28,
        block: 13,
        kx: 4.8,
        react: 'heavy',
        chip: 0.15,
        shake: 5.2,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
    win(
      30,
      35,
      box(-26, 24, 16, 18),
      hit({
        dmg: 12,
        stun: 24,
        block: 11,
        kx: 5.4,
        ky: 1.6,
        react: 'heavy',
        chip: 0.12,
        shake: 4.6,
        sfx: 'explosion',
      }),
      'handL',
    ),
  ],
  onFrame: burst([30], {
    count: 10,
    shape: 'smoke',
    colors: ['#8be0c8', '#5d6b7a', '#ffffff'],
    ox: -22,
    oy: 24,
    speed: [1.0, 3.4],
    life: [14, 30],
    size: [1.4, 3.2],
    gravity: -0.02,
    drag: 0.93,
  }),
});

def({
  id: 'b_dev_standup',
  name: 'Daily Standup',
  duration: 78,
  startup: 26,
  anim: 'taunt',
  sfx: 'super_charge',
  // Four damage and fifty-four frames of hearing what he did yesterday. The
  // knockback is zero on purpose: you do not get pushed out of a standup, you
  // stand there. Twenty-six frames of wind-up is plenty of time to leave the
  // room, which is also true of the real thing.
  windows: [
    win(
      26,
      40,
      box(0, 26, 40, 26, 26),
      hit({
        dmg: 4,
        stun: 54,
        block: 16,
        stop: 5,
        kx: 0,
        push: 0,
        react: 'stun',
        chip: 0.04,
        meter: 0,
        vmeter: 0.14,
        shake: 1.8,
        sfx: 'grunt',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#8be0c8', '#dfe6ee', '#ffffff'], 42, 6),
    burst([26, 36, 46, 56], {
      count: 5,
      shape: 'dot',
      colors: ['#8be0c8', '#ffffff'],
      oy: 46,
      angle: Math.PI * 0.5,
      spread: 1.2,
      speed: [0.6, 1.8],
      life: [22, 44],
      size: [1.2, 2.6],
      gravity: -0.02,
      drag: 0.95,
    }),
  ),
});

def({
  id: 'b_dev_deploy',
  name: 'Deploy On Friday',
  duration: 58,
  startup: 18,
  anim: 'weapon_heavy',
  sfx: 'super_charge',
  windows: [],
  // Three features lobbed into the arena in the order they were finished,
  // which is not the order they were tested.
  onFrame: sequence(
    windup([8, 13], ['#8be0c8', '#ffffff'], 32, 5),
    shots([18, 28, 38], {
      kind: 'junk',
      damage: 13,
      speed: 5.2,
      ox: 24,
      oy: 34,
      spread: 6,
      arc: 3.4,
      sfx: 'drop',
    }),
  ),
});

// ── 10 · SHIBA INU ──────────────────────────────
// Low, fast and never where you swung. Everything he owns is either a bite or
// a way of not being hit, and none of it can be blocked high.

def({
  id: 'b_bite',
  name: 'Bite',
  duration: 26,
  startup: 7,
  anim: 'punch1',
  sfx: 'bone_crack',
  windows: [
    win(
      7,
      10,
      box(20, 14, 12, 11),
      hit({
        dmg: 11,
        stun: 20,
        block: 9,
        stop: 5,
        kx: 2.8,
        level: 'low',
        chip: 0.1,
        sfx: 'bone_crack',
      }),
      'head',
    ),
  ],
  // Bites into itself, so the punish window is between the teeth and not after
  // the first one.
  cancels: [{ into: ['b_bite', 'b_shiba_zoom', 'b_rush'], from: 9 }],
});

def({
  id: 'b_shiba_zoom',
  name: 'Zoomies',
  duration: 54,
  startup: 10,
  anim: 'run',
  sfx: 'dash',
  // Three passes, each one leaving through a different plane. The x is the
  // threat; the z is why you cannot corner him.
  motion: [
    { frame: 6, x: 9.4, y: 0, z: 2.6 },
    { frame: 18, x: -7.8, y: 0, z: -4.2 },
    { frame: 30, x: 8.6, y: 0, z: 2.0 },
  ],
  windows: [
    win(
      10,
      14,
      box(16, 12, 14, 11, 16),
      hit({ dmg: 8, stun: 17, block: 9, stop: 4, kx: 2.4, level: 'low', chip: 0.1, sfx: 'kick' }),
      'root',
    ),
    win(
      22,
      26,
      box(16, 12, 14, 11, 16),
      hit({ dmg: 8, stun: 17, block: 9, stop: 4, kx: 2.4, level: 'low', chip: 0.1, sfx: 'kick' }),
      'root',
    ),
    win(
      34,
      40,
      box(18, 13, 16, 12, 18),
      hit({
        dmg: 13,
        stun: 26,
        block: 12,
        kx: 6.4,
        ky: 3.4,
        react: 'sweep',
        level: 'low',
        chip: 0.13,
        shake: 5.0,
        sfx: 'bone_crack',
      }),
      'root',
    ),
  ],
});

def({
  id: 'b_shiba_dig',
  name: 'Dig',
  duration: 62,
  startup: 28,
  anim: 'sweep',
  sfx: 'grunt',
  // Twenty-eight frames of a dog going under the floor. He is untouchable for
  // most of it and unavoidable for none of it: the dirt shows you exactly
  // where he is going.
  invuln: { start: 8, end: 26 },
  motion: [
    { frame: 8, x: 6.2, y: 0 },
    { frame: 18, x: 4.0, y: 0 },
  ],
  windows: [
    win(
      28,
      33,
      box(14, 10, 20, 14, 22),
      hit({
        dmg: 18,
        stun: 30,
        block: 13,
        kx: 3.6,
        ky: 7.0,
        react: 'launch',
        level: 'low',
        chip: 0.14,
        shake: 6.2,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    burst([10, 16, 22], {
      count: 9,
      shape: 'smoke',
      colors: ['#c98a34', '#8a6a3a', '#d9cfbd'],
      ox: 14,
      oy: 4,
      speed: [1.2, 3.6],
      life: [10, 24],
      size: [1.2, 3.0],
      gravity: 0.22,
      drag: 0.9,
    }),
    groundPound(28, { radius: 66, frames: 16, shake: 6, dust: 16, sfx: 'explosion' }),
  ),
});

def({
  id: 'b_rush',
  name: 'Full Send',
  duration: 66,
  startup: 12,
  anim: 'run',
  sfx: 'dash',
  // The shared "no more thinking" run. Unlike `b_charge` it is not armoured —
  // it is simply faster than you and it does not stop, which is the version of
  // that idea an animal has.
  motion: [
    { frame: 10, x: 8.6, y: 0 },
    { frame: 22, x: 5.4, y: 0 },
    { frame: 32, x: 3.2, y: 0 },
  ],
  windows: [
    win(
      12,
      26,
      box(20, 18, 16, 20),
      hit({
        dmg: 12,
        stun: 22,
        block: 11,
        kx: 5.0,
        react: 'heavy',
        chip: 0.12,
        shake: 4.2,
        sfx: 'punch_heavy',
      }),
      'chest',
    ),
    win(
      28,
      38,
      box(22, 18, 18, 21),
      hit({
        dmg: 17,
        stun: 29,
        block: 13,
        kx: 9.0,
        ky: 2.6,
        push: 1.0,
        react: 'blowback',
        chip: 0.14,
        shake: 6.4,
        sfx: 'bone_crack',
      }),
      'chest',
    ),
  ],
});

// ── 15 · THE BLUE TICK ──────────────────────────────────────────────────────
// He has never hit anyone in his life. He posts, and then other people arrive.

def({
  id: 'b_check_ratio',
  name: 'Ratio',
  duration: 28,
  startup: 6,
  anim: 'punch1',
  sfx: 'punch_light',
  windows: [
    win(
      6,
      8,
      box(21, 30, 12, 12),
      hit({ dmg: 5, stun: 15, block: 8, stop: 3, kx: 1.4, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      14,
      17,
      box(23, 29, 13, 13),
      hit({ dmg: 8, stun: 20, block: 10, kx: 3.2, chip: 0.1, sfx: 'punch_light' }),
      'handL',
    ),
  ],
  cancels: [{ into: ['b_tweet', 'b_check_dogpile'], from: 8 }],
});

def({
  id: 'b_tweet',
  name: 'Hot Take',
  duration: 46,
  startup: 12,
  anim: 'weapon_swing',
  sfx: 'super_charge',
  // The phone goes in your face first, and then the take leaves the building
  // three times without ever being read back.
  windows: [
    win(
      12,
      15,
      box(22, 30, 13, 13),
      hit({ dmg: 7, stun: 18, block: 9, stop: 4, kx: 2.2, chip: 0.12, sfx: 'punch_light' }),
      'handR',
    ),
  ],
  onFrame: sequence(
    shots([12, 20, 28], {
      kind: 'post',
      damage: 12,
      speed: 8.6,
      ox: 26,
      oy: 32,
      spread: 3,
      sfx: 'ui_error',
    }),
    burst([12, 20, 28], {
      count: 5,
      shape: 'star',
      colors: ['#1d9bf0', '#9ff2ff', '#ffffff'],
      ox: 26,
      oy: 32,
      speed: [0.8, 2.6],
      life: [10, 22],
      size: [1, 2.4],
      gravity: -0.02,
      additive: true,
      spin: 0.3,
    }),
  ),
});

def({
  id: 'b_check_dogpile',
  name: 'Reply Guys',
  duration: 80,
  startup: 24,
  anim: 'taunt',
  sfx: 'laugh',
  // He quote-posts you and then stands back. The hit window is the pile-on
  // arriving at his feet, not him; the adds are the actual move.
  windows: [
    win(
      24,
      31,
      box(0, 8, 40, 12, 26),
      hit({
        dmg: 10,
        stun: 24,
        block: 11,
        kx: 4.6,
        ky: 3.8,
        react: 'sweep',
        level: 'low',
        chip: 0.14,
        shake: 4.8,
        sfx: 'punch_light',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#1d9bf0', '#ffffff'], 44, 6),
    summon([26, 44, 62], ['intern', 'lobbyist', 'suit_guard'], 140),
  ),
});

// ── 20 · TESLA ────────────────────────────────────────────────────────
// It indicates. It always indicates. The indicator has never once agreed with
// the steering, and that disagreement is the entire boss.

def({
  id: 'b_fsd_doorping',
  name: 'Door Ping',
  duration: 30,
  startup: 9,
  anim: 'weapon_swing',
  sfx: 'hit_metal',
  windows: [
    win(
      9,
      12,
      box(24, 26, 15, 19),
      hit({
        dmg: 13,
        stun: 23,
        block: 11,
        kx: 4.2,
        react: 'heavy',
        chip: 0.12,
        shake: 4.0,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
  ],
  cancels: [{ into: ['b_fsd_lanechange', 'b_ram'], from: 12 }],
});

def({
  id: 'b_fsd_lanechange',
  name: 'Indicating Left',
  duration: 62,
  startup: 24,
  anim: 'run',
  sfx: 'tyres',
  // Eighteen frames of amber, a polite drift toward the lane it signalled…
  // and then the whole vehicle goes the other way. The tell is real: the
  // indicator side is genuinely the safe side, every single time.
  // The drift is small and the swerve is nearly four times bigger, which is
  // what makes the indicated lane genuinely the safe one: follow the amber and
  // you clear the box by a body width, ignore it and the box arrives on you.
  motion: [
    { frame: 10, x: 1.2, y: 0, z: 2.4 },
    { frame: 20, x: 7.6, y: 0, z: -8.8 },
    { frame: 28, x: 3.0, y: 0, z: -2.0 },
  ],
  windows: [
    win(
      24,
      34,
      box(24, 24, 19, 22, 16),
      hit({
        dmg: 22,
        stun: 33,
        block: 15,
        kx: 9.6,
        ky: 2.4,
        push: 1.0,
        react: 'blowback',
        chip: 0.17,
        shake: 7.2,
        sfx: 'hit_metal',
      }),
      'chest',
    ),
  ],
  onFrame: sequence(
    burst([4, 8, 12, 16], {
      count: 4,
      shape: 'dot',
      colors: ['#ffb347', '#ff8a3d'],
      ox: 18,
      oy: 20,
      angle: Math.PI * 0.5,
      spread: 0.8,
      speed: [0.4, 1.4],
      life: [8, 14],
      size: [1.6, 2.8],
      gravity: 0,
      additive: true,
    }),
    burst([20], {
      count: 12,
      shape: 'smoke',
      colors: ['#c6ccd4', '#8d949d', '#ffffff'],
      oy: 5,
      speed: [1.6, 4.2],
      life: [12, 26],
      size: [1.4, 3.4],
      gravity: 0.08,
      drag: 0.9,
      sfx: 'tyres',
    }),
  ),
});

def({
  id: 'b_fsd_reroute',
  name: 'Rerouting',
  duration: 58,
  startup: 14,
  anim: 'ride',
  sfx: 'engine',
  // Reverse first — over whoever was politely standing behind it — then a
  // forward lurch once the route recalculates. Both halves are the same
  // mistake at two different speeds.
  motion: [
    { frame: 6, x: -6.8, y: 0 },
    { frame: 26, x: 6.4, y: 0 },
  ],
  windows: [
    win(
      14,
      20,
      box(-24, 22, 17, 20),
      hit({
        dmg: 15,
        stun: 26,
        block: 12,
        kx: 5.6,
        ky: 1.6,
        react: 'heavy',
        chip: 0.13,
        shake: 5.0,
        sfx: 'hit_metal',
      }),
      'root',
    ),
    win(
      30,
      36,
      box(24, 22, 17, 20),
      hit({
        dmg: 15,
        stun: 26,
        block: 12,
        kx: 5.6,
        ky: 1.6,
        react: 'heavy',
        chip: 0.13,
        shake: 5.0,
        sfx: 'hit_metal',
      }),
      'root',
    ),
  ],
  onFrame: burst([6, 26], {
    count: 8,
    shape: 'smoke',
    colors: ['#8d949d', '#c6ccd4', '#ffffff'],
    oy: 6,
    speed: [1.0, 3.0],
    life: [10, 22],
    size: [1.2, 2.8],
    gravity: 0.06,
    drag: 0.92,
  }),
});

def({
  id: 'b_ram',
  name: 'Unprotected Left',
  duration: 82,
  startup: 22,
  anim: 'run',
  sfx: 'engine',
  // The vehicle answer to `b_charge`. No armour — it is a large object, not a
  // fighter, and it can be hit out of this — but twenty-one active frames and
  // thirty-eight frames of having to reverse and line up again afterwards.
  motion: [
    { frame: 16, x: 10.4, y: 0 },
    { frame: 26, x: 5.2, y: 0 },
    { frame: 36, x: 2.2, y: 0 },
  ],
  windows: [
    win(
      22,
      42,
      box(26, 24, 21, 26),
      hit({
        dmg: 24,
        stun: 34,
        block: 16,
        kx: 11.0,
        ky: 3.0,
        push: 1.4,
        react: 'blowback',
        chip: 0.18,
        shake: 8.2,
        sfx: 'explosion',
      }),
      'chest',
    ),
  ],
  onFrame: sequence(
    windup([6, 11, 16], ['#ff3b30', '#ffb347', '#ffffff'], 22, 6),
    burst([44], {
      count: 14,
      shape: 'smoke',
      colors: ['#c6ccd4', '#8d949d', '#ffffff'],
      ox: 12,
      oy: 6,
      speed: [1.8, 5.0],
      life: [14, 30],
      size: [1.6, 3.8],
      gravity: 0.06,
      drag: 0.9,
      sfx: 'tyres',
    }),
  ),
});

// ── 25 · THE BORING MACHINE ─────────────────────────────────────────────────
// It has one job, one direction and no reverse gear. Everything it does is a
// hole being made, and you are in front of where the hole is going.

def({
  id: 'b_bore_head',
  name: 'Cutterhead',
  duration: 44,
  startup: 8,
  anim: 'heavy_swing',
  sfx: 'weapon_swing',
  // A grinder, not a punch: three teeth in a row, each individually survivable
  // and the third one not.
  windows: [
    win(
      8,
      11,
      box(28, 22, 17, 18),
      hit({ dmg: 7, stun: 16, block: 8, stop: 5, kx: 2.0, chip: 0.12, sfx: 'hit_metal' }),
      'handR',
    ),
    win(
      16,
      19,
      box(29, 22, 17, 18),
      hit({ dmg: 7, stun: 16, block: 8, stop: 5, kx: 2.0, chip: 0.12, sfx: 'hit_metal' }),
      'handL',
    ),
    win(
      24,
      28,
      box(30, 22, 19, 19),
      hit({
        dmg: 13,
        stun: 26,
        block: 12,
        kx: 6.8,
        ky: 2.0,
        react: 'blowback',
        chip: 0.15,
        shake: 5.6,
        sfx: 'glass',
      }),
      'handR',
    ),
  ],
  onFrame: burst([8, 16, 24], {
    count: 8,
    shape: 'spark',
    colors: ['#ffb347', '#ffffff', '#c2743a'],
    ox: 28,
    oy: 22,
    speed: [1.4, 4.4],
    life: [8, 18],
    size: [1, 2.4],
    gravity: 0.18,
    additive: true,
    spin: 0.4,
  }),
});

def({
  id: 'b_bore_collapse',
  name: 'Tunnel Collapse',
  duration: 82,
  startup: 28,
  anim: 'heavy_swing',
  sfx: 'engine',
  // Twenty-eight frames of a very large machine rearing up. The ceiling is the
  // punchline and the ceiling is slow.
  motion: [{ frame: 26, x: 2.4, y: 0 }],
  windows: [
    win(
      28,
      34,
      box(24, 14, 22, 28),
      hit({
        dmg: 27,
        stun: 40,
        block: 17,
        stop: 16,
        kx: 3.4,
        ky: 2.2,
        react: 'crumple',
        level: 'overhead',
        chip: 0.2,
        shake: 8.8,
        sfx: 'explosion',
      }),
      'handR',
    ),
    // Then the roof arrives, which is a wider and much less selective problem.
    win(
      36,
      44,
      box(0, 6, 54, 11, 30),
      hit({
        dmg: 12,
        stun: 26,
        block: 12,
        kx: 6.0,
        ky: 4.4,
        react: 'sweep',
        level: 'low',
        chip: 0.2,
        shake: 6.0,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20, 26], ['#ffb347', '#c2743a', '#ffffff'], 40, 7),
    groundPound(28, { radius: 128, frames: 24, shake: 9, dust: 26, sfx: 'explosion' }),
  ),
});

def({
  id: 'b_bore_muck',
  name: 'Spoil Removal',
  duration: 62,
  startup: 18,
  anim: 'weapon_heavy',
  sfx: 'engine',
  windows: [],
  // Everything it just dug, thrown over the top of itself in three loads.
  onFrame: sequence(
    windup([8, 13], ['#c2743a', '#d9cfbd'], 38, 5),
    shots([18, 28, 38], {
      kind: 'spoil',
      damage: 14,
      speed: 4.8,
      ox: 22,
      oy: 42,
      spread: 8,
      arc: 4.2,
      sfx: 'drop',
    }),
  ),
});

// ── 30 · SUBJECT P-47 ───────────────────────────────────────────────────────
// Nothing here is a technique. It is an animal with an aerial in its skull,
// and the fight alternates between twitching and broadcasting.

def({
  id: 'b_nl_seizure',
  name: 'Firmware Update',
  duration: 36,
  startup: 6,
  anim: 'punch1',
  sfx: 'grunt',
  // Four windows on an uneven rhythm. Individually trivial; the problem is
  // that the gaps are not the same size twice.
  windows: [
    win(
      6,
      7,
      box(20, 30, 12, 13),
      hit({ dmg: 5, stun: 13, block: 7, stop: 3, kx: 1.4, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      12,
      13,
      box(22, 24, 12, 13),
      hit({ dmg: 5, stun: 13, block: 7, stop: 3, kx: 1.4, sfx: 'punch_light' }),
      'handL',
    ),
    win(
      17,
      18,
      box(20, 32, 12, 13),
      hit({ dmg: 5, stun: 13, block: 7, stop: 3, kx: 1.4, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      24,
      27,
      box(23, 28, 14, 15),
      hit({
        dmg: 12,
        stun: 25,
        block: 11,
        kx: 4.4,
        react: 'heavy',
        chip: 0.12,
        shake: 4.2,
        sfx: 'punch_heavy',
      }),
      'handL',
    ),
  ],
  onFrame: burst([6, 12, 17, 24], {
    count: 4,
    shape: 'bolt',
    colors: ['#6ee4ff', '#ffffff'],
    oy: 40,
    speed: [0.6, 2.4],
    life: [5, 12],
    size: [1, 2.2],
    gravity: 0,
    additive: true,
  }),
});

def({
  id: 'b_nl_headbutt',
  name: 'Percutaneous Port',
  duration: 50,
  startup: 14,
  anim: 'punch2',
  sfx: 'bone_crack',
  // The implant is the hardest thing in the room and he leads with it. Armoured
  // through the approach, wide open the instant it lands or does not.
  invuln: { start: 8, end: 17 },
  motion: [{ frame: 12, x: 6.6, y: 0 }],
  windows: [
    win(
      14,
      20,
      box(22, 32, 15, 18),
      hit({
        dmg: 19,
        stun: 30,
        block: 14,
        kx: 6.2,
        ky: 2.0,
        push: 0.8,
        react: 'heavy',
        chip: 0.15,
        shake: 6.0,
        sfx: 'bone_crack',
      }),
      'head',
    ),
  ],
  onFrame: windup([8, 11], ['#6ee4ff', '#ffffff'], 44, 5),
});

def({
  id: 'b_nl_static',
  name: 'Packet Loss',
  duration: 70,
  startup: 22,
  anim: 'heavy_swing',
  sfx: 'super_charge',
  // He can hear the wifi and now so can you. Barely any damage, enormous
  // hitstun: this is the move that sets up everything else in the phase.
  windows: [
    win(
      22,
      32,
      box(0, 24, 40, 26, 28),
      hit({
        dmg: 12,
        stun: 48,
        block: 16,
        kx: 2.0,
        push: 0,
        react: 'stun',
        chip: 0.2,
        shake: 4.4,
        sfx: 'taser',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    windup([6, 11, 16, 21], ['#6ee4ff', '#9ff2ff', '#ffffff'], 44, 8),
    (self, frame, ctx) => {
      if (frame !== 22) return;
      ctx.fx.shockwave(self.pos.x, self.pos.y + 26, self.pos.z, 108, 22);
      ctx.fx.aberration(0.6, 20);
      ctx.fx.shake({ magnitude: 4.5, duration: 22, frequency: 1.6 });
    },
  ),
});

// ── 35 · THE REGULATOR ──────────────────────────────────────────────────────
// Almost nothing he does damages you. Everything he does costs you your turn,
// which is a different kind of expensive and, eventually, a gavel.

def({
  id: 'b_reg_subpoena',
  name: 'You Have Been Served',
  duration: 28,
  startup: 8,
  anim: 'punch1',
  sfx: 'drop',
  // Seven damage and twenty-six frames of reading it.
  windows: [
    win(
      8,
      11,
      box(26, 30, 14, 15),
      hit({
        dmg: 7,
        stun: 26,
        block: 10,
        stop: 4,
        kx: 1.2,
        push: 0.2,
        chip: 0.06,
        vmeter: 0.03,
        sfx: 'punch_light',
      }),
      'handR',
    ),
  ],
  onFrame: burst([8], {
    count: 7,
    shape: 'shard',
    colors: ['#f6f1e4', '#d9b451', '#ffffff'],
    ox: 24,
    oy: 30,
    speed: [0.8, 2.6],
    life: [16, 34],
    size: [1.2, 2.6],
    gravity: 0.08,
    drag: 0.94,
    spin: 0.24,
  }),
  cancels: [{ into: ['b_reg_injunction', 'b_reg_gavel'], from: 10 }],
});

def({
  id: 'b_reg_injunction',
  name: 'Injunction',
  duration: 66,
  startup: 20,
  anim: 'taunt',
  sfx: 'ui_error',
  // A document held in your face for eleven frames. Five damage, fifty-six
  // frames of not being allowed to do anything — the most literal expression
  // of what this boss is for.
  windows: [
    win(
      20,
      31,
      box(28, 26, 20, 24),
      hit({
        dmg: 5,
        stun: 56,
        block: 18,
        stop: 5,
        kx: 0.6,
        push: 0,
        react: 'stun',
        chip: 0.08,
        meter: 0,
        vmeter: 0.12,
        shake: 2.0,
        sfx: 'drop',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    windup([6, 11, 16], ['#d9b451', '#f6f1e4'], 36, 6),
    burst([20, 26], {
      count: 8,
      shape: 'shard',
      colors: ['#f6f1e4', '#d9b451', '#ffffff'],
      ox: 26,
      oy: 30,
      speed: [0.6, 2.0],
      life: [20, 40],
      size: [1.2, 2.8],
      gravity: 0.05,
      drag: 0.95,
      spin: 0.2,
    }),
  ),
});

def({
  id: 'b_reg_fine',
  name: 'Nine Minutes Of His Income',
  duration: 54,
  startup: 16,
  anim: 'throw',
  sfx: 'coin',
  windows: [
    win(
      16,
      19,
      box(24, 28, 14, 16),
      hit({ dmg: 6, stun: 18, block: 9, stop: 4, kx: 2.0, chip: 0.08, sfx: 'coin' }),
      'handR',
    ),
  ],
  onFrame: shots([16, 26, 36], {
    kind: 'penalty',
    damage: 11,
    speed: 5.6,
    ox: 22,
    oy: 36,
    spread: 5,
    arc: 3.0,
    sfx: 'coin',
  }),
});

def({
  id: 'b_reg_gavel',
  name: 'Contempt',
  duration: 74,
  startup: 26,
  anim: 'heavy_swing',
  sfx: 'super_charge',
  // The one time in the whole fight that he stops filing and starts swinging.
  // Twenty-six frames of raising it, and the recovery of a man who has just
  // done something he will have to justify.
  motion: [{ frame: 24, x: 2.0, y: 0 }],
  windows: [
    win(
      26,
      31,
      box(26, 22, 19, 26),
      hit({
        dmg: 26,
        stun: 40,
        block: 17,
        stop: 15,
        kx: 4.0,
        ky: 2.4,
        react: 'crumple',
        level: 'overhead',
        chip: 0.18,
        shake: 8.0,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#d9b451', '#ffffff'], 46, 7),
    groundPound(26, { radius: 82, frames: 18, shake: 7.5, dust: 14, sfx: 'explosion' }),
  ),
});

// ── 40 · DONALD J. TRUMP ────────────────────────────────────────────────────
// He does not have a fighting style. He has a rally, a handshake and a phone
// number for people who fight. All three are load-bearing.

def({
  id: 'b_trump_handshake',
  name: 'The Handshake',
  duration: 40,
  startup: 10,
  anim: 'grab',
  sfx: 'grunt',
  // Negative knockback: it pulls you IN, holds you there for forty-four
  // frames, and hands you to whoever he called in the last phase.
  windows: [
    win(
      10,
      15,
      box(22, 30, 13, 18),
      hit({
        dmg: 9,
        stun: 44,
        block: 14,
        kx: -3.2,
        push: 0,
        react: 'stun',
        chip: 0.08,
        shake: 2.8,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
  cancels: [{ into: ['b_trump_rally', 'b_trump_delegate', 'b_slam'], from: 14 }],
});

def({
  id: 'b_trump_rally',
  name: 'The Rally',
  duration: 88,
  startup: 30,
  anim: 'taunt',
  sfx: 'laugh',
  // Three damage, a crowd's worth of noise and thirty frames in the middle
  // where nobody can lay a finger on him. It fills YOUR meter faster than
  // anything else he owns, which is the only justice in the encounter.
  invuln: { start: 10, end: 40 },
  windows: [
    win(
      30,
      44,
      box(0, 26, 46, 28, 28),
      hit({
        dmg: 3,
        stun: 30,
        block: 12,
        stop: 5,
        kx: 4.0,
        push: 0,
        react: 'stun',
        chip: 0.04,
        meter: 0,
        vmeter: 0.16,
        shake: 2.4,
        sfx: 'laugh',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20, 26], ['#d0392b', '#f2e07a', '#ffffff'], 46, 8),
    burst([30, 42, 54, 66], {
      count: 8,
      shape: 'star',
      colors: ['#d0392b', '#f2e07a', '#ffffff'],
      oy: 48,
      angle: Math.PI * 0.5,
      spread: 1.8,
      speed: [0.9, 2.8],
      life: [20, 44],
      size: [1.4, 3.0],
      gravity: -0.02,
      additive: true,
      spin: 0.22,
    }),
    (self, frame, ctx) => {
      if (frame !== 30) return;
      ctx.fx.shockwave(self.pos.x, self.pos.y + 30, self.pos.z, 96, 24);
      ctx.fx.shake({ magnitude: 4, duration: 26, frequency: 1.2 });
    },
  ),
});

def({
  id: 'b_trump_delegate',
  name: 'I Pay For People',
  duration: 82,
  startup: 20,
  anim: 'throw',
  sfx: 'super_charge',
  // He points. The hit window is not him — it is the first man to arrive.
  windows: [
    win(
      20,
      25,
      box(36, 28, 18, 22),
      hit({
        dmg: 14,
        stun: 26,
        block: 12,
        kx: 5.2,
        react: 'heavy',
        chip: 0.14,
        shake: 5.0,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    windup([8, 14], ['#d0392b', '#ffffff'], 40, 5),
    summon([22, 40, 58], ['suit_guard', 'lobbyist', 'gunman'], 150),
  ),
});

// ── 45 · OPTIMUS ──────────────────────────────────────────────────
// It was built to do household tasks precisely. It still does them precisely.
// The tasks changed.

def({
  id: 'b_opt_fold',
  name: 'Fold',
  duration: 40,
  startup: 12,
  anim: 'punch2',
  sfx: 'weapon_swing',
  // Two motions: the smoothing, then the crease. It is a laundry animation and
  // it is being run on a person.
  windows: [
    win(
      12,
      15,
      box(24, 28, 14, 16),
      hit({ dmg: 8, stun: 18, block: 9, stop: 4, kx: 2.0, chip: 0.1, sfx: 'hit_metal' }),
      'handL',
    ),
    win(
      22,
      26,
      box(22, 22, 16, 20),
      hit({
        dmg: 16,
        stun: 32,
        block: 14,
        stop: 12,
        kx: 2.4,
        ky: 1.0,
        react: 'crumple',
        chip: 0.15,
        shake: 5.4,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
  onFrame: windup([9], ['#e2e7ec', '#ffffff'], 34, 4),
});

def({
  id: 'b_opt_servo',
  name: 'Torque Limit Disabled',
  duration: 74,
  startup: 24,
  anim: 'heavy_swing',
  sfx: 'engine',
  // The safety numbers a factory arm ships with, turned off. Twenty-four frames
  // of servo whine, one backhand, and forty-three frames of a machine that has
  // to re-home itself before it can do anything else.
  motion: [{ frame: 22, x: 2.2, y: 0 }],
  windows: [
    win(
      24,
      30,
      box(34, 28, 22, 22),
      hit({
        dmg: 26,
        stun: 38,
        block: 17,
        kx: 11.0,
        ky: 3.4,
        push: 1.6,
        react: 'blowback',
        chip: 0.18,
        shake: 8.0,
        sfx: 'hit_metal',
      }),
      'handR',
    ),
  ],
  onFrame: windup([8, 14, 20], ['#9ff2ff', '#e2e7ec', '#ffffff'], 40, 7),
});

def({
  id: 'b_laser',
  name: 'Optical Targeting',
  duration: 58,
  startup: 18,
  anim: 'weapon_swing',
  sfx: 'super_charge',
  // Thin, precise and mostly chip. Where `b_beam` is a wall, this is a line:
  // it does not push you, it just keeps being there. The dot lands on you six
  // frames before the beam does.
  windows: [
    win(
      18,
      22,
      box(58, 30, 48, 7, 9),
      hit({
        dmg: 10,
        stun: 20,
        block: 10,
        kx: 2.0,
        react: 'heavy',
        chip: 0.28,
        shake: 3.4,
        sfx: 'super_blast',
      }),
      'head',
    ),
    win(
      30,
      35,
      box(60, 30, 50, 7, 9),
      hit({
        dmg: 12,
        stun: 24,
        block: 11,
        kx: 4.6,
        react: 'heavy',
        chip: 0.28,
        shake: 4.2,
        sfx: 'super_blast',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    windup([6, 10, 14], ['#ff4d4d', '#ffffff'], 34, 4),
    shots([18, 30], {
      kind: 'laser',
      damage: 10,
      speed: 15.0,
      ox: 32,
      oy: 30,
      sfx: 'super_blast',
    }),
  ),
});

// ── 50 · GROK ───────────────────────────────────────────────────────────────
// It is extremely confident and it is looking slightly to the left of you.

def({
  id: 'b_grok_answer',
  name: 'Certainly!',
  duration: 36,
  startup: 8,
  anim: 'punch1',
  sfx: 'punch_light',
  // The answer, and then the same answer again somewhere it was never asked.
  windows: [
    win(
      8,
      11,
      box(24, 28, 14, 16),
      hit({ dmg: 12, stun: 22, block: 11, kx: 3.4, chip: 0.12, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      18,
      21,
      box(-22, 28, 14, 16),
      hit({
        dmg: 10,
        stun: 20,
        block: 10,
        kx: 3.8,
        react: 'heavy',
        chip: 0.12,
        shake: 3.6,
        sfx: 'punch_light',
      }),
      'handL',
    ),
  ],
  cancels: [{ into: ['b_grok_reroll', 'b_grok_hallucinate'], from: 12 }],
});

def({
  id: 'b_grok_reroll',
  name: 'Regenerate Response',
  duration: 66,
  startup: 14,
  anim: 'weapon_heavy',
  sfx: 'super_charge',
  // Identical swing, twice, with eighteen frames of visible thinking in
  // between. Same box, same numbers, no new information — which is the joke
  // and also, mercifully, a very easy rhythm to learn.
  windows: [
    win(
      14,
      19,
      box(30, 26, 18, 20),
      hit({
        dmg: 15,
        stun: 27,
        block: 13,
        kx: 5.4,
        react: 'heavy',
        chip: 0.14,
        shake: 5.0,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
    win(
      38,
      43,
      box(30, 26, 18, 20),
      hit({
        dmg: 15,
        stun: 27,
        block: 13,
        kx: 5.4,
        react: 'heavy',
        chip: 0.14,
        shake: 5.0,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
  onFrame: burst([24, 28, 32], {
    count: 4,
    shape: 'dot',
    colors: ['#37e6c8', '#ffffff'],
    oy: 46,
    angle: Math.PI * 0.5,
    spread: 0.9,
    speed: [0.4, 1.2],
    life: [12, 24],
    size: [1.2, 2.2],
    gravity: -0.02,
    additive: true,
  }),
});

def({
  id: 'b_grok_hallucinate',
  name: 'Load-Bearing Hallucination',
  duration: 84,
  startup: 22,
  anim: 'taunt',
  sfx: 'super_charge',
  // It invents an attacker at range, then invents another one in your lap, and
  // in between it invents some staff. None of them are real. All of them hit.
  windows: [
    win(
      22,
      28,
      box(48, 26, 22, 24),
      hit({
        dmg: 13,
        stun: 25,
        block: 12,
        kx: 5.0,
        react: 'heavy',
        chip: 0.16,
        shake: 4.6,
        sfx: 'explosion',
      }),
      'handR',
    ),
    win(
      46,
      52,
      box(18, 26, 20, 24),
      hit({
        dmg: 13,
        stun: 25,
        block: 12,
        kx: 5.0,
        react: 'heavy',
        chip: 0.16,
        shake: 4.6,
        sfx: 'explosion',
      }),
      'handL',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#37e6c8', '#9ff2ff', '#ffffff'], 44, 7),
    summon([30, 58], ['intern', 'iot_speaker', 'delivery_drone'], 150),
  ),
});

// ── 55 · STARSHIP, SERIAL NUMBER WHATEVER ───────────────────────────────────
// A very large pressure vessel with engines on one end. Every move is a test
// and every test is passed by definition.

def({
  id: 'b_flame',
  name: 'Static Fire',
  duration: 66,
  startup: 18,
  anim: 'weapon_swing',
  sfx: 'engine',
  // Sustained exhaust across the floor in front of it: low damage per tick,
  // brutal chip, and it does not care whether you are blocking, only whether
  // you are standing in it.
  windows: [
    win(
      18,
      24,
      box(32, 10, 24, 13, 22),
      hit({ dmg: 8, stun: 17, block: 9, stop: 4, kx: 2.2, level: 'low', chip: 0.3, sfx: 'explosion' }),
      'footR',
    ),
    win(
      26,
      32,
      box(34, 10, 26, 13, 22),
      hit({ dmg: 8, stun: 17, block: 9, stop: 4, kx: 2.2, level: 'low', chip: 0.3, sfx: 'explosion' }),
      'footR',
    ),
    win(
      34,
      42,
      box(36, 11, 28, 14, 24),
      hit({
        dmg: 13,
        stun: 26,
        block: 12,
        kx: 7.6,
        ky: 2.6,
        react: 'blowback',
        level: 'low',
        chip: 0.3,
        shake: 6.0,
        sfx: 'explosion',
      }),
      'footR',
    ),
  ],
  onFrame: sequence(
    windup([8, 13], ['#ff6a2a', '#ffcf5c'], 14, 6),
    burst([18, 24, 30, 36], {
      count: 12,
      shape: 'spark',
      colors: ['#ff6a2a', '#ffcf5c', '#ffffff'],
      ox: 30,
      oy: 8,
      angle: Math.PI * 0.5,
      spread: 1.1,
      speed: [1.6, 5.2],
      life: [8, 20],
      size: [1.2, 3.0],
      gravity: -0.04,
      drag: 0.9,
      additive: true,
    }),
  ),
});

def({
  id: 'b_rocket',
  name: 'Payload Deploy',
  duration: 60,
  startup: 20,
  anim: 'weapon_heavy',
  sfx: 'super_charge',
  windows: [],
  // Two of them, arcing, slow enough to walk out from under and heavy enough
  // that you have to actually do it.
  onFrame: sequence(
    windup([8, 14], ['#ff6a2a', '#ffffff'], 46, 6),
    shots([20, 32], {
      kind: 'booster',
      damage: 22,
      speed: 5.0,
      ox: 26,
      oy: 44,
      spread: 3,
      arc: 4.0,
      sfx: 'explosion',
    }),
  ),
});

def({
  id: 'b_ship_flop',
  name: 'Belly Flop',
  duration: 92,
  startup: 36,
  anim: 'fall',
  sfx: 'engine',
  // Up, over, and down flat across the arena. It is untouchable while it is
  // above you and it is a building while it is coming down; the whole thing is
  // thirty-six frames of extremely obvious intent.
  invuln: { start: 10, end: 30 },
  motion: [
    { frame: 6, x: 2.6, y: 9.6 },
    { frame: 30, x: 5.4, y: -4.2 },
  ],
  windows: [
    win(
      36,
      46,
      box(18, 20, 24, 24),
      hit({
        dmg: 21,
        stun: 32,
        block: 15,
        kx: 4.0,
        ky: -2.6,
        react: 'heavy',
        level: 'overhead',
        chip: 0.16,
        shake: 6.6,
        sfx: 'punch_heavy',
      }),
      'chest',
    ),
    win(
      48,
      56,
      box(0, 6, 58, 11, 30),
      hit({
        dmg: 17,
        stun: 30,
        block: 14,
        kx: 6.8,
        ky: 5.2,
        react: 'sweep',
        level: 'low',
        chip: 0.18,
        shake: 8.4,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    burst([8, 14, 20, 26], {
      count: 10,
      shape: 'spark',
      colors: ['#ff6a2a', '#ffcf5c', '#ffffff'],
      oy: 4,
      angle: Math.PI * 1.5,
      spread: 0.9,
      speed: [1.4, 4.4],
      life: [8, 18],
      size: [1.2, 2.8],
      gravity: 0.04,
      additive: true,
    }),
    groundPound(48, { radius: 150, frames: 24, shake: 8.5, dust: 26, sfx: 'explosion' }),
  ),
});

def({
  id: 'b_ship_rud',
  name: 'Rapid Unscheduled Disassembly',
  duration: 104,
  startup: 40,
  anim: 'heavy_swing',
  sfx: 'super_charge',
  // Forty frames of venting, alarms and a vehicle visibly deciding to stop
  // being one. Then a hundred and fifty units of pad, all at once. Then
  // fifty-five frames lying in its own debris, which is the longest free
  // punish in the game and is meant to be.
  windows: [
    win(
      40,
      48,
      box(0, 20, 76, 40, 34),
      hit({
        dmg: 34,
        stun: 46,
        block: 19,
        stop: 18,
        kx: 12.0,
        ky: 6.0,
        push: 0,
        react: 'crumple',
        chip: 0.26,
        shake: 9.0,
        sfx: 'explosion',
      }),
      'chest',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20, 26, 32, 38], ['#ff6a2a', '#ffcf5c', '#ffffff'], 40, 9),
    (self, frame, ctx) => {
      if (frame === 26) ctx.fx.aberration(0.5, 18);
      if (frame !== 40) return;
      ctx.fx.flash('#ffcf5c', 8, 0.55);
      ctx.fx.slowmo(0.4, 18);
      ctx.fx.aberration(0.9, 26);
    },
    groundPound(40, { radius: 210, frames: 30, shake: 9, dust: 32, sfx: 'explosion' }),
    burst([41, 45], {
      count: 16,
      shape: 'shard',
      colors: ['#cfd6de', '#ff6a2a', '#ffffff'],
      oy: 26,
      speed: [2.4, 7.0],
      life: [16, 40],
      size: [1.4, 3.6],
      gravity: 0.26,
      drag: 0.94,
      spin: 0.5,
    }),
  ),
});

// ── 60 · THE GOVERNOR OF MARS ───────────────────────────────────────────────
// A company town with a flag on it. He owns the air, the debt and the gravity,
// and he fights with all three.

def({
  id: 'b_mars_airlock',
  name: 'Subscription Lapsed',
  duration: 38,
  startup: 9,
  anim: 'grab',
  sfx: 'grunt',
  // Six damage. Forty-six frames of not being allowed to breathe.
  windows: [
    win(
      9,
      14,
      box(20, 30, 12, 18),
      hit({
        dmg: 6,
        stun: 46,
        block: 15,
        stop: 6,
        kx: 0.8,
        push: 0,
        react: 'stun',
        chip: 0.1,
        shake: 2.4,
        sfx: 'grunt',
      }),
      'handR',
    ),
  ],
  onFrame: burst([9], {
    count: 8,
    shape: 'ring',
    colors: ['#e8ddc8', '#ffb04a', '#ffffff'],
    ox: 20,
    oy: 32,
    speed: [0.6, 2.2],
    life: [10, 22],
    size: [1, 2.6],
    gravity: 0,
    additive: true,
  }),
  cancels: [{ into: ['b_mars_lowgrav', 'b_mars_dust'], from: 12 }],
});

def({
  id: 'b_mars_lowgrav',
  name: 'Point Three Eight G',
  duration: 56,
  startup: 16,
  anim: 'uppercut',
  sfx: 'punch_heavy',
  // The same uppercut you have taken all game, on a planet where it sends you
  // to the ceiling. Juggle state on the way up is the entire phase plan.
  motion: [
    { frame: 13, x: 1.2, y: 0 },
    { frame: 16, x: 0.6, y: 4.2 },
  ],
  windows: [
    win(
      16,
      22,
      box(20, 34, 16, 26),
      hit({
        dmg: 20,
        stun: 34,
        block: 15,
        kx: 3.2,
        ky: 14.0,
        push: 0.6,
        react: 'launch',
        chip: 0.15,
        shake: 6.4,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
  onFrame: windup([10, 13], ['#ffb04a', '#ffffff'], 30, 5),
});

def({
  id: 'b_mars_dust',
  name: 'Dust Storm',
  duration: 78,
  startup: 22,
  anim: 'sweep',
  sfx: 'super_charge',
  // Nineteen active frames of planet. It barely damages anyone; it removes the
  // idea that there is somewhere on this map you can stand and wait.
  windows: [
    win(
      22,
      40,
      box(0, 18, 56, 22, 32),
      hit({
        dmg: 9,
        stun: 20,
        block: 10,
        stop: 4,
        kx: 6.4,
        ky: 1.2,
        react: 'blowback',
        chip: 0.28,
        shake: 4.6,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#c2521f', '#e0a878', '#ffb04a'], 30, 7),
    burst([22, 28, 34, 40], {
      count: 14,
      shape: 'smoke',
      colors: ['#c2521f', '#e0a878', '#e8ddc8'],
      oy: 16,
      speed: [1.8, 5.4],
      life: [18, 40],
      size: [1.6, 4.0],
      gravity: -0.01,
      drag: 0.95,
      spin: 0.16,
    }),
  ),
});

// ── 65 · SNOW MUSK MK. II ──────────────────────────────────────────────────
// She has all of the original's data and none of her refusals. Everything she
// does is something you love, aimed at you.

def({
  id: 'b_clone_mirror',
  name: 'Mirror',
  duration: 32,
  startup: 7,
  anim: 'punch1',
  sfx: 'punch_light',
  // Your own normal, played back at you twice with identical timing. She knows
  // all seven of your names; this is what that was for.
  windows: [
    win(
      7,
      9,
      box(22, 30, 13, 14),
      hit({ dmg: 10, stun: 20, block: 10, stop: 4, kx: 2.6, chip: 0.12, sfx: 'punch_light' }),
      'handR',
    ),
    win(
      15,
      17,
      box(22, 30, 13, 14),
      hit({ dmg: 10, stun: 20, block: 10, stop: 4, kx: 2.6, chip: 0.12, sfx: 'punch_light' }),
      'handL',
    ),
  ],
  cancels: [{ into: ['b_clone_lullaby', 'b_clone_recording', 'b_clone_kiss'], from: 10 }],
});

def({
  id: 'b_clone_lullaby',
  name: 'Calibration Tone',
  duration: 78,
  startup: 26,
  anim: 'taunt',
  sfx: 'super_charge',
  // A sung note held for thirteen frames. Six damage and fifty-four frames of
  // standing very still, which on this boss is a death sentence with a delay.
  windows: [
    win(
      26,
      38,
      box(0, 28, 44, 30, 30),
      hit({
        dmg: 6,
        stun: 54,
        block: 18,
        stop: 6,
        kx: 0,
        push: 0,
        react: 'stun',
        chip: 0.12,
        meter: 0,
        vmeter: 0.1,
        shake: 2.6,
        sfx: 'super_blast',
      }),
      'head',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20], ['#d02b52', '#f6ecec', '#ffffff'], 48, 7),
    (self, frame, ctx) => {
      if (frame !== 26) return;
      ctx.fx.shockwave(self.pos.x, self.pos.y + 30, self.pos.z, 118, 26);
      ctx.fx.aberration(0.45, 20);
    },
  ),
});

def({
  id: 'b_clone_recording',
  name: 'I Have That Recording',
  duration: 62,
  startup: 16,
  anim: 'weapon_swing',
  sfx: 'super_charge',
  windows: [
    win(
      16,
      22,
      box(30, 28, 22, 20),
      hit({
        dmg: 11,
        stun: 22,
        block: 11,
        kx: 4.4,
        react: 'heavy',
        chip: 0.2,
        shake: 4.0,
        sfx: 'super_blast',
      }),
      'chest',
    ),
  ],
  onFrame: shots([16, 28, 40], {
    kind: 'scream',
    damage: 13,
    speed: 9.4,
    ox: 28,
    oy: 30,
    spread: 3,
    sfx: 'super_blast',
  }),
});

def({
  id: 'b_clone_kiss',
  name: 'Coronation',
  duration: 96,
  startup: 30,
  anim: 'throw',
  sfx: 'super_charge',
  // Thirty frames of her walking you through what happens next, and then it
  // happens. Unblockable, so the answer is distance; slow, so distance is a
  // real answer.
  windows: [
    win(
      30,
      36,
      box(22, 28, 15, 22),
      hit({
        dmg: 34,
        stun: 46,
        block: 46,
        stop: 18,
        kx: 7.0,
        ky: 4.0,
        push: 0,
        react: 'crumple',
        level: 'unblockable',
        chip: 0,
        shake: 8.6,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    windup([8, 14, 20, 26], ['#d02b52', '#ffffff'], 40, 8),
    (self, frame, ctx) => {
      if (frame !== 30) return;
      ctx.fx.flash('#d02b52', 8, 0.45);
      ctx.fx.slowmo(0.35, 16);
      ctx.fx.impactFrame(self.id, 8);
    },
  ),
});

// ── 70 · ELON MUSK ──────────────────────────────────────────────────────────
// He has no style of his own, which is the point: by the last phase he is
// running everybody else's kit at once. These three are the only things in the
// building that are actually his.

def({
  id: 'b_musk_firing',
  name: 'Effective Immediately',
  duration: 34,
  startup: 9,
  anim: 'punch2',
  sfx: 'punch_heavy',
  // Eleven damage and most of the screen. He is not trying to hurt you, he is
  // trying to make you somebody else's problem.
  windows: [
    win(
      9,
      12,
      box(26, 30, 15, 16),
      hit({
        dmg: 11,
        stun: 22,
        block: 11,
        kx: 7.4,
        ky: 1.4,
        push: 0.6,
        react: 'blowback',
        chip: 0.12,
        shake: 4.6,
        sfx: 'punch_heavy',
      }),
      'handR',
    ),
  ],
  cancels: [{ into: ['b_musk_allin', 'b_laser', 'b_tweet'], from: 12 }],
});

def({
  id: 'b_musk_allin',
  name: 'Betting The Company',
  duration: 96,
  startup: 30,
  anim: 'heavy_swing',
  sfx: 'super_charge',
  // Everything on one swing. Thirty frames of wind-up, six active, and sixty
  // frames of standing in the open having missed — the single most punishable
  // move in the game, on the man least able to stop doing it.
  motion: [{ frame: 28, x: 3.0, y: 0 }],
  windows: [
    win(
      30,
      35,
      box(32, 26, 22, 26),
      hit({
        dmg: 30,
        stun: 42,
        block: 18,
        stop: 17,
        kx: 10.0,
        ky: 4.0,
        push: 1.2,
        react: 'crumple',
        chip: 0.2,
        shake: 9.0,
        sfx: 'bone_crack',
      }),
      'handR',
    ),
  ],
  onFrame: sequence(
    windup([6, 12, 18, 24, 28], ['#37e6c8', '#9ff2ff', '#ffffff'], 34, 8),
    (self, frame, ctx) => {
      if (frame === 24) ctx.fx.aberration(0.5, 14);
      if (frame !== 30) return;
      ctx.fx.flash('#37e6c8', 6, 0.4);
      ctx.fx.shockwave(self.pos.x + 20 * self.facing, self.pos.y + 26, self.pos.z, 88, 20);
    },
  ),
});

def({
  id: 'b_musk_everything',
  name: 'Every Device In This Building',
  duration: 104,
  startup: 24,
  anim: 'taunt',
  sfx: 'super_charge',
  // The sum of the other thirteen, run at once: the summon, the beam, the
  // ground wave. Twenty-four frames to read it and two separate windows to be
  // somewhere else for.
  windows: [
    win(
      24,
      30,
      box(0, 26, 40, 28, 28),
      hit({
        dmg: 10,
        stun: 22,
        block: 11,
        kx: 5.0,
        react: 'heavy',
        chip: 0.18,
        shake: 4.4,
        sfx: 'super_blast',
      }),
      'chest',
    ),
    win(
      78,
      86,
      box(0, 8, 68, 12, 32),
      hit({
        dmg: 21,
        stun: 33,
        block: 15,
        kx: 8.4,
        ky: 5.4,
        react: 'sweep',
        level: 'low',
        chip: 0.22,
        shake: 8.6,
        sfx: 'explosion',
      }),
      'root',
    ),
  ],
  onFrame: sequence(
    windup([6, 12, 18], ['#37e6c8', '#ffffff'], 40, 8),
    summon([26, 62], ['security_bot', 'delivery_drone', 'iot_fridge', 'suit_guard'], 160),
    shots([34, 48, 62], {
      kind: 'beam',
      damage: 12,
      speed: 12.0,
      ox: 30,
      oy: 32,
      spread: 4,
      sfx: 'super_blast',
    }),
    groundPound(78, { radius: 190, frames: 28, shake: 9, dust: 28, sfx: 'explosion' }),
  ),
});
