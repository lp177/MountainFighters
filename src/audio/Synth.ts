/**
 * Every sound in Mountain Fighters is DSP. The repository ships zero audio
 * files: each cue below is a recipe of oscillators, pre-rendered noise,
 * biquad filters, waveshapers and envelopes, built fresh on every trigger.
 *
 * HOW A HIT IS BUILT.
 *
 * An impact is up to four layers, and a weak cue is weak in exactly the layer
 * it leaves out:
 *
 *     snap   a few milliseconds of bright noise, kept OUT of any drive stage.
 *            It is the only part of a blow a laptop speaker can reproduce, so
 *            it is the part that makes a hit read at low volume.
 *     body   a pitched thump whose pitch has finished falling a third of the
 *            way into its envelope. A drop that takes the whole decay to
 *            arrive is a "pew"; one that is over early is a blow.
 *     meat   filtered noise pushed through a drive with the body, so the two
 *            intermodulate into one event instead of sitting side by side.
 *     tail   sub, a ring, or the shared room. Only the heavy hits get one.
 *
 * On the heavy hits the body starts `BODY_LAG` after the snap. Five
 * milliseconds is not a delay anyone can hear, but it stops the two peaks
 * stacking — and a transient stacked on a body is what makes a limiter clamp
 * down on the very body that was supposed to carry the weight.
 *
 * Neighbours are told apart by SPECTRUM, never by level alone: a jab is a
 * tick and a knock with no sub; a heavy punch cracks and booms; a kick has no
 * crack at all, only leather in the low mids; flesh is the dull wet one; a knee
 * is the short dry one. Every one of them still has to make sense pitched
 * from 0.85 (a heavy connect) to 1.1 (a light one), because that is how the
 * victim plays them.
 *
 * NOISE LEVELS ARE COMPENSATED. See `bandMakeup`: a `level` passed to
 * `noiseHit` means roughly the same loudness as the same number on an
 * oscillator, whatever the filter in front of it.
 *
 * THE BUS.
 *
 *     voice ─┬─ pan ──────────┐
 *            └─ send ─ room ──┼─ sfx ──┐
 *     voice ─── pan ──────────┘        ├─ mix ─ rumble cut ─ limiter ─
 *     music ─── duck ──────────────────┘        ceiling ─ master volume ─ out
 *
 * The master volume sits AFTER the limiter, so turning the game down does not
 * change how the mix is glued, and the ceiling behind the limiter means the
 * output cannot reach full scale however many cues land on one frame. Big
 * cues duck the music explicitly (`DUCK`) rather than leaving it all to the
 * limiter to pump.
 *
 * THE GORE CUES are ordinary cues now: `squelch`, `bone_snap`, `tear`, `gulp`
 * and `slam`. See LEGACY PITCH ALIASES below for what they used to be.
 */

import { clamp } from '@/core/math';
import type { SfxCue, VoiceProfile } from '@/core/types';

/**
 * The gore palette, as (cue, pitch) pairs.
 *
 * Kept as a table because the fatality library reads better asking for
 * `GORE_SFX.gulp` than for a string, but every entry is a real cue at its
 * natural pitch now. Nothing here depends on a magic playback rate any more.
 */
export const GORE_SFX = {
  /** Wet, sucking, unmistakably organic. The workhorse of the fatality library. */
  squelch: { cue: 'squelch', pitch: 1 },
  /** A snap with splinters and meat around it, not the dry tick of a light hit. */
  boneSnap: { cue: 'bone_snap', pitch: 1 },
  /** Fabric or flesh giving way — a jacket, a shirt, a hat being torn off a head. */
  clothTear: { cue: 'tear', pitch: 1 },
  /** Chew, chew, swallow. For the enemy who eats your hat. */
  gulp: { cue: 'gulp', pitch: 1 },
  /** A whole body arriving on the floor at speed. */
  bodyImpact: { cue: 'slam', pitch: 1 },
} as const satisfies Record<string, { cue: SfxCue; pitch: number }>;

/**
 * LEGACY PITCH ALIASES.
 *
 * `SfxCue` used to be frozen, so the gore palette was smuggled in as "what an
 * existing cue does at a playback rate nobody uses": five cues branched on
 * pitch into a second recipe. It worked, and it was the wrong design, because
 * it made pitch a DISCONTINUOUS parameter. A heavy hit could not be pitched
 * below 0.75 for weight without turning into a squelch, a descending run of
 * cracks changed instrument half way down, and three call sites fell into a
 * variant by accident: a knife whose swing was a whiff at 1.5 tore cloth on
 * the select screen, a spin-up that swept a whiff through 1.5 started ripping
 * fabric mid-spin, and a low heave at exactly 0.75 swallowed.
 *
 * The palette is five real cues now. Three aliases stay, for the three that
 * the fatality library calls on purpose; they route to the SAME recipes as the
 * real cues and can be deleted the day those calls name `squelch`, `bone_snap`
 * and `slam` instead. The other two (`whiff` high, `grunt` low) had no
 * deliberate caller, only the accidents above, and are gone.
 */
const SQUELCH_BELOW = 0.75;
const BONE_SNAP_BELOW = 0.82;
const SLAM_BELOW = 0.75;
/** The pitches the old palette documented, which the aliases normalise against. */
const SQUELCH_ALIAS_PITCH = 0.6;
const BONE_SNAP_ALIAS_PITCH = 0.7;
const SLAM_ALIAS_PITCH = 0.6;

/** An alias plays its recipe as if the documented pitch were 1.0. */
function aliasPitch(k: number, documented: number): number {
  return clamp(k / documented, 0.6, 1.5);
}

/** How far behind its transient a heavy hit's body starts. See the header. */
const BODY_LAG = 0.005;

/** Hard cap on simultaneous voices. Over budget, the quietest voice dies. */
const MAX_VOICES = 24;
/** Length of the pre-rendered white-noise buffer, in seconds. */
const NOISE_SECONDS = 2;
/** Ceiling on `bandMakeup`. Past this a band is too thin to be worth lifting. */
const NOISE_MAKEUP_MAX = 8;

/**
 * The room. Two early reflections, one off each wall and each a prime number
 * of milliseconds out so they never line up into a comb, then a slap off the
 * far end of the alley that goes round a couple of times.
 *
 * It is built once and shared: a cue pays one gain node to be in it.
 */
const ROOM_TAP_L = 0.019;
const ROOM_TAP_R = 0.031;
const ROOM_SLAP = 0.073;
const ROOM_FEEDBACK = 0.3;
/** Level of the whole room against the dry sound, before a cue's own send. */
const ROOM_RETURN = 0.55;
/** Every grunt is in the same alley as the fist that caused it. */
const VOICE_ROOM = 0.1;

/** How fast the music gets out of the way, and how slowly it comes back. */
const DUCK_ATTACK = 0.012;
const DUCK_RELEASE = 0.17;

/**
 * Cull weighting. A loud gunshot should never be dropped so a footstep can
 * live; these multipliers bias the "quietest voice" search.
 */
const PRIORITY: Partial<Record<SfxCue, number>> = {
  ko: 6,
  super_blast: 6,
  impact_heavy: 6,
  fatality_sting: 6,
  sub_drop: 5,
  super_charge: 4,
  riser: 4,
  explosion: 3.5,
  gunshot: 3,
  crash: 3,
  // Quiet by design and played into a silence; the one cue that must not be
  // the "quietest voice".
  heartbeat: 3,
  meter_full: 2.5,
  alert: 2.5,
  slam: 2.2,
  bone_crack: 2,
  bone_snap: 2,
  combo_up: 2,
  dizzy: 2,
  punch_heavy: 1.8,
  jump_kick: 1.6,
  knee: 1.6,
  slice: 1.6,
  squelch: 1.5,
  tear: 1.5,
  whoosh_big: 1.5,
  engine_rev: 1.5,
  ui_move: 2,
  ui_select: 2.5,
  ui_back: 2.5,
  ui_error: 2.5,
  coin: 2,
};

/**
 * How much of a cue goes to the room, 0..1.
 *
 * Impacts get a little, loud cracks get a lot, and anything that is supposed
 * to feel close and dry — a knee, a block, the whole UI, every whoosh — gets
 * none. A cue missing from this table is dry.
 */
const ROOM: Partial<Record<SfxCue, number>> = {
  punch_light: 0.1,
  punch_heavy: 0.22,
  kick: 0.18,
  jump_kick: 0.2,
  hit_flesh: 0.14,
  hit_metal: 0.3,
  bone_crack: 0.2,
  bone_snap: 0.25,
  parry: 0.32,
  bat_crack: 0.34,
  chain_whip: 0.2,
  gunshot: 0.5,
  explosion: 0.4,
  glass: 0.3,
  robot_death: 0.25,
  land: 0.12,
  slam: 0.3,
  crash: 0.35,
  ko: 0.3,
  impact_heavy: 0.45,
  super_blast: 0.35,
  fatality_sting: 0.35,
  slice: 0.2,
  squelch: 0.12,
  alert: 0.25,
};

/**
 * How far a cue pushes the music down, as a fraction of its level.
 *
 * Only the events the whole screen stops for. A punch is not in here and must
 * never be: a duck that fires eight times a second is not a duck, it is a
 * tremolo on the soundtrack.
 *
 * The same goes for anything a crowded wave does every second or so — a guard
 * dying (`ko`, `robot_death`), a body meeting the floor (`slam`), a bike going
 * through one (`crash`). Each of those is a big sound, and each was in here
 * until they were wired to the events that actually fire them; four deaths and
 * six knockdowns in five seconds is the soundtrack breathing in time with the
 * fight, which is the pumping this table exists to avoid.
 */
const DUCK: Partial<Record<SfxCue, number>> = {
  impact_heavy: 0.6,
  fatality_sting: 0.55,
  sub_drop: 0.5,
  super_blast: 0.5,
  heartbeat: 0.4,
  explosion: 0.35,
  riser: 0.3,
  super_charge: 0.2,
};

interface ActiveVoice {
  gain: GainNode;
  pan: StereoPannerNode;
  /** The voice's tap into the room, if it has one. */
  send: GainNode | null;
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

/** Where the output ceiling stops being a straight line. */
const CEILING_KNEE = 0.8;
/** How much room the shoulder has above the knee; knee + this is the ceiling. */
const CEILING_SHOULDER = 0.19;
/** The ceiling's input is padded by this, so its table spans ±(1 / pad). */
const CEILING_PAD = 0.5;

/**
 * The last thing before the volume knob: dead straight up to the knee, then a
 * shoulder that lands just under full scale.
 *
 * The limiter in front of it catches everything it has time to; this is for
 * the first millisecond of a stacked transient, which it does not. Below the
 * knee it is the identity, so it costs the mix nothing when it is not needed.
 */
function ceilingCurve(): Curve {
  const key = 'ceiling';
  const hit = curveCache.get(key);
  if (hit) return hit;
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) / CEILING_PAD;
    const a = Math.abs(x);
    const y =
      a <= CEILING_KNEE
        ? a
        : CEILING_KNEE + CEILING_SHOULDER * Math.tanh((a - CEILING_KNEE) / CEILING_SHOULDER);
    c[i] = x < 0 ? -y : y;
  }
  curveCache.set(key, c);
  return c;
}

/**
 * Makeup gain for a band of noise.
 *
 * White noise spreads its power evenly over the spectrum, so a filter that
 * keeps a fiftieth of the band keeps a fiftieth of the power. The same "0.5"
 * that is a loud tick through a highpass is thirty decibels down through a
 * tight bandpass — which is how a recipe ends up with a wet layer, a set of
 * splinters or a tyre squeal that is in the code and not in the sound.
 *
 * This returns the gain that puts a band's peaks back at about 1.0, so a
 * noise level means what an oscillator level means and a recipe can be read.
 */
function bandMakeup(type: BiquadFilterType, freq: number, q: number, nyquist: number): number {
  const f = clamp(freq / nyquist, 0.002, 0.98);
  let kept: number;
  if (type === 'lowpass') kept = f;
  else if (type === 'highpass') kept = 1 - f;
  else kept = Math.min(1, ((Math.PI / 2) * f) / Math.max(q, 0.1));
  // Uniform white noise is 0.577 RMS, and a filtered band peaks about three
  // times over its RMS: 0.6 is the two of those multiplied out and inverted.
  return clamp(0.6 / Math.sqrt(kept), 0.6, NOISE_MAKEUP_MAX);
}

/**
 * A scratch graph for one triggered sound. Nodes register themselves so the
 * whole patch can be started and stopped as a unit.
 */
class Patch {
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly nyquist: number;
  private readonly offsets: number[] = [];

  constructor(
    readonly ctx: AudioContext,
    readonly out: AudioNode,
    readonly t: number,
    private readonly noiseBuf: AudioBuffer,
  ) {
    this.nyquist = ctx.sampleRate * 0.5;
  }

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

  /**
   * Sustained envelope: up, stay, and a straight line down. For things that
   * drone — an exponential decay is a pluck, and an engine is not plucked.
   */
  hold(g: GainNode, peak: number, attack: number, sustain: number, release: number, at = 0): void {
    const t = this.t + at;
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setValueAtTime(peak, t + attack + sustain);
    p.linearRampToValueAtTime(0, t + attack + sustain + release);
  }

  /**
   * The opposite of `env`: an exponential climb to the peak and then a cliff.
   * Starts a few percent up rather than at silence, or the first half of the
   * rise is spent somewhere nobody can hear it.
   */
  swell(g: GainNode, peak: number, rise: number, release: number, at = 0): void {
    const t = this.t + at;
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak * 0.06, t + 0.012);
    p.exponentialRampToValueAtTime(peak, t + rise);
    p.linearRampToValueAtTime(0, t + rise + release);
  }

  /**
   * Adds a low-frequency oscillator onto an AudioParam.
   *
   * Never point this at a gain that also carries an envelope: the two SUM, so
   * once the envelope has reached zero the gain swings ±depth around it and
   * the layer never actually stops. Give the tremolo a gain stage of its own.
   */
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
  /** Larynx multiplier. A squeak is sung an octave up, not filtered into one. */
  oct: number;
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
  /** Output trim, so that five different throats land at one loudness. */
  trim: number;
}

function timbreShape(t: VoiceProfile['timbre']): TimbreShape {
  const found: TimbreShape | undefined = TIMBRES[t];
  return found ?? TIMBRES.gruff;
}

/**
 * Five throats.
 *
 * A formant only has something to shape if the larynx puts a harmonic near it,
 * which is the whole reason `squeak` is a square wave an octave up: a triangle
 * at 190Hz has nothing left by 2.4kHz, and the old squeak was forty decibels
 * quieter than the gruff voice standing next to it. `nasal` had the same
 * disease in a milder form — two needle formants a long way above a low
 * larynx — and is wider now for the same reason.
 */
const TIMBRES: Record<VoiceProfile['timbre'], TimbreShape> = {
  gruff: { wave: 'sawtooth', oct: 1, f1: 620, q1: 4, f2: 1250, q2: 6, breath: 0.16, sub: 0.35, drive: 6, trim: 1.1 },
  nasal: { wave: 'square', oct: 1, f1: 1500, q1: 5, f2: 2600, q2: 6, breath: 0.08, sub: 0.05, drive: 5, trim: 1 },
  deep: { wave: 'sawtooth', oct: 1, f1: 360, q1: 2.5, f2: 780, q2: 3, breath: 0.1, sub: 0.6, drive: 4, trim: 0.8 },
  squeak: { wave: 'square', oct: 2, f1: 1150, q1: 3.5, f2: 2800, q2: 5, breath: 0.12, sub: 0, drive: 3, trim: 0.7 },
  wheeze: { wave: 'sawtooth', oct: 1, f1: 1050, q1: 1.6, f2: 2100, q2: 2, breath: 0.75, sub: 0.15, drive: 2.5, trim: 1.5 },
};

export class Synth {
  private _ctx: AudioContext | null = null;
  /** The mix bus, ahead of the limiter. */
  private _master: GainNode | null = null;
  /** Master volume, behind the limiter. */
  private out: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  /** Where the music comes in, and where big cues push it down. */
  private duckBus: GainNode | null = null;
  private roomIn: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private voices: ActiveVoice[] = [];
  private masterVol = 0.8;
  private sfxVol = 0.9;
  /** The duck in force: how deep, and until when it is being held. */
  private duckDepth = 0;
  private duckEnds = 0;

  /** The shared AudioContext, or null until something has unlocked audio. */
  get context(): AudioContext | null {
    return this._ctx;
  }

  /** The mix bus, ahead of the limiter and the master volume. */
  get master(): GainNode | null {
    return this._master;
  }

  /**
   * Where the soundtrack plugs in: the mix bus by way of the duck, so the
   * cues in `DUCK` can lean on it. Anything connected to `master` instead is
   * never ducked.
   */
  get musicIn(): GainNode | null {
    return this.duckBus;
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
    if (!ctx || !this.out || !this.sfxBus) return;
    const t = ctx.currentTime;
    this.out.gain.setTargetAtTime(this.masterVol, t, 0.02);
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
    const send = this.sendToRoom(ctx, vg, ROOM[cue] ?? 0);

    const p = new Patch(ctx, vg, t, this.noiseBuf);
    const dur = this.build(p, cue, pitch);
    p.play(dur + 0.03);
    this.voices.push({ gain: vg, pan: pn, send, sources: p.sources, ends: t + dur + 0.08, loud });

    const duck = DUCK[cue];
    if (duck !== undefined) this.duck(t, duck * Math.min(gain, 1), dur);
  }

  /**
   * Procedural grunt. The profile's pitch sets the larynx, the timbre picks a
   * formant pair, the wobble detunes and shakes it, and `kind` decides the
   * pitch contour, the envelope, and what the mouth does while it happens.
   */
  voice(profile: VoiceProfile, kind: VoiceKind): void {
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.sfxBus || !this.noiseBuf) return;

    const now = ctx.currentTime;
    if (!this.reserve(now, kind === 'ko' ? 5 : 1.2)) return;

    const shape = timbreShape(profile.timbre);
    const wobble = clamp(profile.wobble, 0, 1);
    const base =
      clamp(profile.pitch, 40, 900) * shape.oct * (1 + (Math.random() * 2 - 1) * wobble * 0.09);

    const t = now + 0.003;
    const vg = ctx.createGain();
    vg.gain.value = shape.trim;
    const pn = ctx.createStereoPanner();
    pn.pan.value = (Math.random() * 2 - 1) * 0.15;
    vg.connect(pn);
    pn.connect(this.sfxBus);
    const send = this.sendToRoom(ctx, vg, VOICE_ROOM);

    const p = new Patch(ctx, vg, t, this.noiseBuf);

    let dur: number;
    let start: number;
    let mid: number;
    let end: number;
    let attack: number;
    let level: number;
    // The mouth: formants are scaled from `open0` to `open1` across the sound.
    // Above 1 is a jaw dropping, below 1 is one closing.
    let open0: number;
    let open1: number;
    // The consonant in front of the vowel, as a fraction of `level`.
    let puff: number;
    switch (kind) {
      case 'attack':
        // "Hah!" — opens as it goes.
        dur = 0.19;
        start = base * 0.95;
        mid = base * 1.22;
        end = base * 0.86;
        attack = 0.012;
        level = 0.5;
        open0 = 0.96;
        open1 = 1.14;
        puff = 0.32;
        break;
      case 'ko':
        // "Aaaauugh" — everything falls: pitch, jaw, and finally the voice.
        dur = 0.72;
        start = base * 1.12;
        mid = base * 0.85;
        end = base * 0.32;
        attack = 0.03;
        level = 0.62;
        open0 = 1.12;
        open1 = 0.7;
        puff = 0.22;
        break;
      case 'taunt':
        dur = 0.46;
        start = base * 0.9;
        mid = base * 1.28;
        end = base * 1.0;
        attack = 0.04;
        level = 0.42;
        open0 = 1;
        open1 = 1.08;
        puff = 0;
        break;
      case 'jump':
        // "Hup."
        dur = 0.16;
        start = base * 0.82;
        mid = base * 1.2;
        end = base * 1.55;
        attack = 0.01;
        level = 0.34;
        open0 = 0.9;
        open1 = 1.16;
        puff = 0.24;
        break;
      case 'hit':
      default:
        // "Ugh" — the air leaving, and the jaw shutting on it.
        dur = 0.22;
        start = base * 1.3;
        mid = base * 0.95;
        end = base * 0.7;
        attack = 0.008;
        level = 0.55;
        open0 = 1.1;
        open1 = 0.82;
        puff = 0.38;
        break;
    }

    const body = p.gain();
    const f1 = p.filter('bandpass', shape.f1 * open0, shape.q1);
    const f2 = p.filter('bandpass', shape.f2 * open0, shape.q2);
    // A vowel held perfectly still is a synth pad. The second formant moves
    // half as far as the first, which is roughly what a jaw does to them.
    f1.frequency.exponentialRampToValueAtTime(shape.f1 * open1, t + dur);
    f2.frequency.exponentialRampToValueAtTime(shape.f2 * (open0 + open1) * 0.5, t + dur);
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
      // The chest. It goes AROUND the formants: fed through them, a 45Hz sine
      // meets a bandpass sitting four octaves above it and does not come out.
      const sub = p.osc('sine', start * 0.5);
      sub.frequency.exponentialRampToValueAtTime(Math.max(end * 0.5, 12), t + dur);
      const sg = p.gain(shape.sub * 0.5);
      sub.connect(sg);
      sg.connect(body);
    }

    if (shape.breath > 0) {
      const n = p.noise(1);
      const nf = p.filter('bandpass', shape.f1 * 1.4, 1.2);
      const air = shape.breath * 0.22 * bandMakeup('bandpass', shape.f1 * 1.4, 1.2, p.nyquist);
      const ng = p.gain(air);
      // A dying voice stops being voiced before it stops being breath.
      if (kind === 'ko') {
        ng.gain.setValueAtTime(air, t + dur * 0.3);
        ng.gain.linearRampToValueAtTime(air * 3, t + dur);
      }
      n.connect(nf);
      nf.connect(ng);
      ng.connect(mixer);
    }

    // The consonant. A grunt with no onset is a vowel somebody left running;
    // thirty milliseconds of unvoiced air in front of it is the "h" in "hah".
    if (puff > 0) {
      this.noiseHit(p, 'bandpass', shape.f2 * 0.9, shape.f1, 1.4, level * puff, 0.002, 0.03);
    }

    // Larynx wobble; a KO gets a proper death-rattle warble.
    p.lfo(cord.frequency, kind === 'ko' ? 9 : 6.5, base * wobble * (kind === 'ko' ? 0.22 : 0.1));

    if (kind === 'taunt') {
      // Two syllables: "haa — haaa".
      p.env(body, level, attack, 0.14);
      p.env(body, level * 0.9, 0.03, 0.2, 0.22);
    } else {
      p.env(body, level, attack, dur - attack);
    }

    p.play(dur + 0.05);
    this.voices.push({
      gain: vg,
      pan: pn,
      send,
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
          v.send?.disconnect();
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

  // ── Bus ────────────────────────────────────────────────────────────────────

  /**
   * Taps a voice into the room. The tap is taken ahead of the pan: a wall does
   * not care which side of the screen the punch was thrown on.
   */
  private sendToRoom(ctx: AudioContext, voice: GainNode, amount: number): GainNode | null {
    const room = this.roomIn;
    if (!room || amount <= 0) return null;
    const send = ctx.createGain();
    send.gain.value = amount;
    voice.connect(send);
    send.connect(room);
    return send;
  }

  /**
   * Pushes the music down for the length of a big cue and lets it back up.
   *
   * Targets rather than ramps, so a duck landing on top of another one starts
   * from wherever the gain actually is and never jumps.
   */
  private duck(t: number, depth: number, dur: number): void {
    const bus = this.duckBus;
    if (!bus || depth <= 0) return;
    // A small hit inside a big one's hold must not let the music back in.
    if (t < this.duckEnds && depth <= this.duckDepth) return;
    const hold = clamp(dur * 0.45, 0.12, 0.6);
    this.duckDepth = depth;
    this.duckEnds = t + hold;
    const g = bus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - clamp(depth, 0, 0.8), t, DUCK_ATTACK);
    g.setTargetAtTime(1, t + hold, DUCK_RELEASE);
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

    // The mix bus runs at unity. The volume knob is at the far end of the
    // chain, so the limiter sees the same mix whatever the player has set.
    const master = ctx.createGain();
    master.gain.value = 1;
    // Half the sub layers in this file fall through 30Hz on their way out.
    // Nobody hears that, and the limiter would duck the whole mix for it.
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 28;
    rumble.Q.value = 0;
    // The glue. A single heavy hit only leans on it; a screenful of them is
    // held together by it instead of clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 7;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.14;
    const pad = ctx.createGain();
    pad.gain.value = CEILING_PAD;
    const ceiling = ctx.createWaveShaper();
    ceiling.curve = ceilingCurve();
    const out = ctx.createGain();
    out.gain.value = this.masterVol;
    master.connect(rumble);
    rumble.connect(limiter);
    limiter.connect(pad);
    pad.connect(ceiling);
    ceiling.connect(out);
    out.connect(ctx.destination);

    const sfx = ctx.createGain();
    sfx.gain.value = this.sfxVol;
    sfx.connect(master);

    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(master);

    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._ctx = ctx;
    this._master = master;
    this.out = out;
    this.sfxBus = sfx;
    this.duckBus = duck;
    this.roomIn = this.buildRoom(ctx, sfx);
    this.noiseBuf = buf;
    return ctx;
  }

  /**
   * The shared room: twelve nodes, built once, returned into the sfx bus so
   * it obeys the effects volume like everything that feeds it.
   *
   * Band-limited on the way in. A room full of sub is mud and a room full of
   * top is a spring reverb; what a wall gives back is the middle.
   */
  private buildRoom(ctx: AudioContext, into: AudioNode): GainNode {
    const input = ctx.createGain();
    input.gain.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 240;
    hp.Q.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3600;
    lp.Q.value = 0;
    const ret = ctx.createGain();
    ret.gain.value = ROOM_RETURN;
    input.connect(hp);
    hp.connect(lp);
    ret.connect(into);

    const taps: readonly [number, number][] = [
      [ROOM_TAP_L, -0.7],
      [ROOM_TAP_R, 0.7],
    ];
    for (const [time, pan] of taps) {
      const d = ctx.createDelay(0.25);
      d.delayTime.value = time;
      const pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      lp.connect(d);
      d.connect(pn);
      pn.connect(ret);
    }

    // The slap. Damped inside the loop, so each trip round is duller as well
    // as quieter; the feedback is well under unity and cannot run away.
    const slap = ctx.createDelay(0.25);
    slap.delayTime.value = ROOM_SLAP;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1800;
    damp.Q.value = 0;
    const fb = ctx.createGain();
    fb.gain.value = ROOM_FEEDBACK;
    const slapOut = ctx.createGain();
    slapOut.gain.value = 0.6;
    lp.connect(slap);
    slap.connect(damp);
    damp.connect(fb);
    fb.connect(slap);
    slap.connect(slapOut);
    slapOut.connect(ret);

    return input;
  }

  // ── Building blocks ────────────────────────────────────────────────────────

  /**
   * Pitched body. The fall from `f0` to `f1` is finished `sweep` of the way
   * through the envelope and the rest rings at the bottom note; pass 1 for a
   * drop that is still falling as it dies, which is what a sub drop wants and
   * what a punch must never do.
   */
  private thump(
    p: Patch,
    f0: number,
    f1: number,
    dur: number,
    level: number,
    wave: OscillatorType = 'sine',
    at = 0,
    dest?: AudioNode,
    sweep = 0.4,
  ): void {
    const o = p.osc(wave, f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 8), p.t + at + Math.max(dur * sweep, 0.004));
    const g = p.gain();
    o.connect(g);
    g.connect(dest ?? p.out);
    p.env(g, level, 0.002, dur, at);
  }

  /**
   * A burst of filtered noise. `level` is compensated for the width of the
   * band (see `bandMakeup`), so 0.5 here is about as loud as 0.5 on a thump.
   */
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
    p.env(g, level * bandMakeup(type, f0, q, p.nyquist), attack, decay, at);
    return f;
  }

  /**
   * The transient: a few milliseconds of everything above `hz`. Route it to
   * the output, never into a drive — saturating a click only makes it longer.
   */
  private snap(p: Patch, hz: number, level: number, decay = 0.01, at = 0, dest?: AudioNode): void {
    this.noiseHit(p, 'highpass', hz, hz, 0.7, level, 0.0005, decay, at, dest);
  }

  /**
   * Air moving: a band of noise that climbs to `peak` as it gets loud and
   * falls away past it. Level is compensated at the peak, where it is heard.
   */
  private whoosh(
    p: Patch,
    f0: number,
    peak: number,
    f1: number,
    q: number,
    level: number,
    rise: number,
    fall: number,
    at = 0,
    dest?: AudioNode,
  ): BiquadFilterNode {
    const t = p.t + at;
    const n = p.noise(1, at);
    const f = p.filter('bandpass', f0, q);
    f.frequency.setValueAtTime(Math.max(f0, 10), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(peak, 10), t + rise);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), t + rise + fall);
    const g = p.gain();
    n.connect(f);
    f.connect(g);
    g.connect(dest ?? p.out);
    p.env(g, level * bandMakeup('bandpass', peak, q, p.nyquist), rise, fall, at);
    return f;
  }

  /** One decaying partial. Two nodes: the cheapest thing in here that rings. */
  private ring(
    p: Patch,
    freq: number,
    dur: number,
    level: number,
    at = 0,
    dest?: AudioNode,
    wave: OscillatorType = 'sine',
  ): OscillatorNode {
    const o = p.osc(wave, freq, at);
    const g = p.gain();
    o.connect(g);
    g.connect(dest ?? p.out);
    p.env(g, level, 0.001, dur, at);
    return o;
  }

  /**
   * Struck metal: the inharmonic partials of a free bar, each a hair off true
   * so that two clangs in a row are two clangs and not one sample twice. The
   * upper partials are quieter and die sooner. `partials` is the price knob —
   * four is a clang, two is a chain link.
   */
  private metal(
    p: Patch,
    base: number,
    dur: number,
    level: number,
    at = 0,
    dest?: AudioNode,
    partials = 4,
  ): void {
    const ratios = [1, 2.76, 5.4, 8.93];
    const n = Math.min(partials, ratios.length);
    for (let i = 0; i < n; i++) {
      const f = base * ratios[i] * (1 + (Math.random() * 2 - 1) * 0.006);
      this.ring(p, f, dur * (1 - i * 0.16), level / (1 + i * 1.1), at, dest);
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

  /**
   * A drive stage with an output trim, returned as the node to feed.
   *
   * tanh pins anything pushed into it at full scale, so on its own a drive is
   * a volume knob stuck at ten. Split the two jobs: `amount` is how much the
   * layers are crushed together, `level` is how loud the result is.
   */
  private crunch(p: Patch, amount: number, level: number, dest?: AudioNode): WaveShaperNode {
    const w = p.drive(amount);
    const g = p.gain(level);
    w.connect(g);
    g.connect(dest ?? p.out);
    return w;
  }

  // ── Gore recipes ───────────────────────────────────────────────────────────
  //
  // Each is a cue in its own right (`squelch`, `bone_snap`, `tear`, `gulp`,
  // `slam`) and takes its pitch as `w`, exactly as the cue table takes `k`.
  // Three of them are also reachable through a legacy pitch alias; see the top
  // of the file.

  /** Wet, sucking, organic. Impact, then suction, then dribble. */
  private squelch(p: Patch, w: number): number {
    const t = p.t;

    // The blow still has to land; this half is a punch like any other.
    const dist = this.crunch(p, 2.6, 0.62);
    this.noiseHit(p, 'lowpass', 800 * w, 240 * w, 0.9, 0.6, 0.002, 0.12, 0, dist);
    this.thump(p, 96 * w, 46 * w, 0.15, 0.5, 'sine', 0, dist);

    // Suction: a resonant band dragged downwards is a boot leaving mud, and a
    // fist leaving a ribcage is the same physics with worse manners.
    const wet = this.noiseHit(p, 'bandpass', 1300 * w, 170 * w, 6, 0.5, 0.012, 0.25, 0.012);
    p.lfo(wet.frequency, 27, 130 * w, 'triangle');

    // The slack body of the thing, falling an octave and a half.
    const gloop = p.osc('triangle', 340 * w, 0.02);
    gloop.frequency.exponentialRampToValueAtTime(70 * w, t + 0.3);
    const lp = p.filter('lowpass', 1500, 3);
    const gg = p.gain();
    gloop.connect(lp);
    lp.connect(gg);
    gg.connect(p.out);
    p.env(gg, 0.28, 0.012, 0.3, 0.02);

    // Dribble. Three small wet ticks trailing off.
    for (let i = 0; i < 3; i++) {
      const at = 0.17 + i * 0.055 + Math.random() * 0.02;
      this.noiseHit(p, 'bandpass', (1500 + i * 520) * w, 600 * w, 8, 0.2, 0.002, 0.05, at);
    }
    return 0.44;
  }

  /** A snap with splinters and meat around it. */
  private boneSnap(p: Patch, w: number): number {
    // The break: a hard transient, then a struck-timber ring, very short.
    this.snap(p, 2500 * w, 0.62, 0.016);
    this.blip(p, 'square', 3100 * w, 1700 * w, 0.36, 0.015);
    this.metal(p, 760 * w, 0.09, 0.22, 0.002, undefined, 3);

    // Splinters, scattered so no two snaps line up.
    for (let i = 0; i < 4; i++) {
      const at = 0.012 + i * 0.019 + Math.random() * 0.012;
      const f = (1700 + Math.random() * 2300) * w;
      this.noiseHit(p, 'bandpass', f, 850 * w, 9, 0.3, 0.001, 0.032, at);
    }

    // And the leg it was inside.
    const dist = this.crunch(p, 3, 0.6);
    this.noiseHit(p, 'lowpass', 700 * w, 200 * w, 0.9, 0.55, 0.002, 0.17, 0.006, dist);
    this.thump(p, 92 * w, 42 * w, 0.18, 0.6, 'sine', 0.006, dist);
    return 0.3;
  }

  /**
   * Something being pulled apart, slowly, until it gives: fabric on top,
   * flesh underneath, and the pop when the last of it lets go. Half a second,
   * built for the "pull" beat of a finisher rather than for a rip in passing.
   */
  private tear(p: Patch, w: number): number {
    const t = p.t;
    const give = 0.44;

    // A rip is not one event, it is a few hundred small ones. Chopping the
    // band hard in the low audio range is what turns hiss into tearing, and
    // the chop accelerates because a tear does.
    const body = p.gain();
    body.connect(p.out);
    const hp = p.filter('highpass', 520 * w, 0.7);
    const bp = p.filter('bandpass', 2800 * w, 1.3);
    bp.frequency.exponentialRampToValueAtTime(760 * w, t + give);
    const chop = p.gain(0.35);
    const rip = p.lfo(chop.gain, 22, 0.65, 'square');
    rip.frequency.exponentialRampToValueAtTime(64, t + give);
    const n = p.noise(1.25);
    n.connect(hp);
    hp.connect(bp);
    bp.connect(chop);
    chop.connect(body);
    // It gets louder as it runs, right up to the moment it gives.
    const peak = 0.4 * bandMakeup('bandpass', 2800 * w, 1.3, p.nyquist);
    body.gain.setValueAtTime(0, t);
    body.gain.linearRampToValueAtTime(peak * 0.5, t + 0.03);
    body.gain.linearRampToValueAtTime(peak, t + give - 0.04);
    body.gain.exponentialRampToValueAtTime(0.0002, t + give + 0.08);
    body.gain.setValueAtTime(0, t + give + 0.082);

    // The wet half: what makes it a tendon rather than a shirt.
    const wet = this.noiseHit(p, 'bandpass', 950 * w, 300 * w, 5, 0.3, 0.05, 0.42);
    p.lfo(wet.frequency, 19, 110 * w, 'triangle');

    // Individual fibres letting go, the gaps closing as the tear runs.
    for (let i = 0; i < 4; i++) {
      const at = 0.02 + (give - 0.04) * (1 - (1 - i / 5) ** 2) + Math.random() * 0.012;
      this.noiseHit(p, 'highpass', (3600 - i * 300) * w, 2100 * w, 0.8, 0.2, 0.0008, 0.022, at);
    }

    // And then it gives.
    this.noiseHit(p, 'lowpass', 1100 * w, 260 * w, 0.9, 0.45, 0.004, 0.11, give);
    this.thump(p, 140 * w, 64 * w, 0.1, 0.35, 'sine', give);
    return 0.58;
  }

  /** Chew, chew, swallow. A gulp is a pitch contour, not a timbre. */
  private gulp(p: Patch, w: number): number {
    const t = p.t;

    // Two closed-mouth chews.
    for (let i = 0; i < 2; i++) {
      const at = i * 0.13;
      this.noiseHit(p, 'lowpass', 880 * w, 300 * w, 1.2, 0.3, 0.004, 0.07, at);
      this.thump(p, 150 * w, 88 * w, 0.08, 0.22, 'triangle', at);
    }

    // The swallow itself: down the throat and back up behind it. The dip and
    // the recovery are the whole sound — "g-LUP" — so it is a contour on one
    // oscillator, with a lid on it so it stays inside a neck.
    const o = p.osc('triangle', 250 * w, 0.28);
    o.frequency.exponentialRampToValueAtTime(92 * w, t + 0.37);
    o.frequency.exponentialRampToValueAtTime(310 * w, t + 0.45);
    const lp = p.filter('lowpass', 900 * w, 4);
    const g = p.gain();
    o.connect(lp);
    lp.connect(g);
    g.connect(p.out);
    p.env(g, 0.45, 0.02, 0.2, 0.28);

    // Throat closing behind it, and a small satisfied click.
    this.noiseHit(p, 'bandpass', 700 * w, 250 * w, 5, 0.2, 0.01, 0.1, 0.3);
    this.blip(p, 'sine', 180 * w, 96 * w, 0.2, 0.09, 0.47);
    return 0.6;
  }

  /** A whole body arriving on the floor, limbs a beat behind it. */
  private slam(p: Patch, w: number): number {
    const dist = this.crunch(p, 4, 0.9);
    // The floor.
    this.thump(p, 122 * w, 32 * w, 0.34, 0.95, 'sine', 0, dist, 0.35);
    this.thump(p, 68 * w, 26 * w, 0.46, 0.45, 'triangle', 0.012, dist, 1);
    // The meat.
    this.noiseHit(p, 'lowpass', 1600 * w, 260 * w, 0.9, 0.6, 0.002, 0.18, 0, dist);
    // The flat slap of all of it arriving at once. Not in the drive: this is
    // the layer that tells a small speaker something landed.
    this.noiseHit(p, 'bandpass', 1300 * w, 700 * w, 1.0, 0.4, 0.001, 0.035);
    // The follow-through as the arms and head land after the torso.
    this.noiseHit(p, 'lowpass', 900 * w, 240 * w, 0.9, 0.3, 0.004, 0.12, 0.09, dist);
    this.thump(p, 96 * w, 38 * w, 0.16, 0.35, 'sine', 0.095, dist);
    // Debris: whatever was on the floor, or in his pockets.
    for (let i = 0; i < 3; i++) {
      const at = 0.06 + i * 0.07 + Math.random() * 0.05;
      const f = (1900 + Math.random() * 2200) * w;
      this.noiseHit(p, 'bandpass', f, 1200 * w, 5, 0.2 - i * 0.04, 0.001, 0.035, at);
    }
    return 0.52;
  }

  // ── The cue table ──────────────────────────────────────────────────────────

  private build(p: Patch, cue: SfxCue, k: number): number {
    const t = p.t;

    switch (cue) {
      // ── Core combat ────────────────────────────────────────────────────────

      case 'punch_light': {
        // A jab is all knuckle: a tick, a slap, and a knock where a heavier
        // blow would have a thump. No sub, no drive, nothing past 90ms — it
        // has to survive being played eight times a second.
        this.snap(p, 3400 * k, 0.5, 0.007);
        this.noiseHit(p, 'bandpass', 1900 * k, 1050 * k, 1.3, 0.9, 0.001, 0.06);
        this.thump(p, 250 * k, 135 * k, 0.07, 0.7, 'triangle');
        return 0.1;
      }

      case 'punch_heavy': {
        // The crack and the smack go straight to the output; saturating them
        // with the body is what made the old one a puff with a thud under it.
        this.snap(p, 1700 * k, 0.45, 0.012);
        this.noiseHit(p, 'bandpass', 950 * k, 480 * k, 1.2, 0.34, 0.001, 0.075);
        const dist = this.crunch(p, 8, 0.92);
        this.noiseHit(p, 'lowpass', 2200 * k, 300 * k, 0.9, 0.6, 0.002, 0.2, BODY_LAG, dist);
        this.thump(p, 170 * k, 48 * k, 0.24, 0.8, 'sine', BODY_LAG, dist, 0.35);
        // The sub arrives later still and is falling as it dies: that is the
        // follow-through, and the only place a punch is allowed one.
        this.thump(p, 64 * k, 34 * k, 0.3, 0.45, 'sine', 0.012, dist, 1);
        return 0.34;
      }

      case 'kick': {
        // A boot has no knuckle. Where a punch cracks, a kick whups: leather
        // in the low mids with a soft onset, and a body that takes half its
        // envelope to fall instead of a third.
        const dist = this.crunch(p, 4.5, 0.88);
        this.noiseHit(p, 'bandpass', 720 * k, 360 * k, 1.5, 0.7, 0.004, 0.1, 0, dist);
        this.thump(p, 135 * k, 44 * k, 0.19, 0.8, 'sine', 0, dist, 0.5);
        // Just enough top to find it in a crowd, and no more.
        this.noiseHit(p, 'bandpass', 2300 * k, 1300 * k, 1.1, 0.24, 0.001, 0.022);
        return 0.22;
      }

      case 'knee': {
        // Close range and nothing swinging behind it: dense, dry and over.
        // Shorter than a kick and with no room on it at all.
        const dist = this.crunch(p, 6, 0.8);
        this.thump(p, 150 * k, 72 * k, 0.085, 0.9, 'sine', 0, dist, 0.3);
        this.noiseHit(p, 'lowpass', 680 * k, 260 * k, 0.9, 0.6, 0.001, 0.06, 0, dist);
        // The cracked top: bone through skin, a tick and a splinter of tone.
        this.snap(p, 2800 * k, 0.5, 0.006);
        this.blip(p, 'square', 1900 * k, 1150 * k, 0.3, 0.012);
        return 0.13;
      }

      case 'jump_kick': {
        // The air he came through, squeezed into two frames, and then the
        // boot. The smack is 34ms late on purpose: it lands inside the
        // hitstop, and without the lead-in it is just a kick.
        const at = 0.034;
        this.whoosh(p, 500 * k, 3000 * k, 2400 * k, 2, 0.3, at, 0.03);
        this.snap(p, 2300 * k, 0.32, 0.009, at);
        this.noiseHit(p, 'bandpass', 1100 * k, 520 * k, 1.4, 0.45, 0.001, 0.09, at);
        const dist = this.crunch(p, 5, 0.8);
        this.noiseHit(p, 'lowpass', 1500 * k, 300 * k, 0.9, 0.6, 0.002, 0.14, at, dist);
        this.thump(p, 150 * k, 50 * k, 0.2, 0.85, 'sine', at, dist, 0.4);
        return 0.27;
      }

      case 'whiff': {
        // Two bands: the swing, and the air on top of it that a small speaker
        // actually gets to play.
        this.whoosh(p, 260 * k, 2500 * k, 480 * k, 2.4, 0.3, 0.04, 0.14);
        this.whoosh(p, 900 * k, 5200 * k, 1800 * k, 1.6, 0.1, 0.04, 0.09);
        return 0.21;
      }

      case 'block': {
        // Has to say "nothing got through" in forty milliseconds, so it is
        // everything a hit is not: padded, hollow, no crack and nothing wet.
        this.noiseHit(p, 'lowpass', 950 * k, 360 * k, 0.9, 0.6, 0.001, 0.06);
        const o = p.osc('square', 235 * k);
        o.frequency.exponentialRampToValueAtTime(150 * k, t + 0.04);
        const lp = p.filter('lowpass', 820 * k, 2);
        const g = p.gain();
        o.connect(lp);
        lp.connect(g);
        g.connect(p.out);
        p.env(g, 0.45, 0.002, 0.085);
        // A dull "tk" in the mids so it reads without a woofer. Deliberately
        // not bright: the bright one is the parry.
        this.noiseHit(p, 'bandpass', 1500 * k, 1500 * k, 2.2, 0.2, 0.001, 0.014);
        return 0.12;
      }

      case 'parry': {
        this.snap(p, 4000 * k, 0.3, 0.02);
        // Weight under the ting, or it is a menu sound.
        this.thump(p, 320 * k, 170 * k, 0.05, 0.3);
        this.metal(p, 1480 * k, 0.4, 0.24, 0, undefined, 3);
        // A true fifth over the clang. The clang says "steel"; this is the
        // part that says "well done".
        this.ring(p, 2217 * k, 0.34, 0.11, 0.004);
        const shimmer = p.osc('sine', 2600 * k);
        shimmer.frequency.exponentialRampToValueAtTime(4200 * k, t + 0.22);
        const sg = p.gain();
        shimmer.connect(sg);
        sg.connect(p.out);
        p.env(sg, 0.14, 0.02, 0.24);
        return 0.45;
      }

      case 'hit_flesh': {
        if (k <= SQUELCH_BELOW) return this.squelch(p, aliasPitch(k, SQUELCH_ALIAS_PITCH));
        // The default "that landed", so it is the dullest and wettest of the
        // hits: more meat than a punch, less crack, and a damp edge on it.
        this.snap(p, 2400 * k, 0.2, 0.006);
        const dist = this.crunch(p, 3, 0.7);
        this.noiseHit(p, 'lowpass', 1250 * k, 320 * k, 0.9, 0.7, 0.002, 0.11, 0, dist);
        this.thump(p, 112 * k, 55 * k, 0.13, 0.55, 'sine', 0, dist);
        this.noiseHit(p, 'bandpass', 1700 * k, 520 * k, 4.5, 0.3, 0.006, 0.09, 0.004);
        return 0.17;
      }

      case 'hit_metal': {
        this.snap(p, 3000 * k, 0.3, 0.006);
        // The zing: one tight band of noise riding the clang.
        this.noiseHit(p, 'bandpass', 2600 * k, 1800 * k, 12, 0.26, 0.001, 0.09);
        // Shorter than it used to ring. A robot takes a dozen of these a
        // second and the room carries the tail for free.
        this.metal(p, 520 * k, 0.36, 0.34);
        this.thump(p, 170 * k, 86 * k, 0.07, 0.4);
        return 0.42;
      }

      case 'bone_crack': {
        if (k <= BONE_SNAP_BELOW) return this.boneSnap(p, aliasPitch(k, BONE_SNAP_ALIAS_PITCH));
        // Two fractures nine milliseconds apart. That gap is the difference
        // between "crack" and "tick".
        this.snap(p, 2600 * k, 0.55, 0.011);
        this.noiseHit(p, 'bandpass', 1700 * k, 1200 * k, 2.5, 0.45, 0.0006, 0.016, 0.009);
        this.blip(p, 'square', 3400 * k, 2100 * k, 0.3, 0.012);
        // A dozen heavy moves use this as their HIT sound, and as a bare tick
        // they landed softer than a jab. It keeps the crack and gets a limb.
        const dist = this.crunch(p, 4, 0.68);
        this.noiseHit(p, 'lowpass', 820 * k, 300 * k, 0.9, 0.6, 0.002, 0.08, 0.003, dist);
        this.thump(p, 130 * k, 60 * k, 0.11, 0.7, 'sine', 0.003, dist);
        return 0.13;
      }

      case 'ko': {
        // This fires on every death in a crowded room, so it is a blow first
        // and a boom second, and it is finished inside a second. The slow
        // cinematic version is `sub_drop`; the killing blow is `impact_heavy`.
        this.snap(p, 1500 * k, 0.35, 0.02);
        const dist = this.crunch(p, 8, 0.8);
        this.thump(p, 260 * k, 42 * k, 0.42, 0.9, 'sine', BODY_LAG, dist, 0.3);
        this.thump(p, 72 * k, 26, 0.7, 0.7, 'sine', 0.012, dist, 1);
        this.noiseHit(p, 'lowpass', 3200 * k, 220, 0.9, 0.6, 0.004, 0.5, BODY_LAG, dist);
        // The arcade bell under a final blow.
        this.metal(p, 196 * k, 0.6, 0.12, 0.01, undefined, 3);
        return 0.8;
      }

      // ── Finishers ──────────────────────────────────────────────────────────

      case 'impact_heavy': {
        // The biggest single hit in the game. Two cracks, a body, a sub that
        // is still dropping after everything else has stopped, a wet layer,
        // and a low gong so the silence after it has something in it.
        this.snap(p, 1400 * k, 0.5, 0.022);
        this.noiseHit(p, 'bandpass', 2400 * k, 1500 * k, 2, 0.45, 0.0006, 0.02, 0.012);
        const dist = this.crunch(p, 10, 1.0);
        this.thump(p, 210 * k, 40 * k, 0.4, 1.0, 'sine', BODY_LAG, dist, 0.3);
        this.noiseHit(p, 'lowpass', 2600 * k, 260 * k, 0.9, 0.7, 0.002, 0.3, BODY_LAG, dist);
        this.thump(p, 78 * k, 24, 0.9, 0.8, 'sine', 0.012, dist, 1);
        const wet = this.noiseHit(p, 'bandpass', 1500 * k, 300 * k, 5, 0.36, 0.012, 0.3, 0.02);
        p.lfo(wet.frequency, 24, 140 * k, 'triangle');
        this.metal(p, 164 * k, 0.75, 0.2, 0.01, undefined, 3);
        // And the room it happened in, closing behind it.
        this.noiseHit(p, 'lowpass', 900, 200, 0.8, 0.18, 0.02, 0.7, 0.03);
        return 1.0;
      }

      case 'slam':
        return this.slam(p, k);

      case 'squelch':
        return this.squelch(p, k);

      case 'bone_snap':
        return this.boneSnap(p, k);

      case 'tear':
        return this.tear(p, k);

      case 'gulp':
        return this.gulp(p, k);

      case 'slice': {
        // Steel through air: a tight band thrown up through the top octave.
        this.whoosh(p, 2200 * k, 7600 * k, 3800 * k, 5, 0.65, 0.022, 0.09);
        // The edge itself: two partials with no business being in tune.
        this.ring(p, 4100 * k, 0.12, 0.14, 0.01);
        this.ring(p, 6230 * k, 0.09, 0.09, 0.01);
        // Contact.
        this.snap(p, 4500 * k, 0.45, 0.008, 0.022);
        // And what a blade leaves behind, which is the half people remember.
        const wet = this.noiseHit(p, 'bandpass', 1300 * k, 380 * k, 6, 0.6, 0.01, 0.22, 0.04);
        p.lfo(wet.frequency, 23, 120 * k, 'triangle');
        for (let i = 0; i < 2; i++) {
          const at = 0.16 + i * 0.07 + Math.random() * 0.02;
          this.noiseHit(p, 'bandpass', (1700 + i * 600) * k, 700 * k, 8, 0.3, 0.002, 0.05, at);
        }
        return 0.36;
      }

      case 'whoosh_big': {
        // Something large going past slowly. Three bands whose peaks are a
        // few frames apart, so it travels instead of just swelling.
        this.whoosh(p, 90 * k, 520 * k, 140 * k, 1.2, 0.4, 0.32, 0.4);
        const mid = this.whoosh(p, 300 * k, 1900 * k, 480 * k, 1.8, 0.34, 0.36, 0.32);
        p.lfo(mid.frequency, 6.5, 160 * k);
        this.whoosh(p, 1800 * k, 6000 * k, 2400 * k, 1.5, 0.12, 0.4, 0.2);
        return 0.78;
      }

      case 'riser': {
        // Tension is a pitch that will not stop climbing and a tremolo that
        // will not stop speeding up. The release is silence: it falls off a
        // cliff 35ms before the end so the blow lands in a hole.
        const top = 0.78;
        const lp = p.filter('lowpass', 320, 5);
        lp.frequency.exponentialRampToValueAtTime(4200, t + top);
        const trem = p.gain(0.7);
        const shake = p.lfo(trem.gain, 6, 0.3);
        shake.frequency.exponentialRampToValueAtTime(30, t + top);
        const body = p.gain();
        lp.connect(trem);
        trem.connect(body);
        body.connect(p.out);
        p.swell(body, 0.62, top, 0.035);
        for (let i = 0; i < 2; i++) {
          const o = p.osc('sawtooth', 98 * k);
          o.detune.setValueAtTime(i * 16 - 8, t);
          o.frequency.exponentialRampToValueAtTime(392 * k, t + top);
          const g = p.gain(0.5);
          o.connect(g);
          g.connect(lp);
        }
        // Air, opening with it. Into the tremolo, not the lowpass.
        const air = p.noise(1);
        const hp = p.filter('highpass', 500, 0.7);
        hp.frequency.exponentialRampToValueAtTime(6000, t + top);
        const ag = p.gain(0.3);
        air.connect(hp);
        hp.connect(ag);
        ag.connect(trem);
        return 0.84;
      }

      case 'sub_drop': {
        // The slow-motion boom: no transient at all, just the floor going
        // away. The triangle an octave up is the same drop for speakers that
        // do not have a bottom octave, and the drive gives both of them
        // harmonics to be heard by.
        const dist = this.crunch(p, 3, 1.0);
        this.thump(p, 110 * k, 26 * k, 1.2, 1.0, 'sine', 0, dist, 0.85);
        this.thump(p, 220 * k, 52 * k, 0.8, 0.3, 'triangle', 0, dist, 0.85);
        this.noiseHit(p, 'lowpass', 520 * k, 80, 0.8, 0.5, 0.004, 0.4, 0, dist);
        return 1.25;
      }

      case 'fatality_sting': {
        // DUN — DUNNN. Two notes, a tritone apart and falling, which is the
        // most menacing interval there is and also the one a cartoon uses.
        // The second note sags a semitone as it dies, like a tuba running out
        // of player: that sag is the joke.
        const n1 = 155.6 * k;
        const n2 = 110 * k;
        const at2 = 0.19;

        // Brass is a filter that opens late and closes slowly: the blat.
        const lp = p.filter('lowpass', 380, 6);
        lp.frequency.exponentialRampToValueAtTime(2600, t + 0.03);
        lp.frequency.exponentialRampToValueAtTime(700, t + 0.16);
        lp.frequency.setValueAtTime(380, t + at2);
        lp.frequency.exponentialRampToValueAtTime(3000, t + at2 + 0.045);
        lp.frequency.exponentialRampToValueAtTime(520, t + 1.0);
        const growl = p.drive(3.5);
        const amp = p.gain();
        lp.connect(growl);
        growl.connect(amp);
        amp.connect(p.out);
        // Held, not plucked. An exponential decay from the attack is a
        // xylophone; a brass note stays up until the player stops blowing.
        const a = amp.gain;
        a.setValueAtTime(0, t);
        a.linearRampToValueAtTime(0.42, t + 0.008);
        a.linearRampToValueAtTime(0.36, t + 0.11);
        a.exponentialRampToValueAtTime(0.0002, t + 0.18);
        a.setValueAtTime(0, t + at2);
        a.linearRampToValueAtTime(0.5, t + at2 + 0.012);
        a.linearRampToValueAtTime(0.4, t + 0.62);
        a.exponentialRampToValueAtTime(0.0002, t + 1.05);
        a.setValueAtTime(0, t + 1.052);

        const vib = p.osc('sine', 5.5, 0.4);
        const vd = p.gain(0);
        vd.gain.setValueAtTime(0, t + 0.4);
        vd.gain.linearRampToValueAtTime(n2 * 0.02, t + 1.0);
        vib.connect(vd);
        for (let i = 0; i < 3; i++) {
          // Two saws a few cents apart and a square an octave under them: a
          // section, not a soloist.
          const low = i === 2;
          const o = p.osc(low ? 'square' : 'sawtooth', low ? n1 * 0.5 : n1);
          o.detune.setValueAtTime(low ? 0 : i * 18 - 9, t);
          const f2 = low ? n2 * 0.5 : n2;
          o.frequency.setValueAtTime(f2, t + at2);
          o.frequency.setValueAtTime(f2, t + 0.55);
          o.frequency.exponentialRampToValueAtTime(f2 * 0.94, t + 1.0);
          vd.connect(o.frequency);
          const g = p.gain(low ? 0.3 : 0.36);
          o.connect(g);
          g.connect(lp);
        }

        // An anvil on each note and the floor under the second, so the card
        // SLAMS in rather than merely being announced.
        this.snap(p, 2000, 0.26, 0.012);
        this.snap(p, 1600, 0.36, 0.02, at2);
        this.thump(p, 92 * k, 36, 0.5, 0.7, 'sine', at2, undefined, 0.4);
        this.metal(p, n2 * 2, 0.7, 0.13, at2, undefined, 3);
        return 1.08;
      }

      case 'heartbeat': {
        // Lub-dub. The first sound is the long low one, the second the short
        // higher one a quarter of a second on. Triangles through a drive, so
        // there is something above 150Hz for a laptop to play.
        const dist = this.crunch(p, 3, 0.9);
        this.thump(p, 66 * k, 42 * k, 0.13, 0.9, 'triangle', 0, dist, 0.5);
        this.noiseHit(p, 'lowpass', 300 * k, 120 * k, 0.8, 0.4, 0.004, 0.07, 0, dist);
        this.thump(p, 88 * k, 56 * k, 0.09, 0.7, 'triangle', 0.24, dist, 0.5);
        this.noiseHit(p, 'lowpass', 380 * k, 160 * k, 0.8, 0.3, 0.004, 0.05, 0.24, dist);
        return 0.4;
      }

      // ── Weapons ────────────────────────────────────────────────────────────

      case 'weapon_swing': {
        // Heavier than a whiff by one band: the low one is the weight of the
        // thing being swung.
        this.whoosh(p, 360 * k, 2900 * k, 700 * k, 2.6, 0.34, 0.06, 0.18);
        this.whoosh(p, 150 * k, 760 * k, 240 * k, 1.3, 0.3, 0.07, 0.17);
        return 0.27;
      }

      case 'chain_whip': {
        // It is a swing AND a hit sound, so it opens on the links snatching
        // taut: as a hit that is the impact, as a swing it is the first yank.
        this.snap(p, 3200 * k, 0.4, 0.006);
        this.metal(p, 880 * k, 0.08, 0.4, 0, undefined, 2);
        this.whoosh(p, 680 * k, 4300 * k, 1200 * k, 4, 0.3, 0.05, 0.2);
        // Links. Two partials each: at this length nobody can count more, and
        // four full clangs were fifty nodes for one swing.
        for (let i = 0; i < 4; i++) {
          const at = 0.03 + i * 0.045 + Math.random() * 0.02;
          this.metal(p, (2100 + Math.random() * 1500) * k, 0.09, 0.13, at, undefined, 2);
        }
        return 0.3;
      }

      case 'bat_crack': {
        this.snap(p, 2000 * k, 0.7, 0.016);
        // Ash: two modes of a wooden bar, the upper one gone almost at once.
        // The old recipe fed a 215Hz triangle into a resonator tuned an octave
        // above it and got silence, which left "bat_crack" as a bare tick.
        const wood = this.ring(p, 470 * k, 0.11, 0.6, 0, undefined, 'triangle');
        wood.frequency.exponentialRampToValueAtTime(400 * k, t + 0.08);
        this.ring(p, 1270 * k, 0.045, 0.3);
        this.noiseHit(p, 'bandpass', 900 * k, 700 * k, 4, 0.6, 0.001, 0.05);
        // And what it hit.
        const dist = this.crunch(p, 4, 0.55);
        this.noiseHit(p, 'lowpass', 900 * k, 300 * k, 0.9, 0.6, 0.002, 0.1, 0.002, dist);
        this.thump(p, 120 * k, 55 * k, 0.15, 0.6, 'sine', 0.002, dist);
        return 0.22;
      }

      case 'gunshot': {
        // The crack is the part that is clean; everything else is driven.
        this.snap(p, 2800 * k, 0.45, 0.012);
        const dist = this.crunch(p, 12, 0.85);
        this.noiseHit(p, 'lowpass', 5200 * k, 420 * k, 0.9, 0.9, 0.0008, 0.22, BODY_LAG, dist);
        this.thump(p, 220 * k, 44 * k, 0.13, 0.85, 'sine', BODY_LAG, dist);
        // The bark of the barrel: the band a small speaker can give you.
        this.noiseHit(p, 'bandpass', 1300 * k, 700 * k, 1.5, 0.36, 0.001, 0.07);
        // The report rolling off the buildings.
        this.noiseHit(p, 'lowpass', 1500, 500, 0.7, 0.2, 0.02, 0.42, 0.03);
        return 0.52;
      }

      case 'taser': {
        // An arc is a pulse train, and a slow sawtooth through a highpass IS
        // one: every reset of the ramp is a click. One oscillator replaces the
        // six separate ticks this used to schedule, and it can be pitched.
        const dist = p.drive(5);
        // A lid, because a pulse train through a drive is all top and a
        // taser held on somebody for half a second should not be a dentist.
        const lid = p.filter('lowpass', 5200, 0.7);
        const body = p.gain();
        dist.connect(lid);
        lid.connect(body);
        body.connect(p.out);
        p.hold(body, 0.4, 0.006, 0.3, 0.12);

        const arc = p.osc('sawtooth', 23 * k);
        p.lfo(arc.frequency, 7, 3 * k);
        const arcHp = p.filter('highpass', 1200, 0.7);
        const arcGain = p.gain(0.8);
        arc.connect(arcHp);
        arcHp.connect(arcGain);
        arcGain.connect(dist);

        // The buzz between the arcs, and the sizzle on top of it, both gated
        // by one square at the arc rate: bzzt, tick, nothing, bzzt.
        const gate = p.osc('square', 23 * k);
        const buzz = p.osc('sawtooth', 96 * k);
        const buzzHp = p.filter('highpass', 900, 0.7);
        const chop = p.gain(0.5);
        const chopDepth = p.gain(0.5);
        gate.connect(chopDepth);
        chopDepth.connect(chop.gain);
        buzz.connect(buzzHp);
        buzzHp.connect(chop);
        chop.connect(dist);

        const air = p.noise(1);
        const airHp = p.filter('highpass', 3200, 0.7);
        const sizzle = p.gain(0.05);
        const sizzleDepth = p.gain(0.05);
        gate.connect(sizzleDepth);
        sizzleDepth.connect(sizzle.gain);
        air.connect(airHp);
        airHp.connect(sizzle);
        sizzle.connect(dist);
        return 0.46;
      }

      // ── World ──────────────────────────────────────────────────────────────

      case 'explosion': {
        // The report, clean, ahead of the drive.
        this.snap(p, 1200 * k, 0.4, 0.03);
        const dist = this.crunch(p, 7, 0.9);
        this.noiseHit(p, 'lowpass', 4200 * k, 90, 0.8, 0.9, 0.006, 1.05, 0, dist);
        this.thump(p, 86 * k, 24, 0.9, 0.9, 'sine', 0, dist, 1);
        // The punch in the chest: a mid body that is over in a tenth of a
        // second. Without it an explosion is a long noise that starts loud.
        this.thump(p, 190 * k, 52 * k, 0.16, 0.7, 'sine', 0, dist, 0.3);
        const crack = this.noiseHit(p, 'highpass', 2600, 1200, 0.8, 0.3, 0.004, 0.5, 0.01);
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
        this.noiseHit(p, 'bandpass', 1800, 500, 2, 0.2, 0.02, 0.5);
        this.metal(p, 320, 0.4, 0.36, 0.55);
        this.thump(p, 120, 40, 0.25, 0.5, 'sine', 0.55);
        return 1.0;
      }

      case 'glass': {
        this.snap(p, 4200, 0.6, 0.07);
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
        // The thud under the bloop. It was a band of noise too narrow and too
        // low to be heard at all; half the fatality library plays this cue.
        this.noiseHit(p, 'lowpass', 700 * k, 240 * k, 0.8, 0.3, 0.003, 0.1);
        return 0.19;
      }

      // ── Movement ───────────────────────────────────────────────────────────

      case 'jump': {
        // A push off the floor and the air after it. The fighter's own voice
        // supplies the "hup"; a rising tone under that was two boings.
        this.noiseHit(p, 'lowpass', 800 * k, 260 * k, 0.9, 0.45, 0.002, 0.05);
        this.whoosh(p, 420 * k, 1900 * k, 1100 * k, 2, 0.4, 0.07, 0.07);
        return 0.16;
      }

      case 'land': {
        if (k <= SLAM_BELOW) return this.slam(p, aliasPitch(k, SLAM_ALIAS_PITCH));
        // Sole, grit, floor. The first two are what a laptop plays.
        this.noiseHit(p, 'lowpass', 1500 * k, 380 * k, 0.9, 0.45, 0.002, 0.07);
        this.noiseHit(p, 'bandpass', 2300 * k, 1500 * k, 1.2, 0.16, 0.003, 0.035);
        this.thump(p, 150 * k, 56 * k, 0.14, 0.55);
        return 0.18;
      }

      case 'dash': {
        this.whoosh(p, 520 * k, 2700 * k, 900 * k, 3, 0.34, 0.03, 0.14);
        // The foot that launched it.
        this.noiseHit(p, 'lowpass', 900 * k, 300 * k, 0.9, 0.3, 0.002, 0.05);
        this.thump(p, 180 * k, 90 * k, 0.05, 0.25);
        return 0.2;
      }

      // ── Supers ─────────────────────────────────────────────────────────────

      case 'super_charge': {
        // A spark, so it speaks on the frame it is asked for: one caller fires
        // this six frames before the blast, and a pure swell had not started.
        this.blip(p, 'sawtooth', 1400 * k, 2600 * k, 0.16, 0.05);
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
          // Peaks later than it did. A charge that tops out half way and
          // fades through its own climax is not charging anything.
          p.env(g, 0.22, 0.62, 0.55);
        }
        const shimmer = this.noiseHit(p, 'highpass', 900, 7000, 1.4, 0.36, 0.9, 0.35);
        p.lfo(shimmer.frequency, 14, 1200);
        this.thump(p, 40, 90, 1.0, 0.4, 'sine', 0, undefined, 1);
        return 1.35;
      }

      case 'super_blast': {
        this.snap(p, 1500, 0.45, 0.03);
        const dist = this.crunch(p, 14, 0.9);
        this.noiseHit(p, 'lowpass', 6000, 120, 0.8, 0.9, 0.004, 1.2, 0, dist);
        this.thump(p, 110 * k, 26, 1.1, 1.0, 'sine', 0, dist, 1);
        this.thump(p, 220 * k, 60 * k, 0.2, 0.7, 'sine', 0, dist, 0.3);
        for (let i = 0; i < 3; i++) {
          const o = p.osc('sawtooth', 420 * k * (1 - i * 0.06));
          o.detune.setValueAtTime(i * 13 - 13, t);
          o.frequency.exponentialRampToValueAtTime(60 * k, t + 0.8);
          const g = p.gain();
          o.connect(g);
          g.connect(dist);
          p.env(g, 0.3, 0.006, 0.85);
        }
        this.metal(p, 300 * k, 1.1, 0.22, 0.02, undefined, 3);
        return 1.6;
      }

      case 'meter_full': {
        const notes = [880, 1108, 1318];
        for (let i = 0; i < notes.length; i++) {
          this.blip(p, 'square', notes[i] * k, notes[i] * k, 0.24, 0.16, i * 0.07);
        }
        const shimmer = this.noiseHit(p, 'highpass', 3000, 8000, 1.2, 0.24, 0.14, 0.3);
        p.lfo(shimmer.frequency, 9, 1500);
        return 0.55;
      }

      // ── UI ─────────────────────────────────────────────────────────────────

      case 'ui_move': {
        this.blip(p, 'square', 920 * k, 920 * k, 0.22, 0.04);
        this.snap(p, 5000, 0.12, 0.02);
        return 0.07;
      }

      case 'ui_select': {
        this.blip(p, 'triangle', 620 * k, 620 * k, 0.3, 0.05);
        this.blip(p, 'triangle', 1240 * k, 1240 * k, 0.3, 0.12, 0.045);
        this.snap(p, 6000, 0.18, 0.02);
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

      case 'combo_up': {
        // A fifth, upward, in eighty milliseconds: short enough to sit on top
        // of the hit that earned it. Pitch it up a step per milestone.
        this.blip(p, 'triangle', 1318 * k, 1318 * k, 0.24, 0.045);
        this.blip(p, 'triangle', 1976 * k, 1976 * k, 0.26, 0.09, 0.04);
        this.snap(p, 6000, 0.1, 0.012, 0.04);
        return 0.15;
      }

      case 'alert': {
        // A two-tone klaxon for a wave arriving: a horn is a sawtooth through
        // one fat resonance and too much gain, and the falling minor third is
        // every security system ever installed.
        const horn = p.filter('bandpass', 950 * k, 1.6);
        const dist = p.drive(4);
        const amp = p.gain();
        horn.connect(dist);
        dist.connect(amp);
        amp.connect(p.out);
        for (let i = 0; i < 2; i++) {
          const o = p.osc('sawtooth', 392 * k);
          o.detune.setValueAtTime(i * 14 - 7, t);
          o.frequency.setValueAtTime(311 * k, t + 0.17);
          const g = p.gain(0.5);
          o.connect(g);
          g.connect(horn);
        }
        p.hold(amp, 0.28, 0.008, 0.13, 0.03);
        p.hold(amp, 0.28, 0.008, 0.16, 0.09, 0.17);
        return 0.44;
      }

      case 'dizzy': {
        // Stars round the head: two whistles a fifth apart, wobbling out of
        // step with each other and sliding off the note. Then the birds.
        for (let i = 0; i < 2; i++) {
          const f = (i === 0 ? 1320 : 1980) * k;
          const o = p.osc('sine', f);
          o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.5);
          p.lfo(o.frequency, i === 0 ? 9 : 13, f * 0.06);
          const g = p.gain();
          o.connect(g);
          g.connect(p.out);
          p.env(g, i === 0 ? 0.18 : 0.1, 0.03, 0.47);
        }
        for (let i = 0; i < 2; i++) {
          this.blip(p, 'sine', 2600 * k, 3500 * k, 0.12, 0.04, 0.12 + i * 0.16);
        }
        return 0.54;
      }

      // ── Characters ─────────────────────────────────────────────────────────

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
        // "...CHOO!" A band, not a highpass: the spray of a sneeze lives
        // around 3kHz, and everything above 8k was just hiss at full scale.
        const dist = this.crunch(p, 6, 0.9);
        this.noiseHit(p, 'bandpass', 3200, 1100, 0.7, 1.0, 0.004, 0.3, 0.3, dist);
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
        // Inhale: a rattling low buzz. The rattle is its own gain stage in
        // front of the envelope; on the envelope itself it never shut off,
        // and the inhale buzzed on under the whistle until the cue was cut.
        const rasp = p.osc('sawtooth', 68 * k);
        const lp = p.filter('lowpass', 400, 3);
        const rattle = p.gain(0.7);
        const rg = p.gain();
        rasp.connect(lp);
        lp.connect(rattle);
        rattle.connect(rg);
        rg.connect(p.out);
        p.env(rg, 0.55, 0.34, 0.18);
        p.lfo(rattle.gain, 23, 0.3, 'triangle');
        const breath = this.noiseHit(p, 'lowpass', 600, 300, 0.8, 0.2, 0.3, 0.2);
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
        // Five "ha"s falling down a staircase. One mouth for all five: the
        // formants are shared, wider than they were, and driven — as five
        // separate needle-tuned pairs it came out at a fifth of full scale,
        // which is not a laugh, it is somebody smiling in the next room.
        const fa = p.filter('bandpass', 880, 3);
        const fb = p.filter('bandpass', 1520, 4);
        const dist = this.crunch(p, 3, 0.5);
        fa.connect(dist);
        fb.connect(dist);
        // The "h" of each "ha": one band of breath, opened five times.
        const air = p.noise(1);
        const af = p.filter('bandpass', 1500, 1.2);
        const ag = p.gain();
        air.connect(af);
        af.connect(ag);
        ag.connect(p.out);
        const puff = 0.12 * bandMakeup('bandpass', 1500, 1.2, p.nyquist);
        const pitches = [205, 194, 182, 170, 160];
        for (let i = 0; i < pitches.length; i++) {
          const at = i * 0.115;
          const o = p.osc('sawtooth', pitches[i] * k, at);
          o.frequency.exponentialRampToValueAtTime(pitches[i] * k * 0.82, t + at + 0.09);
          const g = p.gain();
          o.connect(g);
          g.connect(fa);
          g.connect(fb);
          p.env(g, 0.8 - i * 0.1, 0.012, 0.085, at);
          p.env(ag, puff, 0.002, 0.03, at);
        }
        return 0.66;
      }

      case 'grunt': {
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
        // Twice what it was: it opens a dozen heavy moves, and at its old level
        // it was thirty decibels down and nobody had ever heard it.
        p.env(g, 0.9, 0.012, 0.19);
        this.noiseHit(p, 'bandpass', 900, 600, 1.5, 0.2, 0.01, 0.16);
        return 0.24;
      }

      // ── Vehicles ───────────────────────────────────────────────────────────

      case 'engine': {
        // A rider re-barks this every 56 frames, so it is built to overlap
        // itself: it holds, and lets go in a straight line, and the next one
        // is already up by the time it has. An exponential decay here was a
        // pluck — vrm... vrm... — where a motor should have been.
        const dist = p.drive(5);
        const lp = p.filter('lowpass', 820 * k, 2);
        const body = p.gain();
        dist.connect(lp);
        lp.connect(body);
        body.connect(p.out);
        p.hold(body, 0.28, 0.05, 0.7, 0.4);
        for (let i = 0; i < 2; i++) {
          // The firing pulse, and a square an octave under it. The half-order
          // is the lope: it is what makes this a twin and not a synth.
          const low = i === 1;
          const f = (low ? 26 : 52) * k;
          const o = p.osc(low ? 'square' : 'sawtooth', f * 0.9);
          o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
          o.frequency.exponentialRampToValueAtTime(f * 0.93, t + 1.0);
          p.lfo(o.frequency, 11 + i * 2, 3 * k);
          const g = p.gain(low ? 0.28 : 0.4);
          o.connect(g);
          g.connect(dist);
        }
        const rumble = this.noiseHit(p, 'lowpass', 340 * k, 220 * k, 0.8, 0.16, 0.08, 0.9);
        p.lfo(rumble.frequency, 13, 90);
        return 1.16;
      }

      case 'engine_rev': {
        // A blip of throttle: up fast, hang, and fall away through the
        // overrun. The filter opens with the revs because an exhaust does.
        const dist = p.drive(6);
        const lp = p.filter('lowpass', 700 * k, 2);
        lp.frequency.exponentialRampToValueAtTime(2400 * k, t + 0.16);
        lp.frequency.exponentialRampToValueAtTime(800 * k, t + 0.6);
        const body = p.gain();
        dist.connect(lp);
        lp.connect(body);
        body.connect(p.out);
        p.hold(body, 0.36, 0.03, 0.2, 0.42);
        for (let i = 0; i < 2; i++) {
          const low = i === 1;
          const m = (low ? 0.5 : 1) * k;
          const o = p.osc(low ? 'square' : 'sawtooth', 62 * m);
          o.frequency.exponentialRampToValueAtTime(196 * m, t + 0.17);
          o.frequency.exponentialRampToValueAtTime(74 * m, t + 0.62);
          const g = p.gain(low ? 0.3 : 0.45);
          o.connect(g);
          g.connect(dist);
        }
        // Intake roar, opening with the throttle.
        this.whoosh(p, 500 * k, 1800 * k, 600 * k, 1.2, 0.16, 0.17, 0.4, 0, dist);
        // Overrun: unburnt fuel popping in the pipe on the way down.
        for (let i = 0; i < 3; i++) {
          const at = 0.34 + i * 0.07 + Math.random() * 0.03;
          this.noiseHit(p, 'lowpass', 1400 * k, 400 * k, 0.9, 0.26, 0.001, 0.03, at);
        }
        return 0.68;
      }

      case 'tyres': {
        // Rubber squeals at a pitch: stick-slip is an oscillator, not a hiss.
        // Two of them a sour interval apart, each wandering on its own. The
        // old recipe was two needle-thin bands of noise and came out thirty
        // decibels under everything around it.
        const body = p.gain();
        body.connect(p.out);
        p.hold(body, 0.6, 0.04, 0.3, 0.32);
        for (let i = 0; i < 2; i++) {
          const hi = i === 1;
          const o = p.osc('sawtooth', (hi ? 1790 : 1180) * k);
          o.frequency.exponentialRampToValueAtTime((hi ? 1500 : 980) * k, t + 0.66);
          p.lfo(o.frequency, hi ? 11 : 7.5, (hi ? 110 : 70) * k);
          const bp = p.filter('bandpass', (hi ? 2600 : 1500) * k, 3);
          const g = p.gain(hi ? 0.3 : 0.6);
          o.connect(bp);
          bp.connect(g);
          g.connect(body);
        }
        // The hiss of the tread, and the carcass scrubbing underneath it.
        const hiss = this.noiseHit(p, 'bandpass', 2800 * k, 2200 * k, 2, 0.14, 0.05, 0.6);
        p.lfo(hiss.frequency, 9, 400);
        this.noiseHit(p, 'lowpass', 420, 200, 0.8, 0.12, 0.05, 0.55);
        return 0.72;
      }

      case 'crash': {
        // A vehicle meeting a body. Sheet metal does not clang when it folds,
        // it creases, so the crunch is a run of narrow bursts over the first
        // few frames rather than one hit.
        this.snap(p, 2200 * k, 0.35, 0.012);
        const dist = this.crunch(p, 8, 0.8);
        this.thump(p, 130 * k, 40 * k, 0.3, 0.9, 'sine', 0, dist, 0.35);
        this.noiseHit(p, 'lowpass', 3400 * k, 420 * k, 0.9, 0.7, 0.001, 0.2, 0, dist);
        // The panel, and the smaller one next to it a frame later.
        this.metal(p, 240 * k, 0.32, 0.24, 0, undefined, 3);
        this.metal(p, 610 * k, 0.16, 0.16, 0.022, undefined, 2);
        for (let i = 0; i < 2; i++) {
          const at = 0.014 + i * 0.034 + Math.random() * 0.014;
          const f = (900 + Math.random() * 1800) * k;
          this.noiseHit(p, 'bandpass', f, 500 * k, 3, 0.3, 0.001, 0.04, at);
        }
        // And the body that was in the way.
        this.noiseHit(p, 'lowpass', 900 * k, 260 * k, 0.9, 0.5, 0.003, 0.13, 0.006, dist);
        return 0.42;
      }

      default: {
        this.blip(p, 'square', 640 * k, 640 * k, 0.22, 0.07);
        return 0.1;
      }
    }
  }
}
