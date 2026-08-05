/**
 * Which keyboard is actually under the player's hands.
 *
 * The game binds by `KeyboardEvent.code` — physical POSITION, not the letter
 * printed on the cap — so the movement diamond is already correct everywhere.
 * The key an AZERTY player calls Z is the key a QWERTY player calls W: both
 * emit `KeyW`, both move the dwarf up, and the simulation never has to know
 * which keyboard is plugged in. That part needs no fixing and must not be
 * "fixed": per-layout default maps are how you break Dvorak users.
 *
 * What is NOT automatic is the LABEL. Printing "W" to somebody whose W is two
 * rows away is a small lie, and small lies about the controls are how a game
 * stops feeling like it was made for you.
 *
 * So we ask the browser what each physical key actually produces —
 * `navigator.keyboard.getLayoutMap()`, Chromium only, and unlike
 * `keyboard.lock()` it needs no permission and shows no prompt — and print
 * that. Firefox and Safari do not implement it, so there we guess from
 * `navigator.languages`, which is exactly as reliable as it sounds. A wrong
 * guess must only ever produce a wrong LABEL, never wrong input, and the
 * rebinding screen is the real escape hatch for anyone we guess wrong about.
 */

export type LayoutId = 'qwerty' | 'azerty' | 'qwertz' | 'dvorak' | 'colemak' | 'other';

/**
 * The slice of the Keyboard API we use. It is not in lib.dom, so it is spelled
 * out here rather than smuggled in as `any`.
 */
interface LayoutMapLike {
  get(code: string): string | undefined;
}

interface KeyboardApi {
  getLayoutMap?: () => Promise<LayoutMapLike>;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys no layout ever moves or renames. The layout map covers only the
 * "writing system" block (letters, digits, punctuation), so everything here
 * would otherwise fall through to a raw event code on the screen.
 */
const FIXED_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Bksp',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  CapsLock: 'Caps',
  NumLock: 'Num Lock',
  ScrollLock: 'ScrLk',
  PrintScreen: 'PrtSc',
  Pause: 'Pause',
  ContextMenu: 'Menu',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  MetaLeft: 'L Meta',
  MetaRight: 'R Meta',
};

/** The numpad is the same slab of plastic on every layout on earth. */
const NUMPAD_LABELS: Record<string, string> = {
  NumpadDecimal: 'Num .',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num ×',
  NumpadDivide: 'Num ÷',
  NumpadEnter: 'Num ⏎',
  NumpadEqual: 'Num =',
  NumpadComma: 'Num ,',
  NumpadParenLeft: 'Num (',
  NumpadParenRight: 'Num )',
};

/** US punctuation, used when nothing better is known about the board. */
const US_PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  // The three keys a US board does not have at all. When they exist they are
  // engraved exactly like this, so guessing them is safe in a way that guessing
  // '\' for the key next to left Shift is not.
  IntlBackslash: '<',
  IntlRo: 'ろ',
  IntlYen: '¥',
};

/**
 * Guess-mode overrides: the DIFFERENCES from the US board, nothing more.
 *
 * These are only ever consulted when the browser refuses to tell us the truth
 * (Firefox, Safari) and we had to infer the layout from a language tag. They
 * deliberately stop at the letter block: if the guess is wrong, being wrong
 * about four letters is recoverable, and announcing that Digit1 is "&" is not
 * worth the risk. When the real layout map exists it wins outright and these
 * are never read.
 */
const GUESS_OVERRIDES: Partial<Record<LayoutId, Record<string, string>>> = {
  azerty: {
    KeyQ: 'A',
    KeyW: 'Z',
    KeyA: 'Q',
    KeyZ: 'W',
    Semicolon: 'M',
    KeyM: ',',
  },
  qwertz: {
    KeyY: 'Z',
    KeyZ: 'Y',
  },
};

const LAYOUT_NAMES: Record<LayoutId, string> = {
  qwerty: 'QWERTY',
  azerty: 'AZERTY',
  qwertz: 'QWERTZ',
  dvorak: 'Dvorak',
  colemak: 'Colemak',
  other: 'Custom',
};

/**
 * The default movement diamond per local slot, mirroring DEFAULT_BINDINGS.
 * Kept here rather than imported so this module stays at the bottom of the
 * dependency graph — Bindings imports Layout, never the other way round.
 */
const MOVEMENT_CODES: Record<number, readonly string[]> = {
  0: ['KeyW', 'KeyA', 'KeyS', 'KeyD'],
  1: ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
};

/** Languages whose speakers are, more often than not, sat at a QWERTZ board. */
const QWERTZ_LANGS = new Set(['de', 'cs', 'sk', 'hu', 'sl', 'hr', 'bs']);

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let layoutMap: LayoutMapLike | null = null;
let currentLayout: LayoutId = guessFromLanguages();
/** True while the layout is inferred from a language tag rather than measured. */
let guessed = true;
let started: Promise<void> | null = null;

const listeners = new Set<() => void>();

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

function keyboardApi(): KeyboardApi | null {
  if (typeof navigator === 'undefined') return null;
  const kb = (navigator as unknown as { keyboard?: KeyboardApi }).keyboard;
  return kb && typeof kb === 'object' ? kb : null;
}

/** Lower-cased glyph a physical key produces, or '' if the map has no opinion. */
function probe(m: LayoutMapLike, code: string): string {
  try {
    const v = m.get(code);
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Name the layout by pressing a few keys in our head and seeing what falls out.
 * This is the honest way round: the real map decides, and the language tag is
 * never consulted once we have one.
 */
function detect(m: LayoutMapLike): LayoutId {
  const q = probe(m, 'KeyQ');
  const w = probe(m, 'KeyW');
  const e = probe(m, 'KeyE');
  const r = probe(m, 'KeyR');
  const a = probe(m, 'KeyA');
  const s = probe(m, 'KeyS');
  const d = probe(m, 'KeyD');
  const f = probe(m, 'KeyF');
  const y = probe(m, 'KeyY');
  const z = probe(m, 'KeyZ');

  // French and Belgian AZERTY: the top-left letter is A and W has moved down.
  if (q === 'a' && w === 'z' && a === 'q') return 'azerty';
  // German, Swiss, Czech, Hungarian and friends: Y and Z swap places.
  if (y === 'z' && z === 'y' && q === 'q') return 'qwertz';
  // Dvorak: the home row reads a o e u i.
  if (a === 'a' && s === 'o' && d === 'e' && f === 'u') return 'dvorak';
  // Colemak (and Colemak-DH, which keeps this half of the home row).
  if (e === 'f' && r === 'p' && s === 'r' && d === 's') return 'colemak';
  if (q === 'q' && w === 'w' && e === 'e' && a === 'a' && s === 's' && d === 'd') return 'qwerty';
  // Cyrillic, Greek, Arabic, a Kinesis with delusions — all real, none named.
  return 'other';
}

function guessFromTag(tag: string): LayoutId | null {
  const parts = tag.toLowerCase().split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const lang = parts[0];
  const region = parts.length > 1 ? parts[parts.length - 1] : '';

  if (lang === 'fr') {
    // Quebec types on a QWERTY board and Geneva on a QWERTZ one. Only France,
    // Belgium and Monaco actually get the AZERTY.
    if (region === 'ca') return 'qwerty';
    if (region === 'ch') return 'qwertz';
    return 'azerty';
  }
  if (lang === 'nl' && region === 'be') return 'azerty';
  if (QWERTZ_LANGS.has(lang)) return 'qwertz';
  if (lang === 'en' || lang === 'es' || lang === 'it' || lang === 'pt' || lang === 'nl') {
    return 'qwerty';
  }
  return null;
}

/**
 * The Firefox/Safari path. A language is not a keyboard — plenty of French
 * speakers are on QWERTY and plenty of Britons are on Dvorak — so this is
 * labelled a guess everywhere it surfaces, and it never touches the bindings.
 */
function guessFromLanguages(): LayoutId {
  if (typeof navigator === 'undefined') return 'qwerty';
  const nav = navigator as unknown as { language?: string; languages?: readonly string[] };
  const tags: string[] = [];
  try {
    if (Array.isArray(nav.languages)) tags.push(...nav.languages);
    if (typeof nav.language === 'string') tags.push(nav.language);
  } catch {
    /* a browser extension mangling navigator is not our problem to solve */
  }
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const id = guessFromTag(tag);
    if (id) return id;
  }
  return 'qwerty';
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[layout] a layout listener threw:', err);
    }
  }
}

async function read(kb: KeyboardApi): Promise<void> {
  const get = kb.getLayoutMap;
  if (typeof get !== 'function') return;
  try {
    const m = await get.call(kb);
    if (!m || typeof m.get !== 'function') return;
    layoutMap = m;
    currentLayout = detect(m);
    guessed = false;
    notify();
  } catch {
    // getLayoutMap needs no permission, but a browser is still allowed to say
    // no — a locked-down kiosk, a privacy extension, an iframe policy. The
    // guess stands, input is unaffected, and rebinding still works.
  }
}

const onLayoutChanged = (): void => {
  const kb = keyboardApi();
  if (kb) void read(kb);
};

async function start(): Promise<void> {
  const kb = keyboardApi();
  if (!kb || typeof kb.getLayoutMap !== 'function') {
    // Firefox and Safari end up here. The language guess made at module load is
    // all we get, and it is already in place.
    return;
  }
  try {
    // Not in every Chromium either — Electron builds have shipped without it.
    kb.addEventListener?.('layoutchange', onLayoutChanged);
  } catch {
    /* an unsubscribable event is still better than no labels */
  }
  await read(kb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Begin detection. Safe to call at any time, from anywhere, more than once:
 * the work happens once and every later call joins the same promise.
 *
 * Callers do not have to await it. Until it resolves, `keyLabel` answers from
 * the language guess (US labels for most of the world), and everything that
 * subscribed through `onLayoutChange` is told to re-render when the truth
 * arrives.
 */
export function initKeyboardLayout(): Promise<void> {
  if (!started) started = start();
  return started;
}

/** Kick detection off lazily, so labels are never wrong just because nobody asked. */
function ensureStarted(): void {
  if (!started) void initKeyboardLayout();
}

export function layoutId(): LayoutId {
  ensureStarted();
  return currentLayout;
}

/** True when the layout was inferred from a language tag instead of measured. */
export function layoutIsGuess(): boolean {
  ensureStarted();
  return guessed;
}

/**
 * 'AZERTY', 'Dvorak', 'ЙЦУКЕН' — and '(assumed)' appended when we are guessing,
 * because claiming to have detected something we merely inferred is the exact
 * habit this whole module exists to break.
 */
export function layoutName(): string {
  ensureStarted();
  let name = LAYOUT_NAMES[currentLayout];
  if (currentLayout === 'other' && layoutMap) {
    // Name an unrecognised board after itself, the way QWERTY was named.
    const row = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY']
      .map((code) => probe(layoutMap as LayoutMapLike, code))
      .filter((g) => [...g].length === 1)
      .join('');
    if ([...row].length === 6) name = row.toUpperCase();
  }
  return guessed ? `${name} (assumed)` : name;
}

/**
 * The glyph actually engraved on the key at a given physical position.
 *
 * Falls back, in order: fixed non-writing keys → numpad → the browser's layout
 * map → the guessed layout's differences from US → the US label. The last two
 * steps are why an AZERTY player sees Z before detection finishes and after it
 * fails.
 */
export function keyLabel(code: string): string {
  if (typeof code !== 'string' || code.length === 0) return '—';
  ensureStarted();

  const fixed = FIXED_LABELS[code];
  if (fixed) return fixed;

  if (code.startsWith('Numpad')) {
    return NUMPAD_LABELS[code] ?? `Num ${code.slice(6)}`;
  }

  if (layoutMap) {
    let raw: string | undefined;
    try {
      raw = layoutMap.get(code);
    } catch {
      raw = undefined;
    }
    const glyph = typeof raw === 'string' ? raw.trim() : '';
    if (glyph.length > 0) return [...glyph].length === 1 ? glyph.toUpperCase() : glyph;
  }

  const override = GUESS_OVERRIDES[currentLayout]?.[code];
  if (override) return override;

  return usLabel(code);
}

/** What the key would say on a US board. The floor everything else builds on. */
function usLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return US_PUNCTUATION[code] ?? code;
}

/**
 * Join a run of keys into one label: 'WASD', 'ZQSD', 'Arrows', 'I/J/K/L'.
 * Exported so the bindings layer can label whatever is bound NOW rather than
 * whatever the defaults said.
 */
export function movementLabelForCodes(codes: readonly string[]): string {
  if (!codes || codes.length === 0) return '';
  if (codes.every((c) => c.startsWith('Arrow'))) return 'Arrows';
  const parts = codes.map(keyLabel);
  return parts.every((p) => [...p].length === 1) ? parts.join('') : parts.join('/');
}

/** 'WASD' on a US board, 'ZQSD' on a French one, 'Arrows' for player two. */
export function movementKeysLabel(slot: number): string {
  const codes = MOVEMENT_CODES[slot] ?? MOVEMENT_CODES[0];
  return movementLabelForCodes(codes);
}

/**
 * Re-render hook. Detection is asynchronous and the layout can change under a
 * running page (people do switch input methods mid-game), so anything printing
 * a key label should subscribe and redraw. Returns its own unsubscribe.
 */
export function onLayoutChange(fn: () => void): () => void {
  ensureStarted();
  if (typeof fn !== 'function') return () => undefined;
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
