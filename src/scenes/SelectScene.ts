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

import { GROUND_Y, MAX_LOCAL_PLAYERS, VIEW_H, VIEW_W, Z_SCALE } from '@/core/constants';
import { TAU, clamp, easeInOut, easeOut, easeOutBack } from '@/core/math';
import { randomSeed } from '@/engine/Rng';
import { KeyboardSource, installKeyboard } from '@/engine/input/KeyboardSource';
import { connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { DEFAULT_BINDINGS } from '@/engine/input/Bindings';
import { DWARFS, getDwarf } from '@/content/dwarfs';
import { WEAPONS } from '@/content/weapons';
import { CLIPS, blendPose, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { burst, poly, roundRect, star } from '@/render/Shapes';
import { Camera } from '@/render/Camera';
import { ParticleSystem } from '@/juice/Particles';
import { CutsceneScene } from '@/scenes/CutsceneScene';

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

const STAGE = { x: 10, y: 26, w: 226, h: 226 };
const INFO = { x: 242, y: 26, w: 388, h: 226 };
const FLOOR_Y = 236;
const RIG_SCALE = 3.0;

const ROSTER_X = 10;
const ROSTER_Y = 262;
const CARD_W = 85;
const CARD_H = 80;
const CARD_GAP = 4;
/** Frames a card's nudge animation runs for. */
const BUMP_FRAMES = 12;

const COL_L = INFO.x + 12;
const COL_R = 434;

const ACCENT = '#ff2e6e';
const ACCENT_DEEP = '#b8004a';
const GOLD = '#ffd23f';
const DIM = '#a2aabb';
const FAINT = '#6d768a';
const PAPER = '#eceff6';
const SURFACE = '#0d1018';
const OUTLINE = '#2c3242';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

const CURSOR_COLORS = ['#ff2e6e', '#ffd23f', '#6ee4ff', '#7cff8f'];
const REMOTE_COLOR = '#b98cff';

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

function setFont(ctx: C2D, size: number, weight: number, display: boolean, italic = false): void {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${display ? DISPLAY : SANS}`;
}

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

function tracked(ctx: C2D, s: string, x: number, y: number, gap: number, color: string): number {
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of [...s]) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + gap;
  }
  return cx - x - gap;
}

function wrap(ctx: C2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    // Trim the tail to an ellipsis rather than letting it run off the panel.
    let last = lines[maxLines - 1];
    if (ctx.measureText(last).width > maxW) {
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines;
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

    if (this.online && net) {
      net.onMessage(this.onNet);
      net.onPlayersChanged(this.onRoster);
    }
  }

  exit(): void {
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
    r.clear('#06070a');
    this.drawBackdrop(ctx, this.frame + alpha);
    this.drawHeader(ctx);
    this.drawStage(ctx, alpha);
    this.drawInfo(ctx);
    this.drawRoster(ctx);
    this.drawFooter(ctx);
    if (this.launch >= 0) this.drawLaunch(ctx);
    r.end();
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.goBack();
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
      color: CURSOR_COLORS[shade % CURSOR_COLORS.length],
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
      this.kick(0.09, 6, 0.34, ACCENT);
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
          color: CURSOR_COLORS[p.slot % CURSOR_COLORS.length],
          name: p.name,
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
    g.addColorStop(0, '#0a0b14');
    g.addColorStop(0.55, '#12101f');
    g.addColorStop(1, '#07070c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Hazard chevrons crawling behind everything, because this is a warehouse
    // and somebody is about to get hit with a chair.
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = ACCENT;
    const off = (t * 0.35) % 56;
    for (let x = -80; x < VIEW_W + 80; x += 56) {
      poly(
        ctx,
        [x + off, VIEW_H, x + off + 26, 0, x + off + 44, 0, x + off + 18, VIEW_H],
        ACCENT,
        'none',
        0,
      );
    }
    ctx.restore();
  }

  private drawHeader(ctx: C2D): void {
    setFont(ctx, 13, 900, true);
    tracked(ctx, 'CHOOSE YOUR FIGHTER', 12, 17, 2.2, PAPER);

    setFont(ctx, 8, 700, false);
    const net = this.game.net;
    const right = this.online && net
      ? `ONLINE · ${net.players.length} IN THE ROOM`
      : this.cursors.length > 1
        ? `LOCAL · ${this.cursors.length} PLAYERS`
        : 'SINGLE PLAYER';
    label(ctx, right, VIEW_W - 12, 16, this.online ? GOLD : FAINT, 'right');

    ctx.fillStyle = OUTLINE;
    ctx.fillRect(12, 21, VIEW_W - 24, 1);
  }

  private drawStage(ctx: C2D, alpha: number): void {
    const d = this.previewDwarf;
    const st = this.previewStyle;

    roundRect(ctx, STAGE.x, STAGE.y, STAGE.w, STAGE.h, 6, SURFACE, OUTLINE, 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(STAGE.x + 1, STAGE.y + 1, STAGE.w - 2, STAGE.h - 2);
    ctx.clip();

    // The dwarf's own name, enormous and ghostly, behind him.
    setFont(ctx, 44, 900, true);
    ctx.globalAlpha = 0.07;
    label(ctx, d.name, STAGE.x + STAGE.w * 0.5, 150, PAPER, 'center');
    ctx.globalAlpha = 1;

    // Backlight, and the pool of light he is standing in.
    const cx = STAGE.x + STAGE.w * 0.5;
    const glow = ctx.createRadialGradient(cx, 150, 8, cx, 150, 130);
    glow.addColorStop(0, `${d.style.jacketAccent}33`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(STAGE.x, STAGE.y, STAGE.w, STAGE.h);

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(cx, FLOOR_Y + 2, 62, 11, 0, 0, TAU);
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
      ctx.fillRect(STAGE.x, STAGE.y, STAGE.w, STAGE.h);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    this.drawOutfitMeter(ctx, st ? st.outfit : 0);
  }

  private drawOutfitMeter(ctx: C2D, outfit: number): void {
    const x = STAGE.x + 12;
    const w = STAGE.w - 24;
    const y = STAGE.y + STAGE.h - 14;

    setFont(ctx, 7, 700, false);
    label(ctx, 'TUNIC', x, y - 4, FAINT);
    label(ctx, 'LEATHER', x + w, y - 4, outfit > 0.9 ? GOLD : FAINT, 'right');

    roundRect(ctx, x, y, w, 4, 2, '#161a24', OUTLINE, 0.8);
    const fill = clamp(outfit, 0, 1) * w;
    if (fill > 1) {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#5f7a3c');
      g.addColorStop(0.55, ACCENT);
      g.addColorStop(1, GOLD);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, fill, 4);
    }
  }

  private drawInfo(ctx: C2D): void {
    const d = this.previewDwarf;
    roundRect(ctx, INFO.x, INFO.y, INFO.w, INFO.h, 6, SURFACE, OUTLINE, 1);

    // Name
    setFont(ctx, 22, 900, true);
    label(ctx, d.name, COL_L, 50, ACCENT);
    const nameW = ctx.measureText(d.name).width;
    ctx.fillStyle = ACCENT_DEEP;
    ctx.fillRect(COL_L, 54, nameW, 2);

    // The name he was christened with, struck out. He does not use it now.
    setFont(ctx, 9, 700, false);
    label(ctx, 'BORN AS', COL_L, 66, FAINT);
    const tagX = COL_L + ctx.measureText('BORN AS ').width;
    label(ctx, d.bornAs, tagX, 66, DIM);
    const bornW = ctx.measureText(d.bornAs).width;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tagX - 1, 63.5);
    ctx.lineTo(tagX + bornW + 1, 63.5);
    ctx.stroke();

    // Tagline
    setFont(ctx, 10, 700, false, true);
    label(ctx, `“${d.tagline}”`, COL_L, 82, GOLD);

    // Bio
    setFont(ctx, 9, 400, false);
    ctx.fillStyle = DIM;
    const bio = wrap(ctx, d.bio, INFO.w - 24, 3);
    for (let i = 0; i < bio.length; i++) label(ctx, bio[i], COL_L, 98 + i * 11, DIM);

    ctx.fillStyle = OUTLINE;
    ctx.fillRect(COL_L, 132, INFO.w - 24, 1);

    this.drawStats(ctx, d);
    this.drawSuper(ctx, d);
  }

  private drawStats(ctx: C2D, d: DwarfDef): void {
    setFont(ctx, 8, 900, true);
    tracked(ctx, 'FRAME DATA', COL_L, 146, 1.6, FAINT);

    const barX = COL_L + 54;
    const barW = 108;
    for (let i = 0; i < STATS.length; i++) {
      const s = STATS[i];
      const y = 158 + i * 14;
      setFont(ctx, 8, 700, false);
      label(ctx, s.label, COL_L, y + 5, DIM);

      const v = clamp((s.read(d) - s.min) / (s.max - s.min), 0, 1);
      const pips = 12;
      const on = Math.max(1, Math.round(v * pips));
      for (let p = 0; p < pips; p++) {
        const px = barX + p * (barW / pips);
        const lit = p < on;
        ctx.fillStyle = lit ? (p >= pips - 3 ? GOLD : ACCENT) : '#1d2230';
        ctx.fillRect(px, y, barW / pips - 1.6, 6);
      }
    }
  }

  private drawSuper(ctx: C2D, d: DwarfDef): void {
    setFont(ctx, 8, 900, true);
    tracked(ctx, 'SUPER', COL_R, 146, 1.6, FAINT);

    // A little charged glyph so the block reads as the special thing it is.
    burst(ctx, COL_R + 168, 143, 7, 7, ACCENT_DEEP, this.frame * 0.02);
    star(ctx, COL_R + 168, 143, 4, 5, GOLD, 'none');

    setFont(ctx, 12, 900, true);
    label(ctx, d.super.name, COL_R, 162, GOLD);

    setFont(ctx, 8.5, 400, false);
    const lines = wrap(ctx, d.super.description, 184, 4);
    for (let i = 0; i < lines.length; i++) label(ctx, lines[i], COL_R, 176 + i * 10, DIM);

    // Signature weapon chip
    const weapon = WEAPONS[d.signatureWeapon];
    setFont(ctx, 7, 900, true);
    tracked(ctx, 'SIGNATURE WEAPON', COL_R, 220, 1.4, FAINT);

    setFont(ctx, 8, 700, false);
    const wname = weapon.name.toUpperCase();
    const w = ctx.measureText(wname).width + 16;
    roundRect(ctx, COL_R, 226, w, 15, 7.5, '#171c28', OUTLINE, 1);
    label(ctx, wname, COL_R + 8, 237, weapon.damageScale >= 1.8 ? ACCENT : DIM);
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
      const y = ROSTER_Y - lift;

      const edge =
        lockedBy.length > 0
          ? lockedBy[0].color
          : hovering.length > 0
            ? hovering[0].color
            : remote.has(d.id)
              ? REMOTE_COLOR
              : OUTLINE;

      roundRect(ctx, x, y, CARD_W, CARD_H, 5, i === this.previewIndex ? '#141a26' : '#0b0e15', edge, hovering.length + lockedBy.length > 0 ? 1.6 : 1);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, CARD_W - 2, CARD_H - 2);
      ctx.clip();

      // Locked cards show the finished article; the rest are still in the tunic.
      const style: RigStyle = { ...d.style, outfit: lockedBy.length > 0 ? 1 : 0.08 };
      const pose = sampleClip(clipOf(lockedBy.length > 0 ? 'victory' : 'idle'), this.frame + i * 13);
      drawCharacter(ctx, style, pose, DWARF_SKELETON, x + CARD_W * 0.5, y + 62, 1, {
        scale: 0.95,
        alpha: i === this.previewIndex ? 1 : 0.78,
        tint: i === this.previewIndex ? undefined : '#9aa0b4',
      });
      ctx.restore();

      // Name band
      ctx.fillStyle = 'rgba(6,7,10,0.86)';
      ctx.fillRect(x + 1, y + CARD_H - 15, CARD_W - 2, 14);
      setFont(ctx, 8, 900, true);
      label(
        ctx,
        d.name,
        x + CARD_W * 0.5,
        y + CARD_H - 5,
        lockedBy.length > 0 ? GOLD : i === this.previewIndex ? PAPER : DIM,
        'center',
      );

      // Cursor chevrons above the card, one per player looking at it.
      let cx = x + 6;
      for (const c of hovering) {
        const bounce = c.locked ? 0 : Math.sin(this.frame * 0.16 + c.seat) * 1.4;
        if (c.locked === d.id) {
          roundRect(ctx, cx, y - 8 + bounce, 12, 6, 2, c.color, '#141019', 1);
          setFont(ctx, 5, 900, true);
          label(ctx, `P${c.seat + 1}`, cx + 6, y - 3.4 + bounce, '#141019', 'center');
        } else {
          poly(
            ctx,
            [cx, y - 3 + bounce, cx + 10, y - 3 + bounce, cx + 5, y + 3 + bounce],
            c.color,
            '#141019',
            1,
          );
        }
        cx += 14;
      }

      // Remote picks live on the right of the same strip.
      const rem = remote.get(d.id);
      if (rem) {
        let rx = x + CARD_W - 8;
        for (const p of rem) {
          ctx.fillStyle = REMOTE_COLOR;
          ctx.beginPath();
          ctx.arc(rx, y - 4, 4, 0, TAU);
          ctx.fill();
          setFont(ctx, 5, 900, true);
          label(ctx, String(p.slot + 1), rx, y - 2, '#141019', 'center');
          rx -= 10;
        }
      }
    }
  }

  private drawFooter(ctx: C2D): void {
    setFont(ctx, 7.5, 700, false);
    if (this.status) {
      label(ctx, this.status, 12, 354, GOLD);
    } else {
      label(
        ctx,
        '◄ ►  CHOOSE     LIGHT / JUMP  LOCK IN     HEAVY  BACK     DOWN  WATCH IT AGAIN',
        12,
        354,
        FAINT,
      );
    }

    const picked = this.cursors.filter((c) => c.locked).length;
    label(
      ctx,
      `${picked} / ${this.cursors.length} READY`,
      VIEW_W - 12,
      354,
      picked === this.cursors.length ? GOLD : FAINT,
      'right',
    );
  }

  private drawLaunch(ctx: C2D): void {
    const t = 1 - this.launch / LAUNCH_FRAMES;
    ctx.save();
    ctx.globalAlpha = 0.82 * easeOut(clamp(t * 4, 0, 1));
    ctx.fillStyle = '#040508';
    ctx.fillRect(0, ROSTER_Y - 14, VIEW_W, VIEW_H - ROSTER_Y + 14);
    ctx.globalAlpha = 1;

    const pop = easeOutBack(clamp(t * 3, 0, 1));
    setFont(ctx, 26 * pop + 2, 900, true);
    ctx.textAlign = 'center';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#141019';
    ctx.strokeText('HI HO', VIEW_W * 0.5, ROSTER_Y + 34);
    ctx.fillStyle = GOLD;
    ctx.fillText('HI HO', VIEW_W * 0.5, ROSTER_Y + 34);

    setFont(ctx, 9, 700, false);
    label(
      ctx,
      `MAP ${this.mapIndex} — SEVENTY BETWEEN YOU AND HIM`,
      VIEW_W * 0.5,
      ROSTER_Y + 52,
      DIM,
      'center',
    );
    ctx.restore();
  }
}

/** Convenience for the fight scene: resolve a pick back to its definition. */
export function dwarfForPick(pick: PlayerPick): DwarfDef {
  return getDwarf(pick.dwarfId);
}
