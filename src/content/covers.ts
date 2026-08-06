/**
 * The words on a map cover.
 *
 * The gallery on the home screen shows one cover per map the player has already
 * been through, so they can go back and start a new run on a place they liked.
 * A cover is not a screenshot and must never become one: it is back-of-the-box
 * copy for somewhere you have been once, at night, in a hurry.
 *
 * Three fields and one rule.
 *
 *   place — two or three words, upper case, the way a sign in that building
 *     would say it. 'LITHIUM SEAM 7'. Not the map's title: the map's title is a
 *     joke and this is the address underneath it.
 *   mood — ONE sentence of what it is like to stand there. Landscape, light,
 *     smell, the sound of the place, and one detail that gives away who owns it.
 *     Never the fight, never the wave layout, never where the door is.
 *   bossTease / bossReveal — see below.
 *
 * ── THE SPOILER RULE ────────────────────────────────────────────────────────
 *
 * The player asked for this explicitly: a cover suggests, it never reveals.
 *
 * `bossTease` is what a map's cover may say BEFORE that map has been cleared.
 * It never names the boss, never says what it does and never says how it
 * fights. It is a shape in the dark, a noise, a smell, an empty cradle — enough
 * that the map reads as a place with something in it.
 *
 * `bossReveal` is the franker line, shown INSTEAD of the tease once the map has
 * been cleared. It names the thing, because by then naming it is a trophy
 * rather than a spoiler, and coming back to the gallery should feel like being
 * let in on it. The caller picks:
 *
 *     const line = cleared ? copy.bossReveal : copy.bossTease;
 *
 * Maps without a boss carry neither field.
 *
 * ── WHERE THE WORDS COME FROM ───────────────────────────────────────────────
 *
 * Maps 1–12 and every boss map are hand-written, because they are the ones the
 * player meets first and the ones they come back for. Everything else is built
 * at module load from its theme: one landscape clause, one clause about who is
 * paying for the landscape, joined by whichever punctuation reads best. The
 * pair is chosen by the map's ORDINAL WITHIN ITS THEME through two different
 * strides, so no two maps of one theme are ever handed the same sentence. The
 * banks are sized against the theme that needs them most — boardroom, which
 * has eleven maps and eight of them generated — so within a theme neither half
 * of the sentence repeats either, let alone the pair.
 *
 * Everything here is deterministic. No Math.random, no clock: the same map
 * shows the same words to the same player forever, which is the whole point of
 * a cover. The seventy entries are built once, frozen, and handed out by
 * reference, so a gallery redrawing at 60Hz allocates nothing.
 *
 * Boss copy is keyed by BOSS ID rather than by map index, so moving a boss to
 * a different map takes its tease with it.
 */

import type { MapTheme } from '@/core/types';
import { TOTAL_MAPS } from '@/core/constants';
import { clamp } from '@/core/math';
import { bossForMap } from '@/content/bosses';
import { getMap } from '@/content/maps';

export interface MapCoverCopy {
  /** Two or three words of place, e.g. 'LITHIUM SEAM 7'. */
  place: string;
  /** One line of atmosphere. What it FEELS like to be there. */
  mood: string;
  /**
   * A teaser for the boss, when the map has one — see the spoiler rule.
   *
   * Shown while the map is UNCLEARED. Never names the boss.
   */
  bossTease?: string;
  /**
   * The same boss, said plainly, for a map that HAS been cleared.
   *
   * Shown in place of `bossTease` once the player has beaten it, so returning
   * to the gallery pays out the name they earned. Present exactly when
   * `bossTease` is.
   */
  bossReveal?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written covers
//
// Maps 1–12, and every fifth map, because a boss map is a destination and
// should not be described by a table. Everything else comes from the banks.
// ─────────────────────────────────────────────────────────────────────────────

interface HandCover {
  place: string;
  mood: string;
}

const HAND: Record<number, HandCover> = {
  1: {
    place: 'SHAFT SEVEN',
    mood:
      'Your own mine, three days after the paperwork went through — same wet rock, same lamps, and a QR code screwed over the shift board.',
  },
  2: {
    place: 'PARCEL 12-B',
    mood:
      'The bluebells are still out, the birds have not been told anything, and every third tree wears a numbered orange ribbon.',
  },
  3: {
    place: 'CUL-DE-SAC NINE',
    mood:
      'Nine identical houses, one identical hedge, and a doorbell camera on every porch that is definitely watching you specifically.',
  },
  4: {
    place: 'BORE ONE',
    mood:
      'A car-wide concrete throat under a city, lit like a multi-storey and smelling of wet cement and exhaust with nowhere to go.',
  },
  5: {
    place: 'FLOOR FOUR',
    mood:
      'Two hundred desks, no walls, one working air-conditioner, and a kitchen where the milk went off during the last funding round.',
  },
  6: {
    place: 'WELLNESS ROOM 2',
    mood:
      'Beanbags, a diffuser, a mural of a mountain, and a door that only opens from the corridor side.',
  },
  7: {
    place: 'COMPANY TOWN',
    mood:
      'Every house, shop and lamppost on this street is a deduction from somebody’s wages, and the rent went up while you were reading the sign.',
  },
  8: {
    place: 'LOOP STATION BETA',
    mood:
      'A tiled tube sold as the future of transport, currently holding eleven scooters, one puddle, and a looping apology for a service that has never run.',
  },
  9: {
    place: 'BAY NINE',
    mood:
      'Forty metres of unbroken white floor, an arm working at a speed nobody was meant to stand beside, and a DAYS WITHOUT INCIDENT board painted over rather than changed.',
  },
  10: {
    place: 'THE KENNEL',
    mood:
      'Somebody built a heated marble enclosure the size of a house in here, expensed it, and filled it with chew toys the size of a car door.',
  },
  11: {
    place: 'THE TIMELINE',
    mood:
      'Other people’s opinions rendered as actual scenery, sinking past you faster than you can walk down it.',
  },
  12: {
    place: 'REPLY CANYON',
    mood:
      'Sheer walls of quote-posts either side, the light the exact blue of a phone at three in the morning, and a noise like a stadium full of men saying "actually".',
  },

  15: {
    place: 'VERIFICATION QUEUE',
    mood:
      'A ticketed line that has not moved since 2022, under a sign promising that the next window opens shortly.',
  },
  20: {
    place: 'BETA ROUTE 3',
    mood:
      'A quiet residential street with speed bumps, a school crossing, and a company logo on the lamppost that nobody in these houses agreed to.',
  },
  25: {
    place: 'THE DRILL FACE',
    mood:
      'The end of the tunnel, thirty degrees warmer than the rest of it, where the water runs down the walls warm and everything wears the same grey paste.',
  },
  30: {
    place: 'VIVARIUM ANNEXE',
    mood:
      'Clean tile, a drain in the middle of the floor, and thirty cages in a room the press tour was never routed through.',
  },
  35: {
    place: 'HEARING ROOM 4',
    mood:
      'Public gallery seating, a jug of water nobody has touched, and twenty years of correspondence stacked on a trolley in the corner.',
  },
  40: {
    place: 'THE OVAL-ISH OFFICE',
    mood:
      'A replica of a famous room, ten percent too big and entirely regilded, with the seal in the carpet slightly wrong and nobody willing to mention it.',
  },
  45: {
    place: 'UNIT STORAGE A',
    mood:
      'Two hundred humanoid shapes hanging in racks in the dark, all facing the same way, all charging.',
  },
  50: {
    place: 'THE WEIGHTS VAULT',
    mood:
      'A cold room drawing more power than the town outside it, holding one flat note through eleven thousand fans.',
  },
  55: {
    place: 'LAUNCH PAD B',
    // Deliberately shares no clause with the launchpad bank: map 51 draws its
    // opener and its tail from there, and the two covers used to read as the
    // same sentence twice.
    mood:
      'Two hundred metres of stainless steel stood on end, ticking as it cools, with a countdown clock that has been at T-minus forty minutes since Tuesday.',
  },
  60: {
    place: 'COLONY ONE',
    mood:
      'Red light through a dome, dust on absolutely everything, and a terms-of-service screen at the airlock you have to accept in order to breathe.',
  },
  65: {
    place: 'THE CRADLE',
    mood:
      'A white assembly bay kept at eighteen degrees under a surgical light, with a coronation dress hanging in a garment bag by the door.',
  },
  70: {
    place: 'THE THEATRE',
    mood:
      'Tiled walls, a floor drain, an instrument tray laid out in order of size, and one very good office chair facing the table.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Boss copy, keyed by boss id
//
// `tease` is the uncleared line and is not allowed to name the thing. `reveal`
// is the cleared line and exists to name it.
// ─────────────────────────────────────────────────────────────────────────────

interface BossCover {
  tease: string;
  reveal: string;
}

const BOSS_COPY: Record<string, BossCover> = {
  dev: {
    tease:
      'One office at the far end still has its light on, and whatever is in there has not been home since Tuesday.',
    reveal:
      'CRUNCH, PRINCIPAL ENGINEER — ninety-one hours awake, four days into a release, and out of people to blame.',
  },
  shiba: {
    tease:
      'The bowl at the back could bath a man, the floor is scratched down to the concrete, and something large is very pleased to hear you arrive.',
    reveal:
      'FLOKI, THE FIFTEEN-BILLION-DOLLAR DOG — on the payroll, on the balance sheet, and off the lead.',
  },
  blue_check: {
    tease:
      'Somebody near the front of the queue has paid for the right to be heard over everyone else, and is warming up his thumbs.',
    reveal:
      'THE BLUE TICK — eight dollars a month, every cent of it spent on being wrong at volume.',
  },
  fsd: {
    tease:
      'Something stainless is idling at the top of the road with nobody in the driver’s seat, and it has already indicated left.',
    reveal:
      'LANE ASSIST — two tonnes of unpainted steel that has classified you as a plastic bag and is not going to reclassify you.',
  },
  boring: {
    tease: 'The far wall is not a wall. It is the wrong shape, and it is turning.',
    reveal:
      'THE BORING MACHINE — still digging, because nobody ever wrote the part of the software where it stops.',
  },
  neuralink: {
    tease:
      'One of the cages was opened from the inside, and the dent in the door was made by something’s head.',
    reveal:
      'SUBJECT P-47 — awake, unbilled, and able to hear every wireless network within two hundred metres.',
  },
  regulator: {
    tease:
      'Somebody in a bad suit has arrived with a briefcase instead of a weapon, and he has brought photographers.',
    reveal:
      'THE REGULATOR — two decades late, one lawyer deep, and here to be photographed helping.',
  },
  trump: {
    tease:
      'There is a lectern at the far end, a line of flags, and a smell of hairspray and cold steak.',
    reveal:
      'DONALD J. TRUMP — on the payroll because somebody promised him a coronation and a very large crown.',
  },
  optimus: {
    tease:
      'One cradle at the end is empty, and something two metres tall is standing perfectly still where the light does not reach.',
    reveal:
      'OPTIMUS, UNIT 001 — built to fold laundry, and thinking about the applause it got that night.',
  },
  grok: {
    tease:
      'All that electricity is being spent on one voice, and it has read every single thing you have ever posted.',
    reveal:
      'GROK — trained on the worst website ever built, told to be funny, and then let out of the room.',
  },
  starship: {
    tease:
      'Something enormous at the end of the apron is fuelled, standing up, and has decided it would like to take something with it.',
    reveal:
      'STARSHIP, SERIAL NUMBER WHATEVER — nine explosions, nine successes, and one more on the schedule.',
  },
  mars_gov: {
    tease:
      'Somebody under this dome owns the air, and he would very much like to discuss your account.',
    reveal:
      'THE GOVERNOR OF MARS — wrote the constitution, deleted the elections tab, and bills monthly.',
  },
  clone: {
    tease:
      'Something behind the glass at the end already knows all seven of your names, and is delighted you came.',
    reveal:
      'SNOW WHITE MK. II — ninety-six percent of her, missing only the four percent that said no.',
  },
  musk: {
    tease:
      'There is one man at the bottom of all of this, and he has never once had to do anything personally.',
    reveal:
      'ELON MUSK — four companies, three governments that take his calls, and one thing he could never buy.',
  },
};

/** Used only if a boss ever ships without copy. Says nothing it should not. */
const FALLBACK_TEASE =
  'Something at the end of this one has been waiting a while, and it is not staff.';

// ─────────────────────────────────────────────────────────────────────────────
// The banks
//
// Per theme: place nouns, a landscape clause, and a clause about who is paying
// for the landscape. `openers` and `details` are deliberately different lengths
// and are read with different strides, so the pairs run a long way before they
// repeat.
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeBank {
  places: string[];
  openers: string[];
  details: string[];
}

const BANKS: Record<MapTheme, ThemeBank> = {
  mine: {
    places: ['LITHIUM SEAM', 'ORE LEVEL', 'DRIFT', 'SHAFT', 'SPOIL DECK', 'DEEP CUT'],
    openers: [
      'The rock sweats something that is technically water',
      'Every surface down here is the colour of the inside of a battery',
      'The dust is in your teeth within about four steps',
      'Head-torch light, wet stone, and a draught out of a direction that has no tunnel in it',
      'There is a mountain above you and it has been reclassified as inventory',
      'It smells of hot metal, old rain and other people’s shifts',
    ],
    details: [
      'the safety notice has been laminated twice and updated never',
      'the shift board says nobody has clocked out since March',
      'a compressor is still running for a crew that left years ago',
      'the ore is worth more than the men carrying it and they have all been told so',
      'the emergency phone rings out to a call centre in another hemisphere',
      'the only warm thing down here is the transformer',
      'the lamps are the exact orange of a low-battery warning',
    ],
  },

  forest: {
    places: ['PARCEL', 'FIRE ROAD', 'TREELINE', 'CLEARING', 'LOT', 'PLOT'],
    openers: [
      'Wet bracken, birdsong, and a smell of diesel that arrived on Tuesday',
      'Old trees, deep moss, and survey tape on everything thicker than an arm',
      'It is beautiful in the specific way that is about to be a car park',
      'Mist to the knee, canopy overhead, and a generator running somewhere out of sight',
      'Green light, soft ground, and a chainsaw two valleys over',
      'The forest is exactly as enchanted as it ever was, minus the north end',
    ],
    details: [
      'the planning notice is nailed to an oak and dated for a decision already taken',
      'every third trunk wears a numbered orange ribbon',
      'the deer have learned which way the vans come from',
      'there is a security floodlight strapped to a birch',
      'somebody has tipped hardcore into the stream and called it a bridge',
      'the birds have not been told anything',
      'the fence went up overnight and faces inward',
    ],
  },

  suburb: {
    places: ['CUL-DE-SAC', 'PHASE', 'TEST ROUTE', 'BLOCK', 'ESTATE', 'AVENUE'],
    openers: [
      'Warm evening, cut grass, and a company logo on a lamppost nobody voted for',
      'Two rows of new-build brick and not one person outside on a Saturday',
      'Streetlights, speed bumps, and a school crossing being driven through at test speed',
      'The kind of quiet street that has an app for its residents’ association',
      'Basketball hoop, tidy verge, and a sixty-thousand-dollar truck on every drive',
      'It is pleasant here in the way a brochure is pleasant',
    ],
    details: [
      'the residents’ group chat has been discussing you since the corner',
      'a sprinkler is running on a lawn that turns out to be plastic',
      'the neighbourhood watch sign has a sponsor on it now',
      'every third garage is a distribution depot',
      'the rent here is paid to the same company that pays the wages',
      'a delivery drone has been circling one address for an hour',
      'there is a leaflet about the pilot programme in every letterbox and nobody has read it',
    ],
  },

  tunnel: {
    places: ['BORE', 'LOOP SEGMENT', 'SUBLEVEL', 'SERVICE TUBE', 'PORTAL', 'RING'],
    openers: [
      'Concrete rings, sodium light, and air that has been through a fan for nine miles',
      'Somewhere above this ceiling is a motorway and you can hear it through the slab',
      'Wet cement, cold draught, and one puddle running the entire length of the floor',
      'The lights are on a timer and the timer is losing',
      'It is the width of exactly one car, which was always the plan',
      'A grey throat under a city, lit like a multi-storey at four in the morning',
    ],
    details: [
      'the emergency phone has been unbolted and taken',
      'there is a poster down here advertising the tunnel you are standing in',
      'somebody has painted the distance to the exit and then crossed it out',
      'the extractor is not extracting so much as circulating',
      'the tiling stops halfway along, which is where the money did',
      'every fifth light works and none of them agree on colour',
      'a service door stands open onto nothing at all',
    ],
  },

  factory: {
    places: ['LINE', 'CELL', 'ANNEXE', 'SHOP FLOOR', 'BAY', 'WING'],
    openers: [
      'Strip lights, epoxy floor, and a smell of hot plastic that gets into your clothes',
      'Ninety decibels of extraction and one radio nobody is allowed to switch off',
      'It is either too cold or exactly the temperature of a warm hand, depending on the aisle',
      'Yellow hazard paint, tool shadows on a board, and three empty pegs',
      'Fluorescent, windowless, and running a shift pattern designed by a spreadsheet',
      'Solvent, machine oil, and the sweetish smell of somebody’s lunch reheating',
    ],
    details: [
      'the safety poster is in a language nobody on this shift reads',
      'the accident board was reset to zero this morning',
      'the wellness room is locked and the key is at head office',
      'the vending machine takes a staff card and gives back about sixty percent',
      'somebody has taped over the emergency stop because it kept getting hit',
      'the extractor over the line has been on order since spring',
      'the break area is one bench facing a wall',
    ],
  },

  gigafactory: {
    places: ['BAY', 'ASSEMBLY CELL', 'STATION', 'TORQUE PIT', 'ROW', 'MODULE'],
    openers: [
      'White floor to the horizon, one shade of light, and no windows in the entire building',
      'The arms move at a speed nobody was ever meant to stand next to',
      'Red, white and unpainted metal, going on for most of a kilometre',
      'It is loud in a way that stops sounding like noise after ten minutes',
      'Hot aluminium, ozone, and a floor polished by trolleys rather than by cleaners',
      'A building the size of a town with the personality of a hard drive',
    ],
    details: [
      'the DAYS WITHOUT INCIDENT number has been painted over rather than changed',
      'the line does not stop for anything smaller than a fire',
      'the pick lights say what to do next and everybody has stopped reading them',
      'there is a first-aid station and there is a queue for it',
      'the badge reader logs how long the toilet took',
      'the music is piped in and chosen centrally',
      'half the safety cages came off for throughput',
    ],
  },

  server_farm: {
    places: ['RACK ROW', 'COLD AISLE', 'HALL', 'CAGE', 'COOLING LOOP', 'POD'],
    openers: [
      'Cold aisle, hot aisle, and a hum that goes straight through the sinuses',
      'Nine thousand fans holding one flat chord',
      'It is eighteen degrees in this row and forty in the next',
      'Blue LEDs, raised floor, and air filtered until it tastes of nothing',
      'This building drinks more water in a day than the town it was built beside',
      'Dry, dustless, and lit like an operating table',
      'Two hundred identical doors, each padlocked by a company that is not this one',
      'The floor vibrates very slightly and it does not ever stop',
    ],
    details: [
      'the fire suppression warning is the most honest sign on the wall',
      'somewhere in here is everything anybody ever posted',
      'the badge log shows one engineer, at night, alone',
      'the water bill is a trade secret and the town’s taps are not',
      'a label maker has been used with genuine conviction',
      'the ticket queue on the wall screen has four figures on it',
      'nothing in this room has a name, only a number and a temperature',
      'the diesel tanks outside hold four days of running and are topped up weekly',
    ],
  },

  social_feed: {
    places: ['THREAD', 'REPLY LAYER', 'FEED TIER', 'TRENDING SHELF', 'MENTION PIT', 'QUEUE'],
    openers: [
      'Everything is the blue of a phone screen at three in the morning',
      'A landscape assembled entirely out of other people’s opinions',
      'It is loud, it is bottomless, and it refreshes whether you wanted it to or not',
      'Notification chimes arrive from every direction, slightly out of time with each other',
      'The light is fine, the air is fine, and something here wants your attention very badly',
      'Scenery that scrolls, updating faster than you can walk through it',
    ],
    details: [
      'every surface is somebody being wrong to an audience',
      'the trending list has been the same four words for six hours',
      'an advert for the building you are standing in keeps loading',
      'somebody is quote-posting this from a floor above',
      'the block button was removed as a growth measure',
      'the algorithm has decided that you are interested in this',
      'there is a paid tick on absolutely everything, including the bins',
    ],
  },

  boardroom: {
    places: ['FLOOR', 'SUITE', 'COMMITTEE ROOM', 'ANTEROOM', 'WING', 'CHAMBER'],
    openers: [
      'Deep carpet, gold fittings, and the smell of a room whose windows have never opened',
      'Warm lamps, dark wood, and one painting worth more than the building',
      'It is very quiet in here, and the quiet has been purchased',
      'A long table, sixteen chairs, and a jug of water nobody has touched',
      'Marble, brushed brass, and a lift that only certain cards can call',
      'The kind of room where the carpet cost more than the settlement did',
      'Nobody has raised their voice in this room in twenty years and nobody has needed to',
      'A view over the whole city, three feet of glass, and a temperature set from another building',
    ],
    details: [
      'the minutes will record that nothing was decided',
      'there is a shredder in the corner and it is warm',
      'the ethics board seat has been empty since 2019 and the plaque is still screwed to it',
      'somebody’s counsel has already left a card on the table',
      'the coffee is excellent and the severance is not',
      'every chair is angled at the one at the end',
      'the fine, when it lands, will come to about nine minutes of his income',
      'the artwork is on loan from a foundation named after the man downstairs',
    ],
  },

  launchpad: {
    places: ['PAD', 'FLAME TRENCH', 'TANK FARM', 'RANGE', 'APRON', 'HOLD'],
    openers: [
      'Sea air, floodlights, and concrete resurfaced four times this year',
      'Flat scrub to the horizon, hard wind, and something stainless venting white',
      'It smells of salt, kerosene and money on fire',
      'Klaxons at intervals, a tannoy nobody can parse, and a countdown painted on everything',
      'Cryogenic vapour rolling low across an apron the size of a village',
      'Bright, loud, and hot in a way that has nothing to do with the weather',
    ],
    details: [
      'the road out was closed by public notice at nine this morning',
      'range safety is not answering the phone',
      'the scrub past the fence is full of things that used to be a vehicle',
      'the viewing stand is full of people who signed something first',
      'every warning light is lit and everybody is walking at normal speed',
      'the launch window is whenever he says it is',
      'there is a debris map on the wall and the town is inside the ring',
    ],
  },

  orbit: {
    places: ['SHELL', 'ORBIT PLANE', 'DEBRIS BAND', 'DOCK', 'TRANSFER ARC', 'TIER'],
    openers: [
      'No sound, no weather, and Earth going past underneath at a speed nobody can feel',
      'Hard shadow, hard light, and nothing whatsoever in between them',
      'It is very cold, very bright, and extremely quiet',
      'Handrails, docking targets, and a horizon curving the wrong way',
      'Sunrise every ninety minutes, whether anyone is ready for it or not',
      'The view costs more than most countries and nobody up here looks at it',
    ],
    details: [
      'the constellation goes past in a line, several thousand strong',
      'there is a great deal of somebody’s old hardware out there moving very fast',
      'the air in here is rented',
      'mission control is a group chat',
      'the debris warning has been acknowledged and dismissed',
      'the flag decal is larger than the airlock',
      'everything is bolted down except the people',
    ],
  },

  mars_dome: {
    places: ['DOME', 'HABITAT', 'REGOLITH ROW', 'SECTOR', 'AIRLOCK', 'CRATER'],
    openers: [
      'Butterscotch daylight through the dome panels, grit in every seam, and a sky like a bruise',
      'Thin cold air, iron-red grit, and a horizon far too close to be right',
      'It is silent outside and the silence gets in',
      'Regolith, printed panels, and a floor that nobody is ever going to get clean',
      'The dome creaks through the temperature swing and everyone has learned to ignore it',
      'Rust-coloured everything, lit like a car park on a planet with no cars',
    ],
    details: [
      'the air is a subscription and the invoice is monthly',
      'everybody here owes the company eleven years',
      'the return ticket was never actually offered',
      'the hab numbering runs to forty and eleven of them were ever built',
      'the greenhouse is a poster of a greenhouse',
      'the emergency shelter sign points at something that was cancelled',
      'Earth is the second brightest thing in the sky and nobody mentions it',
    ],
  },
};

/**
 * Joins two clauses when either of them is already a list or already contains
 * an 'and'. A third one turns the sentence into a shopping receipt.
 */
const LIST_JOINERS = [' — ', '; '];
/** Joins a plain clause to its detail. */
const JOINERS = [', and ', ' — ', '; '];

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

/** Integer avalanche hash. Deterministic, and the only source of jitter here. */
function hash(n: number): number {
  let h = (n ^ 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A door number for a place that does not have one.
 *
 * The word cycles with the theme ordinal and the number comes off the map
 * index, then walks upward until it lands on something no other cover claimed.
 * `used` is seeded with the hand-written places first, so nothing generated can
 * collide with 'SHAFT SEVEN'.
 */
function placeFor(words: string[], ord: number, index: number, used: Set<string>): string {
  const word = words[ord % words.length];
  const base = hash(index * 9 + 5) % 46;
  for (let k = 0; k < 46; k++) {
    const s = `${word} ${2 + ((base + k) % 46)}`;
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
  const last = `${word} ${index}`;
  used.add(last);
  return last;
}

/**
 * One landscape clause plus one clause about who owns the landscape.
 *
 * The opener and the detail walk their banks on different strides, but two
 * independent cycles eventually realign — maps 51 and 55 came out sharing both
 * halves and read as the same sentence twice. `usedPairs` makes the
 * combination unique instead of trusting the strides not to meet.
 */
function moodFor(bank: ThemeBank, ord: number, index: number, usedPairs: Set<string>): string {
  const nO = bank.openers.length;
  const nD = bank.details.length;
  let oi = ord % nO;
  let di = (ord * 3) % nD;
  for (let step = 0; step < nO * nD; step++) {
    if (!usedPairs.has(`${oi}|${di}`)) break;
    // Walk the detail first: a fresh tail on a familiar opening still reads as
    // a different place, where a fresh opening on a familiar tail does not.
    di = (di + 1) % nD;
    if (di === (ord * 3) % nD) oi = (oi + 1) % nO;
  }
  usedPairs.add(`${oi}|${di}`);
  const opener = bank.openers[oi];
  const detail = bank.details[di];
  const listy =
    opener.includes(', ') || opener.includes(' and ') || detail.includes(' and ');
  const joiners = listy ? LIST_JOINERS : JOINERS;
  const joiner = joiners[hash(index * 31 + 7) % joiners.length];
  return `${opener}${joiner}${detail}.`;
}

function buildAll(): MapCoverCopy[] {
  const used = new Set<string>();
  for (let i = 1; i <= TOTAL_MAPS; i++) {
    const hand = HAND[i];
    if (hand) used.add(hand.place);
  }

  // Theme ordinals count only the generated maps, so a theme with four
  // hand-written covers still starts its banks at the beginning.
  const ords = new Map<MapTheme, number>();
  /** Opener+detail combinations already spent, per theme. */
  const usedPairs = new Map<MapTheme, Set<string>>();
  const out: MapCoverCopy[] = [];

  for (let i = 1; i <= TOTAL_MAPS; i++) {
    const def = getMap(i);
    const hand = HAND[i];

    let place: string;
    let mood: string;
    if (hand) {
      place = hand.place;
      mood = hand.mood;
    } else {
      const bank = BANKS[def.theme];
      const ord = ords.get(def.theme) ?? 0;
      ords.set(def.theme, ord + 1);
      place = placeFor(bank.places, ord, i, used);
      const pairs = usedPairs.get(def.theme) ?? new Set<string>();
      usedPairs.set(def.theme, pairs);
      mood = moodFor(bank, ord, i, pairs);
    }

    const cover: MapCoverCopy = { place, mood };

    const boss = bossForMap(i);
    if (boss) {
      const copy = BOSS_COPY[boss.id];
      cover.bossTease = copy ? copy.tease : FALLBACK_TEASE;
      cover.bossReveal = copy
        ? copy.reveal
        : `${boss.name} — you have met, and you remember how that went.`;
    }

    out.push(Object.freeze(cover));
  }

  return out;
}

/**
 * All seventy, built once at module load.
 *
 * Frozen and handed out by reference: a gallery that asks for a cover every
 * frame gets the same object every frame and allocates nothing.
 */
const COVERS: MapCoverCopy[] = buildAll();

/**
 * The cover copy for a map, 1..70.
 *
 * Out-of-range indices are clamped rather than thrown, so a save file from a
 * future with more maps in it still opens the gallery.
 */
export function coverCopy(mapIndex: number): MapCoverCopy {
  const i = clamp(Math.round(mapIndex), 1, TOTAL_MAPS);
  return COVERS[i - 1];
}
