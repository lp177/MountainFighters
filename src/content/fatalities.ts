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
 *
 * ── TROPHIES ────────────────────────────────────────────────────────────────
 *
 * `trophy` is what the finisher LEAVES, and it is the hook the follow-through
 * hangs off — see `FLOURISHES` at the bottom of this file. It is read off the
 * renderer rather than off the name, by two rules applied in order:
 *
 *   1. Something came off a body and is still in the shot: a spine, a heart, an
 *      arm, a leg, a head, a hat, half a torso. That.
 *   2. Otherwise the portable prop the kill was performed with or produced —
 *      a pickaxe, a chain, a stapler, a car door, a brick, a taped box.
 *      `'object'`.
 *
 * Scenery is not a trophy. A cubicle that grew out of the floor, a brick wall,
 * a hatch, a rocket, an airlock and a car are all things the killer is standing
 * next to rather than holding, and a finisher that ends with the killer's hands
 * demonstrably empty — kicked over the horizon, buried, de-rendered, filed in a
 * drawer — is honestly `'none'`. Half this book is `'none'`, and that is the
 * right answer: the follow-through is a reward for the kills that hand you
 * something, not a tax on the ones that do not.
 */

import type {
  FatalityDef,
  FatalityFlourish,
  Rng,
  Settings,
  TrophyKind,
} from '@/core/types';

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
    // Held up, admired, and then dropped in the dirt — which is exactly the
    // waste the follow-through exists to stop.
    trophy: 'spine',
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
    // One bite out of it. Still beating, still throwable.
    trophy: 'heart',
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
    // He clears the atmosphere in one piece and takes it all with him.
    trophy: 'none',
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
    // A whole server rack, standing on a pair of shoes. It has wheels.
    trophy: 'object',
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
    // The pickaxe. It never leaves his hands in the first place.
    trophy: 'object',
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
    // The head is a hundred and fifty units away and still spinning. The chain
    // is the thing that stayed.
    trophy: 'object',
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
    // One green barrel, lid stomped flat, contents included.
    trophy: 'object',
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
    // The contract ages with the reader and crumbles with him. Nothing is left
    // but the pile.
    trophy: 'none',
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
    // He finishes holding one of the two smaller teams in each hand.
    trophy: 'torso',
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
    // What comes back lands on his face, and he wipes it off.
    trophy: 'none',
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
    // It comes away at the shoulder. He offers it back. Nobody takes it.
    trophy: 'arm',
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
    // Held aloft, hat still on, still slowly turning.
    trophy: 'head',
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
    // The partitions grew out of the floor. They are not coming with him.
    trophy: 'none',
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
    // The belch brings one scrap of pom-pom back up, and that is the entire
    // trophy. Swinging it at a crowd is exactly as pathetic as it sounds.
    trophy: 'hat',
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
    // On the ledge, out of reach of everyone, including the man who threw it.
    trophy: 'none',
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
    // The rolled-up document, softened by use.
    trophy: 'object',
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
    // The stapler, still loaded.
    trophy: 'object',
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
    // Clippers, in hand, doing a job a taser was not designed for.
    trophy: 'object',
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
    // He walks back in dusting his hands, which is the whole shot.
    trophy: 'none',
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
    // He de-renders from the feet up. There is no body to take a part off.
    trophy: 'none',
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
    // In the mouth, boot still on it, and he is not giving it back.
    trophy: 'leg',
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
    // Underground, backfilled, patted down.
    trophy: 'none',
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
    // Nine replies deep into the floor. Nothing above ground to pick up.
    trophy: 'none',
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
    // The killer is a car, and the car keeps all of its parts.
    trophy: 'none',
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
    // One falcon door, glass already gone, hinge negotiable.
    trophy: 'object',
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
    // One brick, hat on top, grade A fill.
    trophy: 'object',
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
    // The hatch shuts over him. Please stand clear.
    trophy: 'none',
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
    // The only hardware in the shot is screwed into his skull.
    trophy: 'none',
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
    // A gavel the size of a dwarf, already up in the air.
    trophy: 'object',
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
    // The staff took him away and the staff kept him.
    trophy: 'none',
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
    // Six courses of brick is masonry, not a prop.
    trophy: 'none',
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
    // A dwarf folded into a warm square with crisp corners. It stacks. It also
    // rolls.
    trophy: 'torso',
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
    // Confidently cited as never having existed. Citations have no body parts.
    trophy: 'none',
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
    // One scorched boot lands at his feet, which is all that came back.
    trophy: 'object',
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
    // The man is a stencil on the floor. The hat floats down unharmed.
    trophy: 'hat',
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
    // Everything not bolted down went out with him, waving.
    trophy: 'none',
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
    // A knee-high pile of blue shards, none of which is a handle.
    trophy: 'none',
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
    // Every part is labelled, and every part goes in the drawer.
    trophy: 'none',
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
    // One taped box with a dwarf in it and a one-dollar tag on the side.
    trophy: 'object',
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
  recentFlourish.length = 0;
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

/** What a finisher left in the killer's hands. Unset means empty-handed. */
export function trophyOf(f: FatalityDef): TrophyKind {
  return f.trophy ?? 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// The follow-through
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the killer does with the trophy while the rest of the room is watching.
 *
 * A finisher in a crowd used to be a private event: the victim died
 * spectacularly and the six guards around them stood politely and waited their
 * turn. The flourish is the half of the joke the bystanders are in — the spine
 * that was going to be dropped gets swung through the lot of them instead,
 * which is funnier, and which makes finishing someone in the MIDDLE of a pack
 * worth doing on purpose.
 *
 * ── HOW AN ENTRY IS READ ────────────────────────────────────────────────────
 *
 * Same two-edit rule as the finishers: `visual` names a bespoke renderer in the
 * director's flourish table, and a flourish with no renderer never plays —
 * `chooseFlourish` refuses to stage what it cannot draw and the finisher simply
 * ends the way it always did. `visual` therefore names the MOVEMENT, not the
 * joke: RETURN POLICY throws a boomerang and GOLF drives off a tee, so they
 * point at `boomerang` and `golf_drive` however their banners read. No flourish
 * visual collides with a `FatalityDef.visual` from the book above; keep it that
 * way, in case the two tables are ever merged into one lookup.
 *
 * `radius` is world units around the killer, and -1 is everyone on screen. The
 * throws read it as reach rather than as a blast: JAVELIN's 240 is how far it
 * will look for one target, not a sphere of damage.
 *
 * `damage` is deliberately SMALL. A finisher just killed someone; this is the
 * tip, not a second super. The knockdown is the reward — a room full of guards
 * on their backs is worth far more than four points of chip.
 *
 * `trophies` keeps each one plausible: a spine whips, a head bowls, a heart
 * does neither, and an omitted list means "anything the finisher left you
 * holding". Nothing works with `'none'` — miming a tornado with empty hands is
 * not a joke, it is a bug — and every other TrophyKind has at least SEVEN
 * non-absurd flourishes, so no trophy quietly runs out of things to do at the
 * default gore setting.
 *
 * The weights lean hard on TORNADO because it is the one that teaches the
 * player the mechanic exists, and everything after it is the surprise. SOUVENIR
 * is the exception that proves it: no damage, no crowd, no point, and funny
 * precisely because the other fourteen are none of those things.
 */

/** Long, floppy, and hinged in the wrong places. A club, not a ball. */
const LIMBS: TrophyKind[] = ['spine', 'arm', 'leg', 'object'];
/** Small enough to tee up, lob underarm, or wear as a hat. */
const ROUND: TrophyKind[] = ['heart', 'head', 'hat', 'object'];
/** Enough mass to move the floor when it lands. */
const HEFTY: TrophyKind[] = ['spine', 'arm', 'leg', 'head', 'torso', 'object'];
/** Things that burst rather than snap. */
const BURSTS: TrophyKind[] = ['heart', 'head', 'torso', 'hat', 'object'];
/** Things you can hand to a stranger. A torso is not one of them. */
const TOSSABLE: TrophyKind[] = ['spine', 'heart', 'arm', 'leg', 'head', 'hat', 'object'];

export const FLOURISHES: FatalityFlourish[] = [
  /**
   * Plant a foot, hold it out at arm's length, and turn until the room is
   * horizontal. The one the whole feature was asked for, and the most common by
   * a wide margin so that nobody has to be told it is in the game.
   */
  {
    id: 'tornado',
    name: 'TORNADO',
    visual: 'tornado',
    duration: 88,
    radius: 66,
    damage: 5,
    reaction: 'sweep',
    weight: 26,
    gore: 'heavy',
    sfx: ['weapon_swing', 'hit_flesh', 'land'],
  },
  /** One target, one throw, and that target leaves the postcode. */
  {
    id: 'javelin',
    name: 'JAVELIN',
    visual: 'javelin',
    duration: 66,
    radius: 240,
    damage: 10,
    reaction: 'blowback',
    weight: 15,
    gore: 'heavy',
    sfx: ['grunt', 'whiff', 'hit_flesh'],
  },
  /** Underarm, along the floor, down a lane of guards. Seven pins is a strike. */
  {
    id: 'bowling',
    name: 'BOWLING',
    visual: 'bowling',
    duration: 100,
    radius: 210,
    damage: 6,
    reaction: 'sweep',
    trophies: ['head', 'torso'],
    weight: 11,
    gore: 'heavy',
    sfx: ['drop', 'dash', 'hit_flesh'],
  },
  /** Overhead, faster, faster — then let go and look at something else. */
  {
    id: 'helicopter',
    name: 'HELICOPTER',
    visual: 'helicopter',
    duration: 108,
    radius: -1,
    damage: 8,
    reaction: 'crumple',
    weight: 12,
    gore: 'light',
    sfx: ['weapon_swing', 'whiff', 'hit_flesh'],
  },
  /** Tee it up, address the ball, and put it flat through the front row. */
  {
    id: 'golf',
    name: 'GOLF',
    visual: 'golf_drive',
    duration: 74,
    radius: 190,
    damage: 7,
    reaction: 'blowback',
    trophies: [...ROUND],
    weight: 12,
    gore: 'light',
    sfx: ['whiff', 'bat_crack', 'coin'],
  },
  /** Both hands, straight down, and let the floor pass the message on. */
  {
    id: 'pile_driver',
    name: 'PILE DRIVER',
    visual: 'ground_slam',
    duration: 70,
    radius: 80,
    damage: 5,
    reaction: 'sweep',
    trophies: [...HEFTY],
    weight: 12,
    gore: 'heavy',
    sfx: ['grunt', 'explosion', 'land'],
  },
  /** Thirty-three vertebrae of rawhide. It was always going to end up as this. */
  {
    id: 'whip',
    name: 'WHIP',
    visual: 'whip',
    duration: 78,
    radius: 98,
    damage: 6,
    reaction: 'sweep',
    trophies: ['spine', 'arm'],
    weight: 9,
    gore: 'heavy',
    sfx: ['chain_whip', 'bone_crack', 'hit_flesh'],
  },
  /** Bat it until it gives up its contents. Everybody stands under it anyway. */
  {
    id: 'pinata',
    name: 'PIÑATA',
    visual: 'pinata',
    duration: 116,
    radius: 60,
    damage: 4,
    reaction: 'sweep',
    trophies: [...BURSTS],
    weight: 7,
    gore: 'absurd',
    sfx: ['bat_crack', 'hit_flesh', 'laugh'],
  },
  /** Lobbed to a stranger, who catches it before he has thought it through. */
  {
    id: 'hot_potato',
    name: 'HOT POTATO',
    visual: 'hot_potato',
    duration: 98,
    radius: 112,
    damage: 3,
    reaction: 'sweep',
    trophies: [...TOSSABLE],
    weight: 8,
    gore: 'light',
    sfx: ['whiff', 'grunt', 'drop'],
  },
  /**
   * Pockets it. Walks off. Nothing happens to anybody.
   *
   * The rare quiet one, and worth every frame of the anticlimax: a flourish
   * that always pays off has stopped being a joke by the third wave.
   */
  {
    id: 'souvenir',
    name: 'SOUVENIR',
    visual: 'souvenir',
    duration: 58,
    radius: 0,
    damage: 0,
    reaction: 'light',
    weight: 3,
    gore: 'light',
    sfx: ['pickup', 'coin'],
  },
  /** Backhand, backhand, backhand, all the way round. Attendance is mandatory. */
  {
    id: 'all_hands',
    name: 'ALL HANDS',
    visual: 'all_hands',
    duration: 92,
    radius: 72,
    damage: 4,
    reaction: 'heavy',
    trophies: [...LIMBS],
    weight: 9,
    gore: 'light',
    sfx: ['weapon_swing', 'punch_heavy', 'grunt'],
  },
  /** Thrown flat, and it comes back through the same people on the way home. */
  {
    id: 'return_policy',
    name: 'RETURN POLICY',
    visual: 'boomerang',
    duration: 104,
    radius: 170,
    damage: 4,
    reaction: 'sweep',
    trophies: [...LIMBS],
    weight: 7,
    gore: 'heavy',
    sfx: ['whiff', 'chain_whip', 'hit_flesh'],
  },
  /** Up, hang there longer than is reasonable, and down onto somebody's head. */
  {
    id: 'slam_dunk',
    name: 'SLAM DUNK',
    visual: 'slam_dunk',
    duration: 82,
    radius: 46,
    damage: 9,
    reaction: 'crumple',
    trophies: ['head', 'heart', 'hat', 'torso', 'object'],
    weight: 8,
    gore: 'heavy',
    sfx: ['jump', 'bone_crack', 'land'],
  },
  /** Two guards, one femur, alternating. Nobody asked for a solo. */
  {
    id: 'drum_solo',
    name: 'DRUM SOLO',
    visual: 'drum_solo',
    duration: 112,
    radius: 54,
    damage: 3,
    reaction: 'stun',
    trophies: ['spine', 'arm', 'leg', 'head', 'object'],
    weight: 6,
    gore: 'light',
    sfx: ['punch_light', 'punch_light', 'laugh'],
  },
  /**
   * Wears it. Takes a bow. Holds the bow far too long.
   *
   * Almost no damage: the guards go down from second-hand embarrassment, which
   * is the only status effect in this game anybody has ever deserved.
   */
  {
    id: 'mascot',
    name: 'MASCOT',
    visual: 'mascot',
    duration: 104,
    radius: 88,
    damage: 1,
    reaction: 'stun',
    trophies: ['head', 'hat', 'torso', 'object'],
    weight: 4,
    gore: 'absurd',
    sfx: ['pickup', 'laugh', 'ui_error'],
  },
];

/**
 * Flourishes played recently, most recent last. Same reasoning as `recent`
 * above, and cleared by the same `resetFatalityHistory()`, so a caller that
 * already resets between fights needs no second call.
 */
const recentFlourish: string[] = [];

const flourishCache = new Map<TrophyKind, FatalityFlourish[]>();

/**
 * Every flourish that works with a given trophy, in table order.
 *
 * Cached and shared — treat the result as read-only. `'none'` gets an empty
 * list, because empty hands have nothing to perform with.
 */
export function flourishesFor(trophy: TrophyKind): FatalityFlourish[] {
  const cached = flourishCache.get(trophy);
  if (cached) return cached;

  const out: FatalityFlourish[] = [];
  if (trophy !== 'none') {
    for (const f of FLOURISHES) {
      const only = f.trophies;
      if (only !== undefined && only.length > 0 && only.indexOf(trophy) < 0) continue;
      out.push(f);
    }
  }
  flourishCache.set(trophy, out);
  return out;
}

/**
 * `strict` 0 bans everything in the history, 1 bans only the last one played,
 * 2 bans nothing — the same relaxing ladder the finishers use, which matters
 * more here because the trophy has already cut the pool down before the ban
 * gets a look at it.
 */
function flourishEligible(f: FatalityFlourish, cap: number, strict: number): boolean {
  if (f.weight <= 0) return false;
  if (GORE_RANK[f.gore] > cap) return false;
  if (strict >= 2) return true;
  if (strict === 1) {
    return recentFlourish.length === 0 || recentFlourish[recentFlourish.length - 1] !== f.id;
  }
  return recentFlourish.indexOf(f.id) < 0;
}

/**
 * Weighted, deterministic, gore-capped, trophy-aware and repeat-averse.
 *
 * Returns null when there is nothing in the killer's hands (`'none'`, or a
 * finisher that never set a trophy at all), when the gore setting says no
 * finishers, and when the trophy has no flourish it can perform at this
 * setting. Consumes at most one number from `rng`, and only on a call that is
 * going to return something, so asking on a frame where no flourish applies
 * cannot advance the shared stream and desync a lockstep match.
 */
export function pickFlourish(
  trophy: TrophyKind | undefined,
  rng: Rng,
  gore: Settings['gore'] = 'on',
): FatalityFlourish | null {
  if (trophy === undefined || trophy === 'none') return null;

  // 'off' means no finishers at all, and a follow-through to a finisher that
  // never happened is not something the game can be talked into staging.
  const cap = LEVEL_CAP[gore] ?? LEVEL_CAP.on;
  if (cap < 0) return null;

  const pool = flourishesFor(trophy);
  if (pool.length === 0) return null;

  for (let strict = 0; strict < 3; strict++) {
    let total = 0;
    for (let i = 0; i < pool.length; i++) {
      if (flourishEligible(pool[i], cap, strict)) total += pool[i].weight;
    }
    if (total <= 0) continue;

    let roll = rng.next() * total;
    let last: FatalityFlourish | null = null;
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (!flourishEligible(f, cap, strict)) continue;
      last = f;
      roll -= f.weight;
      if (roll <= 0) break;
    }
    if (!last) continue;

    recentFlourish.push(last.id);
    if (recentFlourish.length > RECENT_MAX) recentFlourish.shift();
    return last;
  }
  return null;
}
