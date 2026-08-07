/**
 * The map gallery — the wall.
 *
 * Seventy covers in a grid, one per map, and the ones you have actually been to
 * are the only ones with anything on them. That is the whole design: the wall
 * filling in IS the reward, so a map you have not reached still takes up its
 * square, drawn in the locked treatment, refusing to say what is on it.
 *
 * A cover is NOT a screenshot. `render/MapCover.ts` draws a suggestion — the
 * light, the shapes, the weather of a place — using the same MapPalette that
 * `game/Backdrop.ts` paints the real thing with, and nothing else. Standing in
 * a map for the first time should still be the first time.
 *
 * The screen is canvas rather than DOM for the same reason the character select
 * is: it is driven by a controller, it wants the game's own typography, and a
 * gallery bolted together out of buttons would look like a settings page. The
 * panel language, the fonts, the colours and the navigation feel are lifted
 * straight from `SelectScene` on purpose.
 *
 * WHAT THIS SCENE DOES NOT DO: start a fight. Selecting a map goes to character
 * select with that map index, exactly as the home screen's own start path does,
 * because the dwarf choice, the local-player count and the netplay handshake all
 * live down there and none of them are this screen's business.
 */

import type { MapDef, MapTheme, Scene, SceneName, VehicleSection } from '@/core/types';
import { Btn } from '@/core/types';

import { TOTAL_MAPS, VIEW_H, VIEW_W } from '@/core/constants';
import { clamp } from '@/core/math';

import { KeyboardSource, installKeyboard } from '@/engine/input/KeyboardSource';
import { GamepadSource, connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { DEFAULT_BINDINGS } from '@/engine/input/Bindings';

import { poly, roundRect, star } from '@/render/Shapes';
import { drawMapCover } from '@/render/MapCover';

import { getMap } from '@/content/maps';
import { bossForMap } from '@/content/bosses';
import { coverCopy } from '@/content/covers';

import type { SceneHost } from '@/scenes/FightScene';
import type { SelectParams } from '@/scenes/SelectScene';
import type { HomeParams } from '@/scenes/HomeScene';
import { nav } from '@/scenes/PauseScene';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────────────────────────────────────────────────────────
// Scene contract
// ─────────────────────────────────────────────────────────────────────────────

/** Params handed to the gallery. */
export interface GalleryParams {
  /** Where the cursor starts. */
  mapIndex?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout — authored against the 640x360 virtual screen
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW = { x: 10, y: 26, w: 250, h: 314 };
const COVER = { x: 18, y: 34, w: 234, h: 112 };
/** MapCover rounds its own card by `min(w, h) * 0.075`. Match it or it shows. */
const COVER_RADIUS = Math.min(COVER.w, COVER.h) * 0.075;
const COL_L = PREVIEW.x + 8;
const TEXT_W = PREVIEW.w - 16;

const GRID = { x: 268, y: 26, w: 362, h: 314 };

const COLS = 5;
const CELL_W = 64;
const CELL_H = 44;
const GAP_X = 7;
const GAP_Y = 8;
const PITCH = CELL_H + GAP_Y;
const ROWS = Math.ceil(TOTAL_MAPS / COLS);

/** The scrolling window the grid lives inside, inset from the grid panel. */
const VIEW = {
  x: GRID.x + 7,
  y: GRID.y + 8,
  w: COLS * CELL_W + (COLS - 1) * GAP_X,
  h: 298,
};

const CONTENT_H = ROWS * PITCH - GAP_Y;
const MAX_SCROLL = Math.max(0, CONTENT_H - VIEW.h);
/** Slack kept above and below the cursor so it never sits on the very edge. */
const SCROLL_PAD = 6;

const ACCENT = '#ff2e6e';
const ACCENT_DEEP = '#b8004a';
const GOLD = '#ffd23f';
const DIM = '#a2aabb';
const FAINT = '#6d768a';
const PAPER = '#eceff6';
const SURFACE = '#0d1018';
const SURFACE_DEEP = '#080a10';
const OUTLINE = '#2c3242';
const INK = '#141019';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

/** Frames the highlighted cover's nudge runs for. */
const BUMP_FRAMES = 12;
const NAV_DELAY = 20;
const NAV_REPEAT = 7;

const CONFIRM = Btn.Light | Btn.Jump;
const CANCEL = Btn.Heavy | Btn.Pause;
/** Shoulder buttons page the wall, because seventy maps is a lot of d-pad. */
const PAGE_UP = Btn.Grab;
const PAGE_DOWN = Btn.Block;

/** How long the "that one is locked" flash on the preview lasts. */
const DENY_FRAMES = 18;

// ─────────────────────────────────────────────────────────────────────────────
// Static strings. Built once so nothing in a draw path ever concatenates.
// ─────────────────────────────────────────────────────────────────────────────

const MAP_NUMBERS: string[] = buildNumbers();

function buildNumbers(): string[] {
  const out: string[] = [];
  for (let i = 1; i <= TOTAL_MAPS; i++) out.push(String(i));
  return out;
}

const THEME_LABEL: Record<MapTheme, string> = {
  tunnel: 'TUNNEL',
  factory: 'FACTORY FLOOR',
  server_farm: 'SERVER FARM',
  launchpad: 'LAUNCHPAD',
  mars_dome: 'MARS DOME',
  boardroom: 'BOARDROOM',
  social_feed: 'THE FEED',
  suburb: 'SUBURB',
  mine: 'MINE',
  forest: 'FOREST',
  gigafactory: 'GIGAFACTORY',
  orbit: 'ORBIT',
};

const VEHICLE_LABEL: Record<VehicleSection['kind'], string> = {
  moto: 'BIKE SECTION',
  cybertruck: 'TRUCK SECTION',
  hyperloop_pod: 'POD SECTION',
  rocket: 'ROCKET SECTION',
  // Never appears on a cover: scooters come from props, not from map sections.
  scooter: 'SCOOTER',
};

const HINTS =
  '◄ ▲ ▼ ►  BROWSE     LIGHT / JUMP  PLAY IT     HEAVY  BACK     L1 / R1  PAGE';

/** What a locked square is allowed to tell you, which is very little. */
const LOCKED_BODY = 'Nobody has been down here yet. Get there and it fills in.';
const LOCKED_BOSS = 'Something with a name is waiting at the end of it.';

// ─────────────────────────────────────────────────────────────────────────────
// Canvas text helpers — the same set SelectScene draws itself with
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
  for (const ch of s) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + gap;
  }
  return cx - x - gap;
}

/**
 * Word wrap into a caller-owned array.
 *
 * Writing into `out` rather than returning a fresh array is what lets the
 * preview cache its lines: wrapping happens once, when the cursor moves onto a
 * different map, and never again while it sits there.
 */
function wrapInto(ctx: C2D, s: string, maxW: number, maxLines: number, out: string[]): void {
  out.length = 0;
  if (!s) return;
  const words = s.split(/\s+/);
  let line = '';
  for (const w of words) {
    if (!w) continue;
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = w;
    if (out.length === maxLines) break;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines) {
    // Trim the tail to an ellipsis rather than letting it run off the panel.
    let last = out[maxLines - 1];
    if (ctx.measureText(last).width > maxW) {
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      out[maxLines - 1] = `${last}…`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class GalleryScene implements Scene {
  readonly name = 'gallery';

  private readonly host: SceneHost;
  private readonly initial: GalleryParams;

  private frame = 0;
  /** Index into the wall, 0-based. The map is this + 1. */
  private cursor = 0;
  private bump = 0;
  private deny = 0;
  /** Set the moment a transition is requested, so nothing fires it twice. */
  private leaving = false;

  private scroll = 0;
  private scrollTarget = 0;

  private dirX = 0;
  private dirY = 0;
  private timerX = 0;
  private timerY = 0;
  private prevMask = 0;
  /** False until the first frame's mask has been swallowed. See `readInput`. */
  private primed = false;

  /** This screen's own devices, so it never disturbs the game's slot map. */
  private keys: KeyboardSource[] = [];
  private readonly pads = new Map<number, GamepadSource>();
  private padScan = 0;

  // Preview text, wrapped once per selection change.
  private previewDirty = true;
  private previewFor = -1;
  private readonly nameLines: string[] = [];
  private readonly placeLines: string[] = [];
  private readonly moodLines: string[] = [];
  private readonly teaseLines: string[] = [];
  private numberLine = '';
  private statusLine = '';
  private bossName = '';

  private progressLine = '';

  /** Cached because a gradient built every frame is a gradient built 60 times. */
  private bgGrad: CanvasGradient | null = null;
  private fadeTop: CanvasGradient | null = null;
  private fadeBottom: CanvasGradient | null = null;

  /** Reused across every cover drawn this frame. Never reallocated. */
  private readonly coverOpts = {
    unlocked: true,
    cleared: false,
    frame: 0,
    focus: 0,
  };

  /** Scratch quad for the backdrop chevrons, so the draw path allocates none. */
  private readonly quad = [0, 0, 0, 0, 0, 0, 0, 0];

  constructor(host: SceneHost, params?: GalleryParams) {
    this.host = host;
    this.initial = params ?? {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    installKeyboard();

    const p = { ...this.initial, ...((params ?? {}) as GalleryParams) };

    this.frame = 0;
    this.bump = 0;
    this.deny = 0;
    this.leaving = false;
    this.dirX = 0;
    this.dirY = 0;
    this.timerX = 0;
    this.timerY = 0;
    this.prevMask = 0;
    this.primed = false;
    this.padScan = 0;
    this.bgGrad = null;
    this.fadeTop = null;
    this.fadeBottom = null;

    // No mapIndex means "show me where I got to", which is the only answer
    // anybody wants when they open a wall of seventy squares.
    const start = p.mapIndex ?? this.host.save.progress;
    this.cursor = clamp(Math.round(start) - 1, 0, TOTAL_MAPS - 1);
    this.previewDirty = true;
    this.previewFor = -1;

    this.progressLine = `${this.clearedCount()} / ${TOTAL_MAPS} CLEARED`;

    this.buildDevices();
    this.keepCursorInView();
    // The wall does not slide in from wherever it was left; it opens on you.
    this.scroll = this.scrollTarget;

    this.host.audio.music('menu');
  }

  exit(): void {
    for (const k of this.keys) k.dispose();
    this.keys = [];
    for (const p of this.pads.values()) p.dispose();
    this.pads.clear();
  }

  update(_dt: number): void {
    this.frame++;
    if (this.bump > 0) this.bump--;
    if (this.deny > 0) this.deny--;

    if (!this.leaving) this.readInput();
    this.stepScroll();
  }

  render(alpha: number): void {
    const r = this.host.renderer;
    const ctx = r.ctx;

    r.begin();
    r.clear('#06070a');
    this.drawBackdrop(ctx, this.frame + alpha);
    this.drawHeader(ctx);
    this.drawPreview(ctx);
    this.drawGrid(ctx);
    this.drawFooter(ctx);
    r.end();
  }

  onKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Everything on the movement diamond and the face buttons already arrives
    // through the bindings; only the keys nobody binds are handled here.
    switch (e.code) {
      case 'Escape':
      case 'Backspace':
        e.preventDefault();
        this.goBack();
        break;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        this.choose();
        break;
      case 'PageUp':
        e.preventDefault();
        this.pageBy(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        this.pageBy(1);
        break;
      case 'Home':
        e.preventDefault();
        this.setCursor(0);
        break;
      case 'End':
        e.preventDefault();
        this.setCursor(this.furthest());
        break;
      default:
        break;
    }
  }

  // ── Progress ───────────────────────────────────────────────────────────────

  /** Furthest map reached, 1..70. Everything at or below it is playable. */
  private get progress(): number {
    return clamp(Math.round(this.host.save.progress || 1), 1, TOTAL_MAPS);
  }

  private unlocked(index: number): boolean {
    return index <= this.progress;
  }

  /** True when the campaign has been taken all the way through at least once. */
  private get beaten(): boolean {
    const c = this.host.save.cleared;
    return Array.isArray(c) && c.length > 0;
  }

  /**
   * Beaten, not merely reached. `progress` is the map you are standing on, so
   * the ones behind it are the ones you actually put down.
   */
  private cleared(index: number): boolean {
    return this.beaten || index < this.progress;
  }

  /** 0-based index of the furthest unlocked square. */
  private furthest(): number {
    return this.progress - 1;
  }

  /**
   * Honest arithmetic: `progress` is the map you are ON, so the maps you have
   * actually finished are the ones behind it. Once the game has been beaten at
   * least once the last map counts too, which is the only way 70/70 is reachable
   * without lying about it.
   */
  private clearedCount(): number {
    if (this.beaten) return TOTAL_MAPS;
    return clamp(this.progress - 1, 0, TOTAL_MAPS);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /**
   * The gallery samples its own keyboard and pads.
   *
   * It could read whatever the InputManager happens to have attached — and it
   * does, on top of this — but the slot map belongs to whatever was played last,
   * and a screen you reach from the menu must work on a fresh boot, after an
   * online match that detached everything, and with a pad plugged in halfway
   * through. Owning private sources costs nothing and cannot disturb anyone.
   */
  private buildDevices(): void {
    for (const k of this.keys) k.dispose();
    this.keys = [];
    const bindings = this.host.save.settings.bindings;
    for (const slot of [0, 1]) {
      this.keys.push(new KeyboardSource(slot, bindings?.[slot] ?? DEFAULT_BINDINGS[slot]));
    }
    this.scanPads();
  }

  /** `connectedGamepads` polls itself if nothing else has, so this is safe cold. */
  private scanPads(): void {
    for (const index of connectedGamepads()) {
      if (!this.pads.has(index)) this.pads.set(index, new GamepadSource(index));
    }
  }

  private heldMask(): number {
    let mask = 0;
    for (const k of this.keys) mask |= k.sample(this.frame);
    for (const p of this.pads.values()) mask |= p.sample(this.frame);
    // Plus anything the game already had bound, so a slot claimed by a pad in a
    // previous fight still drives this screen.
    const input = this.host.input;
    for (const slot of input.slots) mask |= input.get(slot).held;
    return mask;
  }

  private readInput(): void {
    // A pad plugged in while the wall is open should just start working; a scan
    // twice a second is far cheaper than rebuilding the map every frame.
    if (--this.padScan <= 0) {
      this.padScan = 30;
      this.scanPads();
    }
    pollGamepads();

    const held = this.heldMask();
    // The button that opened the gallery is still down on the frame the gallery
    // opens. Swallowing the first mask is what stops it choosing a map with it.
    if (!this.primed) {
      this.primed = true;
      this.prevMask = held;
      return;
    }
    const pressed = held & ~this.prevMask;
    this.prevMask = held;

    if (pressed & CANCEL) {
      this.goBack();
      return;
    }
    if (pressed & CONFIRM) {
      this.choose();
      return;
    }
    if (pressed & PAGE_UP) {
      this.pageBy(-1);
      return;
    }
    if (pressed & PAGE_DOWN) {
      this.pageBy(1);
      return;
    }

    // A stick sets both a horizontal and a vertical bit long before it points
    // anywhere near a corner: the pad widens each cardinal to about 53° so a
    // fighter can walk flat along the floor, which is right for a fight and
    // wrong for a grid. Spend both bits in one frame and a flick 27° off
    // straight up costs a row AND a column, and at the right-hand edge the
    // horizontal wrap runs the wall as one long line and carries the cursor
    // across a row boundary as well. So the wall hands the cursor to one axis
    // at a time: whichever axis is already moving keeps it until it comes back
    // to neutral, and a flick that arrives on both at once is read as vertical,
    // because horizontal is the one that throws the cursor a whole row when it
    // guesses wrong.
    const hx = held & Btn.Right ? 1 : held & Btn.Left ? -1 : 0;
    const hy = held & Btn.Down ? 1 : held & Btn.Up ? -1 : 0;

    // Released first, so an axis let go of this frame hands over immediately
    // rather than holding the cursor for one frame it no longer wants.
    if (hx === 0) {
      this.dirX = 0;
      this.timerX = 0;
    }
    if (hy === 0) {
      this.dirY = 0;
      this.timerY = 0;
    }

    const useV = hy !== 0 && !(hx !== 0 && this.dirX !== 0);
    if (useV) {
      if (this.dirY !== hy) {
        this.dirY = hy;
        this.timerY = NAV_DELAY;
        this.moveV(hy);
      } else if (--this.timerY <= 0) {
        this.timerY = NAV_REPEAT;
        this.moveV(hy);
      }
    } else if (hx !== 0) {
      if (this.dirX !== hx) {
        this.dirX = hx;
        this.timerX = NAV_DELAY;
        this.moveH(hx);
      } else if (--this.timerX <= 0) {
        this.timerX = NAV_REPEAT;
        this.moveH(hx);
      }
    }
  }

  /** Left and right run the wall as one long line, so the ends meet. */
  private moveH(dir: number): void {
    this.setCursor((this.cursor + dir + TOTAL_MAPS) % TOTAL_MAPS);
  }

  /** Up and down stay in their column and wrap top to bottom. */
  private moveV(dir: number): void {
    const col = this.cursor % COLS;
    let row = Math.floor(this.cursor / COLS) + dir;
    if (row < 0) row = ROWS - 1;
    else if (row >= ROWS) row = 0;

    let next = row * COLS + col;
    // The last row can be short. Rather than land on nothing, fall through it.
    if (next >= TOTAL_MAPS) next = dir > 0 ? col : TOTAL_MAPS - 1;
    this.setCursor(clamp(next, 0, TOTAL_MAPS - 1));
  }

  /** A shoulder button moves a screenful of rows, not one. */
  private pageBy(dir: number): void {
    const rows = Math.max(1, Math.floor(VIEW.h / PITCH));
    const col = this.cursor % COLS;
    const row = Math.floor(this.cursor / COLS);
    const next = row + dir * rows;

    if (next < 0) {
      this.setCursor(0);
      return;
    }
    if (next >= ROWS) {
      this.setCursor(TOTAL_MAPS - 1);
      return;
    }
    this.setCursor(clamp(next * COLS + col, 0, TOTAL_MAPS - 1));
  }

  private setCursor(index: number): void {
    const next = clamp(index, 0, TOTAL_MAPS - 1);
    if (next === this.cursor) {
      this.keepCursorInView();
      return;
    }
    this.cursor = next;
    this.bump = BUMP_FRAMES;
    this.previewDirty = true;
    this.host.audio.play('ui_move');
    this.keepCursorInView();
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  /**
   * Hand the map to character select, exactly the way the home screen does.
   *
   * Nothing about the fight is decided here. Select owns the dwarf pick, the
   * number of people on the couch and the online handshake, and routing through
   * it is what keeps all three working from this screen.
   */
  private choose(): void {
    if (this.leaving) return;
    const index = this.cursor + 1;
    if (!this.unlocked(index)) {
      this.deny = DENY_FRAMES;
      this.host.audio.play('ui_error', { gain: 0.55 });
      return;
    }

    this.host.audio.play('ui_select');
    const params: SelectParams = { localPlayers: 1, online: false, mapIndex: index };
    this.leaving = true;
    if (!this.goto('select', params)) this.leaving = false;
  }

  private goBack(): void {
    if (this.leaving) return;
    this.host.audio.play('ui_back');
    const params: HomeParams = { view: 'menu' };
    this.leaving = true;
    if (!this.goto('home', params)) this.leaving = false;
  }

  private goto(name: SceneName, params: unknown): boolean {
    return nav.goto(this.host, name, params);
  }

  // ── Scrolling ──────────────────────────────────────────────────────────────

  private keepCursorInView(): void {
    const top = Math.floor(this.cursor / COLS) * PITCH;
    const bottom = top + CELL_H;
    if (top - SCROLL_PAD < this.scrollTarget) this.scrollTarget = top - SCROLL_PAD;
    else if (bottom + SCROLL_PAD > this.scrollTarget + VIEW.h) {
      this.scrollTarget = bottom + SCROLL_PAD - VIEW.h;
    }
    this.scrollTarget = clamp(this.scrollTarget, 0, MAX_SCROLL);
  }

  private stepScroll(): void {
    if (this.host.save.settings.reducedMotion) {
      this.scroll = this.scrollTarget;
      return;
    }
    const d = this.scrollTarget - this.scroll;
    if (Math.abs(d) < 0.25) {
      this.scroll = this.scrollTarget;
      return;
    }
    this.scroll += d * 0.24;
  }

  // ── Preview cache ──────────────────────────────────────────────────────────

  /**
   * Wrap everything the preview panel needs, once, when the selection changes.
   * Text measurement needs a context, so it happens at draw time — but only on
   * the frame after a move, never on the sixty frames the cursor sits still.
   */
  private layoutPreview(ctx: C2D): void {
    if (!this.previewDirty && this.previewFor === this.cursor) return;
    this.previewDirty = false;
    this.previewFor = this.cursor;

    const index = this.cursor + 1;
    const def = getMap(index);
    const open = this.unlocked(index);
    const boss = def.boss ? bossForMap(index) : null;

    this.numberLine = `MAP ${index}`;
    this.statusLine = !open ? 'LOCKED' : this.cleared(index) ? 'CLEARED' : 'WHERE YOU GOT TO';

    setFont(ctx, 12, 900, true);
    wrapInto(ctx, open ? def.name : '', TEXT_W, 2, this.nameLines);

    setFont(ctx, 8.5, 400, false);
    if (open) {
      const copy = coverCopy(index);
      wrapInto(ctx, copy.place, TEXT_W, 2, this.placeLines);
      wrapInto(ctx, copy.mood, TEXT_W, 2, this.moodLines);
      // The name is the trophy: it arrives only once the map is behind you.
      // Standing on the map you have reached but not beaten still gets the
      // tease, which is exactly what covers.ts wrote the two lines for.
      const done = this.cleared(index);
      this.bossName = boss && done ? boss.name : '';
      setFont(ctx, 8, 400, false, true);
      const line = boss ? (done ? copy.bossReveal : copy.bossTease) : undefined;
      wrapInto(ctx, line ?? '', TEXT_W, 2, this.teaseLines);
    } else {
      wrapInto(ctx, LOCKED_BODY, TEXT_W, 2, this.placeLines);
      this.moodLines.length = 0;
      this.bossName = '';
      setFont(ctx, 8, 400, false, true);
      wrapInto(ctx, boss ? LOCKED_BOSS : '', TEXT_W, 2, this.teaseLines);
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private drawBackdrop(ctx: C2D, t: number): void {
    if (!this.bgGrad) {
      const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      g.addColorStop(0, '#0a0b14');
      g.addColorStop(0.55, '#12101f');
      g.addColorStop(1, '#07070c');
      this.bgGrad = g;
    }
    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // The same hazard chevrons the select screen crawls behind its roster, so
    // the two screens read as rooms in the same building.
    ctx.save();
    ctx.globalAlpha = 0.045;
    const off = this.host.save.settings.reducedMotion ? 0 : (t * 0.3) % 56;
    const q = this.quad;
    for (let x = -80; x < VIEW_W + 80; x += 56) {
      q[0] = x + off;
      q[1] = VIEW_H;
      q[2] = x + off + 26;
      q[3] = 0;
      q[4] = x + off + 44;
      q[5] = 0;
      q[6] = x + off + 18;
      q[7] = VIEW_H;
      poly(ctx, q, ACCENT, 'none', 0);
    }
    ctx.restore();
  }

  private drawHeader(ctx: C2D): void {
    setFont(ctx, 13, 900, true);
    tracked(ctx, 'MAP GALLERY', 12, 17, 2.2, PAPER);

    setFont(ctx, 8, 700, false);
    const done = this.clearedCount();
    label(ctx, this.progressLine, VIEW_W - 12, 16, done >= TOTAL_MAPS ? GOLD : FAINT, 'right');

    // A hairline that fills in with you: the lit part is the campaign so far.
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(12, 21, VIEW_W - 24, 1);
    ctx.fillStyle = ACCENT_DEEP;
    ctx.fillRect(12, 21, ((VIEW_W - 24) * done) / TOTAL_MAPS, 1);
  }

  private drawPreview(ctx: C2D): void {
    this.layoutPreview(ctx);

    const index = this.cursor + 1;
    const def = getMap(index);
    const open = this.unlocked(index);

    roundRect(ctx, PREVIEW.x, PREVIEW.y, PREVIEW.w, PREVIEW.h, 6, SURFACE, OUTLINE, 1);

    // The cover, big. MapCover clips and rims itself, so nothing is drawn over
    // the top of it here — the panel it sits in is the only frame it needs.
    this.paintCover(ctx, def, index, COVER.x, COVER.y, COVER.w, COVER.h, 1);

    if (this.deny > 0) {
      // Same corner radius MapCover uses, so the refusal flashes the card and
      // not a square hole where the card is.
      ctx.save();
      ctx.globalAlpha = (this.deny / DENY_FRAMES) * 0.32;
      roundRect(ctx, COVER.x, COVER.y, COVER.w, COVER.h, COVER_RADIUS, ACCENT, 'none', 0);
      ctx.restore();
    }

    // Number, and where this square sits in the run.
    setFont(ctx, 9, 900, true);
    const numW = tracked(ctx, this.numberLine, COL_L, 159, 1.6, open ? GOLD : FAINT);
    setFont(ctx, 7, 700, false);
    label(ctx, this.statusLine, COL_L + numW + 10, 158, open ? DIM : FAINT);

    // Name. A locked map keeps its joke to itself.
    if (open) {
      setFont(ctx, 12, 900, true);
      for (let i = 0; i < this.nameLines.length; i++) {
        label(ctx, this.nameLines[i], COL_L, 174 + i * 13, ACCENT);
      }
    } else {
      this.drawRedaction(ctx, COL_L, 166);
    }

    ctx.fillStyle = OUTLINE;
    ctx.fillRect(COL_L, 194, TEXT_W, 1);

    let y = 204;
    y = this.drawBlock(ctx, open ? 'THE PLACE' : 'NOT YET', this.placeLines, y);
    if (this.moodLines.length > 0) y = this.drawBlock(ctx, 'THE MOOD', this.moodLines, y);

    if (def.boss) this.drawBossBlock(ctx, y, open);

    this.drawChips(ctx, def, open);
  }

  /** Label plus its wrapped body. Returns the y the next block starts at. */
  private drawBlock(ctx: C2D, name: string, lines: string[], y: number): number {
    setFont(ctx, 7, 900, true);
    tracked(ctx, name, COL_L, y, 1.4, FAINT);
    setFont(ctx, 8.5, 400, false);
    for (let i = 0; i < lines.length; i++) label(ctx, lines[i], COL_L, y + 11 + i * 10, DIM);
    return y + 11 + lines.length * 10 + 6;
  }

  private drawBossBlock(ctx: C2D, y: number, open: boolean): void {
    setFont(ctx, 7, 900, true);
    tracked(ctx, 'AT THE END', COL_L, y, 1.4, FAINT);

    // A small charged glyph, the same one the super block wears on select.
    star(ctx, PREVIEW.x + PREVIEW.w - 16, y - 3, 4.5, 5, GOLD, INK);

    let ty = y + 12;
    if (open && this.bossName) {
      setFont(ctx, 9, 900, true);
      label(ctx, this.bossName, COL_L, ty, ACCENT);
      ty += 11;
    }
    setFont(ctx, 8, 400, false, true);
    for (let i = 0; i < this.teaseLines.length; i++) {
      label(ctx, this.teaseLines[i], COL_L, ty + i * 9.5, open ? GOLD : FAINT);
    }
  }

  /**
   * Nothing about a map you have not reached.
   *
   * The cover art for a locked map is deliberately blank — drawLocked is not
   * even handed the MapDef, so it cannot leak a palette by accident. Printing
   * the theme underneath it undid that: the card said nothing and the caption
   * said SERVER FARM. The ride is hidden for the same reason — finding a bike
   * halfway through a map is the joke, and putting it on the cover spends it.
   */
  private drawChips(ctx: C2D, def: MapDef, open: boolean): void {
    const y = PREVIEW.y + PREVIEW.h - 22;
    let x = COL_L;
    if (!open) {
      this.chip(ctx, 'LOCKED', x, y, FAINT);
      return;
    }
    x += this.chip(ctx, THEME_LABEL[def.theme], x, y, DIM) + 6;
    if (def.vehicle) this.chip(ctx, VEHICLE_LABEL[def.vehicle.kind], x, y, GOLD);
  }

  private chip(ctx: C2D, text: string, x: number, y: number, color: string): number {
    setFont(ctx, 7, 700, false);
    const w = ctx.measureText(text).width + 14;
    roundRect(ctx, x, y, w, 14, 7, '#171c28', OUTLINE, 1);
    label(ctx, text, x + 7, y + 9.5, color);
    return w;
  }

  /** Blocks where the name would be. Whatever it says, you have not earned it. */
  private drawRedaction(ctx: C2D, x: number, y: number): void {
    ctx.fillStyle = '#1a1f2c';
    ctx.fillRect(x, y, 96, 7);
    ctx.fillRect(x + 102, y, 54, 7);
    ctx.fillRect(x, y + 11, 72, 7);
    ctx.fillRect(x + 78, y + 11, 108, 7);
  }

  private drawGrid(ctx: C2D): void {
    roundRect(ctx, GRID.x, GRID.y, GRID.w, GRID.h, 6, SURFACE, OUTLINE, 1);

    // Slack all round so the cursor ring, which sits outside its card, is not
    // shaved off in the first column or the top row.
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW.x - 4, VIEW.y - 4, VIEW.w + 8, VIEW.h + 8);
    ctx.clip();

    const first = Math.max(0, Math.floor(this.scroll / PITCH) * COLS);
    const last = Math.min(TOTAL_MAPS, (Math.floor((this.scroll + VIEW.h) / PITCH) + 1) * COLS);
    const reduced = this.host.save.settings.reducedMotion === true;
    const progress = this.progress;

    for (let i = first; i < last; i++) {
      const index = i + 1;
      const def = getMap(index);
      const open = index <= progress;
      const on = i === this.cursor;

      const cx = VIEW.x + (i % COLS) * (CELL_W + GAP_X);
      let cy = VIEW.y + Math.floor(i / COLS) * PITCH - this.scroll;
      // Up on the press, back down on the release — a half sine, no jump.
      if (on && this.bump > 0 && !reduced) {
        cy -= Math.sin((this.bump / BUMP_FRAMES) * Math.PI) * 2.5;
      }

      this.paintCover(ctx, def, index, cx, cy, CELL_W, CELL_H, on ? 1 : 0);

      // Number plate, bottom left, over whatever the cover put there. Inset and
      // rounded so it never pokes out through the card's own rounded corner.
      roundRect(ctx, cx + 1, cy + CELL_H - 12, 16, 11, 3, 'rgba(6,7,10,0.78)', 'none', 0);
      setFont(ctx, 7, 900, true);
      label(ctx, MAP_NUMBERS[i], cx + 9, cy + CELL_H - 4, open ? PAPER : FAINT, 'center');

      // Boss maps wear a star. Which map has one is public knowledge — every
      // fifth — so it costs nothing and gives the wall a rhythm.
      if (def.boss) {
        star(ctx, cx + CELL_W - 7, cy + 7, 4, 5, open ? GOLD : '#2a3040', INK);
      }

      // The cursor sits OUTSIDE the card. The cover already lights its own rim
      // in the map's accent when focused, and a second ring on top of that just
      // muddies it — this one is the game's pink, and it never touches the art.
      if (on) roundRect(ctx, cx - 2, cy - 2, CELL_W + 4, CELL_H + 4, 5, 'none', ACCENT, 1);
    }

    ctx.restore();
    this.drawEdgeFades(ctx);
    this.drawScrollbar(ctx);
  }

  /** Covers do not stop dead at the top and bottom of the window; they fade. */
  private drawEdgeFades(ctx: C2D): void {
    if (!this.fadeTop) {
      const g = ctx.createLinearGradient(0, VIEW.y - 4, 0, VIEW.y + 14);
      g.addColorStop(0, SURFACE);
      g.addColorStop(1, 'rgba(13,16,24,0)');
      this.fadeTop = g;
    }
    if (!this.fadeBottom) {
      const g = ctx.createLinearGradient(0, VIEW.y + VIEW.h + 4, 0, VIEW.y + VIEW.h - 14);
      g.addColorStop(0, SURFACE);
      g.addColorStop(1, 'rgba(13,16,24,0)');
      this.fadeBottom = g;
    }
    if (this.scroll > 1) {
      ctx.fillStyle = this.fadeTop;
      ctx.fillRect(VIEW.x - 4, VIEW.y - 4, VIEW.w + 8, 18);
    }
    if (this.scroll < MAX_SCROLL - 1) {
      ctx.fillStyle = this.fadeBottom;
      ctx.fillRect(VIEW.x - 4, VIEW.y + VIEW.h - 14, VIEW.w + 8, 18);
    }
  }

  private drawScrollbar(ctx: C2D): void {
    if (MAX_SCROLL <= 0) return;
    const x = GRID.x + GRID.w - 5;
    const h = VIEW.h;
    ctx.fillStyle = '#161a24';
    ctx.fillRect(x, VIEW.y, 2, h);

    const thumb = Math.max(18, (h * h) / CONTENT_H);
    const t = clamp(this.scroll / MAX_SCROLL, 0, 1);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(x, VIEW.y + (h - thumb) * t, 2, thumb);
  }

  /**
   * One call site for every cover on the screen, big or small.
   *
   * `focus` is MapCover's own highlight: it lights the card's rim, opens its
   * parallax and lets its lights blink. Reduced motion pins the frame counter at
   * zero rather than dropping focus — the card stays lit and picked out, it just
   * stops moving, which is the distinction the setting is actually about.
   */
  private paintCover(
    ctx: C2D,
    def: MapDef,
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    focus: number,
  ): void {
    const o = this.coverOpts;
    o.unlocked = this.unlocked(index);
    o.cleared = this.cleared(index);
    o.frame = this.host.save.settings.reducedMotion ? 0 : this.frame;
    o.focus = focus;
    drawMapCover(ctx, def, x, y, w, h, o);
  }

  private drawFooter(ctx: C2D): void {
    // A plate under the strip so the chevrons never crawl through the hints.
    ctx.fillStyle = SURFACE_DEEP;
    ctx.fillRect(0, 342, VIEW_W, VIEW_H - 342);

    setFont(ctx, 7.5, 700, false);
    label(ctx, HINTS, 12, 354, FAINT);

    const index = this.cursor + 1;
    const open = this.unlocked(index);
    label(
      ctx,
      open ? 'START A NEW GAME HERE' : 'KEEP DIGGING',
      VIEW_W - 12,
      354,
      open ? GOLD : FAINT,
      'right',
    );
  }
}
