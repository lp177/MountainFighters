/**
 * The opening cinematic — eight shots, once, before map one.
 *
 * There are no images and no audio files in this repository, so the whole thing
 * is vector geometry and existing SfxCues: a cottage built from four rectangles
 * and a triangle, headlight cones that are two additive quads each, and the same
 * `drawCharacter` rig the fight uses, so the men who kick the door in here are
 * the men you punch in map one.
 *
 * The running order lives in `content/story.ts` as a table. This file walks it.
 * Each shot owns its length, its entry transition and its camera move; the only
 * per-shot code here is the painting, which is the one thing that genuinely
 * cannot be data. The note shot is the exception that proves the table works:
 * its length is `0`, meaning "measure INTRO_TEXT and size the shot to it", so
 * editing the crawl can never silently truncate the reveal.
 *
 * Presentation only. No sim, no netcode, no determinism contract — but the
 * randomness is hashed off indices rather than Math.random all the same, because
 * a scripted cinematic that is subtly different every time you watch it is a bug
 * wearing a hat.
 */

import type { NotePage, StoryShot, StoryShotId } from '@/content/story';
import type { AnimClip, Pose, RigStyle, Scene, SfxCue } from '@/core/types';
import type { SceneHost } from '@/scenes/FightScene';

import { GROUND_Y, VIEW_H, VIEW_W } from '@/core/constants';
import { TAU, clamp, easeIn, easeInOut, easeOut, easeOutBack, lerp } from '@/core/math';

import { STORYBOARD, TITLE_LINES, TITLE_SUB, paginateIntro } from '@/content/story';
import { DWARFS } from '@/content/dwarfs';
import { ENEMIES } from '@/content/enemies';
import { BOSSES } from '@/content/bosses';

import { CLIPS, blendPose, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON, HUMAN_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { capsule, ellipse, poly, roundRect, star, zigzag } from '@/render/Shapes';
import { Camera } from '@/render/Camera';
import { ParticleSystem } from '@/juice/Particles';
import { GamepadSource, connectedGamepads } from '@/engine/input/GamepadSource';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export interface CutsceneOpts {
  /** Called exactly once, when the cinematic ends or is skipped. */
  onDone?: () => void;
  /** Default true. False only for a "watch it again" viewing that must finish. */
  skippable?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Look
// ─────────────────────────────────────────────────────────────────────────────

const INK = '#141019';
const NO = 'none';

const PAPER = '#e8ecf6';
const GOLD = '#ffd23f';
const DIM = '#98a2b6';
const FAINT = '#5c6474';
const BLOOD = '#ff2e6e';

/** Warm side of the film: the forest, the windows, the fire, the leather. */
const WARM = '#ffb347';
const WARM_HOT = '#ffd9a0';
const WOOD = '#4a3527';
const WOOD_DARK = '#2f2016';

/** Cold side: the lab, the moonlight, the thing on the gurney. */
const STEEL = '#c9d2dc';
const CLINIC = '#eaf4ff';
const CYAN = '#37e6c8';
const MOON = '#93b8e8';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

/** Height of each letterbox bar once it has finished sliding in. */
const BAR_H = 30;
const BAR_IN = 26;
/** Frames of bar retraction at the very end, overlapping the outro fade. */
const BAR_OUT = 46;

const FADE_IN = 30;
const FADE_OUT = 24;

/** Frames before any input is allowed to skip — the keypress that started the
 *  cinematic must not also end it. */
const SKIP_LOCK = 24;
const HINT_AT = 132;
const HINT_FADE = 40;

// ── The note ────────────────────────────────────────────────────────────────

const NOTE_MAX_LINES = 8;
const NOTE_LH = 15;
const NOTE_MID = 158;
/** Typewriter speed. Fast, because there are eleven hundred characters of it. */
const CHARS_PER_FRAME = 2.4;
const PAGE_IN = 12;
const PAGE_HOLD = 34;
const PAGE_OUT = 16;
const NOTE_TAIL = 20;

// ── Shot 7's transformation schedule ────────────────────────────────────────
//
// The same tween the select screen runs, against the same authored clip lengths
// and the same rig thresholds: the jacket phase stops dead at 0.42, which is
// exactly where CharacterRig starts sliding the shades down, so nothing arrives
// before the animation that puts it there. The lead-in is shorter here — the
// select screen has time for the wholesomeness, a cinematic does not.

const D_JACKET = 24;
const D_SHADES = D_JACKET + 56;
const D_POSE = D_SHADES + 44;
const D_SNAP = 27;
const D_GLINT = 30;
/** Frames between one dwarf's leather landing and the next one's. */
const D_STAGGER = 7;

function outfitAt(f: number): number {
  if (f < D_JACKET) return 0;
  if (f < D_SHADES) {
    const l = f - D_JACKET;
    return 0.1 * easeInOut(clamp(l / 14, 0, 1)) + 0.32 * easeOut(clamp((l - 14) / 16, 0, 1));
  }
  if (f < D_POSE) {
    return 0.42 + 0.44 * easeInOut(clamp((f - D_SHADES - 8) / 26, 0, 1));
  }
  return 0.86 + 0.14 * easeOut(clamp((f - D_POSE) / 22, 0, 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch geometry
//
// Nothing in the draw path allocates an array. Every polygon in this file is
// written into one of these and consumed by `poly` before the next call can
// clobber it.
// ─────────────────────────────────────────────────────────────────────────────

const P6 = new Array<number>(6).fill(0);
const P8 = new Array<number>(8).fill(0);
const P10 = new Array<number>(10).fill(0);
const P22 = new Array<number>(22).fill(0);

function tri(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  fill: string, outline: string = INK, ow = 2,
): void {
  P6[0] = ax; P6[1] = ay; P6[2] = bx; P6[3] = by; P6[4] = cx; P6[5] = cy;
  poly(ctx, P6, fill, outline, ow);
}

function quad(
  ctx: C2D,
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
  fill: string, outline: string = INK, ow = 2,
): void {
  P8[0] = ax; P8[1] = ay; P8[2] = bx; P8[3] = by;
  P8[4] = cx; P8[5] = cy; P8[6] = dx; P8[7] = dy;
  poly(ctx, P8, fill, outline, ow);
}

/** Stable value hash. Layout is a function of the index, never of the clock. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function hrange(n: number, a: number, b: number): number {
  return a + hash(n) * (b - a);
}

/** Fir silhouette: one path, three tiers, no trunk. Forests are made of these. */
const FIR_T = [0, 0.3, 0.3, 0.62, 0.62, 1];
const FIR_X = [0, 0.44, 0.24, 0.76, 0.44, 1];

function fir(
  ctx: C2D, x: number, base: number, h: number, w: number,
  fill: string, outline: string = NO, ow = 0,
): void {
  let k = 0;
  for (let i = 0; i < 6; i++) {
    P22[k++] = x + FIR_X[i] * w;
    P22[k++] = base - h + FIR_T[i] * h;
  }
  for (let i = 5; i >= 1; i--) {
    P22[k++] = x - FIR_X[i] * w;
    P22[k++] = base - h + FIR_T[i] * h;
  }
  poly(ctx, P22, fill, outline, ow);
}

function setFont(ctx: C2D, size: number, weight: number, display: boolean, italic = false): void {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${display ? DISPLAY : SANS}`;
}

function clipOf(name: string): AnimClip {
  return CLIPS[name] ?? CLIPS['idle'];
}

/** Screen y -> particle y. Particles project as GROUND_Y + z * Z_SCALE - y. */
function py(screenY: number): number {
  return GROUND_Y - screenY;
}

// ─────────────────────────────────────────────────────────────────────────────

export class CutsceneScene implements Scene {
  readonly name = 'cutscene';

  private readonly host: SceneHost;
  private opts: CutsceneOpts;

  /** Shake and the value-noise rumble only. Pan and zoom are the shot's job. */
  private readonly cam = new Camera();
  private readonly particles = new ParticleSystem();

  private frame = 0;
  private shotIndex = 0;
  private shotFrame = 0;
  private done = false;
  private skippable = true;
  private reduced = false;

  /** Resolved shot lengths. Everything but the note comes straight off the table. */
  private readonly lengths: number[] = [];
  private total = 0;

  /** Alpha the block currently being painted is composited at. */
  private a = 1;
  private punch = 0;
  private abr = 0;
  private flashA = 0;
  private flashC = '#ffffff';

  // The note.
  private pages: NotePage[] = [];
  private pageAt = new Int32Array(0);
  private pageType = new Int32Array(0);
  private pageW = new Float32Array(0);
  private livePage = -1;
  private typed = 0;
  /** Measured from INTRO_TEXT in enter(), never guessed. */
  private noteFrames = 600;

  // Cast. Built once in enter() so content/ is never mutated and the draw path
  // never allocates a style object.
  private suitStyle: RigStyle;
  private muskStyle: RigStyle;
  private readonly dwarfStyles: RigStyle[] = [];

  // Cached gradients. Created against the renderer's one long-lived context.
  private gDusk: CanvasGradient | null = null;
  private gNight: CanvasGradient | null = null;
  private gLab: CanvasGradient | null = null;
  private gRoom: CanvasGradient | null = null;

  // Skip.
  private pads: GamepadSource[] = [];
  private padPrev = 0;
  private padScan = 0;

  constructor(host: SceneHost, opts?: CutsceneOpts) {
    this.host = host;
    this.opts = opts ?? {};
    this.suitStyle = { ...ENEMIES.suit_guard.style };
    this.muskStyle = { ...(BOSSES.find((b) => b.id === 'musk')?.style ?? ENEMIES.lobbyist.style) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    if (params && typeof params === 'object') {
      const p = params as CutsceneOpts;
      if (typeof p.onDone === 'function' || typeof p.skippable === 'boolean') this.opts = p;
    }

    this.frame = 0;
    this.shotIndex = 0;
    this.shotFrame = 0;
    this.done = false;
    this.a = 1;
    this.punch = 0;
    this.abr = 0;
    this.flashA = 0;
    this.livePage = -1;
    this.typed = 0;
    this.particles.clear();

    this.skippable = this.opts.skippable !== false;
    this.reduced = this.host.save.settings.reducedMotion === true;

    this.buildNote();
    this.buildTimeline();

    this.dwarfStyles.length = 0;
    for (const d of DWARFS) this.dwarfStyles.push({ ...d.style, outfit: 0, shades: false });

    this.gDusk = null;
    this.gNight = null;
    this.gLab = null;
    this.gRoom = null;

    // A cinematic that inherits a fight's hitstop opens on a frozen frame.
    this.host.loop.timeScale = 1;
    this.host.loop.hitstop = 0;
    this.host.audio.music('cutscene');

    window.addEventListener('pointerdown', this.onPointer);
    this.refreshPads();
  }

  exit(): void {
    window.removeEventListener('pointerdown', this.onPointer);
    for (const p of this.pads) p.dispose?.();
    this.pads.length = 0;
    this.particles.clear();
    this.host.loop.hitstop = 0;
    this.host.loop.timeScale = 1;
  }

  onKey(e: KeyboardEvent): void {
    // Anything at all gets you out — except a browser chord, because losing
    // Ctrl+R or Cmd+Shift+I to a cutscene is its own kind of trapped.
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    this.skip();
  }

  private readonly onPointer = (): void => {
    this.skip();
  };

  // ── Timeline ───────────────────────────────────────────────────────────────

  /**
   * Pages INTRO_TEXT and works out how long the note shot has to be to deliver
   * every character of it. Done once, here, so nothing downstream ever has to
   * guess: `lengths[note]` is measured, not assumed.
   */
  private buildNote(): void {
    this.pages = paginateIntro(NOTE_MAX_LINES);
    const n = this.pages.length;
    this.pageAt = new Int32Array(n);
    this.pageType = new Int32Array(n);
    this.pageW = new Float32Array(n);

    let at = 0;
    for (let i = 0; i < n; i++) {
      const type = Math.ceil(this.pages[i].chars / CHARS_PER_FRAME);
      this.pageAt[i] = at;
      this.pageType[i] = type;
      this.pageW[i] = -1;
      at += PAGE_IN + type + PAGE_HOLD + PAGE_OUT;
    }
    this.noteFrames = at + NOTE_TAIL;
  }

  private buildTimeline(): void {
    this.lengths.length = 0;
    this.total = 0;
    for (const s of STORYBOARD) {
      const n = s.frames > 0 ? s.frames : s.id === 'note' ? this.noteFrames : 120;
      this.lengths.push(n);
      this.total += n;
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(_dt: number): void {
    if (this.done) return;

    this.frame++;
    this.shotFrame++;

    // Advance the edit. A shot never runs short: the entry transition of the
    // next one plays over the top of it rather than eating into it.
    while (this.shotIndex < STORYBOARD.length - 1 && this.shotFrame >= this.lengths[this.shotIndex]) {
      this.shotFrame -= this.lengths[this.shotIndex];
      this.shotIndex++;
      this.livePage = -1;
      this.typed = 0;
    }

    this.beats(STORYBOARD[this.shotIndex].id, this.shotFrame, this.lengths[this.shotIndex]);

    this.particles.update();
    this.cam.update();
    this.punch *= 0.87;
    if (Math.abs(this.punch) < 0.0005) this.punch = 0;
    this.abr *= 0.84;
    if (this.abr < 0.01) this.abr = 0;
    this.flashA *= 0.82;
    if (this.flashA < 0.005) this.flashA = 0;

    this.pollSkip();

    if (this.frame >= this.total) this.finish();
  }

  render(_alpha: number): void {
    const r = this.host.renderer;
    const ctx = r.ctx;

    r.begin();
    r.clear('#000000');
    this.ensureGradients(ctx);

    this.renderEdit(ctx);

    // Order matters: the flash belongs to the picture, the bars sit on top of
    // the picture, and the fade takes the whole frame including the bars.
    this.a = 1;
    ctx.globalAlpha = 1;
    this.flash(ctx);
    this.chrome(ctx);
    this.fade(ctx);

    r.end();

    if (this.abr > 0.01 && !this.reduced) r.aberration(clamp(this.abr, 0, 1));
  }

  /** Walks the current cut, running the outgoing shot underneath when it dissolves. */
  private renderEdit(ctx: C2D): void {
    const i = this.shotIndex;
    const shot = STORYBOARD[i];
    const e = this.shotFrame;
    const ef = shot.entryFrames;

    if (i > 0 && ef > 0 && e < ef && shot.entry !== 'cut') {
      const prevLocal = this.lengths[i - 1] + e;
      if (shot.entry === 'fade') {
        // Cross-dissolve. The outgoing shot keeps its own clock and its own
        // camera, so the smoke keeps rising and the cars keep rolling under it.
        this.paintShot(ctx, i - 1, prevLocal, 1, true);
        this.paintShot(ctx, i, e, e / ef, false);
      } else {
        const half = ef * 0.5;
        if (e < half) this.paintShot(ctx, i - 1, prevLocal, 1 - e / half, true);
        else this.paintShot(ctx, i, e, (e - half) / half, true);
      }
      return;
    }

    this.paintShot(ctx, i, e, 1, true);
  }

  private paintShot(
    ctx: C2D, index: number, local: number, alpha: number, withParticles: boolean,
  ): void {
    const a = clamp(alpha, 0, 1);
    if (a <= 0.003) return;
    const shot = STORYBOARD[index];
    const n = this.lengths[index];
    this.a = a;

    ctx.save();
    this.applyCam(ctx, shot, local, n);
    ctx.globalAlpha = a;
    this.paintWorld(shot.id, local, n);
    if (withParticles) this.particles.render(ctx, this.cam);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = a;
    this.paintOverlay(shot.id, local, n);
    ctx.restore();

    this.a = 1;
    ctx.globalAlpha = 1;
  }

  private applyCam(ctx: C2D, shot: StoryShot, local: number, n: number): void {
    const t = easeInOut(clamp(local / Math.max(1, n), 0, 1));
    // Reduced motion keeps the move — a still frame for thirty seconds is worse
    // — but takes most of the amplitude out of it.
    const k = this.reduced ? 0.45 : 1;
    const c = shot.cam;
    const x = lerp(c.x0, c.x1, t) * k;
    const y = lerp(c.y0, c.y1, t) * k;
    const z = 1 + (lerp(c.z0, c.z1, t) - 1) * k + this.punch;

    ctx.translate(VIEW_W * 0.5, VIEW_H * 0.5);
    ctx.scale(z, z);
    ctx.translate(-VIEW_W * 0.5, -VIEW_H * 0.5);
    ctx.translate(-x + this.cam.shakeX, -y + this.cam.shakeY);
  }

  private paintWorld(id: StoryShotId, f: number, n: number): void {
    const ctx = this.host.renderer.ctx;
    switch (id) {
      case 'cottage': this.shotCottage(ctx, f, n); break;
      case 'headlights': this.shotHeadlights(ctx, f, n); break;
      case 'door': this.shotDoor(ctx, f, n); break;
      case 'taken': this.shotTaken(ctx, f, n); break;
      case 'lab': this.shotLab(ctx, f, n); break;
      case 'note': this.shotRoom(ctx, f, n); break;
      case 'suiting': this.shotSuiting(ctx, f, n); break;
      case 'title': this.shotTitleBed(ctx, f, n); break;
      default: break;
    }
  }

  private paintOverlay(id: StoryShotId, f: number, n: number): void {
    const ctx = this.host.renderer.ctx;
    if (id === 'note') this.noteText(ctx, f);
    else if (id === 'title') this.titleCard(ctx, f, n);
  }

  // ── Audio and juice beats ──────────────────────────────────────────────────

  private sfx(cue: SfxCue, gain: number, pitch = 1): void {
    this.host.audio.play(cue, { gain, pitch });
  }

  private shake(mag: number, frames = 14): void {
    if (this.reduced) return;
    this.cam.addShake({
      magnitude: mag * clamp(this.host.save.settings.screenShake, 0, 2),
      duration: frames,
    });
  }

  private kick(punch: number, flash: number, color: string, abr = 0): void {
    if (this.reduced) {
      // Reduced motion still gets a beat, just a quiet one: no zoom, no
      // aberration, and a flash well under the threshold that makes people ill.
      this.flashA = Math.max(this.flashA, flash * 0.22);
      this.flashC = color;
      return;
    }
    this.punch += punch;
    this.flashA = Math.max(this.flashA, flash);
    this.flashC = color;
    this.abr = Math.max(this.abr, abr);
  }

  private beats(id: StoryShotId, f: number, n: number): void {
    switch (id) {
      case 'headlights': this.beatsHeadlights(f); break;
      case 'door': this.beatsDoor(f); break;
      case 'taken': this.beatsTaken(f, n); break;
      case 'lab': this.beatsLab(f); break;
      case 'note': this.beatsNote(f); break;
      case 'suiting': this.beatsSuiting(f, n); break;
      case 'title': this.beatsTitle(f, n); break;
      default: break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. THE COTTAGE
  // ─────────────────────────────────────────────────────────────────────────

  private ensureGradients(ctx: C2D): void {
    if (this.gDusk) return;
    const dusk = ctx.createLinearGradient(0, -40, 0, 300);
    dusk.addColorStop(0, '#0a1220');
    dusk.addColorStop(0.44, '#1d2138');
    dusk.addColorStop(0.74, '#5c3a35');
    dusk.addColorStop(1, '#c8783a');
    this.gDusk = dusk;

    const night = ctx.createLinearGradient(0, -40, 0, 300);
    night.addColorStop(0, '#05070e');
    night.addColorStop(0.55, '#0b1020');
    night.addColorStop(1, '#171a2c');
    this.gNight = night;

    const lab = ctx.createLinearGradient(0, -40, 0, 360);
    lab.addColorStop(0, '#050a11');
    lab.addColorStop(0.5, '#0b1622');
    lab.addColorStop(1, '#101d2a');
    this.gLab = lab;

    const room = ctx.createLinearGradient(0, -40, 0, 360);
    room.addColorStop(0, '#06080f');
    room.addColorStop(0.6, '#0d1018');
    room.addColorStop(1, '#141220');
    this.gRoom = room;
  }

  /** Full-bleed with overscan, so a push-in never finds the edge of the world. */
  private bleed(ctx: C2D, paint: string | CanvasGradient): void {
    ctx.fillStyle = paint;
    ctx.fillRect(-90, -60, VIEW_W + 180, VIEW_H + 120);
  }

  private alpha(ctx: C2D, v: number): void {
    ctx.globalAlpha = this.a * v;
  }

  private band(
    ctx: C2D, seed: number, count: number, x0: number, x1: number,
    base: number, hMin: number, hMax: number, w: number, fill: string,
  ): void {
    for (let i = 0; i < count; i++) {
      const x = lerp(x0, x1, (i + hrange(seed + i * 3.13, 0.15, 0.85)) / count);
      const h = hrange(seed + i * 7.71, hMin, hMax);
      fir(ctx, x, base + hrange(seed + i * 11.3, -4, 4), h, h * w, fill);
    }
  }

  private shotCottage(ctx: C2D, f: number, n: number): void {
    this.bleed(ctx, this.gDusk ?? '#101828');

    // The last of the sun, behind the trees on the left.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.3);
    ellipse(ctx, 96, 244, 150, 62, 0, '#c8702a', NO, 0);
    this.alpha(ctx, 0.35);
    ellipse(ctx, 96, 246, 44, 20, 0, '#ffb347', NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;

    this.band(ctx, 11, 22, -70, 720, 240, 46, 84, 0.34, '#111d22');
    this.band(ctx, 47, 15, -70, 720, 254, 74, 128, 0.32, '#0c171a');

    // Ground.
    ctx.fillStyle = '#0d1512';
    ctx.fillRect(-90, 250, VIEW_W + 180, VIEW_H - 190);
    this.alpha(ctx, 0.5);
    ctx.fillStyle = '#16211a';
    ctx.fillRect(-90, 250, VIEW_W + 180, 3);
    ctx.globalAlpha = this.a;

    // A path worn between the mine and the front door.
    quad(ctx, 300, 262, 420, 262, 560, 360, 120, 360, '#141c17', NO, 0);

    this.cottage(ctx, 372, 268, 1, 1, f);

    // Framing trees, near-black, half out of frame on both sides.
    fir(ctx, 24, 372, 264, 76, '#050809');
    fir(ctx, 618, 384, 288, 84, '#050809');

    // Fireflies. Fourteen of them, on fixed orbits.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const t = f * 0.012 + i * 1.7;
      const x = hrange(i * 5.1, 60, 580) + Math.sin(t) * 26;
      const y = hrange(i * 9.3, 200, 286) + Math.cos(t * 1.3) * 12;
      this.alpha(ctx, 0.24 + 0.34 * Math.max(0, Math.sin(f * 0.06 + i * 2.1)));
      ellipse(ctx, x, y, 1.5, 1.5, 0, '#d8ff9e', NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = this.a;

    // Somebody moves past the left window, once, about a third of the way in.
    const cross = clamp((f - n * 0.3) / 40, 0, 1);
    if (cross > 0 && cross < 1) {
      this.alpha(ctx, Math.sin(cross * Math.PI) * 0.85);
      const x = lerp(336, 356, cross);
      capsule(ctx, x, 240, x, 254, 4.4, '#1a1016', NO, 0);
      ellipse(ctx, x, 236, 4, 4.6, 0, '#1a1016', NO, 0);
      ctx.globalAlpha = this.a;
    }

    this.groundFog(ctx, f, 0.07, '#7fa8b8');
  }

  /**
   * The cottage. Four rectangles, a triangle and two squares of warm light,
   * which between them are the only reason anything else in this game happens.
   */
  private cottage(ctx: C2D, x: number, base: number, s: number, lit: number, f: number): void {
    const w = 108 * s;
    const h = 66 * s;
    const left = x - w * 0.5;
    const right = x + w * 0.5;
    const top = base - h;

    this.alpha(ctx, 0.55);
    ellipse(ctx, x, base + 3, w * 0.62, 7 * s, 0, '#04060a', NO, 0);
    ctx.globalAlpha = this.a;

    // Chimney first: the roof is drawn over its foot.
    roundRect(ctx, x + w * 0.26, top - 40 * s, 12 * s, 44 * s, 1.5 * s, '#3a2a26', INK, 1.6);
    roundRect(ctx, x + w * 0.245, top - 44 * s, 15 * s, 6 * s, 1.5 * s, '#4a3730', INK, 1.4);

    if (lit > 0.02) {
      for (let i = 0; i < 6; i++) {
        const p = ((f * 0.4 + i * 26) % 156) / 156;
        this.alpha(ctx, 0.26 * (1 - p) * lit);
        ellipse(
          ctx,
          x + w * 0.305 + Math.sin(p * 3.2 + i) * (4 + p * 20),
          top - 46 * s - p * 78,
          (3 + p * 13) * s, (2.6 + p * 11) * s, 0, '#6f6f80', NO, 0,
        );
      }
      ctx.globalAlpha = this.a;
    }

    roundRect(ctx, left, top, w, h, 2 * s, WOOD, INK, 1.8);

    this.alpha(ctx, 0.4);
    ctx.fillStyle = WOOD_DARK;
    for (let i = 1; i < 5; i++) ctx.fillRect(left + 2, top + (h / 5) * i, w - 4, 1.3 * s);
    ctx.globalAlpha = this.a;

    tri(ctx, left - 15 * s, top + 7 * s, x, top - 36 * s, right + 15 * s, top + 7 * s, '#33223a', INK, 2);
    capsule(ctx, left - 15 * s, top + 7 * s, right + 15 * s, top + 7 * s, 2.6 * s, '#241830', INK, 1.4);
    this.alpha(ctx, 0.35);
    capsule(ctx, left - 6 * s, top - 6 * s, x - 2 * s, top - 30 * s, 1.6 * s, '#5a4468', NO, 0);
    ctx.globalAlpha = this.a;

    this.window(ctx, x - w * 0.28, top + h * 0.3, 18 * s, 15 * s, lit, f, 0);
    this.window(ctx, x + w * 0.16, top + h * 0.3, 18 * s, 15 * s, lit, f, 7);

    // Door.
    roundRect(ctx, x - 11 * s, base - 34 * s, 22 * s, 34 * s, 2 * s, '#33221a', INK, 1.6);
    ellipse(ctx, x + 6 * s, base - 17 * s, 1.5 * s, 1.5 * s, 0, '#c8a63f', NO, 0);
    if (lit > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.alpha(ctx, 0.12 * lit);
      ellipse(ctx, x, base + 1, 36 * s, 10 * s, 0, WARM, NO, 0);
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    // Fence, flower box, the whole insufferable business.
    for (let i = 0; i < 7; i++) {
      const fx = left - 66 * s + i * 11 * s;
      capsule(ctx, fx, base - 1, fx, base - 13 * s, 1.6 * s, '#2a2018', INK, 1.2);
    }
    roundRect(ctx, left - 4 * s, base - 14 * s, 26 * s, 7 * s, 1.5 * s, '#3d2a1c', INK, 1.4);
  }

  private window(
    ctx: C2D, x: number, y: number, w: number, h: number, lit: number, f: number, seed: number,
  ): void {
    const flick = 0.86 + 0.14 * Math.sin(f * 0.09 + seed) * Math.sin(f * 0.031 + seed * 2.1);
    const on = lit * flick;

    if (on > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.alpha(ctx, 0.22 * on);
      ellipse(ctx, x + w * 0.5, y + h * 0.5, w * 1.9, h * 1.9, 0, WARM, NO, 0);
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    roundRect(ctx, x, y, w, h, 1.4, on > 0.03 ? WARM_HOT : '#121722', INK, 1.5);
    if (on > 0.03) {
      this.alpha(ctx, on);
      roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 1, '#ffc861', NO, 0);
      ctx.globalAlpha = this.a;
    }
    ctx.fillStyle = '#2a1c14';
    ctx.fillRect(x + w * 0.5 - 0.8, y, 1.6, h);
    ctx.fillRect(x, y + h * 0.5 - 0.8, w, 1.6);
  }

  private groundFog(ctx: C2D, f: number, amount: number, color: string): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 173 + f * 0.16) % 900) - 130;
      this.alpha(ctx, amount);
      ellipse(ctx, x, 288 + i * 9, 190, 13, 0, color, NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = this.a;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. HEADLIGHTS
  // ─────────────────────────────────────────────────────────────────────────

  /** Where each SUV comes to rest, and when it gets there. */
  private static readonly CAR_X = [104, 236, 368];
  private static readonly CAR_STOP = 104;
  private static readonly DOORS = 118;

  private carX(i: number, f: number): number {
    const t = easeOut(clamp((f - i * 9) / (CutsceneScene.CAR_STOP - 8), 0, 1));
    return lerp(-210 - i * 120, CutsceneScene.CAR_X[i], t);
  }

  private shotHeadlights(ctx: C2D, f: number, _n: number): void {
    this.bleed(ctx, this.gNight ?? '#0a1020');

    this.band(ctx, 11, 22, -70, 720, 238, 46, 84, 0.34, '#0a1418');
    this.band(ctx, 47, 15, -70, 720, 252, 74, 128, 0.32, '#070f12');

    // Beams, drawn over the trees so they wash the trunks rather than sit
    // behind them. As each car swings in, its cone rakes down across the wood.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const x = this.carX(i, f);
      if (x < -200) continue;
      const arrive = clamp((f - i * 9) / (CutsceneScene.CAR_STOP - 8), 0, 1);
      const sweep = (1 - easeOut(arrive)) * 120 - 6;
      const bx = x + 40;
      const by = 288;
      this.alpha(ctx, 0.13);
      quad(ctx, bx, by - 4, bx + 320, by - 96 - sweep, bx + 320, by + 40 - sweep, bx, by + 5, WARM_HOT, NO, 0);
      this.alpha(ctx, 0.09);
      quad(ctx, bx, by - 4, bx + 460, by - 150 - sweep, bx + 460, by + 70 - sweep, bx, by + 5, '#fff6dc', NO, 0);
    }
    ctx.restore();
    ctx.globalAlpha = this.a;

    ctx.fillStyle = '#0b1210';
    ctx.fillRect(-90, 250, VIEW_W + 180, VIEW_H - 190);
    quad(ctx, 300, 262, 420, 262, 560, 360, 120, 360, '#111813', NO, 0);

    // The cottage, unaware, still warm, at the end of the track.
    this.cottage(ctx, 528, 258, 0.66, 1, f);

    for (let i = 0; i < 3; i++) this.suv(ctx, this.carX(i, f), 302, 0.9, f);

    // Four of them get out and start walking. They are in no hurry either.
    const gy = 306;
    for (let i = 0; i < 4; i++) {
      const lf = f - CutsceneScene.DOORS - i * 14;
      if (lf < 0) continue;
      const from = CutsceneScene.CAR_X[i % 3] + (i > 2 ? -34 : 30);
      const gx = from + Math.min(lf, 200) * 0.62;

      // The beams throw them forward, long and thin, across the dirt.
      this.alpha(ctx, 0.4);
      quad(ctx, gx - 6, gy, gx + 6, gy, gx + 96, gy + 26, gx + 60, gy + 26, '#05070a', NO, 0);
      ctx.globalAlpha = this.a;

      this.guard(ctx, gx, gy, 1, lf < 8 ? 'land' : 'walk', lf * 1.1, 0.62);
    }

    this.groundFog(ctx, f, 0.05, '#8fb0c0');
  }

  private suv(ctx: C2D, x: number, base: number, s: number, f: number): void {
    if (x < -200 || x > VIEW_W + 200) return;
    const w = 96 * s;
    const bodyY = base - 26 * s;

    this.alpha(ctx, 0.5);
    ellipse(ctx, x, base + 2, w * 0.56, 6 * s, 0, '#04060a', NO, 0);
    ctx.globalAlpha = this.a;

    ellipse(ctx, x - 28 * s, base - 5 * s, 9 * s, 9 * s, 0, '#0a0b10', INK, 1.6);
    ellipse(ctx, x + 30 * s, base - 5 * s, 9 * s, 9 * s, 0, '#0a0b10', INK, 1.6);

    roundRect(ctx, x - w * 0.5, bodyY, w, 26 * s, 3 * s, '#0d0e14', INK, 1.8);
    quad(
      ctx,
      x - 30 * s, bodyY, x - 17 * s, bodyY - 19 * s,
      x + 21 * s, bodyY - 19 * s, x + 33 * s, bodyY,
      '#101219', INK, 1.8,
    );
    quad(
      ctx,
      x - 25 * s, bodyY - 2 * s, x - 14 * s, bodyY - 16 * s,
      x + 17 * s, bodyY - 16 * s, x + 27 * s, bodyY - 2 * s,
      '#141a26', NO, 0,
    );

    // Chrome strip, headlamps, tail lamps.
    roundRect(ctx, x - w * 0.46, bodyY + 13 * s, w * 0.92, 2.4 * s, 1, '#2a2f3a', NO, 0);
    ellipse(ctx, x + w * 0.44, bodyY + 7 * s, 4.4 * s, 3 * s, 0, '#fff4d0', INK, 1.2);
    ellipse(ctx, x - w * 0.46, bodyY + 7 * s, 3.4 * s, 2.6 * s, 0, '#8a1c22', INK, 1.2);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.5 + 0.06 * Math.sin(f * 0.2));
    ellipse(ctx, x + w * 0.44, bodyY + 7 * s, 11 * s, 7 * s, 0, WARM_HOT, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;
  }

  private guard(
    ctx: C2D, x: number, y: number, facing: 1 | -1, clip: string, frame: number,
    scale: number, tint?: string,
  ): void {
    const pose = sampleClip(clipOf(clip), frame);
    drawCharacter(ctx, this.suitStyle, pose, HUMAN_SKELETON, x, y, facing, { scale, tint });
  }

  private beatsHeadlights(f: number): void {
    if (f === 2) this.sfx('engine', 0.5, 0.62);
    else if (f === 62) this.sfx('engine', 0.34, 0.9);
    else if (f === CutsceneScene.CAR_STOP) {
      this.sfx('tyres', 0.6, 0.9);
      this.shake(2.2, 10);
      // Dust off the front wheels as they settle.
      for (let i = 0; i < 3; i++) {
        this.particles.emit({
          count: 9,
          x: CutsceneScene.CAR_X[i] + 30,
          y: py(302),
          z: 0,
          angle: Math.PI * 0.15,
          spread: 1.5,
          speed: [0.4, 1.5],
          life: [26, 52],
          size: [3, 7],
          colors: ['#3b3730', '#565046'],
          gravity: -0.01,
          drag: 0.94,
          shape: 'smoke',
          fade: 'ease',
        });
      }
    } else if (f === CutsceneScene.DOORS || f === CutsceneScene.DOORS + 14
      || f === CutsceneScene.DOORS + 28 || f === CutsceneScene.DOORS + 42) {
      this.sfx('hit_metal', 0.3, 1.15 + hash(f) * 0.12);
    } else if (f === CutsceneScene.DOORS + 8) {
      this.sfx('drop', 0.26, 0.9);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. THE DOOR
  //
  // Hard cut in, hard cut out. Everything in this shot exists to make one
  // frame land: hitstop, shake, a white flash, aberration and forty splinters.
  // ─────────────────────────────────────────────────────────────────────────

  private static readonly IMPACT = 27;
  private static readonly DOOR_X = 246;
  private static readonly DOOR_Y = 96;
  private static readonly DOOR_W = 152;
  private static readonly DOOR_H = 226;

  private shotDoor(ctx: C2D, f: number, _n: number): void {
    const k = f - CutsceneScene.IMPACT;
    const open = clamp(k / 10, 0, 1);
    const dx = CutsceneScene.DOOR_X;
    const dy = CutsceneScene.DOOR_Y;
    const dw = CutsceneScene.DOOR_W;
    const dh = CutsceneScene.DOOR_H;

    // The cottage wall, filling the frame. No edges: this is a wall, not a
    // building, and the shot is close enough that finding its corner would
    // break the whole illusion.
    this.bleed(ctx, '#3f2c1e');
    this.alpha(ctx, 0.4);
    ctx.fillStyle = WOOD_DARK;
    for (let i = 0; i < 20; i++) ctx.fillRect(-84 + i * 37, -60, 1.8, VIEW_H + 120);
    ctx.globalAlpha = this.a;
    // Eave shadow across the top, so the frame has a lid.
    this.alpha(ctx, 0.55);
    ctx.fillStyle = '#120c10';
    ctx.fillRect(-90, -60, VIEW_W + 180, 96);
    ctx.globalAlpha = this.a;

    // Doorway. Warm behind, so the cracks glow before the door has moved.
    roundRect(ctx, dx - 9, dy - 9, dw + 18, dh + 9, 2, '#2a1c12', INK, 2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.34 + 0.62 * open);
    roundRect(
      ctx,
      dx - (open > 0.02 ? 0 : 3), dy - (open > 0.02 ? 0 : 3),
      dw + (open > 0.02 ? 0 : 6), dh + (open > 0.02 ? 0 : 3),
      2, open > 0.02 ? '#ffce7a' : WARM, NO, 0,
    );
    ctx.restore();
    ctx.globalAlpha = this.a;

    if (open > 0.02) {
      // Light floods out past the camera.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.alpha(ctx, 0.3 * open);
      quad(ctx, dx, dy + 30, dx + dw, dy + 30, 560, 372, 60, 372, WARM, NO, 0);
      ctx.restore();

      // Dust hanging in the beam. Fixed positions, drifting.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 22; i++) {
        const t = (f * 0.1 + i * 13) % 200;
        this.alpha(ctx, 0.2 * open * (1 - t / 200));
        ellipse(
          ctx,
          hrange(i * 3.7, dx - 20, dx + dw + 20) + Math.sin(f * 0.02 + i) * 5,
          dy + 40 + t,
          1.1, 1.1, 0, '#ffe6bd', NO, 0,
        );
      }
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    if (k < 0) {
      this.doorLeaf(ctx, dx, dy, 0);
    } else {
      // Off its hinges and coming at you.
      const p = easeOut(clamp(k / 30, 0, 1));
      ctx.save();
      ctx.translate(dx + dw * 0.5 + p * 46, dy + dh * 0.5 + p * 150);
      ctx.rotate(p * 1.45);
      ctx.scale(1 + p * 0.55, 1 + p * 0.55);
      this.doorLeaf(ctx, -dw * 0.5, -dh * 0.5, p);
      ctx.restore();
    }

    // The man who did it, mostly out of frame, and the one who watched.
    const kf = f <= CutsceneScene.IMPACT
      ? (f / CutsceneScene.IMPACT) * 14
      : 14 + clamp((f - CutsceneScene.IMPACT) * 0.8, 0, 8);
    this.guard(ctx, 146, 348, 1, 'kick', kf, 1.7, '#1a1622');
    this.guard(ctx, 512, 344, -1, 'idle', f * 0.7 + 30, 1.55, '#1a1622');
  }

  private doorLeaf(ctx: C2D, x: number, y: number, broken: number): void {
    const w = CutsceneScene.DOOR_W;
    const h = CutsceneScene.DOOR_H;
    roundRect(ctx, x, y, w, h, 2, '#4b3423', INK, 2.2);
    this.alpha(ctx, 0.45);
    ctx.fillStyle = '#33220f';
    for (let i = 1; i < 4; i++) ctx.fillRect(x + (w / 4) * i, y + 3, 2, h - 6);
    ctx.globalAlpha = this.a;

    // Cross braces, hinges, handle.
    capsule(ctx, x + 8, y + h - 18, x + w - 8, y + 24, 4, '#5c4029', INK, 1.6);
    roundRect(ctx, x - 4, y + 26, 16, 12, 2, '#2a2b33', INK, 1.4);
    roundRect(ctx, x - 4, y + h - 46, 16, 12, 2, '#2a2b33', INK, 1.4);
    ellipse(ctx, x + w - 20, y + h * 0.52, 5, 5, 0, '#c8a63f', INK, 1.4);

    // A small pane, which does not survive.
    if (broken < 0.02) {
      roundRect(ctx, x + w * 0.28, y + 22, w * 0.44, 40, 1.5, '#9fd0e0', INK, 1.6);
      ctx.fillStyle = '#2a1c12';
      ctx.fillRect(x + w * 0.5 - 1, y + 22, 2, 40);
    } else {
      roundRect(ctx, x + w * 0.28, y + 22, w * 0.44, 40, 1.5, '#141019', INK, 1.6);
      tri(ctx, x + w * 0.28, y + 22, x + w * 0.44, y + 22, x + w * 0.3, y + 44, '#7fb3c4', NO, 0);
      tri(ctx, x + w * 0.72, y + 62, x + w * 0.72, y + 34, x + w * 0.58, y + 62, '#6ea2b4', NO, 0);
    }
  }

  private beatsDoor(f: number): void {
    if (f === 9) this.sfx('whiff', 0.34, 0.72);
    if (f !== CutsceneScene.IMPACT) {
      if (f === CutsceneScene.IMPACT + 17) this.sfx('drop', 0.8, 0.66);
      else if (f === CutsceneScene.IMPACT + 34) this.sfx('land', 0.34, 0.9);
      return;
    }

    // The frame the whole sequence is built around.
    this.sfx('punch_heavy', 1, 0.9);
    this.sfx('bat_crack', 0.95, 0.76);
    this.sfx('glass', 0.5, 1.2);
    this.host.loop.hitstop = this.reduced ? 3 : 7;
    this.shake(14, 22);
    this.kick(0.09, 0.55, '#ffe9c2', 0.55);

    const cx = CutsceneScene.DOOR_X + CutsceneScene.DOOR_W * 0.5;
    const cy = CutsceneScene.DOOR_Y + CutsceneScene.DOOR_H * 0.5;
    this.particles.emit({
      count: this.reduced ? 18 : 42,
      x: cx,
      y: py(cy),
      z: 0,
      angle: 0,
      spread: TAU,
      speed: [2.2, 8],
      life: [14, 30],
      size: [1.4, 4.2],
      colors: ['#8a5a2e', '#c8a06a', '#4a2f1c', '#e0c79a'],
      gravity: 0.22,
      drag: 0.93,
      shape: 'shard',
      spin: 0.4,
    });
    this.particles.emit({
      count: this.reduced ? 8 : 18,
      x: cx,
      y: py(cy - 18),
      z: 0,
      angle: 0,
      spread: TAU,
      speed: [1.4, 5],
      life: [10, 20],
      size: [1, 2.2],
      colors: ['#ffffff', '#ffe0a8', '#9fd0e0'],
      gravity: 0.06,
      drag: 0.9,
      shape: 'spark',
      additive: true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. TAKEN
  //
  // She stays a shape. Partly because it is more frightening, and partly
  // because designing a character who never appears in gameplay is a promise
  // this game has no intention of keeping.
  // ─────────────────────────────────────────────────────────────────────────

  private shotTaken(ctx: C2D, f: number, n: number): void {
    const t = f / Math.max(1, n);
    this.bleed(ctx, this.gNight ?? '#0a1020');

    this.band(ctx, 11, 20, -70, 720, 232, 44, 80, 0.34, '#080f14');
    ctx.fillStyle = '#0a1010';
    ctx.fillRect(-90, 250, VIEW_W + 180, VIEW_H - 190);

    const doorX = 392;
    const doorY = 214;
    const doorW = 34;
    const doorH = 54;

    // The house, dark now except the hole where the door used to be.
    this.alpha(ctx, 0.6);
    ellipse(ctx, 392, 271, 74, 8, 0, '#04060a', NO, 0);
    ctx.globalAlpha = this.a;
    roundRect(ctx, 330, 200, 124, 68, 2, '#241a14', INK, 1.8);
    tri(ctx, 316, 204, 392, 168, 468, 204, '#1c1424', INK, 2);
    roundRect(ctx, 348, 214, 20, 17, 1.4, '#0e1218', INK, 1.4);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.9);
    roundRect(ctx, doorX - doorW * 0.5, doorY, doorW, doorH, 1, '#ffce7a', NO, 0);
    this.alpha(ctx, 0.16);
    quad(ctx, doorX - doorW * 0.5, doorY, doorX + doorW * 0.5, doorY, 250, 360, -120, 360, WARM, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;

    // The door itself, lying in the grass where it landed.
    ctx.save();
    ctx.translate(464, 274);
    ctx.rotate(0.22);
    roundRect(ctx, -34, -6, 68, 12, 2, '#2e2118', INK, 1.6);
    ctx.restore();

    // The carry. Out of the doorway, down the path, into the car, gone.
    const walk = clamp(t / 0.6, 0, 1);
    const gx = lerp(372, 190, easeInOut(walk));
    const gy = 300;
    const load = clamp((t - 0.6) / 0.12, 0, 1);
    const leave = clamp((t - 0.84) / 0.16, 0, 1);
    const carX = 132 - easeIn(leave) * 380;

    this.suv(ctx, carX, 306, 0.94, f);

    if (leave < 0.02) {
      // A third man leaves last, with a case, and looks back at the house once.
      const bx = lerp(384, 214, easeInOut(clamp((t - 0.24) / 0.52, 0, 1)));
      const look = t > 0.5 && t < 0.62;
      this.guard(ctx, bx, 296, look ? 1 : -1, 'walk', f * 1.05, 0.6, '#22202c');
      capsule(ctx, bx + 12, 274, bx + 12, 286, 5, '#15161c', INK, 1.4);

      if (load < 1) {
        this.guard(ctx, gx + 22, gy, -1, 'walk', f * 1.15, 0.66, '#1e1c28');
        this.guard(ctx, gx - 22, gy, -1, 'walk', f * 1.15 + 9, 0.66, '#1e1c28');
        this.snowWhite(ctx, gx, gy - 46 + load * 22, 1 + load * 0.06, 1 - load);
      } else {
        this.guard(ctx, 178, gy, -1, 'idle', f, 0.66, '#1e1c28');
      }
    }

    // Two red eyes going down the track. Nobody has said a word.
    if (t > 0.78) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.alpha(ctx, 0.6);
      ellipse(ctx, carX - 43, 288, 9, 5, 0, '#ff3b30', NO, 0);
      ellipse(ctx, carX - 30, 288, 6, 4, 0, '#ff3b30', NO, 0);
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    this.groundFog(ctx, f, 0.05, '#7f96b0');
  }

  /**
   * Carried, face up, head toward the car. Two passes over the same geometry:
   * a fat warm one for the rim the doorway throws around her, then the black.
   */
  private snowWhite(ctx: C2D, x: number, y: number, s: number, rim: number): void {
    if (rim > 0.02) {
      this.alpha(ctx, 0.5 * rim);
      this.snowWhiteBody(ctx, x, y, s, 1.6, '#f0a04a');
      ctx.globalAlpha = this.a;
    }
    this.snowWhiteBody(ctx, x, y, s, 0, '#07060b');
  }

  private snowWhiteBody(ctx: C2D, x: number, y: number, s: number, pad: number, fill: string): void {
    const u = 1 * s;
    // Torso and the dress falling off the far side of the arms.
    capsule(ctx, x - 8 * u, y, x + 13 * u, y + 2 * u, 7 * u + pad, fill, NO, 0);
    quad(
      ctx,
      x + 9 * u, y - 6 * u - pad, x + 32 * u, y - 1 * u - pad,
      x + 30 * u, y + 11 * u + pad, x + 8 * u, y + 9 * u + pad,
      fill, NO, 0,
    );
    // Head, and the hair hanging straight down out of it.
    ellipse(ctx, x - 16 * u, y - 2 * u, 6.6 * u + pad, 7.2 * u + pad, 0, fill, NO, 0);
    ellipse(ctx, x - 20 * u, y + 1 * u, 8 * u + pad, 7 * u + pad, 0, fill, NO, 0);
    quad(
      ctx,
      x - 25 * u, y - 2 * u - pad, x - 15 * u, y + 2 * u,
      x - 12 * u, y + 24 * u + pad, x - 24 * u, y + 22 * u + pad,
      fill, NO, 0,
    );
    // The arm nobody is holding.
    capsule(ctx, x - 1 * u, y + 5 * u, x + 5 * u, y + 25 * u, 2.6 * u + pad, fill, NO, 0);
    ellipse(ctx, x + 5 * u, y + 27 * u, 3 * u + pad, 3 * u + pad, 0, fill, NO, 0);
  }

  private beatsTaken(f: number, n: number): void {
    const shut = Math.round(n * 0.72);
    if (f === 4) this.sfx('drop', 0.24, 0.85);
    else if (f === shut) {
      this.sfx('hit_metal', 0.6, 0.8);
      this.shake(3, 10);
    } else if (f === Math.round(n * 0.84)) this.sfx('engine', 0.5, 0.7);
    else if (f === Math.round(n * 0.9)) this.sfx('tyres', 0.5, 1.05);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. THE LAB
  //
  // Same renderer, opposite palette. Everything shot 1 did in amber, this does
  // in surgical white and cyan, which is the whole argument of the film.
  // ─────────────────────────────────────────────────────────────────────────

  private shotLab(ctx: C2D, f: number, _n: number): void {
    this.bleed(ctx, this.gLab ?? '#0a1622');

    // Tiled wall.
    this.alpha(ctx, 0.16);
    ctx.strokeStyle = '#2a4358';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -80; x <= 720; x += 40) {
      ctx.moveTo(x, 20);
      ctx.lineTo(x, 250);
    }
    for (let y = 20; y <= 250; y += 40) {
      ctx.moveTo(-80, y);
      ctx.lineTo(720, y);
    }
    ctx.stroke();
    ctx.globalAlpha = this.a;

    // Monitors, all of them showing the same woman's heart.
    for (let i = 0; i < 3; i++) {
      const mx = 46 + i * 104;
      roundRect(ctx, mx, 58, 88, 54, 2, '#08131c', '#1e3444', 1.6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(mx + 3, 61, 82, 48);
      ctx.clip();
      this.alpha(ctx, 0.9);
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k <= 82; k += 2) {
        const ph = (k + f * 1.6 + i * 40) * 0.09;
        const spike = Math.exp(-((((ph % 6.283) - 3) ** 2) * 3)) * 16;
        ctx.lineTo(mx + 3 + k, 88 + Math.sin(ph * 3) * 2 - spike);
      }
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    // Floor.
    ctx.fillStyle = '#0b1620';
    ctx.fillRect(-90, 250, VIEW_W + 180, VIEW_H - 190);

    this.gurney(ctx, 486, 250, f);

    // Surgical lamp, and the one hard cone of light in the entire cinematic.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.13);
    quad(ctx, 268, 58, 340, 58, 400, 252, 208, 252, CLINIC, NO, 0);
    this.alpha(ctx, 0.2);
    ellipse(ctx, 304, 244, 76, 15, 0, CLINIC, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;

    this.table(ctx, 304, 246);

    capsule(ctx, 304, 4, 304, 40, 3, '#2b3d4c', INK, 1.6);
    ellipse(ctx, 304, 48, 40, 12, 0, '#dbe6ef', INK, 2);
    for (let i = 0; i < 5; i++) {
      ellipse(ctx, 274 + i * 15, 52, 5.4, 3.4, 0, '#fbffff', '#9fb4c4', 1);
    }

    // Him. Hands where you can see them, which is the point.
    drawCharacter(
      ctx, this.muskStyle, sampleClip(clipOf('idle'), f * 0.85), HUMAN_SKELETON,
      196, 252, 1, { scale: 0.82 },
    );

    // The tray, and one instrument catching the light every second or so.
    roundRect(ctx, 366, 226, 54, 6, 1.5, '#3e4c58', INK, 1.4);
    capsule(ctx, 374, 224, 392, 222, 1.6, STEEL, INK, 1);
    capsule(ctx, 396, 225, 412, 223, 1.4, STEEL, INK, 1);
    if ((f % 74) < 8) star(ctx, 392, 222, 4, 4, '#ffffff', NO);

    this.groundFog(ctx, f, 0.045, '#4f7fa0');
  }

  private table(ctx: C2D, x: number, base: number): void {
    roundRect(ctx, x - 84, base - 10, 168, 11, 2, '#8b98a6', INK, 1.8);
    roundRect(ctx, x - 84, base - 14, 168, 5, 2, STEEL, INK, 1.4);
    this.alpha(ctx, 0.5);
    ctx.fillStyle = '#5d6b78';
    ctx.fillRect(x - 70, base - 11, 140, 1.4);
    ctx.globalAlpha = this.a;
    capsule(ctx, x - 58, base + 1, x - 58, base + 34, 3.4, '#525f6b', INK, 1.5);
    capsule(ctx, x + 58, base + 1, x + 58, base + 34, 3.4, '#525f6b', INK, 1.5);
    // Restraints. Four of them, open, waiting.
    for (let i = 0; i < 4; i++) {
      const sx = x - 60 + i * 40;
      capsule(ctx, sx, base - 15, sx, base - 24, 2.2, '#2c3540', INK, 1.2);
    }
  }

  /** Ninety-six percent of a person, on wheels. */
  private gurney(ctx: C2D, x: number, base: number, f: number): void {
    roundRect(ctx, x - 74, base - 30, 148, 8, 2, '#3b4654', INK, 1.6);
    capsule(ctx, x - 60, base - 22, x - 60, base - 4, 2.6, '#333d49', INK, 1.4);
    capsule(ctx, x + 60, base - 22, x + 60, base - 4, 2.6, '#333d49', INK, 1.4);
    ellipse(ctx, x - 60, base - 2, 4, 4, 0, '#20262e', INK, 1.2);
    ellipse(ctx, x + 60, base - 2, 4, 4, 0, '#20262e', INK, 1.2);

    // Chassis: torso plate, an unfinished skull, one arm and one stump.
    roundRect(ctx, x - 48, base - 52, 84, 22, 9, STEEL, INK, 1.8);
    this.alpha(ctx, 0.55);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = '#8f9aa6';
      ctx.fillRect(x - 40 + i * 18, base - 50, 2.4, 18);
    }
    ctx.globalAlpha = this.a;

    capsule(ctx, x + 34, base - 44, x + 60, base - 40, 5, '#aab5c1', INK, 1.6);
    ellipse(ctx, x + 66, base - 40, 12, 13, 0, '#dfe6ee', INK, 1.8);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.5 + 0.3 * Math.sin(f * 0.07));
    ellipse(ctx, x + 70, base - 42, 6, 6, 0, CYAN, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;
    ellipse(ctx, x + 70, base - 42, 2.6, 2.6, 0, CYAN, NO, 0);

    // The missing arm, and the loom of wires hanging out of the socket.
    ellipse(ctx, x - 46, base - 44, 7, 8, 0, '#7c8792', INK, 1.6);
    for (let i = 0; i < 4; i++) {
      const yy = base - 48 + i * 4;
      capsule(ctx, x - 50, yy, x - 66 - i * 3, yy + 10 + i * 3, 1.2,
        i % 2 ? '#c05a4a' : '#3f6fa8', NO, 0);
    }
    // Something in there is still live, twice a shot.
    if (this.arcAt(f, 66) || this.arcAt(f, 142)) {
      zigzag(ctx, x - 50, base - 46, x - 70, base - 34, 3.5, 6, CYAN, 1.4);
    }

    // A crown, on a stand, under glass. Nobody has to say what it is for.
    capsule(ctx, x + 116, base - 6, x + 116, base - 26, 3, '#39434f', INK, 1.4);
    P10[0] = x + 104; P10[1] = base - 28;
    P10[2] = x + 108; P10[3] = base - 40;
    P10[4] = x + 116; P10[5] = base - 32;
    P10[6] = x + 124; P10[7] = base - 40;
    P10[8] = x + 128; P10[9] = base - 28;
    poly(ctx, P10, GOLD, INK, 1.4);
    this.alpha(ctx, 0.16);
    ellipse(ctx, x + 116, base - 30, 22, 26, 0, '#b8dcf0', '#cfe8f8', 1.2);
    ctx.globalAlpha = this.a;
  }

  /** True for ten frames after `at`, so the arc and its crackle line up. */
  private arcAt(f: number, at: number): boolean {
    return f >= at && f < at + 10;
  }

  private beatsLab(f: number): void {
    if (f === 1) {
      this.sfx('hit_metal', 0.42, 1.8);
      this.kick(0, 0.22, CLINIC);
    } else if (f === 66 || f === 142) {
      this.sfx('taser', 0.26, 1.5);
    } else if (f === 108) {
      this.sfx('drop', 0.28, 1.45);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. THE NOTE
  //
  // The payload. The room is deliberately quiet and slightly out of focus
  // behind a scrim: everything on screen is in service of thirty-nine lines of
  // text, and the shot is exactly as long as those lines need.
  // ─────────────────────────────────────────────────────────────────────────

  private shotRoom(ctx: C2D, f: number, _n: number): void {
    this.bleed(ctx, this.gRoom ?? '#0d1018');

    // The hole where the door was, and the night coming in through it.
    roundRect(ctx, 34, 92, 92, 210, 2, '#050810', INK, 2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.1);
    quad(ctx, 34, 92, 126, 92, 300, 360, -40, 360, MOON, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;

    // Window, and two shafts of moonlight down onto the table.
    roundRect(ctx, 486, 78, 90, 78, 2, '#101c2c', INK, 1.8);
    ctx.fillStyle = '#0b1522';
    ctx.fillRect(530, 78, 2.4, 78);
    ctx.fillRect(486, 116, 90, 2.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.09);
    quad(ctx, 486, 78, 530, 78, 366, 292, 268, 292, MOON, NO, 0);
    this.alpha(ctx, 0.07);
    quad(ctx, 532, 78, 576, 78, 420, 292, 322, 292, MOON, NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;

    // Seven hats on seven hooks. Six of them are still there.
    for (let i = 0; i < 7; i++) {
      const hx = 178 + i * 26;
      capsule(ctx, hx, 106, hx, 112, 1.4, '#2a2430', NO, 0);
      if (i === 3) continue;
      const d = DWARFS[i % DWARFS.length];
      tri(ctx, hx - 7, 126, hx + 1, 110, hx + 8, 126, d.style.hatColor, INK, 1.2);
    }

    // Table, chair on its back, plate in two pieces.
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(-90, 288, VIEW_W + 180, 120);
    roundRect(ctx, 232, 250, 156, 9, 2, '#3f2c1c', INK, 1.8);
    capsule(ctx, 248, 259, 244, 296, 3.2, '#33231a', INK, 1.5);
    capsule(ctx, 372, 259, 376, 296, 3.2, '#33231a', INK, 1.5);
    ctx.save();
    ctx.translate(150, 288);
    ctx.rotate(-1.25);
    roundRect(ctx, -20, -4, 40, 8, 2, '#33231a', INK, 1.5);
    capsule(ctx, -14, 4, -14, 26, 2.6, '#2b1e16', INK, 1.3);
    capsule(ctx, 14, 4, 14, 26, 2.6, '#2b1e16', INK, 1.3);
    ctx.restore();
    tri(ctx, 424, 296, 442, 288, 446, 298, '#c8c4b4', INK, 1.2);
    tri(ctx, 452, 298, 462, 286, 470, 297, '#c8c4b4', INK, 1.2);

    // The note. Printed. Signed with a logo.
    ctx.save();
    ctx.translate(308, 244);
    ctx.rotate(-0.07);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.14);
    ellipse(ctx, 0, 0, 52, 30, 0, '#cfe2ff', NO, 0);
    ctx.restore();
    ctx.globalAlpha = this.a;
    roundRect(ctx, -27, -19, 54, 38, 1, '#dfdccd', INK, 1.2);
    this.alpha(ctx, 0.5);
    ctx.fillStyle = '#8b8778';
    for (let i = 0; i < 6; i++) ctx.fillRect(-21, -12 + i * 5, i === 5 ? 18 : 42, 1.4);
    ctx.globalAlpha = this.a;
    ellipse(ctx, 16, 12, 5.4, 5.4, 0, '#1b1a24', NO, 0);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(13.4, 9.4);
    ctx.lineTo(18.6, 14.6);
    ctx.moveTo(18.6, 9.4);
    ctx.lineTo(13.4, 14.6);
    ctx.stroke();
    ctx.restore();
  }

  private notePageAt(f: number): number {
    for (let i = this.pages.length - 1; i >= 0; i--) if (f >= this.pageAt[i]) return i;
    return 0;
  }

  private typedAt(f: number, i: number): number {
    const t = (f - this.pageAt[i] - PAGE_IN) * CHARS_PER_FRAME;
    return clamp(Math.round(t), 0, this.pages[i].chars);
  }

  private noteAlphaAt(f: number, i: number): number {
    const local = f - this.pageAt[i];
    const outAt = PAGE_IN + this.pageType[i] + PAGE_HOLD;
    return Math.min(
      clamp(local / PAGE_IN, 0, 1),
      1 - clamp((local - outAt) / PAGE_OUT, 0, 1),
    );
  }

  private noteText(ctx: C2D, f: number): void {
    if (this.pages.length === 0) return;
    const i = this.notePageAt(f);
    const page = this.pages[i];
    const pa = this.noteAlphaAt(f, i);

    // Scrim. The room is set dressing from here on; the words are the shot.
    ctx.globalAlpha = this.a * 0.74;
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = this.a;
    if (pa <= 0.004) return;

    setFont(ctx, 12, 700, false);
    ctx.textAlign = 'left';

    // Block width is measured once per page, then centred, so the left margin
    // stays put while the line types rather than crawling toward it.
    if (this.pageW[i] < 0) {
      let max = 0;
      for (const l of page.lines) max = Math.max(max, ctx.measureText(l).width);
      this.pageW[i] = max;
    }
    const x0 = Math.round((VIEW_W - this.pageW[i]) * 0.5);
    let y = Math.round(NOTE_MID - (page.lines.length * NOTE_LH) * 0.5);

    const typed = this.typedAt(f, i);
    let cum = 0;
    for (let k = 0; k < page.lines.length; k++) {
      const line = page.lines[k];
      const shown = clamp(typed - cum, 0, line.length);
      // One slice per frame at most: every finished line hands back the
      // original string rather than a copy of it.
      const s = shown <= 0 ? '' : shown >= line.length ? line : line.slice(0, shown);
      if (shown > 0) {
        ctx.globalAlpha = this.a * pa * 0.75;
        ctx.fillStyle = '#04060c';
        ctx.fillText(s, x0 + 1, y + 1);
        ctx.globalAlpha = this.a * pa;
        ctx.fillStyle = page.letter[k] ? GOLD : PAPER;
        ctx.fillText(s, x0, y);
      }
      if (typed <= cum + line.length) {
        // Write head. Blinks on the hold, solid while it is still typing.
        const blink = typed >= page.chars ? (this.frame % 34) < 20 : true;
        if (blink) {
          ctx.globalAlpha = this.a * pa * 0.8;
          ctx.fillStyle = page.letter[k] ? GOLD : PAPER;
          ctx.fillRect(x0 + (shown > 0 ? ctx.measureText(s).width : 0) + 1.5, y - 8, 5.5, 2);
        }
        break;
      }
      cum += line.length + 1;
      y += NOTE_LH;
    }
    ctx.globalAlpha = this.a;
  }

  private beatsNote(f: number): void {
    if (this.pages.length === 0) return;
    const i = this.notePageAt(f);
    if (i !== this.livePage) {
      if (this.livePage >= 0) this.sfx('drop', 0.22, 1.5);
      this.livePage = i;
      this.typed = 0;
    }

    const typed = this.typedAt(f, i);
    if (typed > this.typed) {
      // One tick every other frame at most, and never on a space: a typewriter
      // that clicks on whitespace sounds broken rather than mechanical.
      const c = this.pages[i].flat.charCodeAt(typed - 1);
      if (c !== 32 && c !== 10 && (this.frame & 1) === 0) {
        this.sfx('ui_move', 0.07, 1.7 + hash(typed) * 0.35);
      }
      this.typed = typed;
      if (typed >= this.pages[i].chars && i === this.pages.length - 1) {
        this.sfx('meter_full', 0.45, 1.1);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. SUITING UP
  //
  // The select screen's transformation, seven times, staggered so the leather
  // travels down the line, and then the lights go out behind them.
  // ─────────────────────────────────────────────────────────────────────────

  private silAt(f: number, n: number): number {
    return clamp((f - (n - 92)) / 58, 0, 1);
  }

  private shotSuiting(ctx: C2D, f: number, n: number): void {
    const sil = this.silAt(f, n);
    this.bleed(ctx, this.gNight ?? '#0a1020');

    // The backlight that turns seven dwarfs into a poster.
    if (sil > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.alpha(ctx, 0.3 * sil);
      ellipse(ctx, 320, 300, 420, 190, 0, '#c8783a', NO, 0);
      this.alpha(ctx, 0.22 * sil);
      ellipse(ctx, 320, 306, 250, 120, 0, WARM, NO, 0);
      ctx.restore();
      ctx.globalAlpha = this.a;
    }

    this.band(ctx, 11, 18, -70, 720, 226, 44, 78, 0.34, sil > 0.4 ? '#100c12' : '#0a1014');
    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(-90, 250, VIEW_W + 180, VIEW_H - 190);

    // The cottage, small, dark, behind them. Nobody is going back in.
    this.cottage(ctx, 424, 244, 0.44, 0, f);

    // Seven pickaxes on the ground. Put down, not dropped.
    for (let i = 0; i < 7; i++) {
      const px = 92 + i * 76;
      ctx.save();
      ctx.translate(px, 322);
      ctx.rotate(0.1 + hrange(i * 4.3, -0.35, 0.35));
      capsule(ctx, -20, 0, 18, 0, 2.4, '#4a3020', INK, 1.3);
      capsule(ctx, 16, -6, 16, 6, 2.2, '#6a7480', INK, 1.3);
      ctx.restore();
    }

    const tint = sil > 0.02 ? '#241c30' : undefined;
    for (let i = 0; i < 7 && i < this.dwarfStyles.length; i++) {
      const lf = f - 16 - i * D_STAGGER;
      const st = this.dwarfStyles[i];
      const src = DWARFS[i];
      st.outfit = lf > 0 ? outfitAt(lf) : 0;
      st.shades = src.style.shades && lf >= D_SHADES;
      drawCharacter(
        ctx, st, this.dressPose(lf), DWARF_SKELETON,
        70 + i * 83, 306, 1, { scale: 2, tint },
      );
    }

    if (sil > 0.02) {
      this.alpha(ctx, 0.3 * sil);
      ctx.fillStyle = '#07060c';
      ctx.fillRect(-90, -60, VIEW_W + 180, VIEW_H + 120);
      ctx.globalAlpha = this.a;
    }
    this.groundFog(ctx, f, 0.06, sil > 0.4 ? '#c07a3e' : '#7f96b0');
  }

  private dressPose(f: number): Pose {
    if (f <= 0) return sampleClip(clipOf('dress_start'), 0);
    if (f < D_JACKET) return sampleClip(clipOf('dress_start'), f);
    if (f < D_SHADES) return sampleClip(clipOf('dress_jacket'), f - D_JACKET);
    if (f < D_POSE) return sampleClip(clipOf('dress_shades'), f - D_SHADES);
    const l = f - D_POSE;
    const pose = sampleClip(clipOf('dress_pose'), l);
    if (l >= 8) return pose;
    // dress_pose does not begin where dress_shades ends. Ease across the seam.
    return blendPose(sampleClip(clipOf('dress_shades'), 44), pose, easeInOut(l / 8));
  }

  private beatsSuiting(f: number, n: number): void {
    const last = Math.min(7, DWARFS.length) - 1;
    for (let i = 0; i <= last; i++) {
      const lf = f - 16 - i * D_STAGGER;
      if (lf === D_JACKET) this.sfx('drop', 0.2, 0.85);
      else if (lf === D_JACKET + D_SNAP) {
        this.sfx('hit_metal', 0.24, 1 + i * 0.02);
        if (!this.reduced) {
          this.particles.emit({
            count: 7,
            x: 70 + i * 83,
            y: py(240),
            z: 0,
            angle: Math.PI * 0.5,
            spread: TAU,
            speed: [0.8, 2.4],
            life: [12, 24],
            size: [0.8, 1.7],
            colors: [DWARFS[i].style.jacketAccent, '#e6ebf5'],
            gravity: 0.16,
            drag: 0.92,
            shape: 'spark',
            additive: true,
          });
        }
      } else if (lf === D_SHADES + D_GLINT && i === last) {
        this.sfx('meter_full', 0.5, 1);
        this.kick(0.02, 0.3, '#ffffff');
      } else if (lf === D_POSE && i === last) {
        this.sfx('super_charge', 0.7, 0.95);
        this.host.audio.voice(DWARFS[i].voice, 'taunt');
        this.shake(5, 16);
        this.kick(0.05, 0.2, GOLD);
      }
    }
    if (f === n - 92) this.sfx('dash', 0.4, 0.65);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8. TITLE CARD
  // ─────────────────────────────────────────────────────────────────────────

  private shotTitleBed(ctx: C2D, f: number, _n: number): void {
    this.bleed(ctx, '#040407');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.alpha(ctx, 0.1);
    ellipse(ctx, 320, 210, 300, 150, 0, '#5a2a18', NO, 0);
    for (let i = 0; i < 20; i++) {
      const t = (f * 0.5 + i * 41) % 420;
      this.alpha(ctx, 0.24 * (1 - t / 420));
      ellipse(
        ctx,
        hrange(i * 2.9, 30, 610) + Math.sin(f * 0.02 + i) * 9,
        380 - t,
        1.3, 1.3, 0, i % 3 === 0 ? GOLD : '#ff8a2a', NO, 0,
      );
    }
    ctx.restore();
    ctx.globalAlpha = this.a;
  }

  private titleCard(ctx: C2D, f: number, _n: number): void {
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';

    for (let i = 0; i < TITLE_LINES.length; i++) {
      const at = 8 + i * 20;
      const k = clamp((f - at) / 15, 0, 1);
      if (k <= 0) continue;
      const size = i === 0 ? 48 : 60;
      const y = i === 0 ? 158 : 216;
      const s = this.reduced ? 1 : lerp(2.4, 1, easeOutBack(k));

      ctx.save();
      ctx.translate(VIEW_W * 0.5, y);
      ctx.scale(s, s);
      ctx.globalAlpha = this.a * easeOut(clamp(k * 2.4, 0, 1));
      setFont(ctx, size, 900, true);
      ctx.lineWidth = 9;
      ctx.strokeStyle = INK;
      ctx.strokeText(TITLE_LINES[i], 0, 0);
      ctx.fillStyle = '#8a0f2e';
      ctx.fillText(TITLE_LINES[i], 0, 3);
      ctx.fillStyle = i === 0 ? PAPER : GOLD;
      ctx.fillText(TITLE_LINES[i], 0, 0);
      ctx.restore();
    }

    const sub = clamp((f - 52) / 22, 0, 1);
    if (sub > 0) {
      ctx.globalAlpha = this.a * easeOut(sub);
      setFont(ctx, 9, 700, false);
      ctx.fillStyle = DIM;
      ctx.fillText(TITLE_SUB, VIEW_W * 0.5, 250);
    }

    const hiho = clamp((f - 88) / 16, 0, 1);
    if (hiho > 0) {
      ctx.globalAlpha = this.a * easeOut(hiho);
      setFont(ctx, 15 + (this.reduced ? 0 : (1 - easeOut(hiho)) * 10), 900, true);
      ctx.fillStyle = BLOOD;
      ctx.fillText('HI HO.', VIEW_W * 0.5, 282);
    }

    ctx.globalAlpha = this.a;
    ctx.textAlign = 'left';
  }

  private beatsTitle(f: number, _n: number): void {
    if (f === 8) {
      this.sfx('ko', 0.75, 0.7);
      this.shake(8, 16);
      this.kick(0.06, 0.3, '#ffffff');
    } else if (f === 28) {
      this.sfx('super_blast', 0.85, 0.9);
      this.shake(12, 20);
      this.kick(0.1, 0.45, GOLD, 0.4);
    } else if (f === 52) {
      this.sfx('ui_select', 0.3, 1.2);
    } else if (f === 88) {
      this.sfx('meter_full', 0.5, 0.9);
      this.kick(0.03, 0.2, BLOOD);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chrome: bars, slug, skip hint, flash, fades
  // ─────────────────────────────────────────────────────────────────────────

  private outroT(): number {
    return clamp((this.frame - (this.total - BAR_OUT)) / BAR_OUT, 0, 1);
  }

  private chrome(ctx: C2D): void {
    const h = BAR_H * easeOut(clamp(this.frame / BAR_IN, 0, 1)) * (1 - easeIn(this.outroT()));

    // Slug, sitting just above where the bottom bar lands.
    const shot = STORYBOARD[this.shotIndex];
    if (shot.slug) {
      const inA = clamp(this.shotFrame / 26, 0, 1);
      const outA = 1 - clamp((this.shotFrame - 96) / 34, 0, 1);
      const a = Math.min(inA, outA) * 0.62;
      if (a > 0.01) {
        ctx.globalAlpha = a;
        setFont(ctx, 7.5, 700, false);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#05070c';
        ctx.fillText(shot.slug, 19, VIEW_H - BAR_H - 11);
        ctx.fillStyle = DIM;
        ctx.fillText(shot.slug, 18, VIEW_H - BAR_H - 12);
        ctx.globalAlpha = 1;
      }
    }

    if (h > 0.3) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, VIEW_W, h);
      ctx.fillRect(0, VIEW_H - h, VIEW_W, h);
    }

    // The way out. Never covers the picture: it lives in the bottom bar, and if
    // the bar has gone the cinematic is two seconds from ending anyway.
    if (this.skippable && h > 12) {
      const a = clamp((this.frame - HINT_AT) / HINT_FADE, 0, 1) * 0.5
        * (0.8 + 0.2 * Math.sin(this.frame * 0.045));
      if (a > 0.01) {
        ctx.globalAlpha = a;
        setFont(ctx, 7, 700, false);
        ctx.textAlign = 'right';
        ctx.fillStyle = FAINT;
        ctx.fillText('PRESS ANY KEY TO SKIP', VIEW_W - 16, VIEW_H - 11);
        ctx.textAlign = 'left';
        ctx.globalAlpha = 1;
      }
    }
  }

  private flash(ctx: C2D): void {
    if (this.flashA <= 0.005) return;
    ctx.globalAlpha = clamp(this.flashA, 0, 1);
    ctx.fillStyle = this.flashC;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;
  }

  private fade(ctx: C2D): void {
    const inA = 1 - easeOut(clamp(this.frame / FADE_IN, 0, 1));
    const outA = easeIn(clamp((this.frame - (this.total - FADE_OUT)) / FADE_OUT, 0, 1));
    const dark = Math.max(inA, outA);
    if (dark > 0.004) {
      ctx.globalAlpha = clamp(dark, 0, 1);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Getting out
  // ─────────────────────────────────────────────────────────────────────────

  private refreshPads(): void {
    const live = connectedGamepads();
    if (live.length === this.pads.length) return;
    for (const p of this.pads) p.dispose?.();
    this.pads.length = 0;
    // Sampled directly, never attached: a cutscene has no business rearranging
    // the input slots the player is about to fight with.
    for (const idx of live) this.pads.push(new GamepadSource(idx));
  }

  private pollSkip(): void {
    if (!this.skippable || this.done || this.frame < SKIP_LOCK) return;

    const input = this.host.input;
    for (const slot of input.slots) {
      if (input.get(slot).pressed !== 0) {
        this.skip();
        return;
      }
    }

    if (++this.padScan >= 15) {
      this.padScan = 0;
      this.refreshPads();
    }
    let mask = 0;
    for (const p of this.pads) mask |= p.sample(this.frame);
    if ((mask & ~this.padPrev) !== 0) {
      this.padPrev = mask;
      this.skip();
      return;
    }
    this.padPrev = mask;
  }

  private skip(): void {
    if (this.done || !this.skippable) return;
    if (this.frame < SKIP_LOCK) return;
    this.host.audio.play('ui_back', { gain: 0.5 });
    this.finish();
  }

  /** The one exit. Called exactly once, whether it ran or was walked out on. */
  private finish(): void {
    if (this.done) return;
    this.done = true;
    const cb = this.opts.onDone;
    if (cb) {
      cb();
      return;
    }
    // Nothing wired us up. Rather than sit on a black frame forever, go where
    // the cinematic was always going.
    this.host.goto?.('select');
  }
}
