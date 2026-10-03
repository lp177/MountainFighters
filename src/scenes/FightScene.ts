/**
 * The fight.
 *
 * This scene is where every other module finally has to agree with the others:
 * it builds the player fighters out of the chosen DwarfDefs, constructs the
 * Level for the current map, owns the one and only `SimContext` the simulation
 * ever sees, and drives the fixed step in the order everything else assumes —
 *
 *     players update  ->  level update  ->  combat resolve
 *
 * DETERMINISM. Everything inside `step()` is sim code: seeded RNG, no wall
 * clock, no Math.random. That is not decoration — it is the only reason
 * input-delay lockstep works at all. The sim frame counter is this scene's own
 * and advances only on frames that actually simulated, so two peers that spent
 * different amounts of time in the menus still agree on frame numbers.
 *
 * DIVISION OF LABOUR with `Game`. Game owns a scene stack and a fixed loop; if
 * it has already sampled input for this frame then it is also gating lockstep
 * and taking the checksum, and we leave it alone. If nothing else is driving —
 * a bare harness, a test rig — this scene does the whole `canAdvance /
 * prepare / update / confirm` dance itself. Either way the netplay overlays
 * (waiting-for-player, and a loud, honest desync banner) are drawn here.
 *
 * Presentation — camera shake, particles, floating text, audio — is routed
 * through Fx/AudioSystem and never feeds back into the simulation.
 *
 * FINISHERS. This scene owns the `FatalityDirector` and is the only thing that
 * decides WHEN one fires: the combat resolver hands over every killing blow
 * through `setFatalityHook` and asks nothing about it. While a finisher is on
 * stage the whole fight is frozen — no fighter update, no level update, no
 * combat pass — and the director gets the frame to itself. See `startFatality`
 * for the policy and `stepFatality` for the way back out, which is written so
 * that it cannot fail to happen.
 */

import type {
  DwarfDef,
  FatalityDef,
  HitProperties,
  NetMessage,
  ParticleSpec,
  Rng,
  SaveData,
  Scene,
  SceneName,
  Settings,
  SimContext,
  SuperPowerDef,
  CarriedWeapon,
} from '@/core/types';
import { Btn, EMPTY_INPUT } from '@/core/types';

import {
  FIGHT_ZOOM,
  GROUND_Y,
  TOTAL_MAPS,
  VIEW_H,
  VIEW_W,
  Z_DEPTH,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';
import { clamp, dist2, easeOut, easeOutBack, lerp } from '@/core/math';

import type { GameLoop } from '@/engine/Loop';
import type { InputManager } from '@/engine/input/InputManager';
import { KeyboardSource } from '@/engine/input/KeyboardSource';
import { GamepadSource, connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { DEFAULT_BINDINGS } from '@/engine/input/Bindings';
import { makeRng, randomSeed } from '@/engine/Rng';
import { saveSave } from '@/engine/Save';

import type { Renderer } from '@/render/Renderer';
import { Camera } from '@/render/Camera';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';

import { ParticleSystem } from '@/juice/Particles';
import { Fx } from '@/juice/Fx';
import type { AudioSystem } from '@/audio/AudioSystem';

import { Fighter, setGoreLevel } from '@/game/Fighter';
import type { FighterInit } from '@/game/Fighter';
import { Level } from '@/game/Level';
import { drawBackdrop } from '@/game/Backdrop';
import { CombatResolver, setFatalityHook } from '@/game/combat/Combat';
import { registerMove } from '@/game/combat/Moves';
import { BossIntro } from '@/game/BossIntro';
import { FatalityDirector, HOLD_BUDGET } from '@/game/Fatality';

import { DWARFS, getDwarf } from '@/content/dwarfs';
import { getMap } from '@/content/maps';
import { BOSS_INTROS } from '@/content/story';
import { pickFatality, resetFatalityHistory } from '@/content/fatalities';

import type { NetSession } from '@/net/NetSession';
import type { Lockstep } from '@/net/Lockstep';

import type { Ui } from '@/ui/Ui';
import { drawHud, resetHud, setHudPadSlots } from '@/ui/Hud';
import { PALETTE, band, displayFont, inkText, playerColor, slab, textFont } from '@/ui/theme';
import { drawReadyMarks, readyCaption } from '@/ui/ReadyMarks';
import type { ReadyMark } from '@/ui/ReadyMarks';
import { PauseScene, nav, quitToMenu } from '@/scenes/PauseScene';
import { VictoryScene } from '@/scenes/VictoryScene';
import type { ResultActions } from '@/scenes/VictoryScene';
import { GameOverScene } from '@/scenes/GameOverScene';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// The contract with src/Game.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a scene needs from the top-level game object.
 *
 * The required members are the ones `Game` is defined by in the manifest — it
 * "owns the renderer, loop, audio, input, save data". Everything else is
 * optional and probed for, so a Game that keeps its own camera and particle
 * pool gets used, and one that does not gets a private set built here instead
 * of a crash.
 */
export interface SceneHost {
  readonly renderer: Renderer;
  readonly loop: GameLoop;
  readonly audio: AudioSystem;
  readonly input: InputManager;
  readonly save: SaveData;
  /** The playthrough, which is where a carried weapon survives a map change. */
  readonly run?: { carried: (CarriedWeapon | null)[] };

  readonly ui?: Ui;
  readonly net?: NetSession | null;
  readonly lockstep?: Lockstep | null;

  /** Long-lived presentation systems, when the game owns them. */
  readonly camera?: Camera;
  readonly particles?: ParticleSystem;
  readonly fx?: Fx;
  /** Draws the particle + world-juice layer at the caller's chosen depth. */
  renderWorldFx?(ctx: C2D): void;

  /** Scene stack, when there is one. */
  readonly scenes?: readonly Scene[];
  findScene?(name: string): Scene | null;
  setScene?(scene: Scene, params?: unknown): void;
  pushScene?(scene: Scene, params?: unknown): void;
  popScene?(): void;
  goto?(name: SceneName, params?: unknown): void;

  /** Flush save data to storage. */
  persist?(): void;
  saveNow?(): void;
  applySettings?(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Params & results
// ─────────────────────────────────────────────────────────────────────────────

export interface FightPlayerPick {
  slot: number;
  dwarfId: string;
  name?: string;
  /** False for a player driven across the wire by lockstep. */
  local?: boolean;
  /**
   * True if this seat chose on a controller.
   *
   * Recorded rather than inferred. Pads used to be pinned to slots 2 and 3, so
   * `slot >= 2` was as good as a flag — but the slot a pad lands on is now
   * decided by the seat count, and three separate places were still guessing
   * from the old layout. The board knows; it should say so.
   */
  onPad?: boolean;
  /**
   * Player number, 0-based, as the select screen dealt it. Not the slot: a pad
   * can sit on input slot 2 and still be player one. Drives the colour and the
   * number the HUD shows for this fighter. Absent means "same as the slot".
   */
  seat?: number;
}

export interface FightParams {
  players?: FightPlayerPick[];
  /** Convenience for local play: one dwarf id per slot, in slot order. */
  dwarfIds?: string[];
  mapIndex?: number;
  seed?: number;
  score?: number;
  continues?: number;
  net?: NetSession | null;
  lockstep?: Lockstep | null;
}

export interface FightResult {
  outcome: 'victory' | 'gameover';
  score: number;
  /** Map the run ended on. */
  mapIndex: number;
  mapName: string;
  mapsCleared: number;
  bestCombo: number;
  totalHits: number;
  enemiesFelled: number;
  /** Sim frames the run lasted. */
  frames: number;
  continues: number;
  players: FightPlayerPick[];
  /** True when this run beat the stored best for one of its dwarfs. */
  newRecord: boolean;
  /** Set when the run ended because the netcode fell apart. */
  desynced?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/** Total length of the ROUND / FIGHT! banner. */
const INTRO_FRAMES = 170;
/** Inputs unlock — and "FIGHT!" lands — with this many intro frames left. */
const INTRO_FIGHT_AT = 70;
const CLEAR_FRAMES = 150;
const CONTINUE_FRAMES = 10 * 60;
const BOSS_INTRO_FRAMES = 230;
/** Meter carried from one map to the next, as a fraction. */
const METER_CARRY = 0.5;
/** Health handed back at the start of each new map, as a fraction of the bar. */
const MAP_HEAL = 0.4;

/**
 * Odds an ordinary enemy kill earns a finisher.
 *
 * A boss and a player die with one every single time — those are the moments
 * the book was written for. A guard does not: a beat-em-up kills forty of them
 * an hour, and a three-second cutscene on every one of them stops being a treat
 * and becomes a tax on the pace of the wave.
 */
const FATALITY_CHANCE = 0.35;

/**
 * Frames of grace past a finisher's own duration before it is shot.
 *
 * The director retires itself on the frame after `duration` and there is no
 * known way for it not to. This is here because "the fight never resumes" is
 * the single worst bug this feature could have, and a watchdog costs one
 * integer compare per frame.
 *
 * The grace has to cover everything the director may legitimately add to a
 * finisher's own length: the follow-through, which it caps at 116 frames, and
 * the frames it holds the picture on a blow, which it caps at HOLD_BUDGET.
 * Short of that sum, the watchdog shoots a show that was running to time.
 */
const FATALITY_GRACE = 124 + HOLD_BUDGET;

const DIFFICULTY_HEALTH: Record<Settings['difficulty'], number> = {
  easy: 1.35,
  normal: 1,
  hard: 0.86,
  musk: 0.7,
};

// ── Framing ──────────────────────────────────────────────────────────────────

/** Screen y of the far edge of the walkable band, at z = Z_DEPTH. */
const BAND_BOTTOM = GROUND_Y + Z_DEPTH * Z_SCALE;
/** Virtual pixels of floor kept visible beneath that edge. */
const BAND_CLEARANCE = 10;

/**
 * Vertical framing correction for the fight zoom.
 *
 * `Renderer.withCamera` scales about the middle of the frame, and the belt does
 * not sit in the middle of the frame: the ground line is at GROUND_Y and the
 * band runs another Z_DEPTH * Z_SCALE below it. Zoom about the centre and the
 * far edge of that band — where the deepest fighter's feet and shadow are —
 * drops off the bottom of the screen. This lifts the world by exactly enough to
 * put it back with a little floor to spare.
 *
 * Constant-folded at module load, and never positive: at 1x the framing is
 * precisely what it has always been.
 */
const FIGHT_FRAME_Y = Math.min(
  0,
  (VIEW_H * 0.5 - BAND_CLEARANCE) / FIGHT_ZOOM + VIEW_H * 0.5 - BAND_BOTTOM,
);

/**
 * The stage grade: how far the scenery is pushed back before anybody stands on
 * it. See `gradeStage`.
 *
 * DESAT is the fraction of the backdrop's saturation removed; DIM multiplies its
 * value (0xdc/0xff ≈ 86%); the vignette darkens the corners, where nothing is
 * ever happening, toward the coal of the UI. Tuned on the mine, the server farm
 * and the assembly line — the darkest, the flattest and the brightest maps.
 *
 * Lighter than it was. The grade was set when the scenery was flat fills and
 * had nothing in it worth seeing; pushing that back hard cost nothing. The set
 * is now lit — lamps, pools on the floor, a horizon — and a grade that heavy
 * was taking the light back out of it. The fighters still out-read it, because
 * the light is on the floor they stand on rather than on the wall behind them.
 */
const STAGE_DESAT = 0.2;
const STAGE_DIM = '#dcd7d0';
const STAGE_VIGNETTE = 'rgba(12,9,7,0.5)';

// The roster is authored directly against the ids in `game/combat/Moves.ts`.
// There used to be a MOVE_ALIAS table here remapping the roster's generic
// normals onto one shared punch and one shared kick — which is precisely how
// seven dwarfs ended up throwing the same two attacks without anything ever
// failing. Slot values go through untouched now, so a bad id reaches getMove()
// and gets reported instead of quietly resolving to someone else's move.

// ─────────────────────────────────────────────────────────────────────────────
// Player fighter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Fighter that can get back up.
 *
 * `Level` looks for a `respawn(x, z)` hook when a co-op player burns a life,
 * and falls back to poking `health` when there is not one — which would leave
 * the fighter stuck in the `dead` state and quietly eat the rest of their
 * lives. This is that hook. It doubles as the between-maps reset.
 */
class PlayerFighter extends Fighter {
  respawn(x: number, z: number, keepMeter = 0): void {
    const priv = this as unknown as Record<string, unknown>;

    this.health = this.maxHealth;
    this.state = 'idle';
    this.stateFrame = 0;
    this.grounded = true;
    this.comboCount = 0;
    this.facing = 1;

    this.pos.x = x;
    this.pos.y = 0;
    this.pos.z = z;
    this.vel.x = 0;
    this.vel.y = 0;
    this.vel.z = 0;

    priv.currentMove = null;
    priv.moveConnected = false;
    priv.whiffed = false;
    priv.hitstunTimer = 0;
    priv.knockdownTimer = 0;
    priv.pendingKnockdown = false;
    priv.dizzyMeter = 0;
    priv.dizzyTimer = 0;
    priv.juggleCount = 0;
    priv.wallBounce = false;
    priv.comboTimer = 0;
    priv.bufAction = null;
    priv.bufFrames = 0;
    priv.jumpBuf = 0;
    priv.moveAction = null;
    priv.jumpArc = false;
    priv.wantDash = 0;
    priv.dashTimer = 0;
    priv.flash = 0;
    // Long enough that nobody gets bodied the instant they blink back in.
    priv.invulnFrames = 96;

    /*
     * A new life is a clean one.
     *
     * The damage channel only ever climbs — that is deliberate, so healing
     * patches the health bar and not the jacket — which means without this a
     * dwarf who came back from the dead would walk on soaked in his own blood,
     * wheezing, and with no hat, for the next sixty-nine maps. The health floor
     * puts the wear straight back on the next frame if he is still hurt, so a
     * map transition that carries damage still looks like it carried damage.
     */
    priv.wearAccum = 0;
    priv.bloodAccum = 0;
    priv.breathBase = 0;
    priv.breathSpike = 0;
    priv.strainTimer = 0;
    const d = this.damage;
    d.wear = 0;
    d.blood = 0;
    d.breath = 0;
    d.face = 'calm';
    d.hatless = false;

    this.meter = clamp(keepMeter, 0, this.meter);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supers — the activatable ultimate, built from each dwarf's SuperPowerDef
// ─────────────────────────────────────────────────────────────────────────────

const SUPERS_BUILT = new Set<string>();

interface SuperLook {
  colors: string[];
  shape: ParticleSpec['shape'];
  flash: string;
  ring: string;
  cry: string;
}

const SUPER_LOOK: Record<SuperPowerDef['visual'], SuperLook> = {
  sneeze_shockwave: {
    colors: ['#d6f5c8', '#8fe3a0', '#ffffff', '#c8ffd8'],
    shape: 'smoke',
    flash: '#e8ffe4',
    ring: '#9dffb8',
    cry: 'AAAA-CHOO',
  },
  sleep_dream_crush: {
    colors: ['#8f9cff', '#2b2a6b', '#d6d2ff', '#ffffff'],
    shape: 'star',
    flash: '#b9b6ff',
    ring: '#8f9cff',
    cry: 'ZZZZZ',
  },
  grump_quake: {
    colors: ['#c9a06a', '#8a5a2e', '#ffe14a', '#5a4030'],
    shape: 'shard',
    flash: '#ffd8a0',
    ring: '#ffb347',
    cry: 'TANTRUM',
  },
  doc_lecture: {
    colors: ['#f2f0e6', '#c8a63f', '#ffffff', '#8fd4ff'],
    shape: 'dot',
    flash: '#fff6d8',
    ring: '#ffe9a0',
    cry: 'SLIDE NINE',
  },
  bashful_blush_nova: {
    colors: ['#ff8fae', '#ff2e6e', '#ffd6e2', '#ffffff'],
    shape: 'ring',
    flash: '#ffd6e2',
    ring: '#ff5c8d',
    cry: 'MORTIFIED',
  },
  happy_disco_inferno: {
    colors: ['#ff5f8d', '#ffd23f', '#5fc9ff', '#63ff9d', '#ffffff'],
    shape: 'star',
    flash: '#ffffff',
    ring: '#ffd23f',
    cry: 'LAST DANCE',
  },
  dopey_chaos_rain: {
    colors: ['#ffd166', '#ff8a2a', '#9fd8ff', '#ffffff', '#ff4d6d'],
    shape: 'spark',
    flash: '#ffe9b0',
    ring: '#ffd166',
    cry: 'WHOOPS',
  },
};

function superProps(sp: SuperPowerDef): HitProperties {
  return {
    damage: sp.damage,
    hitstun: 46,
    blockstun: 34,
    hitstop: 12,
    knockback: { x: 9.5, y: 7.2 },
    pushback: 0,
    reaction: 'blowback',
    level: 'unblockable',
    chip: 0,
    meterGain: 0,
    meterGainVictim: 0.06,
    shake: 10,
    sfx: sp.sfx,
  };
}

/**
 * The moment of contact. Applied here rather than through a HitWindow because a
 * super is explicitly allowed to ignore the belt-scroller depth rule that keeps
 * ordinary punches honest — that is what the bar buys you.
 */
function superStrike(sp: SuperPowerDef, selfId: number, ctx: SimContext): number {
  const list = ctx.fighters as readonly Fighter[];
  let src: Fighter | null = null;
  for (const f of list) {
    if (f.id === selfId) {
      src = f;
      break;
    }
  }
  if (!src) return 0;

  const props = superProps(sp);
  const whole = sp.radius < 0;
  const r2 = whole ? 0 : sp.radius * sp.radius;
  let hits = 0;

  for (const f of list) {
    if (f.id === src.id || f.team === src.team || !f.alive) continue;
    if (whole) {
      if (Math.abs(f.pos.x - src.pos.x) > VIEW_W) continue;
    } else if (dist2(src.pos.x, src.pos.z, f.pos.x, f.pos.z) > r2) {
      continue;
    }
    if (f.takeHit(props, src.pos.x, ctx, src)) hits++;
  }
  return hits;
}

function runSuper(
  sp: SuperPowerDef,
  self: { readonly id: number; readonly pos: { x: number; y: number; z: number } },
  frame: number,
  strike: number,
  ctx: SimContext,
): void {
  const look = SUPER_LOOK[sp.visual];
  const x = self.pos.x;
  const z = self.pos.z;

  // ── Wind-up: energy dragged inward and the room going very quiet.
  if (frame < strike) {
    if (frame % 3 === 0) {
      const t = frame / strike;
      ctx.fx.particles({
        count: 4,
        x: x + ctx.rng.range(-46, 46),
        y: 4 + ctx.rng.range(0, 40),
        z: z + ctx.rng.range(-18, 18),
        angle: Math.PI * 0.5,
        spread: 0.5,
        speed: [1.6 + t * 3, 3.4 + t * 4],
        life: [8, 18],
        size: [1, 2.6],
        colors: look.colors,
        gravity: -0.06,
        drag: 0.92,
        shape: 'spark',
        additive: true,
        fade: 'ease',
      });
    }
    if (frame === 1) {
      ctx.fx.slowmo(0.4, strike);
      ctx.fx.text({
        text: sp.name,
        x,
        y: 78,
        z,
        color: look.ring,
        size: 13,
        life: strike + 40,
        rise: 0.12,
        style: 'taunt',
      });
    }
    return;
  }

  // ── Contact.
  if (frame === strike) {
    const hits = superStrike(sp, self.id, ctx);

    ctx.requestHitstop(18);
    ctx.fx.flash(look.flash, 12, 0.8);
    ctx.fx.shake({ magnitude: 13, duration: 40 });
    ctx.fx.aberration(0.9, 24);
    // A dip, not a wade. This used to be 64 frames — a full second of real
    // time on its own, landing on top of the windup's own slowmo — so the
    // super's animation finished and the player kept walking through syrup.
    ctx.fx.slowmo(0.24, 26);
    ctx.fx.shockwave(x, 24, z, sp.radius < 0 ? 240 : sp.radius, 30);
    // The dwarf's own sound and nothing under it. A generic blast used to be
    // stacked on every one of these, which buried the sneeze, the snore and
    // the laugh under the same explosion.
    ctx.audio.play(sp.sfx);

    ctx.fx.particles({
      count: 44,
      x,
      y: 22,
      z,
      angle: 0,
      spread: Math.PI * 2,
      speed: [2.5, 9],
      life: [20, 52],
      size: [1.4, 4.2],
      colors: look.colors,
      gravity: 0.08,
      drag: 0.95,
      shape: look.shape,
      additive: true,
      fade: 'ease',
      spin: 0.3,
    });
    ctx.fx.text({
      text: look.cry,
      x,
      y: 96,
      z,
      color: look.ring,
      size: 20,
      life: 90,
      rise: 0.2,
      style: 'critical',
    });
    if (hits > 1) {
      ctx.fx.text({
        text: `${hits} CAUGHT`,
        x,
        y: 62,
        z,
        color: '#ffe14a',
        size: 10,
        life: 70,
        rise: 0.4,
        style: 'bonus',
      });
    }
    return;
  }

  // ── Aftermath: each ultimate leaves its own mess behind.
  const after = frame - strike;
  if (after > 70) return;

  switch (sp.visual) {
    case 'sneeze_shockwave':
      if (after % 9 === 0) ctx.fx.shockwave(x, 20, z, 90 + after * 3, 20);
      break;

    case 'sleep_dream_crush':
      if (after % 12 === 0) {
        ctx.fx.text({
          text: 'Z',
          x: x + ctx.rng.range(-60, 60),
          y: 40,
          z,
          color: '#b9b6ff',
          size: 14,
          life: 60,
          rise: 0.8,
          style: 'taunt',
        });
      }
      break;

    case 'grump_quake':
      if (after % 6 === 0) {
        ctx.fx.shake({ magnitude: Math.max(0.5, 6 - after * 0.06), duration: 8, dirY: 1 });
        ctx.fx.particles({
          count: 8,
          x: x + ctx.rng.range(-120, 120),
          y: 1,
          z: z + ctx.rng.range(-30, 30),
          angle: Math.PI * 0.5,
          spread: 0.9,
          speed: [1.5, 5],
          life: [14, 32],
          size: [1, 3],
          colors: look.colors,
          gravity: 0.3,
          drag: 0.96,
          shape: 'shard',
          spin: 0.28,
        });
      }
      break;

    case 'doc_lecture':
      if (after % 8 === 0) {
        // Slides. Actual slides, drifting down onto the unconscious.
        ctx.fx.particles({
          count: 5,
          x: x + ctx.rng.range(-140, 140),
          y: 70,
          z: z + ctx.rng.range(-30, 30),
          angle: Math.PI * 0.5,
          spread: 0.4,
          speed: [0.4, 1.4],
          life: [30, 60],
          size: [2, 4],
          colors: ['#f2f0e6', '#ffffff'],
          gravity: 0.05,
          drag: 0.99,
          shape: 'shard',
          spin: 0.12,
        });
      }
      break;

    case 'bashful_blush_nova':
      if (after % 10 === 0) ctx.fx.shockwave(x, 26, z, 60 + after * 2.4, 18);
      break;

    case 'happy_disco_inferno':
      if (after % 4 === 0) {
        ctx.fx.flash(look.colors[((after / 4) | 0) % look.colors.length], 3, 0.16);
        ctx.fx.particles({
          count: 6,
          x: x + ctx.rng.range(-150, 150),
          y: ctx.rng.range(0, 70),
          z: z + ctx.rng.range(-40, 40),
          angle: Math.PI * 0.5,
          spread: Math.PI,
          speed: [1, 4],
          life: [16, 36],
          size: [1.2, 3],
          colors: look.colors,
          gravity: -0.02,
          drag: 0.95,
          shape: 'star',
          additive: true,
          fade: 'flicker',
          spin: 0.4,
        });
      }
      break;

    case 'dopey_chaos_rain':
      if (after % 5 === 0) {
        const dx = ctx.rng.range(-160, 160);
        ctx.fx.particles({
          count: 10,
          x: x + dx,
          y: 120,
          z: z + ctx.rng.range(-40, 40),
          angle: Math.PI * 0.5,
          spread: 0.3,
          speed: [2, 5],
          life: [20, 40],
          size: [1.4, 3.4],
          colors: look.colors,
          gravity: 0.5,
          drag: 0.99,
          shape: 'spark',
          additive: true,
          spin: 0.5,
        });
        if (after % 15 === 0) ctx.fx.shockwave(x + dx, 10, z, 40, 14);
      }
      break;

    default:
      break;
  }
}

/** Registers a dwarf's ultimate as a real move so the Super button can fire it. */
function superMoveFor(d: DwarfDef): string {
  const id = `mf_super_${d.id}`;
  if (SUPERS_BUILT.has(id)) return id;
  SUPERS_BUILT.add(id);

  const sp = d.super;
  const duration = Math.round(clamp(sp.duration, 96, 220));
  const strike = 30;

  registerMove({
    id,
    name: sp.name,
    duration,
    startup: strike,
    anim: 'heavy_swing',
    meterCost: 1,
    airOk: false,
    invuln: { start: 0, end: duration },
    sfx: sp.sfx,
    // No hit windows: `runSuper` applies the damage itself, so the blast is not
    // filtered through the depth gate ordinary hitboxes go through.
    windows: [],
    onFrame: (self, frame, ctx) => runSuper(sp, self, frame, strike, ctx),
  });

  return id;
}

// ─────────────────────────────────────────────────────────────────────────────

export class FightScene implements Scene {
  readonly name = 'fight';

  /** True while a pause overlay is up. Belt and braces: a host with a scene
   *  stack only updates the top scene anyway. */
  paused = false;

  private readonly host: SceneHost;
  private params: FightParams;
  private settings: Settings;

  private cam: Camera;
  private particles: ParticleSystem;
  private fx: Fx;
  /** True when this scene built its own presentation systems and must step them. */
  private ownsPresentation: boolean;

  private combat: CombatResolver;
  private rng: Rng;
  private readonly sim: SimContext;

  private fatality: FatalityDirector;
  /** Frames the current performance has run for, and its hard ceiling. */
  private fatalityFrames = 0;
  private fatalityLimit = 0;
  /** Last values pushed downstream, so a change from the pause menu is noticed. */
  private goreSeen: Settings['gore'];
  private motionSeen: boolean;

  private picks: FightPlayerPick[] = [];
  private players: PlayerFighter[] = [];
  private localSlots: number[] = [];
  private level: Level | null = null;

  private mapIndex = 1;
  private seed = 0;
  /** Frames this fight has actually simulated. The netcode's clock. */
  private simFrame = 0;
  /** The loop frame on which the simulation last advanced. See `render`. */
  private steppedOn = -1;

  /** True while a cinematic of ours is on screen and the peer must be patient. */
  private cinematicBusy = false;

  /** Slots that have told us they are watching something. */
  private readonly busyPeers = new Set<number>();

  /** Slots whose boss introduction has finished. Cleared when the fight resumes. */
  private readonly introDone = new Set<number>();

  private allIntrosDone(net: NetSession): boolean {
    for (const p of net.players) if (!this.introDone.has(p.slot)) return false;
    return true;
  }

  /** Marks for the corner of a cinematic: lit once that player is through. */
  private introMarks(net: NetSession): ReadyMark[] {
    return net.players.map((p) => {
      const d = p.dwarfId ? safeDwarf(p.dwarfId) : null;
      return {
        color: d?.style.hatColor ?? PALETTE.blood,
        ready: this.introDone.has(p.slot) && !this.busyPeers.has(p.slot),
        label: `P${p.slot + 1}`,
      };
    });
  }

  private setCinematicBusy(on: boolean): void {
    if (this.cinematicBusy === on) return;
    this.cinematicBusy = on;
    const net = this.net;
    if (net && net.role !== 'offline' && net.connected) {
      net.send({ t: 'cue', slot: net.slot, busy: on });
    }
    this.lockstep?.hold(on || this.busyPeers.size > 0);
  }

  /** The frame lockstep counts. Both peers start it at zero. See NetFramed. */
  get netFrame(): number {
    return this.simFrame;
  }
  private score = 0;
  private continues = 0;
  private mapsCleared = 0;
  private bestCombo = 0;
  private totalHits = 0;
  private enemiesFelled = 0;
  private lastComboSum = 0;
  private readonly felled = new Set<number>();

  private phase: 'intro' | 'fight' | 'clear' | 'continue' = 'intro';
  private introTimer = INTRO_FRAMES;
  private clearTimer = 0;
  private continueTimer = 0;
  private bossIntro = 0;
  /** The directed boss introduction. Replaces the old timed text plate. */
  private intro!: BossIntro;
  private bossSeen = false;
  private finished = false;

  private net: NetSession | null = null;
  private lockstep: Lockstep | null = null;
  private stalled = 0;
  private remotePaused = -1;
  private netError = '';

  private hitstopRequest = 0;
  private readonly debugBoxes: { x: number; y: number; z: number; hw: number; hh: number }[] = [];

  constructor(host: SceneHost, params?: FightParams) {
    this.host = host;
    this.params = params ?? {};
    this.settings = host.save.settings;

    this.ownsPresentation = host.camera === undefined || host.fx === undefined;
    this.cam = host.camera ?? new Camera();
    this.particles = host.particles ?? new ParticleSystem();
    this.fx = host.fx ?? new Fx(this.cam, this.particles, host.loop, this.settings);

    this.combat = new CombatResolver(this.fx, host.audio);
    this.rng = makeRng(1);
    this.sim = this.makeSim();

    this.goreSeen = this.settings.gore;
    this.motionSeen = this.settings.reducedMotion === true;
    this.fatality = this.makeDirector();
  }

  /**
   * A director bound to the presentation systems as they stand right now.
   *
   * Rebuilt in `enter()` for the same reason the CombatResolver is: the camera,
   * the Fx bus and the RNG are all resolved there, and a director still holding
   * the placeholders from the constructor would zoom a camera nobody is looking
   * through.
   */
  private makeBossIntro(): BossIntro {
    return new BossIntro({
      fx: this.fx,
      audio: this.host.audio,
      cam: this.cam,
      rng: this.rng,
      reducedMotion: this.settings.reducedMotion === true,
    });
  }

  private makeDirector(): FatalityDirector {
    return new FatalityDirector({
      fx: this.fx,
      audio: this.host.audio,
      cam: this.cam,
      rng: this.rng,
      gore: this.settings.gore,
      reducedMotion: this.settings.reducedMotion === true,
      // Everyone still standing, so the follow-through has something to swing
      // the trophy through. Read lazily: the Level rebuilds its roster as waves
      // arrive and die, and a list captured once would sweep ghosts.
      crowd: () => (this.level ? this.level.fighters : []),
      // So it can put the performers' floor where the letterbox leaves room.
      frameY: FIGHT_FRAME_Y,
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    if (params && typeof params === 'object') {
      this.params = { ...this.params, ...(params as FightParams) };
    }
    const p = this.params;

    this.settings = this.host.save.settings;
    this.ownsPresentation = this.host.camera === undefined || this.host.fx === undefined;
    this.cam = this.host.camera ?? this.cam;
    this.particles = this.host.particles ?? this.particles;
    this.fx = this.host.fx ?? new Fx(this.cam, this.particles, this.host.loop, this.settings);
    this.combat = new CombatResolver(this.fx, this.host.audio);

    // The fight's resting zoom. Camera.update() takes any write to `zoom` as the
    // new resting value and adds the decaying punch on top of it, so a heavy hit
    // still kicks the view — it kicks it from here rather than from 1.0.
    this.cam.zoom = FIGHT_ZOOM;

    this.net = p.net ?? this.host.net ?? null;
    this.lockstep = p.lockstep ?? this.host.lockstep ?? null;
    if (this.net && this.net.role === 'offline') this.net = null;
    if (!this.net) this.lockstep = null;

    let seed = p.seed ?? this.net?.seed ?? 0;
    if (!Number.isFinite(seed) || seed === 0) seed = randomSeed();
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);

    // The gore setting is global to the fight — Fighter and the combat resolver
    // read it from one module-level value rather than each holding a Settings
    // reference — so push it out before anything is built.
    setGoreLevel(this.settings.gore);
    this.goreSeen = this.settings.gore;
    this.motionSeen = this.settings.reducedMotion === true;
    this.fatality = this.makeDirector();
    this.fatalityFrames = 0;
    this.fatalityLimit = 0;
    resetFatalityHistory();
    setFatalityHook(this.onFatality);

    this.mapIndex = clamp(Math.round(p.mapIndex ?? 1), 1, TOTAL_MAPS);
    this.score = Math.max(0, Math.round(p.score ?? 0));
    this.continues = Math.max(0, Math.round(p.continues ?? 0));
    this.mapsCleared = 0;
    this.bestCombo = 0;
    this.totalHits = 0;
    this.enemiesFelled = 0;
    this.lastComboSum = 0;
    this.felled.clear();
    this.simFrame = 0;
    this.finished = false;
    this.paused = false;
    this.remotePaused = -1;
    this.netError = '';
    this.stalled = 0;

    this.picks = this.resolvePicks(p);
    this.localSlots = this.picks.filter((x) => x.local !== false).map((x) => x.slot);
    this.ensureInputSources();

    // The match starts HERE, which is the only place that knows the sim's frame
    // numbering — and it starts at zero, on both machines. Lockstep used to be
    // reset when the room opened, from the local render loop's frame, so the
    // two peers numbered frames from different places and neither ever sent
    // anything. See Lockstep.reset.
    this.lockstep?.reset(0);

    resetHud();
    setHudPadSlots(new Set(this.picks.filter((p) => p.onPad === true).map((p) => p.slot)));
    this.particles.clear();
    this.host.loop.timeScale = 1;
    this.host.loop.hitstop = 0;

    this.buildPlayers();
    this.buildLevel(false);

    if (this.net) {
      this.net.onMessage(this.onNet);
      this.net.onError(this.onNetError);
    }

    this.host.ui?.clear();
  }

  exit(): void {
    // Ours only while we are the fight. Leaving it installed would hand the
    // next scene's kills — a demo attract loop, a replay — to a director whose
    // camera is no longer on screen.
    setFatalityHook(null);
    this.endFatality();
    resetFatalityHistory();

    this.host.loop.timeScale = 1;
    this.host.loop.hitstop = 0;
    this.particles.clear();
    this.net?.offMessage(this.onNet);
    // The camera may be the host's; hand it back at the zoom every other scene
    // is authored against.
    this.cam.zoom = 1;
  }

  /** Called by a host that has just popped an overlay off us. */
  resume(): void {
    this.paused = false;
  }

  onKey(e: KeyboardEvent): void {
    if (this.intro.active && !e.repeat) {
      // Any key advances the boss introduction; Escape still reaches the pause
      // menu below, so nobody is trapped in it.
      if (e.code !== 'Escape') {
        e.preventDefault();
        this.intro.press();
        return;
      }
    }
    if (e.code === 'Escape' && !this.paused && !this.finished) {
      e.preventDefault();
      this.openPause();
    }
  }

  /**
   * Lockstep's world hash. Public so a host that drives the netcode can take it
   * straight after our update.
   *
   * Deliberately hashes world state only — never a frame counter. Two peers
   * that entered the fight a frame apart still hold identical worlds, and a
   * checksum that disagreed about the clock would report a desync that had not
   * happened, which is the one failure mode worse than missing a real one.
   */
  checksum(): number {
    let h = this.rng.getState() >>> 0;
    const level = this.level;
    if (level) {
      for (const f of level.fighters) h = (Math.imul(h, 16777619) ^ f.checksum()) >>> 0;
    }
    return h | 0;
  }

  // ── the fixed step ─────────────────────────────────────────────────────────

  update(_dt: number): void {
    if (this.paused || this.finished || !this.level) return;

    this.syncSettings();

    const ls = this.lockstep;
    if (ls?.desynced) {
      // A desync is not something to play through. Freeze, and say so loudly.
      this.netError = 'DESYNC';
      return;
    }

    // A finisher owns the frame outright: no input, no fighters, no level, no
    // combat pass. Everything the player can see for the next few seconds is
    // being drawn by the director.
    if (this.fatality.active) {
      this.stepFatality();
      return;
    }

    // The boss introduction owns the frame the same way a finisher does: the
    // fight is frozen behind it, so nothing starts hitting you while you are
    // still reading who you are about to fight.
    if (this.intro.active) {
      /*
       * A boss introduction is on screen.
       *
       * Both peers reach this on the same sim frame — it is triggered from the
       * simulation, which is identical on both — so both are watching. But it
       * waits for a keypress, and whoever presses first advances while the
       * other is still reading. Ten seconds of that and lockstep concludes the
       * reader has gone and drops them, ending the match in the middle of the
       * one moment the game is trying to make an occasion of.
       *
       * So: tell the other side we are busy, and hold our own timeout while
       * they tell us the same.
       */
      this.setCinematicBusy(true);
      this.intro.update();
      return;
    }

    // Our own introduction is over. In co-op the fight does not resume until
    // everyone's is: whoever skipped first waits on the marks in the corner
    // rather than fighting a boss the other player has not been introduced to.
    if (this.cinematicBusy) {
      const net = this.net;
      if (net && net.role !== 'offline' && net.connected && net.players.length > 1) {
        this.introDone.add(net.slot);
        if (this.busyPeers.size > 0 || !this.allIntrosDone(net)) {
          net.send({ t: 'cue', slot: net.slot, busy: false });
          return;
        }
      }
      this.setCinematicBusy(false);
      this.introDone.clear();
    }

    /*
     * If the host already sampled input for this loop frame then it owns the
     * lockstep gate and the checksum too, and doing it again here would send
     * duplicate syncs and clobber the remote input it just injected. The
     * InputManager records the frame it last sampled, which is the honest way
     * to tell a driving host from a bare one.
     */
    // Compared against the SIM frame, because that is what a driving host now
    // samples with — see Game.step and NetFramed. Comparing against the loop
    // frame would make this read "not sampled" every frame in netplay and the
    // gate would run twice.
    const sampled = (this.host.input as unknown as { frame?: number }).frame === this.simFrame;

    if (!sampled) {
      /*
       * Sample and TRANSMIT before asking whether we may advance. The order
       * matters more than it looks.
       *
       * `prepare` is what records this frame's local input and puts it on the
       * wire, and `canAdvance` refuses to advance until every active slot —
       * INCLUDING our own — has input for the frame. Gating prepare behind
       * canAdvance therefore deadlocks the instant the opening input-delay
       * grace window runs out: neither peer may advance until it has the
       * other's input, and neither peer sends any, because sending only
       * happens on the far side of the gate it is waiting at.
       *
       * It then got worse rather than staying stuck. After NET_TIMEOUT_FRAMES
       * each side drops whatever it is waiting on — which included ITSELF —
       * and carries on alone with the other player frozen at their spawn. That
       * is exactly what a player sees as "my friend is stuck, and he sees me
       * stuck". Both peers had `timedOut: true` and had dropped slot 0.
       *
       * prepare is first-write-wins, so calling it again on a stalled frame is
       * harmless.
       */
      // ONLY under lockstep. Game.ts has already sampled this tick, and
      // sampleAll() rolls the pressed/released baseline every time it is
      // called with a frame number it has not seen — so a second sample on a
      // DIFFERENT clock recomputes `pressed` as `mask & ~mask`, i.e. zero.
      //
      // Under lockstep that is harmless: Game.ts samples with netFrameOf(),
      // which IS this sim clock, so the second call is a no-op and the edge
      // survives. Offline it samples with the RENDER frame, so this call used
      // to wipe every press edge before the fighters read it. Movement reads
      // `held` and was unaffected, which is exactly why a solo player could
      // walk but never attack, jump, grab or super, and why rebinding the keys
      // changed nothing — the bits arrived and were then zeroed.
      if (ls) this.host.input.sampleAll(this.simFrame);
      ls?.prepare(this.simFrame);

      if (ls && !ls.canAdvance(this.simFrame)) {
        this.stalled = ls.stalledFrames;
        return;
      }
    }
    this.stalled = ls ? ls.stalledFrames : 0;

    if (this.wantsPause()) {
      this.openPause();
      return;
    }

    this.step();
    this.simFrame++;
    this.steppedOn = this.host.loop.frame;

    if (!sampled && ls?.shouldChecksum(this.simFrame)) {
      ls.confirm(this.simFrame, this.checksum());
    }
  }

  private step(): void {
    const level = this.level;
    if (!level) return;

    this.hitstopRequest = 0;
    this.debugBoxes.length = 0;

    if (this.introTimer > 0) this.introTimer--;
    const held = this.introTimer > INTRO_FIGHT_AT;

    for (let i = 0; i < this.players.length; i++) {
      const slot = this.picks[i].slot;
      this.players[i].update(held ? EMPTY_INPUT : this.host.input.get(slot), this.sim);
    }

    level.update(this.sim);
    this.combat.resolve(level.fighters, this.sim);

    this.applyAmbient();
    this.trackStats();
    this.trackBoss();

    // A host with its own camera and particle pool steps them itself, right
    // after this returns; stepping them here as well would double their speed.
    if (this.ownsPresentation) {
      this.cam.update();
      this.particles.update();
      this.fx.update();
    }

    if (this.hitstopRequest > 0) {
      this.host.loop.hitstop = Math.max(this.host.loop.hitstop, this.hitstopRequest);
    }

    this.advancePhase();
  }

  // ── finishers ──────────────────────────────────────────────────────────────

  /**
   * The killing blow, offered by the combat resolver.
   *
   * Returning true means "I have taken this kill": the resolver drops its own
   * K.O. juice on the floor and everything the player sees from here is the
   * finisher. Returning false leaves the ordinary death exactly as it was, which
   * is what makes every guard clause below safe to write.
   */
  private readonly onFatality = (killer: Fighter, victim: Fighter): boolean =>
    this.startFatality(killer, victim);

  private startFatality(killer: Fighter, victim: Fighter): boolean {
    const level = this.level;
    if (!level) return false;
    // 'off' means off. The resolver checks it too; this is the other end of the
    // same promise, and the one a hand-written test would reach past.
    if (this.settings.gore === 'off') return false;
    if (this.fatality.active) return false;
    if (this.finished || this.paused) return false;
    // The map is already over, or has not started. A finisher played across a
    // MAP CLEAR banner is a finisher nobody is watching.
    if (this.phase !== 'fight' && this.phase !== 'intro') return false;
    if (killer.id === victim.id) return false;

    /*
     * Not over the wire.
     *
     * A finisher freezes the simulation for two or three seconds, and the gore
     * setting is a LOCAL preference — the fatality director says so itself, and
     * the resolver already refuses to even ask when this end has gore off. Two
     * peers who disagree about it would therefore freeze for different lengths
     * of time, and lockstep would spend the difference showing both of them a
     * "waiting for the other side" banner. Rather than smuggle a local
     * preference into a shared clock, a match with somebody else in it simply
     * gets the ordinary K.O. A room nobody has joined yet is still a solo fight,
     * and keeps its finishers.
     */
    if (this.lockstep?.active) return false;
    if (this.net && this.net.players.length > 1) return false;

    let by: FatalityDef['by'];
    let bossId: string | undefined;

    if (victim.team === 'player') {
      // Losing is where the best of the book lives: the hat gets eaten, the
      // Shiba takes a leg, the car parks on you. A player never dies quietly.
      if (killer.team === 'player') return false;
      by = killer.isBoss ? 'boss' : 'enemy';
      if (killer.isBoss) bossId = killer.archetype;
    } else {
      if (killer.team !== 'player') return false;
      by = 'player';
      // A boss always. A guard sometimes — see FATALITY_CHANCE.
      if (!victim.isBoss && !this.rng.chance(FATALITY_CHANCE)) return false;
    }

    let def = pickFatality(by, this.rng, bossId, this.settings.gore);
    // A boss with nothing of its own left in the book at this gore setting still
    // gets a send-off, rather than silently dropping back to a plain K.O.
    if (!def && bossId !== undefined) {
      def = pickFatality('enemy', this.rng, undefined, this.settings.gore);
    }
    if (!def) return false;

    if (!this.fatality.start(def, killer, victim)) return false;

    this.fatalityFrames = 0;
    this.fatalityLimit = Math.max(30, Math.round(def.duration)) + FATALITY_GRACE;
    level.beginFatality(killer.id, victim.id);
    return true;
  }

  /**
   * One frame of a performance.
   *
   * The sim is not running, so the presentation systems are stepped here by
   * exactly the same rule the fight uses: only when nobody else owns them.
   */
  private stepFatality(): void {
    const fd = this.fatality;

    /*
     * Pause still works.
     *
     * Escape arrives through the DOM and needs nothing from us, but Start on a
     * pad only exists if somebody samples the pad — and the sim clock is frozen,
     * so we sample against the LOOP's frame instead. It is not the netcode's
     * clock and it must not be: `simFrame` is what lockstep counts, and this
     * path deliberately never runs in a netplay fight.
     */
    const sampled =
      (this.host.input as unknown as { frame?: number }).frame === this.host.loop.frame;
    if (!sampled) this.host.input.sampleAll(this.host.loop.frame);
    if (this.wantsPause()) {
      this.openPause();
      return;
    }

    fd.update();
    this.fatalityFrames++;

    if (this.ownsPresentation) {
      this.cam.update();
      this.particles.update();
      this.fx.update();
    }

    // The director retires itself on the frame after its own duration. If it
    // ever does not, this does it for it — a fight that never resumes is the
    // one failure this feature is not allowed to have.
    if (this.fatalityFrames > this.fatalityLimit) fd.cancel();
    if (fd.done || !fd.active) this.endFatality();
  }

  /** Give the fight its camera, its map and its framing back. Idempotent. */
  private endFatality(): void {
    // `fatalityLimit` is set the moment one starts and cleared here, so it is
    // also the answer to "was there a show at all", which keeps this safe to
    // call from enter(), exit() and every map transition.
    const had = this.fatality.active || this.fatalityLimit > 0;
    // Hand the performer their feet back BEFORE cancelling, while the director
    // still knows who it was. The killing move was frozen mid-swing for the
    // whole show; resuming into its leftover recovery left the player rooted
    // for the best part of a second while the room moved on around them.
    // Guarded on `had`, not on `active`: a director that finished NATURALLY has
    // already cleared its own active flag by the time we get here, and that is
    // the common path — guarding on active would have fixed only the timeout.
    if (had) {
      const performer = this.fatality.performer;
      if (performer) performer.releaseFromFinisher();
    }
    if (this.fatality.active) this.fatality.cancel();
    this.fatalityFrames = 0;
    this.fatalityLimit = 0;
    this.level?.endFatality();
    // `cancel()` restores the zoom it borrowed, but only the one it saved; this
    // is what a cancel from anywhere else lands on.
    if (had) this.cam.zoom = FIGHT_ZOOM;
  }

  /**
   * Settings the player can change from the pause menu, pushed out on the first
   * frame after they change and never re-pushed. Three compares a frame.
   */
  private syncSettings(): void {
    const gore = this.settings.gore;
    if (gore !== this.goreSeen) {
      this.goreSeen = gore;
      setGoreLevel(gore);
      this.fatality.setGore(gore);
      // Turning it off mid-performance stops the performance. That is the whole
      // point of the switch.
      if (gore === 'off' && this.fatality.active) this.endFatality();
    }

    const reduced = this.settings.reducedMotion === true;
    if (reduced !== this.motionSeen) {
      this.motionSeen = reduced;
      this.fatality.setReducedMotion(reduced);
    }
  }

  private advancePhase(): void {
    const level = this.level;
    if (!level) return;

    switch (this.phase) {
      case 'intro':
        if (this.introTimer <= 0) this.phase = 'fight';
        break;

      case 'fight':
        if (level.failed) {
          this.phase = 'continue';
          this.continueTimer = CONTINUE_FRAMES;
          this.host.audio.music('defeat');
        } else if (level.complete) {
          this.phase = 'clear';
          this.clearTimer = CLEAR_FRAMES;
          this.mapsCleared++;
          for (const p of this.players) p.celebrate();
          this.host.audio.music('victory');
          this.host.audio.play('coin', { pitch: 1.2 });
          this.recordProgress();
        }
        break;

      case 'clear':
        if (--this.clearTimer <= 0) this.nextMap();
        break;

      case 'continue':
        if (this.wantsContinue()) this.useContinue();
        else if (--this.continueTimer <= 0) this.finish('gameover');
        break;

      default:
        break;
    }
  }

  // ── construction ───────────────────────────────────────────────────────────

  private resolvePicks(p: FightParams): FightPlayerPick[] {
    if (p.players && p.players.length > 0) {
      return p.players.map((x, i) => ({
        slot: Number.isFinite(x.slot) ? x.slot : i,
        dwarfId: x.dwarfId,
        name: x.name,
        local: x.local,
        onPad: x.onPad,
        seat: Number.isFinite(x.seat) ? x.seat : undefined,
      }));
    }

    if (p.dwarfIds && p.dwarfIds.length > 0) {
      return p.dwarfIds.map((id, i) => ({ slot: i, dwarfId: id, local: true }));
    }

    const net = p.net ?? this.host.net ?? null;
    if (net && net.role !== 'offline' && net.players.length > 0) {
      const mine = net.slot;
      return net.players.map((np) => ({
        slot: np.slot,
        dwarfId: np.dwarfId ?? DWARFS[0].id,
        name: np.name,
        local: np.slot === mine,
      }));
    }

    // Somebody dropped us straight into a fight. Give them Grumpy; he is angry
    // enough to carry a solo run.
    return [{ slot: 0, dwarfId: 'grumpy', local: true }];
  }

  /**
   * A slot with no input source is a player who cannot move, which reads as a
   * broken game rather than as a missing menu step. Fill the gaps.
   */
  private ensureInputSources(): void {
    const input = this.host.input;
    let pads: number[] | null = null;

    for (const pick of this.picks) {
      if (pick.local === false) continue;
      if (input.source(pick.slot)) continue;

      if (pick.onPad !== true) {
        const slot = clamp(pick.slot, 0, 1);
        const bindings =
          this.settings.bindings?.[slot] ?? DEFAULT_BINDINGS[slot] ?? DEFAULT_BINDINGS[0];
        input.attach(pick.slot, new KeyboardSource(slot, bindings));
        continue;
      }

      if (pads === null) {
        pollGamepads();
        pads = connectedGamepads();
      }
      // The nth pad-driven seat is holding the nth pad, counting the pad seats
      // in slot order — the same rule the HUD uses to name a player's buttons.
      let nth = 0;
      for (const other of this.picks) {
        if (other === pick) break;
        if (other.local !== false && other.onPad === true) nth++;
      }
      const padIndex = pads[nth];
      if (padIndex !== undefined) input.attach(pick.slot, new GamepadSource(padIndex));
    }
  }

  private buildPlayers(): void {
    const mul = DIFFICULTY_HEALTH[this.settings.difficulty] ?? 1;
    const def = getMap(this.mapIndex);
    this.players = [];

    for (let i = 0; i < this.picks.length; i++) {
      const pick = this.picks[i];
      const d = safeDwarf(pick.dwarfId);

      const init: FighterInit = {
        id: pick.slot,
        team: 'player',
        x: 40 + i * 24,
        z: clamp(def.depth * 0.5 + (i - (this.picks.length - 1) * 0.5) * 16, 4, def.depth - 4),
        // The transformation is over by the time the fight starts: full leather.
        style: { ...d.style, outfit: 1 },
        skeleton: DWARF_SKELETON,
        health: Math.max(40, Math.round(d.stats.health * mul)),
        speed: d.stats.speed,
        power: d.stats.power,
        jump: d.stats.jump,
        moves: {
          light: d.moves.light,
          heavy: d.moves.heavy,
          special: d.moves.special,
          airLight: d.moves.airLight,
          airHeavy: d.moves.airHeavy,
          grab: d.moves.grab,
          dashAttack: d.moves.dashAttack,
          super: superMoveFor(d),
        },
        voice: d.voice,
        archetype: `dwarf_${d.id}`,
      };

      const f = new PlayerFighter(init);
      this.armPlayer(f, pick.slot, d);
      this.players.push(f);
    }
  }

  /**
   * What a dwarf walks onto the map holding.
   *
   * Two rules, in order. Whatever they carried off the last map comes with
   * them, wear and ammunition included — fighting a whole level to keep a
   * weapon and then losing it on the load screen is a punishment for winning.
   * Failing that, they start with the weapon the select screen promised them,
   * which is the one printed under their portrait as their signature.
   *
   * On 'musk' neither applies. That difficulty's whole proposition is that
   * nothing accumulates: you arrive with your hands and you leave with them.
   */
  private armPlayer(f: PlayerFighter, slot: number, d: DwarfDef): void {
    if (this.settings.difficulty === 'musk') return;

    const kept = this.host.run?.carried[slot] ?? null;
    if (kept) {
      f.giveWeapon(kept.kind, kept.durability, kept.ammo);
      return;
    }
    if (d.signatureWeapon) f.giveWeapon(d.signatureWeapon);
  }

  /**
   * Remember what everyone is holding, so the next map can hand it back.
   * Cleared rather than recorded on 'musk'.
   */
  private storeCarried(): void {
    const carried = this.host.run?.carried;
    if (!carried) return;
    for (const f of this.players) {
      carried[f.id] =
        this.settings.difficulty === 'musk' || !f.alive ? null : f.carried;
    }
  }

  private buildLevel(carry: boolean): void {
    const def = getMap(this.mapIndex);

    // Whatever was on stage belonged to the map we are leaving, and the joke
    // history with it: a new map should not open with the three finishers the
    // last one just banned.
    this.endFatality();
    resetFatalityHistory();

    for (let i = 0; i < this.players.length; i++) {
      const f = this.players[i];
      const x = 40 + i * 24;
      const z = clamp(def.depth * 0.5 + (i - (this.players.length - 1) * 0.5) * 16, 4, def.depth - 4);
      // Damage carries between maps; a fixed slice of the bar comes back so the
      // run has a rhythm instead of a slow slide into unwinnable.
      const hurt = f.health;
      const keep = carry ? f.meter * METER_CARRY : 0;
      f.respawn(x, z, keep);
      if (carry) f.health = clamp(hurt + f.maxHealth * MAP_HEAL, 1, f.maxHealth);
      f.minX = 4;
      f.maxX = def.width - 4;
    }

    this.felled.clear();
    this.combat.reset();
    this.particles.clear();
    resetHud();
    setHudPadSlots(new Set(this.picks.filter((p) => p.onPad === true).map((p) => p.slot)));

    this.level = new Level(def, this.players, {
      fx: this.fx,
      audio: this.host.audio,
      cam: this.cam,
      rng: this.rng,
    });

    this.cam.snapTo(this.players[0]?.pos.x ?? VIEW_W * 0.5);
    this.phase = 'intro';
    this.introTimer = INTRO_FRAMES;
    this.clearTimer = 0;
    this.bossIntro = 0;
    this.intro = this.makeBossIntro();
    this.bossSeen = false;
  }

  private makeSim(): SimContext {
    const self = this;
    return {
      get frame(): number {
        return self.simFrame;
      },
      get rng(): Rng {
        return self.rng;
      },
      get fighters(): readonly Fighter[] {
        return self.level ? self.level.fighters : self.players;
      },
      spawnHit(attackerId, window): void {
        self.combat.spawnHit(attackerId, window, self.simFrame);
        if (self.settings.showHitboxes) self.recordBox(attackerId, window.box);
      },
      spawn(kind, x, y, z, data): void {
        self.level?.spawn(kind, x, y, z, data);
      },
      requestHitstop(frames): void {
        if (frames > self.hitstopRequest) self.hitstopRequest = frames;
      },
      get fx(): Fx {
        return self.fx;
      },
      get audio(): AudioSystem {
        return self.host.audio;
      },
    };
  }

  // ── per-frame bookkeeping ──────────────────────────────────────────────────

  /** The map's ambient light, multiplied over everyone standing in it. */
  private applyAmbient(): void {
    const tint = getMap(this.mapIndex).palette.tint;
    if (!this.level) return;
    for (const f of this.level.fighters) f.tint = tint;
  }

  private trackStats(): void {
    // comboCount climbs by exactly one per landed hit and resets when a combo
    // lapses, so its rising edges are the hit count — no need to instrument the
    // resolver just for a statistic.
    let sum = 0;
    for (const f of this.players) {
      if (f.comboCount > this.bestCombo) this.bestCombo = f.comboCount;
      sum += f.comboCount;
    }
    if (sum > this.lastComboSum) this.totalHits += sum - this.lastComboSum;
    this.lastComboSum = sum;

    if (!this.level) return;
    for (const f of this.level.fighters) {
      if (f.team !== 'enemy' || f.alive || this.felled.has(f.id)) continue;
      this.felled.add(f.id);
      this.enemiesFelled++;
    }
  }

  private trackBoss(): void {
    const boss = this.level?.takeBossStart();
    if (boss && !this.bossSeen) {
      this.bossSeen = true;
      const at = this.level?.bossPos;
      // A directed introduction that holds on its text until the player says
      // they have read it, rather than a timed plate over a live fight.
      if (!this.intro.start(boss, at?.x ?? this.cam.x + VIEW_W * 0.5, at?.z ?? Z_DEPTH * 0.5)) {
        this.bossIntro = BOSS_INTRO_FRAMES;
      }
    }
    if (this.bossIntro > 0) this.bossIntro--;
  }

  private recordBox(
    attackerId: number,
    box: { ox: number; oy: number; oz: number; hw: number; hh: number },
  ): void {
    if (!this.level) return;
    for (const f of this.level.fighters) {
      if (f.id !== attackerId) continue;
      this.debugBoxes.push({
        x: f.pos.x + box.ox * f.facing,
        y: f.pos.y + box.oy,
        z: f.pos.z + box.oz,
        hw: box.hw,
        hh: box.hh,
      });
      return;
    }
  }

  // ── transitions ────────────────────────────────────────────────────────────

  /**
   * Pause is not a fighter's action. It belongs to whoever is in the room —
   * which is why both halves of a shared keyboard have always kept Escape — so
   * this asks every slot with a LIVE local source rather than only the slots
   * that picked a dwarf. Choose your fighter on the keyboard, pick up the pad
   * sitting on a slot of its own, and Start still opens the menu.
   *
   * The live-source test is what keeps it local: lockstep drives a remote peer's
   * slot by injecting a mask into it, and no source is ever attached there, so a
   * peer cannot pause this machine by leaning on their own Start button.
   */
  private wantsPause(): boolean {
    const input = this.host.input;
    for (const slot of input.slots) {
      if (input.source(slot) === null) continue;
      if (input.get(slot).pressed & Btn.Pause) return true;
    }
    return false;
  }

  private wantsContinue(): boolean {
    const any = Btn.Light | Btn.Heavy | Btn.Special | Btn.Super | Btn.Jump | Btn.Grab | Btn.Pause;
    for (const slot of this.localSlots) {
      if (this.host.input.get(slot).pressed & any) return true;
    }
    return false;
  }

  private openPause(): void {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.host.audio.play('ui_back');
    this.broadcastPause(true);

    const scene = new PauseScene(this.host, {
      under: this,
      net: this.net,
      mapName: getMap(this.mapIndex).name,
      mapIndex: this.mapIndex,
      onResume: () => {
        this.paused = false;
        this.broadcastPause(false);
      },
      onQuit: () => {
        this.paused = false;
        this.finished = true;
      },
    });

    // Nowhere to push it means no pause menu; unpause rather than freeze solid.
    if (!nav.push(this.host, scene)) this.paused = false;
  }

  private broadcastPause(paused: boolean): void {
    const net = this.net;
    if (!net || net.role === 'offline') return;
    net.send({ t: 'pause', paused, by: this.localSlots[0] ?? 0 });
  }

  private useContinue(): void {
    this.continues++;
    this.score += this.level?.score ?? 0;
    this.host.audio.play('ui_select');
    this.host.audio.music(getMap(this.mapIndex).music);
    this.buildLevel(false);
  }

  private nextMap(): void {
    this.score += this.level?.score ?? 0;
    // Before the world is rebuilt: whatever survived the map goes with them.
    this.storeCarried();
    const next = this.mapIndex + 1;
    if (next > TOTAL_MAPS) {
      this.finish('victory');
      return;
    }
    this.mapIndex = next;
    this.recordProgress();
    this.buildLevel(true);
  }

  private recordProgress(): void {
    const save = this.host.save;
    const reached = Math.min(TOTAL_MAPS, this.mapIndex + 1);
    if (reached > save.progress) {
      save.progress = reached;
      this.persist();
    }
  }

  private persist(): void {
    const h = this.host as unknown as Record<string, unknown>;
    const fn = h.persist ?? h.saveNow;
    if (typeof fn === 'function') {
      (fn as () => void).call(this.host);
      return;
    }
    saveSave(this.host.save);
  }

  /** Rebuild the whole run at `mapIndex` with the same fighters. */
  restart(mapIndex: number): void {
    const params: FightParams = {
      players: this.picks.slice(),
      mapIndex: clamp(Math.round(mapIndex), 1, TOTAL_MAPS),
      score: 0,
      continues: 0,
      net: this.net,
      lockstep: this.lockstep,
      seed: randomSeed(),
    };
    this.finished = false;
    if (!nav.replace(this.host, this, params)) this.enter(params);
  }

  private finish(outcome: 'victory' | 'gameover'): void {
    if (this.finished) return;
    this.finished = true;

    const total = this.score + (this.level?.score ?? 0);
    const map = getMap(this.mapIndex);
    const save = this.host.save;

    let record = false;
    for (const pick of this.picks) {
      const best = save.scores[pick.dwarfId] ?? 0;
      if (total > best) {
        save.scores[pick.dwarfId] = total;
        record = true;
      }
      if (outcome === 'victory' && !save.cleared.includes(pick.dwarfId)) {
        save.cleared.push(pick.dwarfId);
      }
    }
    this.persist();

    const result: FightResult = {
      outcome,
      score: total,
      mapIndex: this.mapIndex,
      mapName: map.name,
      mapsCleared: this.mapsCleared,
      bestCombo: this.bestCombo,
      totalHits: this.totalHits,
      enemiesFelled: this.enemiesFelled,
      frames: this.simFrame,
      continues: this.continues,
      players: this.picks.slice(),
      newRecord: record && total > 0,
      desynced: this.lockstep?.desynced === true,
    };

    const actions: ResultActions = {
      retry: (index) => this.restart(index),
      menu: () => quitToMenu(this.host),
    };

    this.host.audio.music(outcome === 'victory' ? 'victory' : 'defeat');
    this.host.loop.timeScale = 1;
    this.host.loop.hitstop = 0;

    const scene =
      outcome === 'victory'
        ? new VictoryScene(this.host, result, actions)
        : new GameOverScene(this.host, result, actions);
    if (!nav.replace(this.host, scene, { result, actions })) {
      nav.goto(this.host, outcome, { result, actions });
    }
  }

  // ── net plumbing ───────────────────────────────────────────────────────────

  private readonly onNet = (m: NetMessage): void => {
    if (m.t === 'cue') {
      // Somebody is watching a cinematic, or has just finished one. Either way
      // they have not gone anywhere, so the drop timeout stays suspended while
      // anybody is still in there.
      if (m.busy) {
        this.busyPeers.add(m.slot);
        this.introDone.delete(m.slot);
      } else {
        this.busyPeers.delete(m.slot);
        this.introDone.add(m.slot);
      }
      this.lockstep?.hold(this.cinematicBusy || this.busyPeers.size > 0);
      return;
    }
    if (m.t === 'pause') {
      this.remotePaused = m.paused ? m.by : -1;
    } else if (m.t === 'bye') {
      this.netError = `${this.peerName(m.slot)} left the fight.`;
    }
  };

  private readonly onNetError = (message: string): void => {
    this.netError = message;
  };

  private peerName(slot: number): string {
    const p = this.net?.players.find((x) => x.slot === slot);
    return p ? p.name.toUpperCase() : `PLAYER ${slot + 1}`;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  render(alpha: number): void {
    const level = this.level;
    if (!level) return;

    /*
     * A held fight is a still picture.
     *
     * `alpha` is how far the loop is between two fixed steps, and the loop
     * keeps counting whether or not anything stepped: paused, behind a
     * finisher, behind a boss introduction, waiting on a peer — it goes on
     * sweeping 0..1 sixty times a second. Interpolating with it then slides
     * every fighter from where it was to where it is, snaps it back, and does
     * it again, which is the whole cast rocking on the spot behind the pause
     * menu. Interpolation only means anything between two steps that both
     * happened, so when the last loop tick did not advance the simulation the
     * frame is drawn at the state it actually holds.
     */
    if (this.steppedOn !== this.host.loop.frame) alpha = 1;

    const r = this.host.renderer;
    const ctx = r.ctx;
    // A host that composites the frame itself has already begun and cleared it.
    const owns = typeof this.host.renderWorldFx !== 'function';

    if (owns) {
      r.begin();
      r.clear('#05060a');
    }

    this.renderScenery(ctx, r);
    this.gradeStage(ctx, r);

    r.withCamera(this.cam, () => {
      // Vertical framing, applied inside the camera transform so every layer
      // that shares it — actors, particles, floating text — moves together and
      // stays registered with the scenery above. See FIGHT_FRAME_Y.
      if (FIGHT_FRAME_Y !== 0) ctx.translate(0, FIGHT_FRAME_Y);
      // Stains belong to the floor, so they go down before anybody stands on
      // it. Drawn with the rest of the particles — which come after the actors
      // — blood on the ground was painted over the fighters' heads.
      this.particles.renderGround(ctx, this.cam);
      this.drawPlayerRings(ctx, alpha);
      level.render(ctx, this.cam, alpha);
      // Between the map and the juice: the performance stands where the two
      // fighters stood — the Level has struck them from its own draw list — and
      // the blood it throws lands in front of it.
      this.fatality.render(ctx, this.cam);
      this.intro.render(ctx, this.cam);
      if (this.host.renderWorldFx) {
        this.host.renderWorldFx(ctx);
      } else {
        this.particles.render(ctx, this.cam);
        this.fx.render(ctx, this.cam);
      }
      if (this.settings.showHitboxes) this.drawDebug(ctx);
    });

    r.withScreen(() => {
      drawHud(ctx, this.players, level, this.simFrame, {
        scoreBase: this.score,
        mapName: getMap(this.mapIndex).name,
        mapIndex: this.mapIndex,
        mapTotal: TOTAL_MAPS,
        names: this.nameMap(),
        seats: this.seatMap(),
        quiet: this.introTimer > INTRO_FIGHT_AT,
      });
      // Over the HUD on purpose: the letterbox and the title card are the frame
      // around the shot, and a health bar poking through the black is exactly
      // the sort of thing that says "this is a game" at the wrong moment.
      this.fatality.renderOverlay(ctx);
      this.intro.renderOverlay(ctx);
      this.drawIntro(ctx);
      this.drawBossIntro(ctx);
      this.drawIntroMarks(ctx);
      this.drawClear(ctx);
      this.drawContinue(ctx);
      this.drawNet(ctx);
    });

    if (owns) {
      this.fx.renderOverlay(r);
      r.end();
    }
  }

  /**
   * The backdrop, in the basis the fight zoom actually crops.
   *
   * `drawBackdrop` is authored at VIEW_W x VIEW_H and scrolls its own bands
   * against `cam.x`, so it wants the camera's *zoom* but not the camera's pan —
   * and it reads the live transform back to work out which slice of its authored
   * frame is on screen. Reproducing the world's zoom-about-the-middle here, plus
   * the same vertical framing, is what keeps the drawn ground line under
   * everybody's feet and the parallax bands moving at the right rate.
   *
   * This is why `Level.renderBackground` is not used: its screen-space helper
   * cancels the transform's translation outright, which at any zoom above 1
   * pins the backdrop to the canvas corner and drops the whole floor plane off
   * the bottom of the screen.
   */
  private renderScenery(ctx: C2D, r: Renderer): void {
    const z = this.cam.zoom > 0.05 ? this.cam.zoom : 1;
    // A finisher lifts and rolls the camera. The set has to go with it, or the
    // performers tilt over a floor that stayed level and float off a wall that
    // did not move. Both are zero for the whole of an ordinary fight.
    const lift = this.cam.y;
    const roll = this.cam.rotation;
    r.withScreen(() => {
      if (z !== 1 || FIGHT_FRAME_Y !== 0 || lift !== 0 || roll !== 0) {
        ctx.translate(VIEW_W * 0.5, VIEW_H * 0.5);
        if (roll !== 0) ctx.rotate(roll);
        ctx.scale(z, z);
        ctx.translate(-VIEW_W * 0.5, -VIEW_H * 0.5 + FIGHT_FRAME_Y - lift);
      }
      drawBackdrop(ctx, getMap(this.mapIndex), this.cam, this.simFrame);
    });
  }

  /**
   * Push the scenery back so the fighters come forward.
   *
   * The maps are procedural and bright in places — wooden posts lit orange, a
   * pale factory floor — while every dwarf on the roster is wearing black
   * leather. Left alone the backdrop out-contrasts the people fighting in front
   * of it, which is the one thing a brawler's background must never do. So the
   * whole painted set is graded once, before the actors are drawn: some
   * saturation out, some value down, the corners into shadow. The fighters,
   * the props and the effects are drawn after and keep their full range.
   *
   * Three full-frame fills. Cheap on any GPU-backed canvas, and the same cost on
   * every map, which is what matters for a fixed-step game.
   */
  private gradeStage(ctx: C2D, r: Renderer): void {
    r.withScreen(() => {
      ctx.save();
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = STAGE_DESAT;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = STAGE_DIM;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalCompositeOperation = 'source-over';
      const g = ctx.createRadialGradient(
        VIEW_W * 0.5,
        VIEW_H * 0.58,
        VIEW_H * 0.32,
        VIEW_W * 0.5,
        VIEW_H * 0.58,
        VIEW_W * 0.66,
      );
      g.addColorStop(0, 'rgba(12,9,7,0)');
      g.addColorStop(1, STAGE_VIGNETTE);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    });
  }

  /**
   * A ring on the floor under each player, in their colour.
   *
   * The marker over the head answers "which one is me"; the ring answers
   * "where exactly am I on the belt", which is the question a 2.5D brawler
   * actually asks you on every swing — a dwarf in the air, in a crowd, or behind
   * a riot shield has no other visible foot position. Floor layer: drawn with
   * the stains, before anybody stands on it.
   */
  private drawPlayerRings(ctx: C2D, alpha: number): void {
    const a = clamp(alpha, 0, 1);
    const seats = this.seatMap();
    ctx.save();
    for (const f of this.players) {
      if (!f.alive || f.riding) continue;
      const x = lerp(f.prevPos.x, f.pos.x, a);
      const z = lerp(f.prevPos.z, f.pos.z, a);
      const air = lerp(f.prevPos.y, f.pos.y, a);
      const u = clamp(1 - (Z_DEPTH - z) * Z_PERSPECTIVE, 0.75, 1);
      const gy = GROUND_Y + z * Z_SCALE;
      // Shrinks and fades as they leave the floor, so a jump reads as height.
      const lift = clamp(air / 60, 0, 1);
      const rx = 15 * u * (1 - lift * 0.35);
      const ry = rx * 0.32;
      const color = playerColor(seats[f.id] ?? f.id);
      ctx.globalAlpha = 0.9 - lift * 0.5;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = PALETTE.ink;
      ctx.beginPath();
      ctx.ellipse(x, gy + 0.8, rx + 0.6, ry + 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(x, gy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // A notch on the side they face: which way the next swing goes.
      ctx.fillStyle = color;
      const nx = x + f.facing * (rx + 1.5);
      ctx.beginPath();
      ctx.moveTo(nx + f.facing * 3.2, gy);
      ctx.lineTo(nx, gy - 2.2);
      ctx.lineTo(nx, gy + 2.2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private seatMap(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const pick of this.picks) out[pick.slot] = pick.seat ?? pick.slot;
    return out;
  }

  private nameMap(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const pick of this.picks) {
      if (pick.name) out[pick.slot] = pick.name.toUpperCase();
    }
    return out;
  }

  /**
   * Hitbox overlay. The hurtbox drawn here mirrors the resolver's standing
   * default, which is what fighters actually use — none of them publish one.
   */
  private drawDebug(ctx: C2D): void {
    const level = this.level;
    if (!level) return;

    ctx.save();
    ctx.lineWidth = 1;

    for (const f of level.fighters) {
      if (!f.alive) continue;
      const sy = GROUND_Y + f.pos.z * Z_SCALE - f.pos.y;
      ctx.strokeStyle = 'rgba(90,220,255,0.85)';
      ctx.strokeRect(f.pos.x - 10, sy - 51, 20, 52);
      ctx.fillStyle = 'rgba(90,220,255,0.10)';
      ctx.fillRect(f.pos.x - 10, sy - 51, 20, 52);
    }

    for (const b of this.debugBoxes) {
      const sy = GROUND_Y + b.z * Z_SCALE - b.y;
      ctx.strokeStyle = 'rgba(255,60,90,0.95)';
      ctx.strokeRect(b.x - b.hw, sy - b.hh, b.hw * 2, b.hh * 2);
      ctx.fillStyle = 'rgba(255,60,90,0.16)';
      ctx.fillRect(b.x - b.hw, sy - b.hh, b.hw * 2, b.hh * 2);
    }

    ctx.restore();
  }

  /**
   * The title card, then FIGHT!.
   *
   * One band across the middle of the shot opens like a shutter, carries the
   * map number and its name, and closes again; FIGHT! then lands on its own,
   * big and red, with nothing behind it but the fight. Two beats, two jobs:
   * where you are, then go.
   */
  private drawIntro(ctx: C2D): void {
    if (this.introTimer <= 0) return;
    const map = getMap(this.mapIndex);
    const W = VIEW_W;

    if (this.introTimer > INTRO_FIGHT_AT) {
      const span = INTRO_FRAMES - INTRO_FIGHT_AT;
      const t = 1 - (this.introTimer - INTRO_FIGHT_AT) / span;
      const open = easeOut(clamp(t * 5, 0, 1)) * clamp((1 - t) * 6, 0, 1);
      const slide = lerp(-90, 0, easeOutBack(clamp(t * 2.6, 0, 1)));
      ctx.save();
      band(ctx, W, 160, 70, open);
      ctx.globalAlpha = clamp(open * 1.6, 0, 1);
      inkText(ctx, `MAP ${String(this.mapIndex).padStart(2, '0')}`, W * 0.5 + slide * 0.4, 141, 11, PALETTE.lamp, {
        align: 'center',
        weight: 800,
        tracking: 3,
        shadow: 0,
        strokeWidth: 0,
      });
      inkText(ctx, map.name.toUpperCase(), W * 0.5 - slide, 168, 26, PALETTE.bone, {
        align: 'center',
        weight: 900,
        italic: true,
      });
      inkText(
        ctx,
        this.mapIndex === 1
          ? 'THE DOOR WAS OFF ITS HINGES'
          : `${TOTAL_MAPS - this.mapIndex} BETWEEN YOU AND HIM`,
        W * 0.5,
        185,
        8,
        PALETTE.boneDim,
        { align: 'center', weight: 600, shadow: 0, strokeWidth: 0, tracking: 1.4 },
      );
      ctx.restore();
      return;
    }

    const t = 1 - this.introTimer / INTRO_FIGHT_AT;
    const pop = easeOutBack(clamp(t * 3.4, 0, 1));
    const fade = clamp((1 - t) * 2.6, 0, 1);
    ctx.save();
    ctx.globalAlpha = fade;
    // A white slash under the word on the frame it lands, gone a few frames later.
    if (t < 0.12) {
      ctx.globalAlpha = fade * (1 - t / 0.12) * 0.8;
      slab(ctx, W * 0.5 - 150, 152, 300, 22, 14, '#ffffff');
      ctx.globalAlpha = fade;
    }
    inkText(ctx, 'FIGHT!', W * 0.5, 186, 30 + 34 * pop, PALETTE.bloodHot, {
      align: 'center',
      weight: 900,
      italic: true,
      shadow: 3,
    });
    ctx.restore();
  }

  /** Who is still being introduced to the boss. See ui/ReadyMarks. */
  private drawIntroMarks(ctx: C2D): void {
    const net = this.net;
    if (!net || net.role === 'offline' || !net.connected || net.players.length < 2) return;
    if (!this.cinematicBusy) return;
    drawReadyMarks(ctx, this.introMarks(net), VIEW_W, VIEW_H, this.simFrame);
    if (!this.intro.active) {
      const caption = readyCaption(this.introDone.size, net.players.length);
      if (!caption) return;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.textAlign = 'right';
      ctx.font = displayFont(8.5, 600);
      ctx.fillStyle = PALETTE.boneDim;
      ctx.fillText(caption.toUpperCase(), VIEW_W - 14, VIEW_H - 50);
      ctx.restore();
    }
  }

  private drawBossIntro(ctx: C2D): void {
    if (this.bossIntro <= 0) return;
    const bossId = getMap(this.mapIndex).boss;
    if (!bossId) return;
    const lines = BOSS_INTROS[bossId];
    if (!lines || lines.length === 0) return;

    const t = 1 - this.bossIntro / BOSS_INTRO_FRAMES;
    const a = clamp(Math.min(t * 6, (1 - t) * 6), 0, 1);
    if (a <= 0.01) return;

    // Sits under the Level's own title card rather than fighting it for space.
    const top = 190;
    const h = lines.length * 12 + 12;

    ctx.save();
    ctx.globalAlpha = a;
    band(ctx, VIEW_W, top + h * 0.5, h, a, 'rgba(12,10,9,0.82)', PALETTE.blood);
    for (let i = 0; i < lines.length; i++) {
      ctx.font = textFont(9, 500, true);
      ctx.textAlign = 'center';
      ctx.fillStyle = PALETTE.bone;
      ctx.fillText(lines[i], VIEW_W * 0.5, top + 16 + i * 12);
    }
    ctx.restore();
  }

  private drawClear(ctx: C2D): void {
    if (this.phase !== 'clear' || !this.level) return;
    const t = 1 - this.clearTimer / CLEAR_FRAMES;
    const pop = easeOutBack(clamp(t * 4, 0, 1));
    const open = easeOut(clamp(t * 6, 0, 1)) * clamp((1 - t) * 5, 0, 1);

    ctx.save();
    band(ctx, VIEW_W, 172, 84, open);
    ctx.globalAlpha = clamp(open * 1.5, 0, 1);
    inkText(ctx, 'MAP CLEAR', VIEW_W * 0.5, 172, 22 + 14 * pop, PALETTE.lamp, {
      align: 'center',
      weight: 900,
      italic: true,
    });
    inkText(
      ctx,
      this.mapIndex >= TOTAL_MAPS ? 'THERE IS NOWHERE LEFT FOR HIM TO GO' : 'HI HO',
      VIEW_W * 0.5,
      190,
      10,
      PALETTE.bone,
      { align: 'center', weight: 800, tracking: 2 },
    );
    inkText(ctx, `SCORE  ${(this.score + this.level.score).toLocaleString('en-US')}`, VIEW_W * 0.5, 204, 8.5, PALETTE.boneDim, {
      align: 'center',
      weight: 600,
      tracking: 1,
      shadow: 0,
      strokeWidth: 0,
    });
    ctx.restore();
  }

  private drawContinue(ctx: C2D): void {
    if (this.phase !== 'continue') return;
    const secs = Math.max(0, Math.ceil(this.continueTimer / 60));
    const beat = this.continueTimer % 60;
    const pop = easeOut(clamp((60 - beat) / 18, 0, 1));
    const urgent = secs <= 3;

    ctx.save();
    ctx.globalAlpha = 0.78;
    ctx.fillStyle = PALETTE.coal;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;

    inkText(ctx, 'CONTINUE?', VIEW_W * 0.5, 122, 34, PALETTE.bone, {
      align: 'center',
      weight: 900,
      italic: true,
    });

    // The count, in a ring that empties with the second.
    const cx = VIEW_W * 0.5;
    const cy = 178;
    const frac = beat / 60;
    ctx.lineWidth = 4;
    ctx.strokeStyle = PALETTE.coal4;
    ctx.beginPath();
    ctx.arc(cx, cy, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = urgent ? PALETTE.bloodHot : PALETTE.lamp;
    ctx.beginPath();
    ctx.arc(cx, cy, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    inkText(ctx, `${secs}`, cx, cy + 15, 46 - 10 * pop, urgent ? PALETTE.bloodHot : PALETTE.lamp, {
      align: 'center',
      weight: 900,
      italic: true,
    });

    inkText(ctx, 'PRESS ANY ATTACK', VIEW_W * 0.5, 238, 12, PALETTE.bone, {
      align: 'center',
      weight: 800,
      tracking: 1.5,
    });
    inkText(
      ctx,
      this.continues === 0
        ? 'SHE IS STILL IN THERE'
        : `${this.continues} CONTINUE${this.continues === 1 ? '' : 'S'} USED. NOBODY IS COUNTING.`,
      VIEW_W * 0.5,
      254,
      8.5,
      PALETTE.boneDim,
      { align: 'center', weight: 600, shadow: 0, strokeWidth: 0, tracking: 1 },
    );
    ctx.restore();
  }

  private drawNet(ctx: C2D): void {
    const ls = this.lockstep;

    if (ls?.desynced) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      band(ctx, VIEW_W, 176, 118, 1, 'rgba(26,6,6,0.94)', PALETTE.blood);
      ctx.globalAlpha = 1;
      inkText(ctx, 'DESYNCED', VIEW_W * 0.5, 156, 28, PALETTE.bloodHot, {
        align: 'center',
        weight: 900,
        italic: true,
      });
      inkText(ctx, 'THE TWO GAMES HAVE DRIFTED APART.', VIEW_W * 0.5, 178, 10, PALETTE.bone, {
        align: 'center',
        weight: 800,
      });
      inkText(
        ctx,
        'NOTHING ON THIS SCREEN IS TRUE ANY MORE. THE MATCH IS OVER.',
        VIEW_W * 0.5,
        193,
        8,
        PALETTE.boneDim,
        { align: 'center', weight: 600, shadow: 0, strokeWidth: 0 },
      );
      inkText(ctx, 'PRESS ESC TO QUIT', VIEW_W * 0.5, 218, 10, PALETTE.lamp, {
        align: 'center',
        weight: 800,
        tracking: 1.5,
      });
      ctx.restore();
      return;
    }

    if (this.remotePaused >= 0) {
      ctx.save();
      ctx.globalAlpha = 0.66;
      ctx.fillStyle = PALETTE.coal;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
      // Deliberately not the word PAUSED. PauseScene owns the paused
      // presentation; this state is the far side of the wire — no local menu is
      // up — so it says who stopped the fight instead.
      band(ctx, VIEW_W, 172, 56, 1);
      inkText(ctx, 'STANDBY', VIEW_W * 0.5, 172, 26, PALETTE.lamp, {
        align: 'center',
        weight: 900,
        italic: true,
      });
      inkText(ctx, `${this.peerName(this.remotePaused)} IS IN THE MENU`, VIEW_W * 0.5, 189, 10, PALETTE.bone, {
        align: 'center',
        weight: 800,
        tracking: 1,
      });
      ctx.restore();
      return;
    }

    if (ls && this.stalled > 8) {
      const waiting = ls.waitingOn;
      const who = waiting.length > 0 ? waiting.map((s) => this.peerName(s)).join(', ') : 'THE OTHER SIDE';
      const dots = '.'.repeat(1 + (((this.stalled / 18) | 0) % 3));
      ctx.save();
      slab(ctx, VIEW_W * 0.5 - 136, 150, 272, 42, 8, 'rgba(14,11,9,0.94)', PALETTE.ink, 1.6);
      ctx.fillStyle = PALETTE.warn;
      ctx.fillRect(VIEW_W * 0.5 - 128, 150, 256, 1.5);
      inkText(ctx, `WAITING FOR ${who}${dots}`, VIEW_W * 0.5, 170, 12, PALETTE.warn, {
        align: 'center',
        weight: 800,
      });
      inkText(ctx, `${(this.stalled / 60).toFixed(1)}s BEHIND`, VIEW_W * 0.5, 184, 8, PALETTE.boneDim, {
        align: 'center',
        weight: 600,
        shadow: 0,
        strokeWidth: 0,
      });
      ctx.restore();
      return;
    }

    if (this.netError && this.netError !== 'DESYNC') {
      ctx.save();
      slab(ctx, 10, VIEW_H - 64, VIEW_W - 20, 20, 6, 'rgba(40,8,8,0.94)', PALETTE.ink, 1.4);
      inkText(ctx, this.netError.toUpperCase(), VIEW_W * 0.5, VIEW_H - 50.5, 9, '#ffb4a8', {
        align: 'center',
        weight: 800,
      });
      ctx.restore();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function safeDwarf(id: string): DwarfDef {
  try {
    return getDwarf(id);
  } catch {
    return DWARFS[0];
  }
}
