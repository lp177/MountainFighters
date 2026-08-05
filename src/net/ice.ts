/**
 * ICE server configuration.
 *
 * WHY THIS FILE EXISTS: the game shipped with no iceServers config at all, so
 * PeerJS used its STUN-only default. Two players on one LAN connected fine;
 * two players in different countries got
 *
 *   ICE failed, add a TURN server and see about:webrtc for more details
 *
 * with candidates of type `host` and `srflx` only and not a single `relay`.
 * STUN just tells you your own public address — it cannot help when the NAT
 * refuses inbound packets from an address it has not already sent to, which is
 * what symmetric NAT and carrier-grade NAT both do. On those networks the only
 * thing that works is a TURN server relaying the traffic.
 *
 * CREDENTIALS: anything shipped to a browser is public, so a TURN credential in
 * this bundle is readable by anyone who opens devtools. That is unavoidable for
 * a static site; the mitigation is a dedicated, rate-limited credential rather
 * than pretending it is a secret. It is read from Vite env at build time so it
 * is never committed — see .env.example.
 */

import type { NetConfig } from '@/core/types';

/**
 * Several STUN servers, not one.
 *
 * A single STUN host that is slow or blocked delays or breaks gathering for
 * everyone. These are the well-known free ones; they cost nothing and are only
 * consulted during setup.
 */
const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

function env(key: string): string {
  const v = (import.meta.env as Record<string, unknown>)[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * TURN from build-time env, when configured:
 *   VITE_TURN_URLS      comma-separated, e.g. "turn:turn.example.net:3478?transport=udp,turns:turn.example.net:5349"
 *   VITE_TURN_USERNAME
 *   VITE_TURN_CREDENTIAL
 */
function configuredTurn(): RTCIceServer[] {
  const urls = env('VITE_TURN_URLS');
  const username = env('VITE_TURN_USERNAME');
  const credential = env('VITE_TURN_CREDENTIAL');
  if (!urls || !username || !credential) return [];
  return [{ urls: urls.split(',').map((u) => u.trim()).filter(Boolean), username, credential }];
}

/** True when a relay is actually available, so the UI can be honest about it. */
export function hasRelay(cfg?: NetConfig): boolean {
  const servers = cfg?.iceServers ?? defaultIceServers();
  return servers.some((s) => {
    const u = s.urls;
    const list = Array.isArray(u) ? u : [u];
    return list.some((x) => typeof x === 'string' && x.startsWith('turn'));
  });
}

export function defaultIceServers(): RTCIceServer[] {
  return [...STUN, ...configuredTurn()];
}

/**
 * Where to ask for short-lived TURN credentials.
 *
 * The relay on lp177.fr runs coturn with `use-auth-secret`, so it hands out
 * credentials that expire (username IS the expiry timestamp, credential is an
 * HMAC of it). That is strictly better than baking a static credential into the
 * bundle: the thing a player can read out of devtools stops working in a couple
 * of hours instead of never.
 */
const ICE_ENDPOINT = env('VITE_ICE_ENDPOINT') || 'https://lp177.fr/ice';

interface IceGrant {
  ttl?: number;
  iceServers?: RTCIceServer[];
}

let cached: { servers: RTCIceServer[]; expires: number } | null = null;

/**
 * The ICE servers to actually use, fetching a relay grant when one is
 * available.
 *
 * Never rejects: a relay we could not reach is a worse game, not a broken one,
 * so a failure falls back to STUN and the connection simply has the odds it
 * always had.
 */
export async function resolveIceServers(cfg: NetConfig): Promise<RTCIceServer[]> {
  if (cfg.iceServers && cfg.iceServers.length > 0) return cfg.iceServers;

  // An explicitly configured TURN wins: someone set it deliberately.
  const stat = configuredTurn();
  if (stat.length > 0) return [...STUN, ...stat];

  if (cached && Date.now() < cached.expires) return cached.servers;
  if (!ICE_ENDPOINT) return [...STUN];

  try {
    const res = await fetch(ICE_ENDPOINT, { mode: 'cors', cache: 'no-store' });
    if (!res.ok) return [...STUN];
    const grant = (await res.json()) as IceGrant;
    const relay = Array.isArray(grant.iceServers) ? grant.iceServers : [];
    if (relay.length === 0) return [...STUN];
    const servers = [...STUN, ...relay];
    // Re-fetch a little before the credentials actually lapse.
    const ttl = typeof grant.ttl === 'number' && grant.ttl > 60 ? grant.ttl : 600;
    cached = { servers, expires: Date.now() + (ttl - 60) * 1000 };
    return servers;
  } catch {
    return [...STUN];
  }
}

/** The RTCConfiguration handed to PeerJS. */
export function rtcConfig(cfg: NetConfig): RTCConfiguration {
  const iceServers = cfg.iceServers ?? defaultIceServers();
  const out: RTCConfiguration = {
    iceServers,
    // Gather a few candidates before the offer is created, which shaves a
    // visible chunk off how long "connecting…" sits there.
    iceCandidatePoolSize: 4,
  };
  if (cfg.forceRelay) out.iceTransportPolicy = 'relay';
  return out;
}

/**
 * What to tell a player when ICE fails.
 *
 * The browser's own message ("ICE failed, add a TURN server") is aimed at the
 * developer and means nothing to someone who just wanted to play, so say what
 * actually happened and whose problem it is.
 */
export function iceFailureMessage(cfg?: NetConfig): string {
  return hasRelay(cfg)
    ? 'Could not reach your friend, even through the relay. One of you is on a network that is blocking it — a VPN or a different connection usually gets around it.'
    : 'Could not open a direct connection. One of you is behind a network that needs a relay server (most mobile connections do), and this build has no relay configured.';
}
