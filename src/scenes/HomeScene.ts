/**
 * The title screen.
 *
 * It is a piece of key art before it is a menu. Left: the logo, and under it the
 * menu as an arcade list. Right: the seven of them on the plateau in a loose
 * formation — the leader in front with his weapon out, the rest behind him —
 * backlit by a searchlight and rim-lit by the moon. The old screen stood the
 * seven in a dark row along the bottom and then parked four buttons on top of
 * three of them; the one thing on the screen that said what the game is about
 * was the thing the menu covered.
 *
 * Canvas draws the show; the DOM draws the menu, because a real <button> is
 * keyboard-operable, screen-reader legible and focusable for free. The two are
 * registered to each other through the stage-relative CSS in styles.css
 * (.ui-view--home), so the menu lands on the same patch of sky at any window
 * shape. On a tall narrow window there is no left third, so the art re-centres
 * ("stacked") and the menu drops underneath it.
 *
 * The menu is drivable three ways at once — pointer, keyboard, gamepad — all
 * producing the same ui_move / ui_select / ui_back cues.
 *
 * If the page was opened from an invite link, none of that happens: the scene
 * joins the room and goes straight to character select. A friend who clicks a
 * link should not have to press anything.
 */

import type { DwarfDef, RigStyle, Scene } from '@/core/types';
import { Btn } from '@/core/types';
import type { Game } from '@/Game';
import type { SelectParams } from '@/scenes/SelectScene';
import type { LobbyParams } from '@/scenes/LobbyScene';

import { MAX_LOCAL_PLAYERS, VIEW_H, VIEW_W } from '@/core/constants';
import { TAU, clamp, lerp } from '@/core/math';
import { codeForBit, defaultBindingsFor } from '@/engine/input/Bindings';
import { keyLabel, movementKeysLabel, movementLabelForCodes, onLayoutChange } from '@/engine/input/Layout';
import { installKeyboard } from '@/engine/input/KeyboardSource';
import { gamepadPanel, keyBindingEditor } from '@/ui/KeyBindingEditor';
import { MenuInput } from '@/ui/MenuInput';
import { settingsBody } from '@/ui/SettingsPanel';
import { DWARFS } from '@/content/dwarfs';
import { WEAPONS } from '@/content/weapons';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { clearRoomFromUrl, roomIdFromUrl } from '@/net/Room';
import { button, panel } from '@/ui/Widgets';
import { PALETTE, displayFont, trackedText } from '@/ui/theme';

type C2D = CanvasRenderingContext2D;

export type MenuView = 'menu' | 'multiplayer' | 'settings' | 'controls' | 'joining';

/** Params the scene stack may hand back when returning to the title. */
export interface HomeParams {
  /** Which page of the menu to open on. */
  view?: MenuView;
  /** A message to show in a notice — "the host closed the room", and friends. */
  error?: string;
}

/** Below this window aspect the art is re-centred and the menu goes underneath. */
const SPLIT_ASPECT = 1.25;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic-looking noise for the scenery. Not sim code, but a title screen
// that reshuffles its own mountains every frame is a title screen with a bug.
// ─────────────────────────────────────────────────────────────────────────────

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return lerp(hash01(i + seed * 7919), hash01(i + 1 + seed * 7919), s);
}

/** Ridged fractal noise: sharp peaks, soft valleys. Exactly what a skyline is. */
function ridgeAt(x: number, seed: number, scale: number): number {
  let sum = 0;
  let amp = 1;
  let f = scale;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    const v = vnoise(x * f, seed + o);
    sum += (1 - Math.abs(v * 2 - 1)) * amp;
    norm += amp;
    amp *= 0.48;
    f *= 2.3;
  }
  return sum / norm;
}

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
  hot: boolean;
}

/** One dwarf in the formation, for one composition. */
interface Placement {
  x: number;
  /** Feet. */
  y: number;
  scale: number;
  facing: 1 | -1;
  /** 0 = front, 1 = middle, 2 = back: decides tint and draw order. */
  row: 0 | 1 | 2;
}

interface Member {
  def: DwarfDef;
  style: RigStyle;
  phase: number;
  split: Placement;
  stacked: Placement;
}

/**
 * The formation. MALICE leads — the angriest of them, front and centre — with
 * the others in two ranks behind. Authored against 640x360 for both layouts.
 */
const FORMATION: Record<string, { split: Placement; stacked: Placement }> = {
  grumpy: {
    split: { x: 492, y: 314, scale: 2.3, facing: -1, row: 0 },
    stacked: { x: 320, y: 330, scale: 1.75, facing: -1, row: 0 },
  },
  happy: {
    split: { x: 412, y: 290, scale: 1.85, facing: 1, row: 1 },
    stacked: { x: 238, y: 316, scale: 1.45, facing: 1, row: 1 },
  },
  bashful: {
    split: { x: 578, y: 290, scale: 1.85, facing: -1, row: 1 },
    stacked: { x: 402, y: 316, scale: 1.45, facing: -1, row: 1 },
  },
  doc: {
    split: { x: 368, y: 266, scale: 1.5, facing: 1, row: 2 },
    stacked: { x: 92, y: 300, scale: 1.2, facing: 1, row: 2 },
  },
  sleepy: {
    split: { x: 444, y: 260, scale: 1.45, facing: 1, row: 2 },
    stacked: { x: 162, y: 302, scale: 1.2, facing: 1, row: 2 },
  },
  sneezy: {
    split: { x: 540, y: 260, scale: 1.45, facing: -1, row: 2 },
    stacked: { x: 478, y: 302, scale: 1.2, facing: -1, row: 2 },
  },
  dopey: {
    split: { x: 614, y: 266, scale: 1.5, facing: -1, row: 2 },
    stacked: { x: 548, y: 300, scale: 1.2, facing: -1, row: 2 },
  },
};

/** Atmospheric depth: the back rank sits in the night air, the leader does not. */
const ROW_TINT: readonly (string | undefined)[] = [undefined, '#c9c3cc', '#8f8fa3'];

export class HomeScene implements Scene {
  readonly name = 'home';

  private readonly game: Game;

  private frame = 0;
  private view: MenuView = 'menu';
  private notice = '';

  private root: HTMLElement | null = null;

  /** Unsubscribe for the keyboard-layout watch. See onLayoutSettled(). */
  private layoutOff: (() => void) | null = null;

  /**
   * The one line on the Controls page that prints a key name of its own. Kept
   * so a layout landing late can rewrite it in place — rebuilding the page would
   * yank the binding editor out from under whoever is using it.
   */
  private controlsNote: HTMLElement | null = null;

  /** Keyboard-and-pad navigation for whichever page is mounted. */
  private readonly menu: MenuInput;

  private readonly embers: Ember[] = [];
  private readonly members: Member[] = [];

  /**
   * How much of the art is covered by a page that needs the middle of the
   * screen (Settings, Controls). Eased, so the scrim slides in rather than
   * snapping, and the logo steps back out of the way.
   */
  private cover = 0;

  /** Room the auto-join path is dialling, so Cancel knows what to hang up on. */
  private joinRoom = '';
  private joining = false;
  private cancelled = false;

  constructor(game: Game) {
    this.game = game;

    // The menu reads every pad the browser can see, rather than the ones
    // InputManager has handed a player slot to. Nothing hands out a slot on
    // this screen: that happens on `gamepadconnected`, and a controller that
    // was already awake when the page loaded fired that event while the bundle
    // was still parsing and never fires it again — which left the title screen
    // deaf to the one pad in the room while inviting you to press A on it.
    this.menu = new MenuInput({
      ui: () => this.game.ui,
      audio: this.game.audio,
      onBack: () => this.back(),
    });

    // The film dwarfs never turn up on this screen. They already changed.
    for (let i = 0; i < DWARFS.length; i++) {
      const d = DWARFS[i];
      const at = FORMATION[d.id];
      if (!at) continue;
      this.members.push({
        def: d,
        style: { ...d.style, outfit: 1 },
        phase: i * 17,
        split: at.split,
        stacked: at.stacked,
      });
    }
    // Back rank first, the leader last: painter's order is the formation.
    this.members.sort((a, b) => b.split.row - a.split.row || a.split.y - b.split.y);

    for (let i = 0; i < 70; i++) {
      this.embers.push({
        x: Math.random() * VIEW_W,
        y: 230 + Math.random() * 140,
        vx: (Math.random() - 0.5) * 0.16,
        vy: -0.14 - Math.random() * 0.3,
        r: 0.5 + Math.random() * 1.1,
        a: 0.2 + Math.random() * 0.55,
        hot: Math.random() < 0.3,
      });
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    installKeyboard();
    this.frame = 0;
    this.cancelled = false;
    this.menu.attach();
    this.layoutOff = onLayoutChange(() => this.onLayoutSettled());

    const p = (params ?? {}) as HomeParams;
    this.notice = typeof p.error === 'string' ? p.error : '';

    this.game.audio.music('menu');

    // A link in the URL is a decision already taken. Honour it and get out of
    // the way — a friend clicking an invite should not meet a menu.
    const invite = this.game.pendingJoin ?? roomIdFromUrl();
    if (invite && !this.game.online) {
      this.game.pendingJoin = null;
      this.joinRoom = invite;
      this.show('joining');
      void this.autoJoin(invite);
      return;
    }

    this.show(p.view === 'multiplayer' ? 'multiplayer' : 'menu');
  }

  exit(): void {
    this.cancelled = true;
    this.menu.detach();
    this.layoutOff?.();
    this.layoutOff = null;
    this.detachRoot();
    // A session still mid-handshake when the scene dies is a leak with a WebRTC
    // connection attached to it.
    if (this.joining && !this.game.online) this.game.leaveNet();
    this.joining = false;
  }

  update(_dt: number): void {
    this.frame++;
    this.updateEmbers();
    const want = this.view === 'settings' || this.view === 'controls' || this.view === 'joining' ? 1 : 0;
    this.cover += (want - this.cover) * 0.2;
    if (Math.abs(want - this.cover) < 0.002) this.cover = want;
    this.menu.poll();
  }

  render(alpha: number): void {
    const r = this.game.renderer;
    const ctx = r.ctx;
    const t = this.frame + alpha;
    const split = this.isSplit();

    r.begin();
    r.clear(PALETTE.coal);
    this.drawSky(ctx, t, split);
    this.drawSearchlights(ctx, t, split);
    this.drawRidges(ctx, t);
    this.drawPlateau(ctx, split);
    this.drawBacklight(ctx, t, split);
    this.drawFormation(ctx, t, split);
    this.drawEmbers(ctx);
    this.drawScrim(ctx, split);
    this.drawLogo(ctx, t, split);
    if (this.cover > 0.002) {
      ctx.globalAlpha = 0.72 * this.cover;
      ctx.fillStyle = PALETTE.coal;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
    }
    r.end();
  }

  onKey(e: KeyboardEvent): void {
    // The menu takes what it acts on in the capture phase, so a key routed all
    // the way here is one it let past — including Escape in the gap between
    // views, when there is nothing mounted to walk the focus through.
    this.menu.onKey(e);
  }

  /**
   * Wide enough for the art and the menu to sit side by side. Matches the
   * `max-aspect-ratio: 5/4` breakpoint in styles.css, so the canvas and the DOM
   * always agree about which layout this is.
   */
  private isSplit(): boolean {
    if (typeof window === 'undefined') return true;
    const w = window.innerWidth || VIEW_W;
    const h = window.innerHeight || VIEW_H;
    return w / h > SPLIT_ASPECT;
  }

  // ── Backdrop ───────────────────────────────────────────────────────────────

  private drawSky(ctx: C2D, t: number, split: boolean): void {
    // Cold at the top, a banked ember glow along the horizon: night on the
    // mountain, and something burning on the far side of it.
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#07080d');
    g.addColorStop(0.38, '#10131d');
    g.addColorStop(0.6, '#231a1c');
    g.addColorStop(0.72, '#3a2014');
    g.addColorStop(1, '#120c0a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Stars. Fixed positions, twinkle only.
    for (let i = 0; i < 120; i++) {
      const x = hash01(i * 3 + 1) * VIEW_W;
      const y = hash01(i * 3 + 2) * 180;
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.03 + i * 1.7));
      const s = hash01(i * 3 + 3);
      ctx.globalAlpha = tw * (0.2 + s * 0.5) * (1 - y / 230);
      ctx.fillStyle = s > 0.9 ? PALETTE.lampHot : '#e7e9f2';
      const r = s > 0.9 ? 1.2 : 0.75;
      ctx.fillRect(x, y, r, r);
    }
    ctx.globalAlpha = 1;

    // Moon, and the halo it wears in cold air. Upper right, so it rims the
    // formation from behind its right shoulder.
    const mx = split ? 586 : 548;
    const my = split ? 54 : 48;
    const halo = ctx.createRadialGradient(mx, my, 6, mx, my, 70);
    halo.addColorStop(0, 'rgba(226,232,255,0.26)');
    halo.addColorStop(1, 'rgba(226,232,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(mx, my, 70, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#ece9e1';
    ctx.beginPath();
    ctx.arc(mx, my, 16, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,160,175,0.45)';
    for (let i = 0; i < 5; i++) {
      const a = i * 1.9;
      ctx.beginPath();
      ctx.arc(
        mx + Math.cos(a) * (4 + hash01(i + 41) * 7),
        my + Math.sin(a) * (4 + hash01(i + 77) * 7),
        1.1 + hash01(i + 13) * 2.2,
        0,
        TAU,
      );
      ctx.fill();
    }
  }

  private drawSearchlights(ctx: C2D, t: number, split: boolean): void {
    if (this.game.save.settings.reducedMotion) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beams = split
      ? [
          { x: 392, phase: 0, speed: 0.0058, spread: 0.42, len: 320, tint: '255,190,90' },
          { x: 600, phase: 2.6, speed: 0.0049, spread: 0.38, len: 330, tint: '170,200,255' },
        ]
      : [
          { x: 120, phase: 0, speed: 0.0058, spread: 0.5, len: 320, tint: '255,190,90' },
          { x: 520, phase: 2.6, speed: 0.0049, spread: 0.5, len: 330, tint: '170,200,255' },
        ];
    for (const b of beams) {
      const base = 250;
      const ang = -Math.PI / 2 + Math.sin(t * b.speed + b.phase) * b.spread;
      const half = 0.06;
      const ex = b.x + Math.cos(ang) * b.len;
      const ey = base + Math.sin(ang) * b.len;
      const gx = ctx.createLinearGradient(b.x, base, ex, ey);
      gx.addColorStop(0, `rgba(${b.tint},0.18)`);
      gx.addColorStop(0.5, `rgba(${b.tint},0.07)`);
      gx.addColorStop(1, `rgba(${b.tint},0)`);
      ctx.fillStyle = gx;
      ctx.beginPath();
      ctx.moveTo(b.x, base);
      ctx.lineTo(b.x + Math.cos(ang - half) * b.len, base + Math.sin(ang - half) * b.len);
      ctx.lineTo(b.x + Math.cos(ang + half) * b.len, base + Math.sin(ang + half) * b.len);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawRidges(ctx: C2D, t: number): void {
    const layers = [
      { base: 200, amp: 72, scale: 0.0062, seed: 3, drift: 0.04, fill: '#1a1c26', rim: 'rgba(210,220,255,0.16)' },
      { base: 226, amp: 50, scale: 0.0098, seed: 11, drift: 0.08, fill: '#14141b', rim: 'rgba(210,220,255,0.10)' },
      { base: 248, amp: 30, scale: 0.016, seed: 23, drift: 0.14, fill: '#0f0e12', rim: 'rgba(255,190,110,0.10)' },
    ];

    for (const l of layers) {
      const off = t * l.drift;
      ctx.beginPath();
      ctx.moveTo(-4, VIEW_H);
      for (let x = -4; x <= VIEW_W + 4; x += 4) {
        ctx.lineTo(x, l.base - ridgeAt(x + off, l.seed, l.scale) * l.amp);
      }
      ctx.lineTo(VIEW_W + 4, VIEW_H);
      ctx.closePath();
      ctx.fillStyle = l.fill;
      ctx.fill();
      ctx.strokeStyle = l.rim;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

  }

  /** The ground the formation stands on: a wide, dark plateau with a lit lip. */
  private drawPlateau(ctx: C2D, split: boolean): void {
    const top = split ? 246 : 284;
    const g = ctx.createLinearGradient(0, top, 0, VIEW_H);
    g.addColorStop(0, '#1b1512');
    g.addColorStop(0.35, '#120e0c');
    g.addColorStop(1, '#0a0807');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, top + 8);
    for (let x = 0; x <= VIEW_W; x += 16) {
      ctx.lineTo(x, top + Math.sin(x * 0.045) * 2 + hash01(x) * 3);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.lineTo(0, VIEW_H);
    ctx.closePath();
    ctx.fill();
    // The lip catches the ember glow.
    ctx.strokeStyle = 'rgba(255,170,80,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // A few stones and drifts so the plane has scale.
    for (let i = 0; i < 22; i++) {
      const x = hash01(i * 7 + 3) * VIEW_W;
      const y = top + 10 + hash01(i * 7 + 5) * (VIEW_H - top - 14);
      const w = 4 + hash01(i * 7 + 9) * 14 * (y / VIEW_H);
      ctx.fillStyle = hash01(i * 11) > 0.6 ? 'rgba(220,226,240,0.06)' : 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(x, y, w, w * 0.22, 0, 0, TAU);
      ctx.fill();
    }
  }

  /** The searchlight behind the gang: a warm pool they stand in front of. */
  private drawBacklight(ctx: C2D, t: number, split: boolean): void {
    const cx = split ? 492 : 320;
    const cy = split ? 238 : 270;
    const breathe = this.game.save.settings.reducedMotion ? 1 : 1 + 0.04 * Math.sin(t * 0.02);
    const r = (split ? 190 : 230) * breathe;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 8, cx, cy, r);
    g.addColorStop(0, 'rgba(255,170,60,0.30)');
    g.addColorStop(0.4, 'rgba(255,120,40,0.10)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  private drawFormation(ctx: C2D, t: number, split: boolean): void {
    const idle = CLIPS['idle'];
    const pose = CLIPS['dress_pose'] ?? idle;
    if (!idle) return;
    const reduced = this.game.save.settings.reducedMotion;
    const order = split
      ? this.members
      : this.members.slice().sort((a, b) => b.stacked.row - a.stacked.row || a.stacked.y - b.stacked.y);

    for (const m of order) {
      const at = split ? m.split : m.stacked;
      const lead = at.row === 0;
      const clip = lead && pose ? pose : idle;
      // The leader holds the end of his transformation pose, breathing; the rest
      // idle, each on their own beat so the gang never moves as one.
      const f = lead ? 60 + (reduced ? 0 : Math.sin(t * 0.03) * 6) : Math.floor(t * 0.7) + m.phase;
      const p = sampleClip(clip, f);
      const weapon = WEAPONS[m.def.signatureWeapon] ?? null;

      // Contact shadow first, so the plateau knows they are standing on it.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(at.x, at.y + 1, 15 * at.scale, 3.4 * at.scale, 0, 0, TAU);
      ctx.fill();

      // The rig brings its own cool rim light; the rank tint does the depth.
      drawCharacter(ctx, m.style, p, DWARF_SKELETON, at.x, at.y, at.facing, {
        weapon,
        tint: ROW_TINT[at.row],
        scale: at.scale,
      });
    }
  }

  private updateEmbers(): void {
    for (const e of this.embers) {
      e.x += e.vx;
      e.y += e.vy;
      e.vx += (Math.random() - 0.5) * 0.02;
      e.vx = clamp(e.vx, -0.3, 0.3);
      if (e.y < 140 || e.x < -6 || e.x > VIEW_W + 6) {
        e.x = Math.random() * VIEW_W;
        e.y = 300 + Math.random() * 60;
        e.vx = (Math.random() - 0.5) * 0.16;
        e.vy = -0.14 - Math.random() * 0.3;
      }
    }
  }

  private drawEmbers(ctx: C2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      const fade = clamp((e.y - 140) / 100, 0, 1);
      ctx.globalAlpha = e.a * fade;
      ctx.fillStyle = e.hot ? PALETTE.bloodHot : PALETTE.lampHot;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Shade under the menu. Split: a wash from the left edge, so the list reads
   * over the sky without a box around it. Stacked: a wash along the bottom.
   */
  private drawScrim(ctx: C2D, split: boolean): void {
    if (split) {
      const g = ctx.createLinearGradient(0, 0, VIEW_W * 0.62, 0);
      g.addColorStop(0, 'rgba(10,8,7,0.82)');
      g.addColorStop(0.55, 'rgba(10,8,7,0.45)');
      g.addColorStop(1, 'rgba(10,8,7,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      return;
    }
    const g = ctx.createLinearGradient(0, 250, 0, VIEW_H);
    g.addColorStop(0, 'rgba(10,8,7,0)');
    g.addColorStop(1, 'rgba(10,8,7,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 250, VIEW_W, VIEW_H - 250);
  }

  // ── The logo ───────────────────────────────────────────────────────────────

  /**
   * MOUNTAIN, small and tracked out like a stencil on a crate; FIGHTERS, huge,
   * italic and leaning into the fight, in lamp gold with a blood-red extrusion;
   * a studded strap under it, the same studs as the jackets.
   */
  private drawLogo(ctx: C2D, t: number, split: boolean): void {
    const reduced = this.game.save.settings.reducedMotion;
    const settle = reduced ? 1 : clamp(this.frame / 26, 0, 1);
    const ease = 1 - Math.pow(1 - settle, 3);
    const cover = this.cover;

    ctx.save();
    ctx.globalAlpha = 1 - cover * 0.85;
    ctx.textBaseline = 'alphabetic';

    const big = split ? 66 : 58;
    ctx.font = displayFont(big, 900, true);
    const fw = ctx.measureText('FIGHTERS').width;
    const x0 = split ? 34 : VIEW_W * 0.5 - fw * 0.5;
    const yTop = split ? 62 : 52;
    const slide = (1 - ease) * -24;

    // MOUNTAIN
    ctx.font = displayFont(split ? 19 : 17, 800);
    trackedText(ctx, 'MOUNTAIN', x0 + 6 + slide * 0.5, yTop, split ? 9.4 : 8.6, PALETTE.bone);

    // FIGHTERS: extrusion, outline, gradient fill.
    const fy = yTop + big * 0.86;
    const fx = x0 + slide;
    ctx.font = displayFont(big, 900, true);
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    for (let i = 6; i >= 1; i--) {
      ctx.fillStyle = i > 3 ? PALETTE.ink : PALETTE.bloodDeep;
      ctx.fillText('FIGHTERS', fx + i * 0.7, fy + i * 0.9);
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText('FIGHTERS', fx, fy);
    const g = ctx.createLinearGradient(0, fy - big * 0.72, 0, fy);
    g.addColorStop(0, '#ffe7a6');
    g.addColorStop(0.45, PALETTE.lampHot);
    g.addColorStop(0.55, PALETTE.lamp);
    g.addColorStop(1, '#e8780f');
    ctx.fillStyle = g;
    ctx.fillText('FIGHTERS', fx, fy);

    // A glint that crosses the word every few seconds.
    if (!reduced) {
      const cycle = (t % 420) / 420;
      if (cycle < 0.18) {
        const gx = fx - 40 + (fw + 80) * (cycle / 0.18);
        ctx.save();
        ctx.beginPath();
        ctx.rect(fx - 6, fy - big, fw + 16, big + 6);
        ctx.clip();
        ctx.globalCompositeOperation = 'source-atop';
        const sh = ctx.createLinearGradient(gx - 18, 0, gx + 18, 0);
        sh.addColorStop(0, 'rgba(255,255,255,0)');
        sh.addColorStop(0.5, 'rgba(255,255,255,0.55)');
        sh.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sh;
        ctx.font = displayFont(big, 900, true);
        ctx.fillText('FIGHTERS', fx, fy);
        ctx.restore();
      }
    }

    // The studded strap.
    const sy = fy + 9;
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.moveTo(fx + 4, sy - 3.5);
    ctx.lineTo(fx + fw - 2, sy - 3.5);
    ctx.lineTo(fx + fw - 6, sy + 3.5);
    ctx.lineTo(fx, sy + 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = PALETTE.blood;
    ctx.fillRect(fx + 3, sy - 1.2, fw - 8, 2.4);
    for (let x = fx + 9; x < fx + fw - 8; x += 13) {
      ctx.fillStyle = PALETTE.ink;
      ctx.beginPath();
      ctx.arc(x, sy, 2.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = PALETTE.lampHot;
      ctx.beginPath();
      ctx.arc(x, sy, 1.8, 0, TAU);
      ctx.fill();
    }

    // Tagline.
    ctx.font = displayFont(split ? 9 : 8.5, 600);
    const tag = 'SEVEN DWARFS  ·  ONE BILLIONAIRE  ·  ONE VERY BAD IDEA';
    trackedText(
      ctx,
      tag,
      split ? fx + 2 : VIEW_W * 0.5,
      sy + 18,
      1.9,
      PALETTE.boneDim,
      split ? 'left' : 'center',
    );

    ctx.restore();
  }

  // ── Menu construction ──────────────────────────────────────────────────────

  private show(view: MenuView): void {
    this.view = view;
    this.detachRoot();

    let root: HTMLElement;
    switch (view) {
      case 'multiplayer':
        root = this.buildMultiplayer();
        break;
      case 'settings':
        root = this.buildSettings();
        break;
      case 'controls':
        root = this.buildControls();
        break;
      case 'joining':
        root = this.buildJoining();
        break;
      default:
        root = this.buildMenu();
        break;
    }

    root.addEventListener('keydown', this.onViewKey);
    this.root = root;
    this.game.ui.show(root);
  }

  private detachRoot(): void {
    this.controlsNote = null;
    if (!this.root) return;
    this.root.removeEventListener('keydown', this.onViewKey);
    this.root = null;
  }

  /** The left-hand column the title's menus live in. See .ui-view--home. */
  private column(): { view: HTMLElement; list: HTMLElement } {
    const view = document.createElement('nav');
    view.className = 'ui-view--home';
    view.setAttribute('aria-label', 'Main menu');
    if (this.notice) view.appendChild(this.noticeEl(this.notice));
    const list = document.createElement('div');
    list.className = 'menu';
    view.appendChild(list);
    return { view, list };
  }

  /**
   * The keys that drive this menu, as keycaps. Shown only when a keyboard is a
   * plausible thing to be holding — on a phone it is noise.
   */
  private keysLine(items: readonly [string[], string][]): HTMLElement {
    const line = document.createElement('p');
    line.className = 'menu__keys';
    line.setAttribute('aria-hidden', 'true');
    if (coarsePointer()) line.hidden = true;
    for (const [keys, verb] of items) {
      const span = document.createElement('span');
      for (const k of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        span.appendChild(kbd);
      }
      span.appendChild(document.createTextNode(verb));
      line.appendChild(span);
    }
    return line;
  }

  private buildMenu(): HTMLElement {
    const { view, list } = this.column();
    const save = this.game.save;
    const resumable = save.progress > 1;

    // With a run in progress, carrying on is the likeliest thing anybody came
    // back to do, so it is first and it is where focus lands.
    if (resumable) {
      list.appendChild(
        button(`Continue · Map ${save.progress}`, () => this.startGame(save.progress), {
          variant: 'filled',
          wide: true,
          autofocus: true,
        }),
      );
    }
    list.appendChild(
      button('New game', () => this.startGame(1), {
        variant: resumable ? 'tonal' : 'filled',
        wide: true,
        autofocus: !resumable,
      }),
    );
    list.appendChild(
      button('Multiplayer', () => this.go('multiplayer'), { variant: 'outlined', wide: true }),
    );
    if (resumable) {
      // The wall of places you have been. Only worth offering once there is
      // something on it.
      list.appendChild(
        button('Map gallery', () => this.game.setScene('gallery', { mapIndex: save.progress }), {
          variant: 'outlined',
          wide: true,
        }),
      );
    }
    const rule = document.createElement('div');
    rule.className = 'menu__rule';
    list.appendChild(rule);
    list.appendChild(button('Settings', () => this.go('settings'), { variant: 'outlined', wide: true }));
    list.appendChild(button('Controls', () => this.go('controls'), { variant: 'outlined', wide: true }));

    view.appendChild(
      this.keysLine([
        [['↑', '↓'], 'Move'],
        [['Enter'], 'Select'],
      ]),
    );
    return view;
  }

  private buildMultiplayer(): HTMLElement {
    const { view, list } = this.column();

    list.appendChild(
      button('Invite a friend', () => this.hostRoom(), {
        variant: 'filled',
        wide: true,
        autofocus: true,
        title: 'Opens a room and gives you a link to send. They click it and they are in.',
      }),
    );
    const rule = document.createElement('div');
    rule.className = 'menu__rule';
    list.appendChild(rule);
    for (let n = 2; n <= MAX_LOCAL_PLAYERS; n++) {
      list.appendChild(
        button(`Same screen · ${n} players`, () => this.startGame(1, n), {
          variant: 'outlined',
          wide: true,
        }),
      );
    }
    list.appendChild(button('Back', () => this.go('menu'), { variant: 'text', wide: true }));

    const label = document.createElement('p');
    label.className = 'hint';
    // Whatever is bound right now, named the way this keyboard names it. A
    // French player is told ZQSD because that is what is under their fingers.
    label.textContent =
      `Online: send the link, they click it, they are in. Same screen: player one on ` +
      `${this.moveKeys(0)} + ${this.keyFor(0, Btn.Light)}/${this.keyFor(0, Btn.Heavy)}, player two on ` +
      `${this.moveKeys(1)} + the numpad, players three and four on gamepads.`;
    view.appendChild(label);
    return view;
  }

  private buildSettings(): HTMLElement {
    const body = settingsBody({
      settings: this.game.save.settings,
      // Systems hold a live reference to the same Settings object; applySettings
      // only has to push the DOM-side ones out and flush the save.
      commit: () => this.game.applySettings(),
      audio: this.game.audio,
    });

    const view = document.createElement('div');
    view.className = 'stack';
    view.style.width = 'min(680px, 100%)';
    view.style.marginInline = 'auto';
    view.appendChild(panel('Settings', body));
    const foot = document.createElement('div');
    foot.className = 'row row--end';
    foot.appendChild(button('Back', () => this.go('menu'), { variant: 'filled', autofocus: true }));
    view.appendChild(foot);
    return view;
  }

  private buildControls(): HTMLElement {
    const intro = document.createElement('p');
    intro.className = 'hint';
    intro.textContent =
      'Keys go by where they sit, not by what is printed on them — ZQSD on AZERTY, WASD on ' +
      'QWERTY, nothing to set up. Pick a box and press a key to rebind it; it applies at once.';

    const editor = keyBindingEditor({
      bindings: this.game.save.settings.bindings,
      slots: [0, 1],
      onChange: (next) => {
        this.game.applyBindings(next);
        // The footnote names the interact key, so a player who has just moved it
        // must not be left reading about where it used to be.
        if (this.controlsNote) this.controlsNote.textContent = this.controlsNoteText();
        this.game.audio.play('ui_select', { gain: 0.5 });
      },
    });

    const notes = document.createElement('p');
    notes.className = 'hint';
    notes.textContent = this.controlsNoteText();
    this.controlsNote = notes;

    const padNote = document.createElement('p');
    padNote.className = 'hint';
    padNote.textContent =
      'Pick up, swap and ride on the left trigger; super on the right one. The table names ' +
      'them the way your pad does.';

    const view = document.createElement('div');
    view.className = 'stack';
    view.appendChild(panel('Keyboard', intro, editor, notes));
    // The same rule, printed for the other kind of controller: the pad panel
    // reads whatever is plugged in and names its buttons the way that pad names
    // them, and repaints itself when one is plugged in or pulled out.
    view.appendChild(panel('Gamepad', padNote, gamepadPanel()));
    // No autofocus here, unlike the other pages: the point of this one is the
    // editor, so focus lands at the top of it rather than on the way out.
    const foot = document.createElement('div');
    foot.className = 'row row--end';
    foot.appendChild(button('Back', () => this.go('menu'), { variant: 'filled' }));
    view.appendChild(foot);
    return view;
  }

  private buildJoining(): HTMLElement {
    const line = document.createElement('p');
    line.className = 'hint';
    line.setAttribute('role', 'status');
    line.textContent = `Knocking on room ${this.joinRoom.replace(/^mtnfight-/, '')}…`;

    const wait = document.createElement('div');
    wait.className = 'waiting';
    const dot = document.createElement('span');
    dot.className = 'waiting__dot';
    const txt = document.createElement('span');
    txt.textContent = 'Punching a hole through two routers';
    wait.append(dot, txt);

    const cancel = button('Cancel', () => this.cancelJoin(), {
      variant: 'outlined',
      wide: true,
      autofocus: true,
    });

    const view = document.createElement('div');
    view.className = 'stack';
    view.style.width = 'min(420px, 100%)';
    view.appendChild(panel('Joining a fight', line, wait, cancel));
    return view;
  }

  private noticeEl(message: string): HTMLElement {
    const el = document.createElement('p');
    el.className = 'notice notice--error';
    el.setAttribute('role', 'alert');
    el.textContent = message;
    return el;
  }

  // ── Key names ──────────────────────────────────────────────────────────────

  private bindingsFor(slot: number): Record<string, number> {
    return this.game.save.settings.bindings[slot] ?? defaultBindingsFor(slot);
  }

  /** What an action's key actually says, on this keyboard, as bound right now. */
  private keyFor(slot: number, bit: number): string {
    const code = codeForBit(this.bindingsFor(slot), bit);
    return code ? keyLabel(code) : '—';
  }

  /**
   * The footnote under the binding editor.
   *
   * It names the interact key because that is the one action on the list whose
   * existence is the news — weapons used to be collected by walking over them,
   * which quietly did nothing once your hands were full, and vehicles could not
   * be mounted at all. The key comes from the live binding through keyFor(), so
   * it is correct on an AZERTY board and correct after a rebind.
   */
  private controlsNoteText(): string {
    const use = this.keyFor(0, Btn.Interact);
    return (
      'Double-tap a direction to dash. Block on the exact frame a hit lands to parry it and steal ' +
      `meter. ${use} takes the weapon at your feet — press it over another one to trade up, over a ` +
      'bike or a truck to get on, and with nothing in reach to put down what you are carrying. ' +
      'Players 3 and 4 need gamepads — plug them in and press a button.'
    );
  }

  /** The movement diamond as one word: 'WASD', 'ZQSD', 'Arrows', 'I/J/K/L'. */
  private moveKeys(slot: number): string {
    const map = this.bindingsFor(slot);
    const codes: string[] = [];
    for (const bit of [Btn.Up, Btn.Left, Btn.Down, Btn.Right]) {
      const code = codeForBit(map, bit);
      // Somebody has unbound a direction. The stock label is the least wrong
      // thing to print, and the Controls page is where they will find out.
      if (!code) return movementKeysLabel(slot);
      codes.push(code);
    }
    return movementLabelForCodes(codes) || movementKeysLabel(slot);
  }

  /**
   * Detection landed, or the player switched keyboard mid-session.
   *
   * The multiplayer page is rebuilt outright — it is three buttons and a
   * sentence. The Controls page is not: it is the binding editor, which
   * repaints itself and must not be rebuilt underneath a player who is halfway
   * through pressing a key at it. Its one hand-written key name is patched in
   * place instead.
   */
  private onLayoutSettled(): void {
    if (!this.root) return;
    if (this.view === 'controls') {
      if (this.controlsNote) this.controlsNote.textContent = this.controlsNoteText();
      return;
    }
    if (this.view !== 'multiplayer') return;
    this.show('multiplayer');
  }

  // ── Menu behaviour ─────────────────────────────────────────────────────────

  private go(view: MenuView): void {
    this.notice = '';
    this.game.audio.play(view === 'menu' ? 'ui_back' : 'ui_select');
    this.show(view);
  }

  private back(): void {
    if (this.view === 'menu') {
      this.game.audio.play('ui_error');
      return;
    }
    if (this.view === 'joining') {
      this.cancelJoin();
      return;
    }
    this.go('menu');
  }

  private startGame(mapIndex: number, localPlayers = 1): void {
    this.game.audio.play('ui_select');
    const params: SelectParams = { localPlayers, online: false, mapIndex };
    this.game.setScene('select', params);
  }

  private hostRoom(): void {
    this.game.audio.play('ui_select');
    const params: LobbyParams = { fromPause: false, mapIndex: 1 };
    this.game.setScene('lobby', params);
  }

  private async autoJoin(roomId: string): Promise<void> {
    this.joining = true;
    try {
      await this.game.joinRoom(roomId, 'Guest');
      this.joining = false;
      if (this.cancelled) return;
      this.game.audio.play('ui_select');
      const params: SelectParams = { localPlayers: 1, online: true, mapIndex: 1 };
      this.game.setScene('select', params);
    } catch (e) {
      this.joining = false;
      this.game.leaveNet();
      if (this.cancelled) return;
      // A dead link must not trap anybody on a spinner, and it must not sit in
      // the URL waiting to fail again on the next refresh.
      clearRoomFromUrl();
      this.notice = e instanceof Error ? e.message : 'Could not join that room.';
      this.game.audio.play('ui_error');
      this.show('menu');
    }
  }

  private cancelJoin(): void {
    this.game.audio.play('ui_back');
    this.joining = false;
    this.game.leaveNet();
    this.notice = '';
    this.show('menu');
  }

  // ── Keyboard navigation ────────────────────────────────────────────────────

  /**
   * The keys the menu itself does not take.
   *
   * `MenuInput` listens in the capture phase and owns Escape, Space and the
   * up/down walk, stopping each one before it can reach this listener — so any
   * case added back below for those keys would move the focus twice per press.
   * Left and Right are not here either: they now belong to whatever is focused,
   * which is a slider's value or the Controls tab strip, the same as in every
   * other menu in the game.
   *
   * That leaves Backspace, which nothing else claims and which means the same
   * thing as Escape.
   */
  private readonly onViewKey = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'Backspace') return;
    // Anything you can type into wants its own Backspace far more than the menu
    // wants it; a slider is not one of those.
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type !== 'range') return;
    e.preventDefault();
    this.back();
  };
}


/** A phone or a tablet: no keyboard to name keys on, no hover to lean on. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
}
