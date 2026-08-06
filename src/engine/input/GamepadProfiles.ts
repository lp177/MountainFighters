/**
 * What a controller actually is, and how to read it.
 *
 * The Gamepad API promises a "standard" mapping and then, on real machines,
 * frequently does not deliver one. Firefox on Linux, several Nintendo pads and
 * most third-party hardware report `mapping: ''`, which means the browser is
 * handing over whatever the driver said with no remapping at all. Reading such
 * a pad with the W3C indices and no checks is how a controller ends up pausing
 * the game when you press the left stick in.
 *
 * So this module answers two separate questions:
 *
 *  1. WHERE is each control — an index into `buttons` or `axes`. This is
 *     PHYSICAL POSITION: `south` is the bottom face button, whatever letter is
 *     printed on it.
 *  2. WHAT IS PRINTED ON IT — the `labels` block, used by the UI and nowhere
 *     else.
 *
 * Gameplay binds to POSITION, never to the letter. The bottom face button is
 * Light on every pad on earth; on a Nintendo pad that button says "B" and on an
 * Xbox pad it says "A", and the game does not care. This is exactly the rule
 * `Bindings.ts` follows for the keyboard — bind by physical key position, print
 * whatever the key says — and this codebase already got it wrong once, telling
 * AZERTY players to press "W" for a key their board calls "Z". A Nintendo
 * player being told to press "A" for the button their pad calls "B" is the
 * same bug wearing a different hat.
 *
 * Nothing here throws. A pad with four buttons, no axes and a nonsense id is a
 * pad someone is holding, and the worst acceptable outcome is that some of its
 * controls do nothing.
 */

export type PadVendor = 'xbox' | 'playstation' | 'nintendo' | 'steamdeck' | 'generic';

export interface PadProfile {
  vendor: PadVendor;
  /** Display name: 'Xbox Controller', 'Switch Pro Controller', 'Steam Deck'. */
  name: string;

  /** Physical-position button indices. -1 when the pad has no such button. */
  south: number;
  east: number;
  west: number;
  north: number;
  l1: number;
  r1: number;
  l2: number;
  r2: number;
  start: number;
  select: number;
  dpadUp: number;
  dpadDown: number;
  dpadLeft: number;
  dpadRight: number;

  /** Left stick axes, and -1 when the pad has none. */
  axisX: number;
  axisY: number;

  /** Some pads report the d-pad as a hat on an axis instead of buttons. */
  hatAxis?: number;
  /**
   * The other way a driver reports a hat: two axes, one per direction pair,
   * each resting at 0. joydev (Linux) does this for ABS_HAT0X / ABS_HAT0Y.
   */
  dpadAxisX?: number;
  dpadAxisY?: number;

  /** Analog triggers report on an axis on several non-standard pads. */
  l2Axis?: number;
  r2Axis?: number;

  /**
   * What is PRINTED on the control at each position, for the UI. Never for
   * bindings.
   *
   * The triggers earn their entries here: `l2` carries Interact (pick up, swap,
   * mount) and `r2` carries Super, so a controls screen prints both, and it
   * prints what the pad in the player's hands actually says — LT on an Xbox
   * pad, ZL on a Nintendo one, L2 on a DualSense or a Steam Deck. The position
   * is identical on all four; only the engraving moves.
   */
  labels: {
    south: string;
    east: string;
    west: string;
    north: string;
    l1: string;
    r1: string;
    l2: string;
    r2: string;
    start: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The W3C "standard gamepad" layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * https://w3c.github.io/gamepad/#remapping — buttons 0..16, axes 0..3.
 *
 * When `mapping === 'standard'` the browser has already normalised the pad to
 * this, whatever the hardware is, so a DualSense and an Xbox pad differ only in
 * what is printed on them. When it has NOT, this is still the best starting
 * guess available: it is what most drivers approximate, and every read of it is
 * bounds-checked, so being wrong costs a dead control rather than a wrong one.
 */
const W3C = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  axisX: 0,
  axisY: 1,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

type Labels = PadProfile['labels'];

const XBOX_LABELS: Labels = {
  south: 'A',
  east: 'B',
  west: 'X',
  north: 'Y',
  l1: 'LB',
  r1: 'RB',
  l2: 'LT',
  r2: 'RT',
  start: 'Start',
};

const PLAYSTATION_LABELS: Labels = {
  south: 'Cross',
  east: 'Circle',
  west: 'Square',
  north: 'Triangle',
  l1: 'L1',
  r1: 'R1',
  l2: 'L2',
  r2: 'R2',
  start: 'Options',
};

/**
 * Nintendo's face buttons sit in the same PHYSICAL positions as everyone
 * else's, with the letters swapped: the bottom button says B and the right one
 * says A. Only these strings move — the bottom button is still Light.
 */
const NINTENDO_LABELS: Labels = {
  south: 'B',
  east: 'A',
  west: 'Y',
  north: 'X',
  l1: 'L',
  r1: 'R',
  l2: 'ZL',
  r2: 'ZR',
  start: '+',
};

/** Xbox letters on the face, but the Deck prints L1/R1/L2/R2 and a Menu key. */
const STEAMDECK_LABELS: Labels = {
  south: 'A',
  east: 'B',
  west: 'X',
  north: 'Y',
  l1: 'L1',
  r1: 'R1',
  l2: 'L2',
  r2: 'R2',
  start: 'Menu',
};

/**
 * An unknown pad gets Xbox letters, because the W3C standard layout is itself
 * described in Xbox terms and that is what the overwhelming majority of
 * unrecognised PC pads are wearing.
 */
const GENERIC_LABELS: Labels = XBOX_LABELS;

const LABELS: Record<PadVendor, Labels> = {
  xbox: XBOX_LABELS,
  playstation: PLAYSTATION_LABELS,
  nintendo: NINTENDO_LABELS,
  steamdeck: STEAMDECK_LABELS,
  generic: GENERIC_LABELS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Identification
// ─────────────────────────────────────────────────────────────────────────────

function has(id: string, ...needles: string[]): boolean {
  for (const n of needles) {
    if (id.indexOf(n) >= 0) return true;
  }
  return false;
}

/**
 * Vendor from the pad id, which is free-form text plus, on Firefox, USB
 * vendor/product ids ('057e-2009-Pro Controller'). Valve is tested first: the
 * Deck's own controls and Steam Input's virtual pad both mention Steam, and a
 * Steam Input pad also says "xbox 360" in the same string.
 */
export function vendorFor(id: string): PadVendor {
  const s = (id || '').toLowerCase();
  if (has(s, 'steam deck', 'valve', '28de', 'jupiter', 'galileo')) return 'steamdeck';
  if (has(s, 'dualshock', 'dualsense', 'playstation', '054c', 'ps4', 'ps5')) return 'playstation';
  if (has(s, 'nintendo', 'switch', 'joy-con', 'joycon', 'pro controller', '057e')) {
    return 'nintendo';
  }
  if (has(s, 'xbox', 'xinput', 'x-box', '045e')) return 'xbox';
  return 'generic';
}

function nameFor(vendor: PadVendor, id: string): string {
  const s = (id || '').toLowerCase();
  switch (vendor) {
    case 'steamdeck':
      return has(s, 'steam deck', 'jupiter', 'galileo') ? 'Steam Deck' : 'Steam Controller';
    case 'playstation':
      if (has(s, 'dualsense', 'ps5', '0ce6', '0df2')) return 'DualSense Controller';
      if (has(s, 'dualshock', 'ps4', '05c4', '09cc')) return 'DualShock Controller';
      return 'PlayStation Controller';
    case 'nintendo':
      if (has(s, 'joy-con', 'joycon')) return 'Joy-Con';
      if (has(s, 'pro controller', '2009')) return 'Switch Pro Controller';
      return 'Nintendo Controller';
    case 'xbox':
      return 'Xbox Controller';
    default:
      return 'Gamepad';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────

function baseProfile(vendor: PadVendor, name: string): PadProfile {
  return {
    vendor,
    name,
    south: W3C.south,
    east: W3C.east,
    west: W3C.west,
    north: W3C.north,
    l1: W3C.l1,
    r1: W3C.r1,
    l2: W3C.l2,
    r2: W3C.r2,
    start: W3C.start,
    select: W3C.select,
    dpadUp: W3C.dpadUp,
    dpadDown: W3C.dpadDown,
    dpadLeft: W3C.dpadLeft,
    dpadRight: W3C.dpadRight,
    axisX: W3C.axisX,
    axisY: W3C.axisY,
    labels: LABELS[vendor],
  };
}

function buttonCount(pad: Gamepad): number {
  const b = pad.buttons;
  return b && typeof b.length === 'number' ? b.length : 0;
}

function axisCount(pad: Gamepad): number {
  const a = pad.axes;
  return a && typeof a.length === 'number' ? a.length : 0;
}

/**
 * The Linux joydev/xpad layout, which is what Firefox hands over for an Xbox
 * pad it has not remapped. It is recognised by its exact shape — 8 axes, 11
 * buttons — rather than by trusting the id alone, because the id is a driver
 * string and the shape is the thing that would actually break.
 *
 *   axes    0,1 left stick   2 LT   3,4 right stick   5 RT   6,7 d-pad hat
 *   buttons 0 A  1 B  2 X  3 Y  4 LB  5 RB  6 back  7 start  8 guide
 *           9 L3  10 R3
 *
 * Without this branch, Start reads button 9 — which on this pad is the left
 * stick click, so pressing the stick in pauses the fight.
 */
function isLinuxXpadShape(pad: Gamepad): boolean {
  return axisCount(pad) === 8 && buttonCount(pad) === 11;
}

function applyLinuxXpad(p: PadProfile): void {
  p.axisX = 0;
  p.axisY = 1;
  p.l2 = -1;
  p.r2 = -1;
  p.l2Axis = 2;
  p.r2Axis = 5;
  p.select = 6;
  p.start = 7;
  p.dpadUp = -1;
  p.dpadDown = -1;
  p.dpadLeft = -1;
  p.dpadRight = -1;
  p.dpadAxisX = 6;
  p.dpadAxisY = 7;
}

/**
 * Identify a pad and say how to read it.
 *
 * `mapping === 'standard'` means the indices are the W3C ones for every vendor
 * and only the labels differ. Anything else is unverified hardware: the W3C
 * indices are kept as the best available guess, a couple of shapes that can be
 * positively recognised are corrected, and everything else is left to the
 * bounds-checked reader in GamepadSource.
 */
export function profileFor(pad: Gamepad): PadProfile {
  let id = '';
  let mapping = '';
  try {
    id = typeof pad?.id === 'string' ? pad.id : '';
    mapping = typeof pad?.mapping === 'string' ? pad.mapping : '';
  } catch {
    // A hostile or exotic Gamepad-like object. It still gets a profile.
  }

  const vendor = vendorFor(id);
  const profile = baseProfile(vendor, nameFor(vendor, id));
  if (!pad) return profile;

  const axes = axisCount(pad);
  const buttons = buttonCount(pad);

  // No stick to read. Say so rather than reading axis 0 of an empty array.
  if (axes < 2) {
    profile.axisX = -1;
    profile.axisY = -1;
  }

  if (mapping === 'standard') return profile;

  if (vendor === 'xbox' && isLinuxXpadShape(pad)) {
    applyLinuxXpad(profile);
    return profile;
  }

  // No d-pad buttons at all. The d-pad has to be on the axes somewhere, and
  // there are only two conventions worth guessing at:
  //
  //  - an odd axis count leaves one axis unpaired, and that dangling last axis
  //    is the 8-way hat (the DirectInput convention);
  //  - an even count of at least six ends in the joydev pair, one axis per
  //    direction pair, both resting at 0.
  //
  // Both are guesses, so the reader refuses to believe an axis that has not
  // moved since the pad appeared. A trigger resting at -1 will not walk the
  // player into a wall for the rest of the fight.
  if (buttons < W3C.dpadRight + 1) {
    if (axes >= 5 && axes % 2 === 1) {
      profile.hatAxis = axes - 1;
    } else if (axes >= 6 && axes % 2 === 0) {
      profile.dpadAxisX = axes - 2;
      profile.dpadAxisY = axes - 1;
    }
  }

  return profile;
}
