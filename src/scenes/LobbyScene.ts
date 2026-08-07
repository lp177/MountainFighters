/**
 * The host's waiting room.
 *
 * The whole online flow is one link. You open a room, you send the link, your
 * friend clicks it and lands in character select. There is no lobby browser, no
 * six-character code read out over a bad phone line and no account.
 *
 * So this screen has exactly three jobs: hand over the link in a way that
 * survives a locked-down clipboard, show who has actually turned up and how far
 * away they are, and get out of the way.
 *
 * It is also reachable from the pause menu mid-fight, which is why the primary
 * action is a parameter: from the title it starts the match, from a pause it
 * just puts you back in the fight with the room still open behind you.
 */

import type { NetMessage, NetPlayer, Scene } from '@/core/types';
import type { Game } from '@/Game';
import type { NetSession } from '@/net/NetSession';
import type { SelectParams } from '@/scenes/SelectScene';
import type { HomeParams } from '@/scenes/HomeScene';

import { MAX_LOCAL_PLAYERS, VIEW_H, VIEW_W } from '@/core/constants';
import { TAU, clamp, lerp } from '@/core/math';
import { getDwarf } from '@/content/dwarfs';
import { clearRoomFromUrl, normalizeRoomId, roomIdFromUrl } from '@/net/Room';
import { inviteLink } from '@/net/Room';
import { MenuInput } from '@/ui/MenuInput';
import { button, panel } from '@/ui/Widgets';

type C2D = CanvasRenderingContext2D;

/** Params handed to `setScene('lobby', …)` / `pushScene('lobby', …)`. */
export interface LobbyParams {
  /** True when pushed over a running fight, so Back returns to it. */
  fromPause?: boolean;
  /** The pause menu's spelling of the same thing. */
  from?: string;
  /** Map the fight starts on once everyone has picked. */
  mapIndex?: number;
  /**
   * A room to JOIN rather than open. This is what an invite link means.
   *
   * It was declared here from the start and read by nothing: `enter()` looked
   * at `fromPause` and `mapIndex` and then unconditionally opened a room. A
   * guest who clicked an invite was therefore made a host of their own empty
   * room, with their own new code, while the person who invited them waited in
   * the original — both looking at a plausible screen, neither seeing an error.
   */
  join?: string;
  /** The main entry's spelling of the same thing. */
  roomId?: string;
}

type Phase = 'opening' | 'joining' | 'open' | 'error';

const ACCENT = '#ff2e6e';
const GOLD = '#ffd23f';
const DIM = '#a2aabb';
const FAINT = '#6d768a';

const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

/** Refresh the roster on this cadence so pings tick even between net events. */
const REFRESH_EVERY = 20;

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function ridgeAt(x: number, seed: number, scale: number): number {
  let sum = 0;
  let amp = 1;
  let f = scale;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    const t = x * f;
    const i = Math.floor(t);
    const fr = t - i;
    const s = fr * fr * (3 - 2 * fr);
    const v = lerp(hash01(i + (seed + o) * 7919), hash01(i + 1 + (seed + o) * 7919), s);
    sum += (1 - Math.abs(v * 2 - 1)) * amp;
    norm += amp;
    amp *= 0.48;
    f *= 2.3;
  }
  return sum / norm;
}

/** Ping colour bands. Under 60ms is a friend on the same continent. */
function pingClass(ms: number): string {
  if (ms <= 0) return 'chip';
  if (ms < 60) return 'chip chip--live';
  if (ms < 140) return 'chip chip--warn';
  return 'chip chip--bad';
}

function chip(text: string, className = 'chip'): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export class LobbyScene implements Scene {
  readonly name = 'lobby';

  private readonly game: Game;
  private readonly menu: MenuInput;

  private frame = 0;
  private fromPause = false;
  private mapIndex = 1;

  private phase: Phase = 'opening';
  private session: NetSession | null = null;
  private roomId = '';
  private error = '';
  private dead = false;

  /** The room we were invited to, if we arrived on a link. Held until connected. */
  private invite: string | null = null;
  private linkInput: HTMLInputElement | null = null;
  private copyHint: HTMLElement | null = null;
  private rosterEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private startBtn: HTMLButtonElement | null = null;

  constructor(game: Game) {
    this.game = game;
    // Both doors into this room can be opened with a pad — the multiplayer menu
    // from the title, and the pause menu, which detaches its own MenuInput on
    // the way here — and until this existed neither had a pad-shaped way back
    // out. A host who opened a room had to reach for a keyboard to close it.
    this.menu = new MenuInput({
      ui: () => this.game.ui,
      audio: this.game.audio,
      onBack: () => this.leave(),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(params?: unknown): void {
    const p = (params ?? {}) as LobbyParams;
    this.fromPause = p.fromPause === true || p.from === 'pause';
    this.mapIndex = Math.max(1, Math.floor(p.mapIndex ?? this.game.run.mapIndex ?? 1));
    this.frame = 0;
    this.dead = false;
    this.error = '';

    if (!this.fromPause) this.game.audio.music('menu');

    // Attached before anything is mounted, and before the early return below,
    // so every shape of this screen — opening, open, error, over a live fight —
    // is escapable. The first poll after an attach only samples, so the button
    // that opened the room does not read as a press that closes it again.
    this.menu.attach();

    // An invite beats everything else this screen can do. Taken from the params,
    // from the pending join Game parked at boot, or straight out of the URL —
    // whichever survived — because the one thing that must never happen is a
    // guest silently becoming a host.
    const invite = this.fromPause
      ? null
      : (normalizeRoomId(p.join ?? p.roomId ?? '') ?? this.game.pendingJoin ?? roomIdFromUrl());

    const live = this.game.net;
    if (live && live.role === 'host' && live.connected) {
      // Invited from the pause menu with a room already open: reuse it rather
      // than tearing down a session the fight is running on.
      this.session = live;
      this.roomId = live.localId;
      this.phase = 'open';
      this.subscribe(live);
      this.rebuild();
      return;
    }

    if (invite) {
      this.invite = invite;
      this.phase = 'joining';
      this.rebuild();
      void this.joinRoom(invite);
      return;
    }

    this.phase = 'opening';
    this.rebuild();
    void this.openRoom();
  }

  /**
   * Take up an invite.
   *
   * The fragment stays in the URL for the whole of this: room ids are
   * idempotent, so replaying one on a refresh is exactly right, and a chat app
   * that hands the link off to the real browser reloads at least once. Scrubbing
   * it on arrival is what turned "the host is not ready yet" into "you are now
   * hosting a different room".
   */
  private async joinRoom(roomId: string): Promise<void> {
    try {
      await this.game.joinRoom(roomId, 'Guest');
      const session = this.game.net;
      if (this.dead || !session) {
        if (this.dead) this.game.leaveNet();
        return;
      }
      this.session = session;
      this.roomId = roomId;
      this.phase = 'open';
      this.subscribe(session);
      this.game.audio.play('ui_select');
      this.rebuild();
    } catch (e) {
      // Deliberately NOT leaveNet(): that scrubs the fragment, and the invite is
      // the only way back to the right room.
      this.game.closeNet();
      if (this.dead) return;
      this.session = null;
      this.error =
        e instanceof Error
          ? e.message
          : 'Could not reach that room. The host may not have opened it yet.';
      this.phase = 'error';
      this.game.audio.play('ui_error');
      this.rebuild();
    }
  }

  exit(): void {
    this.dead = true;
    this.menu.detach();
    const s = this.session;
    if (s) {
      s.offMessage(this.onNet);
      s.offPlayersChanged(this.onRoster);
    }
    this.game.ui.clear();
    this.linkInput = null;
    this.copyHint = null;
    this.rosterEl = null;
    this.statusEl = null;
    this.startBtn = null;
  }

  update(_dt: number): void {
    this.frame++;
    this.menu.poll();
    if (this.phase === 'open' && this.frame % REFRESH_EVERY === 0) this.refresh();
  }

  render(alpha: number): void {
    const r = this.game.renderer;
    const ctx = r.ctx;
    const t = this.frame + alpha;

    r.begin();
    if (this.fromPause) {
      // Pushed over a live fight: the fight has already drawn itself and must
      // not be wiped. Dim it and put the banner on top.
      ctx.fillStyle = 'rgba(4,5,8,0.78)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      this.drawBanner(ctx, t);
    } else {
      r.clear('#06070a');
      this.drawBackdrop(ctx, t);
    }
    r.end();
  }

  /**
   * Escape used to be answered here. It belongs to MenuInput now, which already
   * owns it for the pad's B button: two owners of one key is one room closed
   * twice, and the second close lands on a scene that has already gone.
   *
   * The link field keeps the keys that matter to it. MenuInput ignores anything
   * held with a modifier, so Ctrl+C on the selected link still copies, and the
   * only keys it takes from the field are the arrows — which on a read-only
   * input have nothing to move a caret through, and are the pad's way off it.
   */
  onKey(e: KeyboardEvent): void {
    this.menu.onKey(e);
  }

  // ── Net ────────────────────────────────────────────────────────────────────

  private async openRoom(): Promise<void> {
    try {
      const id = await this.game.hostRoom('Host');
      const session = this.game.net;
      if (this.dead || !session) {
        if (this.dead) this.game.leaveNet();
        return;
      }
      this.session = session;
      this.roomId = id;
      this.phase = 'open';
      this.subscribe(session);
      this.game.audio.play('ui_select');
      this.rebuild();
    } catch (e) {
      this.game.leaveNet();
      if (this.dead) return;
      this.session = null;
      this.error =
        e instanceof Error ? e.message : 'Could not open a room. The broker may be having a day.';
      this.phase = 'error';
      this.game.audio.play('ui_error');
      this.rebuild();
    }
  }

  private subscribe(session: NetSession): void {
    session.onMessage(this.onNet);
    session.onPlayersChanged(this.onRoster);
    session.onError(this.onNetError);
  }

  private readonly onNet = (m: NetMessage): void => {
    if (this.dead) return;
    if (m.t === 'hello' || m.t === 'roster' || m.t === 'bye') this.refresh();
  };

  private readonly onRoster = (_players: NetPlayer[]): void => {
    if (this.dead) return;
    this.refresh();
  };

  private readonly onNetError = (message: string): void => {
    if (this.dead) return;
    this.error = message;
    this.refresh();
  };

  // ── View ───────────────────────────────────────────────────────────────────

  private rebuild(): void {
    const view = document.createElement('div');
    view.className = 'stack';

    switch (this.phase) {
      case 'opening':
      case 'joining':
        view.appendChild(this.buildOpening());
        break;
      case 'error':
        view.appendChild(this.buildError());
        // Try again is always the SAME thing again — the same invite for a
        // guest, a new room only for someone who was opening one. Opening a
        // fresh room as the answer to a broken invite is how two people end up
        // sitting in two rooms, each looking at a screen that says it worked.
        view.appendChild(
          button('Try again', () => this.retry(), { variant: 'filled', autofocus: true }),
        );
        // And if the host really is not coming, saying so is a deliberate act
        // with its own button, not something that happens by pressing Back.
        if (this.invite) {
          view.appendChild(
            button('Host my own room instead', () => this.hostInstead(), { variant: 'tonal' }),
          );
        }
        view.appendChild(button('Back', () => this.leave(), { variant: 'text' }));
        break;
      default:
        view.appendChild(this.buildInvite());
        view.appendChild(this.buildRoster());
        view.appendChild(this.buildActions());
        break;
    }

    this.game.ui.show(view);
    if (this.phase === 'open') this.refresh();
  }

  private buildOpening(): HTMLElement {
    const wait = document.createElement('div');
    wait.className = 'waiting';
    wait.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'waiting__dot';
    const txt = document.createElement('span');
    txt.textContent = this.phase === 'joining' ? 'Joining your friend…' : 'Opening a room…';
    wait.append(dot, txt);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'No server, no account, no lobby browser — just two browsers talking to each other.';

    const cancel = button('Cancel', () => this.leave(), {
      variant: 'text',
      wide: true,
      autofocus: true,
    });

    return panel('Multiplayer', wait, hint, cancel);
  }

  private buildError(): HTMLElement {
    const notice = document.createElement('p');
    notice.className = 'notice notice--error';
    notice.setAttribute('role', 'alert');
    notice.textContent =
      this.error || (this.invite ? 'Could not reach that room.' : 'Could not open a room.');
    if (this.invite) {
      const keep = document.createElement('p');
      keep.className = 'hint';
      keep.textContent =
        'The invite is still in your address bar, so refreshing tries it again. ' +
        'If your friend has not opened their room yet, give them a moment.';
      return panel('That did not work', notice, keep);
    }
    return panel('That did not work', notice);
  }

  /** True when we took up somebody's invite rather than opening this room. */
  private get isGuest(): boolean {
    return this.invite !== null || this.session?.role === 'guest';
  }

  private buildInvite(): HTMLElement {
    // A guest is not hosting anything, and telling them their room is open —
    // over a Copy button and a Close room button — reads as "you are alone in a
    // room of your own", which is the very thing that used to be true here.
    if (this.isGuest) {
      const blurb = document.createElement('p');
      blurb.className = 'hint';
      blurb.textContent =
        'Pick a dwarf when the host starts. They decide when everyone goes in.';

      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.setAttribute('role', 'status');
      hint.setAttribute('aria-live', 'polite');
      hint.textContent = `Room ${this.roomId.replace(/^mtnfight-/, '')}.`;
      this.copyHint = hint;

      return panel("You are in someone's room", blurb, hint);
    }

    const link = inviteLink(this.roomId);

    const blurb = document.createElement('p');
    blurb.className = 'hint';
    blurb.textContent =
      'Send this to a friend. They open it, pick a dwarf, and they are in — no download, ' +
      'no account, no explaining what a port is.';

    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input grow';
    input.readOnly = true;
    input.value = link;
    input.setAttribute('aria-label', 'Invite link');
    input.style.fontFamily = 'var(--font-mono)';
    input.style.fontSize = 'var(--fs-sm)';
    input.style.color = 'var(--accent-2)';
    // Clicking it selects the lot, so the manual route is one keystroke away.
    input.addEventListener('focus', () => input.select());
    input.addEventListener('click', () => input.select());
    this.linkInput = input;

    const copy = button('Copy', () => void this.copyLink(), {
      variant: 'filled',
      icon: '⧉',
      autofocus: true,
      ariaLabel: 'Copy the invite link to the clipboard',
    });

    row.append(input, copy);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = `Room ${this.roomId.replace(/^mtnfight-/, '')} — the link works until you close this tab.`;
    this.copyHint = hint;

    return panel('Your room is open', blurb, row, hint);
  }

  private buildRoster(): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'list';
    list.setAttribute('aria-live', 'polite');
    this.rosterEl = list;

    const status = document.createElement('p');
    status.className = 'hint';
    this.statusEl = status;

    return panel('In the room', list, status);
  }

  private buildActions(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row row--end';

    if (this.fromPause) {
      const note = document.createElement('p');
      note.className = 'hint grow';
      note.textContent = 'The room stays open while you play. They can drop in when they arrive.';
      row.appendChild(note);
      row.appendChild(
        button('Back to the fight', () => this.game.popScene(), { variant: 'filled', icon: '↩' }),
      );
      return row;
    }

    row.appendChild(
      button(this.isGuest ? 'Leave room' : 'Close room', () => this.leave(), { variant: 'text' }),
    );

    const start = button(this.isGuest ? 'Waiting for the host' : 'Start', () => this.toSelect(), {
      variant: 'filled',
      icon: '⚔',
      disabled: true,
      title: 'Everybody in the room goes to character select.',
    });
    this.startBtn = start;
    row.appendChild(start);
    return row;
  }

  // ── Patching ───────────────────────────────────────────────────────────────

  private refresh(): void {
    const list = this.rosterEl;
    if (!list) return;
    const s = this.session;
    const players = s ? s.players : [];
    const selfSlot = s ? s.slot : 0;

    list.replaceChildren();
    for (let slot = 0; slot < MAX_LOCAL_PLAYERS; slot++) {
      const p = players.find((x) => x.slot === slot);
      list.appendChild(p ? this.playerRow(p, p.slot === selfSlot) : this.emptyRow(slot));
    }

    const others = players.filter((p) => p.slot !== selfSlot);
    const ready = players.length >= 2 && others.every((p) => this.connected(p));

    if (this.startBtn) {
      this.startBtn.disabled = !ready;
      const labelEl = this.startBtn.querySelector('.btn__label');
      if (labelEl) labelEl.textContent = ready ? 'Start' : 'Waiting…';
    }

    if (this.statusEl) {
      if (this.error) {
        this.statusEl.className = 'notice notice--warn';
        this.statusEl.textContent = this.error;
      } else {
        this.statusEl.className = 'hint';
        this.statusEl.textContent =
          players.length < 2
            ? 'Nobody yet. Send the link — this page keeps the room alive.'
            : ready
              ? 'Everyone is here. Start when you are.'
              : 'Shaking hands with the new arrival…';
      }
    }
  }

  /** A peer we have measured, or ourselves. Anything else is still negotiating. */
  private connected(p: NetPlayer): boolean {
    return p.ping > 0 || p.ready || p.dwarfId !== null;
  }

  private playerRow(p: NetPlayer, self: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = self ? 'list__item list__item--self' : 'list__item';

    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = self ? `${p.name} (you)` : p.name;
    li.appendChild(name);

    li.appendChild(chip(`P${p.slot + 1}`));

    if (p.dwarfId) {
      let picked = p.dwarfId;
      try {
        picked = getDwarf(p.dwarfId).name;
      } catch {
        // A peer on a newer build picked somebody we have never heard of. Show
        // the raw id rather than exploding over it.
      }
      li.appendChild(chip(picked, 'chip chip--live'));
    }

    if (!self) {
      li.appendChild(
        p.ping > 0 ? chip(`${p.ping} ms`, pingClass(p.ping)) : chip('connecting', 'chip chip--warn'),
      );
    }

    li.appendChild(p.ready ? chip('ready', 'chip chip--live') : chip('picking'));
    return li;
  }

  private emptyRow(slot: number): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'list__item list__item--empty';
    li.textContent = `Slot ${slot + 1} — open`;
    return li;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Clipboard first; if the browser refuses (no permission, insecure context,
   * an embedded webview) fall back to selecting the text so Ctrl+C still works.
   * The one thing that must never happen is a Copy button that silently lies.
   */
  private async copyLink(): Promise<void> {
    const input = this.linkInput;
    const hint = this.copyHint;
    if (!input) return;
    const text = input.value;

    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, text.length);
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
    }

    if (hint) {
      hint.textContent = copied
        ? 'Copied. Paste it wherever you talk to them.'
        : 'The browser will not let us touch the clipboard — the link is selected, press Ctrl+C.';
    }
    this.game.audio.play(copied ? 'ui_select' : 'ui_error');
  }

  /**
   * Try the same thing again — never a different thing.
   *
   * A guest whose join failed retries THEIR invite. The old version always
   * opened a fresh room, which is the single worst answer to a broken invite:
   * it looks like success and puts the two players in different rooms.
   */
  private retry(): void {
    this.error = '';
    if (this.invite) {
      this.phase = 'joining';
      this.rebuild();
      void this.joinRoom(this.invite);
      return;
    }
    this.phase = 'opening';
    this.rebuild();
    void this.openRoom();
  }

  /** Give up on the invite and open a room of our own. Always a deliberate act. */
  private hostInstead(): void {
    this.invite = null;
    this.game.pendingJoin = null;
    clearRoomFromUrl();
    this.error = '';
    this.phase = 'opening';
    this.rebuild();
    void this.openRoom();
  }

  private toSelect(): void {
    this.game.audio.play('ui_select');
    const params: SelectParams = { localPlayers: 1, online: true, mapIndex: this.mapIndex };
    this.game.setScene('select', params);
  }

  private leave(): void {
    this.game.audio.play('ui_back');
    if (this.fromPause) {
      this.game.popScene();
      return;
    }
    // leaveNet hangs up, drops the lockstep and scrubs the `#join=` fragment,
    // so a refresh does not try to rejoin a room that no longer exists.
    this.game.leaveNet();
    this.session = null;
    const params: HomeParams = { view: 'multiplayer' };
    this.game.setScene('home', params);
  }

  // ── Backdrop ───────────────────────────────────────────────────────────────

  private drawBackdrop(ctx: C2D, t: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#05060b');
    g.addColorStop(0.5, '#100c22');
    g.addColorStop(1, '#08070f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    for (let i = 0; i < 70; i++) {
      const x = hash01(i * 5 + 1) * VIEW_W;
      const y = hash01(i * 5 + 2) * 210;
      ctx.globalAlpha = 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.026 + i));
      ctx.fillStyle = '#dbe3ff';
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;

    // A beacon, sweeping. Somebody out there is meant to see it.
    if (!this.game.save.settings.reducedMotion) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bx = VIEW_W * 0.5;
      const by = 292;
      for (let k = 0; k < 2; k++) {
        const ang = -Math.PI / 2 + Math.sin(t * 0.0055 + k * Math.PI) * 1.05;
        const beam = ctx.createLinearGradient(bx, by, bx + Math.cos(ang) * 320, by + Math.sin(ang) * 320);
        const on = this.phase === 'open' ? 0.16 : 0.07;
        beam.addColorStop(0, `rgba(255,46,110,${on})`);
        beam.addColorStop(1, 'rgba(255,46,110,0)');
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(ang - 0.06) * 320, by + Math.sin(ang - 0.06) * 320);
        ctx.lineTo(bx + Math.cos(ang + 0.06) * 320, by + Math.sin(ang + 0.06) * 320);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Ridge line, so the screen still belongs to the same game as the title.
    const off = t * 0.06;
    ctx.beginPath();
    ctx.moveTo(-4, VIEW_H);
    for (let x = -4; x <= VIEW_W + 4; x += 5) {
      ctx.lineTo(x, 250 - ridgeAt(x + off, 7, 0.012) * 44);
    }
    ctx.lineTo(VIEW_W + 4, VIEW_H);
    ctx.closePath();
    ctx.fillStyle = '#0a0d18';
    ctx.fill();

    ctx.fillStyle = '#06070c';
    ctx.fillRect(0, 292, VIEW_W, VIEW_H - 292);
    ctx.strokeStyle = 'rgba(255,46,110,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 292.5);
    ctx.lineTo(VIEW_W, 292.5);
    ctx.stroke();

    this.drawBanner(ctx, t);

    // The overlay is where the actual work happens; dim the canvas under it.
    ctx.fillStyle = 'rgba(4,5,8,0.5)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  private drawBanner(ctx: C2D, t: number): void {
    const players = this.session ? this.session.players.length : 0;
    const code = this.roomId ? this.roomId.replace(/^mtnfight-/, '').toUpperCase() : '· · · ·';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    ctx.font = `900 11px ${DISPLAY}`;
    ctx.fillStyle = FAINT;
    ctx.fillText(this.fromPause ? 'INVITE, MID-FIGHT' : 'WAITING ROOM', VIEW_W * 0.5, 40);

    ctx.font = `900 40px ${DISPLAY}`;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#141019';
    ctx.strokeText(code, VIEW_W * 0.5, 78);
    ctx.fillStyle = this.phase === 'open' ? GOLD : DIM;
    ctx.fillText(code, VIEW_W * 0.5, 78);
    ctx.globalAlpha = 1;

    ctx.font = `700 9px ${SANS}`;
    ctx.fillStyle = players > 1 ? ACCENT : FAINT;
    const pulse = 0.6 + 0.4 * Math.sin(t * 0.05);
    ctx.globalAlpha = players > 1 ? 1 : clamp(pulse, 0, 1);
    ctx.fillText(
      players > 1
        ? `${players} FIGHTERS IN THE ROOM`
        : this.phase === 'open'
          ? 'LISTENING FOR A FRIEND'
          : 'DIALLING',
      VIEW_W * 0.5,
      96,
    );
    ctx.globalAlpha = 1;

    // A ring of dots ticking round, one per connected peer.
    if (this.phase === 'open') {
      const cx = VIEW_W * 0.5;
      const cy = 318;
      for (let i = 0; i < MAX_LOCAL_PLAYERS; i++) {
        const a = -Math.PI / 2 + (i / MAX_LOCAL_PLAYERS) * TAU;
        const filled = i < players;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * 26, cy + Math.sin(a) * 12, filled ? 3.4 : 2, 0, TAU);
        ctx.fillStyle = filled ? ACCENT : '#232a3a';
        ctx.fill();
      }
    }
  }
}
