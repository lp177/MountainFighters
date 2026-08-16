/** Dependency-free regression checks for latency sizing and lockstep pacing. */

import assert from 'node:assert/strict';

import type { NetMessage, NetPlayer, NetRole } from '@/core/types';
import type { InputManager } from '@/engine/input/InputManager';
import { InputHistory } from '@/net/InputHistory';
import { Lockstep } from '@/net/Lockstep';
import type { NetSession } from '@/net/NetSession';
import {
  EMPTY_RTT,
  addRttSample,
  combinedRouteBudgetMs,
  isBudgetCapped,
  isInputDelayCapped,
  recommendedInputDelay,
  recommendedInputDelayForBudget,
  routeBudgetMs,
} from '@/net/latency';

type MessageFn = (message: NetMessage, from: string) => void;
type RosterFn = (players: NetPlayer[]) => void;

class FakeInput {
  readonly masks = new Map<number, number>();

  source(slot: number): { sample: (frame: number) => number } {
    return { sample: (frame) => ((slot + 1) << (frame % 3)) | 0 };
  }

  raw(slot: number): number {
    return this.masks.get(slot) ?? 0;
  }

  override(slot: number, mask: number): void {
    this.masks.set(slot, mask | 0);
  }
}

class FakeWire {
  tick = 0;
  readonly pending: Array<{ at: number; to: FakeSession; from: string; message: NetMessage }> = [];

  constructor(
    readonly oneWayFrames: number,
    /** Deterministic per-packet latency wobble in ticks; the lane is unordered. */
    readonly jitter?: (tick: number) => number,
  ) {}

  send(sender: FakeSession, message: NetMessage): void {
    const target = sender.other;
    if (!target) return;
    const wobble = this.jitter ? this.jitter(this.tick) : 0;
    this.pending.push({
      at: this.tick + this.oneWayFrames + wobble,
      to: target,
      from: sender.localId,
      message,
    });
  }

  deliver(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const packet = this.pending[i];
      if (packet.at > this.tick) continue;
      this.pending.splice(i, 1);
      packet.to.receive(packet.message, packet.from);
    }
  }
}

class FakeSession {
  other: FakeSession | null = null;
  readonly players: NetPlayer[];
  readonly role: NetRole;
  readonly localId: string;
  readonly slot: number;
  private readonly messageFns: MessageFn[] = [];
  private readonly rosterFns: RosterFn[] = [];

  constructor(private readonly wire: FakeWire, host: boolean) {
    this.role = host ? 'host' : 'guest';
    this.localId = host ? 'host' : 'guest';
    this.slot = host ? 0 : 1;
    this.players = [
      { peerId: 'host', slot: 0, name: 'Host', dwarfId: 'grumpy', ready: true, ping: 0 },
      { peerId: 'guest', slot: 1, name: 'Guest', dwarfId: 'doc', ready: true, ping: 0 },
    ];
  }

  send(message: NetMessage): void {
    this.wire.send(this, message);
  }

  onMessage(fn: MessageFn): void {
    this.messageFns.push(fn);
  }

  offMessage(fn: MessageFn): void {
    const i = this.messageFns.indexOf(fn);
    if (i >= 0) this.messageFns.splice(i, 1);
  }

  onPlayersChanged(fn: RosterFn): void {
    this.rosterFns.push(fn);
    fn(this.players);
  }

  offPlayersChanged(fn: RosterFn): void {
    const i = this.rosterFns.indexOf(fn);
    if (i >= 0) this.rosterFns.splice(i, 1);
  }

  receive(message: NetMessage, from: string): void {
    for (const fn of this.messageFns.slice()) fn(message, from);
  }
}

interface SimOptions {
  wallFrames?: number;
  /** Ticks before the guest's sim starts, modelling `start` crossing the link. */
  guestLagTicks?: number;
  jitter?: (tick: number) => number;
  /** Stall onsets at or after this tick count as "late" — the start offset is burnt by then. */
  settleTicks?: number;
}

function simulate(
  delay: number,
  oneWayFrames: number,
  opts: SimOptions = {},
): { frames: number[]; lateStalls: number } {
  const { wallFrames = 600, guestLagTicks = 0, jitter, settleTicks = 150 } = opts;
  const wire = new FakeWire(oneWayFrames, jitter);
  const sessions = [new FakeSession(wire, true), new FakeSession(wire, false)];
  sessions[0].other = sessions[1];
  sessions[1].other = sessions[0];
  const locks = sessions.map(
    (session) =>
      new Lockstep(
        session as unknown as NetSession,
        new FakeInput() as unknown as InputManager,
        { inputDelay: delay },
      ),
  );
  const frames = [0, 0];
  const wasStalled = [false, false];
  let lateStalls = 0;

  for (wire.tick = 0; wire.tick < wallFrames; wire.tick++) {
    wire.deliver();
    for (let i = 0; i < locks.length; i++) {
      if (i === 1 && wire.tick < guestLagTicks) continue;
      locks[i].prepare(frames[i]);
      if (locks[i].canAdvance(frames[i])) {
        frames[i]++;
        wasStalled[i] = false;
      } else {
        // Count onsets, not stalled ticks: the refill cushion deliberately
        // trades fewer hitches for slightly longer ones, so ticks would score
        // the fix worse than the defect it repairs.
        if (!wasStalled[i] && wire.tick >= settleTicks) lateStalls++;
        wasStalled[i] = true;
      }
    }
  }
  for (const lock of locks) lock.dispose();
  return { frames, lateStalls };
}

function main(): void {
  const first = addRttSample(EMPTY_RTT, 100);
  const second = addRttSample(first, 140);
  assert.deepEqual(first, { rttMs: 100, jitterMs: 0, samples: 1 });
  assert.equal(second.rttMs, 105);
  assert.equal(second.jitterMs, 10);

  // The lead covers the one-way trip plus two jitter deviations plus two
  // safety frames, floored at 3 and capped at 24.
  assert.equal(recommendedInputDelay({ rttMs: 0, jitterMs: 0 }), 3);
  assert.equal(recommendedInputDelay({ rttMs: 100, jitterMs: 0 }), 5);
  assert.equal(recommendedInputDelay({ rttMs: 100, jitterMs: 10 }), 7);
  assert.equal(recommendedInputDelay({ rttMs: 250, jitterMs: 0 }), 10);
  assert.equal(recommendedInputDelay({ rttMs: 500, jitterMs: 0 }), 17);
  assert.equal(recommendedInputDelay({ rttMs: 800, jitterMs: 0 }), 24);
  assert.equal(isInputDelayCapped({ rttMs: 500, jitterMs: 0 }), false);
  assert.equal(isInputDelayCapped({ rttMs: 800, jitterMs: 0 }), true);

  // Route combination: one link is host<->guest; the two worst links summed is
  // the relayed guest<->guest path through the host.
  assert.equal(routeBudgetMs({ rttMs: 100, jitterMs: 10 }), 70);
  assert.equal(routeBudgetMs({ rttMs: 0, jitterMs: 10 }), 0);
  assert.equal(combinedRouteBudgetMs([]), 0);
  assert.equal(combinedRouteBudgetMs([70]), 70);
  assert.equal(combinedRouteBudgetMs([40, 70, 25]), 110);
  assert.equal(combinedRouteBudgetMs([Number.NaN, -5, 70]), 70);
  assert.equal(recommendedInputDelayForBudget(0), 3);
  assert.equal(recommendedInputDelayForBudget(70), 7);
  assert.equal(isBudgetCapped(400), true);

  const replay = new InputHistory(6, 3);
  replay.begin(7);
  assert.equal(
    replay.remember({ t: 'in', epoch: 7, slot: 1, from: 0, inputs: [0, 1, 2, 3, 4, 5] }),
    true,
  );
  assert.equal(
    replay.remember({ t: 'in', epoch: 7, slot: 1, from: 6, inputs: [6, 7] }),
    true,
  );
  assert.deepEqual(replay.packets(), [
    { t: 'in', epoch: 7, slot: 1, from: 2, inputs: [2, 3, 4] },
    { t: 'in', epoch: 7, slot: 1, from: 5, inputs: [5, 6, 7] },
  ]);
  replay.begin(8);
  assert.equal(
    replay.remember({ t: 'in', epoch: 7, slot: 1, from: 8, inputs: [99] }),
    false,
  );
  assert.deepEqual(replay.packets(), []);
  assert.equal(
    replay.remember({ t: 'in', epoch: 8, slot: 1, from: 0, inputs: [42] }),
    true,
  );
  assert.deepEqual(replay.packets(), [
    { t: 'in', epoch: 8, slot: 1, from: 0, inputs: [42] },
  ]);

  const starved = simulate(3, 15).frames;
  const oneWay = simulate(16, 15).frames;
  const buffered = simulate(24, 15).frames;
  assert.ok(Math.min(...starved) < 300, `3f lead unexpectedly advanced ${starved.join('/')} frames`);
  // A lead only one frame above the one-way trip must run clean in steady
  // state: that is the premise of sizing the delay from the one-way route.
  assert.ok(Math.min(...oneWay) >= 595, `16f lead only advanced ${oneWay.join('/')} frames`);
  assert.ok(Math.min(...buffered) >= 595, `24f lead only advanced ${buffered.join('/')} frames`);
  assert.ok(Math.abs(buffered[0] - buffered[1]) <= 1, `peers drifted: ${buffered.join('/')}`);

  // The hostile case one-way sizing must survive, at the delay the sizing
  // itself picks for this link (15-tick one-way = 500ms RTT, ±2 ticks ≈ 33ms
  // jitter → 21 frames): the guest's sim starts one one-way trip after the
  // host's (`start` crossing the link), and latency creeps up a tick every
  // five seconds so new records keep being set long after the start offset
  // has burnt off. The burn-off re-anchors the host to arriving packets with
  // no spare margin, so without the RESUME_CUSHION refill each later record
  // would be one more visible stall.
  assert.equal(recommendedInputDelay({ rttMs: 500, jitterMs: 33 }), 21);
  const wobble = simulate(21, 15, {
    wallFrames: 1200,
    guestLagTicks: 15,
    jitter: (tick) => ((tick * 7) % 5) - 2 + Math.floor(tick / 300),
  });
  assert.ok(
    Math.min(...wobble.frames) >= 1150,
    `offset+jitter run only advanced ${wobble.frames.join('/')} frames`,
  );
  assert.ok(
    wobble.lateStalls <= 2,
    `offset+jitter run had ${wobble.lateStalls} stall onsets after settling`,
  );

  process.stdout.write(
    `PASS  netcode latency/replay regression (3f=${starved.join('/')}, 16f=${oneWay.join('/')}, ` +
      `24f=${buffered.join('/')}, wobble=${wobble.frames.join('/')}+${wobble.lateStalls} late stalls)\n`,
  );
}

main();
