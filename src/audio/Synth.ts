/**
 * Every sound in Mountain Fighters is DSP. The repository ships zero audio
 * files: each cue below is a recipe of oscillators, pre-rendered noise,
 * biquad filters, waveshapers and envelopes, built fresh on every trigger.
 *
 * GORE VARIANTS — how the finishers get sounds the cue list does not name.
 *
 * `SfxCue` lives in the frozen shared contract, so the fatality library cannot
 * be handed a 'squelch' or a 'cloth_tear' cue: those names do not exist and
 * cannot be added. What CAN be added is what a cue does at a playback rate no
 * existing call site uses. Five cues therefore branch on `pitch`, far outside
 * their normal range, into a full second recipe:
 *
 *     hit_flesh  @ <=0.75   wet squelch      (normal game use: 0.8 .. 1.1)
 *     bone_crack @ <=0.82   bone snapping    (normal game use: 0.9 .. 1.55)
 *     whiff      @ >=1.5    cloth tearing    (normal game use: 0.55 .. 1.35)
 *     grunt      @ <=0.75   gulp / swallow   (normal game use: ~1.0)
 *     land       @ <=0.75   heavy body drop  (normal game use: 0.9 .. 1.1)
 *
 * Nothing in the game plays those cues in the variant range today, so no
 * existing sound changes; the plain recipes are untouched. Use `GORE_SFX` below
 * rather than hard-coding the numbers.
 */

import { clamp } from '@/core/math';
import type { SfxCue, VoiceProfile } from '@/core/types';

/**
 * The gore palette, as (cue, pitch) pairs. `audio.play(GORE_SFX.gulp.cue, {
 * pitch: GORE_SFX.gulp.pitch })` gets you a swallow; the same cue at its normal
 * pitch is still the same grunt it always was.
 */
export const GORE_SFX = {
  /** Wet, sucking, unmistakably organic. The workhorse of the fatality library. */
  squelch: { cue: 'hit_flesh', pitch: 0.6 },
  /** A snap with splinters and meat around it, not the dry tick of a light hit. */
  boneSnap: { cue: 'bone_crack', pitch: 0.7 },
  /** Fabric giving way — a jacket, a shirt, a hat being torn off a head. */
  clothTear: { cue: 'whiff', pitch: 1.8 },
  /** Chew, chew, swallow. For the enemy who eats your hat. */
  gulp: { cue: 'grunt', pitch: 0.55 },
  /** A whole body arriving on the floor at speed. */
  bodyImpact: { cue: 'land', pitch: 0.6 },
} as const satisfies Record<string, { cue: SfxCue; pitch: number }>;

/** Playback rates at which the five cues above swap to their gore recipe. */
const SQUELCH_BELOW = 0.75;
const BONE_SNAP_BELOW = 0.82;
const CLOTH_TEAR_ABOVE = 1.5;
const GULP_BELOW = 0.75;
const BODY_IMPACT_BELOW = 0.75;

/** Hard cap on simultaneous voices. Over budget, the quietest voice dies. */
const MAX_VOICES = 24;
/** Length of the pre-rendered white-noise buffer, in seconds. */
const NOISE_SECONDS = 2;

/**
 * Cull weighting. A loud gunshot should never be dropped so a footstep can
 * live; these multipliers bias the "quietest voice" search.
 */
const PRIORITY: Partial<Record<SfxCue, number>> = {
  ko: 6,
  super_blast: 6,
  super_charge: 4,
  explosion: 3.5,
  gunshot: 3,
  meter_full: 2.5,
  bone_crack: 2,
  punch_heavy: 1.8,
  ui_move: 2,
  ui_select: 2.5,
  ui_back: 2.5,
  ui_error: 2.5,
  coin: 2,
};

interface ActiveVoice {
  gain: GainNode;
  pan: StereoPannerNode;
  sources: AudioScheduledSourceNode[];
  /** Context time at which the voice is finished and can be unhooked. */
  ends: number;
  /** Cull weight. -1 marks a voice that is already dying. */
  loud: number;
}

type Curve = Float32Array<ArrayBuffer>;

const curveCache = new Map<string, Curve>();

function driveCurve(amount: number): Curve {
  const key = `d${amount}`;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(amount * x) / norm;
  }
  curveCache.set(key, c);
  return c;
}

function crushCurve(steps: number): Curve {
  const key = `c${steps}`;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * steps) / steps;
  }
  curveCache.set(key, c);
  return c;
}

/**
 * A scratch graph for one triggered sound. Nodes register themselves so the
 * whole patch can be started and stopped as a unit.
 */
class Patch {
  readonly sources: AudioScheduledSourceNode[] = [];
  private readonly offsets: number[] = [];

  constructor(
    readonly ctx: AudioContext,
    readonly out: AudioNode,
    readonly t: number,
    private readonly noiseBuf: AudioBuffer,
  ) {}

  osc(type: OscillatorType, freq: number, at = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(freq, 0.01), this.t + at);
    this.sources.push(o);
    this.offsets.push(at);
    return o;
  }

  noise(rate = 1, at = 0): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    this.sources.push(s);
    this.offsets.push(at);
    return s;
  }

  gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(freq, 10), this.t);
    f.Q.value = q;
    return f;
  }

  drive(amount: number): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = driveCurve(amount);
    w.oversample = '2x';
    return w;
  }

  crush(steps: number): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = crushCurve(steps);
    return w;
  }

  /** Percussive envelope: linear attack to peak, exponential decay to zero. */
  env(g: GainNode, peak: number, attack: number, decay: number, at = 0): void {
    const t = this.t + at;
    const pk = Math.max(peak, 0.0002);
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(pk, t + attack);
    p.exponentialRampToValueAtTime(0.0002, t + attack + decay);
    p.setValueAtTime(0, t + attack + decay + 0.002);
  }

  /** Adds a low-frequency oscillator onto an AudioParam. */
  lfo(param: AudioParam, freq: number, depth: number, wave: OscillatorType = 'sine', at = 0): OscillatorNode {
    const o = this.osc(wave, freq, at);
    const g = this.gain(depth);
    o.connect(g);
    g.connect(param);
    return o;
  }

  /** Starts every registered source and schedules its stop. */
  play(dur: number): void {
    const stop = this.t + dur;
    const maxOffset = Math.max(0.05, NOISE_SECONDS - dur - 0.05);
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      const at = this.t + this.offsets[i];
      try {
        if (s instanceof AudioBufferSourceNode) {
          s.start(at, Math.random() * maxOffset);
        } else {
          s.start(at);
        }
        s.stop(Math.max(stop, at + 0.01));
      } catch {
        /* a source can only be scheduled once */
      }
    }
  }
}

type VoiceKind = 'hit' | 'attack' | 'ko' | 'taunt' | 'jump';

interface TimbreShape {
  wave: OscillatorType;
  /** Primary formant. */
  f1: number;
  q1: number;
  /** Secondary formant, gives the vowel its colour. */
  f2: number;
  q2: number;
  /** How much breath noise is mixed in. */
  breath: number;
  /** Sub-octave weight. */
  sub: number;
  drive: number;
}

function timbreShape(t: VoiceProfile['timbre']): TimbreShape {
  const found: TimbreShape | undefined = TIMBRES[t];
  return found ?? TIMBRES.gruff;
}

const TIMBRES: Record<VoiceProfile['timbre'], TimbreShape> = {
  gruff: { wave: 'sawtooth', f1: 620, q1: 4, f2: 1250, q2: 6, breath: 0.16, sub: 0.35, drive: 6 },
  nasal: { wave: 'square', f1: 1750, q1: 9, f2: 2600, q2: 10, breath: 0.08, sub: 0.05, drive: 3 },
  deep: { wave: 'sawtooth', f1: 360, q1: 2.5, f2: 780, q2: 3, breath: 0.1, sub: 0.6, drive: 4 },
  squeak: { wave: 'triangle', f1: 2450, q1: 7, f2: 3400, q2: 8, breath: 0.12, sub: 0, drive: 2 },
  wheeze: { wave: 'sawtooth', f1: 1050, q1: 1.6, f2: 2100, q2: 2, breath: 0.75, sub: 0.15, drive: 2.5 },
};

export class Synth {
  private _ctx: AudioContext | null = null;
  private _master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private voices: ActiveVoice[] = [];
  private masterVol = 0.8;
  private sfxVol = 0.9;

  /** The shared AudioContext, or null until something has unlocked audio. */
  get context(): AudioContext | null {
    return this._ctx;
  }

  /** Master bus. Music mixes into this alongside the sfx bus. */
  get master(): GainNode | null {
    return this._master;
  }

  get ready(): boolean {
    return this._ctx !== null && this._ctx.state === 'running';
  }

  /** Must be called from a user gesture. Creates the context and resumes it. */
  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    // Nudging one silent buffer through the graph satisfies iOS's unlock rule.
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      s.stop(ctx.currentTime + 0.001);
    } catch {
      /* nothing to unlock */
    }
  }

  setVolume(master: number, sfx: number): void {
    this.masterVol = clamp(master, 0, 1);
    this.sfxVol = clamp(sfx, 0, 1);
    const ctx = this._ctx;
    if (!ctx || !this._master || !this.sfxBus) return;
    const t = ctx.currentTime;
    this._master.gain.setTargetAtTime(this.masterVol, t, 0.02);
    this.sfxBus.gain.setTargetAtTime(this.sfxVol, t, 0.02);
  }

  play(cue: SfxCue, opts?: { pitch?: number; gain?: number; pan?: number }): void {
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.sfxBus || !this.noiseBuf) return;

    const pitch = clamp(opts?.pitch ?? 1, 0.25, 4);
    const gain = clamp(opts?.gain ?? 1, 0, 4);
    const pan = clamp(opts?.pan ?? 0, -1, 1);
    const loud = gain * (PRIORITY[cue] ?? 1);

    const now = ctx.currentTime;
    if (!this.reserve(now, loud)) return;

    const t = now + 0.003;
    const vg = ctx.createGain();
    vg.gain.value = gain;
    const pn = ctx.createStereoPanner();
    pn.pan.value = pan;
    vg.connect(pn);
    pn.connect(this.sfxBus);

    const p = new Patch(ctx, vg, t, this.noiseBuf);
    const dur = this.build(p, cue, pitch);
    p.play(dur + 0.03);
    this.voices.push({ gain: vg, pan: pn, sources: p.sources, ends: t + dur + 0.08, loud });
  }

  /**
   * Procedural grunt. The profile's pitch sets the larynx, the timbre picks a
   * formant pair, the wobble detunes and shakes it, and `kind` decides the
   * pitch contour and envelope.
   */
  voice(profile: VoiceProfile, kind: VoiceKind): void {
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.sfxBus || !this.noiseBuf) return;

    const now = ctx.currentTime;
    if (!this.reserve(now, kind === 'ko' ? 5 : 1.2)) return;

    const shape = timbreShape(profile.timbre);
    const wobble = clamp(profile.wobble, 0, 1);
    const base = clamp(profile.pitch, 40, 900) * (1 + (Math.random() * 2 - 1) * wobble * 0.09);

    const t = now + 0.003;
    const vg = ctx.createGain();
    vg.gain.value = 1;
    const pn = ctx.createStereoPanner();
    pn.pan.value = (Math.random() * 2 - 1) * 0.15;
    vg.connect(pn);
    pn.connect(this.sfxBus);

    const p = new Patch(ctx, vg, t, this.noiseBuf);

    let dur: number;
    let start: number;
    let mid: number;
    let end: number;
    let attack: number;
    let level: number;
    switch (kind) {
      case 'attack':
        dur = 0.19;
        start = base * 0.95;
        mid = base * 1.22;
        end = base * 0.86;
        attack = 0.012;
        level = 0.5;
        break;
      case 'ko':
        dur = 0.72;
        start = base * 1.12;
        mid = base * 0.85;
        end = base * 0.32;
        attack = 0.03;
        level = 0.62;
        break;
      case 'taunt':
        dur = 0.46;
        start = base * 0.9;
        mid = base * 1.28;
        end = base * 1.0;
        attack = 0.04;
        level = 0.42;
        break;
      case 'jump':
        dur = 0.16;
        start = base * 0.82;
        mid = base * 1.2;
        end = base * 1.55;
        attack = 0.01;
        level = 0.34;
        break;
      case 'hit':
      default:
        dur = 0.22;
        start = base * 1.3;
        mid = base * 0.95;
        end = base * 0.7;
        attack = 0.008;
        level = 0.55;
        break;
    }

    const body = p.gain();
    const f1 = p.filter('bandpass', shape.f1, shape.q1);
    const f2 = p.filter('bandpass', shape.f2, shape.q2);
    const dist = p.drive(shape.drive);
    const mixer = p.gain(1);
    // Two parallel formants summed, then softly clipped: a cheap vowel.
    mixer.connect(f1);
    mixer.connect(f2);
    f1.connect(dist);
    f2.connect(dist);
    dist.connect(body);
    body.connect(p.out);

    const cord = p.osc(shape.wave, start);
    cord.detune.setValueAtTime((Math.random() * 2 - 1) * wobble * 140, t);
    cord.frequency.exponentialRampToValueAtTime(Math.max(mid, 20), t + dur * 0.35);
    cord.frequency.exponentialRampToValueAtTime(Math.max(end, 18), t + dur);
    const cordGain = p.gain(0.8);
    cord.connect(cordGain);
    cordGain.connect(mixer);

    if (shape.sub > 0) {
      const sub = p.osc('sine', start * 0.5);
      sub.frequency.exponentialRampToValueAtTime(Math.max(end * 0.5, 12), t + dur);
      const sg = p.gain(shape.sub);
      sub.connect(sg);
      sg.connect(mixer);
    }

    if (shape.breath > 0) {
      const n = p.noise(1);
      const nf = p.filter('bandpass', shape.f1 * 1.4, 1.2);
      const ng = p.gain(shape.breath * 0.6);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(mixer);
    }

    // Larynx wobble; a KO gets a proper death-rattle warble.
    p.lfo(cord.frequency, kind === 'ko' ? 9 : 6.5, base * wobble * (kind === 'ko' ? 0.22 : 0.1));

    if (kind === 'taunt') {
      // Two syllables: "haa — haaa".
      p.env(body, level, attack, 0.14);
      p.env(body, level * 0.9, 0.03, 0.2, 0.22);
    } else if (kind === 'ko') {
      p.env(body, level, attack, dur - attack);
    } else {
      p.env(body, level, attack, dur - attack);
    }

    p.play(dur + 0.05);
    this.voices.push({
      gain: vg,
      pan: pn,
      sources: p.sources,
      ends: t + dur + 0.1,
      loud: kind === 'ko' ? 5 : 1.2,
    });
  }

  // ── Voice budget ───────────────────────────────────────────────────────────

  private prune(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.ends <= now) {
        try {
          v.gain.disconnect();
          v.pan.disconnect();
        } catch {
          /* already torn down */
        }
        this.voices.splice(i, 1);
      }
    }
  }

  private reserve(now: number, loud: number): boolean {
    this.prune(now);
    let live = 0;
    for (const v of this.voices) if (v.loud >= 0) live++;
    if (live < MAX_VOICES) return true;

    let idx = -1;
    let min = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.loud >= 0 && v.loud < min) {
        min = v.loud;
        idx = i;
      }
    }
    if (idx < 0 || min >= loud) return false;
    this.kill(this.voices[idx], now);
    return true;
  }

  private kill(v: ActiveVoice, now: number): void {
    v.loud = -1;
    const p = v.gain.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 0.012);
    } catch {
      /* param already detached */
    }
    for (const s of v.sources) {
      try {
        s.stop(now + 0.02);
      } catch {
        /* not started yet */
      }
    }
    v.ends = now + 0.06;
  }

  // ── Context ────────────────────────────────────────────────────────────────

  private ensure(): AudioContext | null {
    if (this._ctx) return this._ctx;
    let ctx: AudioContext;
    try {
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }

    const master = ctx.createGain();
    master.gain.value = this.masterVol;
    // A gentle limiter keeps a screenful of explosions from clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    master.connect(limiter);
    limiter.connect(ctx.destination);

    const sfx = ctx.createGain();
    sfx.gain.value = this.sfxVol;
    sfx.connect(master);

    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._ctx = ctx;
    this._master = master;
    this.sfxBus = sfx;
    this.noiseBuf = buf;
    return ctx;
  }

  // ── Building blocks ────────────────────────────────────────────────────────

  private thump(
    p: Patch,
    f0: number,
    f1: number,
    dur: number,
    level: number,
    wave: OscillatorType = 'sine',
    at = 0,
    dest?: AudioNode,
  ): void {
    const o = p.osc(wave, f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 8), p.t + at + dur);
    const g = p.gain();
    o.connect(g);
    g.connect(dest ?? p.out);
    p.env(g, level, 0.004, dur, at);
  }

  private noiseHit(
    p: Patch,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    level: number,
    attack: number,
    decay: number,
    at = 0,
    dest?: AudioNode,
  ): BiquadFilterNode {
    const n = p.noise(1, at);
    const f = p.filter(type, f0, q);
    if (f1 !== f0) {
      f.frequency.setValueAtTime(Math.max(f0, 10), p.t + at);
      f.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), p.t + at + attack + decay);
    }
    const g = p.gain();
    n.connect(f);
    f.connect(g);
    g.connect(dest ?? p.out);
    p.env(g, level, attack, decay, at);
    return f;
  }

  /** Inharmonic partial stack — the sound of struck metal. */
  private metal(p: Patch, base: number, dur: number, level: number, at = 0, dest?: AudioNode): void {
    const ratios = [1, 2.76, 5.4, 8.93];
    for (let i = 0; i < ratios.length; i++) {
      const f = base * ratios[i];
      const o = p.osc('square', f, at);
      const bp = p.filter('bandpass', f, 26);
      const g = p.gain();
      o.connect(bp);
      bp.connect(g);
      g.connect(dest ?? p.out);
      p.env(g, level / (1 + i * 1.1), 0.001, dur * (1 - i * 0.16), at);
    }
  }

  private blip(
    p: Patch,
    wave: OscillatorType,
    f0: number,
    f1: number,
    level: number,
    dur: number,
    at = 0,
  ): void {
    const o = p.osc(wave, f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), p.t + at + dur);
    const g = p.gain();
    const lp = p.filter('lowpass', 5200, 0.9);
    o.connect(lp);
    lp.connect(g);
    g.connect(p.out);
    p.env(g, level, 0.004, dur, at);
  }

  // ── Gore recipes ───────────────────────────────────────────────────────────
  //
  // Reached only from the pitch branches at the top of their cues. Each one
  // normalises the incoming playback rate against the pitch `GORE_SFX`
  // recommends, so the variant sounds right at the documented pitch and still
  // moves if a caller pushes it — rather than being detuned into a joke by a
  // rate the plain recipe was designed around.

  /** Wet, sucking, organic. Impact, then suction, then dribble. */
  private squelch(p: Patch, k: number): number {
    const t = p.t;
    // Normalised against GORE_SFX.squelch.pitch.
    const w = clamp(k / 0.6, 0.6, 1.5);

    const dist = p.drive(2.6);
    dist.connect(p.out);
    // The blow still has to land; this half is the punch it always was.
    this.noiseHit(p, 'lowpass', 700 * w, 240 * w, 0.9, 0.75, 0.002, 0.12, 0, dist);
    this.thump(p, 96 * w, 46 * w, 0.15, 0.5, 'sine', 0, dist);

    // Suction: a high-Q band dragged downwards is a boot leaving mud, and a
    // fist leaving a ribcage is the same physics with worse manners.
    const wet = this.noiseHit(p, 'bandpass', 1200 * w, 1200 * w, 8, 0.5, 0.01, 0.26, 0.012);
    wet.frequency.cancelScheduledValues(t);
    wet.frequency.setValueAtTime(1300 * w, t + 0.012);
    wet.frequency.exponentialRampToValueAtTime(170 * w, t + 0.26);
    p.lfo(wet.frequency, 27, 130 * w, 'triangle');

    // The slack body of the thing, falling an octave and a half.
    const gloop = p.osc('triangle', 340 * w, 0.02);
    gloop.frequency.exponentialRampToValueAtTime(70 * w, t + 0.3);
    const lp = p.filter('lowpass', 1500, 3);
    const gg = p.gain();
    gloop.connect(lp);
    lp.connect(gg);
    gg.connect(p.out);
    p.env(gg, 0.36, 0.012, 0.3, 0.02);

    // Dribble. Three small wet ticks trailing off.
    for (let i = 0; i < 3; i++) {
      const at = 0.17 + i * 0.055 + Math.random() * 0.02;
      this.noiseHit(p, 'bandpass', (1500 + i * 520) * w, 600 * w, 10, 0.12, 0.002, 0.05, at);
    }
    return 0.44;
  }

  /** A snap with splinters and meat around it. */
  private boneSnap(p: Patch, k: number): number {
    // Normalised against GORE_SFX.boneSnap.pitch.
    const w = clamp(k / 0.7, 0.6, 1.5);

    // The break: a hard transient, then a struck-timber ring, very short.
    this.noiseHit(p, 'highpass', 2500 * w, 3400 * w, 0.7, 0.9, 0.0007, 0.016);
    this.blip(p, 'square', 3100 * w, 1700 * w, 0.5, 0.015);
    this.metal(p, 760 * w, 0.09, 0.22, 0.002);

    // Splinters, scattered so no two snaps line up.
    for (let i = 0; i < 4; i++) {
      const at = 0.012 + i * 0.019 + Math.random() * 0.012;
      const f = (1700 + Math.random() * 2300) * w;
      this.noiseHit(p, 'bandpass', f, 850 * w, 13, 0.16, 0.001, 0.032, at);
    }

    // And the leg it was inside.
    this.noiseHit(p, 'lowpass', 620 * w, 190 * w, 0.9, 0.5, 0.002, 0.17, 0.006);
    this.thump(p, 92 * w, 42 * w, 0.18, 0.45, 'sine', 0.006);
    return 0.3;
  }

  /** Fabric giving way: broadband noise, chopped, sweeping down as it rips. */
  private clothTear(p: Patch, k: number): number {
    const t = p.t;
    // Normalised against GORE_SFX.clothTear.pitch.
    const w = clamp(k / 1.8, 0.6, 1.5);

    const body = p.gain();
    body.connect(p.out);
    const bp = p.filter('bandpass', 2600 * w, 1.3);
    bp.frequency.setValueAtTime(3000 * w, t);
    bp.frequency.exponentialRampToValueAtTime(820 * w, t + 0.34);
    const hp = p.filter('highpass', 640 * w, 0.7);
    const n = p.noise(1.25);
    n.connect(hp);
    hp.connect(bp);
    bp.connect(body);
    p.env(body, 0.5, 0.006, 0.34);

    // A rip is not one event, it is a few hundred small ones. Chopping the
    // band hard in the low audio range is what turns hiss into tearing.
    const chop = p.gain(0);
    p.lfo(chop.gain, 46, 0.7, 'square');
    bp.connect(chop);
    chop.connect(body);

    // Individual threads letting go, accelerating as the tear runs.
    for (let i = 0; i < 7; i++) {
      const at = 0.008 + i * 0.032 * (1 + i * 0.09) + Math.random() * 0.012;
      this.noiseHit(p, 'highpass', (3400 - i * 220) * w, 2100 * w, 0.8, 0.14, 0.0008, 0.022, at);
    }

    // The flap of the piece coming free.
    this.noiseHit(p, 'lowpass', 900 * w, 260 * w, 0.9, 0.24, 0.006, 0.12, 0.3);
    return 0.46;
  }

  /** Chew, chew, swallow. A gulp is a pitch contour, not a timbre. */
  private gulp(p: Patch, k: number): number {
    const t = p.t;
    // Normalised against GORE_SFX.gulp.pitch.
    const w = clamp(k / 0.55, 0.6, 1.5);

    // Two closed-mouth chews.
    for (let i = 0; i < 2; i++) {
      const at = i * 0.13;
      this.noiseHit(p, 'lowpass', 880 * w, 300 * w, 1.2, 0.3, 0.004, 0.07, at);
      this.thump(p, 150 * w, 88 * w, 0.08, 0.22, 'triangle', at);
    }

    // The swallow itself: a resonant blip dropping through the throat.
    const o = p.osc('sine', 300 * w, 0.28);
    o.frequency.exponentialRampToValueAtTime(74 * w, t + 0.46);
    const bp = p.filter('bandpass', 540 * w, 6);
    bp.frequency.exponentialRampToValueAtTime(180 * w, t + 0.46);
    const g = p.gain();
    o.connect(bp);
    bp.connect(g);
    g.connect(p.out);
    p.env(g, 0.5, 0.02, 0.22, 0.28);

    // Throat closing behind it, and a small satisfied click.
    this.noiseHit(p, 'bandpass', 700 * w, 250 * w, 5, 0.22, 0.01, 0.1, 0.3);
    this.blip(p, 'sine', 180 * w, 96 * w, 0.2, 0.09, 0.44);
    return 0.6;
  }

  /** A whole body arriving on the floor, limbs a beat behind it. */
  private bodyImpact(p: Patch, k: number): number {
    // Normalised against GORE_SFX.bodyImpact.pitch.
    const w = clamp(k / 0.6, 0.6, 1.5);

    const dist = p.drive(4);
    dist.connect(p.out);
    // The floor.
    this.thump(p, 122 * w, 32, 0.3, 0.95, 'sine', 0, dist);
    this.thump(p, 70 * w, 24, 0.44, 0.5, 'triangle', 0.012, dist);
    // The meat.
    this.noiseHit(p, 'lowpass', 1500 * w, 250 * w, 0.9, 0.6, 0.002, 0.18, 0, dist);
    // Clothing, then the dust it knocked up.
    this.noiseHit(p, 'highpass', 1800 * w, 700 * w, 0.7, 0.16, 0.004, 0.1, 0.01);
    this.noiseHit(p, 'lowpass', 700, 200, 0.8, 0.2, 0.02, 0.5, 0.03);
    // The follow-through as the arms and head land after the torso.
    this.noiseHit(p, 'lowpass', 900 * w, 240 * w, 0.9, 0.3, 0.004, 0.12, 0.09);
    this.thump(p, 96 * w, 38, 0.16, 0.35, 'sine', 0.095, dist);
    return 0.72;
  }

  // ── The cue table ──────────────────────────────────────────────────────────

  private build(p: Patch, cue: SfxCue, k: number): number {
    const t = p.t;

    switch (cue) {
      case 'punch_light': {
        this.noiseHit(p, 'bandpass', 1600 * k, 900 * k, 1.1, 0.7, 0.002, 0.062);
        this.thump(p, 175 * k, 88 * k, 0.075, 0.5);
        return 0.1;
      }

      case 'punch_heavy': {
        const dist = p.drive(9);
        dist.connect(p.out);
        this.noiseHit(p, 'lowpass', 1800 * k, 320 * k, 0.9, 0.85, 0.003, 0.2, 0, dist);
        this.thump(p, 150 * k, 42 * k, 0.26, 0.8, 'sine', 0, dist);
        this.thump(p, 96 * k, 30 * k, 0.3, 0.4, 'triangle', 0.01, dist);
        return 0.34;
      }

      case 'kick': {
        const dist = p.drive(5);
        dist.connect(p.out);
        this.noiseHit(p, 'bandpass', 1050 * k, 480 * k, 1.4, 0.6, 0.002, 0.1, 0, dist);
        this.thump(p, 120 * k, 46 * k, 0.17, 0.7, 'sine', 0, dist);
        return 0.22;
      }

      case 'whiff': {
        if (k >= CLOTH_TEAR_ABOVE) return this.clothTear(p, k);
        const f = this.noiseHit(p, 'bandpass', 260 * k, 520 * k, 2.4, 0.3, 0.05, 0.13);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(260 * k, t);
        f.frequency.exponentialRampToValueAtTime(2500 * k, t + 0.09);
        f.frequency.exponentialRampToValueAtTime(480 * k, t + 0.2);
        return 0.22;
      }

      case 'block': {
        this.noiseHit(p, 'lowpass', 700 * k, 300 * k, 0.9, 0.55, 0.002, 0.07);
        this.thump(p, 205 * k, 130 * k, 0.09, 0.45, 'square');
        return 0.13;
      }

      case 'parry': {
        this.noiseHit(p, 'highpass', 3800 * k, 6000 * k, 0.8, 0.4, 0.001, 0.035);
        this.metal(p, 1480 * k, 0.4, 0.34);
        const shimmer = p.osc('sine', 2600 * k);
        shimmer.frequency.exponentialRampToValueAtTime(4200 * k, t + 0.22);
        const sg = p.gain();
        shimmer.connect(sg);
        sg.connect(p.out);
        p.env(sg, 0.2, 0.02, 0.24);
        return 0.45;
      }

      case 'hit_flesh': {
        if (k <= SQUELCH_BELOW) return this.squelch(p, k);
        const dist = p.drive(3.5);
        dist.connect(p.out);
        this.noiseHit(p, 'lowpass', 760 * k, 260 * k, 0.9, 0.8, 0.002, 0.11, 0, dist);
        this.thump(p, 98 * k, 52 * k, 0.13, 0.55, 'sine', 0, dist);
        return 0.18;
      }

      case 'hit_metal': {
        this.noiseHit(p, 'bandpass', 2600 * k, 1800 * k, 12, 0.5, 0.001, 0.1);
        this.metal(p, 520 * k, 0.55, 0.4);
        this.thump(p, 160 * k, 90 * k, 0.08, 0.3);
        return 0.6;
      }

      case 'bone_crack': {
        if (k <= BONE_SNAP_BELOW) return this.boneSnap(p, k);
        this.noiseHit(p, 'highpass', 2600 * k, 3600 * k, 0.7, 0.85, 0.0008, 0.014);
        this.blip(p, 'square', 3400 * k, 2100 * k, 0.45, 0.012);
        this.noiseHit(p, 'bandpass', 900 * k, 420 * k, 3, 0.5, 0.001, 0.05, 0.008);
        return 0.09;
      }

      case 'weapon_swing': {
        const f = this.noiseHit(p, 'bandpass', 380 * k, 380 * k, 2.6, 0.42, 0.045, 0.16);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(360 * k, t);
        f.frequency.exponentialRampToValueAtTime(2900 * k, t + 0.13);
        f.frequency.exponentialRampToValueAtTime(700 * k, t + 0.24);
        return 0.26;
      }

      case 'chain_whip': {
        const f = this.noiseHit(p, 'bandpass', 700 * k, 700 * k, 7, 0.5, 0.03, 0.2);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(680 * k, t);
        f.frequency.exponentialRampToValueAtTime(4300 * k, t + 0.17);
        f.frequency.exponentialRampToValueAtTime(1200 * k, t + 0.28);
        for (let i = 0; i < 4; i++) {
          const at = 0.03 + i * 0.045 + Math.random() * 0.02;
          this.metal(p, (2100 + Math.random() * 1500) * k, 0.1, 0.14, at);
        }
        return 0.34;
      }

      case 'bat_crack': {
        this.noiseHit(p, 'highpass', 2200 * k, 1400 * k, 0.7, 0.9, 0.0008, 0.022);
        const o = p.osc('triangle', 215 * k);
        o.frequency.exponentialRampToValueAtTime(150 * k, t + 0.16);
        const bp = p.filter('bandpass', 430 * k, 16);
        const g = p.gain();
        o.connect(bp);
        bp.connect(g);
        g.connect(p.out);
        p.env(g, 0.75, 0.002, 0.3);
        this.noiseHit(p, 'bandpass', 420 * k, 420 * k, 18, 0.35, 0.002, 0.3);
        return 0.36;
      }

      case 'gunshot': {
        const dist = p.drive(12);
        dist.connect(p.out);
        this.noiseHit(p, 'lowpass', 5200 * k, 420 * k, 0.9, 1.0, 0.0008, 0.24, 0, dist);
        this.thump(p, 220 * k, 44 * k, 0.13, 0.85, 'sine', 0, dist);
        this.noiseHit(p, 'lowpass', 1500, 500, 0.7, 0.22, 0.02, 0.45, 0.03);
        return 0.6;
      }

      case 'taser': {
        const carrier = p.osc('sawtooth', 96 * k);
        const bp = p.filter('bandpass', 1500 * k, 4);
        const body = p.gain();
        carrier.connect(bp);
        bp.connect(body);
        body.connect(p.out);
        p.env(body, 0.42, 0.01, 0.42);
        // Hard amplitude chopping in the 60-120Hz range is what makes it bite.
        const chop = p.gain(0);
        p.lfo(chop.gain, 68, 0.55, 'square');
        bp.connect(chop);
        chop.connect(body);
        for (let i = 0; i < 6; i++) {
          this.noiseHit(p, 'highpass', 3000, 4200, 1, 0.18, 0.001, 0.03, 0.02 + i * 0.062);
        }
        return 0.48;
      }

      case 'explosion': {
        const dist = p.drive(7);
        dist.connect(p.out);
        const f = this.noiseHit(p, 'lowpass', 4200, 4200, 0.8, 1.0, 0.006, 1.05, 0, dist);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(4200, t);
        f.frequency.exponentialRampToValueAtTime(90, t + 1.05);
        this.thump(p, 86 * k, 24, 0.9, 0.9, 'sine', 0, dist);
        const crack = this.noiseHit(p, 'highpass', 2600, 1200, 0.8, 0.35, 0.004, 0.5, 0.01);
        p.lfo(crack.frequency, 31, 900, 'square');
        return 1.3;
      }

      case 'robot_death': {
        const crush = p.crush(5);
        const lp = p.filter('lowpass', 2600, 1.2);
        crush.connect(lp);
        lp.connect(p.out);
        const o = p.osc('sawtooth', 900 * k);
        o.frequency.exponentialRampToValueAtTime(58 * k, t + 0.55);
        const g = p.gain();
        o.connect(g);
        g.connect(crush);
        p.env(g, 0.5, 0.01, 0.6);
        p.lfo(o.frequency, 22, 180, 'square');
        this.noiseHit(p, 'bandpass', 1800, 500, 2, 0.25, 0.02, 0.5);
        this.metal(p, 320, 0.4, 0.4, 0.55);
        this.thump(p, 120, 40, 0.25, 0.5, 'sine', 0.55);
        return 1.0;
      }

      case 'glass': {
        this.noiseHit(p, 'highpass', 4200, 6500, 0.7, 0.6, 0.001, 0.07);
        for (let i = 0; i < 8; i++) {
          const f = (2300 + Math.random() * 4600) * k;
          const at = Math.random() * 0.09;
          const o = p.osc('sine', f, at);
          o.frequency.exponentialRampToValueAtTime(f * 0.88, t + at + 0.3);
          const g = p.gain();
          o.connect(g);
          g.connect(p.out);
          p.env(g, 0.16, 0.002, 0.14 + Math.random() * 0.28, at);
        }
        return 0.56;
      }

      case 'pickup': {
        this.blip(p, 'square', 660 * k, 660 * k, 0.3, 0.05);
        this.blip(p, 'square', 990 * k, 990 * k, 0.32, 0.1, 0.05);
        return 0.17;
      }

      case 'drop': {
        this.blip(p, 'triangle', 520 * k, 210 * k, 0.34, 0.14);
        this.noiseHit(p, 'lowpass', 450, 220, 0.8, 0.3, 0.003, 0.1);
        return 0.19;
      }

      case 'jump': {
        this.blip(p, 'sine', 250 * k, 560 * k, 0.35, 0.12);
        this.noiseHit(p, 'lowpass', 1100, 500, 0.8, 0.22, 0.004, 0.07);
        return 0.16;
      }

      case 'land': {
        if (k <= BODY_IMPACT_BELOW) return this.bodyImpact(p, k);
        this.noiseHit(p, 'lowpass', 420, 180, 0.8, 0.5, 0.003, 0.14);
        this.thump(p, 145 * k, 52 * k, 0.15, 0.55);
        return 0.2;
      }

      case 'dash': {
        const f = this.noiseHit(p, 'bandpass', 520, 520, 3, 0.4, 0.02, 0.13);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(520 * k, t);
        f.frequency.exponentialRampToValueAtTime(2700 * k, t + 0.11);
        f.frequency.exponentialRampToValueAtTime(900 * k, t + 0.18);
        this.blip(p, 'triangle', 320 * k, 220 * k, 0.14, 0.05);
        return 0.2;
      }

      case 'ko': {
        const dist = p.drive(10);
        dist.connect(p.out);
        const o = p.osc('sine', 330 * k);
        o.frequency.exponentialRampToValueAtTime(36 * k, t + 0.55);
        const g = p.gain();
        o.connect(g);
        g.connect(dist);
        p.env(g, 0.95, 0.004, 0.6);
        // Reverse-ish swell that lands on the impact.
        const swell = this.noiseHit(p, 'lowpass', 500, 2600, 0.9, 0.45, 0.3, 0.12);
        p.lfo(swell.frequency, 3, 400);
        this.thump(p, 74 * k, 22, 0.8, 0.8, 'sine', 0.01, dist);
        this.metal(p, 210 * k, 0.5, 0.18, 0.02);
        return 0.95;
      }

      case 'super_charge': {
        const lp = p.filter('lowpass', 400, 4);
        lp.frequency.exponentialRampToValueAtTime(5600, t + 1.1);
        lp.connect(p.out);
        for (let i = 0; i < 3; i++) {
          const o = p.osc('sawtooth', 88 * k * (1 + i * 0.005));
          o.detune.setValueAtTime(i * 7 - 7, t);
          o.frequency.exponentialRampToValueAtTime(980 * k, t + 1.1);
          const g = p.gain();
          o.connect(g);
          g.connect(lp);
          p.env(g, 0.24, 0.5, 0.7);
        }
        const shimmer = this.noiseHit(p, 'highpass', 900, 7000, 1.4, 0.3, 0.9, 0.35);
        p.lfo(shimmer.frequency, 14, 1200);
        this.thump(p, 40, 90, 1.0, 0.4, 'sine');
        return 1.35;
      }

      case 'super_blast': {
        const dist = p.drive(14);
        dist.connect(p.out);
        const f = this.noiseHit(p, 'lowpass', 6000, 6000, 0.8, 1.0, 0.004, 1.2, 0, dist);
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(6000, t);
        f.frequency.exponentialRampToValueAtTime(120, t + 1.2);
        this.thump(p, 110 * k, 26, 1.1, 1.0, 'sine', 0, dist);
        for (let i = 0; i < 3; i++) {
          const o = p.osc('sawtooth', 420 * k * (1 - i * 0.06));
          o.detune.setValueAtTime(i * 13 - 13, t);
          o.frequency.exponentialRampToValueAtTime(60 * k, t + 0.8);
          const g = p.gain();
          o.connect(g);
          g.connect(dist);
          p.env(g, 0.3, 0.006, 0.85);
        }
        this.metal(p, 300 * k, 1.1, 0.3, 0.02);
        return 1.6;
      }

      case 'meter_full': {
        const notes = [880, 1108, 1318];
        for (let i = 0; i < notes.length; i++) {
          this.blip(p, 'square', notes[i] * k, notes[i] * k, 0.24, 0.16, i * 0.07);
        }
        const shimmer = this.noiseHit(p, 'highpass', 3000, 8000, 1.2, 0.16, 0.14, 0.3);
        p.lfo(shimmer.frequency, 9, 1500);
        return 0.55;
      }

      case 'ui_move': {
        this.blip(p, 'square', 920 * k, 920 * k, 0.22, 0.04);
        this.noiseHit(p, 'highpass', 5000, 5000, 0.7, 0.08, 0.001, 0.02);
        return 0.07;
      }

      case 'ui_select': {
        this.blip(p, 'triangle', 620 * k, 620 * k, 0.3, 0.05);
        this.blip(p, 'triangle', 1240 * k, 1240 * k, 0.3, 0.12, 0.045);
        this.noiseHit(p, 'highpass', 6000, 6000, 0.7, 0.12, 0.001, 0.02);
        return 0.19;
      }

      case 'ui_back': {
        this.blip(p, 'square', 700 * k, 700 * k, 0.26, 0.05);
        this.blip(p, 'square', 340 * k, 340 * k, 0.26, 0.11, 0.045);
        return 0.17;
      }

      case 'ui_error': {
        for (let i = 0; i < 2; i++) {
          const o = p.osc('square', 165 * k, i * 0.1);
          o.frequency.exponentialRampToValueAtTime(140 * k, t + i * 0.1 + 0.08);
          const lp = p.filter('lowpass', 1200, 2);
          const g = p.gain();
          o.connect(lp);
          lp.connect(g);
          g.connect(p.out);
          p.env(g, 0.3, 0.004, 0.085, i * 0.1);
        }
        return 0.22;
      }

      case 'coin': {
        this.blip(p, 'square', 988 * k, 988 * k, 0.24, 0.06);
        const o = p.osc('square', 1319 * k, 0.055);
        const g = p.gain();
        o.connect(g);
        g.connect(p.out);
        p.env(g, 0.24, 0.004, 0.3, 0.055);
        p.lfo(o.frequency, 7, 9, 'sine', 0.055);
        return 0.4;
      }

      case 'sneeze': {
        // "aaaah..." — rising, nasal, wet.
        const aah = p.osc('sawtooth', 210 * k);
        aah.frequency.exponentialRampToValueAtTime(320 * k, t + 0.26);
        const f1 = p.filter('bandpass', 780, 4);
        f1.frequency.exponentialRampToValueAtTime(1300, t + 0.26);
        const ag = p.gain();
        aah.connect(f1);
        f1.connect(ag);
        ag.connect(p.out);
        p.env(ag, 0.3, 0.2, 0.07);
        p.lfo(aah.frequency, 5.5, 12);
        // "...CHOO!"
        const dist = p.drive(6);
        dist.connect(p.out);
        this.noiseHit(p, 'highpass', 1600, 380, 0.8, 0.9, 0.004, 0.3, 0.3, dist);
        const choo = p.osc('sawtooth', 280 * k, 0.3);
        choo.frequency.exponentialRampToValueAtTime(110 * k, t + 0.55);
        const f2 = p.filter('bandpass', 900, 3);
        f2.frequency.exponentialRampToValueAtTime(420, t + 0.55);
        const cg = p.gain();
        choo.connect(f2);
        f2.connect(cg);
        cg.connect(dist);
        p.env(cg, 0.55, 0.008, 0.28, 0.3);
        return 0.75;
      }

      case 'snore': {
        // Inhale: a rattling low buzz.
        const rasp = p.osc('sawtooth', 68 * k);
        const lp = p.filter('lowpass', 400, 3);
        const rg = p.gain();
        rasp.connect(lp);
        lp.connect(rg);
        rg.connect(p.out);
        p.env(rg, 0.42, 0.34, 0.18);
        p.lfo(rg.gain, 23, 0.3, 'triangle');
        const breath = this.noiseHit(p, 'lowpass', 600, 300, 0.8, 0.22, 0.3, 0.2);
        p.lfo(breath.frequency, 23, 180);
        // Exhale: a daft little whistle.
        const whistle = p.osc('sine', 330 * k, 0.62);
        whistle.frequency.exponentialRampToValueAtTime(170 * k, t + 1.0);
        const wg = p.gain();
        whistle.connect(wg);
        wg.connect(p.out);
        p.env(wg, 0.16, 0.1, 0.3, 0.62);
        p.lfo(whistle.frequency, 6, 14, 'sine', 0.62);
        this.noiseHit(p, 'bandpass', 1400, 900, 2, 0.1, 0.1, 0.3, 0.62);
        return 1.2;
      }

      case 'laugh': {
        const pitches = [205, 194, 182, 170, 160];
        for (let i = 0; i < pitches.length; i++) {
          const at = i * 0.115;
          const o = p.osc('sawtooth', pitches[i] * k, at);
          o.frequency.exponentialRampToValueAtTime(pitches[i] * k * 0.82, t + at + 0.09);
          const fa = p.filter('bandpass', 880, 5);
          const fb = p.filter('bandpass', 1520, 7);
          const g = p.gain();
          o.connect(fa);
          o.connect(fb);
          fa.connect(g);
          fb.connect(g);
          g.connect(p.out);
          p.env(g, 0.4 - i * 0.05, 0.012, 0.085, at);
        }
        return 0.66;
      }

      case 'grunt': {
        if (k <= GULP_BELOW) return this.gulp(p, k);
        const o = p.osc('sawtooth', 145 * k);
        o.frequency.exponentialRampToValueAtTime(102 * k, t + 0.2);
        const fa = p.filter('bandpass', 640, 4.5);
        const fb = p.filter('bandpass', 1180, 6);
        const g = p.gain();
        o.connect(fa);
        o.connect(fb);
        fa.connect(g);
        fb.connect(g);
        g.connect(p.out);
        p.env(g, 0.45, 0.012, 0.19);
        this.noiseHit(p, 'bandpass', 900, 600, 1.5, 0.1, 0.01, 0.16);
        return 0.24;
      }

      case 'engine': {
        const dist = p.drive(4);
        const lp = p.filter('lowpass', 760, 1.4);
        dist.connect(lp);
        lp.connect(p.out);
        for (let i = 0; i < 2; i++) {
          const o = p.osc('sawtooth', (52 + i * 1.6) * k);
          const g = p.gain();
          o.connect(g);
          g.connect(dist);
          p.env(g, 0.3, 0.08, 0.85);
          p.lfo(o.frequency, 11 + i * 2, 6);
        }
        const rumble = this.noiseHit(p, 'lowpass', 320, 220, 0.8, 0.2, 0.08, 0.85);
        p.lfo(rumble.frequency, 13, 90);
        return 1.0;
      }

      case 'tyres': {
        const f = this.noiseHit(p, 'bandpass', 1500 * k, 1500 * k, 14, 0.42, 0.05, 0.62);
        p.lfo(f.frequency, 7.5, 260);
        const f2 = this.noiseHit(p, 'bandpass', 3100 * k, 2400 * k, 10, 0.22, 0.06, 0.6);
        p.lfo(f2.frequency, 11, 400);
        this.noiseHit(p, 'lowpass', 260, 160, 0.8, 0.16, 0.05, 0.6);
        return 0.72;
      }

      default: {
        this.blip(p, 'square', 640 * k, 640 * k, 0.22, 0.07);
        return 0.1;
      }
    }
  }
}
