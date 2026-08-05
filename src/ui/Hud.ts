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
 * It also owns the one thing on screen that is not in a corner: the floating
 * player marker over each player's head. That lives here because the marker and
 * the panel have to agree about which colour a player is, and because `drawHud`
 * is already the game's screen-space layer — see the PLAYER MARKERS section for
 * how a screen-space overlay is pinned to a world-space head.
 */

import type { Bone, BossDef, RigStyle } from '@/core/types';
import type { Fighter } from '@/game/Fighter';
import type { Level } from '@/game/Level';
import type { Camera } from '@/render/Camera';

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
import { ellipse, poly, roundRect } from '@/render/Shapes';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { resolvePose } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { DWARFS } from '@/content/dwarfs';
import { BOSSES } from '@/content/bosses';

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
}

// ── Palette ──────────────────────────────────────────────────────────────────

const INK = '#120e18';
const FRAME_BG = 'rgba(10,8,14,0.72)';
const TRACK = '#2a2233';
const HEALTH_HI = '#ff5a4f';
const HEALTH_LO = '#c11f2e';
const CHIP = '#ffd23f';
const METER_EMPTY = '#1d2733';
const METER_FILL = '#5fc9ff';
const METER_FULL = '#ffd23f';
const BOSS_HI = '#ff2d55';
const BOSS_LO = '#8c0028';
const TEXT = '#f2eef7';
const TEXT_DIM = '#9aa2b8';
const LIFE = '#ff8fae';
/** The one hue the HUD did not already own. Player four needed a green. */
const MINT = '#63ff9d';

/**
 * Identity colour per player slot, built out of the colours this HUD already
 * uses so there is exactly one player palette in the game: amber (the chip bar),
 * cyan (the meter), pink (the life pips) and mint.
 *
 * Four hues that stay apart from each other, from the red of the health bar, and
 * from the black leather everyone on screen is wearing. They also survive the
 * common colour-vision deficiencies as light/dark pairs — and the marker draws
 * the player number as well, so colour never carries the identity alone.
 */
const PLAYER_COLORS: readonly string[] = [CHIP, METER_FILL, LIFE, MINT];
/** Pre-built so the draw path never builds a string. */
const PLAYER_LABELS: readonly string[] = ['1', '2', '3', '4'];

const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif';

const PAD = 6;
const PANEL_W_MAX = 214;
const PANEL_GAP = 6;
const PORTRAIT_R = 13;

/** Frames the chip bar hangs at the old value before it starts falling. */
const CHIP_HOLD = 16;
/** Fraction of the remaining gap the chip closes per frame, plus a floor. */
const CHIP_RATE = 0.055;
const CHIP_MIN = 0.0016;
/** Frames a finished combo readout lingers before it fades. */
const COMBO_LINGER = 46;

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
  frame: number;
}

const states = new Map<number, HudState>();

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
      frame: -1,
    };
    states.set(id, s);
  }
  return s;
}

/** Drop the animation state. Call between maps so a new fight starts clean. */
export function resetHud(): void {
  states.clear();
}

// ── Text ─────────────────────────────────────────────────────────────────────

function text(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'left',
  weight = '900',
): void {
  ctx.font = `${weight} ${size}px ${DISPLAY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(1.6, size * 0.26);
  ctx.strokeStyle = INK;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

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
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = dead ? '#241820' : '#1b1626';
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  const clip = dead ? (CLIPS.knockdown ?? CLIPS.idle) : (CLIPS.idle ?? CLIPS.walk);
  if (clip) {
    const u = 0.62;
    // The dwarf rig puts the skull about 39 rig-units above the feet; anchoring
    // the ground point that far below the disc centres the face in the frame.
    const headUp = 39 * u;
    const pose = sampleClip(clip, frame * 0.42);
    drawCharacter(ctx, style, pose, skeleton, cx, cy + headUp, 1, {
      scale: u,
      flash: hurt,
    });
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  // The inner ring is in the player's colour: the panel and the marker over that
  // player's head are then the same object, seen twice.
  ctx.arc(cx, cy, r - 1.4, 0, Math.PI * 2);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = dead ? '#5d4a55' : ring;
  ctx.stroke();

  if (dead) {
    text(ctx, 'K.O.', cx, cy + 3, 9, '#ff5a4f', 'center');
  }
}

// ── Bars ─────────────────────────────────────────────────────────────────────

function bar(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  fromRight: boolean,
  fill: string,
  shade: string,
): void {
  const f = clamp(frac, 0, 1);
  if (f <= 0) return;
  const ww = Math.max(0.6, w * f);
  const bx = fromRight ? x + w - ww : x;
  ctx.fillStyle = shade;
  ctx.fillRect(bx, y, ww, h);
  ctx.fillStyle = fill;
  ctx.fillRect(bx, y, ww, h * 0.55);
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

function stepState(s: HudState, f: Fighter, frame: number): void {
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
  }
}

function drawPanel(
  ctx: C2D,
  f: Fighter,
  slot: Slot,
  s: HudState,
  frame: number,
  lives: number,
  name: string,
): void {
  const { x, y, w, mirror } = slot;
  const h = 36;
  const tag = PLAYER_COLORS[playerIndex(f)];

  /** Distance `o` from the portrait side of the panel. */
  const at = (o: number, width = 0): number => (mirror ? x + w - o - width : x + o);

  ctx.save();
  ctx.globalAlpha = 1;

  roundRect(ctx, x, y, w, h, 4, FRAME_BG, INK, 1.6);

  const pcx = at(PORTRAIT_R + 4);
  const pcy = y + h * 0.5;
  portrait(ctx, f.style, f.skeleton, pcx, pcy, PORTRAIT_R, frame, !f.alive, s.hurt * 0.7, tag);

  const barX = at(PORTRAIT_R * 2 + 8, w - (PORTRAIT_R * 2 + 12));
  const barW = w - (PORTRAIT_R * 2 + 12);
  const align: CanvasTextAlign = mirror ? 'right' : 'left';
  const nameX = mirror ? barX + barW : barX;

  text(ctx, name, nameX, y + 10, 8, f.alive ? tag : '#8b7d8e', align);

  // Lives, as little pips beside the name.
  const pipR = 2.2;
  for (let i = 0; i < Math.min(6, lives); i++) {
    const px = mirror ? barX + 4 + i * 7 : barX + barW - 4 - i * 7;
    ellipse(ctx, px, y + 7, pipR, pipR, 0, LIFE, INK, 1);
  }
  if (lives > 6) text(ctx, `x${lives}`, mirror ? barX : barX + barW, y + 10, 7, LIFE, mirror ? 'left' : 'right');

  // Health: chip behind, live bar in front.
  const hy = y + 13;
  const hh = 7;
  roundRect(ctx, barX, hy, barW, hh, 1.5, TRACK, INK, 1.4);
  bar(ctx, barX + 1, hy + 1, barW - 2, hh - 2, s.chip, mirror, CHIP, '#a97f18');
  bar(ctx, barX + 1, hy + 1, barW - 2, hh - 2, s.health, mirror, HEALTH_HI, HEALTH_LO);

  // A hairline at 25% so "one more hit" is a readable position, not a guess.
  const dx = mirror ? barX + barW - (barW - 2) * 0.25 - 1 : barX + 1 + (barW - 2) * 0.25;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(dx, hy + 1, 1, hh - 2);

  // Meter: MAX_METER_BARS segments, the newest full one pulsing.
  const my = y + 22;
  const mh = 4;
  const segGap = 2;
  const segW = (barW - segGap * (MAX_METER_BARS - 1)) / MAX_METER_BARS;
  for (let i = 0; i < MAX_METER_BARS; i++) {
    const sx = mirror
      ? barX + barW - segW - i * (segW + segGap)
      : barX + i * (segW + segGap);
    const fillFrac = clamp(f.meter - i, 0, 1);
    roundRect(ctx, sx, my, segW, mh, 1, METER_EMPTY, INK, 1.2);
    if (fillFrac > 0) {
      const full = fillFrac >= 1;
      const pulse = full ? 0.72 + 0.28 * Math.sin(frame * 0.19 + i) : 1;
      ctx.save();
      ctx.globalAlpha = pulse;
      bar(ctx, sx + 0.8, my + 0.8, segW - 1.6, mh - 1.6, fillFrac, mirror, full ? METER_FULL : METER_FILL, full ? '#c58f00' : '#1d6f9c');
      ctx.restore();
    }
  }
  if (f.meter >= 1) {
    const glow = 0.25 + 0.25 * Math.sin(frame * 0.19);
    ctx.save();
    ctx.globalAlpha = glow + s.meterPulse * 0.5;
    ctx.globalCompositeOperation = 'lighter';
    roundRect(ctx, barX - 1, my - 1, barW + 2, mh + 2, 2, 'rgba(255,210,63,0.35)', 'none', 0);
    ctx.restore();
    text(ctx, 'SUPER', mirror ? barX : barX + barW, my + 12, 7, METER_FULL, mirror ? 'left' : 'right');
  }

  // Weapon and what is left of it.
  const wd = f.weaponDef;
  if (wd) {
    const wear = weaponWear(f);
    const wy = my + 7;
    const label = wd.name.toUpperCase();
    text(ctx, label, nameX, wy + 6, 7, wd.art.accent, align);
    const gw = Math.min(46, barW * 0.42);
    const gx = mirror ? barX : barX + barW - gw;
    if (wd.ammo !== undefined) {
      text(ctx, `${wear.ammo}`, mirror ? gx + gw : gx, wy + 6, 7, wear.ammo > 0 ? TEXT : '#ff5a4f', mirror ? 'right' : 'left');
    } else if (wear.max > 0) {
      const frac = clamp(wear.left / wear.max, 0, 1);
      roundRect(ctx, gx, wy + 1, gw, 3.2, 1, TRACK, INK, 1);
      bar(ctx, gx + 0.6, wy + 1.6, gw - 1.2, 2, frac, mirror, frac < 0.3 ? '#ff5a4f' : wd.art.color, '#3a3446');
    }
  }

  // Combo counter, popping outward from the panel.
  if (s.comboShown >= 2 && (f.comboCount > 0 || s.comboLife > 0)) {
    const fade = f.comboCount > 0 ? 1 : clamp(s.comboLife / COMBO_LINGER, 0, 1);
    const pop = easeOutBack(1 - s.pop);
    const size = (10 + Math.min(18, s.comboShown) * 0.42) * lerp(1.55, 1, pop);
    const cx = mirror ? x + w - 4 : x + 4;
    const cy = y + h + 14;
    ctx.save();
    ctx.globalAlpha = fade;
    text(ctx, `${s.comboShown}`, cx, cy, size, '#ffe14a', mirror ? 'right' : 'left');
    const numW = nameWidth(ctx, `${s.comboShown}`, size);
    text(
      ctx,
      s.comboShown >= 10 ? 'HIT COMBO!' : 'HIT',
      mirror ? cx - numW - 2 : cx + numW + 2,
      cy,
      8,
      '#7fe0ff',
      mirror ? 'right' : 'left',
    );
    ctx.restore();
  }

  ctx.restore();
}

function nameWidth(ctx: C2D, s: string, size: number): number {
  ctx.font = `900 ${size}px ${DISPLAY}`;
  return ctx.measureText(s).width;
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
  const w = 400;
  const x = (VIEW_W - w) * 0.5;
  const y = VIEW_H - 34;
  const h = 11;

  ctx.save();
  roundRect(ctx, x - 5, y - 13, w + 10, h + 20, 4, FRAME_BG, INK, 1.6);

  const name = (def ? def.name : boss.archetype).toUpperCase();
  text(ctx, name, x, y - 4, 10, '#ffffff', 'left');

  roundRect(ctx, x, y, w, h, 2, TRACK, INK, 1.6);
  bar(ctx, x + 1.5, y + 1.5, w - 3, h - 3, s.chip, false, CHIP, '#a97f18');
  bar(ctx, x + 1.5, y + 1.5, w - 3, h - 3, s.health, false, BOSS_HI, BOSS_LO);

  if (def && def.phases.length > 1) {
    const cur = phaseIndex(def, s.health);

    // Threshold notches on the bar itself: you can see the next gear coming.
    for (let i = 1; i < def.phases.length; i++) {
      const t = clamp(def.phases[i].healthThreshold, 0, 1);
      const nx = x + 1.5 + (w - 3) * t;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(nx - 0.5, y + 1.5, 1.4, h - 3);
    }

    // Phase pips: filled for phases survived, hollow for what is left. They sit
    // hard right, and the label is anchored off their left edge so a boss with
    // five phases never has its pips written over.
    const pips = def.phases.length;
    const pipGap = 10;
    const pipRight = x + w - 5;
    for (let i = 0; i < pips; i++) {
      const px = pipRight - (pips - 1 - i) * pipGap;
      const active = i <= cur;
      const pulse = i === cur ? 1 + 0.22 * Math.sin(frame * 0.22) : 1;
      ellipse(
        ctx,
        px,
        y - 7,
        3.3 * pulse,
        3.3 * pulse,
        0,
        active ? (i === cur ? '#ffe14a' : BOSS_HI) : '#3a2b38',
        INK,
        1.3,
      );
    }
    text(
      ctx,
      `PHASE ${cur + 1}/${pips}`,
      pipRight - (pips - 1) * pipGap - 8,
      y - 4,
      8,
      '#ff8fa6',
      'right',
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
const MARK_CHEV_W = 9;
const MARK_CHEV_H = 6;
const MARK_NUM_SIZE = 9;
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
 * the screen and through the panels — the panels end at y = 42, and the digit
 * stands MARK_CHEV_H + the cap height above the tip. It stops here instead,
 * sitting on the head for the half second that costs.
 */
const MARK_MIN_TIP_Y = 61;

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

/** Player slot -> palette index, for any slot number a lobby can hand out. */
function playerIndex(f: Fighter): number {
  const n = PLAYER_COLORS.length;
  return ((((f.id | 0) % n) + n) % n) | 0;
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
 * One player's marker, pinned to the head the renderer has just drawn.
 *
 * `f.drawPos` — not `f.pos` — is the anchor. pos is a whole simulation step
 * ahead of the interpolated body, which is eleven world units at the moment
 * someone leaves the ground; the marker would detach every time anybody jumped.
 */
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

  const d = f.drawPos;
  const zoom = cam.zoom > 0.05 ? cam.zoom : 1;
  // Rig scale, exactly as Fighter.render hands it to drawCharacter: the dwarf's
  // own scale times the belt's depth perspective. A dwarf standing at the back
  // wall is smaller, and their marker comes down to meet them.
  const u = (f.style.scale || 1) * clamp(1 - d.z * Z_PERSPECTIVE, 0.75, 1);

  // World -> camera space, with the head offset applied before the projection so
  // a rolled camera would carry the marker around with it.
  const cx = d.x - cam.x + cam.shakeX - VIEW_W * 0.5;
  const cy =
    GROUND_Y + d.z * Z_SCALE - d.y - rigTop(f.skeleton) * u + WORLD_FRAME_Y + cam.shakeY - VIEW_H * 0.5;

  let sx = cx * zoom;
  let sy = cy * zoom;
  if (cam.rotation !== 0) {
    const c = Math.cos(cam.rotation);
    const sn = Math.sin(cam.rotation);
    const rx = sx * c - sy * sn;
    sy = sx * sn + sy * c;
    sx = rx;
  }
  sx += VIEW_W * 0.5;
  sy += VIEW_H * 0.5;

  if (sx < -24 || sx > VIEW_W + 24 || sy > VIEW_H + 24) return;

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

  const slots = layout(players.length);
  for (let i = 0; i < players.length; i++) {
    const f = players[i];
    const slot = slots[i];
    if (!slot) break;
    const s = stateFor(f.id, f.maxHealth > 0 ? f.health / f.maxHealth : 0);
    stepState(s, f, frame);
    const name = opts?.names?.[f.id] ?? dwarfName(f);
    drawPanel(ctx, f, slot, s, frame, level.livesFor(f.id), name);
    if (cam) drawMarker(ctx, f, s, cam, frame, still);
  }

  // Score and map strip, centred so it survives any player count.
  const score = (opts?.scoreBase ?? 0) + level.score;
  const cx = VIEW_W * 0.5;
  const wide = players.length <= 2;
  const sy = wide ? 16 : 52;
  text(ctx, digitsOf(score, 8), cx, sy, wide ? 15 : 13, '#ffe14a', 'center');

  if (opts?.mapName) {
    const idx = opts.mapIndex ?? 1;
    const total = opts.mapTotal ?? TOTAL_MAPS;
    text(
      ctx,
      `${digitsOf(idx, 2)}/${digitsOf(total, 2)}  ${opts.mapName.toUpperCase()}`,
      cx,
      sy + 10,
      7,
      TEXT_DIM,
      'center',
    );
  }

  // Wave pips, but only while there is no boss stealing the bottom of the screen.
  const boss = findBoss(level);
  if (!boss && level.waveTotal > 0) {
    const n = level.waveTotal;
    const total = Math.min(n, 12);
    const pw = 7;
    const startX = cx - ((total - 1) * pw) * 0.5;
    for (let i = 0; i < total; i++) {
      const done = i < level.waveProgress;
      ellipse(
        ctx,
        startX + i * pw,
        (opts?.mapName ? sy + 18 : sy + 8),
        2.4,
        2.4,
        0,
        done ? '#ffe14a' : '#463a52',
        INK,
        1.2,
      );
    }
  }

  if (boss) {
    const s = stateFor(boss.id, boss.maxHealth > 0 ? boss.health / boss.maxHealth : 0);
    stepState(s, boss, frame);
    drawBossBar(ctx, boss, s, frame);
  }

  ctx.restore();
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
