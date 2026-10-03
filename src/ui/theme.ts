/**
 * The art direction, as code.
 *
 * "Coal and lamp": seven miners who swapped the tunic for leather, fighting
 * through somebody else's idea of the future. Warm near-blacks instead of the
 * cool blue-black of a dashboard; one lamp-gold accent that means "this is
 * yours, press it"; blood red for damage and danger and nothing else; steel blue
 * for meter. Everything on screen is one of those, or it is the scenery.
 *
 * Two rules every screen is held to (DESIGN.md has the rest):
 *
 *  1. VALUE BEFORE HUE. The fighters are the brightest, most contrasted thing in
 *     a fight; the scenery sits underneath them. A dwarf in black leather has to
 *     read against a mine shaft at a glance, and colour cannot do that alone.
 *  2. ONE TYPE FAMILY. Barlow Condensed shouts (titles, buttons, the HUD, every
 *     banner), Barlow talks (sentences). Nothing else, on canvas or in the DOM.
 *
 * Canvas code reads the constants here. The stylesheet declares the same values
 * as custom properties on :root — the two lists are kept in step by hand, and
 * DESIGN.md is the table that says which is which.
 */

type C2D = CanvasRenderingContext2D;

// ── Palette ──────────────────────────────────────────────────────────────────

const RAW_PALETTE = {
  /** Page background, letterbox, the deepest shadow. */
  coal: '#0c0a09',
  /** Surfaces, lowest to highest. */
  coal1: '#141110',
  coal2: '#1c1815',
  coal3: '#25201c',
  coal4: '#302924',
  coal5: '#3c332c',
  /** Hairlines and panel edges. */
  line: '#3d342d',
  lineStrong: '#5a4d42',
  /** The outline every canvas glyph and shape is drawn in. Warm, never pure black. */
  ink: '#120d0b',

  /** Text. Bone, not white: white is reserved for flashes. */
  bone: '#f4ecdf',
  boneDim: '#c2b4a1',
  boneFaint: '#8a7c6b',

  /** The one call to action. Miner's lamp, gold, the studs on the jackets. */
  lamp: '#ffb524',
  lampHot: '#ffcb57',
  lampDeep: '#b97800',
  onLamp: '#1c1203',

  /** Damage, danger, K.O. Never decoration. */
  blood: '#e5322d',
  bloodHot: '#ff5b4a',
  bloodDeep: '#8a1212',

  /** Super meter and anything informational. */
  steel: '#58c4ef',
  steelDeep: '#1b6e94',

  moss: '#74d68e',
  warn: '#ff9a1f',
  rose: '#ff6f9c',
};

export const PALETTE: Readonly<typeof RAW_PALETTE> = Object.freeze(RAW_PALETTE);

/**
 * One colour per player SEAT, used by every screen that shows one: the select
 * cursor, the HUD panel ring, the marker over the head, the ground ring, the
 * interact keycap. A player who picked in gold is gold until the credits.
 *
 * Four hues far enough apart in both hue and lightness to survive the common
 * colour-vision deficiencies as light/dark pairs — and every one of those places
 * also prints the player number, so colour never carries identity alone.
 */
export const PLAYER_COLORS: readonly string[] = [
  PALETTE.lamp,
  PALETTE.steel,
  PALETTE.rose,
  PALETTE.moss,
];

/** Darker partner of each player colour, for the underside of bars and chips. */
export const PLAYER_SHADES: readonly string[] = ['#a36a00', '#1b6e94', '#a8335a', '#2f8a4b'];

export function playerColor(seat: number): string {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[(((seat | 0) % n) + n) % n];
}

export function playerShade(seat: number): string {
  const n = PLAYER_SHADES.length;
  return PLAYER_SHADES[(((seat | 0) % n) + n) % n];
}

// ── Type ─────────────────────────────────────────────────────────────────────

/**
 * The fallbacks are chosen to keep the METRICS close if the webfont has not
 * landed — a condensed face for the condensed one — so a slow first load
 * reflows nothing that matters. `loadFonts()` normally makes them moot.
 */
export const FONT_DISPLAY =
  '"Barlow Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif';
export const FONT_TEXT = 'Barlow, "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif';

/**
 * Canvas font strings are rebuilt on every draw call in a lot of places. They
 * are cached here by key so the hot path is a Map lookup, not string assembly.
 */
const fontCache = new Map<string, string>();

function cached(key: string, build: () => string): string {
  let f = fontCache.get(key);
  if (f === undefined) {
    f = build();
    if (fontCache.size > 512) fontCache.clear();
    fontCache.set(key, f);
  }
  return f;
}

/** Barlow Condensed. 600 for small labels, 800 for headings, 900 italic to shout. */
export function displayFont(size: number, weight = 800, italic = false): string {
  const px = Math.round(size * 10) / 10;
  return cached(`d${px}|${weight}|${italic ? 1 : 0}`, () =>
    `${italic ? 'italic ' : ''}${weight} ${px}px ${FONT_DISPLAY}`,
  );
}

/** Barlow. 500 for reading, 700 for emphasis. */
export function textFont(size: number, weight = 500, italic = false): string {
  const px = Math.round(size * 10) / 10;
  return cached(`t${px}|${weight}|${italic ? 1 : 0}`, () =>
    `${italic ? 'italic ' : ''}${weight} ${px}px ${FONT_TEXT}`,
  );
}

/**
 * Outline width for a glyph of this size.
 *
 * The old rule was a flat quarter of the size, which at 8px closed every
 * counter in the alphabet and at 64px painted a dark slab behind "FIGHT!" that
 * read as a box. An outline is there to separate the letter from whatever is
 * behind it; past about 3px it starts competing with the letter instead.
 */
export function strokeFor(size: number): number {
  return Math.min(3.4, Math.max(1.2, size * 0.16));
}

export interface InkTextOpts {
  align?: CanvasTextAlign;
  weight?: number;
  italic?: boolean;
  /** Outline colour. Defaults to the shared ink. */
  stroke?: string;
  /** Override the computed outline width. 0 disables it. */
  strokeWidth?: number;
  /** Drop shadow offset in px, drawn in ink under the glyph. 0 disables it. */
  shadow?: number;
  /** Letter spacing in px. Canvas has none of its own. */
  tracking?: number;
}

/**
 * Display text the way the HUD and every banner draw it: drop shadow, ink
 * outline, fill. Returns the drawn width.
 */
export function inkText(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  size: number,
  fill: string | CanvasGradient,
  opts: InkTextOpts = {},
): number {
  const align = opts.align ?? 'left';
  ctx.font = displayFont(size, opts.weight ?? 800, opts.italic ?? false);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const tracking = opts.tracking ?? 0;
  const sw = opts.strokeWidth ?? strokeFor(size);
  const shadow = opts.shadow ?? Math.min(2.4, size * 0.07);

  if (tracking === 0) {
    ctx.textAlign = align;
    const w = ctx.measureText(s).width;
    if (shadow > 0) {
      ctx.fillStyle = PALETTE.ink;
      if (sw > 0) {
        ctx.lineWidth = sw;
        ctx.strokeStyle = PALETTE.ink;
        ctx.strokeText(s, x + shadow * 0.4, y + shadow);
      }
      ctx.fillText(s, x + shadow * 0.4, y + shadow);
    }
    if (sw > 0) {
      ctx.lineWidth = sw;
      ctx.strokeStyle = opts.stroke ?? PALETTE.ink;
      ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(s, x, y);
    return w;
  }

  // Tracked: lay the glyphs out by hand, then run the same three passes.
  const chars = [...s];
  let w = -tracking;
  for (const ch of chars) w += ctx.measureText(ch).width + tracking;
  let cx = align === 'center' ? x - w * 0.5 : align === 'right' || align === 'end' ? x - w : x;
  ctx.textAlign = 'left';
  for (const ch of chars) {
    const cw = ctx.measureText(ch).width;
    if (shadow > 0) {
      ctx.fillStyle = PALETTE.ink;
      if (sw > 0) {
        ctx.lineWidth = sw;
        ctx.strokeStyle = PALETTE.ink;
        ctx.strokeText(ch, cx + shadow * 0.4, y + shadow);
      }
      ctx.fillText(ch, cx + shadow * 0.4, y + shadow);
    }
    if (sw > 0) {
      ctx.lineWidth = sw;
      ctx.strokeStyle = opts.stroke ?? PALETTE.ink;
      ctx.strokeText(ch, cx, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(ch, cx, y);
    cx += cw + tracking;
  }
  return w;
}

/** Plain filled text with letter spacing. Returns the drawn width. */
export function trackedText(
  ctx: C2D,
  s: string,
  x: number,
  y: number,
  tracking: number,
  fill: string,
  align: CanvasTextAlign = 'left',
): number {
  const chars = [...s];
  let w = -tracking;
  for (const ch of chars) w += ctx.measureText(ch).width + tracking;
  let cx = align === 'center' ? x - w * 0.5 : align === 'right' || align === 'end' ? x - w : x;
  ctx.textAlign = 'left';
  ctx.fillStyle = fill;
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
  return w;
}

// ── Shapes that belong to the identity ───────────────────────────────────────

/**
 * A full-width banner band: the frame every announcement in a fight sits in —
 * MAP 07, FIGHT!, MAP CLEAR, CONTINUE?. `open` (0..1) is how far it has opened;
 * the band grows from its centre line, so it reads as a shutter, not a fade.
 */
export function band(
  ctx: C2D,
  width: number,
  cy: number,
  h: number,
  open: number,
  fill: string = 'rgba(12,10,9,0.86)',
  edge: string = PALETTE.lamp,
): void {
  const hh = h * Math.max(0, Math.min(1, open));
  if (hh < 0.5) return;
  const y = cy - hh * 0.5;
  ctx.fillStyle = fill;
  ctx.fillRect(0, y, width, hh);
  // Two hairlines of lamp light, and a stud pattern along the top one: the same
  // studs as the jackets and the logo, so even a banner is wearing the leather.
  ctx.fillStyle = edge;
  ctx.fillRect(0, y - 1.5, width, 1.5);
  ctx.fillRect(0, y + hh, width, 1.5);
  if (hh > 18) {
    ctx.save();
    ctx.globalAlpha *= 0.5;
    for (let x = 6; x < width; x += 14) ctx.fillRect(x, y + 3, 2, 2);
    for (let x = 13; x < width; x += 14) ctx.fillRect(x, y + hh - 5, 2, 2);
    ctx.restore();
  }
}

/**
 * The slab: a parallelogram leaning forward by `lean` px across its height.
 * Every banner, keycap strip and HUD plate in the game is one of these — the
 * same forward lean as the italic display face, so type and shape move together.
 */
export function slab(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  lean: number,
  fill: string | CanvasGradient,
  outline?: string,
  ow = 1.4,
): void {
  ctx.beginPath();
  ctx.moveTo(x + lean, y);
  ctx.lineTo(x + w + lean, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (outline && ow > 0) {
    ctx.lineWidth = ow;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
}

/**
 * A keycap: the glyph of a real key or pad button, so every prompt in the game
 * shows the player the thing under their finger rather than a word for it.
 */
export function keycap(
  ctx: C2D,
  label: string,
  x: number,
  cy: number,
  size: number,
  fill: string = PALETTE.bone,
  ink: string = PALETTE.ink,
): number {
  ctx.font = displayFont(size, 800);
  const tw = ctx.measureText(label).width;
  const h = size + 4;
  const w = Math.max(h, tw + 6);
  const y = cy - h * 0.5;
  // Body, then a darker lip along the bottom so it reads as a physical key.
  ctx.fillStyle = ink;
  roundedRect(ctx, x - 0.5, y - 0.5, w + 1, h + 2, 2.4);
  ctx.fill();
  ctx.fillStyle = fill;
  roundedRect(ctx, x, y, w, h, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x + 1, y + h - 1.6, w - 2, 1.6);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + w * 0.5, cy + size * 0.36);
  return w;
}

function roundedRect(ctx: C2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * A row of controller hints along the foot of a canvas screen:
 * [keycap] VERB   [keycap] VERB ...  Returns the x it ended at.
 */
export function hintRow(
  ctx: C2D,
  items: readonly { keys: readonly string[]; verb: string }[],
  x: number,
  cy: number,
  size = 7,
  verbColor: string = PALETTE.boneDim,
): number {
  let cx = x;
  for (const item of items) {
    for (const k of item.keys) {
      cx += keycap(ctx, k, cx, cy, size) + 2;
    }
    cx += 3;
    ctx.font = displayFont(size + 1, 700);
    ctx.textAlign = 'left';
    ctx.fillStyle = verbColor;
    ctx.fillText(item.verb, cx, cy + (size + 1) * 0.36);
    cx += ctx.measureText(item.verb).width + 12;
  }
  return cx;
}

/** Measure a hint row without drawing it, for right- or centre-aligned rows. */
export function hintRowWidth(
  ctx: C2D,
  items: readonly { keys: readonly string[]; verb: string }[],
  size = 7,
): number {
  let w = 0;
  for (const item of items) {
    ctx.font = displayFont(size, 800);
    for (const k of item.keys) {
      const h = size + 4;
      w += Math.max(h, ctx.measureText(k).width + 6) + 2;
    }
    w += 3;
    ctx.font = displayFont(size + 1, 700);
    w += ctx.measureText(item.verb).width + 12;
  }
  return Math.max(0, w - 12);
}
