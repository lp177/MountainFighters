/**
 * The finishers.
 *
 * This is a joke book with frame counts. Every entry is a punchline the game is
 * allowed to tell once the fight is already over, which is why the tone here is
 * closer to a cartoon anvil than to a horror film: the dwarfs are hitting
 * billionaires with a chain, and the worst thing a finisher can be is grim.
 *
 * ── HOW AN ENTRY IS READ ────────────────────────────────────────────────────
 *
 * `visual` is the only field with teeth. It names a bespoke renderer inside
 * `game/Fatality.ts`; a `visual` with no renderer never plays, because
 * `FatalityDirector.start()` refuses to stage something it cannot draw. Adding a
 * finisher is therefore always two edits — the entry here and the renderer
 * there — and never one.
 *
 * `gore` is a rating, not a mood. It answers "how much of the inside of a
 * person is on the floor at the end", so a hat being eaten is `light` however
 * humiliating it is, and a body folded into a neat warm square is `heavy`
 * despite there being no blood in it at all. That is what lets the gore setting
 * mean something specific:
 *
 *     off  — no finishers at all. The kill is a kill.
 *     on   — light + heavy. The default, and the bulk of the book.
 *     max  — everything, including the absurd tier.
 *
 * Because of that split, EVERY boss owns at least one non-absurd finisher.
 * A boss whose only send-off is `absurd` would silently have none at the
 * default setting, which is exactly the class of bug this comment exists to
 * prevent.
 *
 * `weight` is relative odds within its own pool. Surprise is the whole point,
 * so the weights are deliberately flat-ish: nothing dominates, the rare ones
 * are rare but not mythical, and `pickFatality` suppresses whatever it just
 * played so that the third guard of the wave does not die exactly like the
 * first two.
 *
 * `sfx` may only name cues that already exist in `SfxCue` — the repo ships no
 * audio files, and a cue with no synthesis recipe is silence.
 */

import type { FatalityDef, Rng, Settings } from '@/core/types';

export const FATALITIES: FatalityDef[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // PLAYER — what a dwarf does to a guard, a bot, an intern or a lobbyist.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'annual_review',
    name: 'THE ANNUAL REVIEW',
    banner: 'Feedback is a gift. Here is yours, in full.',
    duration: 172,
    by: 'player',
    weight: 10,
    gore: 'heavy',
    visual: 'spine_pull',
    sfx: ['grunt', 'bone_crack', 'hit_flesh'],
  },
  {
    id: 'organ_harvest',
    name: 'ORGAN HARVEST',
    banner: 'One owner. Low mileage. Slightly warm.',
    duration: 184,
    by: 'player',
    weight: 7,
    gore: 'absurd',
    visual: 'heart_bite',
    sfx: ['hit_flesh', 'bone_crack', 'laugh'],
  },
  {
    id: 'severance_package',
    name: 'SEVERANCE PACKAGE',
    banner: 'Effective immediately. And upward.',
    duration: 152,
    by: 'player',
    weight: 10,
    gore: 'light',
    visual: 'orbit_kick',
    sfx: ['kick', 'whiff', 'coin'],
  },
  {
    id: 'downsizing',
    name: 'DOWNSIZING',
    banner: 'Restructuring. From above.',
    duration: 164,
    by: 'player',
    weight: 8,
    gore: 'heavy',
    visual: 'rack_drop',
    sfx: ['whiff', 'explosion', 'hit_metal'],
  },
  {
    id: 'hi_ho',
    name: 'HI HO',
    banner: 'Not sharpened since 1937. Did not need to be.',
    duration: 176,
    by: 'player',
    weight: 6,
    gore: 'absurd',
    visual: 'pickaxe_split',
    sfx: ['weapon_swing', 'bone_crack', 'hit_flesh'],
  },
  {
    id: 'chain_letter',
    name: 'CHAIN LETTER',
    banner: 'Send this to seven friends or nothing happens.',
    duration: 158,
    by: 'player',
    weight: 8,
    gore: 'heavy',
    visual: 'chain_decap',
    sfx: ['chain_whip', 'bone_crack', 'hit_flesh'],
  },
  {
    id: 'recycling',
    name: 'RECYCLING',
    banner: 'Please flatten before disposal.',
    duration: 168,
    by: 'player',
    weight: 8,
    gore: 'light',
    visual: 'barrel_fold',
    sfx: ['drop', 'hit_metal', 'bat_crack'],
  },
  {
    id: 'terms_of_service',
    name: 'TERMS OF SERVICE',
    banner: 'Please scroll to the bottom to continue.',
    duration: 200,
    by: 'player',
    weight: 7,
    gore: 'light',
    visual: 'eula_scroll',
    sfx: ['ui_error', 'ui_move', 'drop'],
  },
  {
    id: 'synergy',
    name: 'SYNERGY',
    banner: 'Two smaller, more focused teams.',
    duration: 166,
    by: 'player',
    weight: 6,
    gore: 'absurd',
    visual: 'confetti_tear',
    sfx: ['grunt', 'bone_crack', 'laugh'],
  },
  {
    id: 'vesting_cliff',
    name: 'THE VESTING CLIFF',
    banner: 'Four years of hard work. One step.',
    duration: 190,
    by: 'player',
    weight: 7,
    gore: 'heavy',
    visual: 'off_frame_toss',
    sfx: ['whiff', 'hit_flesh', 'glass'],
  },
  {
    id: 'exit_interview',
    name: 'THE EXIT INTERVIEW',
    banner: 'Firm handshake. Far too firm.',
    duration: 168,
    by: 'player',
    weight: 6,
    gore: 'heavy',
    visual: 'handshake_keep',
    sfx: ['grunt', 'bone_crack', 'drop'],
  },
  {
    id: 'culture_fit',
    name: 'CULTURE FIT',
    banner: 'He simply did not screw in.',
    duration: 172,
    by: 'player',
    weight: 5,
    gore: 'absurd',
    visual: 'unscrew_head',
    sfx: ['bone_crack', 'glass', 'laugh'],
  },
  {
    id: 'return_to_office',
    name: 'RETURN TO OFFICE',
    banner: 'Badge in. Then stay in.',
    duration: 166,
    by: 'player',
    weight: 6,
    gore: 'light',
    visual: 'cubicle_seal',
    sfx: ['drop', 'hit_metal', 'ui_error'],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // ENEMY — what security does to a dwarf. Humiliation is the damage type.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'hat_trick',
    name: 'HAT TRICK',
    banner: 'He ate it. He ATE the hat.',
    duration: 214,
    by: 'enemy',
    weight: 14,
    gore: 'light',
    visual: 'hat_eat',
    sfx: ['pickup', 'grunt', 'laugh'],
  },
  {
    id: 'roof_toss',
    name: 'ROOF TOSS',
    banner: 'It is up there now. It lives up there.',
    duration: 196,
    by: 'enemy',
    weight: 10,
    gore: 'light',
    visual: 'hat_roof',
    sfx: ['whiff', 'ui_error', 'land'],
  },
  {
    id: 'pip',
    name: 'PERFORMANCE IMPROVEMENT PLAN',
    banner: 'Thirty days to improve. He got four.',
    duration: 178,
    by: 'enemy',
    weight: 9,
    gore: 'light',
    visual: 'pip_beating',
    sfx: ['punch_light', 'punch_light', 'ko'],
  },
  {
    id: 'non_disclosure',
    name: 'NON-DISCLOSURE',
    banner: 'Signed, sealed, stapled.',
    duration: 166,
    by: 'enemy',
    weight: 8,
    gore: 'heavy',
    visual: 'staple_mouth',
    sfx: ['hit_metal', 'grunt', 'drop'],
  },
  {
    id: 'grooming_policy',
    name: 'GROOMING POLICY',
    banner: 'Company standards apply to the beard.',
    duration: 182,
    by: 'enemy',
    weight: 7,
    gore: 'light',
    visual: 'beard_shave',
    sfx: ['taser', 'ui_error', 'drop'],
  },
  {
    id: 'escorted',
    name: 'ESCORTED FROM THE BUILDING',
    banner: 'Your things will be mailed. They will not.',
    duration: 176,
    by: 'enemy',
    weight: 8,
    gore: 'light',
    visual: 'escort_out',
    sfx: ['grunt', 'drop', 'ui_back'],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // BOSSES — one signature send-off each, minimum, and never a shared one.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'dev_wontfix',
    name: 'WONTFIX',
    banner: 'Closed. Cannot reproduce. Working as intended.',
    duration: 176,
    by: 'boss',
    boss: 'dev',
    weight: 10,
    gore: 'light',
    visual: 'wontfix',
    sfx: ['ui_select', 'ui_error', 'ui_back'],
  },
  {
    id: 'shiba_leg',
    name: 'GOOD BOY',
    banner: 'much leg. so femur. wow.',
    duration: 192,
    by: 'boss',
    boss: 'shiba',
    weight: 12,
    gore: 'heavy',
    visual: 'shiba_leg',
    sfx: ['bone_crack', 'hit_flesh', 'laugh'],
  },
  {
    id: 'shiba_bury',
    name: 'BURIED',
    banner: 'he will remember where. he will not come back.',
    duration: 182,
    by: 'boss',
    boss: 'shiba',
    weight: 7,
    gore: 'light',
    visual: 'shiba_bury',
    sfx: ['dash', 'drop', 'land'],
  },
  {
    id: 'check_ratio',
    name: 'RATIOED',
    banner: 'Community Note: he is dead.',
    duration: 184,
    by: 'boss',
    boss: 'blue_check',
    weight: 10,
    gore: 'light',
    visual: 'ratio_crush',
    sfx: ['ui_move', 'ui_error', 'explosion'],
  },
  {
    id: 'fsd_park',
    name: 'PARALLEL PARKING',
    banner: 'Manoeuvre complete. Repeating manoeuvre.',
    duration: 236,
    by: 'boss',
    boss: 'fsd',
    weight: 12,
    gore: 'heavy',
    visual: 'car_roll',
    sfx: ['engine', 'tyres', 'hit_flesh'],
  },
  {
    id: 'fsd_door',
    name: 'FALCON DOOR',
    banner: 'Obstruction detected. Closing anyway.',
    duration: 172,
    by: 'boss',
    boss: 'fsd',
    weight: 7,
    gore: 'heavy',
    visual: 'falcon_door',
    sfx: ['hit_metal', 'glass', 'ui_error'],
  },
  {
    id: 'boring_muck',
    name: 'SPOIL REMOVAL',
    banner: 'Now available as a decorative garden brick.',
    duration: 194,
    by: 'boss',
    boss: 'boring',
    weight: 9,
    gore: 'absurd',
    visual: 'muck_brick',
    sfx: ['engine', 'hit_flesh', 'drop'],
  },
  {
    id: 'boring_tube',
    name: 'THE TUNNEL',
    banner: 'Traffic solved. One dwarf at a time.',
    duration: 178,
    by: 'boss',
    boss: 'boring',
    weight: 8,
    gore: 'light',
    visual: 'tube_drop',
    sfx: ['drop', 'whiff', 'land'],
  },
  {
    id: 'nl_trial',
    name: 'CLINICAL TRIAL',
    banner: 'The subject responded well. Then stopped responding.',
    duration: 188,
    by: 'boss',
    boss: 'neuralink',
    weight: 10,
    gore: 'heavy',
    visual: 'implant_fit',
    sfx: ['taser', 'bone_crack', 'robot_death'],
  },
  {
    id: 'reg_ruling',
    name: 'FINAL RULING',
    banner: 'Filed, stamped, and flattened.',
    duration: 178,
    by: 'boss',
    boss: 'regulator',
    weight: 10,
    gore: 'light',
    visual: 'gavel_stamp',
    sfx: ['whiff', 'explosion', 'drop'],
  },
  {
    id: 'trump_delegate',
    name: 'DELEGATED',
    banner: 'I know the best people. They do this for me.',
    duration: 192,
    by: 'boss',
    boss: 'trump',
    weight: 11,
    gore: 'light',
    visual: 'delegate_drag',
    sfx: ['grunt', 'drop', 'ui_back'],
  },
  {
    id: 'trump_wall',
    name: 'THE WALL',
    banner: 'And he is going to pay for it.',
    duration: 178,
    by: 'boss',
    boss: 'trump',
    weight: 6,
    gore: 'heavy',
    visual: 'wall_drop',
    sfx: ['whiff', 'explosion', 'coin'],
  },
  {
    id: 'opt_fold',
    name: 'LAUNDRY',
    banner: 'Folded. Stacked. Still warm.',
    duration: 188,
    by: 'boss',
    boss: 'optimus',
    weight: 10,
    gore: 'heavy',
    visual: 'fold_stack',
    sfx: ['robot_death', 'bone_crack', 'drop'],
  },
  {
    id: 'grok_hallucinate',
    name: 'HALLUCINATED',
    banner: 'He was never in the training data.',
    duration: 182,
    by: 'boss',
    boss: 'grok',
    weight: 10,
    gore: 'light',
    visual: 'hallucinated',
    sfx: ['ui_error', 'glass', 'ui_back'],
  },
  {
    id: 'ship_rud',
    name: 'RAPID UNSCHEDULED DISASSEMBLY',
    banner: 'A successful test of an unsuccessful dwarf.',
    duration: 208,
    by: 'boss',
    boss: 'starship',
    weight: 9,
    gore: 'absurd',
    visual: 'rud_launch',
    sfx: ['super_charge', 'explosion', 'land'],
  },
  {
    id: 'ship_static',
    name: 'STATIC FIRE',
    banner: 'Hold-down clamps performed nominally.',
    duration: 182,
    by: 'boss',
    boss: 'starship',
    weight: 8,
    gore: 'heavy',
    visual: 'static_fire',
    sfx: ['engine', 'explosion', 'hit_flesh'],
  },
  {
    id: 'mars_airlock',
    name: 'AIRLOCK CYCLE',
    banner: 'Your air subscription has lapsed.',
    duration: 192,
    by: 'boss',
    boss: 'mars_gov',
    weight: 10,
    gore: 'light',
    visual: 'airlock_vent',
    sfx: ['ui_error', 'whiff', 'glass'],
  },
  {
    id: 'clone_kiss',
    name: "TRUE LOVE'S KISS",
    banner: 'Ninety-six percent of one, anyway.',
    duration: 186,
    by: 'boss',
    boss: 'clone',
    weight: 10,
    gore: 'heavy',
    visual: 'kiss_shatter',
    sfx: ['super_charge', 'glass', 'ko'],
  },
  {
    id: 'musk_schematic',
    name: 'THE SCHEMATIC',
    banner: 'At last. The exploded view.',
    duration: 214,
    by: 'boss',
    boss: 'musk',
    weight: 12,
    gore: 'absurd',
    visual: 'exploded_view',
    sfx: ['super_charge', 'bone_crack', 'super_blast'],
  },
  {
    id: 'musk_acquired',
    name: 'ACQUIRED',
    banner: 'Undervalued. Bought anyway. Shut down Friday.',
    duration: 192,
    by: 'boss',
    boss: 'musk',
    weight: 8,
    gore: 'light',
    visual: 'acquired_box',
    sfx: ['coin', 'drop', 'hit_metal'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

/** How far up the viscera ladder each entry sits. */
const GORE_RANK: Record<FatalityDef['gore'], number> = { light: 0, heavy: 1, absurd: 2 };

/** ...and how far up the ladder each setting is willing to go. -1 = nowhere. */
const LEVEL_CAP: Record<Settings['gore'], number> = { off: -1, on: 1, max: 2 };

/**
 * Finishers this pool has played recently, most recent last.
 *
 * A beat-em-up kills the same guard forty times an hour, and a finisher that
 * repeats stops being a surprise on its second showing. Three is enough to
 * cover a whole wave without starving the smaller pools — a boss with exactly
 * one finisher still gets it, because the ban is relaxed rather than enforced
 * when it would leave nothing to pick.
 *
 * This is mutable module state read by deterministic code, which is safe for
 * the same reason the RNG is: every peer runs the same sim in the same order,
 * so every peer's history is the same history.
 */
const RECENT_MAX = 3;
const recent: string[] = [];

/** Drop the history. Call between fights so a new map does not inherit one. */
export function resetFatalityHistory(): void {
  recent.length = 0;
}

const poolCache = new Map<string, FatalityDef[]>();

/**
 * Every finisher a given performer may use, in table order.
 *
 * The returned array is cached and shared — treat it as read-only. Boss pools
 * are keyed by boss id; asking for `'boss'` with no id returns every boss
 * finisher there is, which is what a gallery or a validator wants.
 */
export function fatalitiesFor(
  by: 'player' | 'enemy' | 'boss',
  bossId?: string,
): FatalityDef[] {
  const key = `${by}|${bossId ?? ''}`;
  const cached = poolCache.get(key);
  if (cached) return cached;

  const out: FatalityDef[] = [];
  for (const f of FATALITIES) {
    if (f.by !== by) continue;
    if (by === 'boss') {
      if (bossId !== undefined && f.boss !== bossId) continue;
    } else if (f.boss !== undefined) {
      continue;
    }
    out.push(f);
  }
  poolCache.set(key, out);
  return out;
}

/**
 * `strict` 0 bans everything in the history, 1 bans only the last one played,
 * 2 bans nothing. `pickFatality` walks up that ladder so the ban never turns
 * into "no finisher at all".
 */
function eligible(f: FatalityDef, cap: number, strict: number): boolean {
  if (f.weight <= 0) return false;
  if (GORE_RANK[f.gore] > cap) return false;
  if (strict >= 2) return true;
  if (strict === 1) return recent.length === 0 || recent[recent.length - 1] !== f.id;
  return recent.indexOf(f.id) < 0;
}

/**
 * Weighted, deterministic, gore-capped and repeat-averse.
 *
 * Consumes at most one number from `rng`, and only when it is actually going to
 * return something — a caller that asks on a frame where no finisher applies
 * does not silently advance the shared RNG and desync the fight.
 */
export function pickFatality(
  by: 'player' | 'enemy' | 'boss',
  rng: Rng,
  bossId?: string,
  gore: Settings['gore'] = 'on',
): FatalityDef | null {
  const cap = LEVEL_CAP[gore] ?? LEVEL_CAP.on;
  if (cap < 0) return null;

  const pool = fatalitiesFor(by, bossId);
  if (pool.length === 0) return null;

  for (let strict = 0; strict < 3; strict++) {
    let total = 0;
    for (let i = 0; i < pool.length; i++) {
      if (eligible(pool[i], cap, strict)) total += pool[i].weight;
    }
    if (total <= 0) continue;

    let roll = rng.next() * total;
    let last: FatalityDef | null = null;
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (!eligible(f, cap, strict)) continue;
      last = f;
      roll -= f.weight;
      if (roll <= 0) break;
    }
    if (!last) continue;

    recent.push(last.id);
    if (recent.length > RECENT_MAX) recent.shift();
    return last;
  }
  return null;
}
