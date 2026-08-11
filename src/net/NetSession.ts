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
import {
  DEFAULT_INPUT_DELAY,
  MAX_LOCAL_PLAYERS,
  NET_TIMEOUT_FRAMES,
  NET_VERSION,
  SIM_HZ,
} from '@/core/constants';
import { createRoomId, normalizeRoomId } from '@/net/Room';
import { randomSeed } from '@/engine/Rng';
import { InputHistory } from '@/net/InputHistory';
import {
  EMPTY_RTT,
  MAX_INPUT_DELAY,
  addRttSample,
  clampInputDelay,
  isInputDelayCapped,
  recommendedInputDelay,
} from '@/net/latency';
import type { RttEstimate } from '@/net/latency';

type MessageFn = (m: NetMessage, from: string) => void;
type RosterFn = (players: NetPlayer[]) => void;
type ErrorFn = (message: string) => void;

/** Off-protocol envelope used to tell a peer *why* we are hanging up on it. */
interface WireError {
  t: '_err';
  code: 'version' | 'room-full' | 'closed';
  message: string;
}

interface WireInputProbe {
  t: '_iping' | '_ipong';
  ts: number;
}

interface WireInputFallback {
  t: '_input-fallback';
}

interface WireStartReady {
  t: '_start-ready';
  epoch: number;
}

type Wire = NetMessage | WireError | WireInputProbe | WireInputFallback | WireStartReady;

interface Link {
  /** Ordered, reliable lane for roster/menu/lifecycle state. */
  control: DataConnection | null;
  /** Unordered lane used only for frame-addressed input packets. */
  input: DataConnection | null;
  /** True after the fast lane failed or took too long; control remains a safe fallback. */
  inputFailed: boolean;
  inputTimer: number;
  /** Reject an input-only link that never completes the control handshake. */
  pairTimer: number;
  /** Set once the peer has passed the version handshake. */
  greeted: boolean;
  /** performance.now() of the last unanswered ping. */
  pingSentAt: number;
  /** Separate fast-lane probe. Its failure falls back; it never kills control. */
  inputPingSentAt: number;
  controlRtt: RttEstimate;
  inputRtt: RttEstimate;
  /** Effective estimate: inputRtt while fast is active, controlRtt on fallback. */
  rtt: RttEstimate;
  transport: NetTransportInfo;
  statsPending: boolean;
  reroutedInputs: number;
  /** Frames sent to this peer, replayed when transport switches lanes. */
  outboundInput: InputHistory;
  /** Keep new-fight inputs behind ordered `start` until this peer has reset. */
  startPending: number | null;
}

export interface NetTransportInfo {
  route: 'direct' | 'relay' | 'unknown';
  protocol: string;
  relayProtocol: string;
  bufferedAmount: number;
  reroutedInputs: number;
}

/** Messages a guest may send that the host must forward to the other guests. */
const RELAYED: ReadonlySet<NetMessage['t']> = new Set<NetMessage['t']>([
  'pick',
  'ready',
  'map',
  'cue',
  'stage',
  'start',
  'in',
  'sync',
  'pause',
]);

const JOIN_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 2000;
const INPUT_LANE_TIMEOUT_MS = 8000;
const HOST_ID_ATTEMPTS = 3;
const CONTROL_LABEL = 'mtnfight';
const INPUT_LABEL = 'mtnfight-input';
/** A few dozen tiny input packets: enough burst room, never seconds of stale play. */
const MAX_INPUT_BUFFER = 2 * 1024;
/** Covers worst-phase probe detection, a control trip, and the delayed frame lead. */
const INPUT_HISTORY_FRAMES =
  Math.ceil(((INPUT_LANE_TIMEOUT_MS + PING_INTERVAL_MS * 2) * SIM_HZ) / 1000) +
  MAX_INPUT_DELAY +
  6;

export class NetSession {
  private readonly cfg: NetConfig;

  private peer: Peer | null = null;
  private readonly links = new Map<string, Link>();
  private hostPeerId: string | null = null;
  /** Per-session ICE grant. Never copied into cfg: short-lived grants must refresh. */
  private resolvedIceServers: RTCIceServer[] | null = null;

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
    return !!host?.control?.open;
  }

  /** Shared lead the host will put in the start packet. */
  get recommendedInputDelay(): number {
    let frames = clampInputDelay(this.cfg.inputDelay, DEFAULT_INPUT_DELAY);
    for (const link of this.links.values()) {
      if (!link.greeted) continue;
      frames = Math.max(frames, recommendedInputDelay(delayEstimate(link), frames));
    }
    return frames;
  }

  /** True when the measured route wanted more buffering than the gameplay cap permits. */
  get inputDelayCapped(): boolean {
    for (const link of this.links.values()) {
      if (!link.greeted) continue;
      if (isInputDelayCapped(delayEstimate(link))) return true;
    }
    return false;
  }

  /** The low-latency lane is open, or its ordered fallback has been deliberately selected. */
  inputReady(peerId: string): boolean {
    if (peerId === this._localId) return true;
    const link = this.links.get(peerId);
    if (!link?.greeted) return false;
    return link.inputFailed
      ? link.controlRtt.samples > 0
      : !!link.input?.open && link.inputRtt.samples > 0 && link.controlRtt.samples > 0;
  }

  transportFor(peerId: string): NetTransportInfo | null {
    const link = this.links.get(peerId);
    if (!link) return null;
    const conn = link.input?.open ? link.input : link.control;
    return {
      ...link.transport,
      bufferedAmount: conn?.dataChannel?.bufferedAmount ?? 0,
      reroutedInputs: link.reroutedInputs,
    };
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

    const control = peer.connect(target, {
      label: CONTROL_LABEL,
      reliable: true,
      serialization: 'json',
      metadata: { version: NET_VERSION, name },
    });
    this.registerControl(control);

    // PeerJS calls this option "reliable", but in 1.5.x it controls only the
    // RTCDataChannel's `ordered` flag. False is therefore still reliable while
    // allowing a newer redundant input packet to pass a delayed older one.
    const input = peer.connect(target, {
      label: INPUT_LABEL,
      reliable: false,
      serialization: 'json',
      metadata: { version: NET_VERSION },
    });
    this.registerInput(input);
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
    for (const link of this.links.values()) this.sendTo(link, msg);
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
      for (const link of this.links.values()) this.sendTo(link, msg);
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
    this.resolvedIceServers = await resolveIceServers(this.cfg);
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
    o.config = rtcConfig(c, this.resolvedIceServers ?? undefined);
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
        reject(new Error(describePeerError(err, this.effectiveConfig())));
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
    if (conn.label === INPUT_LABEL) {
      this.registerInput(conn);
      return;
    }
    if (conn.label !== CONTROL_LABEL) {
      conn.close();
      return;
    }
    this.registerControl(conn);
  }

  private linkFor(peerId: string): Link {
    const existing = this.links.get(peerId);
    if (existing) return existing;
    const link: Link = {
      control: null,
      input: null,
      inputFailed: false,
      inputTimer: 0,
      pairTimer: 0,
      greeted: false,
      pingSentAt: 0,
      inputPingSentAt: 0,
      controlRtt: { ...EMPTY_RTT },
      inputRtt: { ...EMPTY_RTT },
      rtt: { ...EMPTY_RTT },
      transport: emptyTransport(),
      statsPending: false,
      reroutedInputs: 0,
      outboundInput: new InputHistory(Math.max(NET_TIMEOUT_FRAMES, INPUT_HISTORY_FRAMES)),
      startPending: null,
    };
    this.links.set(peerId, link);
    return link;
  }

  private registerControl(conn: DataConnection): void {
    const link = this.linkFor(conn.peer);
    if (link.control && link.control !== conn) {
      conn.close();
      return;
    }
    link.control = conn;

    conn.on('open', () => {
      this.rawSend(conn, { t: 'hello', name: this.localName, version: NET_VERSION });
    });
    conn.on('data', (data: unknown) => this.onWire(conn, data));
    conn.on('close', () => this.dropLink(conn.peer, 'left the game'));
    conn.on('error', (err) => {
      const message =
        (err as { type?: string }).type === 'negotiation-failed'
          ? iceFailureMessage(this.effectiveConfig())
          : undefined;
      this.dropLink(conn.peer, 'connection failed', message);
    });
  }

  private registerInput(conn: DataConnection): void {
    const link = this.linkFor(conn.peer);
    if (link.inputFailed) {
      conn.close();
      return;
    }
    if (link.input && link.input !== conn) {
      conn.close();
      return;
    }
    link.input = conn;
    link.inputFailed = false;
    if (!link.greeted && !link.pairTimer) {
      link.pairTimer = window.setTimeout(() => this.expireUnpairedLink(conn.peer), JOIN_TIMEOUT_MS);
    }

    conn.on('open', () => {
      if (link.input !== conn || link.inputFailed) {
        conn.close();
        return;
      }
      if (link.inputTimer) {
        window.clearTimeout(link.inputTimer);
        link.inputTimer = 0;
      }
      link.inputFailed = false;
      link.inputRtt = { ...EMPTY_RTT };
      link.rtt = link.inputRtt;
      if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = MAX_INPUT_BUFFER / 4;
      this.pingInput(link);
      void this.refreshTransport(link);
      this.emitRoster();
    });
    conn.on('data', (data: unknown) => this.onInputWire(conn, data));
    conn.on('close', () => this.loseInput(conn));
    conn.on('error', () => this.loseInput(conn));
  }

  private loseInput(conn: DataConnection): void {
    const link = this.links.get(conn.peer);
    if (!link || link.input !== conn) return;
    if (!link.greeted && !link.control) {
      if (link.pairTimer) window.clearTimeout(link.pairTimer);
      link.input = null;
      try {
        conn.close();
      } catch {
        /* already closed */
      }
      this.links.delete(conn.peer);
      return;
    }
    this.fallbackInput(conn.peer, true);
  }

  private expireUnpairedLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link || link.greeted) return;
    link.pairTimer = 0;
    // A valid peer always completes the version greeting on control. Close
    // both halves together instead of orphaning a control object that may open
    // after its Link was deleted.
    this.dropLink(peerId, 'never completed the handshake');
  }

  private fallbackInput(peerId: string, notify: boolean): void {
    const link = this.links.get(peerId);
    if (!link || link.inputFailed) return;
    link.inputFailed = true;
    link.inputPingSentAt = 0;
    if (link.inputTimer) {
      window.clearTimeout(link.inputTimer);
      link.inputTimer = 0;
    }
    if (link.pairTimer && link.greeted) {
      window.clearTimeout(link.pairTimer);
      link.pairTimer = 0;
    }
    if (notify && link.control?.open) {
      this.rawSend(link.control, { t: '_input-fallback' });
    }
    const input = link.input;
    link.input = null;
    if (link.controlRtt.samples > 0) {
      link.rtt = link.controlRtt;
      this.updatePingBadge(peerId, link.rtt);
    }
    if (input) {
      try {
        input.close();
      } catch {
        /* already closed */
      }
    }
    this.replayInputHistory(link);
    void this.refreshTransport(link);
    this.emitRoster();
  }

  private armInputFallback(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link || link.input?.open || link.inputFailed || link.inputTimer) return;
    link.inputTimer = window.setTimeout(() => {
      link.inputTimer = 0;
      if (!link.input?.open) this.fallbackInput(peerId, true);
    }, INPUT_LANE_TIMEOUT_MS);
  }

  private onPeerError(err: Error): void {
    const msg = describePeerError(err, this.effectiveConfig());
    const type = (err as { type?: string }).type ?? '';
    if (type === 'webrtc') {
      // PeerJS reports offer/SDP/candidate failures at the Peer as well as the
      // individual DataConnection. With two connections, the optional input
      // offer can fail while ordered control is perfectly healthy. Let the
      // connection handlers choose fallback; never tear down that healthy join.
      const liveControl = [...this.links.entries()].filter(([, link]) => link.control?.open);
      if (this.joinSettle || liveControl.length > 0) {
        for (const [peerId, link] of liveControl) {
          if (!link.input?.open && !link.inputFailed) this.fallbackInput(peerId, true);
        }
        return;
      }
    }
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

  private sendTo(link: Link, msg: Wire): void {
    if (msg.t === 'start') {
      link.outboundInput.begin(msg.epoch);
      link.startPending = msg.epoch >>> 0;
    }
    if (msg.t === 'in') {
      if (!link.greeted) return;
      if (!link.outboundInput.remember(msg)) return;
      // `start` and these initial inputs share one ordered lane. Once the peer
      // confirms it has reset, frame-addressed traffic may use the fast lane.
      if (link.startPending !== null) {
        if (link.control) this.rawSend(link.control, msg);
        return;
      }
    }
    if (msg.t === 'in' && link.input?.open) {
      const buffered = link.input.dataChannel?.bufferedAmount ?? 0;
      if (buffered > MAX_INPUT_BUFFER) {
        // Do not queue more stale work on the realtime lane. Preserve the
        // frame range on the quiet ordered lane instead; dropping long enough
        // to outrun the redundancy window would leave a permanent input hole.
        link.reroutedInputs++;
        if (link.control) this.rawSend(link.control, msg);
        return;
      }
      this.rawSend(link.input, msg);
      return;
    }
    if (link.control) this.rawSend(link.control, msg);
  }

  private replayInputHistory(link: Link): void {
    const control = link.control;
    if (!control?.open) return;
    for (const packet of link.outboundInput.packets()) this.rawSend(control, packet);
  }

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
        this.onControlPong(from, m.ts);
        return;

      case '_input-fallback':
        this.fallbackInput(from, false);
        return;

      case '_start-ready': {
        const link = this.links.get(from);
        if (link?.startPending === (m.epoch >>> 0)) link.startPending = null;
        return;
      }

      case '_iping':
      case '_ipong':
        return;

      default:
        break;
    }

    // Nothing but a handshake gets through until the handshake has happened.
    if (this._role === 'host' && !this.links.get(from)?.greeted) return;

    const link = this.links.get(from);
    if (m.t === 'start') link?.outboundInput.begin(m.epoch);

    // Guests only ever talk to the host, so a guest-originated gameplay message
    // has to be forwarded on by us before anybody else sees it.
    if (this._role === 'host' && RELAYED.has(m.t)) {
      for (const [peerId, link] of this.links) {
        if (peerId === from) continue;
        this.sendTo(link, m);
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
    // Sent only after every synchronous listener (including Lockstep) has
    // installed the new epoch and cleared its old frame history.
    if (m.t === 'start') this.rawSend(conn, { t: '_start-ready', epoch: m.epoch });
  }

  /** The fast lane accepts only self-describing input packets and its own probes. */
  private onInputWire(conn: DataConnection, data: unknown): void {
    const m = this.decode(data);
    if (!m) return;
    const from = conn.peer;
    const link = this.links.get(from);
    if (!link) return;

    if (m.t === '_iping') {
      this.rawSend(conn, { t: '_ipong', ts: m.ts });
      return;
    }
    if (m.t === '_ipong') {
      this.onInputPong(from, m.ts);
      return;
    }
    if (m.t !== 'in' || !link.greeted) return;

    if (this._role === 'host') {
      for (const [peerId, target] of this.links) {
        if (peerId !== from) this.sendTo(target, m);
      }
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
    if (link) {
      link.greeted = true;
      if (link.pairTimer) {
        window.clearTimeout(link.pairTimer);
        link.pairTimer = 0;
      }
      if (link.inputFailed) {
        this.rawSend(conn, { t: '_input-fallback' });
        this.replayInputHistory(link);
      }
      else this.armInputFallback(conn.peer);
      this.pingControl(link);
    }

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
    for (const link of this.links.values()) this.sendTo(link, msg);
    this.emitRoster();
  }

  // ── Disconnects ────────────────────────────────────────────────────────────

  private dropLink(peerId: string, why: string, guestMessage?: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    if (link.inputTimer) window.clearTimeout(link.inputTimer);
    if (link.pairTimer) window.clearTimeout(link.pairTimer);
    for (const conn of [link.control, link.input]) {
      if (!conn) continue;
      try {
        conn.close();
      } catch {
        /* already closed */
      }
    }

    if (this._role === 'host') {
      const gone = this._players.find((p) => p.peerId === peerId);
      if (gone) {
        this._players = this._players.filter((p) => p.peerId !== peerId);
        // Tell the survivors, then hand them the corrected roster. The slot is
        // free again and the match carries on without it.
        for (const l of this.links.values()) this.sendTo(l, { t: 'bye', slot: gone.slot });
        this.broadcastRoster();
        this.emitError(`${gone.name} ${why}.`);
        for (const fn of this.messageFns.slice()) fn({ t: 'bye', slot: gone.slot }, peerId);
      }
      return;
    }

    if (peerId === this.hostPeerId) {
      const message = guestMessage ?? `Lost the host — ${why}.`;
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

  private pingControl(link: Link): void {
    if (!link.control?.open || link.pingSentAt > 0) return;
    const now = performance.now();
    link.pingSentAt = now;
    this.rawSend(link.control, { t: 'ping', ts: now });
  }

  private pingInput(link: Link): void {
    if (!link.input?.open || link.inputFailed || link.inputPingSentAt > 0) return;
    const now = performance.now();
    link.inputPingSentAt = now;
    this.rawSend(link.input, { t: '_iping', ts: now });
  }

  private pingAll(): void {
    const now = performance.now();
    for (const [peerId, link] of [...this.links]) {
      // Only the ordered control lane owns session liveness. A failed realtime
      // probe falls back to control; it must never throw away a healthy room.
      if (link.pingSentAt > 0 && now - link.pingSentAt > PING_INTERVAL_MS * 4) {
        this.dropLink(peerId, 'stopped responding');
        continue;
      }
      this.pingControl(link);

      if (
        link.inputPingSentAt > 0 &&
        now - link.inputPingSentAt > PING_INTERVAL_MS * 4
      ) {
        this.fallbackInput(peerId, true);
        continue;
      }
      this.pingInput(link);
    }
  }

  private onControlPong(from: string, ts: number): void {
    const link = this.links.get(from);
    if (!link) return;
    link.pingSentAt = 0;
    const sample = Math.max(0, performance.now() - ts);
    link.controlRtt = addRttSample(link.controlRtt, sample);
    if (!link.input?.open || link.inputFailed) {
      link.rtt = link.controlRtt;
      this.updatePingBadge(from, link.rtt);
    }
    if (!link.input?.open || link.inputFailed) void this.refreshTransport(link);
  }

  private onInputPong(from: string, ts: number): void {
    const link = this.links.get(from);
    if (!link || link.inputFailed) return;
    link.inputPingSentAt = 0;
    const sample = Math.max(0, performance.now() - ts);
    link.inputRtt = addRttSample(link.inputRtt, sample);
    link.rtt = link.inputRtt;
    this.updatePingBadge(from, link.rtt);
    void this.refreshTransport(link);
  }

  private updatePingBadge(from: string, estimate: RttEstimate): void {
    const rtt = Math.max(0, Math.round(estimate.rttMs));
    // The badge belongs to the peer at the far end on both host and guest.
    const target = this._players.find((p) => p.peerId === from);
    if (!target || target.ping === rtt) return;
    target.ping = rtt;
    this.emitRoster();
  }

  /** Cache the selected ICE candidate pair for honest in-game diagnostics. */
  private async refreshTransport(link: Link): Promise<void> {
    if (link.statsPending) return;
    const conn = link.input?.open ? link.input : link.control;
    const pc = conn?.peerConnection;
    if (!pc || pc.connectionState === 'closed') return;
    link.statsPending = true;
    try {
      const stats = await pc.getStats();
      const current = link.input?.open ? link.input : link.control;
      if (current !== conn) return;
      let pair: Record<string, unknown> | null = null;

      stats.forEach((report) => {
        const r = report as unknown as Record<string, unknown>;
        if (r['type'] === 'transport' && typeof r['selectedCandidatePairId'] === 'string') {
          const selected = stats.get(r['selectedCandidatePairId']);
          if (selected) pair = selected as unknown as Record<string, unknown>;
        }
      });
      if (!pair) {
        stats.forEach((report) => {
          const r = report as unknown as Record<string, unknown>;
          if (
            !pair &&
            r['type'] === 'candidate-pair' &&
            r['state'] === 'succeeded' &&
            (r['selected'] === true || r['nominated'] === true)
          ) {
            pair = r;
          }
        });
      }
      if (!pair) return;

      const localId = pair['localCandidateId'];
      const remoteId = pair['remoteCandidateId'];
      const local =
        typeof localId === 'string'
          ? (stats.get(localId) as unknown as Record<string, unknown> | undefined)
          : undefined;
      const remote =
        typeof remoteId === 'string'
          ? (stats.get(remoteId) as unknown as Record<string, unknown> | undefined)
          : undefined;
      const localType = stringStat(local, 'candidateType');
      const remoteType = stringStat(remote, 'candidateType');
      const route =
        localType === 'relay' || remoteType === 'relay'
          ? 'relay'
          : localType || remoteType
            ? 'direct'
            : 'unknown';
      const next: NetTransportInfo = {
        route,
        protocol: stringStat(local, 'protocol') || stringStat(remote, 'protocol'),
        relayProtocol:
          stringStat(local, 'relayProtocol') || stringStat(remote, 'relayProtocol'),
        bufferedAmount: conn?.dataChannel?.bufferedAmount ?? 0,
        reroutedInputs: link.reroutedInputs,
      };
      if (!sameTransport(link.transport, next)) {
        link.transport = next;
        this.emitRoster();
      }
    } catch {
      // getStats is diagnostic only; old WebViews are still allowed to play.
    } finally {
      link.statsPending = false;
    }
  }

  private effectiveConfig(): NetConfig {
    if (!this.resolvedIceServers) return this.cfg;
    return { ...this.cfg, iceServers: this.resolvedIceServers };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private installUnloadGuard(): void {
    if (this.unloadFn || typeof window === 'undefined') return;
    this.unloadFn = () => {
      const msg: NetMessage = { t: 'bye', slot: this._slot };
      for (const link of this.links.values()) this.sendTo(link, msg);
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
      if (link.inputTimer) window.clearTimeout(link.inputTimer);
      if (link.pairTimer) window.clearTimeout(link.pairTimer);
      for (const conn of [link.control, link.input]) {
        if (!conn) continue;
        try {
          conn.close();
        } catch {
          /* already closed */
        }
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
    this.resolvedIceServers = null;
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

function emptyTransport(): NetTransportInfo {
  return { route: 'unknown', protocol: '', relayProtocol: '', bufferedAmount: 0, reroutedInputs: 0 };
}

/**
 * Start travels on control and input returns on the realtime lane. Their
 * RTCPeerConnections may select different ICE paths, so size for the slower of
 * the two instead of assuming the input lane's RTT describes both halves.
 */
function delayEstimate(link: Link): RttEstimate {
  if (link.inputFailed || link.inputRtt.samples <= 0) return link.controlRtt;
  if (link.controlRtt.samples <= 0) return link.inputRtt;
  return {
    rttMs: Math.max(link.controlRtt.rttMs, link.inputRtt.rttMs),
    jitterMs: Math.max(link.controlRtt.jitterMs, link.inputRtt.jitterMs),
    samples: Math.min(link.controlRtt.samples, link.inputRtt.samples),
  };
}

function stringStat(stats: Record<string, unknown> | undefined, key: string): string {
  const value = stats?.[key];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function sameTransport(a: NetTransportInfo, b: NetTransportInfo): boolean {
  return (
    a.route === b.route &&
    a.protocol === b.protocol &&
    a.relayProtocol === b.relayProtocol &&
    a.bufferedAmount === b.bufferedAmount &&
    a.reroutedInputs === b.reroutedInputs
  );
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
