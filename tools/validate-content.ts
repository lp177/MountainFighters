/**
 * Mountain Fighters — content integrity validator.
 *
 * WHY THIS EXISTS
 *
 * The type system cannot see most of this game's content graph. `BossPhase.moves`
 * is `string[]`, `DwarfDef.moves.light` is `string`, `EnemyDef.moves.ranged` is
 * `string`, `MoveDef.anim` is `string`. Every one of those is a *reference* into
 * another table, and TypeScript will happily compile a reference to a move that
 * nobody ever wrote. Worse, `getMove()` deliberately falls back to a stock poke
 * rather than crashing, so a dangling id produces a game that boots, plays, and
 * is quietly wrong: seven dwarfs throwing the same generic punch, bosses whose
 * signature set-pieces are all the same jab.
 *
 * That is exactly the bug class this file exists to make impossible. It imports
 * the real modules — no fixtures, no mocks, no duplicated tables — walks the
 * whole content graph, and fails the build if any reference dangles.
 *
 * It is deliberately dependency-free and runs under plain Node: `npm run
 * validate` bundles it with the esbuild that already ships inside Vite.
 *
 * OUTPUT CONTRACT
 *   - every problem is printed, never a truncated sample, so one run is enough
 *     to fix everything;
 *   - exit code 0 on pass, 1 on failure;
 *   - warnings are advisory and never change the exit code.
 */

import process from 'node:process';

import { BOSS_EVERY, TOTAL_BOSSES, TOTAL_MAPS } from '@/core/constants';
import { BOSSES, bossForMap } from '@/content/bosses';
import { DWARFS, getDwarf } from '@/content/dwarfs';
import { ENEMIES } from '@/content/enemies';
import { MAPS, getMap } from '@/content/maps';
import { WEAPONS } from '@/content/weapons';
import { MOVES } from '@/game/combat/Moves';
import { CLIPS } from '@/render/rig/Anim';
import type { BossDef, EnemyKind, MoveDef, WeaponKind } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Expectations that live in the type system and therefore vanish at runtime.
//
// These mirror the unions in core/types.ts. core/types.ts is frozen contract, so
// they cannot drift underneath us; restating them here is what lets the
// validator catch a `as EnemyKind` cast or a Record that lost a key.
// ─────────────────────────────────────────────────────────────────────────────

const ENEMY_KINDS: readonly EnemyKind[] = [
  'suit_guard',
  'taser_guard',
  'gunman',
  'riot_guard',
  'security_bot',
  'vacuum_bot',
  'iot_fridge',
  'iot_speaker',
  'delivery_drone',
  'intern',
  'lobbyist',
];

const WEAPON_KINDS: readonly WeaponKind[] = [
  'chain',
  'bat',
  'ironbar',
  'pipe',
  'taser',
  'pistol',
  'riotshield',
  'cybertruck_door',
  'keyboard',
  'gpu',
  'lariat',
  'dagger',
];

/** The roster is the premise of the game; it is not allowed to quietly shrink. */
const DWARF_ROSTER: readonly string[] = [
  'doc',
  'grumpy',
  'happy',
  'sleepy',
  'bashful',
  'sneezy',
  'dopey',
];

const SUPER_VISUALS: readonly string[] = [
  'sneeze_shockwave',
  'sleep_dream_crush',
  'grump_quake',
  'doc_lecture',
  'bashful_blush_nova',
  'happy_disco_inferno',
  'dopey_chaos_rain',
];

const AI_BEHAVIOURS: readonly string[] = [
  'rusher',
  'spacer',
  'sniper',
  'turtle',
  'erratic',
  'support',
];

const WEAPON_SHAPES: readonly string[] = [
  'stick', 'flail', 'blocky', 'gun', 'shield', 'plate', 'blade', 'lasso',
];

const RIG_OVERRIDES: readonly string[] = [
  'shiba',
  'cybertruck',
  'rocket',
  'humanoid',
  'robot_giant',
];

const PROP_KINDS: readonly string[] = [
  'barrel',
  'crate',
  'vending',
  'server_rack',
  'scooter',
  'sign',
];

const VEHICLE_KINDS: readonly string[] = ['moto', 'cybertruck', 'hyperloop_pod', 'rocket'];

const MAP_THEMES: readonly string[] = [
  'tunnel',
  'factory',
  'server_farm',
  'launchpad',
  'mars_dome',
  'boardroom',
  'social_feed',
  'suburb',
  'mine',
  'forest',
  'gigafactory',
  'orbit',
];

const MUSIC_MOODS: readonly string[] = [
  'menu',
  'select',
  'fight_low',
  'fight_high',
  'boss',
  'final_boss',
  'victory',
  'defeat',
  'cutscene',
];

/**
 * Clips the rig is contractually required to provide (ARCHITECTURE.md). Anything
 * here missing means some state has no animation at all, which the `anim` check
 * below would only catch if a move happened to reference it.
 */
const REQUIRED_CLIPS: readonly string[] = [
  'idle',
  'walk',
  'run',
  'jump',
  'fall',
  'land',
  'punch1',
  'punch2',
  'kick',
  'uppercut',
  'sweep',
  'heavy_swing',
  'block',
  'hurt_light',
  'hurt_heavy',
  'launched',
  'knockdown',
  'getup',
  'grab',
  'throw',
  'stunned',
  'victory',
  'dead',
  'taunt',
  'weapon_swing',
  'weapon_heavy',
  'pickup',
  'dress_start',
  'dress_jacket',
  'dress_shades',
  'dress_pose',
  'ride',
];

// ─────────────────────────────────────────────────────────────────────────────
// Problem collection
// ─────────────────────────────────────────────────────────────────────────────

type Severity = 'error' | 'warn';

interface Problem {
  section: string;
  /** Precise path to the offending value, e.g. `BOSSES["dev"].phases[1].moves[3]`. */
  where: string;
  msg: string;
  severity: Severity;
}

const problems: Problem[] = [];

function err(section: string, where: string, msg: string): void {
  problems.push({ section, where, msg, severity: 'error' });
}

function warn(section: string, where: string, msg: string): void {
  problems.push({ section, where, msg, severity: 'warn' });
}

/** Records a stat line for the "what did it actually check" summary. */
const checked: { label: string; detail: string }[] = [];

function stat(label: string, detail: string): void {
  checked.push({ label, detail });
}

function has(rec: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
  return isNum(v) && Number.isInteger(v);
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function inRange(v: unknown, lo: number, hi: number): boolean {
  return isNum(v) && v >= lo && v <= hi;
}

function fmt(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// The move reference graph — the centrepiece
//
// Every place in the game that names a move by string is funnelled through
// `refMove`, together with a human-readable path to the exact field. Once the
// whole graph is walked we resolve the lot against MOVES in one pass, so a
// missing id is reported once with the complete list of things that wanted it.
// ─────────────────────────────────────────────────────────────────────────────

interface MoveRef {
  id: string;
  where: string;
}

const moveRefs: MoveRef[] = [];

function refMove(id: string, where: string): void {
  moveRefs.push({ id, where });
}

// ─────────────────────────────────────────────────────────────────────────────
// Moves & animation clips
// ─────────────────────────────────────────────────────────────────────────────

function checkClips(): void {
  const S = 'clips';
  const names = Object.keys(CLIPS);

  for (const name of names) {
    const clip = CLIPS[name];
    const at = `CLIPS[${fmt(name)}]`;

    if (clip.name !== name) {
      err(S, at, `registered under ${fmt(name)} but its own name is ${fmt(clip.name)}`);
    }
    if (!isNum(clip.duration) || clip.duration <= 0) {
      err(S, at, `duration must be a positive number, got ${fmt(clip.duration)}`);
    }
    if (!Array.isArray(clip.frames) || clip.frames.length === 0) {
      err(S, at, 'has no keyframes');
      continue;
    }

    let prev = -Infinity;
    clip.frames.forEach((kf, i) => {
      const kat = `${at}.frames[${i}]`;
      if (!isNum(kf.t) || kf.t < 0) {
        err(S, kat, `keyframe time must be >= 0, got ${fmt(kf.t)}`);
      } else if (kf.t > clip.duration) {
        err(S, kat, `keyframe at t=${kf.t} is past the clip duration of ${clip.duration}`);
      }
      if (isNum(kf.t) && kf.t < prev) {
        err(S, kat, `keyframes must be in ascending time order (t=${kf.t} follows t=${prev})`);
      }
      if (isNum(kf.t)) prev = kf.t;
      if (!kf.pose || typeof kf.pose !== 'object') {
        err(S, kat, 'keyframe has no pose');
      }
    });
  }

  for (const name of REQUIRED_CLIPS) {
    if (!has(CLIPS, name)) {
      err(S, `CLIPS[${fmt(name)}]`, 'required clip is not registered (see ARCHITECTURE.md)');
    }
  }

  stat('animation clips', `${names.length} registered, ${REQUIRED_CLIPS.length} required present`);
}

function checkMoveDef(id: string, m: MoveDef): void {
  const S = 'moves';
  const at = `MOVES[${fmt(id)}]`;

  if (m.id !== id) {
    err(S, at, `registered under ${fmt(id)} but its own id is ${fmt(m.id)}`);
  }
  if (!nonEmpty(m.name)) {
    err(S, at, 'has no display name');
  }

  const dur = m.duration;
  if (!isInt(dur) || dur <= 0) {
    err(S, at, `duration must be a positive whole number of frames, got ${fmt(dur)}`);
  }

  if (!isInt(m.startup) || m.startup < 0) {
    err(S, at, `startup must be a frame count >= 0, got ${fmt(m.startup)}`);
  } else if (isInt(dur) && m.startup >= dur) {
    err(S, at, `startup ${m.startup} is not inside the move (duration ${dur})`);
  }

  // The animation reference is the second untyped string in every move.
  if (!nonEmpty(m.anim)) {
    err(S, at, 'has no anim clip name');
  } else if (!has(CLIPS, m.anim)) {
    err(S, at, `anim ${fmt(m.anim)} is not a registered clip in render/rig/Anim.ts`);
  }

  if (!Array.isArray(m.windows)) {
    err(S, at, 'windows must be an array');
    return;
  }

  m.windows.forEach((w, i) => {
    const wat = `${at}.windows[${i}]`;

    if (!isInt(w.start) || w.start < 0) {
      err(S, wat, `start must be a frame >= 0, got ${fmt(w.start)}`);
    }
    if (!isInt(w.end)) {
      err(S, wat, `end must be a frame number, got ${fmt(w.end)}`);
    }
    if (isInt(w.start) && isInt(w.end) && w.end < w.start) {
      err(S, wat, `ends on frame ${w.end}, before it starts on frame ${w.start}`);
    }
    // A move runs frames 0..duration-1 (Fighter.tickMove), so a window that
    // reaches `duration` can never fully fire — free frames of nothing.
    if (isInt(w.end) && isInt(dur) && w.end >= dur) {
      err(
        S,
        wat,
        `hit window runs to frame ${w.end} but the move is only ${dur} frames long ` +
          `(live frames are 0..${dur - 1})`,
      );
    }

    const b = w.box;
    if (!b) {
      err(S, wat, 'has no hitbox');
    } else if (!(isNum(b.hw) && b.hw > 0) || !(isNum(b.hh) && b.hh > 0) || !(isNum(b.hd) && b.hd > 0)) {
      err(S, wat, `hitbox half-extents must all be positive, got hw=${fmt(b.hw)} hh=${fmt(b.hh)} hd=${fmt(b.hd)}`);
    }

    const p = w.props;
    if (!p) {
      err(S, wat, 'has no hit properties');
      return;
    }
    if (!isNum(p.damage) || p.damage < 0) err(S, wat, `damage must be >= 0, got ${fmt(p.damage)}`);
    if (!isNum(p.hitstun) || p.hitstun < 0) err(S, wat, `hitstun must be >= 0, got ${fmt(p.hitstun)}`);
    if (!isNum(p.blockstun) || p.blockstun < 0) {
      err(S, wat, `blockstun must be >= 0, got ${fmt(p.blockstun)}`);
    }
    if (!isNum(p.hitstop) || p.hitstop < 0) err(S, wat, `hitstop must be >= 0, got ${fmt(p.hitstop)}`);
    if (!inRange(p.chip, 0, 1)) err(S, wat, `chip must be a fraction 0..1, got ${fmt(p.chip)}`);
    if (!isNum(p.meterGain) || p.meterGain < 0) {
      err(S, wat, `meterGain must be >= 0, got ${fmt(p.meterGain)}`);
    }
    if (isNum(p.hitstun) && isNum(p.blockstun) && p.blockstun > p.hitstun) {
      warn(
        S,
        wat,
        `blockstun ${p.blockstun} exceeds hitstun ${p.hitstun}; blocking is supposed to buy ` +
          'the defender their turn back (Moves.ts house rules)',
      );
    }
  });

  if (m.windows.length > 0 && isInt(m.startup)) {
    const first = m.windows.reduce((lo, w) => Math.min(lo, w.start), Infinity);
    if (isInt(first) && first !== m.startup) {
      warn(S, at, `startup is ${m.startup} but the first hit window opens on frame ${first}`);
    }
  }

  for (const mo of m.motion ?? []) {
    if (!isInt(mo.frame) || mo.frame < 0 || (isInt(dur) && mo.frame >= dur)) {
      err(S, at, `motion impulse on frame ${fmt(mo.frame)} is outside the move (0..${isInt(dur) ? dur - 1 : '?'})`);
    }
  }

  if (m.invuln) {
    const iv = m.invuln;
    if (!isInt(iv.start) || !isInt(iv.end) || iv.start < 0 || iv.end < iv.start) {
      err(S, at, `invuln window {start:${fmt(iv.start)}, end:${fmt(iv.end)}} is not a valid frame range`);
    } else if (isInt(dur) && iv.end >= dur) {
      err(S, at, `invuln window runs to frame ${iv.end} but the move is only ${dur} frames long`);
    }
  }

  if (m.meterCost !== undefined && (!isNum(m.meterCost) || m.meterCost < 0)) {
    err(S, at, `meterCost must be >= 0, got ${fmt(m.meterCost)}`);
  }

  if (m.weapon !== undefined && !has(WEAPONS, m.weapon)) {
    err(S, at, `weapon ${fmt(m.weapon)} is not a defined weapon`);
  }

  // Cancel targets are move ids too, and dangle just as silently.
  (m.cancels ?? []).forEach((rule, ri) => {
    if (!isInt(rule.from) || rule.from < 0 || (isInt(dur) && rule.from >= dur)) {
      err(S, `${at}.cancels[${ri}]`, `cancel window opens on frame ${fmt(rule.from)}, outside the move`);
    }
    if (!Array.isArray(rule.into)) {
      err(S, `${at}.cancels[${ri}]`, 'cancel rule has no target list');
      return;
    }
    rule.into.forEach((target, ti) => {
      refMove(target, `${at}.cancels[${ri}].into[${ti}]`);
    });
  });
}

function checkMoves(): void {
  const ids = Object.keys(MOVES);
  for (const id of ids) checkMoveDef(id, MOVES[id]);

  const windows = ids.reduce((n, id) => n + (MOVES[id].windows?.length ?? 0), 0);
  stat('move definitions', `${ids.length} moves, ${windows} hit windows, frame data + anim refs`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dwarfs
// ─────────────────────────────────────────────────────────────────────────────

function checkDwarfs(): void {
  const S = 'dwarfs';

  if (DWARFS.length !== DWARF_ROSTER.length) {
    err(S, 'DWARFS', `expected ${DWARF_ROSTER.length} dwarfs, found ${DWARFS.length}`);
  }

  const seen = new Set<string>();
  const superIds = new Set<string>();

  DWARFS.forEach((d, i) => {
    const at = `DWARFS[${i}] (${fmt(d.id)})`;

    if (!nonEmpty(d.id)) err(S, at, 'has no id');
    if (seen.has(d.id)) err(S, at, `duplicate dwarf id ${fmt(d.id)}`);
    seen.add(d.id);

    if (!nonEmpty(d.name)) err(S, at, 'has no bad-boy name');
    if (!nonEmpty(d.bornAs)) err(S, at, 'has no bornAs (the classic film name)');
    if (!nonEmpty(d.tagline)) err(S, at, 'has no tagline');
    if (!nonEmpty(d.bio)) err(S, at, 'has no bio');

    try {
      if (getDwarf(d.id) !== d) err(S, at, `getDwarf(${fmt(d.id)}) does not return this definition`);
    } catch {
      err(S, at, `getDwarf(${fmt(d.id)}) throws — the lookup index is out of sync with DWARFS`);
    }

    const st = d.stats;
    for (const key of ['health', 'speed', 'jump', 'power', 'tech'] as const) {
      if (!isNum(st?.[key]) || st[key] <= 0) {
        err(S, `${at}.stats.${key}`, `must be a positive number, got ${fmt(st?.[key])}`);
      }
    }

    // The select-screen transformation is the whole gag: every dwarf must start
    // in the 1937 outfit and be tweened to 1 by SelectScene.
    if (d.style?.outfit !== 0) {
      err(
        S,
        `${at}.style.outfit`,
        `must be 0 so the select-screen transformation has somewhere to start, got ${fmt(d.style?.outfit)}`,
      );
    }
    if (!isNum(d.style?.scale) || d.style.scale <= 0) {
      err(S, `${at}.style.scale`, `must be positive, got ${fmt(d.style?.scale)}`);
    }

    if (!has(WEAPONS, d.signatureWeapon)) {
      err(S, `${at}.signatureWeapon`, `${fmt(d.signatureWeapon)} is not a defined weapon`);
    }

    const sp = d.super;
    if (!sp) {
      err(S, `${at}.super`, 'has no super power');
    } else {
      const sat = `${at}.super`;
      if (!nonEmpty(sp.id)) err(S, sat, 'has no id');
      if (superIds.has(sp.id)) err(S, sat, `duplicate super id ${fmt(sp.id)}`);
      superIds.add(sp.id);
      if (!nonEmpty(sp.name)) err(S, sat, 'has no name');
      if (!nonEmpty(sp.description)) err(S, sat, 'has no description');
      if (!isInt(sp.duration) || sp.duration <= 0) {
        err(S, sat, `duration must be a positive frame count, got ${fmt(sp.duration)}`);
      }
      if (!isNum(sp.damage) || sp.damage <= 0) {
        err(S, sat, `damage must be positive, got ${fmt(sp.damage)}`);
      }
      if (!isNum(sp.radius) || (sp.radius !== -1 && sp.radius <= 0)) {
        err(S, sat, `radius must be positive or exactly -1 for full screen, got ${fmt(sp.radius)}`);
      }
      if (!SUPER_VISUALS.includes(sp.visual)) {
        err(S, sat, `visual ${fmt(sp.visual)} has no bespoke renderer`);
      }
    }

    if (!isNum(d.voice?.pitch) || d.voice.pitch <= 0) {
      err(S, `${at}.voice.pitch`, `must be a positive frequency, got ${fmt(d.voice?.pitch)}`);
    }

    // The seven untyped move references that started all of this.
    const slots = ['light', 'heavy', 'special', 'airLight', 'airHeavy', 'grab', 'dashAttack'] as const;
    for (const slot of slots) {
      refMove(d.moves?.[slot], `DWARFS[${fmt(d.id)}].moves.${slot}`);
    }
  });

  for (const id of DWARF_ROSTER) {
    if (!seen.has(id)) err(S, 'DWARFS', `roster is missing the dwarf ${fmt(id)}`);
  }
  for (const id of seen) {
    if (!DWARF_ROSTER.includes(id)) err(S, 'DWARFS', `unexpected dwarf id ${fmt(id)} on the roster`);
  }

  // Two dwarfs sharing a normal is the exact symptom of the bug this file is
  // named after: it makes seven characters play identically.
  const byNormal = new Map<string, string[]>();
  for (const d of DWARFS) {
    for (const slot of ['light', 'heavy'] as const) {
      const id = d.moves?.[slot];
      if (!nonEmpty(id)) continue;
      const key = `${slot}:${id}`;
      const list = byNormal.get(key) ?? [];
      list.push(d.id);
      byNormal.set(key, list);
    }
  }
  for (const [key, owners] of byNormal) {
    if (owners.length < 2) continue;
    const [slot, id] = key.split(':');
    err(
      S,
      'DWARFS',
      `${owners.length} dwarfs (${owners.join(', ')}) share the same ${slot} normal ${fmt(id)} — ` +
        'each dwarf owns a bespoke <id>_light / <id>_heavy',
    );
  }

  stat('dwarfs', `${DWARFS.length} on the roster, outfit/super/weapon + ${DWARFS.length * 7} move slots`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Enemies
// ─────────────────────────────────────────────────────────────────────────────

function checkEnemies(): void {
  const S = 'enemies';
  const keys = Object.keys(ENEMIES);

  for (const kind of ENEMY_KINDS) {
    if (!has(ENEMIES, kind)) err(S, 'ENEMIES', `no definition for enemy kind ${fmt(kind)}`);
  }
  for (const key of keys) {
    if (!(ENEMY_KINDS as readonly string[]).includes(key)) {
      err(S, 'ENEMIES', `${fmt(key)} is not a declared EnemyKind`);
    }
  }

  let moveSlots = 0;

  for (const key of keys) {
    const e = ENEMIES[key as EnemyKind];
    const at = `ENEMIES[${fmt(key)}]`;

    if (e.id !== key) err(S, at, `keyed as ${fmt(key)} but its own id is ${fmt(e.id)}`);
    if (!nonEmpty(e.name)) err(S, at, 'has no display name');
    if (!isNum(e.health) || e.health <= 0) err(S, at, `health must be positive, got ${fmt(e.health)}`);
    if (!isNum(e.speed) || e.speed <= 0) err(S, at, `speed must be positive, got ${fmt(e.speed)}`);
    if (!isNum(e.power) || e.power <= 0) err(S, at, `power must be positive, got ${fmt(e.power)}`);
    if (!inRange(e.aggression, 0, 1)) err(S, at, `aggression must be 0..1, got ${fmt(e.aggression)}`);
    if (!isNum(e.spacing) || e.spacing <= 0) err(S, at, `spacing must be positive, got ${fmt(e.spacing)}`);
    if (!isNum(e.points) || e.points < 0) err(S, at, `points must be >= 0, got ${fmt(e.points)}`);

    if (e.weapon !== undefined && !has(WEAPONS, e.weapon)) {
      err(S, `${at}.weapon`, `${fmt(e.weapon)} is not a defined weapon`);
    }

    // Nobody on the payroll gets a transformation scene.
    if (e.style?.outfit !== 1) {
      warn(S, `${at}.style.outfit`, `should be 1 for enemies, got ${fmt(e.style?.outfit)}`);
    }

    const ai = e.ai;
    if (!ai) {
      err(S, `${at}.ai`, 'has no AI profile');
    } else {
      if (!isInt(ai.reactionFrames) || ai.reactionFrames <= 0) {
        err(S, `${at}.ai.reactionFrames`, `must be a positive frame count, got ${fmt(ai.reactionFrames)}`);
      }
      for (const key2 of ['blockSkill', 'comboSkill', 'swarm'] as const) {
        if (!inRange(ai[key2], 0, 1)) {
          err(S, `${at}.ai.${key2}`, `must be 0..1, got ${fmt(ai[key2])}`);
        }
      }
      if (!AI_BEHAVIOURS.includes(ai.behaviour)) {
        err(S, `${at}.ai.behaviour`, `${fmt(ai.behaviour)} is not an implemented behaviour`);
      }
    }

    if (!e.moves || !nonEmpty(e.moves.light)) {
      err(S, `${at}.moves.light`, 'every enemy needs at least a light attack');
    }
    for (const slot of ['light', 'heavy', 'ranged'] as const) {
      const id = e.moves?.[slot];
      if (id === undefined) continue;
      moveSlots++;
      refMove(id, `${at}.moves.${slot}`);
    }
  }

  stat('enemies', `${keys.length} kinds, stats + AI profiles + ${moveSlots} move slots`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

function checkWeapons(): void {
  const S = 'weapons';
  const keys = Object.keys(WEAPONS);

  for (const kind of WEAPON_KINDS) {
    if (!has(WEAPONS, kind)) err(S, 'WEAPONS', `no definition for weapon kind ${fmt(kind)}`);
  }
  for (const key of keys) {
    if (!(WEAPON_KINDS as readonly string[]).includes(key)) {
      err(S, 'WEAPONS', `${fmt(key)} is not a declared WeaponKind`);
    }
  }

  let moveSlots = 0;

  for (const key of keys) {
    const w = WEAPONS[key as WeaponKind];
    const at = `WEAPONS[${fmt(key)}]`;

    if (w.kind !== key) err(S, at, `keyed as ${fmt(key)} but its own kind is ${fmt(w.kind)}`);
    if (!nonEmpty(w.name)) err(S, at, 'has no display name');
    if (!isInt(w.durability) || (w.durability !== -1 && w.durability <= 0)) {
      err(S, at, `durability must be a positive hit count or exactly -1, got ${fmt(w.durability)}`);
    }
    if (!isNum(w.damageScale) || w.damageScale <= 0) {
      err(S, at, `damageScale must be positive, got ${fmt(w.damageScale)}`);
    }
    if (!isNum(w.speedScale) || w.speedScale <= 0) {
      err(S, at, `speedScale must be positive, got ${fmt(w.speedScale)}`);
    }
    if (w.ammo !== undefined && (!isInt(w.ammo) || w.ammo <= 0)) {
      err(S, at, `ammo must be a positive round count when present, got ${fmt(w.ammo)}`);
    }

    const art = w.art;
    if (!art) {
      err(S, `${at}.art`, 'has no vector art parameters');
    } else {
      if (!WEAPON_SHAPES.includes(art.shape)) {
        err(S, `${at}.art.shape`, `${fmt(art.shape)} is not a silhouette drawWeapon implements`);
      }
      if (!isNum(art.length) || art.length <= 0) {
        err(S, `${at}.art.length`, `must be positive, got ${fmt(art.length)}`);
      }
      if (!isNum(art.thickness) || art.thickness <= 0) {
        err(S, `${at}.art.thickness`, `must be positive, got ${fmt(art.thickness)}`);
      }
    }

    for (const slot of ['light', 'heavy', 'throw'] as const) {
      const id = w.moves?.[slot];
      if (id === undefined) continue;
      moveSlots++;
      refMove(id, `${at}.moves.${slot}`);
    }
    if (!w.moves || !nonEmpty(w.moves.light) || !nonEmpty(w.moves.heavy)) {
      err(S, `${at}.moves`, 'a weapon must replace both the light and the heavy normal');
    }
  }

  stat('weapons', `${keys.length} kinds, art + durability + ${moveSlots} move slots`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bosses
// ─────────────────────────────────────────────────────────────────────────────

function checkBosses(): Map<string, BossDef> {
  const S = 'bosses';
  const byId = new Map<string, BossDef>();
  const byMap = new Map<number, BossDef>();

  if (BOSSES.length !== TOTAL_BOSSES) {
    err(
      S,
      'BOSSES',
      `expected TOTAL_MAPS / BOSS_EVERY = ${TOTAL_MAPS} / ${BOSS_EVERY} = ${TOTAL_BOSSES} bosses, ` +
        `found ${BOSSES.length}`,
    );
  }

  let phaseCount = 0;
  let phaseMoveRefs = 0;

  BOSSES.forEach((b, i) => {
    const at = `BOSSES[${i}] (${fmt(b.id)})`;

    if (!nonEmpty(b.id)) err(S, at, 'has no id');
    if (byId.has(b.id)) err(S, at, `duplicate boss id ${fmt(b.id)}`);
    byId.set(b.id, b);

    if (!nonEmpty(b.name)) err(S, at, 'has no display name');
    if (!nonEmpty(b.quote)) err(S, at, 'has no title-card quote');

    if (!isInt(b.atMap) || b.atMap < 1 || b.atMap > TOTAL_MAPS) {
      err(S, `${at}.atMap`, `must be a map index 1..${TOTAL_MAPS}, got ${fmt(b.atMap)}`);
    } else {
      if (b.atMap % BOSS_EVERY !== 0) {
        err(S, `${at}.atMap`, `map ${b.atMap} is not a boss map (a boss guards every ${BOSS_EVERY}th map)`);
      }
      if (byMap.has(b.atMap)) {
        err(S, `${at}.atMap`, `two bosses both claim map ${b.atMap} (${fmt(byMap.get(b.atMap)!.id)} and ${fmt(b.id)})`);
      }
      byMap.set(b.atMap, b);
    }

    if (!isNum(b.health) || b.health <= 0) {
      err(S, `${at}.health`, `must be positive, got ${fmt(b.health)}`);
    }
    if (!isNum(b.points) || b.points < 0) {
      err(S, `${at}.points`, `must be >= 0, got ${fmt(b.points)}`);
    }
    if (b.rigOverride !== undefined && !RIG_OVERRIDES.includes(b.rigOverride)) {
      err(S, `${at}.rigOverride`, `${fmt(b.rigOverride)} has no bespoke renderer`);
    }
    if (!MUSIC_MOODS.includes(b.music)) {
      err(S, `${at}.music`, `${fmt(b.music)} is not a MusicMood the synth implements`);
    }

    if (!Array.isArray(b.phases) || b.phases.length === 0) {
      err(S, `${at}.phases`, 'a boss must have at least one phase');
      return;
    }

    let prevThreshold = Infinity;
    b.phases.forEach((ph, pi) => {
      phaseCount++;
      const pat = `BOSSES[${fmt(b.id)}].phases[${pi}]`;

      if (!inRange(ph.healthThreshold, 0, 1)) {
        err(S, `${pat}.healthThreshold`, `must be a fraction 0..1, got ${fmt(ph.healthThreshold)}`);
      } else if (ph.healthThreshold >= prevThreshold) {
        // Level.advancePhase() walks phases in order and only ever steps
        // forward, so a threshold that does not strictly decrease makes this
        // phase and everything after it unreachable.
        err(
          S,
          `${pat}.healthThreshold`,
          `${ph.healthThreshold} does not drop below the previous phase's ${prevThreshold} — ` +
            'this phase can never be entered',
        );
      }
      if (isNum(ph.healthThreshold)) prevThreshold = ph.healthThreshold;

      if (!inRange(ph.aggression, 0, 1)) {
        err(S, `${pat}.aggression`, `must be 0..1, got ${fmt(ph.aggression)}`);
      }

      if (!Array.isArray(ph.moves) || ph.moves.length === 0) {
        err(S, `${pat}.moves`, 'a phase with no moves leaves the boss standing there');
      } else {
        ph.moves.forEach((id, mi) => {
          phaseMoveRefs++;
          refMove(id, `${pat}.moves[${mi}]`);
        });
      }

      (ph.spawns ?? []).forEach((sp, si) => {
        if (!has(ENEMIES, sp.kind)) {
          err(S, `${pat}.spawns[${si}]`, `enemy kind ${fmt(sp.kind)} is not defined`);
        }
        if (!isInt(sp.count) || sp.count <= 0) {
          err(S, `${pat}.spawns[${si}]`, `count must be a positive whole number, got ${fmt(sp.count)}`);
        }
      });
    });

    if (b.phases[0] && isNum(b.phases[0].healthThreshold) && b.phases[0].healthThreshold < 1) {
      warn(
        S,
        `BOSSES[${fmt(b.id)}].phases[0].healthThreshold`,
        `is ${b.phases[0].healthThreshold}; phase 0 is entered at full health regardless, so 1.0 reads clearer`,
      );
    }
  });

  stat('bosses', `${BOSSES.length}/${TOTAL_BOSSES}, ${phaseCount} phases, ${phaseMoveRefs} phase move refs`);
  return byId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Maps, and the boss cadence across them
// ─────────────────────────────────────────────────────────────────────────────

function checkMaps(bossesById: Map<string, BossDef>): void {
  const S = 'maps';

  if (MAPS.length !== TOTAL_MAPS) {
    err(S, 'MAPS', `expected TOTAL_MAPS = ${TOTAL_MAPS} entries, found ${MAPS.length}`);
  }

  const byIndex = new Map<number, number>(); // map index -> position in MAPS
  let waveCount = 0;
  let enemyRefs = 0;
  let propCount = 0;
  let bossMaps = 0;

  MAPS.forEach((m, i) => {
    const at = `MAPS[${i}] (index ${fmt(m.index)})`;

    if (!isInt(m.index) || m.index < 1 || m.index > TOTAL_MAPS) {
      err(S, at, `index must be a whole number 1..${TOTAL_MAPS}, got ${fmt(m.index)}`);
    } else if (byIndex.has(m.index)) {
      err(S, at, `duplicate map index ${m.index} (already used by MAPS[${byIndex.get(m.index)}])`);
    } else {
      byIndex.set(m.index, i);
      if (m.index !== i + 1) {
        err(S, at, `MAPS must be stored in index order: position ${i} holds index ${m.index}`);
      }
    }

    if (!nonEmpty(m.name)) err(S, at, 'has no name');
    if (!isNum(m.width) || m.width <= 0) err(S, at, `width must be positive, got ${fmt(m.width)}`);
    if (!isNum(m.depth) || m.depth <= 0) err(S, at, `depth must be positive, got ${fmt(m.depth)}`);
    if (!MAP_THEMES.includes(m.theme)) err(S, `${at}.theme`, `${fmt(m.theme)} is not a MapTheme`);
    if (!MUSIC_MOODS.includes(m.music)) err(S, `${at}.music`, `${fmt(m.music)} is not a MusicMood`);

    if (!m.palette) {
      err(S, `${at}.palette`, 'has no palette; the procedural backdrop cannot draw');
    }

    // ── waves ────────────────────────────────────────────────────────────────
    if (!Array.isArray(m.waves) || m.waves.length === 0) {
      err(S, `${at}.waves`, 'a map needs at least one wave of enemies');
    } else {
      m.waves.forEach((w, wi) => {
        waveCount++;
        const wat = `MAPS[index ${m.index}].waves[${wi}]`;

        if (!inRange(w.at, 0, 1)) {
          err(S, `${wat}.at`, `trigger position must be a fraction 0..1 of the map width, got ${fmt(w.at)}`);
        }

        if (!Array.isArray(w.enemies) || w.enemies.length === 0) {
          err(S, `${wat}.enemies`, 'wave spawns nothing');
        } else {
          w.enemies.forEach((g, gi) => {
            enemyRefs++;
            if (!has(ENEMIES, g.kind)) {
              err(S, `${wat}.enemies[${gi}]`, `enemy kind ${fmt(g.kind)} is not defined in content/enemies.ts`);
            }
            if (!isInt(g.count) || g.count <= 0) {
              err(S, `${wat}.enemies[${gi}]`, `count must be a positive whole number, got ${fmt(g.count)}`);
            }
          });
        }

        const r = w.reward;
        if (r) {
          if (r.weapon !== undefined && !has(WEAPONS, r.weapon)) {
            err(S, `${wat}.reward.weapon`, `${fmt(r.weapon)} is not a defined weapon`);
          }
          if (r.health !== undefined && (!isNum(r.health) || r.health <= 0)) {
            err(S, `${wat}.reward.health`, `must be positive when present, got ${fmt(r.health)}`);
          }
          if (r.meter !== undefined && (!isNum(r.meter) || r.meter <= 0)) {
            err(S, `${wat}.reward.meter`, `must be positive when present, got ${fmt(r.meter)}`);
          }
        }
      });

      // Waves are cleared in order, so their trigger points must march forward.
      let prevAt = -Infinity;
      m.waves.forEach((w, wi) => {
        if (isNum(w.at) && w.at < prevAt) {
          warn(
            S,
            `MAPS[index ${m.index}].waves[${wi}].at`,
            `${w.at} is behind the previous wave's ${prevAt}; waves trigger in array order`,
          );
        }
        if (isNum(w.at)) prevAt = w.at;
      });
    }

    // ── props ────────────────────────────────────────────────────────────────
    (m.props ?? []).forEach((p, pi) => {
      propCount++;
      const pat = `MAPS[index ${m.index}].props[${pi}]`;
      if (!PROP_KINDS.includes(p.kind)) err(S, `${pat}.kind`, `${fmt(p.kind)} is not a drawable prop`);
      if (!isNum(p.health) || p.health <= 0) err(S, pat, `health must be positive, got ${fmt(p.health)}`);
      if (isNum(m.width) && (!isNum(p.x) || p.x < 0 || p.x > m.width)) {
        err(S, `${pat}.x`, `${fmt(p.x)} is outside the map (0..${m.width})`);
      }
      if (isNum(m.depth) && (!isNum(p.z) || p.z < 0 || p.z > m.depth)) {
        err(S, `${pat}.z`, `${fmt(p.z)} is outside the walkable band (0..${m.depth})`);
      }
      if (p.drop?.weapon !== undefined && !has(WEAPONS, p.drop.weapon)) {
        err(S, `${pat}.drop.weapon`, `${fmt(p.drop.weapon)} is not a defined weapon`);
      }
      if (p.drop?.health !== undefined && (!isNum(p.drop.health) || p.drop.health <= 0)) {
        err(S, `${pat}.drop.health`, `must be positive when present, got ${fmt(p.drop.health)}`);
      }
    });

    // ── vehicle section ──────────────────────────────────────────────────────
    if (m.vehicle) {
      const vat = `MAPS[index ${m.index}].vehicle`;
      if (!VEHICLE_KINDS.includes(m.vehicle.kind)) {
        err(S, `${vat}.kind`, `${fmt(m.vehicle.kind)} is not a rideable vehicle`);
      }
      if (!inRange(m.vehicle.from, 0, 1) || !inRange(m.vehicle.to, 0, 1)) {
        err(S, vat, `from/to must be fractions 0..1, got ${fmt(m.vehicle.from)}..${fmt(m.vehicle.to)}`);
      } else if (m.vehicle.from >= m.vehicle.to) {
        err(S, vat, `empty stretch: from ${m.vehicle.from} is not before to ${m.vehicle.to}`);
      }
    }

    // ── boss cadence ─────────────────────────────────────────────────────────
    const shouldHaveBoss = isInt(m.index) && m.index % BOSS_EVERY === 0;
    const hasBoss = m.boss !== undefined;
    if (hasBoss) bossMaps++;

    if (hasBoss && !bossesById.has(m.boss!)) {
      err(S, `${at}.boss`, `references boss ${fmt(m.boss)}, which is not defined in content/bosses.ts`);
    }
    if (hasBoss && !shouldHaveBoss) {
      err(S, `${at}.boss`, `map ${m.index} has a boss but only every ${BOSS_EVERY}th map may`);
    }
    if (!hasBoss && shouldHaveBoss) {
      err(S, at, `map ${m.index} is a multiple of BOSS_EVERY=${BOSS_EVERY} but has no boss`);
    }
    if (hasBoss && bossesById.has(m.boss!)) {
      const b = bossesById.get(m.boss!)!;
      if (b.atMap !== m.index) {
        err(S, `${at}.boss`, `map ${m.index} hosts ${fmt(b.id)}, but that boss declares atMap ${b.atMap}`);
      }
    }
  });

  // Every index present exactly once, no gaps.
  for (let i = 1; i <= TOTAL_MAPS; i++) {
    if (!byIndex.has(i)) err(S, 'MAPS', `no map with index ${i}`);
  }

  // getMap() must agree with the array it indexes.
  for (let i = 1; i <= TOTAL_MAPS; i++) {
    const pos = byIndex.get(i);
    if (pos === undefined) continue;
    if (getMap(i) !== MAPS[pos]) {
      err(S, `getMap(${i})`, 'does not return the map with that index');
    }
  }

  // bossForMap() is a second, independent answer to "where are the bosses"; the
  // two must not be allowed to drift apart.
  for (let i = 1; i <= TOTAL_MAPS; i++) {
    const expected = i % BOSS_EVERY === 0;
    const b = bossForMap(i);
    const pos = byIndex.get(i);
    const mapBoss = pos === undefined ? undefined : MAPS[pos].boss;

    if (expected && !b) {
      err('bosses', `bossForMap(${i})`, `returned null, but map ${i} is a boss map`);
    }
    if (!expected && b) {
      err('bosses', `bossForMap(${i})`, `returned ${fmt(b.id)}, but map ${i} is not a boss map`);
    }
    if (b && mapBoss !== undefined && b.id !== mapBoss) {
      err(
        'bosses',
        `bossForMap(${i})`,
        `returned ${fmt(b.id)} but MAPS[index ${i}].boss is ${fmt(mapBoss)}`,
      );
    }
    if (b && b.atMap !== i) {
      err('bosses', `bossForMap(${i})`, `returned ${fmt(b.id)}, whose atMap is ${b.atMap}`);
    }
  }

  const expectedBossMaps = Math.floor(TOTAL_MAPS / BOSS_EVERY);
  if (bossMaps !== expectedBossMaps) {
    err(S, 'MAPS', `expected ${expectedBossMaps} maps carrying a boss, found ${bossMaps}`);
  }

  stat('maps', `${MAPS.length}/${TOTAL_MAPS}, indices 1..${TOTAL_MAPS} unique`);
  stat('waves', `${waveCount} waves, ${enemyRefs} enemy-kind refs, trigger points 0..1`);
  stat('props & vehicles', `${propCount} props, drops + bounds`);
  stat('boss placement', `${bossMaps} boss maps (every ${BOSS_EVERY}th), cross-checked against bossForMap()`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the move reference graph — the check that catches the whole bug class
// ─────────────────────────────────────────────────────────────────────────────

function resolveMoveRefs(): void {
  const S = 'move-refs';

  const missing = new Map<string, string[]>();
  const blank: string[] = [];
  const used = new Set<string>();

  for (const ref of moveRefs) {
    if (!nonEmpty(ref.id)) {
      blank.push(ref.where);
      continue;
    }
    if (has(MOVES, ref.id)) {
      used.add(ref.id);
      continue;
    }
    const sites = missing.get(ref.id) ?? [];
    sites.push(ref.where);
    missing.set(ref.id, sites);
  }

  for (const where of blank) {
    err(S, where, 'move slot is empty — every slot must name a real move');
  }

  // Sorted so the report is stable run to run and diffable in CI logs.
  for (const id of [...missing.keys()].sort()) {
    const sites = missing.get(id)!;
    err(
      S,
      `move ${fmt(id)}`,
      `is referenced ${sites.length} time${sites.length === 1 ? '' : 's'} but is not defined in ` +
        `game/combat/Moves.ts — getMove() would silently substitute a stock poke:\n` +
        sites.map((s) => `        · ${s}`).join('\n'),
    );
  }

  // Not a failure — a move can legitimately exist only as a combo target — but
  // it is how a renamed-and-orphaned move (light_punch, heavy_punch) surfaces.
  const orphans = Object.keys(MOVES)
    .filter((id) => !used.has(id))
    .sort();
  if (orphans.length > 0) {
    warn(
      S,
      'MOVES',
      `${orphans.length} defined move${orphans.length === 1 ? '' : 's'} nothing references: ` +
        orphans.map((o) => fmt(o)).join(', '),
    );
  }

  stat(
    'move references',
    `${moveRefs.length} refs from dwarfs, enemies, weapons, boss phases and cancel rules → ` +
      `${used.size}/${Object.keys(MOVES).length} moves reached`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, s: string): string {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}

const red = (s: string) => paint('31;1', s);
const green = (s: string) => paint('32;1', s);
const yellow = (s: string) => paint('33', s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

const SECTION_ORDER = [
  'move-refs',
  'moves',
  'clips',
  'dwarfs',
  'enemies',
  'weapons',
  'bosses',
  'maps',
];

const SECTION_TITLES: Record<string, string> = {
  'move-refs': 'DANGLING MOVE REFERENCES',
  moves: 'MOVE DEFINITIONS',
  clips: 'ANIMATION CLIPS',
  dwarfs: 'DWARFS',
  enemies: 'ENEMIES',
  weapons: 'WEAPONS',
  bosses: 'BOSSES',
  maps: 'MAPS',
};

function report(): number {
  const line = '─'.repeat(78);
  const out: string[] = [];

  out.push('');
  out.push(bold('Mountain Fighters — content integrity'));
  out.push(dim(line));

  const width = checked.reduce((w, c) => Math.max(w, c.label.length), 0);
  for (const c of checked) {
    out.push(`  ${c.label.padEnd(width)}  ${dim(c.detail)}`);
  }

  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warn');

  for (const section of SECTION_ORDER) {
    const inSection = problems.filter((p) => p.section === section);
    if (inSection.length === 0) continue;

    out.push('');
    out.push(dim(line));
    const nErr = inSection.filter((p) => p.severity === 'error').length;
    const nWarn = inSection.length - nErr;
    const counts = [
      nErr > 0 ? `${nErr} error${nErr === 1 ? '' : 's'}` : '',
      nWarn > 0 ? `${nWarn} warning${nWarn === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    out.push(`${bold(SECTION_TITLES[section] ?? section.toUpperCase())} ${dim(`(${counts})`)}`);

    // Errors first inside a section; every single one is printed.
    for (const p of [...inSection].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))) {
      const mark = p.severity === 'error' ? red('  ✗') : yellow('  !');
      out.push(`${mark} ${p.where}`);
      out.push(`      ${p.msg}`);
    }
  }

  out.push('');
  out.push(dim(line));

  if (errors.length === 0) {
    const tail = warnings.length > 0 ? dim(` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`) : '';
    out.push(`${green('PASS')}  content is internally consistent${tail}`);
  } else {
    const tail = warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '';
    out.push(`${red('FAIL')}  ${errors.length} problem${errors.length === 1 ? '' : 's'}${tail}`);
    out.push(dim('      Warnings are advisory and do not affect the exit code.'));
  }
  out.push('');

  process.stdout.write(out.join('\n') + '\n');
  return errors.length === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────

function main(): number {
  checkClips();
  checkMoves();
  checkWeapons();
  checkEnemies();
  checkDwarfs();
  const bossesById = checkBosses();
  checkMaps(bossesById);
  // Every producer of a move reference has run by now, so the graph is complete.
  resolveMoveRefs();
  return report();
}

try {
  process.exitCode = main();
} catch (e) {
  process.stdout.write(
    `\n${red('FAIL')}  the validator itself blew up while loading content:\n` +
      `      ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n\n`,
  );
  process.exitCode = 1;
}
