/**
 * The pause menu — and the shared menu plumbing the results screens reuse.
 *
 * Pause overlays the frozen fight rather than replacing it: the scene
 * underneath keeps being drawn, a scrim goes over the top, and a real DOM panel
 * takes the keyboard. That is deliberate. A hand-rolled canvas menu would lose
 * focus rings, screen-reader labels, browser zoom and text selection, and gain
 * nothing at all.
 *
 * The headline feature is INVITE FRIEND. You can open the lobby from the middle
 * of a run, hand someone a link, and have them drop into the fight. When the
 * game routes scenes by name we hand off to the real LobbyScene; when it does
 * not, this scene opens the room itself, so the button is never a dead end.
 *
 * Everything is operable from keyboard and gamepad: the DOM gives us the former
 * for free, and `MenuInput` walks focus for the latter.
 */

import type { AudioBus, NetConfig, NetPlayer, Scene, SceneName, Settings } from '@/core/types';
import { Btn } from '@/core/types';

import { DEFAULT_INPUT_DELAY, VIEW_H, VIEW_W } from '@/core/constants';
import { clamp } from '@/core/math';
import { saveSave } from '@/engine/Save';
import { GamepadSource, connectedGamepads, pollGamepads } from '@/engine/input/GamepadSource';
import { KeyboardSource, isCapturing, refreshOwnedKeys } from '@/engine/input/KeyboardSource';
import { defaultBindingsFor } from '@/engine/input/Bindings';

import { Ui, setReducedMotion } from '@/ui/Ui';
import { keyBindingEditor } from '@/ui/KeyBindingEditor';
import { button, panel, slider, toggle } from '@/ui/Widgets';

import { NetSession } from '@/net/NetSession';
import { inviteLink } from '@/net/Room';

import type { SceneHost } from '@/scenes/FightScene';

// ─────────────────────────────────────────────────────────────────────────────
// Scene navigation
// ─────────────────────────────────────────────────────────────────────────────

type SceneFn = (scene: Scene, params?: unknown) => void;

/**
 * Resolves the first scene-stack method the host actually implements.
 *
 * `SceneHost` declares its stack methods optional on purpose: these scenes are
 * written against a Game that might spell `pushScene` as `push`, and a name
 * mismatch should degrade one transition rather than fail the whole build.
 */
function hostFn(host: object, names: readonly string[]): SceneFn | null {
  const o = host as unknown as Record<string, unknown>;
  for (const n of names) {
    const f = o[n];
    if (typeof f === 'function') return (f as SceneFn).bind(host);
  }
  return null;
}

export const nav = {
  push(host: SceneHost, scene: Scene, params?: unknown): boolean {
    const f = hostFn(host, ['pushScene', 'push', 'overlay', 'setScene', 'replaceScene', 'show']);
    if (!f) return false;
    f(scene, params);
    return true;
  },
  replace(host: SceneHost, scene: Scene, params?: unknown): boolean {
    const f = hostFn(host, ['setScene', 'replaceScene', 'replace', 'show', 'pushScene', 'push']);
    if (!f) return false;
    f(scene, params);
    return true;
  },
  pop(host: SceneHost): boolean {
    const f = hostFn(host, ['popScene', 'pop', 'back', 'closeOverlay']);
    if (!f) return false;
    (f as unknown as () => void)();
    return true;
  },
  /** Overlay a scene the host builds by name, keeping what is underneath. */
  pushNamed(host: SceneHost, name: SceneName, params?: unknown): boolean {
    const o = host as unknown as Record<string, unknown>;
    for (const n of ['pushScene', 'push', 'overlay']) {
      const f = o[n];
      if (typeof f === 'function') {
        (f as (n: SceneName, p?: unknown) => void).call(host, name, params);
        return true;
      }
    }
    return false;
  },
  /**
   * Route by name. Hosts that build scenes from a name table accept one
   * straight through `setScene`, which is why the scene-instance methods are
   * tried too — they are the same door.
   */
  goto(host: SceneHost, name: SceneName, params?: unknown): boolean {
    const o = host as unknown as Record<string, unknown>;
    for (const n of ['goto', 'go', 'route', 'changeScene', 'setScene', 'replaceScene', 'show']) {
      const f = o[n];
      if (typeof f === 'function') {
        (f as (n: SceneName, p?: unknown) => void).call(host, name, params);
        return true;
      }
    }
    return false;
  },
};

/** The DOM overlay: the game's own if it has one, otherwise a fresh one. */
export function overlayFor(host: SceneHost): Ui {
  if (host.ui) return host.ui;
  const root = document.getElementById('ui');
  return new Ui(root instanceof HTMLElement ? root : document.body);
}

/** Falls back to reloading when the game exposes no way home. */
export function quitToMenu(host: SceneHost): void {
  if (nav.goto(host, 'home')) return;
  if (typeof location !== 'undefined') location.reload();
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu input — keyboard fix-ups plus full gamepad control of a DOM view
// ─────────────────────────────────────────────────────────────────────────────

/** Frames a held direction waits before it starts repeating on a gamepad. */
const PAD_REPEAT = 11;

export interface MenuInputHooks {
  /** The mounted view, re-read each time because views get swapped. */
  ui(): Ui | null;
  audio: AudioBus;
  /** B / Escape. */
  onBack(): void;
  /** Start / Pause. Defaults to onBack. */
  onStart?(): void;
}

/**
 * Makes a DOM menu behave like a console menu.
 *
 * Two jobs. First, the gameplay keyboard handler suppresses Space's default
 * action (it is the jump button), which would otherwise stop Space activating a
 * focused button — so we listen in the capture phase and do it ourselves.
 * Second, it walks focus, nudges sliders and flips switches from a gamepad.
 */
export class MenuInput {
  private readonly hooks: MenuInputHooks;
  private readonly pads = new Map<number, GamepadSource>();
  private prev = 0;
  private hold = 0;
  private attached = false;

  constructor(hooks: MenuInputHooks) {
    this.hooks = hooks;
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.onKey, true);
  }

  detach(): void {
    if (this.attached && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKey, true);
    }
    this.attached = false;
    for (const src of this.pads.values()) src.dispose();
    this.pads.clear();
    this.prev = 0;
    this.hold = 0;
  }

  /** Call once per frame while the menu is up. */
  poll(): void {
    pollGamepads();
    let mask = 0;
    for (const index of connectedGamepads()) {
      let src = this.pads.get(index);
      if (!src) {
        src = new GamepadSource(index);
        this.pads.set(index, src);
      }
      mask |= src.sample(0);
    }

    const dirs = Btn.Up | Btn.Down | Btn.Left | Btn.Right;
    const pressed = mask & ~this.prev;

    let repeat = 0;
    if (mask & dirs) {
      if (this.hold > 0) this.hold--;
      else {
        repeat = mask & dirs;
        this.hold = PAD_REPEAT;
      }
    } else {
      this.hold = 0;
    }
    // A fresh press always fires; a direction that is merely held fires on the
    // repeat tick, which is what stops a menu scrolling past at 60Hz.
    const move = (pressed & dirs) | (repeat & this.prev & dirs);
    this.prev = mask;

    // The binding editor is waiting for a key. Everything is still sampled so a
    // button held across the wait does not read as a fresh press afterwards,
    // but nothing acts on it: walking focus now would move the menu out from
    // under the row being rebound.
    if (isCapturing()) return;

    if (move & Btn.Up) this.moveFocus(-1);
    else if (move & Btn.Down) this.moveFocus(1);
    else if (move & Btn.Left) this.adjust(-1);
    else if (move & Btn.Right) this.adjust(1);

    if (pressed & (Btn.Light | Btn.Jump)) this.activate();
    else if (pressed & (Btn.Heavy | Btn.Grab)) this.hooks.onBack();
    else if (pressed & Btn.Pause) (this.hooks.onStart ?? this.hooks.onBack)();
  }

  /** Also exposed so a Game that routes DOM keys can call it directly. */
  readonly onKey = (e: KeyboardEvent): void => {
    if (!this.attached) return;
    // This handler is registered before the binding editor's own, so it would
    // otherwise get first refusal on the very keypress the editor is waiting
    // for: Escape would close the page instead of cancelling the capture, and
    // Space would re-click the button rather than becoming the new Jump key.
    if (isCapturing()) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hooks.onBack();
      return;
    }

    const view = this.hooks.ui()?.current ?? null;
    const active = document.activeElement;
    const inView = view !== null && active instanceof HTMLElement && view.contains(active);

    if (e.code === 'Space' && inView && active instanceof HTMLButtonElement) {
      e.preventDefault();
      e.stopPropagation();
      active.click();
      return;
    }

    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      // Sliders own the arrow keys; everything else walks the menu with them.
      if (active instanceof HTMLInputElement && active.type === 'range') return;
      e.preventDefault();
      e.stopPropagation();
      this.moveFocus(e.code === 'ArrowUp' ? -1 : 1);
    }
  };

  private focusables(): HTMLElement[] {
    const view = this.hooks.ui()?.current;
    if (!view) return [];
    const sel =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    return Array.from(view.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => el.offsetParent !== null || el.getClientRects().length > 0,
    );
  }

  private moveFocus(dir: number): void {
    const items = this.focusables();
    if (items.length === 0) return;
    const active = document.activeElement;
    let i = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (i < 0) i = dir > 0 ? -1 : 0;
    const next = items[(i + dir + items.length) % items.length];
    if (!next) return;
    next.focus();
    this.hooks.audio.play('ui_move', { gain: 0.5 });
  }

  private activate(): void {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) {
      active.click();
      return;
    }
    if (active instanceof HTMLInputElement && active.type === 'checkbox') {
      active.checked = !active.checked;
      active.dispatchEvent(new Event('change', { bubbles: true }));
      this.hooks.audio.play('ui_select');
    }
  }

  private adjust(dir: number): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return;

    if (active.type === 'range') {
      const min = Number(active.min);
      const max = Number(active.max);
      const step = Number(active.step) || 0.05;
      active.value = String(clamp(Number(active.value) + step * dir, min, max));
      active.dispatchEvent(new Event('input', { bubbles: true }));
      this.hooks.audio.play('ui_move', { gain: 0.4 });
      return;
    }

    if (active.type === 'checkbox') {
      const want = dir > 0;
      if (active.checked === want) return;
      active.checked = want;
      active.dispatchEvent(new Event('change', { bubbles: true }));
      this.hooks.audio.play('ui_select');
    }
  }
}

// ── DOM helpers, shared with the results screens ─────────────────────────────

export function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function cell(value: string, className = ''): HTMLElement {
  const el = document.createElement('span');
  if (className) el.className = className;
  el.textContent = value;
  return el;
}

export function chip(value: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'chip';
  el.textContent = value;
  return el;
}

/** A label/value tile for the results tables. */
export function statRow(label: string, value: string, highlight = false): HTMLElement {
  const li = document.createElement('li');
  li.className = 'list__item';
  if (highlight) li.classList.add('list__item--self');
  li.appendChild(cell(label, 'grow'));
  const v = document.createElement('strong');
  v.textContent = value;
  li.appendChild(v);
  return li;
}

/**
 * Two tiles per line rather than eight stacked rows. A results board that fills
 * the screen buries the picture behind it, and the picture is half the point.
 */
export function statGrid(rows: HTMLElement[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'list';
  list.style.flexDirection = 'row';
  list.style.flexWrap = 'wrap';
  for (const row of rows) {
    row.style.flex = '1 1 44%';
    row.style.minWidth = '0';
    list.appendChild(row);
  }
  return list;
}

/** Keeps a results view narrow enough that the canvas behind it still reads. */
export function narrow(el: HTMLElement, width = '640px'): HTMLElement {
  el.style.width = `min(${width}, 100%)`;
  el.style.marginInline = 'auto';
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface PauseParams {
  /** The scene to keep drawing behind the scrim. */
  under?: Scene | null;
  onResume?: () => void;
  onQuit?: () => void;
  /** Match already in progress, if any. */
  net?: NetSession | null;
  /** So a paused fight still says where it is. */
  mapName?: string;
  mapIndex?: number;
}

type View = 'root' | 'settings' | 'controls' | 'invite';

const DISPLAY = 'Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif';

/**
 * The pad half of the controls page.
 *
 * The keyboard half used to be a hard-coded table that said W A S D to
 * everybody, including the people whose W is two rows away. It is now the
 * shared binding editor, which reads the live bindings and names every key the
 * way the player's own keyboard names it. The pad cannot be remapped here, so
 * it stays a table.
 */
const PAD_ROWS: readonly (readonly [string, string])[] = [
  ['Move', 'Left stick / d-pad'],
  ['Light attack', 'A / ✕'],
  ['Heavy attack', 'B / ○'],
  ['Jump', 'X / □'],
  ['Special', 'Y / △'],
  ['Block / parry', 'RB / R1'],
  ['Grab', 'LB / L1'],
  ['Super (1 bar)', 'RT / R2'],
  ['Pause', 'Start'],
];

export class PauseScene implements Scene {
  readonly name = 'pause';

  private readonly host: SceneHost;
  private params: PauseParams;
  private readonly settings: Settings;
  private ui: Ui | null = null;
  private readonly menu: MenuInput;

  private view: View = 'root';
  /** Set when there was no scene stack to pop; we then get out of the way. */
  private dismissed = false;

  private net: NetSession | null = null;
  private ownsNet = false;
  private roomId = '';
  private inviteBusy = false;
  private inviteError = '';
  private roster: NetPlayer[] = [];
  private copied = false;

  constructor(host: SceneHost, params?: PauseParams) {
    this.host = host;
    this.params = params ?? {};
    this.settings = host.save.settings;
    this.menu = new MenuInput({
      ui: () => this.ui,
      audio: host.audio,
      onBack: () => this.back(),
      onStart: () => this.resume(),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    if (params && typeof params === 'object') {
      this.params = { ...this.params, ...(params as PauseParams) };
    }
    this.net = this.params.net ?? this.host.net ?? null;
    // Pushed by the game itself (a hidden tab, say) rather than by the fight:
    // find what we are covering so the scrim has something to sit on.
    if (!this.params.under) this.params.under = this.host.findScene?.('fight') ?? null;
    this.view = 'root';
    this.dismissed = false;

    this.ui = overlayFor(this.host);
    this.menu.attach();
    this.mount();
  }

  exit(): void {
    this.menu.detach();
    this.net?.offPlayersChanged(this.onRoster);
    this.ui?.clear();
  }

  onKey(e: KeyboardEvent): void {
    this.menu.onKey(e);
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.dismissed) {
      this.params.under?.update(dt);
      return;
    }
    this.menu.poll();
  }

  render(alpha: number): void {
    // A host with a scene stack draws the whole stack bottom-up, so the fight
    // is already on screen; drawing it again here would double every blend.
    const stacked = this.host.scenes?.includes(this) === true;
    const under = this.params.under;
    if (!stacked && under && under !== this) under.render(alpha);
    if (this.dismissed) return;

    const r = this.host.renderer;
    const ctx = r.ctx;

    r.begin();
    ctx.globalAlpha = 0.66;
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;

    // Hazard chevrons down the left edge. The menu itself is DOM; this is frame.
    for (let y = -8; y < VIEW_H; y += 16) {
      ctx.fillStyle = ((y / 16) | 0) % 2 === 0 ? '#ff2e6e' : '#1a141f';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(6, y + 8);
      ctx.lineTo(6, y + 16);
      ctx.lineTo(0, y + 8);
      ctx.closePath();
      ctx.fill();
    }

    stamp(ctx, 'PAUSED', 12, VIEW_H - 14, 14, '#ffe14a', 'left');
    const map = this.params.mapName;
    if (map) {
      const idx = this.params.mapIndex;
      stamp(
        ctx,
        `${idx === undefined ? '' : `${idx}  `}${map}`.toUpperCase(),
        VIEW_W - 12,
        VIEW_H - 14,
        9,
        '#9aa2b8',
        'right',
      );
    }
    r.end();
  }

  // ── views ──────────────────────────────────────────────────────────────────

  private mount(): void {
    const ui = this.ui;
    if (!ui) return;
    switch (this.view) {
      case 'settings':
        ui.show(this.settingsView());
        break;
      case 'controls':
        ui.show(this.controlsView());
        break;
      case 'invite':
        ui.show(this.inviteView());
        break;
      default:
        ui.show(this.rootView());
        break;
    }
  }

  private go(view: View): void {
    this.view = view;
    this.host.audio.play('ui_select');
    this.mount();
  }

  private rootView(): HTMLElement {
    const stack = div('stack');

    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = 'Paused';
    stack.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent =
      'She is still in there. The clock is not running — but it never really stops.';
    stack.appendChild(sub);

    const rows = div('stack');
    rows.appendChild(
      button('Resume', () => this.resume(), {
        variant: 'filled',
        wide: true,
        autofocus: true,
        icon: '▶',
      }),
    );
    rows.appendChild(
      button('Invite a friend', () => this.invite(), {
        variant: 'tonal',
        wide: true,
        icon: '⚑',
        title: 'Open the lobby and hand somebody a link, mid-fight',
      }),
    );
    rows.appendChild(
      button('Settings', () => this.go('settings'), { variant: 'tonal', wide: true, icon: '⚙' }),
    );
    rows.appendChild(
      button('Controls', () => this.go('controls'), { variant: 'tonal', wide: true, icon: '⌨' }),
    );
    rows.appendChild(
      button('Quit to menu', () => this.quit(), { variant: 'danger', wide: true, icon: '⏻' }),
    );
    stack.appendChild(panel('', rows));

    const foot = document.createElement('p');
    foot.className = 'hint';
    foot.textContent = 'Esc resumes. Arrows or the d-pad move, Enter or A activates, B goes back.';
    stack.appendChild(foot);

    return stack;
  }

  private settingsView(): HTMLElement {
    const s = this.settings;
    const body = div('stack');

    body.appendChild(
      slider('Master volume', 0, 1, s.masterVolume, (v) => {
        s.masterVolume = v;
        this.persist();
      }),
    );
    body.appendChild(
      slider('Music', 0, 1, s.musicVolume, (v) => {
        s.musicVolume = v;
        this.persist();
      }),
    );
    body.appendChild(
      slider('Sound effects', 0, 1, s.sfxVolume, (v) => {
        s.sfxVolume = v;
        this.host.audio.play('punch_light', { gain: 0.7 });
        this.persist();
      }),
    );
    body.appendChild(
      slider(
        'Screen shake',
        0,
        2,
        s.screenShake,
        (v) => {
          s.screenShake = v;
          this.persist();
        },
        {
          step: 0.1,
          format: (v) => `${Math.round(v * 100)}%`,
          help: 'Zero turns the camera kick off completely.',
        },
      ),
    );
    body.appendChild(
      toggle(
        'Reduced motion',
        s.reducedMotion,
        (v) => {
          s.reducedMotion = v;
          setReducedMotion(v);
          this.persist();
        },
        { help: 'Cuts particles, slow motion, screen flashes and menu animation.' },
      ),
    );
    body.appendChild(
      toggle(
        'Show hitboxes',
        s.showHitboxes,
        (v) => {
          s.showHitboxes = v;
          this.persist();
        },
        { help: 'Draws every live hitbox and hurtbox. Ugly, honest, useful.' },
      ),
    );

    const foot = div('row row--end');
    foot.appendChild(button('Back', () => this.back(), { variant: 'filled', autofocus: true }));

    const stack = div('stack');
    stack.appendChild(panel('Settings', body));
    stack.appendChild(foot);
    return stack;
  }

  private controlsView(): HTMLElement {
    const intro = document.createElement('p');
    intro.className = 'hint';
    intro.textContent =
      'Keys are stored by position on the board rather than by the letter on the cap, so the ' +
      'movement diamond is ZQSD on an AZERTY keyboard and WASD on a QWERTY one on its own. ' +
      'Change anything you like: it lands on the fight you are standing in, not on the next one.';

    const editor = keyBindingEditor({
      bindings: this.settings.bindings,
      slots: [0, 1],
      onChange: (next) => {
        this.applyBindings(next);
        this.host.audio.play('ui_select', { gain: 0.5 });
      },
    });

    const pads = document.createElement('ul');
    pads.className = 'list';
    for (const [action, pad] of PAD_ROWS) {
      const li = document.createElement('li');
      li.className = 'list__item';
      li.appendChild(cell(action, 'grow'));
      li.appendChild(chip(pad));
      pads.appendChild(li);
    }

    const notes = document.createElement('p');
    notes.className = 'hint';
    notes.textContent =
      'Tap a direction twice to dash. Block on the first frame a blow lands to parry it. ' +
      'A full bar buys the ultimate, and the ultimate does not care where anybody is standing.';

    const foot = div('row row--end');
    foot.appendChild(button('Back', () => this.back(), { variant: 'filled' }));

    const stack = div('stack');
    stack.appendChild(panel('Controls', intro, editor, notes));
    stack.appendChild(panel('Gamepad', pads));
    stack.appendChild(foot);
    return stack;
  }

  private inviteView(): HTMLElement {
    const body = div('stack');

    if (this.inviteError) {
      const err = div('notice notice--error');
      err.textContent = this.inviteError;
      body.appendChild(err);
      body.appendChild(button('Try again', () => this.startHosting(true), { variant: 'tonal' }));
    } else if (!this.roomId) {
      const wait = div('waiting');
      const dot = document.createElement('span');
      dot.className = 'waiting__dot';
      wait.appendChild(dot);
      wait.appendChild(cell(this.inviteBusy ? 'Opening a room…' : 'Getting ready…'));
      body.appendChild(wait);
    } else {
      const link = inviteLink(this.roomId);

      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent =
        'Send this. Opening it drops them into character select and then straight into the fight.';
      body.appendChild(hint);

      const code = div('code');
      code.textContent = link;
      body.appendChild(code);

      const row = div('row');
      const copy: HTMLButtonElement = button(
        this.copied ? 'Copied' : 'Copy link',
        () => this.copyText(link, copy),
        { variant: 'filled', icon: '⧉' },
      );
      row.appendChild(copy);
      const codeBtn: HTMLButtonElement = button(
        'Copy room code',
        () => this.copyText(this.roomId, codeBtn),
        { variant: 'tonal' },
      );
      row.appendChild(codeBtn);
      body.appendChild(row);

      const list = document.createElement('ul');
      list.className = 'list';
      if (this.roster.length === 0) {
        const li = document.createElement('li');
        li.className = 'list__item list__item--empty';
        li.textContent = 'Nobody has knocked yet.';
        list.appendChild(li);
      } else {
        for (const p of this.roster) {
          const li = document.createElement('li');
          li.className = 'list__item';
          if (p.slot === (this.net?.slot ?? -1)) li.classList.add('list__item--self');
          li.appendChild(cell(`P${p.slot + 1}  ${p.name}`, 'grow'));
          li.appendChild(chip(p.dwarfId ? p.dwarfId.toUpperCase() : 'CHOOSING'));
          if (p.ping > 0) li.appendChild(chip(`${p.ping} ms`));
          list.appendChild(li);
        }
      }
      body.appendChild(list);
    }

    const foot = div('row row--between');
    foot.appendChild(button('Back', () => this.back(), { variant: 'tonal' }));
    foot.appendChild(
      button('Resume', () => this.resume(), { variant: 'filled', autofocus: true }),
    );

    const stack = div('stack');
    stack.appendChild(panel('Invite a friend', body));
    stack.appendChild(foot);
    return stack;
  }

  // ── actions ────────────────────────────────────────────────────────────────

  private resume(): void {
    this.host.audio.play('ui_back');
    this.ui?.clear();
    this.params.onResume?.();
    if (nav.pop(this.host)) return;
    // Nothing to pop: stop drawing the menu and let the fight underneath run.
    this.menu.detach();
    this.dismissed = true;
  }

  private back(): void {
    if (this.view === 'root') {
      this.resume();
      return;
    }
    this.host.audio.play('ui_back');
    this.view = 'root';
    this.mount();
  }

  /**
   * The headline: a lobby from the middle of a run.
   *
   * When the game can overlay a lobby by name we step out of the way first, so
   * the lobby sits directly on the frozen fight and its own way out really does
   * lead back to the fight rather than to this menu again. When it cannot, we
   * open the room here instead — the button is never a dead end.
   */
  private invite(): void {
    this.host.audio.play('ui_select');

    const canOverlay =
      typeof (this.host as unknown as Record<string, unknown>).pushScene === 'function';

    if (canOverlay) {
      const params = {
        fromPause: true,
        from: 'pause',
        invite: true,
        mapIndex: this.params.mapIndex,
      };
      this.menu.detach();
      this.ui?.clear();
      this.params.onResume?.();
      nav.pop(this.host);
      if (nav.pushNamed(this.host, 'lobby', params)) return;
      // The overlay never happened; put ourselves back rather than vanishing.
      this.menu.attach();
      nav.push(this.host, this);
    }

    this.view = 'invite';
    this.startHosting(false);
    this.mount();
  }

  private startHosting(retry: boolean): void {
    if (this.inviteBusy && !retry) return;
    this.inviteError = '';
    this.copied = false;

    let net = this.net;
    if (!net) {
      const cfg: NetConfig = { inputDelay: DEFAULT_INPUT_DELAY };
      net = new NetSession(cfg);
      this.net = net;
      this.ownsNet = true;
    }
    net.onPlayersChanged(this.onRoster);

    if (net.role === 'host' && net.localId) {
      this.roomId = net.localId;
      this.inviteBusy = false;
      this.mount();
      return;
    }

    this.inviteBusy = true;
    this.roomId = '';
    this.mount();

    net.host().then(
      (id) => {
        this.roomId = id;
        this.inviteBusy = false;
        this.host.audio.play('coin', { pitch: 1.3 });
        if (this.view === 'invite') this.mount();
      },
      (e: unknown) => {
        this.inviteBusy = false;
        this.inviteError =
          e instanceof Error ? e.message : 'Could not open a room. The broker never answered.';
        this.host.audio.play('ui_error');
        if (this.view === 'invite') this.mount();
      },
    );
  }

  private readonly onRoster = (players: NetPlayer[]): void => {
    this.roster = players.slice();
    if (this.view === 'invite') this.mount();
  };

  private copyText(value: string, btn: HTMLButtonElement): void {
    const done = (ok: boolean): void => {
      this.copied = ok;
      const label = btn.querySelector('.btn__label');
      if (label) label.textContent = ok ? 'Copied' : 'Select it and copy by hand';
      this.host.audio.play(ok ? 'ui_select' : 'ui_error');
    };

    const clip = typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(value).then(
        () => done(true),
        () => done(false),
      );
      return;
    }
    done(false);
  }

  private quit(): void {
    this.host.audio.play('ui_back');
    this.host.audio.music('menu');
    this.menu.detach();
    this.ui?.clear();
    this.params.onQuit?.();

    if (this.ownsNet) {
      this.net?.close();
      this.net = null;
      this.ownsNet = false;
    }
    quitToMenu(this.host);
  }

  /**
   * Systems hold a live reference to the same Settings object, so a change is
   * already in effect; all that is left is the DOM side and the write to disk.
   */
  private persist(): void {
    const h = this.host as unknown as Record<string, unknown>;
    const fn = h.applySettings ?? h.persist ?? h.saveNow;
    if (typeof fn === 'function') {
      (fn as () => void).call(this.host);
      return;
    }
    saveSave(this.host.save);
  }

  /**
   * A rebind, applied to the fight that is frozen underneath this menu.
   *
   * The Game knows how to do this properly — save, suppression set, every live
   * input source — so it is asked first. The fallback is the same three steps
   * done by hand, because a host that is not Game still has a player sitting in
   * front of a keyboard that has just changed meaning.
   */
  private applyBindings(next: Record<number, Record<string, number>>): void {
    const fn = (this.host as unknown as Record<string, unknown>).applyBindings;
    if (typeof fn === 'function') {
      (fn as (b: Record<number, Record<string, number>>) => void).call(this.host, next);
      return;
    }

    const merged: Record<number, Record<string, number>> = { ...this.settings.bindings };
    for (const key of Object.keys(next)) {
      const slot = Number(key);
      const map = next[slot];
      if (!Number.isInteger(slot) || slot < 0 || !map || typeof map !== 'object') continue;
      merged[slot] = { ...map };
    }
    this.settings.bindings = merged;

    refreshOwnedKeys(merged);
    for (const slot of this.host.input.slots) {
      const src = this.host.input.source(slot);
      if (src instanceof KeyboardSource) src.setBindings(merged[slot] ?? defaultBindingsFor(slot));
    }
    this.persist();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Outlined display text. Shared with the results screens' canvas layers. */
export function stamp(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'center',
): void {
  ctx.font = `900 ${size}px ${DISPLAY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(1.6, size * 0.24);
  ctx.strokeStyle = '#120e18';
  ctx.strokeText(value, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(value, x, y);
}
