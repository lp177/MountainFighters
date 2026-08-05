/**
 * The roster. Seven dwarfs, seven grudges, seven very different ways of
 * ruining a security guard's evening.
 *
 * Each one keeps the hat colour he had in 1937 — that is the whole joke of the
 * select-screen transformation. `style.outfit` starts at 0 (tunic, cap, no
 * shades) and the SelectScene tweens it to 1 while the rig plays the dressing
 * clips. Everything else about the palette is allowed to get nasty.
 *
 * Move id convention:
 *   the ground normals are bespoke per dwarf — `<id>_light` / `<id>_heavy` —
 *   so no two of them throw the same punch;
 *   `air_light`, `air_heavy`, `grab` and `dash_attack` stay shared;
 *   the one bespoke per-dwarf entry beyond the normals is the special,
 *   `sp_<gimmick>`.
 * The activatable ultimate is NOT a move id; it lives in `super` and is drawn
 * by the bespoke renderer named in `super.visual`.
 */

import type { DwarfDef } from '@/core/types';

const AIR_L = 'air_light';
const AIR_H = 'air_heavy';
const GRAB = 'grab';
const DASH = 'dash_attack';

export const DWARFS: DwarfDef[] = [
  // ── Doc ────────────────────────────────────────────────────────────────────
  {
    id: 'doc',
    name: 'SAWBONES',
    bornAs: 'Doc',
    tagline: 'He read the terms of service. All of them.',
    bio:
      'Mining engineer, four doctorates nobody paid for, and the only dwarf in the ' +
      'house who can spell "indemnity". He does the arithmetic on exactly how much ' +
      'of a man can be removed before the man stops working, then removes slightly more.',
    stats: { health: 104, speed: 1.0, jump: 1.0, power: 1.0, tech: 1.4 },
    style: {
      scale: 1.0,
      girth: 1.0,
      headSize: 1.06,
      beardLength: 1.0,
      beardStyle: 'bushy',
      skin: '#e8b48c',
      skinShade: '#c48a63',
      hair: '#efe6dc',
      hatColor: '#c8a63f',
      tunicColor: '#5f7a3c',
      jacketColor: '#241f2a',
      jacketAccent: '#c8a63f',
      spikes: 4,
      shades: true,
      outfit: 0,
      tattoo: 'barcode',
      cigar: false,
    },
    moves: {
      light: 'doc_light',
      heavy: 'doc_heavy',
      special: 'sp_doc',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_doc',
      name: 'THE LONG EXPLANATION',
      description:
        'Deploys a forty-slide deck on load-bearing human anatomy. Nobody in the ' +
        'room is permitted to leave and nobody survives slide nine.',
      duration: 190,
      damage: 34,
      radius: -1,
      visual: 'doc_lecture',
      sfx: 'super_blast',
    },
    signatureWeapon: 'keyboard',
    voice: { pitch: 152, timbre: 'nasal', wobble: 0.07 },
  },

  // ── Grumpy ─────────────────────────────────────────────────────────────────
  {
    id: 'grumpy',
    name: 'MALICE',
    bornAs: 'Grumpy',
    tagline: 'Hates you. Specifically you. By name.',
    bio:
      'Woke up furious in 1937 and has not once put it down. Moves like a landslide ' +
      'and negotiates like one. Do not ask him how his day is going — he will tell ' +
      'you in full, with the bar, for as long as your skull holds out.',
    stats: { health: 132, speed: 0.8, jump: 0.86, power: 1.45, tech: 0.78 },
    style: {
      scale: 1.06,
      girth: 1.18,
      headSize: 1.0,
      beardLength: 1.15,
      beardStyle: 'forked',
      skin: '#dfa079',
      skinShade: '#b57451',
      hair: '#d8cfc6',
      hatColor: '#a83a2c',
      tunicColor: '#8a5a2e',
      jacketColor: '#191419',
      jacketAccent: '#a83a2c',
      spikes: 9,
      shades: true,
      outfit: 0,
      tattoo: 'skull',
      cigar: true,
    },
    moves: {
      light: 'grumpy_light',
      heavy: 'grumpy_heavy',
      special: 'sp_grump',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_grumpy',
      name: 'TANTRUM',
      description:
        'Stamps once. The floor takes it personally, and so does everyone standing ' +
        'on the floor, and so does the building.',
      duration: 150,
      damage: 44,
      radius: 170,
      visual: 'grump_quake',
      sfx: 'explosion',
    },
    signatureWeapon: 'ironbar',
    voice: { pitch: 90, timbre: 'gruff', wobble: 0.03 },
  },

  // ── Happy ──────────────────────────────────────────────────────────────────
  {
    id: 'happy',
    name: 'RIOT',
    bornAs: 'Happy',
    tagline: 'Laughing the whole way through your ribcage.',
    bio:
      'Grins wider the worse things get, which is why nobody will stand next to him ' +
      'in a lift. Fights in flurries, apologises never, and has been barred from ' +
      'every pub between here and the coast for being too cheerful about the damage.',
    stats: { health: 94, speed: 1.32, jump: 1.12, power: 0.86, tech: 1.18 },
    style: {
      scale: 0.98,
      girth: 1.12,
      headSize: 1.04,
      beardLength: 0.85,
      beardStyle: 'bushy',
      skin: '#f0bb92',
      skinShade: '#c8906a',
      hair: '#f4ece2',
      hatColor: '#7b4a26',
      tunicColor: '#d8a33a',
      jacketColor: '#22181f',
      jacketAccent: '#ff5f8d',
      spikes: 5,
      shades: true,
      outfit: 0,
      tattoo: 'heart',
      cigar: false,
    },
    moves: {
      light: 'happy_light',
      heavy: 'happy_heavy',
      special: 'sp_happy',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_happy',
      name: 'LAST DANCE',
      description:
        'Kicks the lights on. Everyone in the room is contractually obliged to ' +
        'dance and structurally unable to survive the chorus.',
      duration: 200,
      damage: 30,
      radius: -1,
      visual: 'happy_disco_inferno',
      sfx: 'laugh',
    },
    signatureWeapon: 'chain',
    voice: { pitch: 176, timbre: 'deep', wobble: 0.11 },
  },

  // ── Sleepy ─────────────────────────────────────────────────────────────────
  {
    id: 'sleepy',
    name: 'COMA',
    bornAs: 'Sleepy',
    tagline: 'Wakes up for two things. This is the second one.',
    bio:
      'Two hundred kilos of dwarf running on nine hours a night and one very old ' +
      'grudge. Takes a decade to wind up and exactly one connection to end the ' +
      'conversation. He has slept through three of these boss fights already.',
    stats: { health: 140, speed: 0.72, jump: 0.8, power: 1.36, tech: 0.64 },
    style: {
      scale: 1.08,
      girth: 1.24,
      headSize: 0.98,
      beardLength: 1.25,
      beardStyle: 'long',
      skin: '#d9a483',
      skinShade: '#ad7554',
      hair: '#cfc6bd',
      hatColor: '#a58a4e',
      tunicColor: '#4a6e4e',
      jacketColor: '#1c1c24',
      jacketAccent: '#6f8fbd',
      spikes: 3,
      shades: true,
      outfit: 0,
      tattoo: 'anchor',
      cigar: false,
    },
    moves: {
      light: 'sleepy_light',
      heavy: 'sleepy_heavy',
      special: 'sp_snore',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_sleepy',
      name: 'NIGHT TERROR',
      description:
        'Falls asleep mid-fight and drags the entire room into the dream with him. ' +
        'What is in there is his business. What comes out is a lot of unconscious guards.',
      duration: 210,
      damage: 46,
      radius: -1,
      visual: 'sleep_dream_crush',
      sfx: 'snore',
    },
    signatureWeapon: 'cybertruck_door',
    voice: { pitch: 96, timbre: 'wheeze', wobble: 0.05 },
  },

  // ── Bashful ────────────────────────────────────────────────────────────────
  {
    id: 'bashful',
    name: 'BASH',
    bornAs: 'Bashful',
    tagline: 'Cannot look you in the eye. Can look you in the teeth.',
    bio:
      'Goes scarlet when spoken to and counters when touched. Holds a riot shield ' +
      'like a comfort blanket and hands back everything you send him with interest, ' +
      'a broken nose, and a mumbled apology you will hear about in physio.',
    stats: { health: 120, speed: 0.92, jump: 0.96, power: 1.02, tech: 1.12 },
    style: {
      scale: 1.0,
      girth: 1.08,
      headSize: 1.02,
      beardLength: 0.9,
      beardStyle: 'braided',
      skin: '#f2b79a',
      skinShade: '#cb8467',
      hair: '#e6d6c4',
      hatColor: '#4a8a45',
      tunicColor: '#c25a2e',
      jacketColor: '#1e2226',
      jacketAccent: '#ff8fae',
      spikes: 6,
      shades: true,
      outfit: 0,
      tattoo: 'heart',
      cigar: false,
    },
    moves: {
      light: 'bashful_light',
      heavy: 'bashful_heavy',
      special: 'sp_bashful',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_bashful',
      name: 'MORTIFIED',
      description:
        'Somebody says something nice to him in front of everyone. The resulting ' +
        'blush reaches critical mass and takes out the room, the mezzanine, and a van outside.',
      duration: 160,
      damage: 36,
      radius: 200,
      visual: 'bashful_blush_nova',
      sfx: 'super_blast',
    },
    signatureWeapon: 'riotshield',
    voice: { pitch: 188, timbre: 'squeak', wobble: 0.14 },
  },

  // ── Sneezy ─────────────────────────────────────────────────────────────────
  {
    id: 'sneezy',
    name: 'PATIENT ZERO',
    bornAs: 'Sneezy',
    tagline: 'Airborne, untreatable, and about to clear the room.',
    bio:
      'A walking notifiable public health incident. Fights at range because nothing ' +
      'survives being close. Two sneezes take a security door off its hinges; the ' +
      'third one is just showing off and he knows it.',
    stats: { health: 88, speed: 1.06, jump: 1.06, power: 0.92, tech: 1.06 },
    style: {
      scale: 0.96,
      girth: 0.94,
      headSize: 1.1,
      beardLength: 0.8,
      beardStyle: 'stubble',
      skin: '#eec0a4',
      skinShade: '#c28d70',
      hair: '#e2d2c0',
      hatColor: '#d0742e',
      tunicColor: '#6f7fa0',
      jacketColor: '#20232c',
      jacketAccent: '#7ce0a8',
      spikes: 4,
      shades: true,
      outfit: 0,
      tattoo: 'barcode',
      cigar: false,
    },
    moves: {
      light: 'sneezy_light',
      heavy: 'sneezy_heavy',
      special: 'sp_sneeze',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_sneezy',
      name: 'AAAA-CHOO',
      description:
        'The big one. He has been holding it since map one. Everything not bolted ' +
        'to the floor leaves the building, and some of what is bolted down goes too.',
      duration: 140,
      damage: 38,
      radius: -1,
      visual: 'sneeze_shockwave',
      sfx: 'sneeze',
    },
    signatureWeapon: 'pistol',
    voice: { pitch: 164, timbre: 'nasal', wobble: 0.16 },
  },

  // ── Dopey ──────────────────────────────────────────────────────────────────
  {
    id: 'dopey',
    name: 'SILENT D',
    bornAs: 'Dopey',
    tagline: 'Says nothing. Means every word of it.',
    bio:
      'Has never spoken and has never lost a fight whose rules he understood. Moves ' +
      'like a dropped firework — fast, low, and going somewhere nobody predicted, ' +
      'least of all him. The hat is three sizes too big and he will not discuss it.',
    stats: { health: 84, speed: 1.46, jump: 1.26, power: 0.8, tech: 1.22 },
    style: {
      scale: 0.9,
      girth: 0.9,
      headSize: 1.14,
      beardLength: 0.0,
      beardStyle: 'none',
      skin: '#f4c4a2',
      skinShade: '#cd9070',
      hair: '#f6efe6',
      hatColor: '#7a4fa8',
      tunicColor: '#3f7a5a',
      jacketColor: '#191b26',
      jacketAccent: '#ffd166',
      spikes: 7,
      shades: true,
      outfit: 0,
      tattoo: 'skull',
      cigar: true,
    },
    moves: {
      light: 'dopey_light',
      heavy: 'dopey_heavy',
      special: 'sp_dopey',
      airLight: AIR_L,
      airHeavy: AIR_H,
      grab: GRAB,
      dashAttack: DASH,
    },
    super: {
      id: 'super_dopey',
      name: 'WHOOPS',
      description:
        'Trips over something. Whatever was in his pockets is now in the air, and ' +
        'whatever was in the air is now on fire, and none of it was aimed.',
      duration: 180,
      damage: 33,
      radius: -1,
      visual: 'dopey_chaos_rain',
      sfx: 'explosion',
    },
    signatureWeapon: 'bat',
    voice: { pitch: 210, timbre: 'squeak', wobble: 0.2 },
  },
];

const BY_ID = new Map<string, DwarfDef>(DWARFS.map((d) => [d.id, d]));

export function getDwarf(id: string): DwarfDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown dwarf: ${id}`);
  return d;
}
