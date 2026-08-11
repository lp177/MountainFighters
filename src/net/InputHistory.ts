import type { NetMessage } from '@/core/types';

export type InputPacket = Extract<NetMessage, { t: 'in' }>;

/**
 * Per-link copy of recently transmitted frame input.
 *
 * The normal input lane is unordered. If it fails, the two endpoints switch
 * to ordered control at slightly different times, so packets sent during that
 * transition can disappear with the old lane. Replaying this bounded history
 * after the ordered fallback marker closes that race; Lockstep's first-write-
 * wins storage makes duplicates harmless.
 */
export class InputHistory {
  private readonly slots = new Map<number, Map<number, number>>();
  private readonly newest = new Map<number, number>();
  private epoch: number | null = null;

  constructor(
    private readonly maxFrames: number,
    private readonly chunkFrames = 60,
  ) {}

  /** Start a new frame-numbering epoch and discard packets from the prior fight. */
  begin(epoch: number): void {
    this.slots.clear();
    this.newest.clear();
    this.epoch = epoch >>> 0;
  }

  /** False means this packet belongs to an old/future fight and must not be sent. */
  remember(packet: InputPacket): boolean {
    const epoch = packet.epoch >>> 0;
    if (this.epoch === null) this.epoch = epoch;
    if (epoch !== this.epoch || packet.inputs.length === 0) return false;
    let history = this.slots.get(packet.slot);
    if (!history) {
      history = new Map();
      this.slots.set(packet.slot, history);
    }

    for (let i = 0; i < packet.inputs.length; i++) {
      history.set(packet.from + i, packet.inputs[i] | 0);
    }

    const last = packet.from + packet.inputs.length - 1;
    const newest = Math.max(this.newest.get(packet.slot) ?? last, last);
    this.newest.set(packet.slot, newest);
    const cutoff = newest - Math.max(1, this.maxFrames) + 1;
    for (const frame of history.keys()) {
      if (frame < cutoff) history.delete(frame);
    }
    return true;
  }

  /** Contiguous, bounded packets suitable for replay on an ordered channel. */
  packets(): InputPacket[] {
    const out: InputPacket[] = [];
    const chunkSize = Math.max(1, this.chunkFrames);

    for (const slot of [...this.slots.keys()].sort((a, b) => a - b)) {
      const history = this.slots.get(slot);
      if (!history) continue;
      const frames = [...history.keys()].sort((a, b) => a - b);
      let from = 0;
      let previous = -Infinity;
      let inputs: number[] = [];

      const flush = () => {
        if (inputs.length === 0) return;
        out.push({ t: 'in', epoch: this.epoch ?? 0, slot, from, inputs });
        inputs = [];
      };

      for (const frame of frames) {
        if (inputs.length === 0) from = frame;
        if (inputs.length > 0 && (frame !== previous + 1 || inputs.length >= chunkSize)) {
          flush();
          from = frame;
        }
        inputs.push(history.get(frame) ?? 0);
        previous = frame;
      }
      flush();
    }
    return out;
  }
}
