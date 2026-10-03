/**
 * Character select — the screen this whole game is an excuse for.
 *
 * Highlight a dwarf and the preview panel runs the transformation: he is
 * standing there in the 1937 tunic with his hands clasped, and then the leather
 * arrives. `style.outfit` is tweened 0 -> 1 underneath the `dress_*` clips, so
 * the jacket grows over the tunic, the studs pop through the shoulders, the
 * shades come out of the inside pocket and slide down onto the nose, and he
 * lands a pose he has absolutely not earned, holding his signature weapon.
 *
 * The hat never comes off. That is the joke: whatever he does to the rest of
 * it, he is still the same dwarf underneath, and everybody can tell.
 *
 * The whole screen is canvas, because it is driven by controllers rather than
 * by a pointer: four local cursors can move at once, each in its own colour,
 * and remote players' picks arrive live over the `pick` NetMessage.
 *
 * Input comes off the InputManager the Game already owns, so whichever pad or
 * keyboard a player chooses their dwarf with is the one they fight with.
 */

import type {
  AnimClip,
  DwarfDef,
  NetMessage,
  NetPlayer,
  ParticleSpec,
  Pose,
  RigStyle,
  Scene,
} from '@/core/types';
import { Btn } from '@/core/types';
import type { Game } from '@/Game';
import type { HomeParams } from '@/scenes/HomeScene';
import type { FightParams, FightPlayerPick } from '@/scenes/FightScene';

import { GROUND_Y, MAX_LOCAL_PLAYERS, TOTAL_MAPS, VIEW_H, VIEW_W, Z_SCALE } from '@/core/constants';
import { TAU, clamp, easeInOut, easeOut, easeOutBack } from '@/core/math';
import { randomSeed } from '@/engine/Rng';
import { KeyboardSource, installKeyboard } from '@/engine/input/KeyboardSource';
import { connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { DEFAULT_BINDINGS, codeForBit } from '@/engine/input/Bindings';
import { keyLabel } from '@/engine/input/Layout';
import { touchActive } from '@/engine/input/TouchControls';
import { DWARFS, getDwarf } from '@/content/dwarfs';
import { WEAPONS } from '@/content/weapons';
import { CLIPS, blendPose, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { burst, poly, star } from '@/render/Shapes';
import { Camera } from '@/render/Camera';
import { ParticleSystem } from '@/juice/Particles';
import { CutsceneScene } from '@/scenes/CutsceneScene';
import {
  PALETTE,
  band,
  displayFont,
  hintRow,
  inkText,
  playerColor,
  slab,
  textFont,
  trackedText,
} from '@/ui/theme';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// Scene contracts
// ─────────────────────────────────────────────────────────────────────────────

/** Params handed to `setScene('select', …)`. */
export interface SelectParams {
  /** Fighters choosing on this machine, 1..MAX_LOCAL_PLAYERS. Forced to 1 online. */
  localPlayers?: number;
  /** True when `game.net` is live and picks are shared with the room. */
  online?: boolean;
  /** Map the fight starts on. */
  mapIndex?: number;
}

/**
 * One chosen fighter. A superset of FightScene's own pick: the extra colour is
 * the cursor they locked in with, which the HUD reuses so the player they were
 * watching on this screen is the player they follow in the fight.
 */
export interface PlayerPick extends FightPlayerPick {
  slot: number;
  dwarfId: string;
  local: boolean;
  color: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout — authored against the 640x360 virtual screen
// ─────────────────────────────────────────────────────────────────────────────

/** The preview: no box. He stands in a pool of light on the backdrop itself. */
const STAGE = { x: 8, y: 34, w: 236, h: 220 };
const INFO = { x: 250, y: 34, w: 382, h: 220 };
const FLOOR_Y = 232;
const RIG_SCALE = 2.85;

const ROSTER_X = 8;
const ROSTER_Y = 264;
const CARD_GAP = 6;
const CARD_W = (VIEW_W - ROSTER_X * 2 - CARD_GAP * 6) / 7;
const CARD_H = 70;
/** Forward lean of every card: the italic of the display face, again. */
const CARD_LEAN = 6;
/** Frames a card's nudge animation runs for. */
const BUMP_FRAMES = 12;

const COL_L = INFO.x + 16;
const COL_R = INFO.x + 210;

const GOLD = PALETTE.lamp;
const DIM = PALETTE.boneDim;
const FAINT = PALETTE.boneFaint;
const PAPER = PALETTE.bone;
const INK = PALETTE.ink;

/** Online, a player who is not on this machine. Not a seat colour, on purpose. */
const REMOTE_COLOR = '#b9a7d9';

// ─────────────────────────────────────────────────────────────────────────────
// The transformation timeline
// ─────────────────────────────────────────────────────────────────────────────

/** Frames of insufferable wholesomeness before the leather turns up. */
const P_START = 34;
/** Lengths of the authored clips in render/rig/Anim.ts. */
const P_JACKET = 56;
const P_SHADES = 44;

const T_JACKET = P_START;
const T_SHADES = T_JACKET + P_JACKET;
const T_POSE = T_SHADES + P_SHADES;

/** Local frame of dress_jacket where both fists punch down the sleeves. */
const F_SNAP = 27;
/** Local frame of dress_shades where the lenses reach the bridge of the nose. */
const F_GLINT = 30;
/** Frames into the pose before the signature weapon is in his hand. */
const F_WEAPON = 8;

/**
 * A per-dwarf playback rate for the cues every transformation shares.
 *
 * Seven dwarfs dressing produced seven identical sound sequences with only the
 * final weapon differing, which reads as "it is the same sound for everyone".
 * Leaning on each dwarf's own VoiceProfile pitch makes Grumpy's leather land
 * heavier than Dopey's without needing seven bespoke cues.
 */
function voicePitch(d: DwarfDef): number {
  return clamp(0.78 + (d.voice.pitch - 70) / 260, 0.7, 1.4);
}

/**
 * The outfit blend, scheduled against the rig's own thresholds:
 *   jacket hem   cover  = fit * 1.25          (full at 0.80)
 *   studs        pop    = 0.28 -> 0.70
 *   cigar               = 0.35 -> 0.65
 *   shades slide        = 0.42 -> 0.76
 * The jacket phase therefore stops dead at 0.42, which is exactly where the
 * shades start moving — so nothing arrives before the clip that puts it there.
 */
function outfitAt(f: number): number {
  if (f < T_JACKET) return 0;
  if (f < T_SHADES) {
    const l = f - T_JACKET;
    const drape = 0.1 * easeInOut(clamp(l / 14, 0, 1));
    const snap = 0.32 * easeOut(clamp((l - 14) / 16, 0, 1));
    return drape + snap;
  }
  if (f < T_POSE) {
    const l = f - T_SHADES;
    return 0.42 + 0.44 * easeInOut(clamp((l - 8) / 26, 0, 1));
  }
  return 0.86 + 0.14 * easeOut(clamp((f - T_POSE) / 22, 0, 1));
}

function clipOf(name: string): AnimClip {
  return CLIPS[name] ?? CLIPS['idle'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

interface StatRow {
  label: string;
  read(d: DwarfDef): number;
  min: number;
  max: number;
}

/**
 * The dwarf's profile. Relative ratings across the roster, not frame data —
 * the old heading said FRAME DATA, which in a fighting game means startup,
 * active and recovery frames, and a player who knows the term was promised
 * something this panel does not show.
 */
const STATS: StatRow[] = [
  { label: 'STAMINA', read: (d) => d.stats.health, min: 76, max: 148 },
  { label: 'POWER', read: (d) => d.stats.power, min: 0.72, max: 1.52 },
  { label: 'SPEED', read: (d) => d.stats.speed, min: 0.64, max: 1.54 },
  { label: 'AIR', read: (d) => d.stats.jump, min: 0.72, max: 1.34 },
  { label: 'TECH', read: (d) => d.stats.tech, min: 0.56, max: 1.48 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Canvas text helpers
// ─────────────────────────────────────────────────────────────────────────────

function label(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function wrap(ctx: C2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !line) {
      line = next;
      used++;
      continue;
    }
    lines.push(line);
    if (lines.length === maxLines) break;
    line = w;
    used++;
  }
  if (lines.length < maxLines && line) lines.push(line);
  // Text that did not fit says so. A sentence that simply stops mid-thought
  // ("What comes out is a") reads as a bug, not as a cut.
  const truncated = used < words.length || lines.length > maxLines;
  if (truncated && lines.length > 0) {
    let last = lines[Math.min(lines.length, maxLines) - 1].replace(/[\s,;:.—-]+$/, '');
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1).trimEnd();
    lines[Math.min(lines.length, maxLines) - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursors
// ─────────────────────────────────────────────────────────────────────────────

interface Cursor {
  /** InputManager slot this cursor reads, and the fighter slot it becomes. */
  slot: number;
  /** Local player index, 0-based, for the P1/P2 badge. */
  seat: number;
  index: number;
  locked: string | null;
  color: string;
  dir: number;
  timer: number;
  /** Card-nudge animation, counts down. */
  bump: number;
}

const NAV_DELAY = 20;
const NAV_REPEAT = 7;
const MOVE_L = Btn.Left;
const MOVE_R = Btn.Right;
const CONFIRM = Btn.Light | Btn.Jump | Btn.Special;
const CANCEL = Btn.Heavy | Btn.Grab | Btn.Block;

/** Frames of drum-roll once everybody is locked in. */
const LAUNCH_FRAMES = 96;

export class SelectScene implements Scene {
  readonly name = 'select';

  private readonly game: Game;
  private readonly cam = new Camera();
  private readonly particles = new ParticleSystem();

  private frame = 0;
  private mapIndex = 1;
  private online = false;
  private seats = 1;

  private cursors: Cursor[] = [];

  private previewIndex = 0;
  private animFrame = 0;
  /** Style object handed to the rig; a copy so content/dwarfs.ts is never touched. */
  private previewStyle: RigStyle | null = null;

  private flashAlpha = 0;
  private flashColor = '#ffffff';
  private launch = -1;
  private launched = false;
  private status = '';

  constructor(game: Game) {
    this.game = game;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    installKeyboard();
    const p = (params ?? {}) as SelectParams;

    this.frame = 0;
    this.animFrame = 0;
    this.previewIndex = 0;
    this.launch = -1;
    this.launched = false;
    this.flashAlpha = 0;
    this.status = '';
    this.particles.clear();
    this.cam.x = 0;

    this.mapIndex = Math.max(1, Math.floor(p.mapIndex ?? 1));
    const net = this.game.net;
    this.online = p.online === true && !!net && net.role !== 'offline';
    // Lockstep gives each peer one slot; sharing a keyboard AND a wire at the
    // same time is a promise this netcode cannot keep.
    this.seats = this.online
      ? 1
      : clamp(Math.floor(p.localPlayers ?? 1), 1, MAX_LOCAL_PLAYERS);

    this.buildCursors();
    this.refreshPreview(this.cursors[0]?.index ?? 0, true);

    this.game.audio.music('select');
    this.game.canvas.addEventListener('pointerdown', this.onPointer);

    if (this.online && net) {
      net.onMessage(this.onNet);
      net.onPlayersChanged(this.onRoster);
    }
  }

  exit(): void {
    this.game.canvas.removeEventListener('pointerdown', this.onPointer);
    const net = this.game.net;
    if (net) {
      net.offMessage(this.onNet);
      net.offPlayersChanged(this.onRoster);
    }
    this.cursors = [];
    this.particles.clear();
  }

  update(_dt: number): void {
    this.frame++;
    this.animFrame++;

    // Game.step() has already sampled every attached source for this frame.
    for (const c of this.cursors) this.stepCursor(c);

    this.runTransformation();
    this.particles.update();
    this.cam.update();
    this.flashAlpha *= 0.86;
    if (this.flashAlpha < 0.004) this.flashAlpha = 0;

    this.stepLaunch();
  }

  render(alpha: number): void {
    const r = this.game.renderer;
    const ctx = r.ctx;

    r.begin();
    r.clear(PALETTE.coal);
    this.drawBackdrop(ctx, this.frame + alpha);
    this.drawHeader(ctx);
    this.drawStage(ctx, alpha);
    this.drawInfo(ctx);
    this.drawRoster(ctx);
    this.drawFooter(ctx);
    if (this.launch >= 0) this.drawLaunch(ctx);
    r.end();
  }

  /**
   * The menu keys every other screen answers to. This one only knew Escape —
   * the home screen said "Enter to choose", and Enter here did nothing at all.
   * Escape and Backspace now step back one level: a locked pick is unlocked
   * before anybody is thrown out to the title.
   */
  onKey(e: KeyboardEvent): void {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const c = this.cursors[0];
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      if (c && c.locked && !this.launched) this.unlock(c);
      else this.goBack();
      return;
    }
    if (e.key === 'Enter' && c && !this.launched) {
      e.preventDefault();
      this.lock(c);
    }
  }

  // ── Cursors ────────────────────────────────────────────────────────────────

  /**
   * One cursor per occupied input slot.
   *
   * Slots are dealt out by SEAT COUNT rather than from a fixed base. The
   * keyboard halves can only live on slots 0 and 1 — they are the slots whose
   * key maps exist, and whose split is what makes player two's keys player
   * two's — so the board keeps only as many of them as there are seats the pads
   * cannot cover, and the pads take everything above. Three people with three
   * controllers get three controllers; a fourth pad is no longer dropped on the
   * floor while its owner is handed half a keyboard.
   *
   * Online is different: the host decides which slot we are, and the player who
   * has been given slot 2 still expects to fight on WASD. So the local device is
   * moved onto whatever slot the room gave us, and every other slot is left
   * clear for lockstep to drive.
   */
  private buildCursors(): void {
    const bindings = this.game.save.settings.bindings;

    this.cursors = [];

    if (this.online) {
      const netSlot = clamp(Math.max(0, this.game.net?.slot ?? 0), 0, MAX_LOCAL_PLAYERS - 1);
      for (let s = 0; s < MAX_LOCAL_PLAYERS; s++) this.game.detachSlot(s);
      pollGamepads();
      const pad = connectedGamepads()[0];
      // Through Game either way, so the slot this room gave us is the slot the
      // pad comes back to if it drops out mid-match.
      if (pad !== undefined) {
        this.game.bindGamepad(netSlot, pad);
      } else {
        this.game.input.attach(netSlot, new KeyboardSource(0, bindings[0] ?? DEFAULT_BINDINGS[0]));
      }
      this.cursors.push(this.makeCursor(netSlot, 0));
      this.shareKeyboard();
      return;
    }

    // Hand out only as many keyboard halves as there are seats left over once
    // the pads have taken theirs. Game boots with both halves live so either can
    // join in at the menus; from here on, one person gets the whole board and
    // only a second person sharing it takes half of it away again.
    //
    // That count is also where the pads start, so every controller in the room
    // has a slot to land on. The floor of one keeps the board live beside a
    // player who chose with a pad — put the controller down and the keys still
    // work — and lifts only when four pads have turned up for four seats, when
    // there is neither a slot to spare nor anybody left wanting one.
    pollGamepads();
    const padCount = connectedGamepads().length;
    const keyboards =
      padCount >= MAX_LOCAL_PLAYERS && this.seats >= MAX_LOCAL_PLAYERS
        ? 0
        : clamp(this.seats - padCount, 1, 2);
    this.game.attachGamepads(keyboards);
    this.game.attachKeyboards(keyboards);

    // Pads before keyboard halves: two people with two controllers should not
    // end up elbowing each other over one keyboard.
    const padSlots: number[] = [];
    const keys: number[] = [];
    for (let s = 0; s < MAX_LOCAL_PLAYERS; s++) {
      const src = this.game.input.source(s);
      if (!src) continue;
      (src.kind === 'gamepad' ? padSlots : keys).push(s);
    }
    const available = [...padSlots, ...keys];
    if (available.length === 0) {
      this.game.attachKeyboards(1);
      available.push(0);
    }

    const seats = Math.min(this.seats, available.length);
    for (let i = 0; i < seats; i++) this.cursors.push(this.makeCursor(available[i], i));
    this.shareKeyboard();
  }

  /**
   * Say how many of these players are actually sharing one keyboard.
   *
   * Game boots with both keyboard halves attached so either of them can join in
   * at the menus, which is not the same question as how many people are typing
   * on this board — and the second question is the one that decides whether
   * player one keeps the arrows as a second movement diamond or hands them to
   * player two. One person, online or off, gets the whole keyboard; two people
   * on one board get half each.
   */
  private shareKeyboard(): void {
    let sharing = 0;
    for (const c of this.cursors) {
      if (this.game.input.source(c.slot)?.kind === 'keyboard') sharing++;
    }
    this.game.setLocalKeyboardCount(sharing);
  }

  /** One player, so every attached device is fair game to choose with. */
  private get solo(): boolean {
    return !this.online && this.cursors.length === 1;
  }

  private makeCursor(slot: number, seat: number): Cursor {
    // Colour follows the SEAT, not the input slot it happens to read. Player one
    // is red whether they chose on the keyboard at slot 0 or a pad at slot 2,
    // which is what the P1 badge printed inside the cursor already claims.
    // Online there is one seat per machine and the room's slot is the player
    // number, so there the slot is the thing that tells four peers apart.
    const shade = this.online ? slot : seat;
    return {
      slot,
      seat,
      index: Math.min(seat, DWARFS.length - 1),
      locked: null,
      color: playerColor(shade),
      dir: 0,
      timer: 0,
      bump: 0,
    };
  }

  private stepCursor(c: Cursor): void {
    if (this.launched) return;
    if (c.bump > 0) c.bump--;

    let mask = this.game.input.get(c.slot).held;
    let pressed = this.game.input.get(c.slot).pressed;

    if (this.solo) {
      // Whichever device you actually choose with is the one you fight with:
      // the cursor's slot follows the last thing that was pressed, and the slot
      // is what the fighter reads from. Plug a pad in and just use it.
      mask = 0;
      pressed = 0;
      for (const s of this.game.input.slots) {
        const f = this.game.input.get(s);
        mask |= f.held;
        pressed |= f.pressed;
        if (f.pressed !== 0) c.slot = s;
      }
    }

    if (pressed & Btn.Pause) {
      this.goBack();
      return;
    }

    if (pressed & CONFIRM) {
      this.lock(c);
      return;
    }
    if (pressed & CANCEL) {
      if (c.locked) this.unlock(c);
      else if (c.seat === 0) this.goBack();
      else this.game.audio.play('ui_error', { gain: 0.5 });
      return;
    }
    // A quiet favourite: nudge down to watch him get dressed all over again.
    if (pressed & Btn.Down) {
      this.refreshPreview(c.index, true);
      this.game.audio.play('ui_move', { gain: 0.6 });
      return;
    }

    if (c.locked) {
      c.dir = 0;
      return;
    }

    const dir = mask & MOVE_R ? 1 : mask & MOVE_L ? -1 : 0;
    if (dir === 0) {
      c.dir = 0;
      c.timer = 0;
      return;
    }
    if (c.dir !== dir) {
      c.dir = dir;
      c.timer = NAV_DELAY;
      this.moveCursor(c, dir);
      return;
    }
    if (--c.timer <= 0) {
      c.timer = NAV_REPEAT;
      this.moveCursor(c, dir);
    }
  }

  private moveCursor(c: Cursor, dir: number): void {
    const n = DWARFS.length;
    c.index = (c.index + dir + n) % n;
    c.bump = BUMP_FRAMES;
    this.game.audio.play('ui_move');
    this.refreshPreview(c.index, false);
  }

  private lock(c: Cursor): void {
    if (c.locked) {
      this.game.audio.play('ui_error', { gain: 0.5 });
      return;
    }
    const d = DWARFS[c.index];
    c.locked = d.id;
    c.bump = BUMP_FRAMES;
    this.refreshPreview(c.index, false);

    this.game.audio.play('ui_select');
    this.game.audio.voice(d.voice, 'taunt');
    this.kick(0.05, 4, 0.18, d.style.jacketAccent);

    const net = this.game.net;
    if (this.online && net) {
      net.send({ t: 'pick', slot: c.slot, dwarfId: d.id });
      net.send({ t: 'ready', slot: c.slot, ready: true });
    }
  }

  private unlock(c: Cursor): void {
    c.locked = null;
    c.bump = BUMP_FRAMES;
    this.launch = -1;
    this.game.audio.play('ui_back');
    const net = this.game.net;
    if (this.online && net) net.send({ t: 'ready', slot: c.slot, ready: false });
  }

  private goBack(): void {
    if (this.launched) return;
    this.game.audio.play('ui_back');
    // Backing out of an online select means backing out of the room, and the
    // link in the address bar has to go with it.
    if (this.online) this.game.leaveNet();
    const params: HomeParams = { view: this.online ? 'multiplayer' : 'menu' };
    this.game.setScene('home', params);
  }

  // ── Transformation ─────────────────────────────────────────────────────────

  private refreshPreview(index: number, force: boolean): void {
    if (!force && index === this.previewIndex) return;
    this.previewIndex = clamp(index, 0, DWARFS.length - 1);
    this.animFrame = 0;
    this.previewStyle = { ...DWARFS[this.previewIndex].style, outfit: 0, shades: false };
    this.particles.clear();
    this.flashAlpha = 0;
  }

  private get previewDwarf(): DwarfDef {
    return DWARFS[this.previewIndex];
  }

  /** Runs the schedule and fires the juice on the exact frames it lands on. */
  private runTransformation(): void {
    const d = this.previewDwarf;
    const st = this.previewStyle;
    if (!st) return;

    const f = this.animFrame;
    st.outfit = outfitAt(f);
    st.shades = d.style.shades && f >= T_SHADES;

    const reduced = this.game.save.settings.reducedMotion;
    const cx = STAGE.x + STAGE.w * 0.5;
    const z0 = (FLOOR_Y - GROUND_Y) / Z_SCALE;

    const vp = voicePitch(d);

    if (f === T_JACKET) {
      this.game.audio.play('drop', { gain: 0.7, pitch: 0.85 * vp });
    } else if (f === T_JACKET + F_SNAP) {
      // The jacket lands. Studs, leather and a small amount of gravel.
      this.game.audio.play('hit_metal', { gain: 0.75, pitch: vp });
      this.game.audio.play('punch_light', { gain: 0.5, pitch: vp });
      this.kick(0.03, 3.4, 0.22, d.style.jacketAccent);
      if (!reduced) {
        this.emit({
          count: 22,
          x: cx,
          y: 118,
          z: z0,
          angle: Math.PI * 0.5,
          spread: TAU,
          speed: [1.1, 3.4],
          life: [16, 34],
          size: [0.9, 2.1],
          colors: [d.style.jacketAccent, '#e6ebf5', d.style.jacketColor],
          gravity: 0.16,
          drag: 0.93,
          shape: 'shard',
          spin: 0.24,
        });
        this.emit({
          count: 14,
          x: cx,
          y: 128,
          z: z0,
          angle: Math.PI * 0.5,
          spread: 2.2,
          speed: [2.0, 4.4],
          life: [10, 20],
          size: [0.8, 1.5],
          colors: ['#ffffff', d.style.jacketAccent],
          gravity: 0.1,
          drag: 0.9,
          shape: 'spark',
          additive: true,
        });
      }
    } else if (f === T_SHADES + 2) {
      this.game.audio.play('dash', { gain: 0.55, pitch: 1.3 * vp });
    } else if (f === T_SHADES + F_GLINT) {
      // Lenses hit the nose. One hard white glint, and he can no longer see you.
      this.game.audio.play('meter_full', { gain: 0.8, pitch: vp });
      this.kick(0.028, 1.6, 0.5, '#ffffff');
      if (!reduced) {
        this.emit({
          count: 10,
          x: cx + 4,
          y: 158,
          z: z0,
          angle: 0.35,
          spread: 1.1,
          speed: [1.4, 3.0],
          life: [12, 24],
          size: [1.2, 2.6],
          colors: ['#ffffff', '#bcd4ff', GOLD],
          gravity: 0,
          drag: 0.88,
          shape: 'star',
          additive: true,
          spin: 0.3,
        });
      }
    } else if (f === T_POSE) {
      // The pose. Camera punch, floor ring, and whatever he calls a war cry.
      this.game.audio.play('super_charge', { gain: 0.85 });
      this.game.audio.voice(d.voice, 'taunt');
      this.kick(0.09, 6, 0.34, d.style.jacketAccent);
      if (!reduced) {
        this.emit({
          count: 3,
          x: cx,
          y: 2,
          z: z0,
          angle: 0,
          spread: 0,
          speed: [0.2, 0.6],
          life: [22, 30],
          size: [10, 17],
          colors: [d.style.jacketAccent, '#ffffff'],
          gravity: 0,
          drag: 1,
          shape: 'ring',
          additive: true,
        });
        this.emit({
          count: 26,
          x: cx,
          y: 6,
          z: z0,
          angle: Math.PI * 0.5,
          spread: 2.6,
          speed: [1.6, 4.6],
          life: [18, 40],
          size: [0.9, 2.0],
          colors: [d.style.jacketAccent, GOLD, '#ffffff'],
          gravity: 0.2,
          drag: 0.94,
          shape: 'spark',
          additive: true,
        });
      }
    } else if (f === T_POSE + F_WEAPON) {
      // The weapon is the punchline of the transformation, so it gets the stage
      // to itself — the generic pickup blip that used to play here competed
      // with it and made every dwarf sound the same.
      const w = WEAPONS[d.signatureWeapon];
      this.game.audio.play(w.sfx.reveal, { gain: 0.95, pitch: w.sfx.pitch ?? 1 });
      this.kick(0.02, 2, 0.12, GOLD);
    } else if (f === T_POSE + F_WEAPON + 7) {
      // A second beat as he swings it. Two notes are recognisable where one
      // buried in a sequence is not.
      const w = WEAPONS[d.signatureWeapon];
      this.game.audio.play(w.sfx.swing, {
        gain: 0.72,
        pitch: w.sfx.swingPitch ?? (w.sfx.pitch ?? 1) * 1.06,
      });
      this.game.audio.voice(d.voice, 'taunt');
    }
  }

  /** Camera punch + shake + a screen flash, all of it optional. */
  private kick(punch: number, shake: number, flash: number, color: string): void {
    const s = this.game.save.settings;
    if (s.reducedMotion) return;
    this.cam.punch(punch);
    this.cam.addShake({ magnitude: shake * clamp(s.screenShake, 0, 2), duration: 14 });
    this.flashAlpha = Math.max(this.flashAlpha, flash);
    this.flashColor = color;
  }

  private emit(spec: ParticleSpec): void {
    this.particles.emit(spec);
  }

  private poseFor(f: number): Pose {
    if (f < T_JACKET) return sampleClip(clipOf('dress_start'), f);
    if (f < T_SHADES) return sampleClip(clipOf('dress_jacket'), f - T_JACKET);
    if (f < T_POSE) return sampleClip(clipOf('dress_shades'), f - T_SHADES);

    const l = f - T_POSE;
    const pose = sampleClip(clipOf('dress_pose'), l);
    if (l >= 8) return pose;
    // dress_pose does not begin where dress_shades ends, so ease across the seam
    // instead of letting his arms teleport.
    return blendPose(sampleClip(clipOf('dress_shades'), P_SHADES), pose, easeInOut(l / 8));
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  private allLocalLocked(): boolean {
    return this.cursors.length > 0 && this.cursors.every((c) => c.locked !== null);
  }

  private roomReady(): boolean {
    const net = this.game.net;
    if (!this.online || !net) return true;
    const players = net.players;
    if (players.length === 0) return false;
    return players.every((p) => p.ready && p.dwarfId !== null);
  }

  private stepLaunch(): void {
    if (this.launched) return;

    const net = this.game.net;
    const iAmHost = !this.online || !net || net.role === 'host';

    if (!this.allLocalLocked() || !this.roomReady()) {
      this.launch = -1;
      this.status = this.statusLine();
      return;
    }
    // A guest never starts the match; it waits for the host's `start` so both
    // ends agree on the seed and the first frame.
    if (!iAmHost) {
      this.launch = -1;
      this.status = 'Waiting for the host to say go…';
      return;
    }

    if (this.launch < 0) {
      this.launch = LAUNCH_FRAMES;
      this.game.audio.play('super_charge', { gain: 0.5, pitch: 0.8 });
    }
    this.status = '';
    this.launch--;
    if (this.launch <= 0) {
      const seed = this.online && net ? net.seed || randomSeed() : randomSeed();
      if (this.online && net) {
        const inputDelay = net.recommendedInputDelay;
        this.game.lockstep?.configureDelay(inputDelay);
        // A room may start more than one fight with the same deterministic
        // world seed. The input epoch must still be fresh so late packets from
        // the prior fight can never share its frame numbers.
        const epoch = randomSeed() >>> 0;
        this.game.lockstep?.configureEpoch(epoch);
        net.send({ t: 'start', mapIndex: this.mapIndex, seed, startFrame: 0, inputDelay, epoch });
      }
      this.begin(seed, this.mapIndex);
    }
  }

  private statusLine(): string {
    if (!this.allLocalLocked()) return '';
    const net = this.game.net;
    if (!this.online || !net) return '';
    const waiting = net.players.filter((p) => !p.ready || p.dwarfId === null);
    if (waiting.length === 0) return '';
    if (net.players.length < 2) return 'Nobody else has arrived yet. The link still works.';
    return `Waiting on ${waiting.map((p) => p.name).join(', ')}…`;
  }

  private begin(seed: number, mapIndex: number): void {
    if (this.launched) return;
    this.launched = true;

    const picks = this.buildPicks();

    // Fold the choice into the run before the fight starts, so the victory and
    // game-over screens know who was fighting and the save file knows whose
    // high score it is.
    this.game.newRun({
      seed,
      mapIndex,
      online: this.online,
      slots: picks.map((p) => p.slot),
    });
    for (const p of picks) this.game.setDwarf(p.slot, p.dwarfId);

    const params: FightParams = {
      players: picks.map((p) => ({
        slot: p.slot,
        dwarfId: p.dwarfId,
        name: p.name,
        local: p.local,
        onPad: this.game.input.source(p.slot)?.kind === 'gamepad',
        seat: p.seat,
      })),
      mapIndex,
      seed,
    };
    this.game.audio.play('ko', { gain: 0.6, pitch: 1.4 });

    // The story runs at the top of the first map, every time a new game is
    // started — starting one is a deliberate act and the story is the point.
    // Retrying after a game over goes straight to 'fight' without passing
    // through here, so a death never costs you the exposition again. Skipped
    // with any key regardless.
    //
    // Online it runs too, on both screens. It used to be skipped outright,
    // because whoever finished first would walk into the fight and start
    // stalling on somebody still reading — so `waitForPeers` holds the fast one
    // on the last frame until everybody has seen it, and nobody arrives alone.
    if (mapIndex === 1) {
      this.game.setScene(
        new CutsceneScene(this.game, {
          waitForPeers: this.online,
          onDone: () => this.game.setScene('fight', params),
        }),
      );
      return;
    }

    this.game.setScene('fight', params);
  }

  private buildPicks(): PlayerPick[] {
    const picks: PlayerPick[] = [];
    const net = this.game.net;

    for (const c of this.cursors) {
      if (!c.locked) continue;
      const mine = this.online && net ? net.players.find((p) => p.slot === c.slot) : null;
      picks.push({
        slot: c.slot,
        dwarfId: c.locked,
        local: true,
        color: c.color,
        name: mine?.name ?? `Player ${c.seat + 1}`,
        // Online the room's slot IS the player number; offline the seat is.
        seat: this.online ? c.slot : c.seat,
      });
    }

    if (this.online && net) {
      const mySlots = new Set(picks.map((p) => p.slot));
      for (const p of net.players) {
        if (mySlots.has(p.slot) || !p.dwarfId) continue;
        picks.push({
          slot: p.slot,
          dwarfId: p.dwarfId,
          local: false,
          color: playerColor(p.slot),
          name: p.name,
          seat: p.slot,
        });
      }
    }

    picks.sort((a, b) => a.slot - b.slot);
    return picks;
  }

  // ── Net ────────────────────────────────────────────────────────────────────

  private readonly onNet = (m: NetMessage): void => {
    switch (m.t) {
      case 'pick': {
        // Somebody across the wire just committed. Say so.
        this.game.audio.play('ui_select', { gain: 0.45, pitch: 1.2 });
        break;
      }
      case 'start':
        this.begin(m.seed, m.mapIndex);
        break;
      case 'bye':
        this.launch = -1;
        this.game.audio.play('ui_error', { gain: 0.5 });
        break;
      default:
        break;
    }
  };

  private readonly onRoster = (_players: NetPlayer[]): void => {
    // The roster is read straight out of the session at draw time; this only
    // has to cancel a countdown that is no longer justified.
    if (!this.roomReady()) this.launch = -1;
  };

  // ── Drawing ────────────────────────────────────────────────────────────────

  private drawBackdrop(ctx: C2D, t: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#120e0c');
    g.addColorStop(0.6, '#0e0b0a');
    g.addColorStop(1, '#090706');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Hazard chevrons crawling behind everything, because this is a locker room
    // and somebody is about to get hit with a chair.
    ctx.save();
    ctx.globalAlpha = 0.035;
    const off = this.game.save.settings.reducedMotion ? 0 : (t * 0.3) % 56;
    for (let x = -80; x < VIEW_W + 80; x += 56) {
      poly(ctx, [x + off, VIEW_H, x + off + 26, 0, x + off + 44, 0, x + off + 18, VIEW_H], GOLD, 'none', 0);
    }
    ctx.restore();

    // The preview's light: a warm cone from above onto the spot he stands on,
    // tinted by his own jacket so every dwarf brings his colour on stage.
    const d = this.previewDwarf;
    const cx = STAGE.x + STAGE.w * 0.5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cone = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
    cone.addColorStop(0, 'rgba(255,190,90,0)');
    cone.addColorStop(1, 'rgba(255,190,90,0.10)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(cx - 34, 0);
    ctx.lineTo(cx + 34, 0);
    ctx.lineTo(cx + 104, FLOOR_Y + 4);
    ctx.lineTo(cx - 104, FLOOR_Y + 4);
    ctx.closePath();
    ctx.fill();
    const glow = ctx.createRadialGradient(cx, FLOOR_Y - 70, 10, cx, FLOOR_Y - 70, 150);
    glow.addColorStop(0, `${d.style.jacketAccent}2e`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(STAGE.x - 20, STAGE.y - 20, STAGE.w + 40, STAGE.h + 40);
    ctx.restore();
  }

  private drawHeader(ctx: C2D): void {
    inkText(ctx, 'CHOOSE YOUR FIGHTER', 14, 24, 17, PAPER, { weight: 900, italic: true, shadow: 1.6 });

    const net = this.game.net;
    const right = this.online && net
      ? `ONLINE · ${net.players.length} IN THE ROOM`
      : this.cursors.length > 1
        ? `SAME SCREEN · ${this.cursors.length} PLAYERS`
        : 'STORY · MAP ' + String(this.mapIndex).padStart(2, '0');
    ctx.font = displayFont(9, 800);
    const w = ctx.measureText(right).width + 18;
    slab(ctx, VIEW_W - 14 - w, 11, w, 14, 4, this.online ? GOLD : PALETTE.coal3, INK, 1.2);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.online ? PALETTE.onLamp : DIM;
    ctx.fillText(right, VIEW_W - 14 - w * 0.5 + 2, 21.5);

    // A lamp-gold hairline under the title, broken by a slab of the same.
    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(14, 30, VIEW_W - 28, 1);
    slab(ctx, 14, 29, 64, 3, 2, GOLD);
  }

  private drawStage(ctx: C2D, alpha: number): void {
    const d = this.previewDwarf;
    const st = this.previewStyle;
    const cx = STAGE.x + STAGE.w * 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.rect(STAGE.x - 8, STAGE.y, STAGE.w + 16, STAGE.h);
    ctx.clip();

    // His name, enormous, outlined and leaning, behind him. Fitted to the stage
    // width so PATIENT ZERO is not cut in half like SAWBONES used to be.
    const nameSize = Math.min(64, fitSize(ctx, d.name, STAGE.w - 6, 900, true));
    ctx.font = displayFont(nameSize, 900, true);
    ctx.textAlign = 'center';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(244,236,223,0.13)';
    ctx.strokeText(d.name, cx, STAGE.y + 104);
    ctx.fillStyle = 'rgba(244,236,223,0.035)';
    ctx.fillText(d.name, cx, STAGE.y + 104);

    // The spot on the floor.
    const pool = ctx.createRadialGradient(cx, FLOOR_Y + 2, 4, cx, FLOOR_Y + 2, 86);
    pool.addColorStop(0, 'rgba(255,200,120,0.22)');
    pool.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(cx, FLOOR_Y + 2, 86, 16, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(cx, FLOOR_Y + 2, 50, 8, 0, 0, TAU);
    ctx.fill();

    if (st) {
      const f = this.animFrame + alpha;
      const pose = this.poseFor(f);
      const weapon = f >= T_POSE + F_WEAPON ? WEAPONS[d.signatureWeapon] : null;

      ctx.save();
      const anchorY = FLOOR_Y - 62;
      ctx.translate(cx, anchorY);
      ctx.scale(this.cam.zoom, this.cam.zoom);
      ctx.translate(-cx + this.cam.shakeX, -anchorY + this.cam.shakeY);

      drawCharacter(ctx, st, pose, DWARF_SKELETON, cx, FLOOR_Y, 1, {
        weapon,
        scale: RIG_SCALE,
      });
      this.particles.render(ctx, this.cam);
      ctx.restore();
    }

    if (this.flashAlpha > 0.004) {
      ctx.globalAlpha = clamp(this.flashAlpha, 0, 1);
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(STAGE.x - 8, STAGE.y, STAGE.w + 16, STAGE.h);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    this.drawOutfitMeter(ctx, st ? st.outfit : 0);
  }

  private drawOutfitMeter(ctx: C2D, outfit: number): void {
    const x = STAGE.x + 22;
    const w = STAGE.w - 44;
    const y = STAGE.y + STAGE.h - 6;

    ctx.font = displayFont(7.5, 800);
    label(ctx, 'TUNIC', x, y - 4, FAINT);
    label(ctx, 'LEATHER', x + w, y - 4, outfit > 0.9 ? GOLD : FAINT, 'right');

    slab(ctx, x - 0.8, y - 0.8, w + 1.6, 5.6, 2, INK);
    slab(ctx, x, y, w, 4, 2, PALETTE.coal3);
    const fill = clamp(outfit, 0, 1) * w;
    if (fill > 1) {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#6c7a43');
      g.addColorStop(0.55, PALETTE.blood);
      g.addColorStop(1, GOLD);
      slab(ctx, x, y, fill, 4, 2, g);
    }
  }

  private drawInfo(ctx: C2D): void {
    const d = this.previewDwarf;
    slab(ctx, INFO.x, INFO.y, INFO.w, INFO.h, 0, 'rgba(20,17,16,0.88)', PALETTE.line, 1);
    // Registration mark in the corner, like the DOM panels.
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(INFO.x + INFO.w - 10, INFO.y);
    ctx.lineTo(INFO.x + INFO.w, INFO.y);
    ctx.lineTo(INFO.x + INFO.w, INFO.y + 10);
    ctx.closePath();
    ctx.fill();

    // Name, in whichever colour the cursor looking at him wears.
    const hover = this.cursors.find((c) => c.index === this.previewIndex);
    const tint = hover ? hover.color : GOLD;
    const nameSize = Math.min(30, fitSize(ctx, d.name, INFO.w - 34, 900, true));
    inkText(ctx, d.name, COL_L, INFO.y + 32, nameSize, tint, { weight: 900, italic: true, shadow: 2 });

    // The name he was christened with, struck out. He does not use it now.
    ctx.font = displayFont(9, 800);
    label(ctx, 'BORN AS', COL_L, INFO.y + 47, FAINT);
    const tagX = COL_L + ctx.measureText('BORN AS ').width + 2;
    label(ctx, d.bornAs.toUpperCase(), tagX, INFO.y + 47, DIM);
    const bornW = ctx.measureText(d.bornAs.toUpperCase()).width;
    ctx.fillStyle = PALETTE.blood;
    ctx.fillRect(tagX - 1.5, INFO.y + 43.5, bornW + 3, 1.6);

    // Tagline
    ctx.font = textFont(10, 700, true);
    label(ctx, `“${d.tagline}”`, COL_L, INFO.y + 64, PALETTE.lampHot);

    // Bio
    ctx.font = textFont(8.8, 500);
    const bio = wrap(ctx, d.bio, INFO.w - 32, 3);
    for (let i = 0; i < bio.length; i++) label(ctx, bio[i], COL_L, INFO.y + 80 + i * 11.5, DIM);

    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(COL_L, INFO.y + 116, INFO.w - 32, 1);

    this.drawStats(ctx, d);
    this.drawSuper(ctx, d);
  }

  private drawStats(ctx: C2D, d: DwarfDef): void {
    const top = INFO.y + 132;
    ctx.font = displayFont(8, 800);
    trackedText(ctx, 'PROFILE', COL_L, top, 2, GOLD);

    const barX = COL_L + 50;
    const segs = 10;
    const segW = 12;
    const segGap = 2;
    for (let i = 0; i < STATS.length; i++) {
      const s = STATS[i];
      const y = top + 9 + i * 14;
      ctx.font = displayFont(9, 800);
      label(ctx, s.label, COL_L, y + 6.5, PAPER);

      const v = clamp((s.read(d) - s.min) / (s.max - s.min), 0, 1);
      const on = Math.max(1, Math.round(v * segs));
      for (let p = 0; p < segs; p++) {
        const px = barX + p * (segW + segGap);
        const lit = p < on;
        slab(ctx, px, y, segW, 7, 2.5, lit ? (p >= segs - 2 ? PALETTE.lampHot : GOLD) : PALETTE.coal3);
      }
    }
  }

  private drawSuper(ctx: C2D, d: DwarfDef): void {
    const top = INFO.y + 132;
    ctx.font = displayFont(8, 800);
    trackedText(ctx, 'SUPER', COL_R, top, 2, GOLD);

    // A little charged glyph so the block reads as the special thing it is.
    burst(ctx, COL_R + 156, top - 3, 6.5, 7, PALETTE.bloodDeep, this.frame * 0.02);
    star(ctx, COL_R + 156, top - 3, 3.8, 5, PALETTE.lampHot, 'none');

    const nm = d.super.name.toUpperCase();
    const sz = Math.min(13, fitSize(ctx, nm, INFO.w - (COL_R - INFO.x) - 14, 900, true));
    inkText(ctx, nm, COL_R, top + 17, sz, PAPER, { weight: 900, italic: true, shadow: 1.4 });

    ctx.font = textFont(8.2, 500);
    const lines = wrap(ctx, d.super.description, INFO.w - (COL_R - INFO.x) - 14, 4);
    for (let i = 0; i < lines.length; i++) label(ctx, lines[i], COL_R, top + 30 + i * 10, DIM);

    // Signature weapon chip
    const weapon = WEAPONS[d.signatureWeapon];
    const cy = INFO.y + INFO.h - 15;
    ctx.font = displayFont(7.5, 800);
    trackedText(ctx, 'CARRIES', COL_R, cy + 3, 1.4, FAINT);
    const lx = COL_R + ctx.measureText('CARRIES').width + 14;
    ctx.font = displayFont(9, 800);
    const wname = weapon.name.toUpperCase();
    const w = ctx.measureText(wname).width + 16;
    slab(ctx, lx, cy - 7, w, 14, 3, PALETTE.coal3, PALETTE.lineStrong, 1);
    label(ctx, wname, lx + 9, cy + 3.4, weapon.damageScale >= 1.8 ? PALETTE.bloodHot : PAPER);
  }

  private drawRoster(ctx: C2D): void {
    const net = this.game.net;
    const remote = new Map<string, NetPlayer[]>();
    if (this.online && net) {
      for (const p of net.players) {
        if (!p.dwarfId) continue;
        // Our own pick already has a cursor on the card; do not badge it twice.
        if (this.cursors.some((c) => c.slot === p.slot)) continue;
        const list = remote.get(p.dwarfId) ?? [];
        list.push(p);
        remote.set(p.dwarfId, list);
      }
    }

    for (let i = 0; i < DWARFS.length; i++) {
      const d = DWARFS[i];
      const x = ROSTER_X + i * (CARD_W + CARD_GAP);
      const hovering = this.cursors.filter((c) => c.index === i);
      const lockedBy = this.cursors.filter((c) => c.locked === d.id);
      const bump = hovering.reduce((m, c) => Math.max(m, c.bump), 0);
      // Up on the press, back down on the release — a half sine, no discontinuity.
      const lift = bump > 0 ? Math.sin((bump / BUMP_FRAMES) * Math.PI) * 3.5 : 0;
      const y = ROSTER_Y - lift - (hovering.length > 0 ? 3 : 0);
      const focus = i === this.previewIndex;

      const edge =
        lockedBy.length > 0
          ? lockedBy[0].color
          : hovering.length > 0
            ? hovering[0].color
            : remote.has(d.id)
              ? REMOTE_COLOR
              : PALETTE.line;

      // Card: a leaning slab, his jacket colour bleeding up from the bottom.
      const bg = ctx.createLinearGradient(0, y, 0, y + CARD_H);
      bg.addColorStop(0, focus ? '#2a221d' : '#1a1513');
      bg.addColorStop(1, focus ? `${d.style.jacketAccent}55` : '#120f0d');
      slab(ctx, x, y, CARD_W, CARD_H, CARD_LEAN, bg, INK, 2.4);
      const active = hovering.length + lockedBy.length > 0;
      if (active) slab(ctx, x, y, CARD_W, CARD_H, CARD_LEAN, 'rgba(0,0,0,0)', edge, 2);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x + CARD_LEAN + 1, y + 1);
      ctx.lineTo(x + CARD_W + CARD_LEAN - 1, y + 1);
      ctx.lineTo(x + CARD_W - 1, y + CARD_H - 1);
      ctx.lineTo(x + 1, y + CARD_H - 1);
      ctx.closePath();
      ctx.clip();

      // Locked cards show the finished article; the rest are still in the tunic.
      // Cropped to head and shoulders: at card size a whole dwarf is a smudge,
      // and the hat and the face are what tell the seven apart.
      const style: RigStyle = { ...d.style, outfit: lockedBy.length > 0 ? 1 : 0.08 };
      const pose = sampleClip(clipOf(lockedBy.length > 0 ? 'victory' : 'idle'), this.frame + i * 13);
      drawCharacter(ctx, style, pose, DWARF_SKELETON, x + CARD_W * 0.5 + 3, y + CARD_H + 28, 1, {
        scale: 1.55,
        tint: focus || active ? undefined : '#8c8590',
      });
      ctx.restore();

      // Name band along the foot of the card.
      slab(ctx, x + 1, y + CARD_H - 15, CARD_W - 2, 14, 2.6, 'rgba(12,10,9,0.9)');
      ctx.font = displayFont(CARD_W < 80 ? 8.5 : 9.5, 800);
      label(
        ctx,
        d.name,
        x + CARD_W * 0.5 + 1,
        y + CARD_H - 4.5,
        lockedBy.length > 0 ? lockedBy[0].color : focus ? PAPER : DIM,
        'center',
      );

      // Cursor tags above the card, one per player looking at it.
      let tx = x + CARD_LEAN + 4;
      for (const c of hovering) {
        const bounce = c.locked ? 0 : Math.sin(this.frame * 0.16 + c.seat) * 1.2;
        const tag = c.locked === d.id ? `P${c.seat + 1} ✓` : `P${c.seat + 1}`;
        ctx.font = displayFont(7.5, 800);
        const tw = ctx.measureText(tag).width + 9;
        slab(ctx, tx, y - 11 + bounce, tw, 10, 2.5, c.color, INK, 1.2);
        ctx.textAlign = 'center';
        ctx.fillStyle = INK;
        ctx.fillText(tag, tx + tw * 0.5 + 1, y - 3.2 + bounce);
        tx += tw + 3;
      }

      // Remote picks live on the right of the same strip.
      const rem = remote.get(d.id);
      if (rem) {
        let rx = x + CARD_W + CARD_LEAN - 8;
        for (const p of rem) {
          ctx.fillStyle = REMOTE_COLOR;
          ctx.beginPath();
          ctx.arc(rx, y - 6, 4.5, 0, TAU);
          ctx.fill();
          ctx.font = displayFont(6.5, 800);
          label(ctx, String(p.slot + 1), rx, y - 3.6, INK, 'center');
          rx -= 11;
        }
      }
    }
  }

  private drawFooter(ctx: C2D): void {
    const y = VIEW_H - 9;
    if (this.status) {
      ctx.font = displayFont(9, 800);
      label(ctx, this.status.toUpperCase(), 14, y + 3, GOLD);
    } else {
      // The real keys, named the way this keyboard names them — or the pad's
      // own letters, if a pad is what this player last pressed.
      const pad = this.cursors[0] ? this.game.input.source(this.cursors[0].slot)?.kind === 'gamepad' : false;
      const k = (bit: number, fallback: string): string => this.keyName(bit, fallback);
      const items = touchActive()
        ? [
            { keys: ['TAP'], verb: 'CHOOSE' },
            { keys: ['TAP AGAIN'], verb: 'LOCK IN' },
            { keys: ['‹'], verb: 'BACK' },
          ]
        : pad
        ? [
            { keys: ['◀', '▶'], verb: 'CHOOSE' },
            { keys: ['A'], verb: 'LOCK IN' },
            { keys: ['B'], verb: 'BACK' },
            { keys: ['▼'], verb: 'WATCH AGAIN' },
          ]
        : [
            { keys: [k(Btn.Left, '◀'), k(Btn.Right, '▶')], verb: 'CHOOSE' },
            { keys: ['Enter', k(Btn.Light, 'F')], verb: 'LOCK IN' },
            { keys: ['Esc'], verb: 'BACK' },
            { keys: [k(Btn.Down, '▼')], verb: 'WATCH AGAIN' },
          ];
      hintRow(ctx, items, 14, y, 6.5);
    }

    const picked = this.cursors.filter((c) => c.locked).length;
    const all = picked === this.cursors.length;
    ctx.font = displayFont(9, 800);
    label(ctx, `${picked} / ${this.cursors.length} READY`, VIEW_W - 14, y + 3, all ? GOLD : FAINT, 'right');
  }

  /** What the first local player's key for an action actually says. */
  private keyName(bit: number, fallback: string): string {
    const c = this.cursors[0];
    const slot = c ? (c.slot <= 1 ? c.slot : 0) : 0;
    const map = this.game.save.settings.bindings[slot] ?? DEFAULT_BINDINGS[slot] ?? DEFAULT_BINDINGS[0];
    const code = codeForBit(map, bit);
    return code ? keyLabel(code) : fallback;
  }

  private drawLaunch(ctx: C2D): void {
    const t = 1 - this.launch / LAUNCH_FRAMES;
    ctx.save();
    const open = easeOut(clamp(t * 4, 0, 1));
    band(ctx, VIEW_W, ROSTER_Y + CARD_H * 0.5, CARD_H + 18, open, 'rgba(12,10,9,0.92)');

    const pop = easeOutBack(clamp(t * 3, 0, 1));
    ctx.globalAlpha = clamp(open * 1.4, 0, 1);
    inkText(ctx, 'HI HO', VIEW_W * 0.5, ROSTER_Y + 40, 12 + 22 * pop, GOLD, {
      align: 'center',
      weight: 900,
      italic: true,
      shadow: 2.4,
    });

    ctx.font = displayFont(9, 800);
    const left = TOTAL_MAPS - this.mapIndex + 1;
    trackedText(
      ctx,
      `MAP ${String(this.mapIndex).padStart(2, '0')}  ·  ${left} BETWEEN YOU AND HIM`,
      VIEW_W * 0.5,
      ROSTER_Y + 58,
      1.6,
      DIM,
      'center',
    );
    ctx.restore();
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  /**
   * Mouse and touch. The screen was controller-only, which was right for four
   * players on a couch and wrong for the person who opened a link and reached
   * for the mouse: click a card to look at him, click him again to take him.
   * Drives the first local cursor only — a pointer has no seat of its own.
   */
  private readonly onPointer = (e: PointerEvent): void => {
    if (this.launched || e.button !== 0) return;
    const c = this.cursors[0];
    if (!c) return;
    const rect = this.game.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const vx = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const vy = ((e.clientY - rect.top) / rect.height) * VIEW_H;

    for (let i = 0; i < DWARFS.length; i++) {
      const x = ROSTER_X + i * (CARD_W + CARD_GAP);
      if (vy < ROSTER_Y - 12 || vy > ROSTER_Y + CARD_H) continue;
      // The card leans, so its left edge moves with height.
      const lean = CARD_LEAN * (1 - (vy - ROSTER_Y) / CARD_H);
      if (vx < x + lean || vx > x + CARD_W + lean) continue;
      e.preventDefault();
      if (c.locked) {
        if (c.locked !== DWARFS[i].id) this.unlock(c);
        else return;
      }
      if (c.index === i) this.lock(c);
      else {
        c.index = i;
        c.bump = BUMP_FRAMES;
        this.game.audio.play('ui_move');
        this.refreshPreview(i, false);
      }
      return;
    }

    // A tap on the dwarf himself takes him, too.
    if (vx >= STAGE.x && vx <= STAGE.x + STAGE.w && vy >= STAGE.y && vy <= STAGE.y + STAGE.h) {
      e.preventDefault();
      if (!c.locked) this.lock(c);
    }
  };
}

/** The largest display size at which `s` fits in `maxW`. */
function fitSize(ctx: C2D, s: string, maxW: number, weight: number, italic: boolean): number {
  ctx.font = displayFont(100, weight, italic);
  const w = ctx.measureText(s).width;
  return w > 0 ? (100 * maxW) / w : 100;
}

/** Convenience for the fight scene: resolve a pick back to its definition. */
export function dwarfForPick(pick: PlayerPick): DwarfDef {
  return getDwarf(pick.dwarfId);
}
