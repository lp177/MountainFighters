/**
 * Every weapon that can be dropped, picked up, swung and broken.
 *
 * Design rules the numbers follow:
 *   - Reach and damage are paid for in `speedScale` and `durability`.
 *   - Anything with `ammo` is spent rather than broken; it dies at 0 rounds.
 *   - Nothing in here is strictly better than fists — a bat that hits like a
 *     truck breaks in eighteen swings, and the Cybertruck door makes you walk
 *     like you are carrying a Cybertruck door.
 *
 * `art.shape` must be one of the silhouettes CharacterRig.drawWeapon actually
 * implements: stick, flail, blocky, gun, shield, plate. The rig special-cases
 * `keyboard` and `taser` inside those shapes.
 *
 * Move id convention: `<kind>_light`, `<kind>_heavy`, `<kind>_throw`.
 */

import type { WeaponDef, WeaponKind } from '@/core/types';

export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  chain: {
    kind: 'chain',
    sfx: { reveal: 'chain_whip', swing: 'chain_whip', impact: 'hit_metal' },
    name: 'Bike Chain',
    // Long, cheap, wraps round guards. Poor per-hit damage, superb reach.
    durability: 28,
    damageScale: 1.2,
    speedScale: 0.98,
    moves: { light: 'chain_light', heavy: 'chain_heavy', throw: 'chain_throw' },
    art: {
      shape: 'flail',
      length: 32,
      thickness: 3.0,
      color: '#8e97a6',
      accent: '#dbe4f0',
      segments: 8,
      spikes: false,
    },
  },

  bat: {
    kind: 'bat',
    sfx: { reveal: 'bat_crack', swing: 'weapon_swing', impact: 'bat_crack' },
    name: 'Aluminium Bat',
    // The crowd-pleaser. Big damage, dents fast.
    durability: 18,
    damageScale: 1.6,
    speedScale: 0.93,
    moves: { light: 'bat_light', heavy: 'bat_heavy', throw: 'bat_throw' },
    art: {
      shape: 'stick',
      length: 27,
      thickness: 4.4,
      color: '#b6bfca',
      accent: '#e8eff7',
      spikes: false,
    },
  },

  ironbar: {
    kind: 'ironbar',
    sfx: { reveal: 'hit_metal', swing: 'weapon_swing', impact: 'hit_metal', pitch: 0.58 },
    name: 'Length of Rebar',
    // Nearly indestructible, slow, and it goes straight through a suit.
    durability: 46,
    damageScale: 1.4,
    speedScale: 0.88,
    moves: { light: 'ironbar_light', heavy: 'ironbar_heavy', throw: 'ironbar_throw' },
    art: {
      shape: 'stick',
      length: 30,
      thickness: 3.2,
      color: '#6f6a76',
      accent: '#a49dae',
      segments: 5,
      spikes: true,
    },
  },

  pipe: {
    kind: 'pipe',
    sfx: { reveal: 'hit_metal', swing: 'weapon_swing', impact: 'hit_metal', pitch: 1.34 },
    name: 'Lead Pipe',
    // Short, dense, honest. The starter weapon of every wet alley in the game.
    durability: 24,
    damageScale: 1.35,
    speedScale: 0.95,
    moves: { light: 'pipe_light', heavy: 'pipe_heavy', throw: 'pipe_throw' },
    art: {
      shape: 'stick',
      length: 22,
      thickness: 4.0,
      color: '#7f6c58',
      accent: '#c3a385',
      spikes: false,
    },
  },

  taser: {
    kind: 'taser',
    sfx: { reveal: 'taser', swing: 'taser', impact: 'taser' },
    name: 'Compliance Taser',
    // Low damage, enormous stun. Eight cartridges of workplace culture.
    durability: -1,
    ammo: 8,
    damageScale: 1.05,
    speedScale: 1.0,
    moves: { light: 'taser_light', heavy: 'taser_heavy', throw: 'taser_throw' },
    art: {
      shape: 'gun',
      length: 12,
      thickness: 4.0,
      color: '#2f3a4a',
      accent: '#6ee4ff',
      spikes: false,
    },
  },

  pistol: {
    kind: 'pistol',
    sfx: { reveal: 'gunshot', swing: 'weapon_swing', impact: 'gunshot' },
    name: 'Executive Sidearm',
    // Six rounds, no reload, wildly out of proportion to the situation.
    durability: -1,
    ammo: 6,
    damageScale: 2.2,
    speedScale: 1.0,
    moves: { light: 'pistol_light', heavy: 'pistol_heavy', throw: 'pistol_throw' },
    art: {
      shape: 'gun',
      length: 13,
      thickness: 4.2,
      color: '#31313c',
      accent: '#ffcf5c',
      spikes: false,
    },
  },

  riotshield: {
    kind: 'riotshield',
    sfx: { reveal: 'block', swing: 'weapon_swing', impact: 'block', pitch: 0.9 },
    name: 'Riot Shield',
    // Barely a weapon. Absolutely a wall. Slows you to a shuffle.
    durability: 40,
    damageScale: 1.05,
    speedScale: 0.8,
    moves: { light: 'riotshield_light', heavy: 'riotshield_heavy', throw: 'riotshield_throw' },
    art: {
      shape: 'shield',
      length: 36,
      thickness: 4.0,
      color: '#2b3340',
      accent: '#f2c53d',
      spikes: false,
    },
  },

  cybertruck_door: {
    kind: 'cybertruck_door',
    sfx: { reveal: 'glass', swing: 'weapon_swing', impact: 'hit_metal', pitch: 0.7 },
    name: 'Cybertruck Door',
    // Eighty kilos of unpainted stainless despair. Two hits, one funeral.
    durability: 12,
    damageScale: 2.5,
    speedScale: 0.58,
    moves: {
      light: 'cybertruck_door_light',
      heavy: 'cybertruck_door_heavy',
      throw: 'cybertruck_door_throw',
    },
    art: {
      shape: 'plate',
      length: 42,
      thickness: 6.4,
      color: '#b9bfc7',
      accent: '#e2e8ef',
      spikes: false,
    },
  },

  keyboard: {
    kind: 'keyboard',
    sfx: { reveal: 'bone_crack', swing: 'weapon_swing', impact: 'glass', pitch: 1.55 },
    name: 'Mechanical Keyboard',
    // Fast, light, extremely loud, does almost nothing. Ninety-eight percent
    // of the damage is emotional.
    durability: 10,
    damageScale: 0.85,
    speedScale: 1.06,
    moves: { light: 'keyboard_light', heavy: 'keyboard_heavy', throw: 'keyboard_throw' },
    art: {
      shape: 'blocky',
      length: 26,
      thickness: 7.0,
      color: '#2a2b34',
      accent: '#8be0c8',
      spikes: false,
    },
  },

  gpu: {
    kind: 'gpu',
    sfx: { reveal: 'robot_death', swing: 'weapon_swing', impact: 'hit_metal', pitch: 1.2 },
    name: 'Flagship GPU',
    // A brick of silicon worth more than the flat you grew up in. Swing it.
    durability: 15,
    damageScale: 1.9,
    speedScale: 0.86,
    moves: { light: 'gpu_light', heavy: 'gpu_heavy', throw: 'gpu_throw' },
    art: {
      shape: 'blocky',
      length: 24,
      thickness: 8.2,
      color: '#1f2430',
      accent: '#57ff9e',
      spikes: false,
    },
  },
};
