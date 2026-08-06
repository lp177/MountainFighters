/**
 * The key rebinding editor, and the gamepad table that sits under it.
 *
 * ONE component each, mounted by both the title screen's Controls page and the
 * in-game pause menu. Two copies of a rebinding UI is two copies of every bug
 * in a rebinding UI, so there is exactly one.
 *
 * TWO KEYS PER ACTION
 * -------------------
 * Every row has two boxes. The first is the action's primary — the one the HUD
 * prompt and the controls screen name it after — and the second is a spare,
 * which most actions ship without and which is a perfectly ordinary thing to
 * leave empty. Both are independently rebindable, independently clearable and
 * independently focusable; an empty one reads as a dash and still takes a key.
 *
 * The pair is not stored as a pair. A binding map is `code -> bit` and always
 * has been, so the ORDER of the codes is the pair, which is why every mutation
 * here goes through `setBinding` rather than editing the map by hand. One
 * consequence surfaces in the UI: a `Record` cannot hold "no primary, but a
 * secondary", so putting a key in the second box of an action with an empty
 * first box lands it in the first, and the status line says so.
 *
 * WHY NO LABEL IS HARD-CODED
 * --------------------------
 * Bindings are stored by `KeyboardEvent.code`, which names a PHYSICAL key
 * POSITION and is layout-independent: the key engraved "Z" on an AZERTY board
 * reports `KeyW`. That is why the movement diamond is already ZQSD in France
 * and WASD in the US without a single per-layout default table — and it is also
 * why printing "W" next to it would be a lie. Every key name on screen comes
 * from `keyLabel()`, and the whole editor repaints through `onLayoutChange()`
 * when detection resolves or the player switches layout mid-session.
 *
 * `gamepadPanel()` is the same idea wearing the other hat. Pad actions bind to
 * the PHYSICAL position of a button, so the bottom face button is Light on every
 * pad on earth — and the letter printed on it is whatever the vendor felt like.
 * The letters therefore come from the connected pad's own `PadProfile` and from
 * nowhere else: a Nintendo player is told B for the bottom button and A for the
 * right one, a PlayStation player Cross and Circle. A hard-coded Xbox table told
 * them all the same lie the old hard-coded WASD table told AZERTY players.
 *
 * CAPTURE MODE
 * ------------
 * While waiting for a key this component owns the keyboard outright. It listens
 * on `window` in the CAPTURE phase and stops the event dead, so the keypress
 * reaches neither the game nor the focused button — otherwise pressing Space to
 * rebind Jump would also re-activate the button that started the capture. The
 * input layer is told to stand down via `setCaptureMode(true)`, and that flag is
 * cleared on every exit there is: commit, Escape, blur, click-away, tab switch,
 * and the component leaving the DOM. A leaked capture flag is a game that has
 * stopped answering its own controls, so it gets belt and braces.
 */

import type { ActionDef, KeySlot } from '@/engine/input/Bindings';
import {
  ACTIONS,
  actionForBit,
  codesForBit,
  conflictFor,
  defaultBindingsFor,
  setBinding,
} from '@/engine/input/Bindings';
import { keyLabel, layoutName, onLayoutChange } from '@/engine/input/Layout';
import { setCaptureMode } from '@/engine/input/KeyboardSource';
import type { PadProfile } from '@/engine/input/GamepadProfiles';
import { profileFor } from '@/engine/input/GamepadProfiles';
import {
  connectedGamepads,
  padProfile,
  pollGamepads,
  rumble,
} from '@/engine/input/GamepadSource';
import { attachRipple, button } from '@/ui/Widgets';

export interface KeyBindingEditorOpts {
  /** Current bindings, keyed by player slot then by KeyboardEvent.code. */
  bindings: Record<number, Record<string, number>>;
  /** Which slots to offer, e.g. [0, 1]. */
  slots: number[];
  /** Fired with the FULL next bindings object on every committed change. */
  onChange(next: Record<number, Record<string, number>>): void;
}

type BindingMap = Record<string, number>;
type BindingsBySlot = Record<number, BindingMap>;

type Tone = 'plain' | 'ok' | 'warn';

/** The two key slots every action gets, in the order they are drawn. */
const SLOT_ORDER: readonly KeySlot[] = [0, 1];

/** The badge above each key button. Short, because the row has to fit a phone. */
const SLOT_BADGE: Record<KeySlot, string> = { 0: '1st', 1: '2nd' };

/** The same thing said properly, for screen readers and the status line. */
const SLOT_NAME: Record<KeySlot, string> = { 0: 'primary key', 1: 'second key' };

function playerName(slot: number): string {
  return `Player ${slot + 1}`;
}

function keyList(codes: readonly string[]): string {
  return codes.map(keyLabel).join(' and ');
}

function cloneBindings(src: BindingsBySlot): BindingsBySlot {
  const out: BindingsBySlot = {};
  for (const key of Object.keys(src)) {
    const slot = Number(key);
    const map = src[slot];
    if (map) out[slot] = { ...map };
  }
  return out;
}

/**
 * Never allowed to throw or to be skipped: teardown has to hand the keyboard
 * back to the game whatever else went wrong on the way out.
 */
function setCapture(on: boolean): void {
  try {
    setCaptureMode(on);
  } catch {
    /* nothing this component can usefully do, and nothing it should amplify */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom element — this is what makes teardown automatic
//
// Ui.clear() empties the overlay by removing nodes, and the browser fires
// disconnectedCallback for every custom element in a removed subtree. So a
// scene that clears its view has already torn this down: no scene-side
// bookkeeping, no leaked window listener, no capture flag left switched on.
// ─────────────────────────────────────────────────────────────────────────────

const TAG = 'mf-keybinding-editor';
const editors = new WeakMap<HTMLElement, Editor>();

class KeyBindingEditorElement extends HTMLElement {
  connectedCallback(): void {
    editors.get(this)?.arm();
  }

  disconnectedCallback(): void {
    editors.get(this)?.disarm();
  }
}

let uid = 0;

function createHost(): HTMLElement {
  if (typeof customElements === 'undefined') return document.createElement('div');
  if (!customElements.get(TAG)) customElements.define(TAG, KeyBindingEditorElement);
  return document.createElement(TAG);
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────

/** One of a row's two key buttons, with its own ✕. */
interface KeyUi {
  row: RowUi;
  index: KeySlot;
  group: HTMLElement;
  btn: HTMLButtonElement;
  text: HTMLElement;
  clearBtn: HTMLButtonElement;
}

interface RowUi {
  action: ActionDef;
  slot: number;
  root: HTMLLIElement;
  /** Primary then secondary, always both present even when only one is bound. */
  keys: KeyUi[];
}

interface SlotUi {
  slot: number;
  tab: HTMLButtonElement | null;
  panel: HTMLElement;
  rows: RowUi[];
}

interface CaptureSession {
  key: KeyUi;
  ctl: AbortController;
}

class Editor {
  private readonly host: HTMLElement;
  private readonly opts: KeyBindingEditorOpts;
  private readonly slots: number[];
  private readonly ids: string;
  private readonly slotUis: SlotUi[] = [];
  private readonly rowIndex = new Map<string, RowUi>();

  private readonly layoutEl: HTMLParagraphElement;
  private readonly statusEl: HTMLParagraphElement;

  private bindings: BindingsBySlot;
  private activeIndex = 0;
  private capture: CaptureSession | null = null;

  private armed = false;
  private layoutOff: (() => void) | null = null;

  constructor(host: HTMLElement, opts: KeyBindingEditorOpts) {
    uid += 1;
    this.ids = `kbe-${uid}`;
    this.host = host;
    this.opts = opts;
    this.slots = opts.slots.length > 0 ? [...opts.slots] : [0];
    this.bindings = cloneBindings(opts.bindings ?? {});

    // A slot the save has never seen should show the stock keys rather than a
    // column of dashes. Seeding it is not a change the player made, so onChange
    // stays quiet until they actually touch something.
    for (const slot of this.slots) {
      if (!this.bindings[slot]) this.bindings[slot] = defaultBindingsFor(slot);
    }

    host.classList.add('kbe');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Key bindings');

    // Panels first, so the tabs have something real to point aria-controls at.
    for (const slot of this.slots) this.buildPanel(slot);

    const head = document.createElement('div');
    head.className = 'kbe__head';
    if (this.slots.length > 1) head.appendChild(this.buildTabs());

    this.layoutEl = document.createElement('p');
    this.layoutEl.className = 'kbe__layout';
    this.layoutEl.title =
      'Keys are stored by their position on the board, not by the letter, so these ' +
      'labels are whatever is printed on your own keyboard.';
    head.appendChild(this.layoutEl);

    const hint = document.createElement('p');
    hint.className = 'kbe__hint';
    hint.id = `${this.ids}-hint`;
    hint.textContent =
      'Every action takes two keys. The first is the one the game names in its prompts; the ' +
      'second is a spare, and leaving it empty is perfectly normal. Pick a box, then press the ' +
      'key you want. Esc backs out. ✕ empties that box, which is your funeral.';

    host.append(head, hint);
    for (const ui of this.slotUis) host.appendChild(ui.panel);

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'kbe__status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    host.appendChild(this.statusEl);

    this.paint();
  }

  // ── Construction ──────────────────────────────────────────────────────────

  private buildTabs(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'kbe__tabs';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Player to configure');

    this.slotUis.forEach((ui, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'kbe__tab';
      tab.id = `${this.ids}-tab-${ui.slot}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', ui.panel.id);
      tab.textContent = playerName(ui.slot);
      tab.addEventListener('click', () => this.selectTab(index, false));
      tab.addEventListener('keydown', (e) => this.onTabKey(e, index));
      attachRipple(tab);

      ui.panel.setAttribute('aria-labelledby', tab.id);
      ui.tab = tab;
      list.appendChild(tab);
    });

    return list;
  }

  private buildPanel(slot: number): void {
    const panel = document.createElement('div');
    panel.className = 'kbe__panel';
    panel.id = `${this.ids}-panel-${slot}`;
    if (this.slots.length > 1) panel.setAttribute('role', 'tabpanel');

    const list = document.createElement('ul');
    list.className = 'kbe__rows';
    panel.appendChild(list);

    const ui: SlotUi = { slot, tab: null, panel, rows: [] };
    for (const action of ACTIONS) {
      const row = this.buildRow(slot, action);
      ui.rows.push(row);
      this.rowIndex.set(rowKey(slot, action.bit), row);
      list.appendChild(row.root);
    }

    const foot = document.createElement('div');
    foot.className = 'kbe__foot';
    foot.appendChild(
      button('Reset to defaults', () => this.resetSlot(slot), {
        variant: 'outlined',
        icon: '↺',
        ariaLabel: `Reset ${playerName(slot)} to the default keys`,
        title: `Put ${playerName(slot)} back on the stock keys`,
      }),
    );
    panel.appendChild(foot);

    this.slotUis.push(ui);
  }

  private buildRow(slot: number, action: ActionDef): RowUi {
    const root = document.createElement('li');
    root.className = 'kbe__row';

    const name = document.createElement('span');
    name.className = 'kbe__action';
    name.textContent = action.name;

    const row: RowUi = { action, slot, root, keys: [] };

    // Both boxes are built whether or not anything is in them. An empty second
    // key is a box you can put a key in, not a control that has gone missing, so
    // it keeps its size, its badge and its place in the tab order.
    const keys = document.createElement('div');
    keys.className = 'kbe__keys';
    for (const index of SLOT_ORDER) {
      const key = this.buildKey(row, index);
      row.keys.push(key);
      keys.appendChild(key.group);
    }

    root.append(name, keys);
    return row;
  }

  private buildKey(row: RowUi, index: KeySlot): KeyUi {
    const { slot, action } = row;

    const group = document.createElement('div');
    group.className = `kbe__slot kbe__slot--${index === 0 ? 'primary' : 'secondary'}`;

    const badge = document.createElement('span');
    badge.className = 'kbe__slotlabel';
    // The button's own aria-label already says which of the two this is, and
    // hearing "1st" read out before every key name is noise, not information.
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = SLOT_BADGE[index];

    const btn = button('', () => this.toggleCapture(slot, action.bit, index), {
      variant: 'outlined',
      className: 'kbe__key',
      title:
        index === 0
          ? `The key ${action.name} is named after`
          : `A spare key for ${action.name}. Optional.`,
    });
    btn.setAttribute('aria-describedby', `${this.ids}-hint`);
    btn.setAttribute('aria-pressed', 'false');

    // "Awaiting a key" must not be signalled by colour alone: this caret is a
    // second, shape-based cue alongside the changed label and the dashed border.
    const cue = document.createElement('span');
    cue.className = 'kbe__cue';
    cue.setAttribute('aria-hidden', 'true');
    btn.appendChild(cue);

    const clearBtn = button('✕', () => this.clearBinding(slot, action.bit, index), {
      variant: 'text',
      className: 'kbe__clear',
      ariaLabel: `Clear the ${SLOT_NAME[index]} for ${action.name}, ${playerName(slot)}`,
      title: `Unbind the ${SLOT_NAME[index]}`,
    });

    const ctl = document.createElement('div');
    ctl.className = 'kbe__slotctl';
    ctl.append(btn, clearBtn);
    group.append(badge, ctl);

    return {
      row,
      index,
      group,
      btn,
      text: btn.querySelector<HTMLElement>('.btn__label') ?? btn,
      clearBtn,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Called when the host enters the DOM. */
  arm(): void {
    this.armed = true;
    if (!this.layoutOff) {
      // Detection is asynchronous, and people do switch input method mid-game;
      // either one changes every key name printed here.
      this.layoutOff = onLayoutChange(() => {
        if (this.armed) this.paint();
      });
    }
    this.paint();
  }

  /** Called when the host leaves the DOM — including via Ui.clear(). */
  disarm(): void {
    this.armed = false;
    this.cancelCapture();
    // Whatever else happened, the game gets its keyboard back.
    setCapture(false);
    this.layoutOff?.();
    this.layoutOff = null;
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  private selectTab(index: number, focus: boolean): void {
    const next = Math.max(0, Math.min(this.slots.length - 1, index));
    if (next !== this.activeIndex) this.cancelCapture();
    this.activeIndex = next;
    this.paint();
    if (focus) this.slotUis[next]?.tab?.focus();
  }

  private onTabKey(e: KeyboardEvent, index: number): void {
    const last = this.slots.length - 1;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    e.stopPropagation();
    this.selectTab(next, true);
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  private toggleCapture(slot: number, bit: number, index: KeySlot): void {
    const key = this.rowIndex.get(rowKey(slot, bit))?.keys[index];
    if (!key) return;
    if (this.capture?.key === key) {
      this.cancelCapture();
      this.say(`Left the ${SLOT_NAME[index]} for ${key.row.action.name} where it was.`);
      return;
    }
    this.beginCapture(key);
  }

  private beginCapture(key: KeyUi): void {
    this.cancelCapture();

    const ctl = new AbortController();
    this.capture = { key, ctl };
    setCapture(true);
    this.paint();
    this.say(
      `Press a key for ${key.row.action.name} — its ${SLOT_NAME[key.index]}. Esc backs out.`,
      'ok',
    );

    // Capture phase on window: this runs before the game's own listeners AND
    // before the focused button's default activation, so the key being bound
    // does not also throw a punch or re-press the button it was bound from.
    const keys: AddEventListenerOptions = { capture: true, passive: false, signal: ctl.signal };
    window.addEventListener('keydown', this.onCaptureKeyDown, keys);
    window.addEventListener('keyup', this.swallow, keys);
    window.addEventListener('keypress', this.swallow, keys);
    window.addEventListener('blur', this.onCaptureBlur, { signal: ctl.signal });
    window.addEventListener('pointerdown', this.onCapturePointer, {
      capture: true,
      signal: ctl.signal,
    });
  }

  /** The single exit from capture mode. Aborting the controller kills every
   *  listener the session added, so none of them can outlive it. */
  private cancelCapture(): void {
    const session = this.capture;
    if (!session) return;
    this.capture = null;
    session.ctl.abort();
    setCapture(false);
    this.paint();
  }

  private readonly swallow = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private readonly onCaptureBlur = (): void => {
    this.cancelCapture();
    this.say('Capture dropped — the window lost focus.');
  };

  private readonly onCapturePointer = (e: PointerEvent): void => {
    const session = this.capture;
    if (!session) return;
    // Clicking the armed button again is a deliberate cancel, handled by its
    // own click listener; clicking anywhere else just calls the whole thing off.
    if (e.target instanceof Node && session.key.btn.contains(e.target)) return;
    this.cancelCapture();
  };

  private readonly onCaptureKeyDown = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const session = this.capture;
    if (!session) return;
    // A held Enter or Space from activating the button repeats straight into
    // here and would bind itself. Only a fresh press counts.
    if (e.repeat || !e.code) return;

    if (e.code === 'Escape') {
      const { row, index, btn } = session.key;
      this.cancelCapture();
      this.say(`Cancelled. The ${SLOT_NAME[index]} for ${row.action.name} is unchanged.`);
      btn.focus();
      return;
    }

    this.commit(session.key, e.code);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────

  private commit(key: KeyUi, code: string): void {
    const { row, index } = key;
    const { slot, action } = row;
    const map = this.bindings[slot] ?? {};

    // Read the clashes off the CURRENT state, before it is rewritten underneath
    // us — the losing action is about to stop being findable.
    const stolenBit = conflictFor(map, code);
    const stolen = stolenBit !== null && stolenBit !== action.bit ? actionForBit(stolenBit) : null;
    const shared: string[] = [];
    for (const other of Object.keys(this.bindings).map(Number)) {
      if (other === slot) continue;
      const bit = conflictFor(this.bindings[other] ?? {}, code);
      if (bit === null) continue;
      shared.push(`${playerName(other)}'s ${actionForBit(bit)?.name ?? 'controls'}`);
    }

    const next = cloneBindings(this.bindings);
    // setBinding does the evicting: one action per key within a slot, and the
    // pair kept in a defined order so the primary stays the primary.
    next[slot] = setBinding(map, action.bit, index, code);

    this.cancelCapture();
    this.apply(next);
    key.btn.focus();

    const after = codesForBit(next[slot] ?? {}, action.bit);
    const landed: KeySlot = after.indexOf(code) === 1 ? 1 : 0;
    const printed = keyLabel(code);

    let text = `${action.name}: ${SLOT_NAME[landed]} is now ${printed}.`;
    let tone: Tone = 'ok';
    // Asked for the spare box on an action that had nothing in the first one.
    // A key map cannot hold the gap, so the key took the first box instead;
    // saying so is better than letting them wonder which box they clicked.
    if (landed === 0 && index === 1) text += ' The first box was empty, so it went in there.';
    if (stolen) {
      const left = codesForBit(next[slot] ?? {}, stolen.bit);
      text +=
        left.length > 0
          ? ` ${stolen.name} had that key and now answers to ${keyList(left)} alone.`
          : ` ${stolen.name} had that key and is now unbound.`;
      tone = 'warn';
    }
    if (shared.length > 0) {
      text += ` Heads up: ${printed} is also ${shared.join(' and ')}. One keyboard, two players, endless arguments.`;
      tone = 'warn';
    }
    this.say(text, tone);
  }

  private clearBinding(slot: number, bit: number, index: KeySlot): void {
    const key = this.rowIndex.get(rowKey(slot, bit))?.keys[index];
    if (!key) return;
    const action = key.row.action;
    const map = this.bindings[slot] ?? {};

    if (!codesForBit(map, bit)[index]) {
      this.say(`${action.name} has no ${SLOT_NAME[index]} to clear.`);
      return;
    }

    const next = cloneBindings(this.bindings);
    next[slot] = setBinding(map, bit, index, null);

    this.cancelCapture();
    this.apply(next);
    // The ✕ disables itself once there is nothing left to clear, and focus must
    // not fall off the row when it does.
    key.btn.focus();

    const left = codesForBit(next[slot] ?? {}, bit);
    if (left.length === 0) {
      this.say(`${action.name} is unbound. Hope you were not planning to use it.`, 'warn');
      return;
    }
    // Clearing the first box promotes the spare into it, because the map has no
    // way to spell "no primary, but a secondary".
    this.say(`${action.name} now answers to ${keyList(left)} alone.`);
  }

  private resetSlot(slot: number): void {
    const next = cloneBindings(this.bindings);
    next[slot] = defaultBindingsFor(slot);
    this.cancelCapture();
    this.apply(next);
    this.say(`${playerName(slot)} is back on the stock keys.`, 'ok');
  }

  private apply(next: BindingsBySlot): void {
    this.bindings = next;
    this.paint();
    this.opts.onChange(next);
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private say(text: string, tone: Tone = 'plain'): void {
    this.statusEl.className = tone === 'plain' ? 'kbe__status' : `kbe__status kbe__status--${tone}`;
    // Re-setting identical text is not re-announced, and the same warning twice
    // is still news, so the node is emptied first.
    this.statusEl.textContent = '';
    this.statusEl.textContent = text;
  }

  private paint(): void {
    const name = document.createElement('b');
    name.textContent = layoutName();
    this.layoutEl.textContent = 'Keyboard layout: ';
    this.layoutEl.appendChild(name);

    this.slotUis.forEach((ui, index) => {
      const selected = this.slots.length === 1 || index === this.activeIndex;
      if (ui.tab) {
        ui.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        // Roving tabindex: the tablist is one tab stop, arrows move inside it.
        ui.tab.tabIndex = selected ? 0 : -1;
      }
      ui.panel.hidden = !selected;
      for (const row of ui.rows) this.paintRow(row);
    });
  }

  private paintRow(row: RowUi): void {
    const codes = codesForBit(this.bindings[row.slot] ?? {}, row.action.bit);
    const capturing = this.capture?.key.row === row;

    row.root.classList.toggle('is-capturing', capturing);
    // The ROW is only in trouble when the action has no key at all. An empty
    // second box is the resting state of almost everything on this list and must
    // not be dressed up as a fault.
    row.root.classList.toggle('is-unbound', codes.length === 0 && !capturing);

    for (const key of row.keys) this.paintKey(key, codes[key.index] ?? null);
  }

  private paintKey(key: KeyUi, code: string | null): void {
    const capturing = this.capture?.key === key;
    const printed = code ? keyLabel(code) : null;
    const which = SLOT_NAME[key.index];
    const action = key.row.action.name;

    key.text.textContent = capturing ? 'press a key' : (printed ?? '—');
    key.btn.classList.toggle('is-capturing', capturing);
    // Empty is a dash and a dimmer colour, but still a live button: this is how
    // an unused second key gets assigned in the first place.
    key.btn.classList.toggle('is-empty', !code && !capturing);
    key.btn.setAttribute('aria-pressed', capturing ? 'true' : 'false');
    // The visible label is a bare key name, or a dash, which on its own tells a
    // screen reader nothing about which action or which box it belongs to.
    key.btn.setAttribute(
      'aria-label',
      capturing
        ? `${action}, ${which}: waiting for a key. Press Escape to cancel.`
        : `${action}, ${which}: ${printed ?? 'not set'}. Activate to ${code ? 'change' : 'set'} it.`,
    );

    // Nothing to clear, or a capture in flight that ✕ would only confuse.
    key.clearBtn.disabled = !code || capturing;
  }
}

function rowKey(slot: number, bit: number): string {
  return `${slot}:${bit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function keyBindingEditor(opts: KeyBindingEditorOpts): HTMLElement {
  const host = createHost();
  const editor = new Editor(host, opts);
  editors.set(host, editor);
  // A plain <div> fallback gets no lifecycle callbacks, so arm it now; teardown
  // then depends on disposeKeyBindingEditor().
  if (!(host instanceof KeyBindingEditorElement)) editor.arm();
  return host;
}

/**
 * Explicit teardown, for a caller that wants to drop the editor without taking
 * it out of the DOM. Detaching it — which is what Ui.clear() does — already
 * does this on its own.
 */
export function disposeKeyBindingEditor(host: HTMLElement): void {
  editors.get(host)?.disarm();
}

// ─────────────────────────────────────────────────────────────────────────────
// The gamepad panel
//
// Same contract as the keyboard half: print what is actually there. It asks the
// input layer which pads are connected, asks each one's PadProfile what its
// buttons say, and prints that. Nothing here decides what a button DOES — the
// action next to each letter is the position GamepadSource binds it to, and the
// only reason the letters differ between a Switch Pro and a DualSense is that
// the vendors disagree about the alphabet.
//
// With no pad connected it says so and prints the generic layout, because a
// confident Xbox table shown to somebody holding nothing is the same lie in a
// smaller hat.
// ─────────────────────────────────────────────────────────────────────────────

/** Test buzz. Short and mid-strength: a handshake, not a hit. */
const TEST_STRENGTH = 0.65;
const TEST_MS = 220;

interface LivePad {
  index: number;
  profile: PadProfile;
}

/**
 * The layout to print when there is no pad to read.
 *
 * `profileFor` is written to survive a missing or exotic pad — it identifies
 * whatever it can and returns a profile regardless — so the generic letters come
 * out of the one label table rather than a second copy here that would drift
 * away from it the first time somebody edited one and not the other.
 */
function genericProfile(): PadProfile {
  return profileFor(null as unknown as Gamepad);
}

function collectPads(): LivePad[] {
  const out: LivePad[] = [];
  try {
    // The game polls once per sim frame; this is a DOM event or a fresh mount,
    // which can both land between two of them.
    pollGamepads();
    for (const index of connectedGamepads()) {
      const profile = padProfile(index);
      if (profile) out.push({ index, profile });
    }
  } catch {
    // A browser that will not discuss gamepads still gets the generic table.
  }
  return out;
}

/**
 * Whether this pad can be buzzed at all. Firefox exposes no `vibrationActuator`,
 * plenty of pads have no motors, and offering a button that provably does
 * nothing is worse than admitting it.
 */
function hasHaptics(index: number): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return false;
    }
    const pad = navigator.getGamepads()[index];
    const actuator = pad?.vibrationActuator as GamepadHapticActuator | undefined;
    return !!actuator && typeof actuator.playEffect === 'function';
  } catch {
    return false;
  }
}

/**
 * The same signal the rest of the presentation layer reads: `Ui` mirrors the
 * setting onto <html>, and the combat resolver drops rumble outright when it is
 * set. A test button that buzzed anyway would be advertising something the
 * fights will not do.
 */
function motionReduced(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('reduced-motion')
  );
}

interface PadRow {
  /** What the game calls it. */
  action: string;
  /** WHERE the control is. This is the half that bindings actually use. */
  where: string;
  /** What is printed on it, straight off this pad's profile. */
  label: string;
  /** False when this pad reports no such control at all. */
  present: boolean;
}

function movePresent(p: PadProfile): boolean {
  return (
    (p.axisX >= 0 && p.axisY >= 0) ||
    p.dpadUp >= 0 ||
    p.dpadDown >= 0 ||
    p.dpadLeft >= 0 ||
    p.dpadRight >= 0 ||
    typeof p.hatAxis === 'number' ||
    typeof p.dpadAxisX === 'number' ||
    typeof p.dpadAxisY === 'number'
  );
}

/** Every action a pad can reach, paired with the letter THIS pad prints on it. */
function padRows(p: PadProfile): PadRow[] {
  const l = p.labels;
  const stick = p.axisX >= 0 && p.axisY >= 0;
  return [
    {
      action: 'Move',
      where: 'left stick or d-pad',
      label: 'Stick / d-pad',
      present: movePresent(p),
    },
    { action: 'Run', where: 'stick pushed to its edge', label: 'Stick', present: stick },
    { action: 'Light attack', where: 'bottom face button', label: l.south, present: p.south >= 0 },
    { action: 'Heavy attack', where: 'right face button', label: l.east, present: p.east >= 0 },
    { action: 'Jump', where: 'left face button', label: l.west, present: p.west >= 0 },
    { action: 'Special', where: 'top face button', label: l.north, present: p.north >= 0 },
    { action: 'Block / parry', where: 'right shoulder', label: l.r1, present: p.r1 >= 0 },
    { action: 'Grab', where: 'left shoulder', label: l.l1, present: p.l1 >= 0 },
    {
      action: 'Super (1 bar)',
      where: 'right trigger',
      label: l.r2,
      present: p.r2 >= 0 || typeof p.r2Axis === 'number',
    },
    { action: 'Pause', where: 'start button', label: l.start, present: p.start >= 0 },
  ];
}

const PAD_TAG = 'mf-gamepad-panel';
const gamepadPanels = new WeakMap<HTMLElement, GamepadPanel>();

class GamepadPanelElement extends HTMLElement {
  connectedCallback(): void {
    gamepadPanels.get(this)?.arm();
  }

  disconnectedCallback(): void {
    gamepadPanels.get(this)?.disarm();
  }
}

function createPadHost(): HTMLElement {
  if (typeof customElements === 'undefined') return document.createElement('div');
  if (!customElements.get(PAD_TAG)) customElements.define(PAD_TAG, GamepadPanelElement);
  return document.createElement(PAD_TAG);
}

class GamepadPanel {
  private readonly summaryEl: HTMLParagraphElement;
  private readonly bodyEl: HTMLElement;
  private readonly statusEl: HTMLParagraphElement;

  private armed = false;
  private hotplug: AbortController | null = null;

  constructor(host: HTMLElement) {
    host.classList.add('kbe');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Gamepad controls');

    const head = document.createElement('div');
    head.className = 'kbe__head';
    this.summaryEl = document.createElement('p');
    this.summaryEl.className = 'kbe__layout';
    this.summaryEl.title =
      'Read off the pads that are plugged in right now. Unplug one and this list ' +
      'notices.';
    head.appendChild(this.summaryEl);

    const hint = document.createElement('p');
    hint.className = 'kbe__hint';
    hint.textContent =
      'Pad buttons are bound by POSITION, exactly like the keys: the bottom face button is ' +
      'Light on every pad on earth, whether that button says A, B or Cross. The letters below ' +
      'are the ones your own pad prints. Nudge the stick to walk and push it to the edge to ' +
      'run; the d-pad always runs. Pads are not rebindable.';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'stack';

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'kbe__status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    host.append(head, hint, this.bodyEl, this.statusEl);
    this.paint();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Called when the host enters the DOM. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    if (typeof window !== 'undefined') {
      const ctl = new AbortController();
      this.hotplug = ctl;
      // A pad plugged in while this page is open must not leave a screen full of
      // "no gamepad connected" behind it.
      window.addEventListener('gamepadconnected', this.onConnect, { signal: ctl.signal });
      window.addEventListener('gamepaddisconnected', this.onDisconnect, { signal: ctl.signal });
    }
    this.paint();
  }

  /** Called when the host leaves the DOM — including via Ui.clear(). */
  disarm(): void {
    this.armed = false;
    this.hotplug?.abort();
    this.hotplug = null;
  }

  private readonly onConnect = (e: GamepadEvent): void => {
    this.paint();
    const name = profileFor(e.gamepad).name;
    this.say(`${name} connected as pad ${e.gamepad.index + 1}.`, 'ok');
  };

  private readonly onDisconnect = (e: GamepadEvent): void => {
    this.paint();
    this.say(`Pad ${e.gamepad.index + 1} disconnected.`, 'warn');
  };

  // ── Painting ──────────────────────────────────────────────────────────────

  private say(text: string, tone: Tone = 'plain'): void {
    this.statusEl.className = tone === 'plain' ? 'kbe__status' : `kbe__status kbe__status--${tone}`;
    // Re-setting identical text is not re-announced, and the same news twice is
    // still news.
    this.statusEl.textContent = '';
    this.statusEl.textContent = text;
  }

  private paint(): void {
    const pads = collectPads();

    // Rebuilding throws away whatever had focus, which on a pad-connected event
    // is somebody's Tab position. Put it back on the same pad's button.
    const active = document.activeElement;
    const wasInside = active instanceof HTMLElement && this.bodyEl.contains(active);
    const focused = wasInside ? (active.dataset.pad ?? '') : '';

    const name = document.createElement('b');
    name.textContent =
      pads.length === 0 ? 'none connected' : pads.map((p) => p.profile.name).join(' · ');
    this.summaryEl.textContent = pads.length > 1 ? 'Gamepads: ' : 'Gamepad: ';
    this.summaryEl.appendChild(name);

    this.bodyEl.textContent = '';
    if (pads.length === 0) {
      this.bodyEl.appendChild(this.buildSection(-1, genericProfile()));
    } else {
      for (const pad of pads) this.bodyEl.appendChild(this.buildSection(pad.index, pad.profile));
    }

    if (!wasInside) return;
    const back =
      (/^\d+$/.test(focused)
        ? this.bodyEl.querySelector<HTMLElement>(`[data-pad="${focused}"]`)
        : null) ?? this.bodyEl.querySelector<HTMLElement>('button');
    back?.focus({ preventScroll: true });
  }

  /** One pad, or — with `index` at -1 — the generic layout and an apology. */
  private buildSection(index: number, profile: PadProfile): HTMLElement {
    const section = document.createElement('div');
    section.className = 'kbe__panel';

    const head = document.createElement('div');
    head.className = 'kbe__head';

    const title = document.createElement('p');
    title.className = 'kbe__layout';
    const name = document.createElement('b');
    name.textContent = index < 0 ? 'generic layout' : profile.name;
    const lead = index < 0 ? 'Nothing plugged in — ' : `Pad ${index + 1} — `;
    title.append(document.createTextNode(lead), name);
    head.appendChild(title);

    if (index >= 0) head.appendChild(this.buildRumbleControl(index));
    section.appendChild(head);

    if (index < 0) {
      const note = document.createElement('p');
      note.className = 'kbe__hint';
      note.textContent =
        'Plug a controller in and press a button. This table then names every button the way ' +
        'your own pad names it, and players three and four get one each.';
      section.appendChild(note);
    }

    const list = document.createElement('ul');
    list.className = 'list';
    for (const row of padRows(profile)) list.appendChild(this.buildRow(row));
    section.appendChild(list);

    return section;
  }

  private buildRow(row: PadRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'list__item';

    const action = document.createElement('span');
    action.className = 'grow';
    action.textContent = row.action;

    const where = document.createElement('span');
    where.className = 'hint';
    where.textContent = row.where;

    const value = document.createElement('span');
    value.className = row.present ? 'chip' : 'chip chip--warn';
    value.textContent = row.label;

    li.append(action, where, value);

    if (!row.present) {
      const missing = document.createElement('span');
      missing.className = 'chip chip--warn';
      missing.textContent = 'not reported';
      li.appendChild(missing);
      li.title = 'This pad does not report that control, so the action is out of its reach.';
    }

    return li;
  }

  private buildRumbleControl(index: number): HTMLElement {
    if (!hasHaptics(index)) {
      const chip = document.createElement('span');
      chip.className = 'chip chip--warn';
      chip.textContent = 'no rumble';
      chip.title = 'This pad reports no motors, or this browser does not expose them.';
      return chip;
    }

    const btn = button('Test rumble', () => this.test(index), {
      variant: 'outlined',
      icon: '≈',
      ariaLabel: `Buzz pad ${index + 1}`,
      title: 'A short buzz, so you know which pad is which',
    });
    btn.dataset.pad = String(index);
    return btn;
  }

  private test(index: number): void {
    if (motionReduced()) {
      this.say(
        'Reduced motion is on, so rumble stays off — here and in the fights. Turn it off in ' +
          'Settings to feel anything.',
        'warn',
      );
      return;
    }
    rumble(index, TEST_STRENGTH, TEST_MS);
    this.say(`Buzzed pad ${index + 1}.`, 'ok');
  }
}

/**
 * The gamepad half of a Controls page: what is plugged in, what each of its
 * buttons says, and a buzz to tell two identical pads apart. Self-updating —
 * it repaints itself when a pad is connected or disconnected while it is open.
 */
export function gamepadPanel(): HTMLElement {
  const host = createPadHost();
  const p = new GamepadPanel(host);
  gamepadPanels.set(host, p);
  // A plain <div> fallback gets no lifecycle callbacks, so arm it now; teardown
  // then depends on disposeGamepadPanel().
  if (!(host instanceof GamepadPanelElement)) p.arm();
  return host;
}

/**
 * Explicit teardown, for a caller that drops the panel without taking it out of
 * the DOM. Detaching it already does this on its own.
 */
export function disposeGamepadPanel(host: HTMLElement): void {
  gamepadPanels.get(host)?.disarm();
}
