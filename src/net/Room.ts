/**
 * Room ids and invite links.
 *
 * The entire netplay flow is meant to be: host clicks HOST, gets a link, sends
 * it to a friend, friend opens it and picks a dwarf. No accounts, no lobby
 * browser, no six-character code read out over a bad phone line.
 */

import { PEER_PREFIX } from '@/core/constants';

/**
 * Deliberately missing 0/o, 1/l/i so a room id survives being read aloud or
 * re-typed from a screenshot. Lowercase keeps the URL tidy.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const GROUP_LEN = 4;
const GROUPS = 2;

/** Largest multiple of the alphabet size that fits in a byte, for rejection sampling. */
const REJECT_ABOVE = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

function fillRandom(buf: Uint8Array): void {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buf);
    return;
  }
  // Boot-time only, never simulation: a weak fallback is acceptable here.
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
}

/**
 * A short, readable room id prefixed with PEER_PREFIX, e.g. `mtnfight-k7f2-9wq4`.
 * The shape (alphanumeric, dashes only in the middle) is what PeerJS accepts as
 * a peer id, so the room id doubles as the host's peer id.
 */
export function createRoomId(): string {
  const groups: string[] = [];
  const buf = new Uint8Array(GROUP_LEN * GROUPS * 2);
  fillRandom(buf);
  let read = 0;
  for (let g = 0; g < GROUPS; g++) {
    let out = '';
    while (out.length < GROUP_LEN) {
      if (read >= buf.length) {
        fillRandom(buf);
        read = 0;
      }
      const b = buf[read++];
      // Rejection sampling keeps every character equally likely.
      if (b >= REJECT_ABOVE) continue;
      out += ALPHABET[b % ALPHABET.length];
    }
    groups.push(out);
  }
  return PEER_PREFIX + groups.join('-');
}

/**
 * Accepts anything a human might paste — a bare code, a prefixed id, or the
 * whole invite URL — and returns the canonical room id, or null if there is
 * nothing usable in there.
 */
export function normalizeRoomId(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  const marker = s.indexOf('join=');
  if (marker >= 0) s = s.slice(marker + 'join='.length);
  const amp = s.search(/[&#?\s]/);
  if (amp >= 0) s = s.slice(0, amp);

  s = s.replace(/[^a-z0-9_-]/g, '');
  if (s.startsWith(PEER_PREFIX)) s = s.slice(PEER_PREFIX.length);
  s = s.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  if (!s) return null;

  return PEER_PREFIX + s;
}

/** Reads `#join=<id>` out of the current URL. Null when we were not invited. */
export function roomIdFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  const m = /(?:^|[#&/?])join=([^&#]+)/i.exec(location.hash);
  if (!m) return null;
  let raw = m[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Leave it as-is; normalizeRoomId will scrub whatever survived.
  }
  return normalizeRoomId(raw);
}

/** The absolute URL to hand to a friend. Opening it drops them straight in. */
export function inviteLink(roomId: string): string {
  const id = normalizeRoomId(roomId) ?? roomId;
  const base =
    typeof location !== 'undefined' && location.href ? location.href : 'https://localhost/';
  const url = new URL(base);
  url.hash = `join=${encodeURIComponent(id)}`;
  return url.toString();
}

/**
 * Drops the `#join=` fragment without reloading, so a refresh after the room
 * has died does not try to rejoin a corpse.
 */
export function clearRoomFromUrl(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  if (!location.hash) return;
  const url = new URL(location.href);
  url.hash = '';
  history.replaceState(null, '', url.pathname + url.search);
}
