/**
 * The boss cinematic — what used to be a title card slapped over a fight that
 * had already started.
 *
 * The old presentation had two faults and the players named both: the words
 * covered the thing you needed to look at, and they left before anybody could
 * read them. So this is built the other way round.
 *
 *   VISUAL FIRST. The fight behind goes dark, the letterbox comes in, and the
 *     camera picks the boss up out of the world and pushes in on them while
 *     they do the one thing that says who they are: the Shiba stretches and
 *     shakes itself out, the car revs and snaps its headlights on, the engineer
 *     closes the laptop, Trump squares the jacket. No text is on screen for any
 *     of it.
 *
 *   TEXT WAITS FOR THE PLAYER. When the name plate arrives the intro STOPS. It
 *     has no clock from that point on and never advances itself — a blinking
 *     prompt sits under the words until `press()` is called, exactly the way
 *     `CutsceneScene` handles the note in the opening cinematic, so the two
 *     places in the game that ask you to read behave identically.
 *
 *   IT IS ALWAYS SHORT. This plays fourteen times a run, so it must never feel
 *     like a toll booth. About a second and a half of picture, then the plate,
 *     then whatever the player wants. A press during the picture jumps straight
 *     to the plate; a press during the plate's reveal completes it; a press
 *     after that ends the whole thing on a hard cut back into the fight.
 *
 * ── SELF-CONTAINED BY CONSTRUCTION ──────────────────────────────────────────
 *
 * This owns nothing and mutates nothing. It never touches the Camera, the
 * Level, the Fighters or the scene: the "push in" is a transform this class
 * applies on top of whatever the camera is already doing, computed by inverting
 * the camera's own projection, so at t=0 the boss is drawn EXACTLY where the
 * frozen fight has them and at t=1 they are framed. That is also why the cut
 * back is free — the framing simply unwinds to where the fight already is, and
 * the last frame of the intro and the first frame of the fight are the same
 * picture.
 *
 * Everything visible is drawn here from vector geometry, including the dust and
 * the steam. Nothing is routed through the particle system or the Fx flash,
 * because the caller freezes the fight and may well stop updating both, and a
 * cinematic whose effects quietly do not run is worse than one with none. The
 * one thing that DOES go through `Fx` is screen shake, which is the caller's
 * property and is correctly damped by their settings.
 *
 * Wiring, in full:
 *
 *     // once
 *     this.bossIntro = new BossIntro({ fx, audio, cam, rng, reducedMotion });
 *     // when the boss appears
 *     this.bossIntro.start(bossDef, boss.pos.x, boss.pos.z);
 *     // sim
 *     if (this.bossIntro.active) { this.bossIntro.update(); return; }
 *     // on a fresh press of anything
 *     this.bossIntro.press();
 *     // render, inside the camera pass and the screen pass respectively
 *     this.bossIntro.render(ctx, cam);
 *     this.bossIntro.renderOverlay(ctx);
 */

import type {
  AudioBus,
  Bone,
  BonePose,
  BossDef,
  Facing,
  Pose,
  Rng,
  SfxCue,
} from '@/core/types';
import type { Camera } from '@/render/Camera';
import type { Fx } from '@/juice/Fx';

import { GROUND_Y, VIEW_H, VIEW_W, Z_SCALE } from '@/core/constants';
import { clamp, easeIn, easeInOut, easeOut, easeOutBack, lerp } from '@/core/math';

import { BOSS_INTROS } from '@/content/story';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON, HUMAN_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
/**
 * The bespoke boss rigs — the dog that is a dog, the car that is a car.
 *
 * These take the ground point in screen space exactly as `drawCharacter` does,
 * so one call site can pick between them; the difference is that a bespoke rig
 * is driven by a STATE NAME rather than by a skeletal pose, because a
 * cybertruck has no elbows to key. Both are touched in exactly one method,
 * `paintStage`.
 */
import type { BossRigKind } from '@/render/rig/BossRigs';
import { drawBossRig, hasBossRig } from '@/render/rig/BossRigs';
import { capsule, ellipse, poly, roundRect, star, zigzag } from '@/render/Shapes';

type C2D = CanvasRenderingContext2D;

/**
 * The boss looks at the camera, which is where the players are coming from.
 * Left, always: the belt scrolls right and the boss waits at the end of it.
 */
const FACE: Facing = -1;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export interface BossIntroDeps {
  /** Screen shake only, so the player's shake setting still governs it. */
  fx: Fx;
  audio: AudioBus;
  /**
   * Never written to. The framing is a transform applied on top of whatever
   * the camera is doing, computed from the live camera handed to `render`, so
   * there is nothing here to save and nothing to put back.
   */
  cam: Camera;
  rng: Rng;
  reducedMotion?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Look
//
// Same palette as the opening cinematic, deliberately: this is the same film.
// ─────────────────────────────────────────────────────────────────────────────

const INK = '#141019';
const NO = 'none';
const VOID = '#05060c';
const PAPER = '#e8ecf6';
const GOLD = '#ffd23f';
const DIM = '#98a2b6';
const FAINT = '#5c6474';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

/**
 * Font strings, built once.
 *
 * `ctx.font = ` + a template literal is a string allocation on every call, and
 * this file paints text every frame the plate is up. The sizes are all integers
 * and all small, so the whole space is enumerable.
 */
const FONT_MAX = 40;
const DISPLAY_FONT: string[] = [];
const SANS_FONT: string[] = [];
const SANS_ITALIC: string[] = [];
for (let i = 0; i <= FONT_MAX; i++) {
  DISPLAY_FONT.push(`900 ${i}px ${DISPLAY}`);
  SANS_FONT.push(`700 ${i}px ${SANS}`);
  SANS_ITALIC.push(`italic 700 ${i}px ${SANS}`);
}

function fontOf(table: string[], size: number): string {
  return table[clamp(Math.round(size), 0, FONT_MAX)];
}

// ── Framing ─────────────────────────────────────────────────────────────────

/** Letterbox bar height once it has finished sliding in. */
const BAR_H = 34;
const BAR_IN = 16;
const BAR_OUT = 10;

/** Where the boss ends up: right of centre, feet just above the bottom bar. */
const FRAME_X = VIEW_W * 0.705;
const FRAME_FEET = VIEW_H - BAR_H - 8;
/** How tall the boss should read on screen once framed, in virtual pixels. */
const FRAME_H = 186;
/** And how wide it is allowed to get. A cybertruck is mostly width. */
const FRAME_W = 350;
/** Absolute screen scale bounds. A rocket pulls back; a dog pushes in hard. */
const MIN_K = 0.6;
const MAX_K = 2.6;

/** The text column, hard left, over a plate that fades out toward the boss. */
const PLATE_W = 330;
const COL_X = 22;
const COL_W = 276;

// ── Clock ───────────────────────────────────────────────────────────────────

const ST_OFF = 0;
const ST_IN = 1;
const ST_POSE = 2;
const ST_CARD = 3;
const ST_OUT = 4;
const ST_DONE = 5;

/** Bars in, world down, framing begins. */
const IN_FRAMES = 20;
/** The characterful beat. Everything a boss does happens inside this. */
const POSE_FRAMES = 74;
/** Frames the framing move takes to arrive, and to unwind on the way out. */
const PUSH_IN = 46;
const PUSH_OUT = 8;
const OUT_FRAMES = 12;

/**
 * Presses are locked out twice, for the same reason `CutsceneScene` does it:
 * once against the start, so whatever the player was holding when the boss
 * walked in cannot skip the intro they have not seen yet, and once against the
 * plate, so the press that summoned the plate cannot also dismiss it.
 */
const PRESS_LOCK = 14;
const CARD_LOCK = 10;

// ── The plate's reveal ──────────────────────────────────────────────────────

const CARD_PLATE = 14;
const CARD_NAME = 2;
const CARD_TAIL = 12;
const CARD_RULE = 14;
const CARD_QUOTE = 20;
const CARD_BLURB = 30;
/** Frames between one blurb line arriving and the next. */
const BLURB_STEP = 5;
const BLURB_FADE = 12;

// ─────────────────────────────────────────────────────────────────────────────
// What each boss DOES while you look at them
//
// Acts are independent of which rig draws the body: `act` decides the transform
// and the pose tweak, `prop` decides the vector flourish painted around it.
// Everything here is authored per boss id, with a fallback per rigOverride so a
// boss added later still gets something characterful rather than a blank stare.
// ─────────────────────────────────────────────────────────────────────────────

const ACT_STAND = 0;
/** Front down, rear up, then shakes itself out. */
const ACT_DOG = 1;
/** Settles on its suspension, revs, snaps the lamps on. */
const ACT_CAR = 2;
/** Vents, leans, lights the engine. */
const ACT_ROCKET = 3;
/** Takes one heavy step and puts it down. */
const ACT_MECH = 4;
/** Working on something lit, then shuts it. */
const ACT_DESK = 5;
/** Squares the jacket, adjusts the tie. */
const ACT_TIE = 6;
/** Something electrical happens to it. */
const ACT_ZAP = 7;

const PROP_NONE = 0;
const PROP_SCREEN = 1;
const PROP_LIGHTS = 2;
const PROP_VENT = 3;
const PROP_ARC = 4;
const PROP_GLINT = 5;

interface BossBeat {
  act: number;
  prop: number;
  clip: string;
  /** Clip playback rate. Bosses idle slower than they fight. */
  rate: number;
  /** The frame within the pose beat where the act lands. */
  at: number;
  cue: SfxCue;
  cueAt: number;
  cuePitch: number;
  cueGain: number;
  cue2: SfxCue;
  cue2At: number;
  cue2Pitch: number;
  cue2Gain: number;
}

function beat(
  act: number, prop: number, clip: string, rate: number, at: number,
  cue: SfxCue, cueAt: number, cuePitch: number, cueGain: number,
  cue2: SfxCue, cue2At: number, cue2Pitch: number, cue2Gain: number,
): BossBeat {
  return {
    act, prop, clip, rate, at,
    cue, cueAt, cuePitch, cueGain,
    cue2, cue2At, cue2Pitch, cue2Gain,
  };
}

const BEATS: Record<string, BossBeat> = {
  // Ninety-one hours in. He is still typing when you arrive, and the laptop
  // going shut is the only acknowledgement you get.
  dev: beat(ACT_DESK, PROP_SCREEN, 'idle', 0.55, 44,
    'ui_move', 18, 1.7, 0.12, 'drop', 44, 0.9, 0.5),

  // A dog. Stretches, shakes the dust out of its coat, and looks at you.
  shiba: beat(ACT_DOG, PROP_NONE, 'idle', 0.5, 46,
    'grunt', 26, 1.75, 0.45, 'land', 46, 1.45, 0.4),

  // Posts about it first.
  blue_check: beat(ACT_DESK, PROP_SCREEN, 'taunt', 0.7, 40,
    'ui_select', 18, 1.5, 0.22, 'ui_error', 40, 1.2, 0.3),

  // Idles. Indicates. Lights up. None of it means what it says.
  fsd: beat(ACT_CAR, PROP_LIGHTS, 'idle', 0.4, 38,
    'engine', 10, 0.6, 0.5, 'tyres', 48, 1.0, 0.42),

  // Something enormous underground finishing a cut it was never told to stop.
  boring: beat(ACT_MECH, PROP_ARC, 'idle', 0.35, 40,
    'engine', 8, 0.42, 0.55, 'hit_metal', 40, 0.6, 0.5),

  // The implant is receiving something. It is not from here.
  neuralink: beat(ACT_ZAP, PROP_ARC, 'stunned', 0.8, 34,
    'taser', 34, 1.1, 0.42, 'grunt', 52, 1.3, 0.38),

  // Straightens the suit before serving you.
  regulator: beat(ACT_TIE, PROP_GLINT, 'taunt', 0.6, 40,
    'ui_select', 20, 0.9, 0.22, 'drop', 40, 1.3, 0.28),

  // Squares the jacket. Adjusts the tie. Twice.
  trump: beat(ACT_TIE, PROP_NONE, 'taunt', 0.55, 40,
    'ui_move', 22, 0.8, 0.18, 'grunt', 46, 0.85, 0.42),

  // Torque limits check, and one step forward to say it can.
  optimus: beat(ACT_MECH, PROP_ARC, 'idle', 0.4, 42,
    'dash', 14, 0.5, 0.32, 'hit_metal', 42, 0.75, 0.55),

  // Eleven thousand cards spinning up behind a very confident face.
  grok: beat(ACT_ZAP, PROP_GLINT, 'idle', 0.4, 36,
    'super_charge', 12, 1.3, 0.28, 'taser', 36, 0.8, 0.38),

  // Static fire. The exhaust arrives before the boss does.
  starship: beat(ACT_ROCKET, PROP_VENT, 'idle', 0.3, 40,
    'engine', 6, 0.4, 0.5, 'explosion', 40, 1.6, 0.28),

  // Dust off the coat, on a planet he wrote the constitution for.
  mars_gov: beat(ACT_TIE, PROP_GLINT, 'taunt', 0.6, 38,
    'grunt', 24, 0.85, 0.38, 'drop', 38, 0.8, 0.32),

  // Ninety-six percent of somebody you have been trying to reach for sixty-five
  // maps, holding the pose she was taught.
  clone: beat(ACT_STAND, PROP_GLINT, 'victory', 0.5, 44,
    'meter_full', 20, 1.25, 0.32, 'ui_select', 44, 1.4, 0.28),

  // Puts the phone away. Finally.
  musk: beat(ACT_DESK, PROP_SCREEN, 'taunt', 0.5, 42,
    'ui_select', 16, 1.1, 0.22, 'super_charge', 42, 0.8, 0.28),
};

/** Anything new, keyed off the rig it is drawn with. */
const BEATS_BY_RIG: Record<string, BossBeat> = {
  shiba: BEATS.shiba,
  cybertruck: BEATS.fsd,
  rocket: BEATS.starship,
  robot_giant: BEATS.optimus,
  humanoid: BEATS.trump,
};

const DEFAULT_BEAT = beat(ACT_STAND, PROP_GLINT, 'idle', 0.5, 40,
  'ui_move', 16, 0.9, 0.16, 'meter_full', 40, 1.0, 0.3);

/**
 * The bounding box of each rig, in ITS OWN units per unit of `style.scale`,
 * measured off the art in `BossRigs` and `Skeleton`. The framing needs it to
 * decide how far to push in: a fifteen-billion-dollar dog is forty units tall
 * and fifty long, and a Starship is fifty tall and sixteen wide, and pushing
 * both to the same zoom would put one in the letterbox and lose the other.
 *
 * `cx` is the visual centre along +x (forward). Only the quadruped needs it —
 * everything else is drawn about its own feet.
 */
const RIG_H: Record<string, number> = {
  shiba: 42,
  cybertruck: 32,
  rocket: 53,
  robot_giant: 78,
  humanoid: 72,
};

const RIG_W: Record<string, number> = {
  shiba: 26,
  cybertruck: 34,
  rocket: 16,
  robot_giant: 20,
  humanoid: 18,
};

const RIG_CX: Record<string, number> = {
  shiba: 5.5,
  cybertruck: 0,
  rocket: 0,
  robot_giant: 0,
  humanoid: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Scratch
//
// Nothing below allocates once the intro is running. Polygons are written into
// these buffers and consumed by `poly` before the next call can touch them, and
// the pose tweaks are the same three objects every frame.
// ─────────────────────────────────────────────────────────────────────────────

const P8 = new Array<number>(8).fill(0);
const EMPTY_LINES: readonly string[] = [];

const twArmLU: BonePose = {};
const twArmLL: BonePose = {};
const twArmRU: BonePose = {};
const twArmRL: BonePose = {};
const twChest: BonePose = {};
const twHead: BonePose = {};

function quad(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
  fill: string, outline: string = NO, ow = 0,
): void {
  P8[0] = ax; P8[1] = ay; P8[2] = bx; P8[3] = by;
  P8[4] = cx; P8[5] = cy; P8[6] = dx; P8[7] = dy;
  poly(ctx, P8, fill, outline, ow);
}

/** A pulse that rises over `up`, holds for `hold` and falls over `down`. */
function envelope(f: number, at: number, up: number, hold: number, down: number): number {
  if (f < at - up) return 0;
  if (f < at) return easeOut((f - (at - up)) / up);
  if (f < at + hold) return 1;
  if (f < at + hold + down) return 1 - easeIn((f - at - hold) / down);
  return 0;
}

const DUST_N = 12;

// ─────────────────────────────────────────────────────────────────────────────

export class BossIntro {
  private readonly fx: Fx;
  private readonly audio: AudioBus;
  private readonly rng: Rng;
  private readonly reduced: boolean;

  private stage = ST_OFF;
  /** Frames into the current stage. */
  private f = 0;
  /** Frames since `start`, for anything that blinks. */
  private clock = 0;

  private boss: BossDef | null = null;
  private bossX = 0;
  private bossZ = 0;
  private beat: BossBeat = DEFAULT_BEAT;
  private skeleton: Bone[] = HUMAN_SKELETON;
  private rigKind: BossRigKind = 'humanoid';
  private useBossRig = false;

  /** Rig height and half-width in local units. Drives framing and prop placing. */
  private bh = 72;
  private bw = 20;
  /** Horizontal nudge that puts the rig's silhouette, not its feet, on the mark. */
  private rcx = 0;
  /** The eased framing progress the current paint is running at. */
  private frameE = 0;
  private kTarget = 1.6;
  /** 0 = where the fight has them, 1 = framed. Eased at paint time. */
  private pushT = 0;
  /** How far down the fight behind has gone. */
  private veil = 0;
  /**
   * Opacity of the intro's own copy of the boss.
   *
   * The caller freezes the fight but is not obliged to stop drawing it, so for
   * the handful of frames at each end where the intro's boss and the Level's
   * boss are both on screen in the same place, this cross-dissolves between
   * them instead of ghosting one over the other.
   */
  private rigA = 0;

  private accent = GOLD;

  /** One press, consumed once, on the next `update`. */
  private pressReq = false;

  // The plate. Laid out once per boss, on the first frame it is painted,
  // because every measurement needs a context and none of them change after.
  private laidOut = false;
  private nameHead = '';
  private nameTail = '';
  private nameSize = 26;
  private tailSize = 9;
  private readonly tailLines: string[] = [];
  private readonly quoteLines: string[] = [];
  private quoteSize = 9;
  private blurb: readonly string[] = EMPTY_LINES;
  private blurbSize = 7;
  private yName = 120;
  private yTail = 148;
  private yRule = 160;
  private yQuote = 176;
  private yBlurb = 224;
  private yPrompt = 300;
  /** Frames the plate takes to finish arriving. Depends on how much text. */
  private revealEnd = 62;

  /** Screen-space flash, drawn here rather than through Fx — see the header. */
  private flashA = 0;
  private flashC = PAPER;

  private plateGrad: CanvasGradient | null = null;

  // Dust and steam. Seeded once per intro off the deterministic Rng so the same
  // boss on the same run looks the same twice.
  private readonly dustA = new Float32Array(DUST_N);
  private readonly dustV = new Float32Array(DUST_N);
  private readonly dustR = new Float32Array(DUST_N);
  private dustAt = -1;

  /** Mutated in place and handed to the rigs. Never reallocated. */
  private readonly charOpts: {
    scale: number;
    alpha: number;
    flash: number;
    reducedMotion: boolean;
  } = { scale: 1, alpha: 1, flash: 0, reducedMotion: false };

  private readonly bossOpts: {
    scale: number;
    alpha: number;
    flash: number;
    state: string;
    frame: number;
  } = { scale: 1, alpha: 1, flash: 0, state: 'idle', frame: 0 };

  constructor(deps: BossIntroDeps) {
    this.fx = deps.fx;
    this.audio = deps.audio;
    this.rng = deps.rng;
    this.reduced = deps.reducedMotion === true;
    this.charOpts.reducedMotion = this.reduced;
  }

  // ── State ────────────────────────────────────────────────────────────────

  get active(): boolean {
    return this.stage !== ST_OFF && this.stage !== ST_DONE;
  }

  get done(): boolean {
    return this.stage === ST_DONE;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Begin the intro for a boss. `bossX` / `bossZ` are the boss's world position
   * — the intro opens on them exactly where the frozen fight has them and puts
   * them back there before it hands control over.
   *
   * Returns false if there is nothing to play: no boss, or one already running.
   */
  start(boss: BossDef, bossX: number, bossZ: number): boolean {
    if (!boss || this.active) return false;

    this.boss = boss;
    this.bossX = bossX;
    this.bossZ = bossZ;

    const rig: BossRigKind = boss.rigOverride ?? 'humanoid';
    this.beat = BEATS[boss.id] ?? BEATS_BY_RIG[rig] ?? DEFAULT_BEAT;
    this.rigKind = rig;
    this.useBossRig = hasBossRig(rig);
    // Only reached when there is no bespoke rig, but kept faithful to what the
    // Level builds the fighter with so the cut into the fight is seamless.
    this.skeleton = rig === 'shiba' ? DWARF_SKELETON : HUMAN_SKELETON;

    const scale = boss.style.scale > 0.05 ? boss.style.scale : 1;
    this.bh = (RIG_H[rig] ?? 72) * scale;
    this.bw = (RIG_W[rig] ?? 18) * scale;
    this.rcx = (RIG_CX[rig] ?? 0) * scale;
    // Enough of the frame to be the subject, never so much that the silhouette
    // runs into the letterbox or off the side of the screen.
    const band = FRAME_FEET - (BAR_H + 14);
    this.kTarget = clamp(
      Math.min(Math.min(FRAME_H, band) / Math.max(8, this.bh), FRAME_W / Math.max(8, this.bw * 2)),
      MIN_K,
      MAX_K,
    );

    this.accent = boss.style.jacketAccent || GOLD;

    this.stage = ST_IN;
    this.f = 0;
    this.clock = 0;
    this.pushT = 0;
    this.veil = 0;
    this.rigA = 0;
    this.pressReq = false;
    this.flashA = 0;
    this.dustAt = -1;

    this.laidOut = false;
    this.blurb = BOSS_INTROS[boss.id] ?? EMPTY_LINES;

    for (let i = 0; i < DUST_N; i++) {
      this.dustA[i] = this.rng.range(-1, 1);
      this.dustV[i] = this.rng.range(0.5, 1.5);
      this.dustR[i] = this.rng.range(2.2, 5.4);
    }

    this.audio.music(boss.music);
    this.audio.play('super_charge', { gain: 0.2, pitch: 0.6 });
    return true;
  }

  /** A fresh key / button / click press. Edge-triggered by the caller. */
  press(): void {
    if (!this.active) return;
    this.pressReq = true;
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  update(): void {
    if (!this.active) return;

    this.clock++;
    this.f++;

    this.handlePress();
    if (!this.active) return;

    switch (this.stage) {
      case ST_IN:
        if (this.f >= IN_FRAMES) this.enterPose();
        break;
      case ST_POSE:
        this.poseBeats();
        if (this.f >= POSE_FRAMES) this.enterCard();
        break;
      case ST_CARD:
        // No clock past the reveal. This is the whole point of the rewrite.
        break;
      case ST_OUT:
        if (this.f >= OUT_FRAMES) {
          this.stage = ST_DONE;
          this.boss = null;
        }
        break;
      default:
        break;
    }
    if (this.stage === ST_DONE) return;

    // Framing. Arrives over PUSH_IN and unwinds much faster, because the way
    // back into the fight is a cut, not a move.
    if (this.stage === ST_OUT) this.pushT = Math.max(0, this.pushT - 1 / PUSH_OUT);
    else this.pushT = Math.min(1, this.pushT + 1 / PUSH_IN);

    if (this.stage === ST_IN) {
      this.veil = easeOut(clamp(this.f / IN_FRAMES, 0, 1));
      this.rigA = easeIn(clamp(this.f / IN_FRAMES, 0, 1));
    } else if (this.stage === ST_OUT) {
      this.veil = 1 - easeIn(clamp(this.f / OUT_FRAMES, 0, 1));
      this.rigA = 1 - easeIn(clamp(this.f / (OUT_FRAMES * 0.7), 0, 1));
    } else {
      this.veil = 1;
      this.rigA = 1;
    }

    this.flashA *= 0.8;
    if (this.flashA < 0.006) this.flashA = 0;
  }

  /**
   * One press, meaning whatever is on screen says it means.
   *
   *   picture  — bring the plate in now.
   *   reveal   — finish the reveal. Never advances past it: a player reading
   *              fast should not be punished by losing the page.
   *   plate up — leave, on a hard cut.
   */
  private handlePress(): void {
    const press = this.pressReq;
    this.pressReq = false;
    if (!press || this.clock < PRESS_LOCK) return;

    if (this.stage === ST_IN || this.stage === ST_POSE) {
      this.enterCard();
      return;
    }
    if (this.stage !== ST_CARD || this.f < CARD_LOCK) return;

    if (this.f < this.revealEnd) {
      this.f = this.revealEnd;
      this.audio.play('ui_move', { gain: 0.2, pitch: 1.4 });
      return;
    }
    this.enterOut();
  }

  private enterPose(): void {
    this.stage = ST_POSE;
    this.f = 0;
  }

  private enterCard(): void {
    if (this.stage === ST_CARD) return;
    this.stage = ST_CARD;
    this.f = 0;

    // The slam. Big, once, and over before the eye has finished arriving.
    this.audio.play('ko', { gain: 0.6, pitch: 0.78 });
    this.shake(9, 16);
    this.flash(0.38, PAPER);
  }

  private enterOut(): void {
    this.stage = ST_OUT;
    this.f = 0;
    this.audio.play('super_blast', { gain: 0.62, pitch: 1.08 });
    this.shake(6, 12);
    this.flash(0.5, PAPER);
  }

  private shake(mag: number, frames: number): void {
    if (this.reduced) return;
    this.fx.shake({ magnitude: mag, duration: frames });
  }

  private flash(a: number, color: string): void {
    // Reduced motion keeps the beat and drops it well under the level that
    // makes people ill.
    this.flashA = Math.max(this.flashA, this.reduced ? a * 0.22 : a);
    this.flashC = color;
  }

  /** The act's own audio and its one physical consequence. */
  private poseBeats(): void {
    const b = this.beat;
    const f = this.f;

    if (f === b.cueAt) this.audio.play(b.cue, { gain: b.cueGain, pitch: b.cuePitch });
    if (f === b.cue2At) this.audio.play(b.cue2, { gain: b.cue2Gain, pitch: b.cue2Pitch });

    if (f !== b.at) return;
    switch (b.act) {
      case ACT_DOG:
        this.dustAt = this.clock;
        this.shake(1.6, 10);
        break;
      case ACT_MECH:
        this.dustAt = this.clock;
        this.shake(5, 16);
        this.flash(0.16, this.accent);
        break;
      case ACT_CAR:
        this.dustAt = this.clock;
        this.shake(2.4, 12);
        this.flash(0.14, '#fff4d0');
        break;
      case ACT_ROCKET:
        this.dustAt = this.clock;
        this.shake(3.4, 22);
        this.flash(0.18, '#ff8a2a');
        break;
      case ACT_ZAP:
        this.shake(1.2, 8);
        this.flash(0.16, this.accent);
        break;
      default:
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // World layer
  //
  // Called inside the renderer's camera pass. Draws the scrim over the frozen
  // fight and then the boss, lifted out of the world by a transform derived
  // from the camera's own projection.
  // ─────────────────────────────────────────────────────────────────────────

  render(ctx: C2D, cam: Camera): void {
    if (!this.active || !this.boss) return;

    if (this.veil > 0.004) {
      ctx.globalAlpha = this.veil * 0.9;
      ctx.fillStyle = VOID;
      // Overscan rather than arithmetic: at any fight zoom this covers the view
      // and it is one fill either way.
      ctx.fillRect(cam.x - VIEW_W, -VIEW_H, VIEW_W * 3, VIEW_H * 3);
      ctx.globalAlpha = 1;
    }

    const z = cam.zoom > 0.05 ? cam.zoom : 1;
    const ground = GROUND_Y + this.bossZ * Z_SCALE;

    // Where the boss actually is on screen, under whatever the camera is doing.
    const restX = (this.bossX - cam.x + cam.shakeX - VIEW_W * 0.5) * z + VIEW_W * 0.5;
    const restY = (ground + cam.shakeY - VIEW_H * 0.5) * z + VIEW_H * 0.5;

    const e = easeInOut(clamp(this.pushT, 0, 1));
    const sx = lerp(restX, FRAME_X, e);
    const sy = lerp(restY, FRAME_FEET, e);
    const k = lerp(z, this.kTarget, e);

    // Invert the camera so the framing lands on exact screen coordinates.
    const ux = (sx - VIEW_W * 0.5) / z + VIEW_W * 0.5 + cam.x - cam.shakeX;
    const uy = (sy - VIEW_H * 0.5) / z + VIEW_H * 0.5 - cam.shakeY;

    ctx.save();
    ctx.translate(ux, uy);
    ctx.scale(k / z, k / z);
    this.frameE = e;
    this.paintStage(ctx);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Everything in here is in rig-local units, origin at the boss's feet. */
  private paintStage(ctx: C2D): void {
    const boss = this.boss;
    if (!boss) return;
    const b = this.beat;
    // The act's own clock. It is pinned at 0 while the bars are still coming in
    // and at its end for the whole time the plate is up, so the boss is holding
    // a settled pose behind the words rather than mid-swing.
    const pf = this.stage === ST_POSE ? this.f : this.stage === ST_IN ? 0 : POSE_FRAMES;

    // Silhouette on the mark, not feet on the mark: a quadruped's feet are not
    // the middle of it. Faded in with the framing, so at rest the copy sits
    // exactly on top of the fighter it is standing in for.
    if (this.rcx !== 0) ctx.translate(this.rcx * this.frameE, 0);

    this.paintBacklight(ctx, pf);
    this.paintPool(ctx);

    if (b.prop === PROP_LIGHTS) this.paintLights(ctx, pf);
    if (b.prop === PROP_VENT) this.paintVent(ctx, pf);

    ctx.save();
    this.applyAct(ctx, pf);
    this.charOpts.alpha = this.rigA;
    this.bossOpts.alpha = this.rigA;
    if (this.useBossRig) {
      this.driveRig(pf);
      drawBossRig(ctx, this.rigKind, boss.style, 0, 0, FACE, this.bossOpts);
    } else {
      const pose = sampleClip(CLIPS[b.clip] ?? CLIPS['idle'], (this.clock + 40) * b.rate);
      this.tweakPose(pose, pf);
      drawCharacter(ctx, boss.style, pose, this.skeleton, 0, 0, FACE, this.charOpts);
    }
    ctx.restore();

    if (b.prop === PROP_SCREEN) this.paintScreen(ctx, pf);
    if (b.prop === PROP_ARC) this.paintArcs(ctx, pf);
    if (b.prop === PROP_GLINT) this.paintGlint(ctx, pf);

    this.paintDust(ctx);
    ctx.globalAlpha = 1;
  }

  /**
   * A bespoke rig is driven by a state name, not a pose, so the act becomes a
   * little state machine instead of a clip: idle until the wind-up, then the
   * generic anticipate-and-commit envelope, then a settled hold.
   *
   * Once the plate is up the hold is unconditional. Its idle is free-running
   * off the wall clock inside `BossRigs`, so a boss the player leaves on screen
   * for a minute is still breathing.
   */
  private driveRig(pf: number): void {
    const b = this.beat;
    const show = b.act === ACT_DOG || b.act === ACT_STAND;
    const o = this.bossOpts;

    if (this.stage === ST_CARD || this.stage === ST_OUT) {
      o.state = show ? 'victory' : 'idle';
      o.frame = this.clock;
      return;
    }

    const wind = b.at - 11;
    if (pf < wind) {
      o.state = 'idle';
      o.frame = pf;
    } else if (show) {
      o.state = 'victory';
      o.frame = pf - wind;
    } else if (pf < wind + 46) {
      o.state = 'attack';
      o.frame = pf - wind;
    } else {
      o.state = 'idle';
      o.frame = pf - wind - 46;
    }
  }

  // ── The stage the boss stands on ─────────────────────────────────────────

  private paintBacklight(ctx: C2D, pf: number): void {
    const pulse = 0.9 + 0.1 * Math.sin(this.clock * 0.05);
    const grow = easeOut(clamp(pf / 40, 0, 1));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.13 * pulse * this.veil;
    ellipse(ctx, 0, -this.bh * 0.5, this.bw * 2.6, this.bh * 0.78, 0, this.accent, NO, 0);
    ctx.globalAlpha = 0.09 * this.veil * grow;
    ellipse(ctx, 0, -this.bh * 0.55, this.bw * 1.3, this.bh * 0.5, 0, this.accent, NO, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private paintPool(ctx: C2D): void {
    ctx.globalAlpha = 0.5 * this.veil;
    ellipse(ctx, 0, 2, this.bw * 1.5, this.bw * 0.34, 0, '#02040a', NO, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.1 * this.veil;
    ellipse(ctx, 0, 1, this.bw * 2.1, this.bw * 0.46, 0, this.accent, NO, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ── Acts ─────────────────────────────────────────────────────────────────

  /**
   * The whole-body move. Everything here is a transform about the feet, which
   * is what lets one implementation drive a dwarf rig, a dog, a car and a
   * rocket without any of them knowing about it.
   */
  private applyAct(ctx: C2D, pf: number): void {
    const b = this.beat;
    const soft = this.reduced ? 0.45 : 1;
    let ox = 0;
    let oy = 0;
    let rot = 0;
    let kx = 1;
    let ky = 1;

    switch (b.act) {
      case ACT_DOG: {
        // Stretch: chest to the floor, rear in the air. Then the shake, which
        // is the thing everybody recognises a dog by.
        const st = envelope(pf, b.at - 12, 18, 4, 10);
        const sh = envelope(pf, b.at + 8, 4, 12, 8);
        rot = (-0.13 * st + Math.sin(pf * 1.55) * 0.11 * sh) * soft;
        ky = 1 - 0.13 * st * soft;
        kx = 1 + 0.1 * st * soft;
        ox = Math.sin(pf * 1.55) * 1.6 * sh * soft;
        oy = 1.5 * st * soft;
        break;
      }
      case ACT_CAR: {
        // Idles on its springs, then the rev drops the nose and lifts it.
        const rev = envelope(pf, b.at, 8, 6, 14);
        oy = (Math.sin(this.clock * 0.09) * 0.5 - 2.6 * rev) * soft;
        rot = -0.03 * rev * soft;
        ky = 1 + 0.04 * rev * soft;
        break;
      }
      case ACT_ROCKET: {
        const lean = easeInOut(clamp(pf / 60, 0, 1));
        rot = 0.028 * lean * soft;
        oy = Math.sin(this.clock * 0.035) * 0.8 * soft;
        break;
      }
      case ACT_MECH: {
        // One step. Up over twelve frames, down in four, and the floor knows.
        const up = clamp((pf - (b.at - 14)) / 14, 0, 1);
        const down = clamp((pf - b.at) / 5, 0, 1);
        const lift = easeOut(up) * (1 - easeIn(down));
        oy = -this.bh * 0.06 * lift * soft;
        ky = 1 - 0.05 * lift * soft + 0.06 * Math.max(0, 1 - Math.abs(pf - b.at) / 5) * soft;
        rot = 0.02 * lift * soft;
        break;
      }
      case ACT_DESK: {
        const shut = envelope(pf, b.at, 3, 30, 0);
        oy = Math.sin(this.clock * 0.05) * 0.5;
        rot = -0.02 * (1 - shut) * soft;
        break;
      }
      case ACT_ZAP: {
        const z = envelope(pf, b.at, 3, 6, 14);
        ox = Math.sin(pf * 2.3) * 1.4 * z * soft;
        rot = Math.sin(pf * 1.9) * 0.05 * z * soft;
        break;
      }
      default:
        oy = Math.sin(this.clock * 0.045) * 0.7;
        break;
    }

    if (ox !== 0 || oy !== 0) ctx.translate(ox, oy);
    if (rot !== 0) ctx.rotate(rot);
    if (kx !== 1 || ky !== 1) ctx.scale(kx, ky);
  }

  /**
   * The act's contribution to the pose, layered on top of the sampled clip.
   *
   * `sampleClip` hands back a fresh pose every call, so writing into it is safe
   * and the tweak objects themselves are reused rather than rebuilt.
   */
  private tweakPose(pose: Pose, pf: number): void {
    // Only ever reached on the `drawCharacter` path: a bespoke rig owns its own
    // anatomy and is driven through `driveRig` instead.
    const b = this.beat;

    switch (b.act) {
      case ACT_TIE: {
        // Both hands to the collar, chest out, chin down. Twice — the second
        // tug is shorter, which is what makes it read as a habit.
        const e = Math.max(
          envelope(pf, b.at - 10, 14, 4, 12),
          envelope(pf, b.at + 12, 5, 3, 9) * 0.7,
        );
        if (e <= 0.001) return;
        twArmLU.rot = 0.85 * e;
        twArmLL.rot = 1.55 * e;
        twArmRU.rot = 0.75 * e;
        twArmRL.rot = 1.45 * e;
        twChest.rot = 0.06 * e;
        twHead.rot = -0.05 * e;
        pose.armL_upper = twArmLU;
        pose.armL_lower = twArmLL;
        pose.armR_upper = twArmRU;
        pose.armR_lower = twArmRL;
        pose.chest = twChest;
        pose.head = twHead;
        break;
      }
      case ACT_DESK: {
        // Both hands on something lit, head down over it — then the lid comes
        // shut, the arms take the shock of it, and he looks up at you.
        const hold = easeOut(clamp(pf / 16, 0, 1));
        const snap = envelope(pf, b.at, 2, 3, 8);
        const up = easeOut(clamp((pf - b.at - 4) / 16, 0, 1));
        twArmLU.rot = 0.62 * hold + 0.18 * snap;
        twArmLL.rot = 1.02 * hold + 0.3 * snap;
        twArmRU.rot = 0.58 * hold + 0.16 * snap;
        twArmRL.rot = 0.98 * hold + 0.28 * snap;
        twHead.rot = -0.2 * hold * (1 - up);
        pose.armL_upper = twArmLU;
        pose.armL_lower = twArmLL;
        pose.armR_upper = twArmRU;
        pose.armR_lower = twArmRL;
        pose.head = twHead;
        break;
      }
      default:
        break;
    }
  }

  // ── Props ────────────────────────────────────────────────────────────────

  /** Two lamps and their cones, snapping on with a half-frame of hesitation. */
  private paintLights(ctx: C2D, pf: number): void {
    const on = (pf < this.beat.at
      ? 0
      : pf < this.beat.at + 5
        ? (pf & 1) === 0 ? 0.55 : 0.15
        : 0.9 + 0.1 * Math.sin(this.clock * 0.2)) * this.rigA;
    if (on <= 0.01) return;

    const dir = -1;
    // Out at the nose, at bumper height, where a wedge keeps its lamps.
    const lx = dir * this.bw * 0.92;
    const ly = -this.bh * 0.34;
    const reach = dir * this.bh * 3.2;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.14 * on * this.veil;
    quad(ctx, lx, ly - 3, lx + reach, ly - this.bh * 0.7,
      lx + reach, ly + this.bh * 0.8, lx, ly + 4, '#fff6dc');
    ctx.globalAlpha = 0.1 * on * this.veil;
    quad(ctx, lx, ly - 2, lx + reach * 1.4, ly - this.bh * 1.1,
      lx + reach * 1.4, ly + this.bh * 1.3, lx, ly + 3, '#ffe6b0');
    ctx.globalAlpha = 0.5 * on;
    ellipse(ctx, lx, ly - this.bh * 0.06, this.bw * 0.3, this.bw * 0.16, 0, '#fff6dc', NO, 0);
    ellipse(ctx, lx, ly + this.bh * 0.08, this.bw * 0.3, this.bw * 0.16, 0, '#fff6dc', NO, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Steam off the flanks and a fire that has not been asked for yet. */
  private paintVent(ctx: C2D, pf: number): void {
    const a = this.rigA;
    if (a <= 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const t = ((this.clock * 0.9 + i * 21) % 120) / 120;
      const side = i & 1 ? 1 : -1;
      ctx.globalAlpha = 0.16 * (1 - t) * this.veil * a;
      ellipse(
        ctx,
        side * this.bw * 0.9 + side * t * 14,
        -this.bh * 0.22 - t * this.bh * 0.7,
        4 + t * 13, 3 + t * 11, 0, '#cfe2ff', NO, 0,
      );
    }
    const burn = easeOut(clamp((pf - this.beat.at) / 14, 0, 1)) * a;
    if (burn > 0.01) {
      ctx.globalAlpha = 0.3 * burn;
      ellipse(ctx, 0, -2, this.bw * 1.3, this.bw * 0.5, 0, '#ff8a2a', NO, 0);
      ctx.globalAlpha = 0.35 * burn;
      ellipse(ctx, 0, -1, this.bw * 0.7, this.bw * 0.26, 0, '#ffe6a0', NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** A lit rectangle held in front of the face, until it is not. */
  private paintScreen(ctx: C2D, pf: number): void {
    const a = this.rigA;
    if (a <= 0.02) return;
    ctx.globalAlpha = a;
    const dir = -1;
    const shut = envelope(pf, this.beat.at, 3, 400, 0);
    const open = (1 - shut) * a;
    // Where the hands end up once ACT_DESK has swung the arms forward.
    const px = dir * this.bw * 0.78;
    const py = -this.bh * 0.55;
    const w = this.bw * 0.62;
    const h = this.bw * 0.42;

    // Base, then the lid folding down onto it.
    roundRect(ctx, px - w * 0.5, py, w, h * 0.28, 1, '#20262f', INK, 1.1);
    ctx.save();
    ctx.translate(px - dir * w * 0.5, py);
    ctx.rotate(dir * lerp(-1.28, -0.06, shut));
    roundRect(ctx, 0, -h * 0.22, dir * w, h * 0.9, 1, '#171c24', INK, 1.1);
    if (open > 0.02) {
      ctx.globalAlpha = open;
      roundRect(ctx, dir * w * 0.1, -h * 0.1, dir * w * 0.8, h * 0.66, 0.6, '#37e6c8', NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    if (open > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.2 * open * (0.85 + 0.15 * Math.sin(this.clock * 0.31));
      ellipse(ctx, px, py - h * 0.2, w * 1.9, h * 1.9, 0, '#37e6c8', NO, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /** Something in there is arcing to something else in there. */
  private paintArcs(ctx: C2D, pf: number): void {
    const e = envelope(pf, this.beat.at, 3, 8, 16) * this.rigA;
    if (e <= 0.02) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * e;
    const hy = -this.bh * 0.78;
    zigzag(ctx, -this.bw * 0.6, hy, this.bw * 0.6, hy - this.bh * 0.06,
      this.bh * 0.05, 6, this.accent, 1.3);
    zigzag(ctx, -this.bw * 0.35, hy - this.bh * 0.08, this.bw * 0.2, -this.bh * 0.5,
      this.bh * 0.04, 5, this.accent, 1.1);
    zigzag(ctx, this.bw * 0.5, -this.bh * 0.45, this.bw * 0.15, -this.bh * 0.62,
      this.bh * 0.035, 4, '#cfe2ff', 1);
    ctx.globalAlpha = prev;
  }

  /** One hard specular hit on the silhouette. Cheap, and it lands. */
  private paintGlint(ctx: C2D, pf: number): void {
    const e = envelope(pf, this.beat.at, 2, 3, 16) * this.rigA;
    if (e <= 0.02) return;
    const gx = -this.bw * 0.34;
    const gy = -this.bh * 0.8;
    const r = this.bh * 0.1 * (0.6 + 0.4 * e);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = e * 0.9;
    star(ctx, gx, gy, r, 4, PAPER, NO);
    ctx.globalAlpha = e * 0.35;
    ellipse(ctx, gx, gy, r * 2.4, r * 2.4, 0, this.accent, NO, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Dust off the floor. Drawn rather than emitted: the caller has frozen the
   * fight and may well have frozen the particle system with it.
   */
  private paintDust(ctx: C2D): void {
    if (this.dustAt < 0) return;
    // Against the intro's own clock, not the beat's, so a press that jumps to
    // the plate does not leave a puff of dust hanging there for ever.
    const age = this.clock - this.dustAt;
    if (age < 0 || age > 46) return;
    const t = age / 46;
    const rise = easeOut(t);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < DUST_N; i++) {
      const dir = this.dustA[i];
      const x = dir * this.bw * (0.5 + this.dustV[i] * 1.5) * rise;
      const y = -rise * this.bh * 0.14 * this.dustV[i] - 1;
      ctx.globalAlpha = 0.2 * (1 - t) * this.veil;
      ellipse(ctx, x, y, this.dustR[i] * (0.6 + rise * 1.5),
        this.dustR[i] * (0.4 + rise * 0.9), 0, '#8f8577', NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Screen layer: the dip, the bars, the plate, the prompt, the flash
  // ─────────────────────────────────────────────────────────────────────────

  renderOverlay(ctx: C2D): void {
    if (!this.active) return;

    // A short dip to black on the way in, so the arrival reads as a cut rather
    // than as something fading up over a fight.
    if (this.stage === ST_IN) {
      const dip = 1 - easeOut(clamp(this.f / 9, 0, 1));
      if (dip > 0.004) {
        ctx.globalAlpha = dip * 0.85;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.globalAlpha = 1;
      }
    }

    if (this.stage === ST_CARD || this.stage === ST_OUT) this.paintPlate(ctx);

    this.paintBars(ctx);

    if (this.flashA > 0.006) {
      ctx.globalAlpha = clamp(this.flashA, 0, 1);
      ctx.fillStyle = this.flashC;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
  }

  private paintBars(ctx: C2D): void {
    const inT = easeOut(clamp(this.clock / BAR_IN, 0, 1));
    const outT = this.stage === ST_OUT ? easeIn(clamp(this.f / BAR_OUT, 0, 1)) : 0;
    const h = BAR_H * inT * (1 - outT);
    if (h <= 0.4) return;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, VIEW_W, h);
    ctx.fillRect(0, VIEW_H - h, VIEW_W, h);
  }

  // ── The plate ────────────────────────────────────────────────────────────

  private paintPlate(ctx: C2D): void {
    if (!this.laidOut) this.layout(ctx);
    const boss = this.boss;
    if (!boss) return;

    const f = this.f;
    const out = this.stage === ST_OUT ? easeIn(clamp(this.f / (OUT_FRAMES * 0.6), 0, 1)) : 0;
    const fade = 1 - out;
    if (fade <= 0.01) return;

    // Ground for the words. Opaque at the margin, gone by the boss.
    const wipe = easeOut(clamp(f / CARD_PLATE, 0, 1));
    if (!this.plateGrad) {
      const g = ctx.createLinearGradient(0, 0, PLATE_W, 0);
      g.addColorStop(0, 'rgba(4,5,10,0.94)');
      g.addColorStop(0.55, 'rgba(4,5,10,0.8)');
      g.addColorStop(1, 'rgba(4,5,10,0)');
      this.plateGrad = g;
    }
    ctx.globalAlpha = wipe * fade;
    ctx.fillStyle = this.plateGrad;
    ctx.fillRect(0, BAR_H, PLATE_W * wipe, VIEW_H - BAR_H * 2);
    ctx.globalAlpha = 1;

    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';

    this.paintName(ctx, f, fade);
    this.paintRule(ctx, f, fade);
    this.paintQuote(ctx, f, fade);
    this.paintBlurb(ctx, f, fade);
    if (f >= this.revealEnd && this.stage === ST_CARD) this.paintPrompt(ctx, fade);

    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** The slam. Comes in from the left, overshoots once, and stops dead. */
  private paintName(ctx: C2D, f: number, fade: number): void {
    const k = clamp((f - CARD_NAME) / 14, 0, 1);
    if (k <= 0) return;
    const pop = easeOutBack(k);
    const slideFrom = this.reduced ? -40 : -170;
    const x = COL_X + lerp(slideFrom, 0, pop);
    const s = this.reduced ? 1 : lerp(1.5, 1, pop);
    const a = easeOut(clamp(k * 2.6, 0, 1)) * fade;

    ctx.save();
    ctx.translate(x, this.yName);
    ctx.scale(s, s);
    ctx.globalAlpha = a;
    ctx.font = fontOf(DISPLAY_FONT, this.nameSize);
    ctx.lineWidth = Math.max(4, this.nameSize * 0.3);
    ctx.strokeStyle = INK;
    ctx.strokeText(this.nameHead, 0, 0);
    ctx.fillStyle = '#8a0f2e';
    ctx.fillText(this.nameHead, 0, 2);
    ctx.fillStyle = PAPER;
    ctx.fillText(this.nameHead, 0, 0);
    ctx.restore();

    if (this.tailLines.length === 0) return;
    const tk = clamp((f - CARD_TAIL) / 12, 0, 1);
    if (tk <= 0) return;
    ctx.globalAlpha = easeOut(tk) * fade;
    ctx.font = fontOf(SANS_FONT, this.tailSize);
    ctx.fillStyle = GOLD;
    for (let i = 0; i < this.tailLines.length; i++) {
      ctx.fillText(this.tailLines[i], COL_X + 2, this.yTail + i * (this.tailSize + 2));
    }
    ctx.globalAlpha = 1;
  }

  private paintRule(ctx: C2D, f: number, fade: number): void {
    const k = easeOut(clamp((f - CARD_RULE) / 12, 0, 1));
    if (k <= 0.01) return;
    ctx.globalAlpha = fade;
    capsule(ctx, COL_X, this.yRule, COL_X + COL_W * 0.62 * k, this.yRule, 1.4, this.accent, NO, 0);
    ctx.globalAlpha = 0.5 * fade;
    capsule(ctx, COL_X, this.yRule + 3, COL_X + COL_W * 0.3 * k, this.yRule + 3, 0.7, GOLD, NO, 0);
    ctx.globalAlpha = 1;
  }

  private paintQuote(ctx: C2D, f: number, fade: number): void {
    if (this.quoteLines.length === 0) return;
    ctx.font = fontOf(SANS_ITALIC, this.quoteSize);
    const lh = this.quoteSize + 3;
    for (let i = 0; i < this.quoteLines.length; i++) {
      const k = clamp((f - CARD_QUOTE - i * 3) / 12, 0, 1);
      if (k <= 0) break;
      const y = this.yQuote + i * lh;
      ctx.globalAlpha = easeOut(k) * fade * 0.8;
      ctx.fillStyle = '#05070c';
      ctx.fillText(this.quoteLines[i], COL_X + 1, y + 1);
      ctx.globalAlpha = easeOut(k) * fade;
      ctx.fillStyle = GOLD;
      ctx.fillText(this.quoteLines[i], COL_X, y);
    }
    ctx.globalAlpha = 1;
  }

  private paintBlurb(ctx: C2D, f: number, fade: number): void {
    if (this.blurb.length === 0) return;
    ctx.font = fontOf(SANS_FONT, this.blurbSize);
    ctx.fillStyle = DIM;
    const lh = this.blurbSize + 3.5;
    for (let i = 0; i < this.blurb.length; i++) {
      const line = this.blurb[i];
      if (line.length === 0) continue;
      const k = clamp((f - CARD_BLURB - i * BLURB_STEP) / BLURB_FADE, 0, 1);
      if (k <= 0) break;
      ctx.globalAlpha = easeOut(k) * fade * 0.92;
      ctx.fillText(line, COL_X, this.yBlurb + i * lh);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The affordance. Nothing else on screen is moving by now, so it has to be
   * unmistakably an invitation: a label that says what to do and a chevron that
   * bobs. Same words and the same shape as the opening cinematic's, because a
   * game that asks for a keypress two different ways has taught nobody
   * anything. Reduced motion keeps the blink and drops the bob.
   */
  private paintPrompt(ctx: C2D, fade: number): void {
    const t = this.clock * 0.06;
    const blink = 0.55 + 0.45 * Math.sin(t);
    const bob = this.reduced ? 0 : Math.sin(t) * 1.6;
    const a = fade * (0.42 + 0.58 * blink);

    ctx.globalAlpha = a;
    ctx.font = fontOf(SANS_FONT, 7);
    ctx.fillStyle = DIM;
    ctx.fillText('PRESS ANY KEY', COL_X + 14, this.yPrompt);

    // Drawn rather than typed: a glyph that falls back to a box on one machine
    // in twenty is not an affordance.
    quad(ctx, COL_X, this.yPrompt - 6 + bob, COL_X + 9, this.yPrompt - 6 + bob,
      COL_X + 4.5, this.yPrompt + bob, COL_X + 4.5, this.yPrompt + bob, GOLD, INK, 1.1);

    ctx.globalAlpha = fade * 0.3;
    ctx.font = fontOf(SANS_FONT, 6);
    ctx.fillStyle = FAINT;
    ctx.fillText('TO FIGHT', COL_X + 14, this.yPrompt + 10);
    ctx.globalAlpha = 1;
  }

  // ── Layout, once per boss ────────────────────────────────────────────────

  /**
   * Measures and stacks the plate. Runs on the first frame the plate is
   * painted and never again: everything it produces is a number or a string
   * that the draw path only reads.
   */
  private layout(ctx: C2D): void {
    this.laidOut = true;
    const boss = this.boss;
    if (!boss) return;

    // Some names carry a job title after a comma ("CRUNCH, MUSK'S PRINCIPAL
    // ENGINEER"); others are just a name ("SHIBA INU"). Split on the comma when
    // there is one, because a whole job description at title size is a
    // paragraph rather than a title — and fall through cleanly when there is not.
    const full = boss.name;
    const comma = full.indexOf(',');
    this.nameHead = comma > 0 ? full.slice(0, comma) : full;
    this.nameTail = comma > 0 ? full.slice(comma + 1).trim() : '';

    // Fit the headline to the column with one measurement.
    ctx.font = fontOf(DISPLAY_FONT, 30);
    const w30 = Math.max(1, ctx.measureText(this.nameHead).width);
    this.nameSize = clamp(Math.floor(30 * (COL_W / w30)), 13, 30);

    this.tailSize = 9;
    this.tailLines.length = 0;
    if (this.nameTail.length > 0) {
      ctx.font = fontOf(SANS_FONT, this.tailSize);
      wrapInto(ctx, this.nameTail, COL_W, this.tailLines, 2);
    }

    this.quoteSize = 9;
    this.quoteLines.length = 0;
    if (boss.quote.length > 0) {
      ctx.font = fontOf(SANS_ITALIC, this.quoteSize);
      wrapInto(ctx, boss.quote, COL_W, this.quoteLines, 5);
    }

    // The story lines are already authored to a line length; only shrink if a
    // particular boss's happen to run long.
    this.blurbSize = 7;
    if (this.blurb.length > 0) {
      ctx.font = fontOf(SANS_FONT, 7);
      let widest = 1;
      for (const l of this.blurb) widest = Math.max(widest, ctx.measureText(l).width);
      if (widest > COL_W) this.blurbSize = clamp(Math.floor(7 * (COL_W / widest)), 6, 7);
    }

    // Stack it, then centre the block between the bars.
    const tailH = this.tailLines.length > 0 ? this.tailLines.length * (this.tailSize + 2) + 6 : 0;
    const quoteH = this.quoteLines.length * (this.quoteSize + 3);
    const blurbH = this.blurb.length * (this.blurbSize + 3.5);
    const promptH = 26;
    const total = this.nameSize + tailH + 12 + quoteH + (quoteH > 0 ? 14 : 0)
      + blurbH + (blurbH > 0 ? 14 : 0) + promptH;

    // A block taller than the band is pinned to the top rather than clamped
    // upside down; nothing in content/ is that long, but nothing in content/
    // has to stay that way either.
    const lo = BAR_H + 16;
    const hi = Math.max(lo, VIEW_H - BAR_H - total - 8);
    const top = clamp((VIEW_H - total) * 0.5, lo, hi);
    let y = top + this.nameSize;
    this.yName = y;
    y += 6;
    this.yTail = y + this.tailSize;
    y += tailH;
    this.yRule = y + 4;
    y += 12;
    this.yQuote = y + this.quoteSize;
    y += quoteH + (quoteH > 0 ? 14 : 0);
    this.yBlurb = y + this.blurbSize;
    y += blurbH + (blurbH > 0 ? 14 : 0);
    this.yPrompt = Math.min(y + 12, VIEW_H - BAR_H - 22);

    // The last frame on which anything is still arriving. After it the plate
    // has no clock at all — which is the entire point of this class.
    const qEnd = this.quoteLines.length > 0
      ? CARD_QUOTE + (this.quoteLines.length - 1) * 3 + 12
      : CARD_RULE + 12;
    const bEnd = this.blurb.length > 0
      ? CARD_BLURB + (this.blurb.length - 1) * BLURB_STEP + BLURB_FADE
      : 0;
    this.revealEnd = Math.max(CARD_LOCK, qEnd, bEnd);
  }
}

/**
 * Greedy word wrap into a caller-owned array. Called once per boss from
 * `layout`, never from a draw path.
 */
function wrapInto(
  ctx: C2D, text: string, maxW: number, out: string[], cap: number,
): void {
  out.length = 0;
  const words = text.split(' ');
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length === 0) continue;
    const cand = line.length === 0 ? word : `${line} ${word}`;
    if (line.length > 0 && ctx.measureText(cand).width > maxW) {
      out.push(line);
      if (out.length >= cap) return;
      line = word;
    } else {
      line = cand;
    }
  }
  if (line.length > 0 && out.length < cap) out.push(line);
}
