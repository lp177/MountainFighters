/**
 * The title screen.
 *
 * Canvas draws the show — a procedural logo, a night mountain, sweeping
 * searchlights and seven very unimpressed silhouettes. The DOM draws the menu,
 * because a real <button> is keyboard-operable, screen-reader legible and
 * focusable for free, and a hand-rolled canvas menu is none of those things.
 *
 * The two halves are wired together so the menu is drivable three ways at once:
 * pointer, keyboard (Tab, arrows, Enter, Space, Escape) and gamepad — all of
 * them producing the same ui_move / ui_select / ui_back cues.
 *
 * If the page was opened from an invite link, none of that happens: the scene
 * joins the room and goes straight to character select. A friend who clicks a
 * link should not have to press anything.
 *
 * Everything long-lived — renderer, audio, input, save, the net session — is
 * read off `Game`; this scene owns nothing but its own scenery.
 */

import type { RigStyle, Scene, Settings } from '@/core/types';
import { Btn } from '@/core/types';
import type { Game } from '@/Game';
import type { SelectParams } from '@/scenes/SelectScene';
import type { LobbyParams } from '@/scenes/LobbyScene';

import { MAX_LOCAL_PLAYERS, VIEW_H, VIEW_W } from '@/core/constants';
import { TAU, clamp, lerp } from '@/core/math';
import { DEFAULT_BINDINGS } from '@/engine/input/Bindings';
import { installKeyboard } from '@/engine/input/KeyboardSource';
import { DWARFS } from '@/content/dwarfs';
import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { poly, roundRect, spikeStrip } from '@/render/Shapes';
import { clearRoomFromUrl, roomIdFromUrl } from '@/net/Room';
import { button, panel, slider, toggle } from '@/ui/Widgets';

type C2D = CanvasRenderingContext2D;

export type MenuView = 'menu' | 'multiplayer' | 'settings' | 'controls' | 'joining';

/** Params the scene stack may hand back when returning to the title. */
export interface HomeParams {
  /** Which page of the menu to open on. */
  view?: MenuView;
  /** A message to show in a notice — "the host closed the room", and friends. */
  error?: string;
}

const ACCENT = '#ff2e6e';
const ACCENT_DEEP = '#b8004a';
const ACCENT_HOT = '#ff5c8d';
const GOLD = '#ffd23f';
const INK = '#141019';
const DIM = '#a2aabb';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

/** Frames a held direction waits before it starts repeating, and the repeat gap. */
const NAV_DELAY = 22;
const NAV_REPEAT = 8;

const CONFIRM_MASK = Btn.Light | Btn.Jump | Btn.Special;
const BACK_MASK = Btn.Heavy | Btn.Grab | Btn.Block | Btn.Pause;

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

// ─────────────────────────────────────────────────────────────────────────────
// Canvas text
// ─────────────────────────────────────────────────────────────────────────────

function setFont(ctx: C2D, size: number, weight: number, display: boolean): void {
  ctx.font = `${weight} ${size}px ${display ? DISPLAY : SANS}`;
}

function trackedWidth(ctx: C2D, chars: string[], tracking: number): number {
  if (chars.length === 0) return 0;
  let w = -tracking;
  for (const ch of chars) w += ctx.measureText(ch).width + tracking;
  return w;
}

/** Letter-spaced text. Canvas has no tracking, and the logo lives or dies on it. */
function drawTracked(
  ctx: C2D,
  s: string,
  cx: number,
  y: number,
  tracking: number,
  fill: string | CanvasGradient,
  stroke?: string,
  strokeW = 0,
): number {
  const chars = [...s];
  const w = trackedWidth(ctx, chars, tracking);
  let x = cx - w * 0.5;
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const ch of chars) {
    if (stroke && strokeW > 0) {
      ctx.lineWidth = strokeW;
      ctx.strokeStyle = stroke;
      ctx.strokeText(ch, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key labels for the controls page
// ─────────────────────────────────────────────────────────────────────────────

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    if (rest === 'Decimal') return 'Num .';
    if (rest === 'Add') return 'Num +';
    if (rest === 'Subtract') return 'Num −';
    if (rest === 'Enter') return 'Num ⏎';
    return `Num ${rest}`;
  }
  switch (code) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'ShiftLeft':
      return 'L Shift';
    case 'ShiftRight':
      return 'R Shift';
    case 'Space':
      return 'Space';
    case 'Escape':
      return 'Esc';
    default:
      return code;
  }
}

/** Reverse a bindings map so the controls page can print it back to the player. */
function codeForBit(bindings: Record<string, number>, bit: number): string {
  for (const code of Object.keys(bindings)) {
    if (bindings[code] === bit) return keyLabel(code);
  }
  return '—';
}

interface ControlRow {
  action: string;
  bit: number;
  pad: string;
}

const CONTROL_ROWS: ControlRow[] = [
  { action: 'Move', bit: Btn.Left, pad: 'Stick / D-pad' },
  { action: 'Light attack', bit: Btn.Light, pad: 'A / ✕' },
  { action: 'Heavy attack', bit: Btn.Heavy, pad: 'B / ○' },
  { action: 'Jump', bit: Btn.Jump, pad: 'X / □' },
  { action: 'Special', bit: Btn.Special, pad: 'Y / △' },
  { action: 'Block', bit: Btn.Block, pad: 'RB / R1' },
  { action: 'Grab', bit: Btn.Grab, pad: 'LB / L1' },
  { action: 'Super', bit: Btn.Super, pad: 'RT / R2' },
  { action: 'Pause', bit: Btn.Pause, pad: 'Start' },
];

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
  hot: boolean;
}

interface Silhouette {
  x: number;
  facing: 1 | -1;
  phase: number;
  style: RigStyle;
}

export class HomeScene implements Scene {
  readonly name = 'home';

  private readonly game: Game;

  private frame = 0;
  private view: MenuView = 'menu';
  private notice = '';

  private root: HTMLElement | null = null;

  private navHeld = 0;
  private navTimer = 0;

  private readonly embers: Ember[] = [];
  private readonly silhouettes: Silhouette[] = [];

  /** Room the auto-join path is dialling, so Cancel knows what to hang up on. */
  private joinRoom = '';
  private joining = false;
  private cancelled = false;

  constructor(game: Game) {
    this.game = game;

    // The film dwarfs never turn up on this screen. They already changed.
    const n = DWARFS.length;
    for (let i = 0; i < n; i++) {
      const d = DWARFS[i];
      this.silhouettes.push({
        x: 44 + (i * (VIEW_W - 88)) / (n - 1),
        facing: i % 2 === 0 ? 1 : -1,
        phase: i * 17,
        style: { ...d.style, outfit: 1 },
      });
    }

    for (let i = 0; i < 64; i++) {
      this.embers.push({
        x: Math.random() * VIEW_W,
        y: 240 + Math.random() * 130,
        vx: (Math.random() - 0.5) * 0.16,
        vy: -0.16 - Math.random() * 0.3,
        r: 0.5 + Math.random() * 1.2,
        a: 0.2 + Math.random() * 0.5,
        hot: Math.random() < 0.35,
      });
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    installKeyboard();
    this.frame = 0;
    this.cancelled = false;
    this.navHeld = 0;
    this.navTimer = 0;

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
    this.detachRoot();
    // A session still mid-handshake when the scene dies is a leak with a WebRTC
    // connection attached to it.
    if (this.joining && !this.game.online) this.game.leaveNet();
    this.joining = false;
  }

  update(_dt: number): void {
    this.frame++;
    this.updateEmbers();
    this.padNav();
  }

  render(alpha: number): void {
    const r = this.game.renderer;
    const ctx = r.ctx;
    const t = this.frame + alpha;

    r.begin();
    r.clear('#05060b');
    this.drawSky(ctx, t);
    this.drawSearchlights(ctx, t);
    this.drawRidges(ctx, t);
    this.drawSilhouettes(ctx, t);
    this.drawEmbers(ctx);
    this.drawScrim(ctx);
    this.drawLogo(ctx, t);
    r.end();
  }

  onKey(e: KeyboardEvent): void {
    // The DOM view owns the keyboard while it is mounted; this only catches the
    // gap between views.
    if (this.root) return;
    if (e.key === 'Escape') this.back();
  }

  // ── Backdrop ───────────────────────────────────────────────────────────────

  private drawSky(ctx: C2D, t: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#05060b');
    g.addColorStop(0.42, '#141033');
    g.addColorStop(0.72, '#3a1140');
    g.addColorStop(1, '#0a0710');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Stars. Fixed positions, twinkle only.
    for (let i = 0; i < 110; i++) {
      const x = hash01(i * 3 + 1) * VIEW_W;
      const y = hash01(i * 3 + 2) * 190;
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.03 + i * 1.7));
      const s = hash01(i * 3 + 3);
      ctx.globalAlpha = tw * (0.25 + s * 0.55);
      ctx.fillStyle = s > 0.86 ? GOLD : '#dfe6ff';
      const r = s > 0.86 ? 1.3 : 0.8;
      ctx.fillRect(x, y, r, r);
    }
    ctx.globalAlpha = 1;

    // Moon, and the halo it wears in cold air.
    const mx = 528;
    const my = 56;
    const halo = ctx.createRadialGradient(mx, my, 6, mx, my, 54);
    halo.addColorStop(0, 'rgba(226,232,255,0.30)');
    halo.addColorStop(1, 'rgba(226,232,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(mx, my, 54, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#e6ebf7';
    ctx.beginPath();
    ctx.arc(mx, my, 17, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,160,190,0.5)';
    for (let i = 0; i < 5; i++) {
      const a = i * 1.9;
      ctx.beginPath();
      ctx.arc(
        mx + Math.cos(a) * (4 + hash01(i + 41) * 8),
        my + Math.sin(a) * (4 + hash01(i + 77) * 8),
        1.2 + hash01(i + 13) * 2.4,
        0,
        TAU,
      );
      ctx.fill();
    }
  }

  private drawSearchlights(ctx: C2D, t: number): void {
    if (this.game.save.settings.reducedMotion) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beams = [
      { x: 84, phase: 0, speed: 0.0062, spread: 0.62, len: 330, tint: '255,210,120' },
      { x: 322, phase: 2.1, speed: 0.0048, spread: 0.5, len: 300, tint: '255,120,170' },
      { x: 566, phase: 4.4, speed: 0.0071, spread: 0.7, len: 350, tint: '150,210,255' },
    ];
    for (const b of beams) {
      const base = 276;
      const ang = -Math.PI / 2 + Math.sin(t * b.speed + b.phase) * b.spread;
      const half = 0.052;
      const ex = b.x + Math.cos(ang) * b.len;
      const ey = base + Math.sin(ang) * b.len;
      const gx = ctx.createLinearGradient(b.x, base, ex, ey);
      gx.addColorStop(0, `rgba(${b.tint},0.20)`);
      gx.addColorStop(0.45, `rgba(${b.tint},0.09)`);
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
      { base: 196, amp: 62, scale: 0.0068, seed: 3, drift: 0.045, fill: '#1b2140' },
      { base: 224, amp: 46, scale: 0.0104, seed: 11, drift: 0.085, fill: '#131734' },
      { base: 252, amp: 32, scale: 0.0165, seed: 23, drift: 0.15, fill: '#0c0f22' },
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

      // A cold rim on the moonward face of each ridge.
      ctx.strokeStyle = 'rgba(180,200,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // The plateau the dwarfs are standing on.
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 298, VIEW_W, VIEW_H - 298);
    ctx.strokeStyle = 'rgba(255,46,110,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 298.5);
    ctx.lineTo(VIEW_W, 298.5);
    ctx.stroke();
  }

  private drawSilhouettes(ctx: C2D, t: number): void {
    const idle = CLIPS['idle'];
    if (!idle) return;
    for (const s of this.silhouettes) {
      const pose = sampleClip(idle, Math.floor(t * 0.72) + s.phase);
      drawCharacter(ctx, s.style, pose, DWARF_SKELETON, s.x, 300, s.facing, {
        tint: '#1b1630',
        alpha: 0.96,
        scale: 1.08,
      });
    }
  }

  private updateEmbers(): void {
    for (const e of this.embers) {
      e.x += e.vx;
      e.y += e.vy;
      e.vx += (Math.random() - 0.5) * 0.02;
      e.vx = clamp(e.vx, -0.3, 0.3);
      if (e.y < 150 || e.x < -6 || e.x > VIEW_W + 6) {
        e.x = Math.random() * VIEW_W;
        e.y = 300 + Math.random() * 60;
        e.vx = (Math.random() - 0.5) * 0.16;
        e.vy = -0.16 - Math.random() * 0.3;
      }
    }
  }

  private drawEmbers(ctx: C2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      const fade = clamp((e.y - 150) / 90, 0, 1);
      ctx.globalAlpha = e.a * fade;
      ctx.fillStyle = e.hot ? ACCENT_HOT : GOLD;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawScrim(ctx: C2D): void {
    const g = ctx.createLinearGradient(0, 214, 0, VIEW_H);
    g.addColorStop(0, 'rgba(4,5,8,0)');
    g.addColorStop(0.55, 'rgba(4,5,8,0.66)');
    g.addColorStop(1, 'rgba(4,5,8,0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 214, VIEW_W, VIEW_H - 214);
  }

  // ── The logo ───────────────────────────────────────────────────────────────

  private drawLogo(ctx: C2D, t: number): void {
    const reduced = this.game.save.settings.reducedMotion;
    const bob = reduced ? 0 : Math.sin(t * 0.024) * 2.2;
    const cx = VIEW_W * 0.5;
    const cy = 82 + bob;

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // Mountain badge behind the type: three peaks, snow on the big one.
    poly(
      ctx,
      [cx - 168, cy + 46, cx - 96, cy - 24, cx - 44, cy + 46],
      '#1a2038',
      'rgba(255,46,110,0.20)',
      1.4,
    );
    poly(
      ctx,
      [cx + 44, cy + 46, cx + 104, cy - 30, cx + 172, cy + 46],
      '#1a2038',
      'rgba(255,46,110,0.20)',
      1.4,
    );
    poly(ctx, [cx - 118, cy + 46, cx, cy - 62, cx + 118, cy + 46], '#232a48', ACCENT_DEEP, 1.6);
    poly(ctx, [cx - 30, cy - 32, cx, cy - 62, cx + 30, cy - 32, cx + 12, cy - 26, cx - 8, cy - 34],
      '#e8ecf8', 'none', 0);

    // MOUNTAIN
    setFont(ctx, 21, 900, true);
    drawTracked(ctx, 'MOUNTAIN', cx, cy - 8, 7, '#eceff6', INK, 5);

    // FIGHTERS — the loud half.
    setFont(ctx, 47, 900, true);
    drawTracked(ctx, 'FIGHTERS', cx + 3, cy + 38, 2.5, ACCENT_DEEP);
    const grad = ctx.createLinearGradient(0, cy - 4, 0, cy + 38);
    grad.addColorStop(0, '#ffe6ee');
    grad.addColorStop(0.5, ACCENT_HOT);
    grad.addColorStop(1, ACCENT);
    drawTracked(ctx, 'FIGHTERS', cx, cy + 35, 2.5, grad, INK, 6);

    // Studded bar. The same studs that end up on the jackets.
    spikeStrip(ctx, cx - 146, cy + 47, cx + 146, cy + 47, 16, 3.6, GOLD);
    roundRect(ctx, cx - 150, cy + 44, 300, 3, 1.5, ACCENT_DEEP, 'none', 0);

    setFont(ctx, 9, 700, false);
    drawTracked(
      ctx,
      'SEVEN DWARFS  ·  ONE BILLIONAIRE  ·  ONE VERY BAD IDEA',
      cx,
      cy + 66,
      2.4,
      DIM,
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
    if (!this.root) return;
    this.root.removeEventListener('keydown', this.onViewKey);
    this.root = null;
  }

  /** The menu pages hug the bottom so the logo keeps the top of the screen. */
  private lowColumn(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'stack';
    el.style.alignSelf = 'end';
    el.style.width = 'min(360px, 100%)';
    el.style.gap = '9px';
    return el;
  }

  private buildMenu(): HTMLElement {
    const col = this.lowColumn();
    if (this.notice) col.appendChild(this.noticeEl(this.notice));

    const save = this.game.save;
    col.appendChild(
      button('New Game', () => this.startGame(1), {
        variant: 'filled',
        wide: true,
        autofocus: true,
        icon: '⛏',
      }),
    );

    if (save.progress > 1) {
      col.appendChild(
        button(`Continue — Map ${save.progress}`, () => this.startGame(save.progress), {
          variant: 'tonal',
          wide: true,
          icon: '▶',
        }),
      );
    }

    col.appendChild(
      button('Multiplayer', () => this.go('multiplayer'), {
        variant: 'outlined',
        wide: true,
        icon: '⚔',
      }),
    );
    col.appendChild(
      button('Settings', () => this.go('settings'), { variant: 'outlined', wide: true, icon: '⚙' }),
    );
    col.appendChild(
      button('Controls', () => this.go('controls'), { variant: 'outlined', wide: true, icon: '⌨' }),
    );

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.textAlign = 'center';
    hint.textContent = 'Arrows or stick to move · Enter or A to choose';
    col.appendChild(hint);
    return col;
  }

  private buildMultiplayer(): HTMLElement {
    const col = this.lowColumn();
    if (this.notice) col.appendChild(this.noticeEl(this.notice));

    col.appendChild(
      button('Invite a Friend', () => this.hostRoom(), {
        variant: 'filled',
        wide: true,
        autofocus: true,
        icon: '🔗',
        title: 'Opens a room and gives you a link to send. They click it and they are in.',
      }),
    );

    const label = document.createElement('p');
    label.className = 'hint';
    label.style.textAlign = 'center';
    label.style.margin = '4px 0 0';
    label.textContent = 'Or share this keyboard and a few gamepads:';
    col.appendChild(label);

    for (let n = 2; n <= MAX_LOCAL_PLAYERS; n++) {
      col.appendChild(
        button(`Local — ${n} Players`, () => this.startGame(1, n), {
          variant: 'outlined',
          wide: true,
        }),
      );
    }

    col.appendChild(button('Back', () => this.go('menu'), { variant: 'text', wide: true }));
    return col;
  }

  private buildSettings(): HTMLElement {
    const s = this.game.save.settings;
    const body = document.createElement('div');
    body.className = 'stack';

    body.appendChild(
      slider('Master volume', 0, 1, s.masterVolume, (v) => this.patch({ masterVolume: v })),
    );
    body.appendChild(slider('Effects', 0, 1, s.sfxVolume, (v) => this.patch({ sfxVolume: v })));
    body.appendChild(slider('Music', 0, 1, s.musicVolume, (v) => this.patch({ musicVolume: v })));
    body.appendChild(
      slider('Screen shake', 0, 2, s.screenShake, (v) => this.patch({ screenShake: v }), {
        step: 0.1,
        format: (v) => `${Math.round(v * 100)}%`,
        help: 'There is a great deal of screen shake. Turn it down if you like.',
      }),
    );

    body.appendChild(
      toggle('Reduced motion', s.reducedMotion, (v) => this.patch({ reducedMotion: v }), {
        help: 'Calms the flashes, the shake and the particles. The fights still hurt.',
      }),
    );
    body.appendChild(
      toggle('Show hitboxes', s.showHitboxes, (v) => this.patch({ showHitboxes: v }), {
        help: 'For people who want to argue about frame data.',
      }),
    );

    const diffLabel = document.createElement('div');
    diffLabel.className = 'field__label';
    diffLabel.textContent = 'Difficulty';

    const row = document.createElement('div');
    row.className = 'row';
    const modes: { id: Settings['difficulty']; label: string; help: string }[] = [
      { id: 'easy', label: 'Easy', help: 'The guards are having an off day.' },
      { id: 'normal', label: 'Normal', help: 'A fair fight, which is more than he deserves.' },
      { id: 'hard', label: 'Hard', help: 'They have read your file.' },
      { id: 'musk', label: 'Musk', help: 'Unpaid overtime, and they all block.' },
    ];
    for (const m of modes) {
      const b = button(
        m.label,
        () => {
          this.patch({ difficulty: m.id });
          this.show('settings');
        },
        {
          variant: s.difficulty === m.id ? 'filled' : 'outlined',
          title: m.help,
          ariaLabel: `Difficulty: ${m.label}. ${m.help}`,
        },
      );
      b.setAttribute('aria-pressed', String(s.difficulty === m.id));
      row.appendChild(b);
    }

    const diffField = document.createElement('div');
    diffField.className = 'field';
    diffField.append(diffLabel, row);
    body.appendChild(diffField);

    const view = document.createElement('div');
    view.className = 'stack';
    view.appendChild(panel('Settings', body));
    view.appendChild(
      button('Back', () => this.go('menu'), { variant: 'tonal', wide: true, autofocus: true }),
    );
    return view;
  }

  private buildControls(): HTMLElement {
    const bindings = this.game.save.settings.bindings;
    const p1 = bindings[0] ?? DEFAULT_BINDINGS[0];
    const p2 = bindings[1] ?? DEFAULT_BINDINGS[1];

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'minmax(96px, 1.2fr) 1fr 1fr 1fr';
    grid.style.gap = '4px 12px';
    grid.style.fontSize = 'var(--fs-sm)';

    const head = (txt: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'field__label';
      el.textContent = txt;
      return el;
    };
    grid.append(head('Action'), head('Player 1'), head('Player 2'), head('Gamepad'));

    for (const rowDef of CONTROL_ROWS) {
      const a = document.createElement('div');
      a.textContent = rowDef.action;
      a.style.color = 'var(--on-surface)';

      const mk = (txt: string): HTMLElement => {
        const el = document.createElement('div');
        el.textContent = txt;
        el.style.fontFamily = 'var(--font-mono)';
        el.style.color = 'var(--accent-2)';
        return el;
      };

      const one =
        rowDef.bit === Btn.Left
          ? `${codeForBit(p1, Btn.Up)}${codeForBit(p1, Btn.Left)}${codeForBit(p1, Btn.Down)}${codeForBit(p1, Btn.Right)}`
          : codeForBit(p1, rowDef.bit);
      const two =
        rowDef.bit === Btn.Left
          ? `${codeForBit(p2, Btn.Up)}${codeForBit(p2, Btn.Left)}${codeForBit(p2, Btn.Down)}${codeForBit(p2, Btn.Right)}`
          : codeForBit(p2, rowDef.bit);

      grid.append(a, mk(one), mk(two), mk(rowDef.pad));
    }

    const notes = document.createElement('p');
    notes.className = 'hint';
    notes.textContent =
      'Double-tap a direction to dash. Block on the exact frame a hit lands to parry it and steal meter. ' +
      'Players 3 and 4 need gamepads — plug them in and press a button.';

    const view = document.createElement('div');
    view.className = 'stack';
    view.appendChild(panel('Controls', grid, notes));
    view.appendChild(
      button('Back', () => this.go('menu'), { variant: 'tonal', wide: true, autofocus: true }),
    );
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
      variant: 'text',
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

  // ── Menu behaviour ─────────────────────────────────────────────────────────

  private patch(part: Partial<Settings>): void {
    Object.assign(this.game.save.settings, part);
    // Systems hold a live reference to the same Settings object; applySettings
    // only has to push the DOM-side ones out and flush the save.
    this.game.applySettings();
    this.game.audio.play('ui_move', { gain: 0.5 });
  }

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

  private focusables(): HTMLElement[] {
    if (!this.root) return [];
    return [
      ...this.root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
  }

  private moveFocus(dir: number): void {
    const items = this.focusables();
    if (items.length === 0) return;
    const active = document.activeElement;
    const cur = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = cur < 0 ? (dir > 0 ? 0 : items.length - 1) : (cur + dir + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    this.game.audio.play('ui_move');
  }

  private activateFocused(): void {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) {
      active.click();
      return;
    }
    // Focus fell out of the view entirely (a click on the canvas will do it):
    // put it back rather than swallowing the press.
    const items = this.focusables();
    if (items.length > 0) items[0].focus({ preventScroll: true });
  }

  private readonly onViewKey = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    const onRange = target instanceof HTMLInputElement && target.type === 'range';

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveFocus(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveFocus(-1);
        break;
      case 'ArrowRight':
        if (onRange) return; // the slider wants it more than the menu does
        e.preventDefault();
        this.moveFocus(1);
        break;
      case 'ArrowLeft':
        if (onRange) return;
        e.preventDefault();
        this.moveFocus(-1);
        break;
      case ' ':
      case 'Spacebar':
        // KeyboardSource preventDefaults Space, which would otherwise stop a
        // focused button from firing. Fire it here instead.
        if (target instanceof HTMLButtonElement) {
          e.preventDefault();
          target.click();
        }
        break;
      case 'Escape':
      case 'Backspace':
        if (target instanceof HTMLInputElement && target.type !== 'range') return;
        e.preventDefault();
        this.back();
        break;
      default:
        break;
    }
  };

  // ── Gamepad navigation ─────────────────────────────────────────────────────

  /**
   * Menu navigation from a controller.
   *
   * Only gamepad slots are read here: the keyboard is already talking to the
   * DOM, and sampling it twice would move the focus two places per press.
   */
  private padNav(): void {
    const input = this.game.input;
    let held = 0;
    let pressed = 0;
    for (const slot of input.slots) {
      if (input.source(slot)?.kind !== 'gamepad') continue;
      const f = input.get(slot);
      held |= f.held;
      pressed |= f.pressed;
    }

    if (pressed & CONFIRM_MASK) {
      this.activateFocused();
      return;
    }
    if (pressed & BACK_MASK) {
      this.back();
      return;
    }

    // Held directions repeat, so scrolling a menu with a stick does not need
    // seven separate flicks.
    const dir = held & (Btn.Down | Btn.Right) ? 1 : held & (Btn.Up | Btn.Left) ? -1 : 0;
    if (dir === 0) {
      this.navHeld = 0;
      this.navTimer = 0;
      return;
    }
    if (this.navHeld !== dir) {
      this.navHeld = dir;
      this.navTimer = NAV_DELAY;
      this.moveFocus(dir);
      return;
    }
    if (--this.navTimer <= 0) {
      this.navTimer = NAV_REPEAT;
      this.moveFocus(dir);
    }
  }
}

