/**
 * Seventy maps, from the dwarfs' own mineshaft to the operating theatre.
 *
 * Maps 1–5 are the vertical slice and are hand-authored frame by frame:
 *   1 — movement and light attacks, nothing else on the screen to distract
 *   2 — weapons: props that cough one up, waves that reward one
 *   3 — ranged enemies, so the player learns to close distance and to block
 *   4 — a prop gauntlet and the first vehicle section
 *   5 — the first boss arena
 *
 * Maps 6–70 are generated at module load from a seeded RNG walking the theme
 * list, escalating wave size and enemy mix with depth, hanging a boss on every
 * fifth map and a vehicle section on roughly one map in six or seven — see
 * VEHICLE_RUNS. Every map name is hand-written, because the names are the
 * point. `MAPS` is a plain array of 70 fully-populated MapDefs — no holes, no
 * lazy initialisation, no undefined.
 */

import type {
  EnemyKind,
  MapDef,
  MapPalette,
  MapTheme,
  MusicMood,
  PropSpawn,
  VehicleSection,
  WaveDef,
  WeaponKind,
  Rng,
} from '@/core/types';
import { TOTAL_MAPS, Z_DEPTH } from '@/core/constants';
import { clamp } from '@/core/math';
import { makeRng } from '@/engine/Rng';
import { bossForMap } from '@/content/bosses';

// ─────────────────────────────────────────────────────────────────────────────
// Palettes
// ─────────────────────────────────────────────────────────────────────────────

const PALETTES: Record<MapTheme, MapPalette> = {
  mine: {
    sky: ['#0d0a12', '#1a1420'],
    far: '#1e1826',
    mid: '#2a2032',
    near: '#372a41',
    ground: '#241c2c',
    groundLine: '#4d3c5a',
    fog: 'rgba(12,9,16,0.60)',
    accent: '#ffb347',
    tint: '#c4b6d0',
  },
  forest: {
    sky: ['#0e1a16', '#20402f'],
    far: '#1d3a2c',
    mid: '#28503c',
    near: '#33654c',
    ground: '#1e3227',
    groundLine: '#4a7a56',
    fog: 'rgba(12,24,20,0.45)',
    accent: '#9ee37d',
    tint: '#cfe6cf',
  },
  suburb: {
    sky: ['#1a2340', '#3c4f74'],
    far: '#3a4a68',
    mid: '#4a5c7c',
    near: '#5c6f8e',
    ground: '#38405a',
    groundLine: '#7f8fb0',
    fog: 'rgba(24,32,52,0.42)',
    accent: '#ffd166',
    tint: '#dfe6f2',
  },
  tunnel: {
    sky: ['#141018', '#221a26'],
    far: '#241d2c',
    mid: '#2e2436',
    near: '#3a2d44',
    ground: '#2a2130',
    groundLine: '#4a3c56',
    fog: 'rgba(24,18,28,0.55)',
    accent: '#ff7a3d',
    tint: '#c8b8d8',
  },
  factory: {
    sky: ['#1b1f2a', '#2a3040'],
    far: '#2b3242',
    mid: '#39404f',
    near: '#464e5f',
    ground: '#333a48',
    groundLine: '#5b6577',
    fog: 'rgba(24,28,40,0.50)',
    accent: '#f2c53d',
    tint: '#cfd8e6',
  },
  gigafactory: {
    sky: ['#14161c', '#232833'],
    far: '#252a34',
    mid: '#323844',
    near: '#414957',
    ground: '#2b3038',
    groundLine: '#6b7480',
    fog: 'rgba(18,20,26,0.50)',
    accent: '#e0453a',
    tint: '#d4dae4',
  },
  server_farm: {
    sky: ['#05131a', '#0a2230'],
    far: '#0c2634',
    mid: '#123243',
    near: '#1a4256',
    ground: '#0f2733',
    groundLine: '#1f5f78',
    fog: 'rgba(6,20,28,0.55)',
    accent: '#37e6c8',
    tint: '#bfe8f0',
  },
  social_feed: {
    sky: ['#0b1622', '#14304a'],
    far: '#173a58',
    mid: '#1f4a6e',
    near: '#2a5d86',
    ground: '#12293c',
    groundLine: '#3f86b8',
    fog: 'rgba(10,24,36,0.50)',
    accent: '#4fc3f7',
    tint: '#cfe6f5',
  },
  boardroom: {
    sky: ['#101018', '#1c1c28'],
    far: '#20202e',
    mid: '#2b2b3c',
    near: '#3a3a4e',
    ground: '#26262f',
    groundLine: '#8a7433',
    fog: 'rgba(14,14,20,0.50)',
    accent: '#d9b451',
    tint: '#ded8e8',
  },
  launchpad: {
    sky: ['#1a1020', '#4a2a3a'],
    far: '#33223a',
    mid: '#452e48',
    near: '#573a56',
    ground: '#2b1f30',
    groundLine: '#7a4a5e',
    fog: 'rgba(30,16,26,0.45)',
    accent: '#ff6a4a',
    tint: '#f0d0c8',
  },
  orbit: {
    sky: ['#02030a', '#080d1c'],
    far: '#0a1020',
    mid: '#101a30',
    near: '#182440',
    ground: '#0b1224',
    groundLine: '#3a5a9a',
    fog: 'rgba(2,4,12,0.60)',
    accent: '#8fb8ff',
    tint: '#c8d8f4',
  },
  mars_dome: {
    sky: ['#2a1410', '#6a3020'],
    far: '#5a2a1c',
    mid: '#713924',
    near: '#8a482c',
    ground: '#4a2418',
    groundLine: '#a4603a',
    fog: 'rgba(60,26,16,0.45)',
    accent: '#ffb04a',
    tint: '#f2cfae',
  },
};

/** Alternate signage colours so two maps of one theme never look identical. */
const ACCENTS: Record<MapTheme, string[]> = {
  mine: ['#ffb347', '#ff7a3d', '#c8a63f'],
  forest: ['#9ee37d', '#7ce0a8', '#d8e04a'],
  suburb: ['#ffd166', '#ff8fae', '#8be0c8'],
  tunnel: ['#ff7a3d', '#ff3b30', '#ffd166'],
  factory: ['#f2c53d', '#e0453a', '#6ee4ff'],
  gigafactory: ['#e0453a', '#f2c53d', '#c9d2dc'],
  server_farm: ['#37e6c8', '#57ff9e', '#4fc3f7'],
  social_feed: ['#4fc3f7', '#1d9bf0', '#ff5f8d'],
  boardroom: ['#d9b451', '#c0392b', '#8fb8ff'],
  launchpad: ['#ff6a4a', '#ffb347', '#6ee4ff'],
  orbit: ['#8fb8ff', '#c9a6ff', '#57ff9e'],
  mars_dome: ['#ffb04a', '#ff6a4a', '#ffe6a8'],
};

function paletteFor(theme: MapTheme, rng: Rng): MapPalette {
  const base = PALETTES[theme];
  return {
    sky: [base.sky[0], base.sky[1]],
    far: base.far,
    mid: base.mid,
    near: base.near,
    ground: base.ground,
    groundLine: base.groundLine,
    fog: base.fog,
    accent: rng.pick(ACCENTS[theme]),
    tint: base.tint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The book of names. One line per map, all seventy, in order.
// ─────────────────────────────────────────────────────────────────────────────

interface BookEntry {
  name: string;
  theme: MapTheme;
}

const MAP_BOOK: BookEntry[] = [
  { name: 'Shaft Seven, Now Under New Management', theme: 'mine' },
  { name: 'The Enchanted Forest, Rezoned Light Industrial', theme: 'forest' },
  { name: 'Gated Community, Ungated', theme: 'suburb' },
  { name: 'The Boring Tunnel: Twelve Feet Wide, No Cars', theme: 'tunnel' },
  { name: 'Open-Plan Hell, Floor Four', theme: 'factory' },

  { name: 'The Wellness Room With The Locked Door', theme: 'factory' },
  { name: 'Company Town, Company Rent', theme: 'suburb' },
  { name: 'Loop Station Beta: Mind The Everything', theme: 'tunnel' },
  { name: 'Gigafactory Bay Nine: Safety Third', theme: 'gigafactory' },
  { name: 'The Kennel Of Infinite Value', theme: 'gigafactory' },

  { name: 'The Timeline, Descending', theme: 'social_feed' },
  { name: 'Reply Guy Canyon', theme: 'social_feed' },
  { name: 'Rack Row Twelve: Ninety Decibels Of Nothing', theme: 'server_farm' },
  { name: 'The All-Hands Nobody Attended', theme: 'boardroom' },
  { name: 'Verification Queue, Eternal', theme: 'social_feed' },

  { name: 'Autonomous Test Corridor — Do Not Cross', theme: 'suburb' },
  { name: 'Paint Shop, Ventilation Optional', theme: 'factory' },
  { name: 'Chassis Line, Human Override Disabled', theme: 'gigafactory' },
  { name: 'Parking Level Minus Six', theme: 'tunnel' },
  { name: 'Beta Testing On A Residential Street', theme: 'suburb' },

  { name: 'Dirt, And Debt, And Dirt', theme: 'tunnel' },
  { name: 'Lithium Concession Number One', theme: 'mine' },
  { name: 'The Deep Cut', theme: 'mine' },
  { name: 'Spoil Heap Nine', theme: 'tunnel' },
  { name: 'The Face Of The Drill', theme: 'tunnel' },

  { name: 'Clean Room, Filthy Business', theme: 'factory' },
  { name: 'The Wetware Annexe', theme: 'server_farm' },
  { name: 'Vivarium B', theme: 'factory' },
  { name: 'The Signal Room', theme: 'server_farm' },
  { name: 'Consent Form Withheld', theme: 'factory' },

  { name: 'Compliance, Fourth Floor', theme: 'boardroom' },
  { name: 'The Subpoena Buffet', theme: 'boardroom' },
  { name: 'Legal Discovery, Room Two', theme: 'boardroom' },
  { name: 'Ethics Board (Vacant Since 2019)', theme: 'boardroom' },
  { name: 'The Hearing You Skipped', theme: 'boardroom' },

  { name: 'Rally Field, Ankle Deep', theme: 'suburb' },
  { name: 'The Ballroom Of Gold Paint', theme: 'boardroom' },
  { name: 'All-Caps Country', theme: 'social_feed' },
  { name: 'Motorcade, Stationary', theme: 'suburb' },
  { name: 'The Resolute Knockoff', theme: 'boardroom' },

  { name: 'Assembly Cell 44: No Humans Beyond', theme: 'gigafactory' },
  { name: 'The Torque Test Pit', theme: 'gigafactory' },
  { name: 'Actuator Wing', theme: 'factory' },
  { name: 'The Dance Floor Demo', theme: 'gigafactory' },
  { name: 'Unit Storage, Row A', theme: 'gigafactory' },

  { name: 'Training Run Nine Thousand', theme: 'server_farm' },
  { name: 'The Alignment Closet', theme: 'server_farm' },
  { name: 'Prompt Injection Alley', theme: 'social_feed' },
  { name: 'Cooling Loop Gamma', theme: 'server_farm' },
  { name: 'The Model Weights Vault', theme: 'server_farm' },

  { name: 'Pad Thirty-Nine Adjacent', theme: 'launchpad' },
  { name: 'Static Fire, Everyone Fine', theme: 'launchpad' },
  { name: 'Range Safety Overruled', theme: 'launchpad' },
  { name: 'The Debris Field They Called A Success', theme: 'launchpad' },
  { name: 'T-Minus Nothing', theme: 'launchpad' },

  { name: 'Low Orbit, High Ego', theme: 'orbit' },
  { name: 'Constellation Traffic', theme: 'orbit' },
  { name: 'The Junk Belt', theme: 'orbit' },
  { name: 'Transfer Burn', theme: 'orbit' },
  { name: 'Colony One: Terms And Conditions Apply', theme: 'mars_dome' },

  { name: 'Regolith Row', theme: 'mars_dome' },
  { name: 'The Oxygen Subscription', theme: 'mars_dome' },
  { name: 'Habitat Four, Depressurised', theme: 'mars_dome' },
  { name: 'The Fabrication Vault', theme: 'mars_dome' },
  { name: 'The Assembly Cradle', theme: 'mars_dome' },

  { name: 'Executive Descent', theme: 'boardroom' },
  { name: 'The Backup Of Her', theme: 'server_farm' },
  { name: 'The Coronation Rehearsal', theme: 'boardroom' },
  { name: 'The Private Elevator', theme: 'orbit' },
  { name: 'The Operating Theatre', theme: 'boardroom' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Generation tables
// ─────────────────────────────────────────────────────────────────────────────

/** Nothing appears before its map. This is the difficulty curve, in one table. */
const UNLOCKS: { kind: EnemyKind; from: number }[] = [
  { kind: 'suit_guard', from: 1 },
  { kind: 'intern', from: 2 },
  { kind: 'taser_guard', from: 3 },
  { kind: 'gunman', from: 3 },
  { kind: 'vacuum_bot', from: 6 },
  { kind: 'riot_guard', from: 8 },
  { kind: 'delivery_drone', from: 11 },
  { kind: 'lobbyist', from: 14 },
  { kind: 'iot_speaker', from: 17 },
  { kind: 'security_bot', from: 20 },
  { kind: 'iot_fridge', from: 24 },
];

/**
 * Threat cost per body. A wave budget is spent in these, not in headcount, so
 * six interns and two riot guards are the same amount of trouble.
 */
const COST: Record<EnemyKind, number> = {
  intern: 0.6,
  vacuum_bot: 0.7,
  suit_guard: 1.0,
  delivery_drone: 1.0,
  taser_guard: 1.2,
  gunman: 1.4,
  lobbyist: 1.5,
  iot_speaker: 1.6,
  riot_guard: 2.0,
  security_bot: 2.4,
  iot_fridge: 3.2,
};

/** Hard ceiling regardless of budget — four gunmen is already unreasonable. */
const MAX_PER_WAVE: Record<EnemyKind, number> = {
  intern: 8,
  vacuum_bot: 7,
  suit_guard: 8,
  delivery_drone: 6,
  taser_guard: 5,
  gunman: 4,
  lobbyist: 5,
  iot_speaker: 3,
  riot_guard: 4,
  security_bot: 4,
  iot_fridge: 2,
};

/** Extra weight so a server farm feels like a server farm. */
const THEME_FAVOURITES: Record<MapTheme, EnemyKind[]> = {
  mine: ['suit_guard', 'security_bot'],
  forest: ['suit_guard', 'delivery_drone'],
  suburb: ['suit_guard', 'vacuum_bot', 'delivery_drone'],
  tunnel: ['security_bot', 'riot_guard'],
  factory: ['security_bot', 'intern', 'riot_guard'],
  gigafactory: ['security_bot', 'intern', 'iot_fridge'],
  server_farm: ['iot_speaker', 'security_bot', 'intern'],
  social_feed: ['intern', 'lobbyist', 'iot_speaker'],
  boardroom: ['lobbyist', 'suit_guard', 'gunman'],
  launchpad: ['riot_guard', 'gunman', 'delivery_drone'],
  orbit: ['delivery_drone', 'security_bot', 'iot_speaker'],
  mars_dome: ['riot_guard', 'gunman', 'iot_fridge'],
};

const THEME_PROPS: Record<MapTheme, PropSpawn['kind'][]> = {
  mine: ['crate', 'barrel', 'sign'],
  forest: ['crate', 'barrel', 'sign'],
  suburb: ['scooter', 'vending', 'sign', 'crate'],
  tunnel: ['barrel', 'crate', 'sign', 'scooter'],
  factory: ['barrel', 'crate', 'vending'],
  gigafactory: ['crate', 'barrel', 'server_rack'],
  server_farm: ['server_rack', 'crate', 'vending'],
  social_feed: ['sign', 'vending', 'server_rack'],
  boardroom: ['vending', 'sign', 'crate'],
  launchpad: ['barrel', 'crate', 'sign'],
  orbit: ['crate', 'server_rack', 'barrel'],
  mars_dome: ['crate', 'barrel', 'vending', 'sign'],
};

const THEME_WEAPONS: Record<MapTheme, WeaponKind[]> = {
  // The whip is deliberately absent from every one of these. It is the one
  // weapon you cannot find: it belongs to the dwarf who brought it, and picking
  // his fighter is the only way to hold it.
  mine: ['pipe', 'ironbar', 'bat', 'dagger'],
  forest: ['bat', 'chain', 'dagger'],
  suburb: ['bat', 'chain', 'taser'],
  tunnel: ['ironbar', 'pipe', 'chain', 'dagger'],
  factory: ['ironbar', 'pipe', 'riotshield'],
  gigafactory: ['cybertruck_door', 'ironbar', 'riotshield'],
  server_farm: ['gpu', 'keyboard', 'pipe'],
  social_feed: ['keyboard', 'gpu', 'chain'],
  boardroom: ['pistol', 'taser', 'keyboard'],
  launchpad: ['ironbar', 'pistol', 'riotshield'],
  orbit: ['gpu', 'pipe', 'taser'],
  mars_dome: ['cybertruck_door', 'pistol', 'ironbar'],
};

/**
 * Where the campaign puts you on something with an engine.
 *
 * Roughly one map in six or seven — often enough that the player learns to hope
 * for it, rare enough that it stays a treat rather than a traversal mechanic.
 * Never on a boss map: the boss is that map's event, and nobody should arrive at
 * one still holding a throttle.
 *
 * The kind is chosen per map rather than per theme, because the map is a joke
 * with a name and the vehicle is its punchline — a pod belongs in the tunnel
 * that was sold as a hyperloop, a rocket belongs in the debris field they called
 * a success. Map 4 is absent from this table on purpose: its bike is
 * hand-authored above, and it is the one the player meets first.
 */
const VEHICLE_RUNS: Record<number, VehicleSection['kind']> = {
  8: 'hyperloop_pod', // Loop Station Beta — the tube it kept promising
  14: 'cybertruck', // straight through the all-hands nobody attended
  21: 'hyperloop_pod', // Dirt, And Debt, And Dirt: the boring machine's own line
  28: 'moto', // Vivarium B — a factory floor with nothing on it but staff
  36: 'cybertruck', // the rally field, ankle deep, motorcade-style
  43: 'moto', // Actuator Wing, taken at speed
  49: 'hyperloop_pod', // Cooling Loop Gamma: a pod in a pipe by another name
  54: 'rocket', // the debris field they called a success
  61: 'cybertruck', // Regolith Row, the only road on Mars
  69: 'rocket', // the private elevator, going up
};

const THEME_DEPTH: Record<MapTheme, number> = {
  mine: Z_DEPTH * 0.82,
  forest: Z_DEPTH,
  suburb: Z_DEPTH,
  tunnel: Z_DEPTH * 0.72,
  factory: Z_DEPTH * 0.95,
  gigafactory: Z_DEPTH,
  server_farm: Z_DEPTH * 0.86,
  social_feed: Z_DEPTH,
  boardroom: Z_DEPTH * 0.9,
  launchpad: Z_DEPTH,
  orbit: Z_DEPTH * 0.88,
  mars_dome: Z_DEPTH,
};

function poolFor(index: number, theme: MapTheme): EnemyKind[] {
  const pool: EnemyKind[] = [];
  for (const u of UNLOCKS) {
    if (index < u.from) continue;
    pool.push(u.kind);
    // Recently unlocked kinds get shown off; theme favourites get doubled up.
    if (index < u.from + 4) pool.push(u.kind);
    if (THEME_FAVOURITES[theme].includes(u.kind)) pool.push(u.kind, u.kind);
  }
  if (pool.length === 0) pool.push('suit_guard');
  return pool;
}

function musicFor(index: number): MusicMood {
  if (index <= 20) return 'fight_low';
  if (index <= 45) return index % 3 === 0 ? 'fight_high' : 'fight_low';
  return 'fight_high';
}

function makeWaves(index: number, theme: MapTheme, rng: Rng, hasBoss: boolean): WaveDef[] {
  const pool = poolFor(index, theme);
  const weapons = THEME_WEAPONS[theme];
  // Boss maps run short so the fight itself is the meat of the level.
  const count = hasBoss ? (index >= 40 ? 3 : 2) : clamp(2 + Math.floor(index / 16), 2, 5);
  const budget = clamp(3 + Math.floor(index / 7), 3, 10);
  const span = hasBoss ? 0.62 : 0.74;
  const waves: WaveDef[] = [];

  for (let w = 0; w < count; w++) {
    const at = 0.16 + (count === 1 ? 0 : (w * span) / (count - 1));
    const total = budget + w + rng.int(0, 2);
    const kindCount = clamp(
      1 + (index > 6 ? 1 : 0) + (index > 20 ? 1 : 0) + rng.int(0, 1),
      1,
      3,
    );

    const chosen: EnemyKind[] = [];
    for (let attempt = 0; attempt < kindCount * 4 && chosen.length < kindCount; attempt++) {
      const pick = rng.pick(pool);
      if (!chosen.includes(pick)) chosen.push(pick);
    }
    if (chosen.length === 0) chosen.push('suit_guard');

    // The budget is spent in threat points, not bodies, so a wave of fridges is
    // three fridges and a wave of interns is a mob.
    const enemies: { kind: EnemyKind; count: number }[] = [];
    let left = total;
    for (let k = 0; k < chosen.length; k++) {
      const kind = chosen[k];
      const last = k === chosen.length - 1;
      const share = last ? left : (total / chosen.length) * rng.range(0.8, 1.25);
      const n = clamp(Math.round(share / COST[kind]), 1, MAX_PER_WAVE[kind]);
      enemies.push({ kind, count: n });
      left -= n * COST[kind];
      if (left <= 0.75) break;
    }

    const wave: WaveDef = { enemies, at: Math.min(at, 0.9) };
    if (w % 2 === 1) {
      wave.reward = { weapon: rng.pick(weapons) };
    } else if (w > 0) {
      wave.reward = { health: 20 + rng.int(0, 3) * 5, meter: 0.25 };
    }
    waves.push(wave);
  }

  return waves;
}

function makeProps(index: number, theme: MapTheme, width: number, depth: number, rng: Rng): PropSpawn[] {
  const kinds = THEME_PROPS[theme];
  const weapons = THEME_WEAPONS[theme];
  const n = 2 + rng.int(0, 3);
  const props: PropSpawn[] = [];
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(kinds);
    const x = Math.round(width * (0.12 + (0.76 * (i + rng.next())) / n));
    const z = Math.round(rng.range(10, Math.max(14, depth - 10)));
    const prop: PropSpawn = {
      kind,
      x,
      z,
      health: kind === 'server_rack' ? 40 : kind === 'vending' ? 34 : 22,
    };
    if (rng.chance(0.45)) {
      prop.drop = { weapon: rng.pick(weapons) };
    } else if (rng.chance(0.6)) {
      prop.drop = { health: 15 + rng.int(0, 2) * 10 };
    }
    props.push(prop);
  }
  return props;
}

/** Two decimals, so the shipped data reads like something a person wrote. */
function hundredths(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Where inside the map the ride sits.
 *
 * It opens a clear stretch after the first wave, so the player has met the level
 * on foot and knows what they are about to go past at speed, and it closes well
 * before the last one, so the map finishes the way every other map finishes:
 * standing up, with your hands. Boss maps are excluded by the caller rather than
 * squeezed in here, because a section short enough to clear a boss arena is not
 * worth mounting.
 *
 * Deterministic: the jitter comes from the map's own seeded rng, drawn after
 * everything else the map needs, so hanging a vehicle on a map cannot shift its
 * palette, waves or props.
 */
function vehicleSpan(kind: VehicleSection['kind'], waves: WaveDef[], rng: Rng): VehicleSection {
  const first = waves.length > 0 ? waves[0].at : 0.16;
  const last = waves.length > 0 ? waves[waves.length - 1].at : 0.9;

  const from = clamp(first + rng.range(0.12, 0.2), 0.26, 0.46);
  // The latest it may end, and never so late that dismounting lands on the
  // closing wave. The max() keeps the stretch non-empty whatever the waves do.
  const latest = Math.max(from + 0.22, Math.min(0.82, last - 0.08));
  const to = Math.min(from + rng.range(0.28, 0.4), latest);

  return { kind, from: hundredths(from), to: hundredths(to) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Maps 1–5, hand-authored
// ─────────────────────────────────────────────────────────────────────────────

function handMade(index: number): MapDef | null {
  const book = MAP_BOOK[index - 1];
  const rng = seedFor(index);

  switch (index) {
    // 1 — MOVEMENT AND LIGHT ATTACKS.
    // Nothing on the floor to pick up, one enemy type, wide gaps between waves
    // so the player has room to walk about and discover that z exists.
    case 1:
      return {
        index: 1,
        name: book.name,
        theme: book.theme,
        width: 1400,
        depth: THEME_DEPTH.mine,
        waves: [
          // One man, so the first fight of the game is a lesson and not an
          // ambush. It grows from there, and Level scales it again by party.
          { enemies: [{ kind: 'suit_guard', count: 1 }], at: 0.2 },
          { enemies: [{ kind: 'suit_guard', count: 2 }], at: 0.54, reward: { health: 25 } },
          { enemies: [{ kind: 'suit_guard', count: 3 }], at: 0.86, reward: { meter: 0.5 } },
        ],
        palette: paletteFor('mine', rng),
        props: [
          { kind: 'crate', x: 380, z: 26, health: 20, drop: { health: 15 } },
          { kind: 'barrel', x: 900, z: 66, health: 22, drop: { health: 20 } },
          { kind: 'sign', x: 1210, z: 80, health: 12 },
        ],
        music: 'fight_low',
      };

    // 2 — WEAPONS.
    // Every prop coughs one up, both wave rewards are weapons, and the interns
    // arrive carrying keyboards so the player sees a weapon get dropped by a
    // corpse before being asked to use one.
    case 2:
      return {
        index: 2,
        name: book.name,
        theme: book.theme,
        width: 1560,
        depth: THEME_DEPTH.forest,
        waves: [
          {
            enemies: [{ kind: 'suit_guard', count: 3 }],
            at: 0.18,
            reward: { weapon: 'pipe' },
          },
          {
            enemies: [
              { kind: 'intern', count: 3 },
              { kind: 'suit_guard', count: 2 },
            ],
            at: 0.55,
            reward: { weapon: 'bat' },
          },
          {
            enemies: [
              { kind: 'suit_guard', count: 3 },
              { kind: 'intern', count: 2 },
            ],
            at: 0.88,
            reward: { health: 30, meter: 0.5 },
          },
        ],
        palette: paletteFor('forest', rng),
        props: [
          { kind: 'crate', x: 300, z: 22, health: 20, drop: { weapon: 'pipe' } },
          { kind: 'barrel', x: 660, z: 74, health: 22, drop: { weapon: 'chain' } },
          { kind: 'crate', x: 1020, z: 40, health: 20, drop: { health: 25 } },
          { kind: 'sign', x: 1330, z: 88, health: 12, drop: { weapon: 'bat' } },
        ],
        music: 'fight_low',
      };

    // 3 — RANGED.
    // A gunman parked at the far end of the first wave so the player eats one
    // bullet, finds the block button, and learns to close. Riot shield reward
    // makes the lesson explicit.
    case 3:
      return {
        index: 3,
        name: book.name,
        theme: book.theme,
        width: 1700,
        depth: THEME_DEPTH.suburb,
        waves: [
          {
            enemies: [
              { kind: 'suit_guard', count: 2 },
              { kind: 'gunman', count: 1 },
            ],
            at: 0.16,
            reward: { weapon: 'riotshield' },
          },
          {
            enemies: [
              { kind: 'taser_guard', count: 2 },
              { kind: 'intern', count: 2 },
            ],
            at: 0.46,
            reward: { health: 30 },
          },
          {
            enemies: [
              { kind: 'gunman', count: 2 },
              { kind: 'suit_guard', count: 3 },
            ],
            at: 0.72,
            reward: { weapon: 'taser' },
          },
          {
            enemies: [
              { kind: 'suit_guard', count: 3 },
              { kind: 'taser_guard', count: 2 },
              { kind: 'gunman', count: 1 },
            ],
            at: 0.9,
            reward: { health: 35, meter: 0.5 },
          },
        ],
        palette: paletteFor('suburb', rng),
        props: [
          { kind: 'scooter', x: 420, z: 30, health: 18, drop: { weapon: 'pipe' } },
          { kind: 'vending', x: 880, z: 84, health: 34, drop: { health: 35 } },
          { kind: 'sign', x: 1180, z: 20, health: 12 },
          { kind: 'crate', x: 1480, z: 62, health: 20, drop: { weapon: 'bat' } },
        ],
        music: 'fight_low',
      };

    // 4 — THE GAUNTLET.
    // Nine breakables in a row, then the tunnel opens out and the player is put
    // on a bike for the middle third of the map.
    case 4:
      return {
        index: 4,
        name: book.name,
        theme: book.theme,
        width: 2100,
        depth: THEME_DEPTH.tunnel,
        waves: [
          {
            enemies: [
              { kind: 'suit_guard', count: 3 },
              { kind: 'intern', count: 2 },
            ],
            at: 0.14,
            reward: { weapon: 'ironbar' },
          },
          {
            enemies: [
              { kind: 'taser_guard', count: 2 },
              { kind: 'suit_guard', count: 2 },
            ],
            at: 0.3,
            reward: { health: 30 },
          },
          {
            enemies: [
              { kind: 'gunman', count: 2 },
              { kind: 'taser_guard', count: 2 },
              { kind: 'intern', count: 3 },
            ],
            at: 0.78,
            reward: { weapon: 'chain' },
          },
          {
            enemies: [
              { kind: 'suit_guard', count: 4 },
              { kind: 'gunman', count: 2 },
            ],
            at: 0.92,
            reward: { health: 40, meter: 1 },
          },
        ],
        palette: paletteFor('tunnel', rng),
        props: [
          { kind: 'barrel', x: 240, z: 24, health: 22, drop: { health: 15 } },
          { kind: 'barrel', x: 330, z: 48, health: 22, drop: { weapon: 'pipe' } },
          { kind: 'crate', x: 420, z: 16, health: 20, drop: { health: 20 } },
          { kind: 'crate', x: 505, z: 62, health: 20, drop: { weapon: 'ironbar' } },
          { kind: 'barrel', x: 590, z: 34, health: 22, drop: { health: 15 } },
          { kind: 'crate', x: 675, z: 70, health: 20, drop: { weapon: 'bat' } },
          { kind: 'scooter', x: 760, z: 28, health: 18, drop: { health: 25 } },
          { kind: 'sign', x: 1720, z: 58, health: 12, drop: { weapon: 'chain' } },
          { kind: 'barrel', x: 1900, z: 40, health: 22, drop: { health: 30 } },
        ],
        vehicle: { kind: 'moto', from: 0.34, to: 0.7 },
        music: 'fight_low',
      };

    // 5 — FIRST BOSS.
    // Two short waves to warm the hands up, then a long empty run of floor that
    // reads as an arena, then CRUNCH.
    case 5:
      return {
        index: 5,
        name: book.name,
        theme: book.theme,
        width: 1900,
        depth: THEME_DEPTH.factory,
        waves: [
          {
            enemies: [
              { kind: 'intern', count: 4 },
              { kind: 'suit_guard', count: 2 },
            ],
            at: 0.18,
            reward: { weapon: 'ironbar' },
          },
          {
            enemies: [
              { kind: 'suit_guard', count: 3 },
              { kind: 'taser_guard', count: 2 },
              { kind: 'gunman', count: 1 },
            ],
            at: 0.5,
            reward: { health: 45, meter: 1 },
          },
        ],
        boss: 'dev',
        palette: paletteFor('factory', rng),
        props: [
          { kind: 'vending', x: 520, z: 82, health: 34, drop: { health: 35 } },
          { kind: 'barrel', x: 860, z: 30, health: 22, drop: { weapon: 'pipe' } },
          { kind: 'crate', x: 1120, z: 56, health: 20, drop: { weapon: 'keyboard' } },
        ],
        music: 'fight_low',
      };

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

function seedFor(index: number): Rng {
  // Deterministic per map, and far enough apart that neighbouring maps do not
  // come out looking like siblings.
  return makeRng((index * 0x9e3779b1) ^ 0x4d5f7a21);
}

function generated(index: number): MapDef {
  const book = MAP_BOOK[index - 1];
  const theme = book.theme;
  const rng = seedFor(index);
  const boss = bossForMap(index);
  const hasBoss = boss !== null;

  const width = 1500 + Math.min(index, 48) * 22 + (hasBoss ? 280 : 0) + rng.int(0, 6) * 20;
  const depth = THEME_DEPTH[theme];

  const def: MapDef = {
    index,
    name: book.name,
    theme,
    width,
    depth,
    waves: makeWaves(index, theme, rng, hasBoss),
    palette: paletteFor(theme, rng),
    props: makeProps(index, theme, width, depth, rng),
    music: musicFor(index),
  };

  if (boss) def.boss = boss.id;

  // The vehicle stretch, on the campaign cadence in VEHICLE_RUNS. Guarded on the
  // boss again rather than trusting the table, so moving a boss can only cost a
  // map its ride, never drop one into a boss arena.
  const ride = VEHICLE_RUNS[index];
  if (ride && !hasBoss) def.vehicle = vehicleSpan(ride, def.waves, rng);

  return def;
}

function buildAll(): MapDef[] {
  const out: MapDef[] = [];
  for (let i = 1; i <= TOTAL_MAPS; i++) {
    out.push(handMade(i) ?? generated(i));
  }
  return out;
}

export const MAPS: MapDef[] = buildAll();

export function getMap(index: number): MapDef {
  const i = clamp(Math.round(index), 1, TOTAL_MAPS);
  return MAPS[i - 1];
}
