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

import type { NetConfig, NetPlayer, Scene, SceneName, Settings } from '@/core/types';

import { DEFAULT_INPUT_DELAY, VIEW_H, VIEW_W } from '@/core/constants';
import { saveSave } from '@/engine/Save';
import { KeyboardSource, refreshOwnedKeys } from '@/engine/input/KeyboardSource';
import { defaultBindingsFor } from '@/engine/input/Bindings';

import { Ui } from '@/ui/Ui';
import { MenuInput } from '@/ui/MenuInput';
import { gamepadPanel, keyBindingEditor } from '@/ui/KeyBindingEditor';
import { button, panel } from '@/ui/Widgets';
import { settingsBody } from '@/ui/SettingsPanel';

import { NetSession } from '@/net/NetSession';
import { inviteLink } from '@/net/Room';

import type { SceneHost } from '@/scenes/FightScene';

import { PALETTE, inkText } from '@/ui/theme';
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
    // The fight stays visible on the right, frozen mid-swing; the left, where
    // the menu stands, goes nearly to black so the list reads without a box.
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(12,10,9,0.55)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const g = ctx.createLinearGradient(0, 0, VIEW_W * 0.62, 0);
    g.addColorStop(0, 'rgba(12,10,9,0.9)');
    g.addColorStop(0.6, 'rgba(12,10,9,0.55)');
    g.addColorStop(1, 'rgba(12,10,9,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // One lamp-gold stripe down the left edge: the frame, not a decoration.
    ctx.fillStyle = PALETTE.lamp;
    ctx.fillRect(0, 0, 3, VIEW_H);

    // Where you are, quietly, bottom right. The menu itself says PAUSED.
    const map = this.params.mapName;
    if (map && this.view === 'root') {
      const idx = this.params.mapIndex;
      inkText(
        ctx,
        `${idx === undefined ? '' : `MAP ${String(idx).padStart(2, '0')}  ·  `}${map}`.toUpperCase(),
        VIEW_W - 14,
        VIEW_H - 14,
        9,
        PALETTE.boneDim,
        { align: 'right', weight: 800, shadow: 0 },
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
    const view = document.createElement('nav');
    view.className = 'ui-view--pause';
    view.setAttribute('aria-label', 'Pause menu');

    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = 'Paused';
    view.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent = 'She is still in there. The clock is not running — but it never really stops.';
    view.appendChild(sub);

    const list = div('menu');
    list.appendChild(
      button('Resume', () => this.resume(), { variant: 'filled', wide: true, autofocus: true }),
    );
    list.appendChild(
      button('Invite a friend', () => this.invite(), {
        variant: 'outlined',
        wide: true,
        title: 'Open the lobby and hand somebody a link, mid-fight',
      }),
    );
    list.appendChild(button('Settings', () => this.go('settings'), { variant: 'outlined', wide: true }));
    list.appendChild(button('Controls', () => this.go('controls'), { variant: 'outlined', wide: true }));
    list.appendChild(div('menu__rule'));
    list.appendChild(button('Quit to title', () => this.quit(), { variant: 'danger', wide: true }));
    view.appendChild(list);

    const keys = document.createElement('p');
    keys.className = 'menu__keys';
    keys.setAttribute('aria-hidden', 'true');
    for (const [k, verb] of [
      ['Esc', 'Resume'],
      ['Enter', 'Select'],
    ] as const) {
      const span = document.createElement('span');
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      span.append(kbd, document.createTextNode(verb));
      keys.appendChild(span);
    }
    view.appendChild(keys);
    return view;
  }

  private settingsView(): HTMLElement {
    const body = settingsBody({
      settings: this.settings,
      commit: () => this.persist(),
      audio: this.host.audio,
      midRun: true,
    });

    const foot = div('row row--end');
    foot.appendChild(button('Back', () => this.back(), { variant: 'filled', autofocus: true }));

    const stack = div('stack');
    stack.style.width = 'min(680px, 100%)';
    stack.style.marginInline = 'auto';
    stack.appendChild(panel('Settings', body));
    stack.appendChild(foot);
    return stack;
  }

  private controlsView(): HTMLElement {
    const intro = document.createElement('p');
    intro.className = 'hint';
    intro.textContent =
      'Keys go by where they sit, not by what is printed on them. Pick a box and press a key ' +
      'to rebind it — it lands on the fight you are standing in, not on the next one.';

    const editor = keyBindingEditor({
      bindings: this.settings.bindings,
      slots: [0, 1],
      onChange: (next) => {
        this.applyBindings(next);
        this.host.audio.play('ui_select', { gain: 0.5 });
      },
    });

    const notes = document.createElement('p');
    notes.className = 'hint';
    notes.textContent =
      'Tap a direction twice to dash. Block on the first frame a blow lands to parry it. ' +
      'A full bar buys the ultimate, and the ultimate does not care where anybody is standing.';

    const foot = div('row row--end');
    foot.appendChild(button('Back', () => this.back(), { variant: 'filled' }));

    const stack = div('stack');
    stack.appendChild(panel('Keyboard', intro, editor, notes));
    // Pads follow the same rule as the keys — bound by position, printed by
    // vendor — so this panel reads the pads that are actually in somebody's
    // hands and prints their own letters, mid-fight plug-ins included.
    stack.appendChild(panel('Gamepad', gamepadPanel()));
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
          const path = this.net?.transportFor(p.peerId);
          if (path && path.route !== 'unknown') {
            const wire = (path.relayProtocol || path.protocol).toUpperCase();
            li.appendChild(chip(`${path.route === 'relay' ? 'TURN' : 'P2P'}${wire ? `/${wire}` : ''}`));
          }
          list.appendChild(li);
        }
      }
      body.appendChild(list);

      if (this.net) {
        // During a fight the host-negotiated value is fixed. RTT may drift,
        // but showing a newly recommended value here would claim a buffer the
        // running simulation is not actually using.
        const delay = this.host.lockstep?.inputDelay ?? this.net.recommendedInputDelay;
        const quality = document.createElement('p');
        quality.className = this.net.inputDelayCapped ? 'notice notice--warn' : 'hint';
        quality.textContent = `${delay}-frame network buffer (${Math.round(delay * (1000 / 60))} ms)`;
        body.appendChild(quality);
      }
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
  inkText(ctx, value, x, y, size, fill, { align, weight: 900, italic: true });
}
