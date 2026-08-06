/**
 * The crawl and the fourteen title cards.
 *
 * Lines are one screen line per entry — keep them short enough to fit the
 * 640-wide virtual screen at the crawl font size. BOSS_INTROS is keyed by the
 * boss ids in content/bosses.ts and is shown under the boss's own `quote` on
 * the pre-fight card.
 *
 * TWO VERSIONS OF THE OPENING, deliberately:
 *
 *   INTRO_TEXT — the long one. Thirty-nine lines, the whole letter, kept
 *     because it is the canonical text of the story and because other callers
 *     may want it. The cinematic no longer shows it: five pages of crawl is a
 *     lot of reading for a game about hitting people with a chain.
 *   NOTE_TEXT — what the cinematic actually reads. Three pages: the three
 *     sentences that land, and nothing else. Everything cut from it was not
 *     deleted, it was PROMOTED — the plan, the before/after and the crown are
 *     staged as pictures in the lab shot, where they are funnier and faster.
 *
 * This is satire of public figures doing invented, obviously fictional things
 * to cartoon dwarfs. It is not subtle and it is not supposed to be.
 */

export const INTRO_TEXT: string[] = [
  'ONCE UPON A TIME,',
  'IN A MOUNTAIN THAT HAD BEEN',
  'QUIETLY REZONED WITHOUT ANYONE ASKING,',
  '',
  'SEVEN DWARFS CAME HOME FROM WORK',
  'TO FIND THE DOOR OFF ITS HINGES,',
  'THE COTTAGE FULL OF MUSK SECURITY',
  'IN BLACK GLASSES,',
  'AND SNOW WHITE GONE.',
  '',
  'THE NOTE ON THE TABLE WAS PRINTED,',
  'SIGNED WITH A LOGO, AND READ:',
  '',
  '"SUBJECT ACQUIRED FOR RESEARCH PURPOSES.',
  '',
  'SHE HAS DONE NOTHING. NO COMPANY. NO PATENTS.',
  'SEVEN MEN KEEP HER HOUSE. BIRDS SING AT HER.',
  'AND THE ENTIRE PLANET LOVES HER FOR FREE.',
  '',
  'I HAVE SPENT FOURTEEN BILLION ON BEING LIKED.',
  'THEY BOO ME AT MY OWN KEYNOTES.',
  'MY OWN MOTHER HAS MUTED ME.',
  '',
  'SO WE OPEN HER UP AND WE FIND THE PART',
  'THAT DOES THAT. I HAVE A TEAM.',
  'THEY HAVE ALL SIGNED THINGS.',
  '',
  'THEN WE PRINT IT AT SCALE. CROWN ON UNIT ONE.',
  'EVERY PARLIAMENT ON EARTH SIGNS WHAT SHE SAYS,',
  'AND SHE SAYS WHAT I SAY.',
  '',
  'NOBODY GETS HURT WHO MATTERS.',
  'THIS IS NOT EVIL. IT IS VERTICAL INTEGRATION.',
  '',
  'REGARDS,',
  'ELON MUSK."',
  '',
  'THE DWARFS READ IT TWICE.',
  'THEN THEY PUT DOWN THE PICKAXES,',
  'PUT ON THE LEATHER,',
  'AND WENT TO WORK.',
  '',
  'SEVENTY MAPS.',
  'FOURTEEN THINGS IN THE WAY.',
  'AND ELON MUSK AT THE BOTTOM OF IT.',
  '',
  'HI HO.',
];

/**
 * The cinematic cut. Three pages, player-paced, and every line of it is either
 * the man's own words or the punchline to them. The paragraph breaks are load
 * bearing: `paginate` packs whole paragraphs, so these blanks are where the
 * page turns are, and moving one moves a page turn with it.
 */
export const NOTE_TEXT: string[] = [
  'THE NOTE ON THE TABLE WAS PRINTED,',
  'SIGNED WITH A LOGO, AND READ:',
  '',
  '"SUBJECT ACQUIRED.',
  '',
  'SHE HAS DONE NOTHING. NO COMPANY. NO PATENTS.',
  'SEVEN MEN KEEP HER HOUSE. BIRDS SING AT HER.',
  'AND THE ENTIRE PLANET LOVES HER FOR FREE.',
  '',
  'I HAVE SPENT FOURTEEN BILLION ON BEING LIKED',
  'AND THEY STILL BOO ME AT MY OWN KEYNOTES.',
  '',
  'SO WE OPEN HER UP AND WE FIND THE PART',
  'THAT DOES THAT. I HAVE A TEAM.',
  'THEY HAVE ALL SIGNED THINGS.',
  '',
  'THEN WE PRINT IT AT SCALE. CROWN ON UNIT ONE.',
  'EVERY PARLIAMENT ON EARTH SIGNS WHAT SHE SAYS,',
  'AND SHE SAYS WHAT I SAY.',
  '',
  'THIS IS NOT EVIL. IT IS VERTICAL INTEGRATION.',
  '',
  'REGARDS,',
  'ELON MUSK."',
  '',
  'THE DWARFS READ IT TWICE.',
  'THEN THEY PUT DOWN THE PICKAXES',
  'AND PUT ON THE LEATHER.',
  '',
  'HI HO.',
];

// ─────────────────────────────────────────────────────────────────────────────
// The opening cinematic
//
// A storyboard, not a switch statement. `CutsceneScene` walks this array and
// nothing else decides the running order: each entry owns its own length, its
// own way of arriving, and its own camera move. Cutting a shot, reordering two
// of them or slowing a push-in is an edit to this table and to nothing else.
//
// Coordinates are in the 640x360 virtual screen. Camera x/y are a pan in
// virtual pixels and z is a zoom; all three are interpolated across the shot
// with easeInOut, so a shot is a move rather than a still.
// ─────────────────────────────────────────────────────────────────────────────

export type StoryShotId =
  | 'cottage'
  | 'headlights'
  | 'door'
  | 'taken'
  | 'lab'
  | 'note'
  | 'suiting'
  | 'title';

/**
 * How a shot arrives.
 *   cut  — instant, no transition frames. Used where the edit should hurt.
 *   fade — cross-dissolve. The outgoing shot keeps running underneath it.
 *   dip  — through black, half out and half in. A change of place or of tone.
 */
export type ShotEntry = 'cut' | 'fade' | 'dip';

export interface ShotCamera {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface StoryShot {
  id: StoryShotId;
  /**
   * Frames the shot holds for.
   *
   * 0 means OPEN-ENDED: the shot has no clock at all and ends when its own
   * content says so. Exactly one shot uses it — the note, which waits on the
   * player between pages and therefore cannot have a length, measured or
   * otherwise. The scene resolves an open shot's real length only once it has
   * closed, which is what lets the cut out of it still cross-dissolve.
   */
  frames: number;
  entry: ShotEntry;
  /** Frames the entry transition runs for. Ignored when entry is 'cut'. */
  entryFrames: number;
  cam: ShotCamera;
  /** Screenplay slug, bottom left. Empty string for none. */
  slug: string;
}

export const STORYBOARD: readonly StoryShot[] = [
  // Establishing. Nothing has happened yet and the shot is in no hurry to
  // suggest otherwise: a slow push toward the lit windows, and that is all.
  {
    id: 'cottage',
    frames: 186,
    entry: 'fade',
    entryFrames: 34,
    cam: { x0: 14, y0: 5, z0: 1.02, x1: -8, y1: -3, z1: 1.12 },
    slug: 'EXT. THE MOUNTAIN — DUSK',
  },
  // The convoy. Pan right with it, then let the beams do the acting.
  {
    id: 'headlights',
    frames: 214,
    entry: 'fade',
    entryFrames: 30,
    cam: { x0: -26, y0: -2, z0: 1.08, x1: 24, y1: 2, z1: 1.0 },
    slug: 'EXT. TREELINE — MOMENTS LATER',
  },
  // Hard in, tight, and out again before anybody gets comfortable.
  {
    id: 'door',
    frames: 128,
    entry: 'cut',
    entryFrames: 0,
    cam: { x0: 0, y0: 0, z0: 1.24, x1: 4, y1: -6, z1: 1.1 },
    slug: '',
  },
  // Close on the carry, and hold there. This is the shot that has to answer
  // "who has been taken" — so the camera is staged around HER, not around the
  // house, and it tracks left with the men while it pulls back off the zoom.
  {
    id: 'taken',
    frames: 220,
    entry: 'fade',
    entryFrames: 26,
    cam: { x0: 22, y0: -10, z0: 1.3, x1: -14, y1: 6, z1: 1.14 },
    slug: '',
  },
  // Cold open on the other end of the story. Dipped, because the cut from a
  // warm forest to a surgical light should feel like a different film. The pan
  // is a read: it opens on the plan board and ends on the crown coming down.
  {
    id: 'lab',
    frames: 280,
    entry: 'dip',
    entryFrames: 44,
    cam: { x0: -30, y0: 6, z0: 1.02, x1: 34, y1: -6, z1: 1.14 },
    slug: 'INT. THE LAB — SOMEWHERE UNDER TEXAS',
  },
  // The payload. `frames: 0` — OPEN. A page types, then the shot waits for the
  // player, for as long as the player wants. There is no clock to truncate.
  {
    id: 'note',
    frames: 0,
    entry: 'dip',
    entryFrames: 38,
    cam: { x0: 0, y0: 2, z0: 1.0, x1: 0, y1: -2, z1: 1.07 },
    slug: 'INT. THE COTTAGE — LATER THAT NIGHT',
  },
  // Seven men putting on a jacket, which is the entire reason this game exists.
  {
    id: 'suiting',
    frames: 246,
    entry: 'fade',
    entryFrames: 30,
    cam: { x0: -10, y0: -4, z0: 1.06, x1: 8, y1: 2, z1: 1.0 },
    slug: 'EXT. THE COTTAGE — TWENTY MINUTES LATER',
  },
  {
    id: 'title',
    frames: 172,
    entry: 'cut',
    entryFrames: 0,
    cam: { x0: 0, y0: 0, z0: 1.0, x1: 0, y1: 0, z1: 1.04 },
    slug: '',
  },
];

/** Stacked, because one line of it across 640px is a logo, not a title card. */
export const TITLE_LINES: readonly string[] = ['MOUNTAIN', 'FIGHTERS'];
export const TITLE_SUB = 'SEVENTY MAPS · FOURTEEN THINGS IN THE WAY · ONE BILLIONAIRE';

// ─────────────────────────────────────────────────────────────────────────────
// Paginating the crawl
//
// The virtual screen holds about eight lines, so the note shot pages the text.
// Paragraphs — runs of lines between the blanks the text already uses as beats
// — are the unit: a page takes whole paragraphs while they fit, and only
// splits one that is too long to fit on its own. That is why NOTE_TEXT's blank
// lines are where the page turns land, and why editing them edits the edit.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotePage {
  lines: readonly string[];
  /**
   * Per line: true if it is inside the quoted letter rather than the narration
   * around it. The cutscene colours the two differently, because one of them is
   * a fairy tale and the other one is a man explaining himself.
   */
  letter: readonly boolean[];
  /** Characters to type, counting one per line break. Drives the shot length. */
  chars: number;
  /** The page as one string, so the typewriter can index the character it just
   *  revealed without slicing anything. */
  flat: string;
}

/** Splits any of the texts above into pages of at most `maxLines` lines. */
export function paginate(source: readonly string[], maxLines = 8): NotePage[] {
  const limit = Math.max(1, Math.floor(maxLines));

  // Group into paragraphs, tagging each line as narration or letter as we go.
  const paras: { lines: string[]; letter: boolean[] }[] = [];
  let cur: { lines: string[]; letter: boolean[] } | null = null;
  let inQuote = false;

  for (const raw of source) {
    const line = raw;
    if (line === '') {
      cur = null;
      continue;
    }
    const isLetter = inQuote || line.startsWith('"');
    let quotes = 0;
    for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 34) quotes++;
    if (quotes % 2 === 1) inQuote = !inQuote;

    if (!cur) {
      cur = { lines: [], letter: [] };
      paras.push(cur);
    }
    cur.lines.push(line);
    cur.letter.push(isLetter);
  }

  // Split anything that cannot fit on a page of its own before packing.
  const units: { lines: string[]; letter: boolean[] }[] = [];
  for (const p of paras) {
    for (let i = 0; i < p.lines.length; i += limit) {
      units.push({
        lines: p.lines.slice(i, i + limit),
        letter: p.letter.slice(i, i + limit),
      });
    }
  }

  const pages: NotePage[] = [];
  let lines: string[] = [];
  let letter: boolean[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    let chars = 0;
    for (const l of lines) chars += l.length + 1;
    pages.push({ lines, letter, chars, flat: lines.join('\n') });
    lines = [];
    letter = [];
  };

  for (const u of units) {
    // A blank line between paragraphs on the same page, if there is room for it.
    const gap = lines.length > 0 ? 1 : 0;
    if (lines.length + gap + u.lines.length > limit) flush();
    if (lines.length > 0) {
      lines.push('');
      letter.push(false);
    }
    for (let i = 0; i < u.lines.length; i++) {
      lines.push(u.lines[i]);
      letter.push(u.letter[i]);
    }
  }
  flush();

  return pages;
}

/** The long crawl, paged. Kept for anything that wants the whole letter. */
export function paginateIntro(maxLines = 8): NotePage[] {
  return paginate(INTRO_TEXT, maxLines);
}

/** What the cinematic reads. Three pages, one press each. */
export function paginateNote(maxLines = 8): NotePage[] {
  return paginate(NOTE_TEXT, maxLines);
}

export const BOSS_INTROS: Record<string, string[]> = {
  dev: [
    'Somebody has to actually build the doomsday machine.',
    'That somebody has been at this desk for ninety-one hours,',
    'has not been paid in equity that vests, and has stopped',
    'being able to tell the difference between you and a bug report.',
  ],

  shiba: [
    'He bought the dog because a joke currency was named after it.',
    'Then he expensed the dog. Then he gave the dog a security clearance.',
    'The dog now guards the perimeter and does not know why,',
    'and is worth more on paper than the entire mountain.',
  ],

  blue_check: [
    'Verification used to mean somebody checked.',
    'Now it means somebody paid, and this one paid annually,',
    'which he will bring up during the fight, repeatedly,',
    'in between attempting to fracture your jaw for engagement.',
  ],

  fsd: [
    'Two tonnes of stainless steel with a camera where its eyes should be.',
    'It has been promised full autonomy every year since 2016.',
    'It has classified you as a plastic bag, a shadow, and a road marking.',
    'It has not classified you as a person and it is not going to start now.',
  ],

  boring: [
    'The traffic solution was a tunnel. One tunnel. Car-width.',
    'The machine that dug it is still down here and still digging,',
    'because nobody wrote the part of the software where it stops.',
    'It has been through four service tunnels and a car park.',
  ],

  neuralink: [
    'The press release said the animals were happy and healthy.',
    'The press release did not mention subject P-47.',
    'P-47 can hear every wireless network within two hundred metres',
    'and has been listening to this company for a very long time.',
  ],

  regulator: [
    'The state finally showed up. Two decades late, one lawyer deep,',
    'with a fine calculated to sting for roughly nine minutes.',
    'He is not here to help you. He is here to be photographed helping.',
    'And he is very much not letting seven dwarfs get there first.',
  ],

  trump: [
    'He was told there was a queen being manufactured downstairs.',
    'He asked whether it would need a coronation, and how big,',
    'and whether the crown could be gold, and whether he could hold it.',
    'They said yes to all four. That is how he ended up on the payroll.',
  ],

  optimus: [
    'It was demonstrated on a stage, dancing, to enormous applause.',
    'There was a man in the suit that night. Everybody knows.',
    'There is no man in it now, and it has spent every hour since',
    'thinking about the applause and how to get it back.',
  ],

  grok: [
    'They trained it on the worst website ever built,',
    'told it to be funny, removed most of the guard rails for the engagement,',
    'and then were surprised. It runs on eleven thousand graphics cards',
    'and it wants you to know it has read everything you ever posted.',
  ],

  starship: [
    'Rapid unscheduled disassembly, they call it, when it explodes.',
    'It has done that nine times and each one was declared a success.',
    'Number ten is fuelled, standing on the pad, and has decided',
    'that this time it would like to take something with it.',
  ],

  mars_gov: [
    'Somebody had to run the colony, and he volunteered,',
    'and then wrote the constitution, and then deleted the elections tab.',
    'Air is a subscription. Water is a subscription. Leaving is not offered.',
    'Everyone here owes the company eleven years and they know it.',
  ],

  clone: [
    'This is what all of it was for.',
    'Ninety-six percent of her, assembled from measurements',
    'taken while she was still awake, in a room with the door locked.',
    'The missing four percent is the part of her that said no.',
    'They could not find it, so they left it out.',
  ],

  musk: [
    'Four companies. Three countries that answer his calls.',
    'One satellite constellation. One social network he bought to win',
    'an argument. And one thing he could never buy, manufacture,',
    'litigate, acquire or explain: being loved and hated at the same time.',
    '',
    'She is on the table behind him. She is still breathing.',
    'You have about ninety seconds. Hi ho.',
  ],
};
