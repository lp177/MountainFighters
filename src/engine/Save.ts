/**
 * Persistent save data.
 *
 * localStorage is treated as hostile: it may be absent, full, disabled by
 * private browsing, or contain garbage written by an older build. Every path
 * through this module degrades to a working default rather than throwing, and
 * a malformed save is repaired field by field instead of being discarded
 * wholesale — losing someone's progress because one number went NaN would be
 * the kind of thing Musk would ship.
 */

import { SAVE_KEY, SAVE_VERSION, TOTAL_MAPS } from '@/core/constants';
import type { SaveData, Settings } from '@/core/types';
import { clamp } from '@/core/math';
import { DEFAULT_BINDINGS, normalizeBindings } from '@/engine/input/Bindings';

type Difficulty = Settings['difficulty'];

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'musk'];

type Gore = Settings['gore'];
const GORE_LEVELS: readonly Gore[] = ['off', 'on', 'max'];

/** Used when localStorage is unavailable, so settings still stick for the session. */
let memory: string | null = null;
let store: Storage | null | undefined;

function storage(): Storage | null {
  if (store !== undefined) return store;
  store = null;
  try {
    const s = window.localStorage;
    const probe = `${SAVE_KEY}.probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    store = s;
  } catch {
    store = null;
  }
  return store;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Copy one slot's key map, dropping anything that is not a number.
 *
 * The order of the keys is not cosmetic and is not the copy's to choose: an
 * action's FIRST code is its primary and its second is the spare, which is what
 * every prompt in the game prints and what the rebinding editor shows in which
 * box. JSON preserves the insertion order of non-numeric string keys in both
 * directions, so the order written last session is the order read this one — and
 * `normalizeBindings` puts a file written by an older build, or by a text
 * editor, into the same defined order rather than trusting it.
 *
 * This does NOT change the persisted shape, which stays
 * `Record<slot, Record<code, bit>>`. Nothing outside this file, and no existing
 * save, has to know.
 */
function cloneSlot(src: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!src) return out;
  for (const code of Object.keys(src)) {
    const bit = src[code];
    if (typeof bit === 'number' && Number.isFinite(bit)) out[code] = bit | 0;
  }
  return normalizeBindings(out);
}

function defaultBindings(): Record<number, Record<string, number>> {
  return {
    0: cloneSlot(DEFAULT_BINDINGS[0]),
    1: cloneSlot(DEFAULT_BINDINGS[1]),
  };
}

function repairBindings(v: unknown): Record<number, Record<string, number>> {
  const out = defaultBindings();
  if (!v || typeof v !== 'object') return out;
  const raw = v as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) continue;
    const map = raw[key];
    if (!map || typeof map !== 'object') continue;
    const cleaned = cloneSlot(map as Record<string, number>);
    if (Object.keys(cleaned).length > 0) out[slot] = cleaned;
  }
  // Slots 0 and 1 must always be playable, whatever the file said.
  if (Object.keys(out[0] ?? {}).length === 0) out[0] = cloneSlot(DEFAULT_BINDINGS[0]);
  if (Object.keys(out[1] ?? {}).length === 0) out[1] = cloneSlot(DEFAULT_BINDINGS[1]);
  return out;
}

export function defaultSettings(): Settings {
  return {
    masterVolume: 0.8,
    sfxVolume: 0.9,
    musicVolume: 0.55,
    screenShake: 1,
    reducedMotion: prefersReducedMotion(),
    showHitboxes: false,
    difficulty: 'normal',
    gore: 'on',
    bindings: defaultBindings(),
  };
}

export function defaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    progress: 1,
    scores: {},
    settings: defaultSettings(),
    cleared: [],
  };
}

function repairSettings(v: unknown): Settings {
  const base = defaultSettings();
  if (!v || typeof v !== 'object') return base;
  const o = v as Record<string, unknown>;
  const difficulty = o['difficulty'];
  const gore = o['gore'];
  return {
    masterVolume: num(o['masterVolume'], base.masterVolume, 0, 1),
    sfxVolume: num(o['sfxVolume'], base.sfxVolume, 0, 1),
    musicVolume: num(o['musicVolume'], base.musicVolume, 0, 1),
    screenShake: num(o['screenShake'], base.screenShake, 0, 2),
    reducedMotion: bool(o['reducedMotion'], base.reducedMotion),
    showHitboxes: bool(o['showHitboxes'], base.showHitboxes),
    difficulty: DIFFICULTIES.includes(difficulty as Difficulty)
      ? (difficulty as Difficulty)
      : base.difficulty,
    gore: GORE_LEVELS.includes(gore as Gore) ? (gore as Gore) : base.gore,
    bindings: repairBindings(o['bindings']),
  };
}

function repairScores(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  const raw = v as Record<string, unknown>;
  for (const id of Object.keys(raw)) {
    const score = raw[id];
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0) {
      out[id] = Math.floor(score);
    }
  }
  return out;
}

function repairCleared(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const id of v) {
    if (typeof id === 'string' && id.length > 0 && id.length < 64) seen.add(id);
  }
  return [...seen];
}

/** Coerce anything at all into a usable SaveData, migrating older versions. */
function migrate(raw: unknown): SaveData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSave();
  const o = raw as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    progress: Math.floor(num(o['progress'], 1, 1, TOTAL_MAPS)),
    scores: repairScores(o['scores']),
    settings: repairSettings(o['settings']),
    cleared: repairCleared(o['cleared']),
  };
}

export function loadSave(): SaveData {
  let text: string | null = null;
  try {
    text = storage()?.getItem(SAVE_KEY) ?? memory;
  } catch {
    text = memory;
  }
  if (!text) return defaultSave();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fresh = defaultSave();
    saveSave(fresh);
    return fresh;
  }

  const data = migrate(parsed);
  const storedVersion =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['version'] : null;
  if (storedVersion !== SAVE_VERSION) saveSave(data);
  return data;
}

export function saveSave(data: SaveData): void {
  let text: string;
  try {
    text = JSON.stringify(migrate(data));
  } catch {
    return;
  }
  memory = text;
  try {
    storage()?.setItem(SAVE_KEY, text);
  } catch {
    // Quota exceeded or storage revoked mid-session: the in-memory copy stands
    // in for the rest of the session and the game carries on.
  }
}
