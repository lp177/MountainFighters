import type { BtnMask, InputFrame, InputSource } from '@/core/types';
import { pollGamepads } from '@/engine/input/GamepadSource';

interface SlotState {
  src: InputSource | null;
  /** Stable object handed out by get(); mutated in place, never reallocated. */
  frame: InputFrame;
  /** Mask at the end of the previous sim frame; the pressed/released baseline. */
  prev: BtnMask;
  cur: BtnMask;
  /** Netcode-injected mask waiting to be consumed. */
  pending: BtnMask | null;
  sampledFrame: number;
}

/** Returned for slots nobody has claimed. Never mutated. */
const ZERO_FRAME: InputFrame = { held: 0, pressed: 0, released: 0 };

export class InputManager {
  private readonly states = new Map<number, SlotState>();
  private readonly slotList: number[] = [];
  private frame = -1;

  get slots(): number[] {
    return this.slotList;
  }

  /** Bind an input source to a player slot. */
  attach(slot: number, src: InputSource): void {
    const st = this.ensure(slot);
    st.src = src;
    this.resetState(st);
  }

  detach(slot: number): void {
    const st = this.states.get(slot);
    if (!st) return;
    this.states.delete(slot);
    const i = this.slotList.indexOf(slot);
    if (i >= 0) this.slotList.splice(i, 1);
  }

  source(slot: number): InputSource | null {
    return this.states.get(slot)?.src ?? null;
  }

  /** Sample every attached source for this frame. Call once per sim step. */
  sampleAll(frame: number): void {
    this.frame = frame;
    pollGamepads();
    for (const slot of this.slotList) {
      const st = this.states.get(slot);
      if (!st) continue;
      let mask: BtnMask;
      if (st.pending !== null) {
        mask = st.pending;
        st.pending = null;
      } else {
        mask = st.src ? st.src.sample(frame) | 0 : 0;
      }
      // Roll the edge-detection baseline exactly once per frame, so a late
      // override() can be re-applied without losing pressed/released.
      if (st.sampledFrame !== frame) st.prev = st.cur;
      this.apply(st, mask);
      st.sampledFrame = frame;
    }
  }

  /** Resolved input for a slot on the current frame, with pressed/released. */
  get(slot: number): InputFrame {
    return this.states.get(slot)?.frame ?? ZERO_FRAME;
  }

  /** Raw held mask, used by the netcode to transmit. */
  raw(slot: number): BtnMask {
    return this.states.get(slot)?.cur ?? 0;
  }

  /**
   * Override a slot's mask — used by lockstep to inject remote input. The
   * override always beats the slot's local source for the frame it lands on,
   * whether it arrives before or after sampleAll().
   */
  override(slot: number, mask: BtnMask): void {
    const st = this.ensure(slot);
    const m = mask | 0;
    if (st.sampledFrame === this.frame && this.frame >= 0) {
      // Already sampled this frame: re-derive from the previous frame's mask so
      // pressed/released stay correct instead of double-counting.
      this.apply(st, m);
      st.pending = null;
    } else {
      st.pending = m;
    }
  }

  private apply(st: SlotState, mask: BtnMask): void {
    st.cur = mask;
    st.frame.held = mask;
    st.frame.pressed = mask & ~st.prev;
    st.frame.released = st.prev & ~mask;
  }

  private resetState(st: SlotState): void {
    st.prev = 0;
    st.cur = 0;
    st.pending = null;
    st.sampledFrame = -1;
    st.frame.held = 0;
    st.frame.pressed = 0;
    st.frame.released = 0;
  }

  private ensure(slot: number): SlotState {
    let st = this.states.get(slot);
    if (!st) {
      st = {
        src: null,
        frame: { held: 0, pressed: 0, released: 0 },
        prev: 0,
        cur: 0,
        pending: null,
        sampledFrame: -1,
      };
      this.states.set(slot, st);
      this.slotList.push(slot);
      this.slotList.sort((a, b) => a - b);
    }
    return st;
  }
}
