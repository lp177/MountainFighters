/**
 * The heads-up display.
 *
 * Everything here is drawn in screen space at the virtual 640x360, and it has
 * exactly one hard requirement: it must stay readable with four dwarfs, a boss
 * and forty particles on screen at once. That is why the panels shrink instead
 * of overlapping, why every glyph is stroked in ink before it is filled, and why
 * the health bar drains in two stages — a fast red bar that tracks the real
 * number and a slow yellow chip behind it, so a combo reads as "he took THAT
 * much" rather than as a bar that simply moved.
 *
 * The HUD keeps a small amount of per-fighter animation state (chip drain, combo
 * pop, meter pulse, marker idle). It is stepped by the sim frame number the
 * caller hands in, not by wall clock, so a 144Hz display does not run the
 * animations at 144Hz. None of it feeds back into the simulation.
 *
 * It also owns the two things on screen that are not in a corner: the floating
 * player marker over each player's head, and the interact prompt above it. Both
 * live here because they have to agree with the panel about which colour a
 * player is, and because `drawHud` is already the game's screen-space layer —
 * see the PLAYER MARKERS section for how a screen-space overlay is pinned to a
 * world-space head.
 */

import type { Bone, BossDef, RigStyle, WeaponKind } from '@/core/types';
import type { Fighter } from '@/game/Fighter';
import type { InteractTarget, Level } from '@/game/Level';
import type { Camera } from '@/render/Camera';

import { Btn } from '@/core/types';
import { clamp, easeOutBack, lerp } from '@/core/math';
import {
  FIGHT_ZOOM,
  GROUND_Y,
  MAX_METER_BARS,
  TOTAL_MAPS,
  VIEW_H,
  VIEW_W,
  Z_DEPTH,
  Z_PERSPECTIVE,
  Z_SCALE,
} from '@/core/constants';
import { poly } from '@/render/Shapes';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { resolvePose } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { codeForBit, defaultBindingsFor } from '@/engine/input/Bindings';
import { keyLabel } from '@/engine/input/Layout';
import { connectedGamepads, padProfile } from '@/engine/input/GamepadSource';
import { touchActive } from '@/engine/input/TouchControls';
import { loadSave } from '@/engine/Save';
import { DWARFS } from '@/content/dwarfs';
import { BOSSES } from '@/content/bosses';
import {
  PALETTE,
  PLAYER_COLORS,
  displayFont,
  inkText,
  keycap,
  slab,
} from '@/ui/theme';

type C2D = CanvasRenderingContext2D;

export interface HudOptions {
  /** Score carried in from previous maps; `level.score` is added on top. */
  scoreBase?: number;
  /** Display name per fighter id. Falls back to the dwarf's bad-boy alias. */
  names?: Record<number, string>;
  /** Shown in the top strip, e.g. "03/70  SERVICE TUNNEL". */
  mapName?: string;
  mapIndex?: number;
  mapTotal?: number;
  /** Hide the whole thing during title cards and cutscenes. */
  hidden?: boolean;
  /**
   * Live keyboard bindings per local slot, for the interact prompt.
   *
   * Optional because the prompt has a working fallback (see `bindingsFor`), and
   * because a HUD that could only name a key when its caller remembered to hand
   * one over would print the wrong key most of the time. A caller that already
   * holds `Settings.bindings` should pass it: it is exact and it costs nothing.
   */
  bindings?: Record<number, Record<string, number>>;
  /**
   * Seat (0-based player number) per fighter id, as the select screen dealt
   * them. A pad can land on input slot 2 while being player ONE, so the slot is
   * not the player number; without this the marker over player one's head said
   * "3" and wore player three's colour.
   */
  seats?: Record<number, number>;
  /**
   * Hold the interact prompts. The map's title card is a full-width band over
   * the middle of the shot, and a DROP KNIFE pill poking out from under it is
   * the HUD talking over the one moment it should not.
   */
  quiet?: boolean;
}

// ── Palette ──────────────────────────────────────────────────────────────────
//
// Everything comes out of the shared theme. The HUD's own vocabulary on top of
// it: health is LAMP (what you have), the chip that drains behind it is BLOOD
// (what you just lost), meter is STEEL until a bar is full and then it is lamp
// too, because a full bar is a thing to press.

const INK = PALETTE.ink;
const PLATE = 'rgba(14,11,9,0.84)';
const PLATE_EDGE = 'rgba(244,236,223,0.10)';
const TRACK = '#2b2420';
const HEALTH_HI = '#ffd36b';
const HEALTH_LO = PALETTE.lamp;
const HEALTH_LOW = PALETTE.bloodHot;
const CHIP = PALETTE.blood;
const CHIP_LO = PALETTE.bloodDeep;
const METER_EMPTY = '#1a1d22';
const METER_FILL = PALETTE.steel;
const METER_FILL_LO = PALETTE.steelDeep;
const METER_FULL = PALETTE.lampHot;
const BOSS_HI = PALETTE.bloodHot;
const BOSS_LO = PALETTE.bloodDeep;
const TEXT = PALETTE.bone;
const TEXT_DIM = PALETTE.boneDim;
const LIFE = PALETTE.bone;
const DEAD = '#6b5f57';

/** Pre-built so the draw path never builds a string. */
const PLAYER_LABELS: readonly string[] = ['1', '2', '3', '4'];
const PLAYER_TAGS: readonly string[] = ['P1', 'P2', 'P3', 'P4'];

const PAD = 8;
const PANEL_W_MAX = 204;
const PANEL_H = 44;
const PANEL_GAP = 6;
const PORTRAIT_R = 15;
/** The forward lean of every HUD plate and bar: the italic of the display face. */
const LEAN = 5;
/** Health below this fraction turns red and starts to pulse. */
const LOW_HEALTH = 0.25;

/** Frames the chip bar hangs at the old value before it starts falling. */
const CHIP_HOLD = 16;
/** Fraction of the remaining gap the chip closes per frame, plus a floor. */
const CHIP_RATE = 0.055;
const CHIP_MIN = 0.0016;
/** Frames a finished combo readout lingers before it fades. */
const COMBO_LINGER = 46;

/** Fraction of the interact prompt's ease-in covered per frame. */
const PROMPT_RISE = 0.16;
/**
 * Frames the "you can put this down again" prompt is shown for.
 *
 * Re-armed only when the weapon in hand CHANGES, because dropping is the one
 * interact target that is always available while armed — left ungated it would
 * park a label over the player's head for the entire time they carry a bat,
 * which is the opposite of what a prompt is for.
 */
const DROP_HINT_FRAMES = 110;

// ── Per-fighter animation state ──────────────────────────────────────────────

interface HudState {
  chip: number;
  hold: number;
  health: number;
  combo: number;
  comboShown: number;
  comboLife: number;
  pop: number;
  bars: number;
  meterPulse: number;
  hurt: number;
  /** Frames since this player last did anything. Drives the marker fade. */
  markIdle: number;
  /** Which kind of controller this player last steered with. See `stepDevice`. */
  onPad: boolean;
  /** 0..1 ease-in of the interact prompt, restarted whenever it changes. */
  promptPop: number;
  /** What the prompt said last frame, so a different answer re-pops it. */
  promptKey: string;
  /** Weapon in hand last frame; a change re-arms the drop hint. */
  promptWeapon: WeaponKind | null;
  /** Frames the drop hint has left. See DROP_HINT_FRAMES. */
  dropHint: number;
  frame: number;
}

const states = new Map<number, HudState>();

/**
 * Slots the fight has told us are on a controller.
 *
 * The HUD used to work this out from the slot number, because pads were pinned
 * to slots two and three and nothing else could be there. The seat count now
 * decides where a pad lands, so the guess was wrong for the commonest case of
 * all — one player, one controller, slot zero. The fight knows; it says so.
 */
let padSlots: ReadonlySet<number> | null = null;

/** Told by the fight as it builds its players. See `padSlots`. */
export function setHudPadSlots(slots: ReadonlySet<number> | null): void {
  padSlots = slots;
}

function stateFor(id: number, healthFrac: number): HudState {
  let s = states.get(id);
  if (!s) {
    s = {
      chip: healthFrac,
      hold: 0,
      health: healthFrac,
      combo: 0,
      comboShown: 0,
      comboLife: 0,
      pop: 0,
      bars: 0,
      meterPulse: 0,
      hurt: 0,
      markIdle: 0,
      onPad: guessOnPad(id),
      promptPop: 0,
      promptKey: '',
      promptWeapon: null,
      dropHint: 0,
      frame: -1,
    };
    states.set(id, s);
  }
  return s;
}

/** Drop the animation state. Call between maps so a new fight starts clean. */
export function resetHud(): void {
  states.clear();
  padSlots = null;
  padCacheFrame = -1e9;
  bindingCacheFrame = -1e9;
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Display text as the HUD draws it. Thin ink outline plus a short drop shadow:
 * the old quarter-of-the-size outline closed the counters of every letter at
 * 8px and turned "MECHANICAL KEYBOARD" into a smudge.
 */
function text(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'left',
  weight = 800,
  italic = false,
): void {
  inkText(ctx, s, x, y, size, fill, { align, weight, italic });
}

/** Seat per fighter id for the current draw; see HudOptions.seats. */
let seatMap: Record<number, number> | null = null;

function digitsOf(n: number, width: number): string {
  const v = Math.max(0, Math.round(n));
  const s = String(v);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// ── Portrait ─────────────────────────────────────────────────────────────────

/**
 * A head-and-shoulders crop of the real character rig — no sprite sheet, the
 * same `drawCharacter` the fight uses, clipped to a disc and framed.
 */
function portrait(
  ctx: C2D,
  style: RigStyle,
  skeleton: Fighter['skeleton'],
  cx: number,
  cy: number,
  r: number,
  frame: number,
  dead: boolean,
  hurt: number,
  ring: string,
): void {
  // The disc sits on a ring of the player's colour, which is the same object as
  // the marker over their head and the ring at their feet, seen a third time.
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2.4, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.2, 0, Math.PI * 2);
  ctx.fillStyle = dead ? DEAD : ring;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.4, 0, Math.PI * 2);
  ctx.clip();

  const bg = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  bg.addColorStop(0, dead ? '#2a201d' : '#3a3029');
  bg.addColorStop(1, dead ? '#151110' : '#1a1512');
  ctx.fillStyle = bg;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  const clip = dead ? (CLIPS.knockdown ?? CLIPS.idle) : (CLIPS.idle ?? CLIPS.walk);
  if (clip) {
    const u = 0.7;
    // The dwarf rig puts the skull about 39 rig-units above the feet; anchoring
    // the ground point that far below the disc centres the face in the frame.
    const headUp = 39 * u;
    const pose = sampleClip(clip, frame * 0.42);
    drawCharacter(ctx, style, pose, skeleton, cx, cy + headUp, 1, {
      scale: u,
      flash: hurt,
      tint: dead ? '#4a403a' : undefined,
    });
  }

  ctx.restore();

  if (dead) text(ctx, 'K.O.', cx, cy + 3.5, 10, PALETTE.bloodHot, 'center', 900, true);
}

// ── Bars ─────────────────────────────────────────────────────────────────────

/**
 * A leaning bar segment filled to `frac`, from the left or (mirrored) from the
 * right. `hi` is the lit top half, `lo` the shaded bottom: a two-tone fill reads
 * as a physical tube at 7px where a gradient reads as mud.
 */
function bar(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  fromRight: boolean,
  hi: string,
  lo: string,
  lean = LEAN * (h / 10),
): void {
  const f = clamp(frac, 0, 1);
  if (f <= 0) return;
  const ww = Math.max(0.8, w * f);
  const bx = fromRight ? x + w - ww : x;
  slab(ctx, bx, y, ww, h, lean, lo);
  // The lit half: the same slab, cut to its upper half.
  const k = 0.5;
  ctx.beginPath();
  ctx.moveTo(bx + lean, y);
  ctx.lineTo(bx + ww + lean, y);
  ctx.lineTo(bx + ww + lean * (1 - k), y + h * k);
  ctx.lineTo(bx + lean * (1 - k), y + h * k);
  ctx.closePath();
  ctx.fillStyle = hi;
  ctx.fill();
}

// ── Player panel ─────────────────────────────────────────────────────────────

interface Slot {
  x: number;
  y: number;
  w: number;
  mirror: boolean;
}

function layout(n: number): Slot[] {
  const out: Slot[] = [];
  if (n <= 0) return out;

  if (n <= 2) {
    const w = PANEL_W_MAX;
    out.push({ x: PAD, y: PAD, w, mirror: false });
    if (n === 2) out.push({ x: VIEW_W - PAD - w, y: PAD, w, mirror: true });
    return out;
  }

  const w = Math.min(PANEL_W_MAX, (VIEW_W - PAD * 2 - PANEL_GAP * (n - 1)) / n);
  for (let i = 0; i < n; i++) {
    out.push({ x: PAD + i * (w + PANEL_GAP), y: PAD, w, mirror: false });
  }
  return out;
}

function dwarfName(f: Fighter): string {
  const a = f.archetype;
  const id = a.startsWith('dwarf_') ? a.slice(6) : a;
  const d = DWARFS.find((x) => x.id === id);
  return d ? d.name : id.toUpperCase();
}

/** Fighter keeps weapon wear private; the HUD only ever reads it. */
function weaponWear(f: Fighter): { left: number; max: number; ammo: number } {
  const raw = f as unknown as { weaponDurability?: number; weaponAmmo?: number };
  const def = f.weaponDef;
  return {
    left: typeof raw.weaponDurability === 'number' ? raw.weaponDurability : 0,
    max: def ? def.durability : 0,
    ammo: typeof raw.weaponAmmo === 'number' ? raw.weaponAmmo : 0,
  };
}

function stepState(
  s: HudState,
  f: Fighter,
  frame: number,
  target: InteractTarget | null = null,
): void {
  const steps = s.frame < 0 ? 1 : clamp(frame - s.frame, 0, 6);
  s.frame = frame;

  const hf = f.maxHealth > 0 ? clamp(f.health / f.maxHealth, 0, 1) : 0;

  // What counts as "doing something" for the marker fade: taking damage, dealing
  // damage, or being in any state but a standing idle. Read before the loop —
  // none of it can change inside a catch-up — and applied per step, so the count
  // that drives the fade is honestly in sim frames.
  const busy = hf < s.health || f.comboCount > s.combo || f.state !== 'idle';

  for (let i = 0; i < steps; i++) {
    s.markIdle = busy ? 0 : s.markIdle + 1;

    if (hf < s.health) {
      s.hold = CHIP_HOLD;
      s.hurt = 1;
    } else if (hf > s.health) {
      // Healed: the chip catches up instantly rather than lagging upward.
      s.chip = Math.max(s.chip, hf);
    }
    s.health = hf;

    if (s.hold > 0) s.hold--;
    else if (s.chip > hf) s.chip = Math.max(hf, s.chip - Math.max(CHIP_MIN, (s.chip - hf) * CHIP_RATE));
    if (s.chip < hf) s.chip = hf;

    if (s.hurt > 0) s.hurt = Math.max(0, s.hurt - 0.12);

    const c = f.comboCount;
    if (c > s.combo) {
      s.pop = 1;
      s.comboShown = c;
      s.comboLife = COMBO_LINGER;
    } else if (c === 0 && s.comboLife > 0) {
      s.comboLife--;
    }
    s.combo = c;
    if (s.pop > 0) s.pop = Math.max(0, s.pop - 0.085);

    const bars = Math.floor(f.meter);
    if (bars > s.bars) s.meterPulse = 1;
    s.bars = bars;
    if (s.meterPulse > 0) s.meterPulse = Math.max(0, s.meterPulse - 0.03);

    stepPrompt(s, f, target);
  }

  stepDevice(s, f);
}

function drawPanel(
  ctx: C2D,
  f: Fighter,
  slot: Slot,
  s: HudState,
  frame: number,
  lives: number,
  name: string,
  tag: string,
  superKey: string | null,
): void {
  const { x, y, w, mirror } = slot;
  const h = PANEL_H;
  const seat = playerIndex(f);
  const color = PLAYER_COLORS[seat];
  const alive = f.alive;

  /** Distance `o` from the portrait side of the panel. */
  const at = (o: number, width = 0): number => (mirror ? x + w - o - width : x + o);

  ctx.save();
  ctx.globalAlpha = 1;

  // The plate: one leaning slab, the portrait overlapping its near end.
  const plateX = at(PORTRAIT_R + 6, w - (PORTRAIT_R + 6));
  const plateW = w - (PORTRAIT_R + 6);
  slab(ctx, plateX, y + 3, plateW, h - 6, mirror ? -LEAN : LEAN, PLATE, INK, 1.4);
  // A hairline of the player's colour along the top edge.
  ctx.fillStyle = alive ? color : DEAD;
  ctx.globalAlpha = 0.9;
  slab(ctx, plateX + (mirror ? 0 : 2), y + 3, plateW - 2, 1.6, mirror ? -0.4 : 0.4, alive ? color : DEAD);
  ctx.globalAlpha = 1;
  ctx.fillStyle = PLATE_EDGE;
  ctx.fillRect(plateX + 6, y + h - 4.4, plateW - 12, 0.8);

  const pcx = at(PORTRAIT_R + 3);
  const pcy = y + h * 0.5;
  portrait(ctx, f.style, f.skeleton, pcx, pcy, PORTRAIT_R, frame, !alive, s.hurt * 0.7, color);

  const innerL = PORTRAIT_R * 2 + 12;
  const barW = w - innerL - 12;
  const barX = at(innerL, barW);
  const align: CanvasTextAlign = mirror ? 'right' : 'left';
  const nameX = mirror ? barX + barW : barX;
  const farX = mirror ? barX : barX + barW;
  const farAlign: CanvasTextAlign = mirror ? 'left' : 'right';

  // Name, with the player tag in their colour at the far end.
  text(ctx, name, nameX + (mirror ? -1 : 1), y + 14, 11, alive ? TEXT : DEAD, align, 800);
  const tagW = measure(ctx, tag, 8, 800);
  text(ctx, tag, farX, y + 13.5, 8, alive ? color : DEAD, farAlign, 800);

  // Lives, as little studs between the name and the tag.
  const pipR = 1.9;
  const shown = Math.min(5, lives);
  for (let i = 0; i < shown; i++) {
    const off = tagW + 6 + i * 5.5;
    const px = mirror ? farX + off : farX - off;
    ctx.beginPath();
    ctx.arc(px, y + 10.6, pipR + 0.9, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, y + 10.6, pipR, 0, Math.PI * 2);
    ctx.fillStyle = LIFE;
    ctx.fill();
  }
  if (lives > 5) {
    const off = tagW + 6 + shown * 5.5;
    text(ctx, `+${lives - 5}`, mirror ? farX + off : farX - off, y + 13, 7, TEXT_DIM, farAlign, 800);
  }

  // Health: chip behind, live bar in front, leaning with the plate.
  const hy = y + 18;
  const hh = 8;
  const hl = mirror ? -LEAN * 0.8 : LEAN * 0.8;
  slab(ctx, barX - 1, hy - 1, barW + 2, hh + 2, hl, INK);
  slab(ctx, barX, hy, barW, hh, hl, TRACK);
  bar(ctx, barX, hy, barW, hh, s.chip, mirror, CHIP, CHIP_LO, hl);
  const low = s.health <= LOW_HEALTH && alive;
  const throb = low ? 0.5 + 0.5 * Math.sin(frame * 0.24) : 0;
  bar(
    ctx,
    barX,
    hy,
    barW,
    hh,
    s.health,
    mirror,
    low ? mixHex(HEALTH_LOW, '#ffd0c6', throb * 0.5) : HEALTH_HI,
    low ? PALETTE.blood : HEALTH_LO,
    hl,
  );

  // Quarter ticks so "one more hit" is a readable position, not a guess.
  ctx.fillStyle = 'rgba(12,10,9,0.55)';
  for (let q = 1; q < 4; q++) {
    const tx = barX + barW * (mirror ? 1 - q / 4 : q / 4);
    ctx.beginPath();
    ctx.moveTo(tx + hl, hy);
    ctx.lineTo(tx + hl + 1, hy);
    ctx.lineTo(tx + 1, hy + hh);
    ctx.lineTo(tx, hy + hh);
    ctx.closePath();
    ctx.fill();
  }

  // Meter: MAX_METER_BARS leaning cells, steel while filling, lamp when full.
  const my = y + 29;
  const mh = 4;
  const segGap = 2.5;
  const segW = (barW * 0.62 - segGap * (MAX_METER_BARS - 1)) / MAX_METER_BARS;
  const ml = mirror ? -2 : 2;
  for (let i = 0; i < MAX_METER_BARS; i++) {
    const sx = mirror ? barX + barW - segW - i * (segW + segGap) : barX + i * (segW + segGap);
    const fillFrac = clamp(f.meter - i, 0, 1);
    slab(ctx, sx - 0.8, my - 0.8, segW + 1.6, mh + 1.6, ml, INK);
    slab(ctx, sx, my, segW, mh, ml, METER_EMPTY);
    if (fillFrac > 0) {
      const full = fillFrac >= 1;
      bar(ctx, sx, my, segW, mh, fillFrac, mirror, full ? METER_FULL : METER_FILL, full ? PALETTE.lamp : METER_FILL_LO, ml);
    }
  }
  if (f.meter >= 1 && alive) {
    // A full bar is a button to press, so the HUD names the button.
    const pulse = 0.6 + 0.4 * Math.sin(frame * 0.19);
    ctx.save();
    ctx.globalAlpha = 0.25 * pulse + s.meterPulse * 0.5;
    ctx.globalCompositeOperation = 'lighter';
    const gx = mirror ? barX + barW - barW * 0.62 : barX;
    slab(ctx, gx - 2, my - 2, barW * 0.62 + 4, mh + 4, ml, 'rgba(255,181,36,0.55)');
    ctx.restore();
    const lx = mirror ? barX + barW - barW * 0.62 - 4 : barX + barW * 0.62 + 4;
    ctx.save();
    ctx.globalAlpha = 0.75 + 0.25 * pulse;
    if (superKey) {
      const kw = measureCap(ctx, superKey, 5.5);
      const kx = mirror ? lx - kw : lx;
      keycap(ctx, superKey, kx, my + 2, 5.5, METER_FULL);
      text(ctx, 'SUPER', mirror ? kx - 3 : kx + kw + 3, my + 5, 7, METER_FULL, align, 800);
    } else {
      text(ctx, 'SUPER', lx, my + 5, 7, METER_FULL, align, 800);
    }
    ctx.restore();
  }

  // Weapon and what is left of it, on the bottom line.
  const wd = f.weaponDef;
  if (wd && alive) {
    const wear = weaponWear(f);
    const wy = y + 40.5;
    const label = wd.name.toUpperCase();
    const gw = Math.min(40, barW * 0.32);
    const gx = mirror ? barX : barX + barW - gw;
    const room = barW - gw - 6;
    text(ctx, fitText(ctx, label, 7, room), nameX, wy, 7, wd.art.accent, align, 800);
    if (wd.ammo !== undefined) {
      text(ctx, `${wear.ammo}`, mirror ? gx : gx + gw, wy, 8, wear.ammo > 0 ? TEXT : PALETTE.bloodHot, farAlign, 800);
    } else if (wear.max > 0) {
      const frac = clamp(wear.left / wear.max, 0, 1);
      slab(ctx, gx - 0.6, wy - 4.6, gw + 1.2, 3.8, ml * 0.5, INK);
      slab(ctx, gx, wy - 4, gw, 2.6, ml * 0.5, TRACK);
      bar(ctx, gx, wy - 4, gw, 2.6, frac, mirror, frac < 0.3 ? PALETTE.bloodHot : TEXT, frac < 0.3 ? PALETTE.blood : TEXT_DIM, ml * 0.5);
    }
  }

  // Combo counter, punched out under the panel.
  if (s.comboShown >= 2 && (f.comboCount > 0 || s.comboLife > 0)) {
    const fade = f.comboCount > 0 ? 1 : clamp(s.comboLife / COMBO_LINGER, 0, 1);
    const pop = easeOutBack(1 - s.pop);
    const size = (15 + Math.min(20, s.comboShown) * 0.45) * lerp(1.5, 1, pop);
    const cx = mirror ? x + w - 6 : x + 6;
    const cy = y + h + 8 + size * 0.78;
    ctx.save();
    ctx.globalAlpha = fade;
    const numW = measure(ctx, `${s.comboShown}`, size, 900, true);
    text(ctx, `${s.comboShown}`, cx, cy, size, PALETTE.lampHot, mirror ? 'right' : 'left', 900, true);
    const big = s.comboShown >= 10;
    text(
      ctx,
      big ? 'HIT COMBO!' : 'HITS',
      mirror ? cx - numW - 3 : cx + numW + 3,
      cy - 1,
      big ? 10 : 9,
      big ? PALETTE.bloodHot : TEXT,
      mirror ? 'right' : 'left',
      900,
      true,
    );
    ctx.restore();
  }

  ctx.restore();
}

function measure(ctx: C2D, s: string, size: number, weight = 800, italic = false): number {
  ctx.font = displayFont(size, weight, italic);
  return ctx.measureText(s).width;
}

/** Width a keycap of this label will take, without drawing it. */
function measureCap(ctx: C2D, label: string, size: number): number {
  ctx.font = displayFont(size, 800);
  return Math.max(size + 4, ctx.measureText(label).width + 6);
}

/** Truncate to fit, with an ellipsis. Weapon names are long; panels are not. */
function fitText(ctx: C2D, s: string, size: number, maxW: number): string {
  ctx.font = displayFont(size, 800);
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Mix two #rrggbb colours. Only the low-health throb uses it, once per frame. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = clamp(t, 0, 1);
  const r = Math.round(((pa >> 16) & 255) * (1 - k) + ((pb >> 16) & 255) * k);
  const g = Math.round(((pa >> 8) & 255) * (1 - k) + ((pb >> 8) & 255) * k);
  const bl = Math.round((pa & 255) * (1 - k) + (pb & 255) * k);
  return `rgb(${r},${g},${bl})`;
}

// ── Boss bar ─────────────────────────────────────────────────────────────────

function bossDefFor(f: Fighter): BossDef | null {
  return BOSSES.find((b) => b.id === f.archetype) ?? null;
}

function phaseIndex(def: BossDef, frac: number): number {
  let i = 0;
  while (i + 1 < def.phases.length && frac <= def.phases[i + 1].healthThreshold) i++;
  return i;
}

function drawBossBar(ctx: C2D, boss: Fighter, s: HudState, frame: number): void {
  const def = bossDefFor(boss);
  const w = 420;
  const x = (VIEW_W - w) * 0.5;
  const y = VIEW_H - 26;
  const h = 10;

  ctx.save();

  // The name sits on a blood-red slab breaking out of the bar's top-left: the
  // boss is the one thing in the HUD allowed to use the danger colour as a fill.
  const name = (def ? def.name : boss.archetype).toUpperCase();
  const nameW = measure(ctx, name, 12, 900, true);
  slab(ctx, x - 6, y - 17, nameW + 22, 15, 5, PALETTE.blood, INK, 1.4);
  text(ctx, name, x + 5, y - 5.5, 12, TEXT, 'left', 900, true);

  slab(ctx, x - 1.5, y - 1.5, w + 3, h + 3, 4, INK);
  slab(ctx, x, y, w, h, 4, TRACK);
  bar(ctx, x, y, w, h, s.chip, false, '#ffe2a0', PALETTE.lampDeep, 4);
  bar(ctx, x, y, w, h, s.health, false, BOSS_HI, BOSS_LO, 4);

  if (def && def.phases.length > 1) {
    const cur = phaseIndex(def, s.health);

    // Threshold notches on the bar itself: you can see the next gear coming.
    ctx.fillStyle = INK;
    for (let i = 1; i < def.phases.length; i++) {
      const t = clamp(def.phases[i].healthThreshold, 0, 1);
      const nx = x + w * t;
      ctx.beginPath();
      ctx.moveTo(nx + 4, y - 3);
      ctx.lineTo(nx + 5.6, y - 3);
      ctx.lineTo(nx + 1.6, y + h + 1);
      ctx.lineTo(nx, y + h + 1);
      ctx.closePath();
      ctx.fill();
    }

    // Phase pips: filled for phases reached, hollow for what is left. Hard
    // right, label anchored off their left edge so five phases never collide.
    const pips = def.phases.length;
    const pipGap = 9;
    const pipRight = x + w - 2;
    for (let i = 0; i < pips; i++) {
      const px = pipRight - (pips - 1 - i) * pipGap;
      const active = i <= cur;
      const pulse = i === cur ? 1 + 0.2 * Math.sin(frame * 0.22) : 1;
      const r = 3 * pulse;
      ctx.beginPath();
      ctx.moveTo(px, y - 10 - r - 1);
      ctx.lineTo(px + r + 1, y - 10);
      ctx.lineTo(px, y - 10 + r + 1);
      ctx.lineTo(px - r - 1, y - 10);
      ctx.closePath();
      ctx.fillStyle = INK;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px, y - 10 - r);
      ctx.lineTo(px + r, y - 10);
      ctx.lineTo(px, y - 10 + r);
      ctx.lineTo(px - r, y - 10);
      ctx.closePath();
      ctx.fillStyle = active ? (i === cur ? PALETTE.lampHot : BOSS_HI) : '#3a302a';
      ctx.fill();
    }
    text(
      ctx,
      `PHASE ${cur + 1}/${pips}`,
      pipRight - (pips - 1) * pipGap - 8,
      y - 6.5,
      8,
      TEXT_DIM,
      'right',
      800,
    );
  }

  ctx.restore();
}

// ── Player markers ───────────────────────────────────────────────────────────

/*
 * Four dwarfs in black leather, forty enemies, and a guard in a black suit that
 * reads as a dwarf at a glance. Without something over your own head you spend
 * the fight looking for yourself instead of playing it, which is why the genre
 * has drawn this exact marker since Final Fight. It is a requirement, not a
 * flourish.
 *
 * WHICH SPACE. `drawHud` runs inside `Renderer.withScreen`, so nothing here
 * shares the world transform: the marker is drawn at a fixed pixel size — the
 * right call, since a marker that grew with the zoom would be furniture — and
 * only its anchor is projected, by hand, through exactly the transform
 * `Renderer.withCamera` applies. Getting that wrong puts the chevron in a
 * plausible but subtly wrong place, so the maths below mirrors withCamera step
 * for step, including the shake and the fight's vertical framing.
 */

/** Screen px between the top of the head and the point of the chevron. */
const MARK_GAP = 5;
const MARK_CHEV_W = 10;
const MARK_CHEV_H = 6.5;
const MARK_NUM_SIZE = 10;
/** Extra px the marker floats up through on the idle bob. */
const MARK_BOB = 2.2;
const MARK_BOB_RATE = 0.075;
/** Frames of a player doing nothing before the marker starts dimming. */
const MARK_HOLD = 200;
const MARK_FADE = 45;
/** How far down it goes. Still findable if you look; no longer shouting. */
const MARK_DIM = 0.3;
/**
 * A jumping player near the front of the belt can push the marker off the top of
 * the screen and through the panels — the panels end at y = 52, and the digit
 * stands MARK_CHEV_H + the cap height above the tip. It stops here instead,
 * sitting on the head for the half second that costs.
 */
const MARK_MIN_TIP_Y = 72;

/**
 * The lift FightScene applies to the whole world layer inside the camera
 * transform, so the far edge of the walkable band survives FIGHT_ZOOM.
 *
 * Mirrored from `FightScene.FIGHT_FRAME_Y` — same constants, same fold, same
 * 10px of floor clearance — because that module imports this one and the value
 * therefore cannot travel the other way. A marker that ignored it would sit a
 * consistent 19 screen px above every head.
 */
const WORLD_FRAME_Y = Math.min(
  0,
  (VIEW_H * 0.5 - 10) / FIGHT_ZOOM + VIEW_H * 0.5 - (GROUND_Y + Z_DEPTH * Z_SCALE),
);

/** Reused by every chevron drawn in a frame. The draw path allocates nothing. */
const CHEVRON: number[] = [0, 0, 0, 0, 0, 0];

/** Rig height in rig units, per skeleton. Two entries, ever. */
const rigTops = new Map<Bone[], number>();

/**
 * How far above the feet the top of this rig reaches, in rig units at scale 1.
 *
 * Measured off the rest pose rather than guessed: the tallest bone tip is the
 * hat, which the art direction keeps on at every outfit blend, so that is the
 * silhouette the marker has to clear.
 *
 * Deliberately the REST pose and not the live one. A marker that tracked the
 * animated skull would drop on every crouch and duck under every uppercut — it
 * would read as a loose object rather than as a label, and it would cost a pose
 * resolve per player per frame. Holding the tallest the fighter can be means the
 * marker only ever floats a little high, never low. Cached: a dwarf and a human
 * are the only two skeletons in the game.
 */
function rigTop(skeleton: Bone[]): number {
  const cached = rigTops.get(skeleton);
  if (cached !== undefined) return cached;

  const bones = resolvePose(skeleton, {}, 1);
  let top = 0;
  for (const b of skeleton) {
    const r = bones.get(b.name);
    if (!r) continue;
    const tip = r.y + b.length * r.scale * Math.cos(r.rot);
    if (tip > top) top = tip;
  }
  rigTops.set(skeleton, top);
  return top;
}

/**
 * Fighter -> player number (0-based), for any slot number a lobby can hand out.
 * The seat the select screen dealt when the fight told us; the slot otherwise,
 * which is the same thing online and for a plain local game.
 */
function playerIndex(f: Fighter): number {
  const n = PLAYER_COLORS.length;
  const seat = seatMap?.[f.id] ?? f.id;
  return ((((seat | 0) % n) + n) % n) | 0;
}

/**
 * The camera the world was drawn with.
 *
 * Level is handed the very camera FightScene renders through, and reading it
 * back structurally is the same bargain `weaponWear` already strikes with the
 * fighter's private durability: the HUD only ever looks. The alternative was a
 * new required argument on a function every scene calls. No camera means no
 * projection is possible, and no marker is better than one in the wrong place.
 */
function cameraOf(level: Level): Camera | null {
  const cam = (level as unknown as { cam?: Camera | null }).cam;
  return cam && typeof cam.x === 'number' && typeof cam.zoom === 'number' ? cam : null;
}

/**
 * Reduced motion — live, and without widening a signature every scene calls.
 *
 * `Ui.setReducedMotion` already mirrors `Settings.reducedMotion` onto <html>, at
 * boot and again the instant the toggle flips; the ripple asks the same question
 * the same way. So a toggle in the pause menu stills the bob on the very next
 * frame, and the draw path reads a class instead of parsing a save.
 */
function holdStill(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('reduced-motion')
  );
}

function chevron(ctx: C2D, cx: number, tipY: number, fill: string, outline: string): void {
  CHEVRON[0] = cx - MARK_CHEV_W * 0.5;
  CHEVRON[1] = tipY - MARK_CHEV_H;
  CHEVRON[2] = cx + MARK_CHEV_W * 0.5;
  CHEVRON[3] = tipY - MARK_CHEV_H;
  CHEVRON[4] = cx;
  CHEVRON[5] = tipY;
  poly(ctx, CHEVRON, fill, outline, 1.1);
}

/**
 * Where the top of this fighter's head is on screen, written into HEAD.
 *
 * `f.drawPos` — not `f.pos` — is the anchor. pos is a whole simulation step
 * ahead of the interpolated body, which is eleven world units at the moment
 * someone leaves the ground; anything pinned to it would detach every time
 * somebody jumped.
 *
 * Returns false when the head is far enough off screen that nothing hung above
 * it could be seen. Shared by the marker and the interact prompt so the two can
 * never disagree about where a player's head is.
 */
const HEAD = { x: 0, y: 0 };

function headScreen(f: Fighter, cam: Camera): boolean {
  const d = f.drawPos;
  const zoom = cam.zoom > 0.05 ? cam.zoom : 1;
  // Rig scale, exactly as Fighter.render hands it to drawCharacter: the dwarf's
  // own scale times the belt's depth perspective. A dwarf standing at the back
  // wall is smaller, and their marker comes down to meet them. Far is z = 0, so
  // the falloff is measured from Z_DEPTH — the same fold Fighter.render uses.
  // (This read d.z directly once, which put the marker a hat's height into the
  // cap of anybody standing at the front of the belt.)
  const u = (f.style.scale || 1) * clamp(1 - (Z_DEPTH - d.z) * Z_PERSPECTIVE, 0.75, 1);

  // World -> camera space, with the head offset applied before the projection so
  // a rolled camera would carry the marker around with it.
  const cx = d.x - cam.x + cam.shakeX - VIEW_W * 0.5;
  const cy =
    GROUND_Y +
    d.z * Z_SCALE -
    d.y -
    rigTop(f.skeleton) * u +
    WORLD_FRAME_Y -
    cam.y +
    cam.shakeY -
    VIEW_H * 0.5;

  let sx = cx * zoom;
  let sy = cy * zoom;
  if (cam.rotation !== 0) {
    const c = Math.cos(cam.rotation);
    const sn = Math.sin(cam.rotation);
    const rx = sx * c - sy * sn;
    sy = sx * sn + sy * c;
    sx = rx;
  }
  HEAD.x = sx + VIEW_W * 0.5;
  HEAD.y = sy + VIEW_H * 0.5;

  return !(HEAD.x < -24 || HEAD.x > VIEW_W + 24 || HEAD.y > VIEW_H + 24);
}

/** One player's marker, pinned to the head the renderer has just drawn. */
function drawMarker(
  ctx: C2D,
  f: Fighter,
  s: HudState,
  cam: Camera,
  frame: number,
  still: boolean,
): void {
  // Players only. An enemy wearing one of these would be a lie.
  if (f.team !== 'player' || !f.alive) return;
  if (!headScreen(f, cam)) return;
  const sx = HEAD.x;
  const sy = HEAD.y;

  // Idle bob, one-sided so the marker only ever floats further from the head,
  // and phase-shifted per player so four of them do not pulse as one.
  const bob = still ? 0 : (Math.sin(frame * MARK_BOB_RATE + f.id * 1.9) * 0.5 + 0.5) * MARK_BOB;
  const tipY = Math.max(MARK_MIN_TIP_Y, sy - MARK_GAP - bob);

  // Full strength the instant they act or get hit; down to a whisper only after
  // a few seconds of a player who is doing nothing to anyone.
  const idle = s.markIdle - MARK_HOLD;
  const alpha = idle <= 0 ? 1 : lerp(1, MARK_DIM, clamp(idle / MARK_FADE, 0, 1));
  const idx = playerIndex(f);
  const color = PLAYER_COLORS[idx];
  const numY = tipY - MARK_CHEV_H - 2.5;

  ctx.save();
  ctx.globalAlpha = alpha;
  // A dropped shadow under the ink outline: white sparks and a lit Mars dome are
  // both perfectly capable of swallowing a 9px triangle otherwise.
  chevron(ctx, sx, tipY + 1.6, 'rgba(0,0,0,0.45)', 'none');
  chevron(ctx, sx, tipY, color, INK);
  text(ctx, PLAYER_LABELS[idx], sx, numY, MARK_NUM_SIZE, color, 'center');
  ctx.restore();
}

// ── The interact prompt ──────────────────────────────────────────────────────

/*
 * WHY THIS EXISTS AT ALL.
 *
 * Weapons used to be collected by walking over them, which silently did nothing
 * once your hands were full, and vehicles could not be mounted by any means.
 * There is now a key for all of it — but a key nobody is told about is a key
 * that does not exist, and the report that produced this feature was a player
 * saying, correctly, "we don't have a key for taking weapon on ground". They
 * had one by then. Nothing on screen said so.
 *
 * So: when a player is standing over something the button would act on, the
 * button and the verb float above their head. It goes above the player marker
 * rather than beside the item, because the item is at their feet, which is
 * exactly where the fight is; a label there would sit on top of the thing it is
 * describing.
 *
 * WHAT IT PRINTS. Never a hard-coded letter. The keyboard is bound by physical
 * POSITION (see Bindings.ts) and the label is read back through the
 * layout-aware `keyLabel`, so an AZERTY player is told to press the key their
 * board actually calls E, someone who rebound it is told about the key they
 * chose, and a player on a pad is told what THEIR pad prints on the trigger —
 * LT, ZL or L2, depending on whose hardware it is.
 */

/** Screen px between the top of the player marker and the bottom of the pill. */
const PROMPT_GAP = 4;
const PROMPT_H = 13;
const PROMPT_FONT = 7.5;
/**
 * How high the pill may climb before it is into the score and map strip.
 *
 * Rarely reached: interacting requires both feet on the floor, so the head it
 * hangs over is somewhere between y≈198 and y≈286 on the belt. It is here for
 * the mounted case and for anything that ever moves the camera.
 */
const PROMPT_MIN_Y = 86;

/**
 * Cached device facts.
 *
 * Both of the questions below — what is plugged in, and what is bound — have
 * answers that change perhaps twice in a session and would otherwise be asked
 * sixty times a second. They are re-asked on a slow timer instead, so a pad
 * plugged in or a key rebound mid-fight lands within a second, and the draw
 * path stays a draw path. Nothing here is asked at all unless a prompt is
 * actually on screen.
 */
const DEVICE_TTL = 45;
let padCache: number[] = [];
let padCacheFrame = -1e9;
let bindingCache: Record<number, Record<string, number>> | null = null;
let bindingCacheFrame = -1e9;

function stale(at: number, frame: number): boolean {
  return frame < at || frame - at >= DEVICE_TTL;
}

function padIndices(frame: number): number[] {
  if (stale(padCacheFrame, frame)) {
    try {
      padCache = connectedGamepads();
    } catch {
      padCache = [];
    }
    padCacheFrame = frame;
  }
  return padCache;
}

/**
 * The keyboard map for a slot.
 *
 * `opts.bindings` when the caller has the live settings; otherwise the saved
 * ones, which are what the live ones were written from — a rebind saves
 * immediately, so the two agree within the TTL above. Falling back to the
 * shipped defaults would print W to somebody who rebound it, which is the one
 * failure this whole path exists to avoid.
 */
function bindingsFor(
  slot: number,
  frame: number,
  override?: Record<number, Record<string, number>>,
): Record<string, number> {
  if (override) return override[slot] ?? defaultBindingsFor(slot);
  if (stale(bindingCacheFrame, frame)) {
    try {
      bindingCache = loadSave().settings.bindings;
    } catch {
      bindingCache = null;
    }
    bindingCacheFrame = frame;
  }
  return bindingCache?.[slot] ?? defaultBindingsFor(slot);
}

/**
 * A first guess at which controller a slot is holding, before they have moved.
 *
 * If the fight has told us which slots are on pads, that is not a guess at all
 * and we use it. Failing that: nothing plugged in means a keyboard whatever the
 * slot number says, and otherwise the high slots are the likelier pads. Either
 * way `stepDevice` corrects it on the first step the player takes.
 */
function guessOnPad(slot: number): boolean {
  if (padSlots) return padSlots.has(slot);
  let pads = 0;
  try {
    pads = connectedGamepads().length;
  } catch {
    pads = 0;
  }
  return pads > 0 && slot >= 2;
}

/**
 * Fighter latches whether its input claimed to be analog; the HUD only reads it,
 * the same bargain `weaponWear` strikes with weapon durability.
 */
function movedOnStick(f: Fighter): boolean {
  return (f as unknown as { analogMove?: boolean }).analogMove === true;
}

/**
 * Which controller is in this player's hands, decided by the only evidence that
 * reaches this far: `Btn.Analog`, which a pad sets on every frame it reports a
 * direction and a keyboard never sets at all.
 *
 * Latched rather than sampled, because the prompt has to be right while the
 * player is standing perfectly still over a bat — which is precisely when no
 * direction is being held and there is nothing to read. Walking under one's own
 * steam with the bit clear is equally good evidence the other way, so putting
 * the pad down and going back to the keyboard is handled too.
 */
function stepDevice(s: HudState, f: Fighter): void {
  if (movedOnStick(f)) {
    s.onPad = true;
    return;
  }
  const state = f.state;
  if (state === 'walk' || state === 'run' || state === 'dash') s.onPad = false;
}

/**
 * The button this player would press, named the way their own hardware names
 * it. Null when nothing can honestly be printed — better no prompt than a
 * prompt naming a key that does nothing.
 */
function interactButton(
  f: Fighter,
  s: HudState,
  frame: number,
  padOrder: number,
  opts?: HudOptions,
): string | null {
  return buttonLabel(f, s, frame, padOrder, Btn.Interact, 'l2', opts);
}

/**
 * The one control on the pad and the keyboard that a given action lives on,
 * named by the player's own hardware. Interact is the left trigger, Super the
 * right one; on a keyboard it is whatever key is bound right now.
 */
function buttonLabel(
  f: Fighter,
  s: HudState,
  frame: number,
  padOrder: number,
  bit: number,
  trigger: 'l2' | 'r2',
  opts?: HudOptions,
): string | null {
  // Player one on a phone: the button on the glass says USE and SUPER.
  if (touchActive() && !s.onPad && playerIndex(f) === 0) {
    return bit === Btn.Interact ? 'USE' : bit === Btn.Super ? 'SUPER' : null;
  }
  if (s.onPad) {
    // Pads are handed to slots in ascending order, so the nth pad-driven player
    // is holding the nth pad. Its vendor is what decides whether the trigger
    // says LT, ZL or L2 — the POSITION is the same on all of them.
    const pads = padIndices(frame);
    const index = pads.length > 0 ? pads[clamp(padOrder, 0, pads.length - 1)] : undefined;
    const p = index === undefined ? null : padProfile(index);
    if (p) {
      const button = trigger === 'l2' ? p.l2 : p.r2;
      const axis = trigger === 'l2' ? p.l2Axis : p.r2Axis;
      if (button >= 0 || typeof axis === 'number') return p.labels[trigger];
    }
    // The pad has been unplugged, or it reports no such trigger and therefore
    // cannot reach the action at all. Fall through to the keyboard: whoever is
    // still playing is playing on something, and it is not that.
  }
  const code = codeForBit(bindingsFor(f.id, frame, opts?.bindings), bit);
  return code ? keyLabel(code) : null;
}

/**
 * The last word of a weapon's name: 'Aluminium Bat' -> 'BAT', 'Length of
 * Rebar' -> 'REBAR'. A prompt is read at a glance in the middle of a fight, and
 * SWAP FOR MECHANICAL KEYBOARD is a sentence, not a glance.
 */
function shortNoun(label: string): string {
  const parts = label.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  return last.length > 0 ? last : label;
}

/** What the press would do, in the fewest words that stay unambiguous. */
function promptVerb(t: InteractTarget): string {
  switch (t.action) {
    case 'swap':
      return `SWAP FOR ${shortNoun(t.label)}`;
    case 'drop':
      return `DROP ${shortNoun(t.label)}`;
    case 'mount':
      return 'RIDE';
    case 'dismount':
      return 'GET OFF';
    default:
      // Taking it. The thing is at your feet and drawn there, so naming it as
      // well would be the label telling you what you are already looking at.
      return 'PICK UP';
  }
}

/**
 * Advance the prompt's own animation, and decide whether the drop hint is still
 * welcome. One step per simulation frame, like everything else in this file.
 */
function stepPrompt(s: HudState, f: Fighter, t: InteractTarget | null): void {
  if (f.weapon !== s.promptWeapon) {
    s.promptWeapon = f.weapon;
    s.dropHint = f.weapon ? DROP_HINT_FRAMES : 0;
  }
  if (s.dropHint > 0) s.dropHint--;

  const key = t ? `${t.action}:${t.label}` : '';
  if (key !== s.promptKey) {
    s.promptKey = key;
    s.promptPop = 0;
  }
  if (t) s.promptPop = Math.min(1, s.promptPop + PROMPT_RISE);
}

/**
 * Is there anything worth saying about this target?
 *
 * Everything except `drop`, which is the answer the interact key gives when
 * there is nothing else within reach — true for most of the time anybody is
 * carrying anything, and therefore not news after the first couple of seconds.
 */
function promptWanted(s: HudState, t: InteractTarget | null): t is InteractTarget {
  if (!t) return false;
  return t.action !== 'drop' || s.dropHint > 0;
}

/**
 * The pill: a keycap in the player's own colour, then the verb.
 *
 * Sized off the measured text rather than off a guess, because the button on it
 * may be 'E', 'Num 4', 'L Shift' or '←' depending on whose keyboard this is.
 */
function drawPrompt(
  ctx: C2D,
  cx: number,
  top: number,
  button: string,
  verb: string,
  tint: string,
  scale: number,
  alpha: number,
): void {
  const capW = measureCap(ctx, button, PROMPT_FONT - 1);
  const verbW = measure(ctx, verb, PROMPT_FONT, 800);
  const w = 3 + capW + 5 + verbW + 7;
  const x = cx - w * 0.5;
  const base = top + PROMPT_H - 3.8;

  ctx.save();
  ctx.globalAlpha = alpha;
  if (scale !== 1) {
    // About the bottom edge, so it grows up out of the marker rather than
    // through it.
    ctx.translate(cx, top + PROMPT_H);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -(top + PROMPT_H));
  }

  slab(ctx, x, top, w, PROMPT_H, 3, PLATE, INK, 1.3);
  // A keycap in the player's colour: it reads as a physical key, and it is the
  // same hue as their marker and their panel, so a four-player couch can tell
  // whose prompt it is without reading it.
  keycap(ctx, button, x + 3.5, top + PROMPT_H * 0.5, PROMPT_FONT - 1, tint);
  text(ctx, verb, x + 3 + capW + 5, base, PROMPT_FONT, TEXT, 'left', 800);
  ctx.restore();
}

/** One player's prompt, stacked above their marker. */
function drawInteractPrompt(
  ctx: C2D,
  f: Fighter,
  s: HudState,
  cam: Camera,
  t: InteractTarget,
  padOrder: number,
  still: boolean,
  opts?: HudOptions,
): void {
  if (f.team !== 'player' || !f.alive) return;
  const button = interactButton(f, s, s.frame, padOrder, opts);
  if (!button) return;
  if (!headScreen(f, cam)) return;

  // Above the marker, and above the whole height the marker's idle bob can
  // reach, so the two never touch and the pill never bobs in sympathy.
  const tip = Math.max(MARK_MIN_TIP_Y, HEAD.y - MARK_GAP);
  const markTop = tip - MARK_CHEV_H - 2.5 - MARK_NUM_SIZE * 0.78 - MARK_BOB;
  const top = Math.max(PROMPT_MIN_Y, markTop - PROMPT_GAP - PROMPT_H);

  const scale = still ? 1 : easeOutBack(s.promptPop);
  // The drop hint is on a timer rather than on a target going out of reach, so
  // it is the one prompt that has to see itself out.
  const leaving = t.action === 'drop' ? clamp(s.dropHint / 20, 0, 1) : 1;
  const alpha = (still ? 1 : clamp(s.promptPop * 1.8, 0, 1)) * leaving;
  if (alpha <= 0.01 || scale <= 0.01) return;

  drawPrompt(ctx, HEAD.x, top, button, promptVerb(t), PLAYER_COLORS[playerIndex(f)], scale, alpha);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function drawHud(
  ctx: C2D,
  players: Fighter[],
  level: Level,
  frame: number,
  opts?: HudOptions,
): void {
  if (opts?.hidden) return;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  const cam = cameraOf(level);
  const still = holdStill();

  seatMap = opts?.seats ?? null;
  const slots = layout(players.length);
  // Panels go left to right in PLAYER order, which is seat order — not the
  // order of the input slots the fighters happen to be standing on.
  const order = players.slice().sort((a, b) => playerIndex(a) - playerIndex(b));
  // Pads are handed to slots in ascending order, so counting the pad-driven
  // players by slot gives each one the pad it is actually holding.
  const padOrderOf = new Map<number, number>();
  {
    let n = 0;
    const bySlot = players.slice().sort((a, b) => a.id - b.id);
    for (const f of bySlot) {
      if (stateFor(f.id, 1).onPad) padOrderOf.set(f.id, n++);
    }
  }
  for (let i = 0; i < order.length; i++) {
    const f = order[i];
    const slot = slots[i];
    if (!slot) break;
    const s = stateFor(f.id, f.maxHealth > 0 ? f.health / f.maxHealth : 0);
    // Asked before the state is stepped, so the prompt's ease-in starts on the
    // very frame the thing came within reach. Two short linear scans over
    // things there are single digits of; see Level.interactTargetFor.
    const target = f.team === 'player' && f.alive ? level.interactTargetFor(f) : null;
    stepState(s, f, frame, target);
    const mine = s.onPad ? (padOrderOf.get(f.id) ?? 0) : 0;
    // The dwarf's name is the title; the player's own name, when they have one
    // worth printing (online), rides in the tag beside their number.
    const seat = playerIndex(f);
    const given = opts?.names?.[f.id];
    const tag =
      given && !/^PLAYER \d+$/i.test(given) ? `${PLAYER_TAGS[seat]} · ${given}` : PLAYER_TAGS[seat];
    const superKey = f.meter >= 1 ? buttonLabel(f, s, frame, mine, Btn.Super, 'r2', opts) : null;
    drawPanel(ctx, f, slot, s, frame, level.livesFor(f.id), dwarfName(f), tag, superKey);
    if (cam) {
      drawMarker(ctx, f, s, cam, frame, still);
      // After the marker, so the pill is never drawn under a chevron it is
      // meant to sit above.
      if (!opts?.quiet && promptWanted(s, target)) {
        drawInteractPrompt(ctx, f, s, cam, target, mine, still, opts);
      }
    }
  }

  // Score and map strip, centred so it survives any player count.
  const score = (opts?.scoreBase ?? 0) + level.score;
  const cx = VIEW_W * 0.5;
  const wide = players.length <= 2;
  const sy = wide ? 19 : 68;
  drawScore(ctx, score, cx, sy, wide ? 17 : 14);

  if (opts?.mapName) {
    const idx = opts.mapIndex ?? 1;
    const total = opts.mapTotal ?? TOTAL_MAPS;
    const line = `MAP ${digitsOf(idx, 2)}/${total}  ·  ${opts.mapName.toUpperCase()}`;
    text(ctx, fitText(ctx, line, 7.5, wide ? 196 : 300), cx, sy + 11, 7.5, TEXT_DIM, 'center', 600);
  }

  // Wave pips, but only while there is no boss stealing the bottom of the screen.
  const boss = findBoss(level);
  if (!boss && level.waveTotal > 0) {
    const n = level.waveTotal;
    const total = Math.min(n, 12);
    const pw = 8;
    const startX = cx - ((total - 1) * pw) * 0.5;
    const py = opts?.mapName ? sy + 20 : sy + 9;
    for (let i = 0; i < total; i++) {
      const done = i < level.waveProgress;
      const current = i === level.waveProgress;
      const px = startX + i * pw;
      const r = current ? 3 + 0.5 * Math.sin(frame * 0.15) : 2.6;
      diamond(ctx, px, py, r + 1.2, INK);
      diamond(ctx, px, py, r, done ? PALETTE.lamp : current ? PALETTE.boneDim : '#3a312b');
    }
  }

  if (boss) {
    const s = stateFor(boss.id, boss.maxHealth > 0 ? boss.health / boss.maxHealth : 0);
    stepState(s, boss, frame);
    drawBossBar(ctx, boss, s, frame);
  }

  ctx.restore();
}

function diamond(ctx: C2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * The score, arcade style: a fixed run of digits so it never jumps sideways,
 * but with the leading zeros sunk into the plate so the number that matters is
 * the thing you read.
 */
function drawScore(ctx: C2D, score: number, cx: number, y: number, size: number): void {
  const digits = digitsOf(score, 7);
  let lead = 0;
  while (lead < digits.length - 1 && digits[lead] === '0') lead++;
  ctx.font = displayFont(size, 900, true);
  const w = ctx.measureText(digits).width;
  const x = cx - w * 0.5;
  const head = digits.slice(0, lead);
  const tail = digits.slice(lead);
  const headW = head ? ctx.measureText(head).width : 0;
  if (head) text(ctx, head, x, y, size, '#4a3f37', 'left', 900, true);
  text(ctx, tail, x + headW, y, size, TEXT, 'left', 900, true);
}

function findBoss(level: Level): Fighter | null {
  for (const f of level.fighters) {
    if (f.isBoss && f.health > 0) return f;
  }
  // A boss that has just died still owns the bottom bar for its death throes.
  for (const f of level.fighters) {
    if (f.isBoss) return f;
  }
  return null;
}

/** Outlined display text, so the scene's own banners match the HUD exactly. */
export function hudText(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'center',
): void {
  text(ctx, s, x, y, size, fill, align);
}
