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
  isInputDelayCapped,
  recommendedInputDelay,
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

  constructor(readonly oneWayFrames: number) {}

  send(sender: FakeSession, message: NetMessage): void {
    const target = sender.other;
    if (!target) return;
    this.pending.push({ at: this.tick + this.oneWayFrames, to: target, from: sender.localId, message });
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

function simulate(delay: number, oneWayFrames: number, wallFrames = 600): number[] {
  const wire = new FakeWire(oneWayFrames);
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

  for (wire.tick = 0; wire.tick < wallFrames; wire.tick++) {
    wire.deliver();
    for (let i = 0; i < locks.length; i++) {
      locks[i].prepare(frames[i]);
      if (locks[i].canAdvance(frames[i])) frames[i]++;
    }
  }
  for (const lock of locks) lock.dispose();
  return frames;
}

function main(): void {
  const first = addRttSample(EMPTY_RTT, 100);
  const second = addRttSample(first, 140);
  assert.deepEqual(first, { rttMs: 100, jitterMs: 0, samples: 1 });
  assert.equal(second.rttMs, 105);
  assert.equal(second.jitterMs, 10);

  assert.equal(recommendedInputDelay({ rttMs: 0, jitterMs: 0 }), 3);
  assert.equal(recommendedInputDelay({ rttMs: 100, jitterMs: 0 }), 9);
  assert.equal(recommendedInputDelay({ rttMs: 250, jitterMs: 0 }), 18);
  assert.equal(recommendedInputDelay({ rttMs: 500, jitterMs: 0 }), 24);
  assert.equal(isInputDelayCapped({ rttMs: 500, jitterMs: 0 }), true);

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

  const starved = simulate(3, 15);
  const buffered = simulate(24, 15);
  assert.ok(Math.min(...starved) < 300, `3f lead unexpectedly advanced ${starved.join('/')} frames`);
  assert.ok(Math.min(...buffered) >= 595, `24f lead only advanced ${buffered.join('/')} frames`);
  assert.ok(Math.abs(buffered[0] - buffered[1]) <= 1, `peers drifted: ${buffered.join('/')}`);

  process.stdout.write(
    `PASS  netcode latency/replay regression (3f=${starved.join('/')}, 24f=${buffered.join('/')})\n`,
  );
}

main();
