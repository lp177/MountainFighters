/**
 * Input-delay lockstep.
 *
 * Every peer simulates every frame identically. Local input sampled on frame F
 * is not applied on frame F — it is transmitted and applied by everyone on
 * frame F + inputDelay. That buys the network `inputDelay` frames of slack in
 * exchange for a fixed, honest amount of input latency, and it needs no
 * rollback because nobody ever guesses.
 *
 * If a peer's input for the frame we are about to run has not arrived, we
 * STALL. Stalling is visible and recoverable; guessing is a desync.
 *
 * Required call order inside the fixed-step loop:
 *
 *     input.sampleAll(frame);
 *     lockstep.prepare(frame);                   // send local, apply everyone
 *     if (!lockstep.canAdvance(frame)) return;   // hold the sim
 *     world.update();
 *     lockstep.confirm(frame, world.checksum());
 *
 * A guest resets itself when the host's `start` arrives; the host, which never
 * receives its own broadcast, calls reset(startFrame) as it sends it.
 */

import type { BtnMask, NetConfig, NetMessage, NetPlayer } from '@/core/types';
import { DEFAULT_INPUT_DELAY, NET_TIMEOUT_FRAMES, SYNC_INTERVAL } from '@/core/constants';
import type { InputManager } from '@/engine/input/InputManager';
import type { NetSession } from '@/net/NetSession';
import { clampInputDelay } from '@/net/latency';

/** Frames of already-sent input repeated in each packet, to ride out a loss. */
const REDUNDANCY = 3;
/** While stalled, re-send recent input this often in case a packet went missing. */
const RESEND_EVERY = 12;
/** Cap on stored history per slot; well beyond anything lockstep needs. */
const HISTORY = 240;

export class Lockstep {
  private readonly session: NetSession;
  private readonly input: InputManager;

  private delay: number;
  private sendInterval: number;
  /** Match identity; frame numbers alone restart at zero for every fight. */
  private epoch = 0;

  /** slot -> frame -> held mask. */
  private readonly inputs = new Map<number, Map<number, BtnMask>>();
  private activeSlots: number[] = [];
  private localSlots: number[] = [];
  private readonly dropped = new Set<number>();

  private origin = 0;
  /** True while a cinematic excuses the stall. See hold(). */
  private held = false;
  private lastFlush = -999;
  private lastPrune = 0;

  private _stalled = 0;
  private _desynced = false;
  private _timedOut = false;
  private readonly _waiting: number[] = [];

  private readonly localChecks = new Map<number, number>();
  private readonly remoteChecks = new Map<number, Map<string, number>>();

  constructor(session: NetSession, input: InputManager, cfg: NetConfig) {
    this.session = session;
    this.input = input;

    const raw = Number.isFinite(cfg.inputDelay) ? cfg.inputDelay : DEFAULT_INPUT_DELAY;
    this.delay = clampInputDelay(raw, 0);
    this.sendInterval = sendEvery(this.delay);

    session.onPlayersChanged(this.onRoster);
    session.onMessage(this.onNet);
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  get desynced(): boolean {
    return this._desynced;
  }

  get stalledFrames(): number {
    return this._stalled;
  }

  /** True once we gave up on a peer. The match continued without them. */
  get timedOut(): boolean {
    return this._timedOut;
  }

  /** Slots we are currently waiting on, for the "waiting for player" overlay. */
  get waitingOn(): readonly number[] {
    return this._waiting;
  }

  get inputDelay(): number {
    return this.delay;
  }

  /**
   * Install the host's agreed input lead before a match resets its frame clock.
   * Every peer receives the value in `start`; changing it independently during
   * a fight would leave holes in the frame history and is deliberately not an
   * adaptive mid-match operation.
   */
  configureDelay(frames: number): number {
    this.delay = clampInputDelay(frames, 0);
    this.sendInterval = sendEvery(this.delay);
    return this.delay;
  }

  configureEpoch(epoch: number): number {
    this.epoch = epoch >>> 0;
    return this.epoch;
  }

  /** True when lockstep is actually doing something — a live remote peer exists. */
  get active(): boolean {
    if (this.session.role === 'offline') return false;
    for (const slot of this.activeSlots) {
      if (this.dropped.has(slot)) continue;
      if (!this.localSlots.includes(slot)) return true;
    }
    return false;
  }

  /**
   * Suspend the drop-them-they-have-gone timeout.
   *
   * Set while any peer has a cinematic on screen. They are deliberately not
   * advancing, and the stall that causes is expected rather than a fault — a
   * boss introduction waits for a keypress, and ten seconds of somebody reading
   * it is enough for NET_TIMEOUT_FRAMES to conclude they have left and end the
   * match in the middle of the moment the game is making an occasion of.
   */
  hold(on: boolean): void {
    this.held = on === true;
    if (this.held) this._stalled = 0;
  }

  /**
   * Call at the start of a MATCH — not when the room opens — so both peers
   * number frames from the same place.
   *
   * `startFrame` must be the frame the simulation itself will start counting
   * from, which is 0: `FightScene.simFrame` resets to 0 on entry and is what
   * gets passed to `canAdvance`/`prepare`. Passing anything machine-local here
   * (the render loop's frame, say) is silently catastrophic rather than merely
   * wrong: `flush` clamps `from` up to `origin`, so with an origin of a few
   * thousand and a target of `simFrame + delay`, `from > target` and the loop
   * `continue`s — NO INPUT IS EVER SENT. Meanwhile `lookup` reads every frame
   * as inside the opening grace window and hands back 0, so both peers run
   * happily, each watching a perfectly motionless copy of the other.
   */
  reset(startFrame = 0): void {
    this.origin = startFrame;
    this.lastFlush = startFrame - 999;
    this.lastPrune = startFrame;
    this._stalled = 0;
    this.held = false;
    this._desynced = false;
    this._timedOut = false;
    this._waiting.length = 0;
    this.dropped.clear();
    this.localChecks.clear();
    this.remoteChecks.clear();
    for (const hist of this.inputs.values()) hist.clear();
    this.onRoster(this.session.players);
  }

  /** Returns true when the sim may advance this frame. */
  canAdvance(frame: number): boolean {
    this._waiting.length = 0;
    if (!this.active) {
      this._stalled = 0;
      return true;
    }

    for (const slot of this.activeSlots) {
      if (this.lookup(slot, frame) === undefined) this._waiting.push(slot);
    }

    if (this._waiting.length === 0) {
      this._stalled = 0;
      return true;
    }

    this._stalled++;
    // The peer may simply have lost a packet; nudge them with our history.
    if (this._stalled % RESEND_EVERY === 0) this.flush(frame, true);

    // Somebody is reading a cinematic. They are not gone, they are busy, and
    // dropping them for it would end the match at the exact moment the game is
    // trying to tell them a story.
    if (this.held) this._stalled = 0;

    if (this._stalled > NET_TIMEOUT_FRAMES) {
      for (const slot of this._waiting) this.dropSlot(slot);
      this._timedOut = true;
      this._stalled = 0;
      this._waiting.length = 0;
      return true;
    }
    return false;
  }

  /** Push local input onto the wire and pull everyone's input into the sim. */
  prepare(frame: number): void {
    if (!this.active) return;

    const target = frame + this.delay;
    for (const slot of this.localSlots) {
      // Read the source rather than InputManager.raw(): raw() would hand back
      // whatever we injected last frame, which would compound the delay if the
      // caller ever sampled after us.
      const src = this.input.source(slot);
      const mask = (src ? src.sample(frame) : this.input.raw(slot)) | 0;
      this.store(slot, target, mask);
    }
    this.flush(frame, false);

    for (const slot of this.activeSlots) {
      const mask = this.lookup(slot, frame);
      if (mask !== undefined) this.input.override(slot, mask);
    }

    if (frame - this.lastPrune >= 64) {
      this.lastPrune = frame;
      this.prune(frame);
    }
  }

  /** Cheap test so the caller can skip hashing the world on non-sync frames. */
  shouldChecksum(frame: number): boolean {
    return this.active && frame % SYNC_INTERVAL === 0;
  }

  confirm(frame: number, checksum: number): void {
    if (!this.active) return;
    if (frame % SYNC_INTERVAL !== 0) return;

    const c = checksum | 0;
    this.localChecks.set(frame, c);
    this.session.send({ t: 'sync', epoch: this.epoch, frame, checksum: c });

    const bucket = this.remoteChecks.get(frame);
    if (bucket) {
      for (const [peer, remote] of bucket) {
        if (remote !== c) this.flagDesync(frame, peer, c, remote);
      }
      this.remoteChecks.delete(frame);
    }

    for (const f of this.localChecks.keys()) {
      if (f < frame - SYNC_INTERVAL * 8) this.localChecks.delete(f);
    }
  }

  /** Detach from the session. Call when the match ends. */
  dispose(): void {
    this.session.offMessage(this.onNet);
    this.session.offPlayersChanged(this.onRoster);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private readonly onRoster = (players: NetPlayer[]): void => {
    const localId = this.session.localId;
    const active: number[] = [];
    const local: number[] = [];

    for (const p of players) {
      active.push(p.slot);
      if (localId && p.peerId === localId) local.push(p.slot);
    }
    if (local.length === 0 && this.session.slot >= 0) local.push(this.session.slot);

    // Anyone who left stops being waited on: their input reads as "no buttons"
    // from here on and the fight carries on without them.
    for (const slot of this.activeSlots) {
      if (!active.includes(slot)) this.dropSlot(slot);
    }

    active.sort((a, b) => a - b);
    local.sort((a, b) => a - b);
    this.activeSlots = active;
    this.localSlots = local;

    for (const slot of active) {
      if (!this.inputs.has(slot)) this.inputs.set(slot, new Map());
    }
  };

  private readonly onNet = (m: NetMessage, from: string): void => {
    if (m.t === 'in') {
      // A delayed packet from the prior fight may arrive after the new fight's
      // frame counter reset. Never let it masquerade as current frame input.
      if ((m.epoch >>> 0) !== this.epoch) return;
      // Nobody else gets to drive a slot we own.
      if (this.localSlots.includes(m.slot)) return;
      if (this.dropped.has(m.slot)) return;
      const n = m.inputs.length;
      for (let i = 0; i < n; i++) this.store(m.slot, m.from + i, m.inputs[i] | 0);
      return;
    }

    if (m.t === 'sync') {
      if ((m.epoch >>> 0) !== this.epoch) return;
      const remote = m.checksum | 0;
      const local = this.localChecks.get(m.frame);
      if (local === undefined) {
        let bucket = this.remoteChecks.get(m.frame);
        if (!bucket) {
          bucket = new Map();
          this.remoteChecks.set(m.frame, bucket);
        }
        bucket.set(from, remote);
        if (this.remoteChecks.size > 16) {
          const oldest = Math.min(...this.remoteChecks.keys());
          this.remoteChecks.delete(oldest);
        }
      } else if (local !== remote) {
        this.flagDesync(m.frame, from, local, remote);
      }
      return;
    }

    if (m.t === 'start') {
      this.configureDelay(m.inputDelay);
      this.configureEpoch(m.epoch);
      this.reset(m.startFrame);
    }
  };

  private store(slot: number, frame: number, mask: BtnMask): void {
    let hist = this.inputs.get(slot);
    if (!hist) {
      hist = new Map();
      this.inputs.set(slot, hist);
    }
    // First write wins: a redundant copy must never overwrite what we already
    // simulated, or peers would diverge on a resend.
    if (!hist.has(frame)) hist.set(frame, mask | 0);
  }

  private lookup(slot: number, frame: number): BtnMask | undefined {
    if (this.dropped.has(slot)) return 0;
    // The opening `delay` frames have no transmitted input by definition.
    if (frame < this.origin + this.delay) return 0;
    return this.inputs.get(slot)?.get(frame);
  }

  /**
   * One packet carries the newly-sampled frame plus a few already-sent ones, so
   * a single dropped datagram never costs a stall and the packet rate stays at
   * or below one per simulated frame.
   */
  private flush(frame: number, force: boolean): void {
    if (!force && frame - this.lastFlush < this.sendInterval) return;
    this.lastFlush = frame;

    const target = frame + this.delay;
    const span = this.sendInterval + REDUNDANCY;
    for (const slot of this.localSlots) {
      const hist = this.inputs.get(slot);
      if (!hist) continue;
      const from = Math.max(this.origin, target - span + 1);
      if (from > target) continue;
      const inputs: number[] = [];
      for (let f = from; f <= target; f++) inputs.push(hist.get(f) ?? 0);
      this.session.send({ t: 'in', epoch: this.epoch, slot, from, inputs });
    }
  }

  private dropSlot(slot: number): void {
    if (this.dropped.has(slot)) return;
    this.dropped.add(slot);
    this.inputs.get(slot)?.clear();
    const i = this._waiting.indexOf(slot);
    if (i >= 0) this._waiting.splice(i, 1);
  }

  private prune(frame: number): void {
    const cutoff = frame - HISTORY;
    for (const hist of this.inputs.values()) {
      for (const f of hist.keys()) {
        if (f < cutoff) hist.delete(f);
      }
    }
  }

  private flagDesync(frame: number, peer: string, local: number, remote: number): void {
    if (this._desynced) return;
    this._desynced = true;
    console.error(
      `[net] desync at frame ${frame}: local checksum ${local >>> 0} != ${remote >>> 0} from ${peer}. ` +
        'The simulations have diverged; the match is no longer trustworthy.',
    );
  }
}

function sendEvery(delay: number): number {
  // With a generous delay we can afford to pack several frames per packet and
  // cut the send rate; with a tight delay every frame goes out on its own.
  return Math.max(1, Math.min(3, Math.floor(delay / 3)));
}
