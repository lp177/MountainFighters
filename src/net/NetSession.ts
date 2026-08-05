/**
 * WebRTC session over PeerJS.
 *
 * Topology is a star: the host owns the room id, every guest connects to the
 * host, and the host relays gameplay traffic to the other guests. That keeps
 * the connection count at N-1 instead of N*(N-1)/2 and gives us one obvious
 * place to keep the authoritative roster.
 *
 * The broker defaults to the public PeerJS cloud so there is no server to run.
 * Point NetConfig.host/port/path/secure at a self-hosted PeerServer and nothing
 * else in the codebase needs to change.
 */

import { Peer } from 'peerjs';
import type { DataConnection, PeerOptions } from 'peerjs';

import type { NetConfig, NetMessage, NetPlayer, NetRole } from '@/core/types';
import { iceFailureMessage, resolveIceServers, rtcConfig } from '@/net/ice';
import { MAX_LOCAL_PLAYERS, NET_VERSION } from '@/core/constants';
import { createRoomId, normalizeRoomId } from '@/net/Room';
import { randomSeed } from '@/engine/Rng';

type MessageFn = (m: NetMessage, from: string) => void;
type RosterFn = (players: NetPlayer[]) => void;
type ErrorFn = (message: string) => void;

/** Off-protocol envelope used to tell a peer *why* we are hanging up on it. */
interface WireError {
  t: '_err';
  code: 'version' | 'room-full' | 'closed';
  message: string;
}

type Wire = NetMessage | WireError;

interface Link {
  conn: DataConnection;
  /** Set once the peer has passed the version handshake. */
  greeted: boolean;
  /** performance.now() of the last unanswered ping. */
  pingSentAt: number;
}

/** Messages a guest may send that the host must forward to the other guests. */
const RELAYED: ReadonlySet<NetMessage['t']> = new Set<NetMessage['t']>([
  'pick',
  'ready',
  'start',
  'in',
  'sync',
  'pause',
]);

const JOIN_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 2000;
const HOST_ID_ATTEMPTS = 3;

export class NetSession {
  private readonly cfg: NetConfig;

  private peer: Peer | null = null;
  private readonly links = new Map<string, Link>();
  private hostPeerId: string | null = null;

  private _role: NetRole = 'offline';
  private _players: NetPlayer[] = [];
  private _slot = -1;
  private _seed = 0;
  private _localId = '';
  private _lastError = '';

  private readonly messageFns: MessageFn[] = [];
  private readonly rosterFns: RosterFn[] = [];
  private readonly errorFns: ErrorFn[] = [];

  private pingTimer = 0;
  private localName = 'Dwarf';
  private closed = false;

  private joinSettle: { resolve: () => void; reject: (e: Error) => void; timer: number } | null =
    null;
  private unloadFn: (() => void) | null = null;

  constructor(cfg: NetConfig) {
    this.cfg = cfg;
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  get role(): NetRole {
    return this._role;
  }

  get players(): NetPlayer[] {
    return this._players;
  }

  get connected(): boolean {
    if (this._role === 'offline' || !this.peer || this.peer.destroyed) return false;
    if (this._role === 'host') return true;
    const host = this.hostPeerId ? this.links.get(this.hostPeerId) : null;
    return !!host && host.conn.open;
  }

  /** Our own peer id. Empty until host()/join() resolves. */
  get localId(): string {
    return this._localId;
  }

  /** Our own player slot. Host is always 0. */
  get slot(): number {
    return this._slot;
  }

  /** Shared RNG seed for the match, chosen by the host. */
  get seed(): number {
    return this._seed;
  }

  /** Last human-readable failure, for the lobby to display. */
  get lastError(): string {
    return this._lastError;
  }

  /**
   * Opens a room. Resolves with the room id, which is also the host's peer id
   * and the thing that goes in the invite link.
   */
  async host(name = 'Host'): Promise<string> {
    this.teardown();
    this.closed = false;
    this.localName = name;
    this._role = 'host';
    this._slot = 0;
    this._seed = randomSeed();

    await this.ensureIce();

    let lastErr = new Error('Could not open a room.');
    for (let attempt = 0; attempt < HOST_ID_ATTEMPTS; attempt++) {
      const id = createRoomId();
      try {
        const realId = await this.openPeer(id);
        this._localId = realId;
        this.hostPeerId = realId;
        this._players = [makePlayer(realId, 0, name)];
        this.attachHostHandlers();
        this.startPinging();
        this.installUnloadGuard();
        this.emitRoster();
        return realId;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        // A taken id on the public broker is pure bad luck; roll another one.
        if (!/unavailable-id/i.test(lastErr.message)) break;
      }
    }
    this._role = 'offline';
    this.teardown();
    this._lastError = lastErr.message;
    throw lastErr;
  }

  /** Connects to a room. Resolves once the host has welcomed us into a slot. */
  async join(roomId: string, name = 'Guest'): Promise<void> {
    const target = normalizeRoomId(roomId);
    if (!target) throw new Error('That invite link is missing a room id.');

    this.teardown();
    this.closed = false;
    this.localName = name;
    this._role = 'guest';
    this._slot = -1;
    this.hostPeerId = target;

    await this.ensureIce();

    try {
      this._localId = await this.openPeer(null);
    } catch (e) {
      this._role = 'offline';
      this.teardown();
      const err = e instanceof Error ? e : new Error(String(e));
      this._lastError = err.message;
      throw err;
    }

    const peer = this.peer;
    if (!peer) throw new Error('Connection was closed before it opened.');

    peer.on('error', (err) => this.onPeerError(err));
    peer.on('disconnected', () => this.onPeerDisconnected());
    peer.on('close', () => this.onPeerClosed());

    const conn = peer.connect(target, {
      label: 'mtnfight',
      reliable: true,
      serialization: 'json',
      metadata: { version: NET_VERSION, name },
    });
    this.registerLink(conn);
    this.installUnloadGuard();
    this.startPinging();

    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.failJoin(
          new Error(
            'The host never answered. They may have closed the tab, or the room id is stale.',
          ),
        );
      }, JOIN_TIMEOUT_MS);
      this.joinSettle = { resolve, reject, timer };
    });
  }

  /** Broadcasts to every connected peer (host) or to the host (guest). */
  send(msg: NetMessage): void {
    if (this._role === 'offline') return;
    this.applyRoster(msg, this._localId);
    for (const link of this.links.values()) this.rawSend(link.conn, msg);
  }

  onMessage(fn: MessageFn): void {
    if (!this.messageFns.includes(fn)) this.messageFns.push(fn);
  }

  offMessage(fn: MessageFn): void {
    const i = this.messageFns.indexOf(fn);
    if (i >= 0) this.messageFns.splice(i, 1);
  }

  onPlayersChanged(fn: RosterFn): void {
    if (!this.rosterFns.includes(fn)) this.rosterFns.push(fn);
    fn(this._players);
  }

  offPlayersChanged(fn: RosterFn): void {
    const i = this.rosterFns.indexOf(fn);
    if (i >= 0) this.rosterFns.splice(i, 1);
  }

  /** Fired for anything the player needs told about: kicks, drops, mismatches. */
  onError(fn: ErrorFn): void {
    if (!this.errorFns.includes(fn)) this.errorFns.push(fn);
  }

  close(): void {
    if (this._role !== 'offline') {
      const msg: NetMessage = { t: 'bye', slot: this._slot };
      for (const link of this.links.values()) this.rawSend(link.conn, msg);
    }
    this.closed = true;
    this.teardown();
    this._role = 'offline';
    this._slot = -1;
    this._players = [];
    this.emitRoster();
  }

  // ── Peer plumbing ──────────────────────────────────────────────────────────

  /**
   * Fetch the relay grant once per session, before any peer is created.
   * Failing is fine — resolveIceServers falls back to STUN on its own.
   */
  private async ensureIce(): Promise<void> {
    if (this.cfg.iceServers && this.cfg.iceServers.length > 0) return;
    this.cfg.iceServers = await resolveIceServers(this.cfg);
  }

  private peerOptions(): PeerOptions {
    // Only defined keys go in: PeerJS merges over its cloud defaults, and an
    // explicit `undefined` would clobber them.
    const o: PeerOptions = {};
    const c = this.cfg;
    if (typeof c.host === 'string' && c.host) o.host = c.host;
    if (typeof c.port === 'number' && c.port > 0) o.port = c.port;
    if (typeof c.path === 'string' && c.path) o.path = c.path;
    if (typeof c.secure === 'boolean') o.secure = c.secure;
    // Without this PeerJS uses its STUN-only default, which cannot cross
    // symmetric or carrier-grade NAT — the connection simply fails with
    // "ICE failed" and no relay candidate to fall back on.
    o.config = rtcConfig(c);
    return o;
  }

  private openPeer(id: string | null): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const opts = this.peerOptions();
      const peer = id ? new Peer(id, opts) : new Peer(opts);
      this.peer = peer;

      let settled = false;
      const onOpen = (realId: string) => {
        if (settled) return;
        settled = true;
        peer.off('error', onError);
        resolve(realId);
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        peer.off('open', onOpen);
        try {
          peer.destroy();
        } catch {
          /* already gone */
        }
        if (this.peer === peer) this.peer = null;
        reject(new Error(describePeerError(err, this.cfg)));
      };
      peer.on('open', onOpen);
      peer.on('error', onError);
    });
  }

  private attachHostHandlers(): void {
    const peer = this.peer;
    if (!peer) return;
    peer.on('connection', (conn) => this.acceptGuest(conn));
    peer.on('error', (err) => this.onPeerError(err));
    peer.on('disconnected', () => this.onPeerDisconnected());
    peer.on('close', () => this.onPeerClosed());
  }

  private acceptGuest(conn: DataConnection): void {
    if (this.closed) {
      conn.close();
      return;
    }
    this.registerLink(conn);
  }

  private registerLink(conn: DataConnection): void {
    const link: Link = { conn, greeted: false, pingSentAt: 0 };
    this.links.set(conn.peer, link);

    conn.on('open', () => {
      this.rawSend(conn, { t: 'hello', name: this.localName, version: NET_VERSION });
    });
    conn.on('data', (data: unknown) => this.onWire(conn, data));
    conn.on('close', () => this.dropLink(conn.peer, 'left the game'));
    conn.on('error', () => this.dropLink(conn.peer, 'connection failed'));
  }

  private onPeerError(err: Error): void {
    const msg = describePeerError(err, this.cfg);
    this._lastError = msg;
    // peer-unavailable while joining means the room simply is not there.
    if (this.joinSettle) this.failJoin(new Error(msg));
    else this.emitError(msg);
  }

  private onPeerDisconnected(): void {
    // Lost the broker but not necessarily the data channels; try to get back so
    // late joiners can still find us.
    if (this.closed || !this.peer || this.peer.destroyed) return;
    try {
      this.peer.reconnect();
    } catch {
      /* nothing else to try */
    }
  }

  private onPeerClosed(): void {
    if (this.closed) return;
    this.emitError('Disconnected from the matchmaking server.');
  }

  // ── Wire handling ──────────────────────────────────────────────────────────

  private rawSend(conn: DataConnection, msg: Wire): void {
    if (!conn.open) return;
    try {
      const r = conn.send(msg);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          /* the close handler will deal with it */
        });
      }
    } catch {
      /* the close handler will deal with it */
    }
  }

  private decode(data: unknown): Wire | null {
    let v: unknown = data;
    if (v instanceof ArrayBuffer) {
      try {
        v = new TextDecoder().decode(v);
      } catch {
        return null;
      }
    }
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        return null;
      }
    }
    if (!v || typeof v !== 'object') return null;
    if (typeof (v as { t?: unknown }).t !== 'string') return null;
    return v as Wire;
  }

  private onWire(conn: DataConnection, data: unknown): void {
    const m = this.decode(data);
    if (!m) return;
    const from = conn.peer;

    switch (m.t) {
      case '_err':
        this._lastError = m.message;
        if (this.joinSettle) this.failJoin(new Error(m.message));
        else this.emitError(m.message);
        return;

      case 'hello':
        this.onHello(conn, m.version, m.name);
        return;

      case 'ping':
        this.rawSend(conn, { t: 'pong', ts: m.ts });
        return;

      case 'pong':
        this.onPong(from, m.ts);
        return;

      default:
        break;
    }

    // Nothing but a handshake gets through until the handshake has happened.
    if (this._role === 'host' && !this.links.get(from)?.greeted) return;

    // Guests only ever talk to the host, so a guest-originated gameplay message
    // has to be forwarded on by us before anybody else sees it.
    if (this._role === 'host' && RELAYED.has(m.t)) {
      for (const [peerId, link] of this.links) {
        if (peerId === from) continue;
        this.rawSend(link.conn, m);
      }
    }

    this.applyRoster(m, from);

    if (m.t === 'welcome') {
      this._slot = m.slot;
      this._seed = m.seed;
      const settle = this.joinSettle;
      if (settle) {
        window.clearTimeout(settle.timer);
        this.joinSettle = null;
        settle.resolve();
      }
    } else if (m.t === 'start') {
      this._seed = m.seed;
    } else if (m.t === 'bye' && this._role === 'guest' && m.slot === 0) {
      this.emitError('The host closed the room.');
    }

    for (const fn of this.messageFns.slice()) fn(m, from);
  }

  private onHello(conn: DataConnection, version: string, name: string): void {
    if (version !== NET_VERSION) {
      // Both ends greet each other, so both ends detect this independently —
      // the _err is a courtesy for builds that only check one way.
      const message =
        `Netcode version mismatch: this room speaks v${NET_VERSION}, the other side speaks ` +
        `v${version || '?'}. One of you is running an older build — reload and try again.`;
      this.rawSend(conn, { t: '_err', code: 'version', message });
      this._lastError = message;
      if (this.joinSettle) this.failJoin(new Error(message));
      else {
        this.emitError(message);
        this.dropLink(conn.peer, 'is running a different version');
      }
      return;
    }

    const link = this.links.get(conn.peer);
    if (link) link.greeted = true;

    if (this._role !== 'host') return;

    const existing = this._players.find((p) => p.peerId === conn.peer);
    if (existing) {
      existing.name = cleanName(name, existing.slot);
      this.broadcastRoster();
      return;
    }

    const slot = this.freeSlot();
    if (slot < 0) {
      const message = 'That room is full — four fighters is the lot.';
      this.rawSend(conn, { t: '_err', code: 'room-full', message });
      window.setTimeout(() => conn.close(), 60);
      return;
    }

    const player = makePlayer(conn.peer, slot, cleanName(name, slot));
    this._players = [...this._players, player].sort((a, b) => a.slot - b.slot);
    this.rawSend(conn, {
      t: 'welcome',
      slot,
      players: this._players.map(clonePlayer),
      seed: this._seed,
    });
    this.broadcastRoster();
  }

  private freeSlot(): number {
    for (let s = 0; s < MAX_LOCAL_PLAYERS; s++) {
      if (!this._players.some((p) => p.slot === s)) return s;
    }
    return -1;
  }

  /** Folds roster-affecting messages into our local view of the lobby. */
  private applyRoster(m: NetMessage, _from: string): void {
    switch (m.t) {
      case 'welcome':
      case 'roster':
        this._players = m.players.map(clonePlayer).sort((a, b) => a.slot - b.slot);
        this.emitRoster();
        break;
      case 'pick': {
        const p = this._players.find((x) => x.slot === m.slot);
        if (p && p.dwarfId !== m.dwarfId) {
          p.dwarfId = m.dwarfId;
          this.emitRoster();
        }
        break;
      }
      case 'ready': {
        const p = this._players.find((x) => x.slot === m.slot);
        if (p && p.ready !== m.ready) {
          p.ready = m.ready;
          this.emitRoster();
        }
        break;
      }
      case 'bye': {
        if (this._role !== 'host') {
          const before = this._players.length;
          this._players = this._players.filter((x) => x.slot !== m.slot);
          if (this._players.length !== before) this.emitRoster();
        }
        break;
      }
      default:
        break;
    }
  }

  private broadcastRoster(): void {
    if (this._role !== 'host') return;
    const msg: NetMessage = { t: 'roster', players: this._players.map(clonePlayer) };
    for (const link of this.links.values()) this.rawSend(link.conn, msg);
    this.emitRoster();
  }

  // ── Disconnects ────────────────────────────────────────────────────────────

  private dropLink(peerId: string, why: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    try {
      link.conn.close();
    } catch {
      /* already closed */
    }

    if (this._role === 'host') {
      const gone = this._players.find((p) => p.peerId === peerId);
      if (gone) {
        this._players = this._players.filter((p) => p.peerId !== peerId);
        // Tell the survivors, then hand them the corrected roster. The slot is
        // free again and the match carries on without it.
        for (const l of this.links.values()) this.rawSend(l.conn, { t: 'bye', slot: gone.slot });
        this.broadcastRoster();
        this.emitError(`${gone.name} ${why}.`);
        for (const fn of this.messageFns.slice()) fn({ t: 'bye', slot: gone.slot }, peerId);
      }
      return;
    }

    if (peerId === this.hostPeerId) {
      const message = `Lost the host — ${why}.`;
      this._lastError = message;
      if (this.joinSettle) {
        this.failJoin(new Error(message));
        return;
      }
      const self = this._players.find((p) => p.slot === this._slot);
      this._players = self ? [self] : [];
      this.emitRoster();
      this.emitError(message);
      for (const fn of this.messageFns.slice()) fn({ t: 'bye', slot: 0 }, peerId);
    }
  }

  private failJoin(err: Error): void {
    const settle = this.joinSettle;
    this._lastError = err.message;
    if (!settle) {
      this.emitError(err.message);
      return;
    }
    window.clearTimeout(settle.timer);
    this.joinSettle = null;
    this._role = 'offline';
    this.teardown();
    settle.reject(err);
  }

  // ── Ping ───────────────────────────────────────────────────────────────────

  private startPinging(): void {
    if (this.pingTimer) return;
    this.pingTimer = window.setInterval(() => this.pingAll(), PING_INTERVAL_MS);
  }

  private pingAll(): void {
    const now = performance.now();
    for (const [peerId, link] of [...this.links]) {
      if (!link.conn.open) continue;
      // A silent peer is a gone peer, whether or not the browser ever bothers
      // to fire 'close'. Reclaim the slot rather than stalling the match.
      if (link.pingSentAt > 0 && now - link.pingSentAt > PING_INTERVAL_MS * 4) {
        this.dropLink(peerId, 'stopped responding');
        continue;
      }
      if (link.pingSentAt === 0) link.pingSentAt = now;
      this.rawSend(link.conn, { t: 'ping', ts: now });
    }
  }

  private onPong(from: string, ts: number): void {
    const link = this.links.get(from);
    if (link) link.pingSentAt = 0;
    const rtt = Math.max(0, Math.round(performance.now() - ts));
    // Host measures each guest directly; a guest can only measure the host, and
    // that round trip is exactly what its own ping badge should read.
    const target =
      this._role === 'host'
        ? this._players.find((p) => p.peerId === from)
        : this._players.find((p) => p.slot === this._slot);
    if (!target || target.ping === rtt) return;
    target.ping = rtt;
    this.emitRoster();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private installUnloadGuard(): void {
    if (this.unloadFn || typeof window === 'undefined') return;
    this.unloadFn = () => {
      const msg: NetMessage = { t: 'bye', slot: this._slot };
      for (const link of this.links.values()) this.rawSend(link.conn, msg);
    };
    window.addEventListener('pagehide', this.unloadFn);
  }

  private teardown(): void {
    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = 0;
    }
    if (this.unloadFn && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadFn);
      this.unloadFn = null;
    }
    for (const link of this.links.values()) {
      try {
        link.conn.close();
      } catch {
        /* already closed */
      }
    }
    this.links.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        /* already destroyed */
      }
      this.peer = null;
    }
    if (this.joinSettle) {
      window.clearTimeout(this.joinSettle.timer);
      this.joinSettle = null;
    }
    this.hostPeerId = null;
  }

  private emitRoster(): void {
    const snapshot = this._players;
    for (const fn of this.rosterFns.slice()) fn(snapshot);
  }

  private emitError(message: string): void {
    for (const fn of this.errorFns.slice()) fn(message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlayer(peerId: string, slot: number, name: string): NetPlayer {
  return { peerId, slot, name: cleanName(name, slot), dwarfId: null, ready: false, ping: 0 };
}

function clonePlayer(p: NetPlayer): NetPlayer {
  return {
    peerId: p.peerId,
    slot: p.slot,
    name: p.name,
    dwarfId: p.dwarfId,
    ready: p.ready,
    ping: p.ping,
  };
}

function cleanName(name: string, slot: number): string {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 16) : '';
  return s || `Player ${slot + 1}`;
}

function describePeerError(err: unknown, cfg?: NetConfig): string {
  const type = (err as { type?: string })?.type ?? '';
  const raw = err instanceof Error ? err.message : String(err);
  switch (type) {
    case 'peer-unavailable':
      return 'That room is not open. The host may have closed the tab, or the link has gone stale.';
    case 'unavailable-id':
      return 'unavailable-id: that room id is already taken.';
    case 'browser-incompatible':
      return 'This browser cannot do WebRTC, so it cannot do netplay. Try Firefox or Chrome.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check the connection and try again.';
    case 'ssl-unavailable':
      return 'The broker refused a secure connection. Check the NetConfig host/secure settings.';
    case 'invalid-id':
    case 'invalid-key':
      return 'That room id is not valid.';
    case 'webrtc':
      // Almost always ICE failing to find a route between the two networks,
      // which is a relay problem, not something the player did wrong.
      return iceFailureMessage(cfg);
    case 'disconnected':
      return 'Disconnected from the matchmaking server.';
    default:
      return raw || 'Networking failed for an unknown reason.';
  }
}
