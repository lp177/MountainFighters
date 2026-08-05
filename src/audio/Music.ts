/**
 * Procedural soundtrack. There are no music files: every mood is a step
 * sequencer — bass, lead and a noise-based drum kit — scheduled ahead on the
 * AudioContext clock from the render loop.
 *
 * Mood changes crossfade: the outgoing deck keeps playing its pattern while it
 * fades, so the score never hard-cuts.
 */

import { clamp } from '@/core/math';
import type { MusicMood } from '@/core/types';

/** How far ahead of the audio clock notes are scheduled, in seconds. */
const LOOKAHEAD = 0.12;
/** Crossfade length between moods, in seconds. */
const XFADE = 1.1;
/** If the clock has run away from us by more than this, resync instead of
 *  frantically catching up. Happens when the tab is backgrounded. */
const RESYNC_GAP = 0.25;
const MAX_STEPS_PER_UPDATE = 64;
const MAX_DECKS = 3;
const NOISE_SECONDS = 1;

const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const HARMONIC = [0, 2, 3, 5, 7, 8, 11];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PENTA_MIN = [0, 3, 5, 7, 10];

type Note = number | null;

interface MoodDef {
  bpm: number;
  steps: number;
  /** MIDI note the scale is rooted on. */
  root: number;
  scale: readonly number[];
  gain: number;

  bass: readonly Note[];
  bassWave: OscillatorType;
  bassCut: number;
  bassLen: number;
  bassOct: number;
  bassGain: number;

  lead: readonly Note[];
  leadWave: OscillatorType;
  leadOct: number;
  leadLen: number;
  leadGain: number;
  leadDetune: number;
  leadCut: number;

  kick: string;
  snare: string;
  hat: string;
  open: string;
  drumGain: number;

  /** Delay of every odd 16th, as a fraction of a step. */
  swing: number;
  /** Lead delay time in beats. 0 disables the send. */
  delayBeats: number;
  feedback: number;
  /** Cents of downward drift across one bar — the sound of giving up. */
  sag: number;
  /** Cents of random detune per note. Chaos. */
  jitter: number;
}

const MOODS: Record<MusicMood, MoodDef> = {
  menu: {
    bpm: 84,
    steps: 16,
    root: 33,
    scale: AEOLIAN,
    gain: 0.5,
    bass: [0, null, null, null, null, null, null, null, 5, null, null, null, null, null, 3, null],
    bassWave: 'triangle',
    bassCut: 420,
    bassLen: 6,
    bassOct: 0,
    bassGain: 0.5,
    lead: [null, null, 7, null, null, null, null, null, null, null, 9, null, null, null, null, 11],
    leadWave: 'triangle',
    leadOct: 2,
    leadLen: 3,
    leadGain: 0.2,
    leadDetune: 5,
    leadCut: 2200,
    kick: 'x-------x-------',
    snare: '----------------',
    hat: '--x-----------x-',
    open: '----------------',
    drumGain: 0.5,
    swing: 0.12,
    delayBeats: 0.75,
    feedback: 0.44,
    sag: 0,
    jitter: 0,
  },

  select: {
    bpm: 110,
    steps: 16,
    root: 34,
    scale: DORIAN,
    gain: 0.5,
    bass: [0, null, 0, null, 4, null, 2, null, 0, null, 0, null, 5, null, 4, null],
    bassWave: 'sawtooth',
    bassCut: 620,
    bassLen: 1.6,
    bassOct: 0,
    bassGain: 0.42,
    lead: [7, null, 9, null, null, 7, null, null, 11, null, 9, null, null, 7, null, null],
    leadWave: 'square',
    leadOct: 1,
    leadLen: 1.6,
    leadGain: 0.16,
    leadDetune: 7,
    leadCut: 2800,
    kick: 'x-----x---x-----',
    snare: '----x-------x---',
    hat: '--x---x---x---x-',
    open: '--------------x-',
    drumGain: 0.55,
    swing: 0.16,
    delayBeats: 0.5,
    feedback: 0.32,
    sag: 0,
    jitter: 0,
  },

  fight_low: {
    bpm: 132,
    steps: 16,
    root: 33,
    scale: PENTA_MIN,
    gain: 0.55,
    bass: [0, 0, null, 0, 3, null, 0, null, 0, 0, null, 4, 2, null, 0, null],
    bassWave: 'sawtooth',
    bassCut: 700,
    bassLen: 1.1,
    bassOct: 0,
    bassGain: 0.5,
    lead: [null, null, null, null, 5, null, 4, null, null, null, 3, null, 4, null, null, null],
    leadWave: 'square',
    leadOct: 1,
    leadLen: 1.8,
    leadGain: 0.17,
    leadDetune: 9,
    leadCut: 3000,
    kick: 'x--x--x---x-x---',
    snare: '----x-------x---',
    hat: 'x-x-x-x-x-x-x-x-',
    open: '--------------x-',
    drumGain: 0.6,
    swing: 0,
    delayBeats: 0.375,
    feedback: 0.3,
    sag: 0,
    jitter: 0,
  },

  fight_high: {
    bpm: 158,
    steps: 16,
    root: 33,
    scale: PENTA_MIN,
    gain: 0.55,
    bass: [0, 0, 3, 0, 5, 0, 3, 0, 0, 0, 4, 0, 7, 5, 4, 3],
    bassWave: 'sawtooth',
    bassCut: 820,
    bassLen: 0.95,
    bassOct: 0,
    bassGain: 0.46,
    lead: [7, null, 8, 7, null, 5, null, 7, 10, null, 8, 7, null, 5, 4, null],
    leadWave: 'square',
    leadOct: 1,
    leadLen: 1.1,
    leadGain: 0.16,
    leadDetune: 11,
    leadCut: 3600,
    kick: 'x--x--x-x--x--x-',
    snare: '----x---x---x-x-',
    hat: 'xxxxxxxxxxxxxxxx',
    open: '------------x---',
    drumGain: 0.62,
    swing: 0,
    delayBeats: 0.375,
    feedback: 0.26,
    sag: 0,
    jitter: 2,
  },

  boss: {
    bpm: 146,
    steps: 16,
    root: 31,
    scale: HARMONIC,
    gain: 0.6,
    bass: [0, 0, null, 1, 0, null, 0, null, 6, null, 5, null, 4, null, 0, null],
    bassWave: 'sawtooth',
    bassCut: 760,
    bassLen: 1.05,
    bassOct: 0,
    bassGain: 0.55,
    lead: [null, null, 7, 6, 7, null, null, 9, null, 8, 7, null, 6, null, null, null],
    leadWave: 'sawtooth',
    leadOct: 1,
    leadLen: 1.4,
    leadGain: 0.16,
    leadDetune: 14,
    leadCut: 3200,
    kick: 'x-x---x-x-x---x-',
    snare: '----x-------x---',
    hat: 'x-x-x-x-x-x-x-x-',
    open: '--------------x-',
    drumGain: 0.66,
    swing: 0,
    delayBeats: 0.375,
    feedback: 0.34,
    sag: 0,
    jitter: 3,
  },

  final_boss: {
    bpm: 176,
    steps: 16,
    root: 30,
    scale: PHRYGIAN,
    gain: 0.62,
    bass: [0, 0, 1, 0, 0, 1, 0, 3, 0, 0, 1, 0, 4, 3, 1, 0],
    bassWave: 'sawtooth',
    bassCut: 900,
    bassLen: 0.9,
    bassOct: 0,
    bassGain: 0.55,
    lead: [7, 8, 7, 11, null, 10, 8, 7, 14, 13, 11, 8, 7, null, 1, 0],
    leadWave: 'sawtooth',
    leadOct: 1,
    leadLen: 0.95,
    leadGain: 0.15,
    leadDetune: 19,
    leadCut: 4200,
    kick: 'x-xx--x-x-xx-x--',
    snare: '--x---x---x---x-',
    hat: 'xxxxxxxxxxxxxxxx',
    open: 'x-------x-------',
    drumGain: 0.7,
    swing: 0,
    delayBeats: 0.1875,
    feedback: 0.55,
    sag: 0,
    jitter: 9,
  },

  victory: {
    bpm: 130,
    steps: 16,
    root: 36,
    scale: MAJOR,
    gain: 0.6,
    bass: [0, null, 0, null, 4, null, 4, null, 5, null, 5, null, 4, null, null, null],
    bassWave: 'sawtooth',
    bassCut: 700,
    bassLen: 1.6,
    bassOct: 0,
    bassGain: 0.45,
    lead: [4, null, 4, 4, null, 2, null, 4, 7, null, null, 6, 4, null, null, null],
    leadWave: 'square',
    leadOct: 1,
    leadLen: 1.8,
    leadGain: 0.2,
    leadDetune: 6,
    leadCut: 3400,
    kick: 'x--x--x-x-------',
    snare: '----x-------x--x',
    hat: 'x-x-x-x-x-x-xxx-',
    open: '------------x---',
    drumGain: 0.6,
    swing: 0.1,
    delayBeats: 0.5,
    feedback: 0.36,
    sag: 0,
    jitter: 0,
  },

  defeat: {
    bpm: 64,
    steps: 16,
    root: 29,
    scale: AEOLIAN,
    gain: 0.5,
    bass: [0, null, null, null, null, null, null, null, -2, null, null, null, null, null, null, null],
    bassWave: 'triangle',
    bassCut: 340,
    bassLen: 7,
    bassOct: 0,
    bassGain: 0.5,
    lead: [4, null, null, null, 3, null, null, null, 2, null, null, null, null, null, 1, null],
    leadWave: 'triangle',
    leadOct: 1,
    leadLen: 3.5,
    leadGain: 0.18,
    leadDetune: 4,
    leadCut: 1600,
    kick: 'x---------------',
    snare: '--------x-------',
    hat: '----------------',
    open: '----------------',
    drumGain: 0.4,
    swing: 0.2,
    delayBeats: 0.75,
    feedback: 0.4,
    sag: 70,
    jitter: 0,
  },

  cutscene: {
    bpm: 92,
    steps: 16,
    root: 33,
    scale: AEOLIAN,
    gain: 0.44,
    bass: [0, null, null, null, null, null, null, null, 4, null, null, null, null, null, null, null],
    bassWave: 'triangle',
    bassCut: 380,
    bassLen: 7,
    bassOct: 0,
    bassGain: 0.45,
    lead: [null, null, null, null, 7, null, null, null, null, null, null, null, 9, null, null, null],
    leadWave: 'sine',
    leadOct: 2,
    leadLen: 6,
    leadGain: 0.2,
    leadDetune: 4,
    leadCut: 2000,
    kick: 'x---------------',
    snare: '----------------',
    hat: '------x---------',
    open: '----------------',
    drumGain: 0.35,
    swing: 0,
    delayBeats: 0.75,
    feedback: 0.46,
    sag: 0,
    jitter: 0,
  },
};

interface Deck {
  mood: MusicMood;
  def: MoodDef;
  gain: GainNode;
  dry: GainNode;
  drums: GainNode;
  delay: DelayNode;
  wet: GainNode;
  fb: GainNode;
  step: number;
  /** Context time of the next step, before swing. */
  nextTime: number;
  /** Context time at which this deck is finished and can be torn down. */
  expires: number;
}

function noteHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function degreeHz(def: MoodDef, degree: number, octaveOffset: number): number {
  const len = def.scale.length;
  const i = ((degree % len) + len) % len;
  const oct = Math.floor(degree / len) + octaveOffset;
  return noteHz(def.root + def.scale[i] + 12 * oct);
}

export class Music {
  private ctx: AudioContext;
  private bus: GainNode;
  private noiseBuf: AudioBuffer;
  private decks: Deck[] = [];
  private mood: MusicMood | null = null;
  private volume = 0.6;

  constructor(ctx: AudioContext, out: GainNode) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this.volume;
    this.bus.connect(out);

    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  play(mood: MusicMood): void {
    if (this.mood === mood) return;
    this.mood = mood;
    const now = this.ctx.currentTime;

    for (const d of this.decks) this.retire(d, now, XFADE);
    // Rapid mood ping-pong must not stack decks forever.
    while (this.decks.length >= MAX_DECKS) {
      const oldest = this.decks.shift();
      if (oldest) this.dispose(oldest);
    }

    const deck = this.makeDeck(mood, now);
    deck.gain.gain.setValueAtTime(0.0001, now);
    deck.gain.gain.linearRampToValueAtTime(deck.def.gain, now + XFADE * 0.8);
    this.decks.push(deck);
  }

  stop(): void {
    const now = this.ctx.currentTime;
    this.mood = null;
    for (const d of this.decks) this.retire(d, now, 0.6);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.bus.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
  }

  /** Called every render frame. Schedules the next LOOKAHEAD of music. */
  update(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;

    for (let i = this.decks.length - 1; i >= 0; i--) {
      const deck = this.decks[i];
      if (now >= deck.expires) {
        this.dispose(deck);
        this.decks.splice(i, 1);
        continue;
      }

      const stepDur = 60 / deck.def.bpm / 4;
      // Backgrounded tabs freeze rAF while the audio clock keeps running.
      // Snap back to the top of a bar instead of dumping a burst of late notes.
      if (deck.nextTime < now - RESYNC_GAP) {
        deck.nextTime = now + 0.04;
        deck.step = 0;
      }

      let guard = 0;
      while (deck.nextTime < now + LOOKAHEAD && guard++ < MAX_STEPS_PER_UPDATE) {
        const swung = deck.step % 2 === 1 ? deck.def.swing * stepDur : 0;
        this.scheduleStep(deck, deck.step, Math.max(deck.nextTime + swung, now + 0.005));
        deck.nextTime += stepDur;
        deck.step = (deck.step + 1) % deck.def.steps;
      }
    }
  }

  // ── Decks ──────────────────────────────────────────────────────────────────

  private makeDeck(mood: MusicMood, now: number): Deck {
    const ctx = this.ctx;
    const def = MOODS[mood];

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.bus);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(gain);

    const drums = ctx.createGain();
    drums.gain.value = def.drumGain;
    drums.connect(gain);

    const delay = ctx.createDelay(2);
    delay.delayTime.value = Math.min(def.delayBeats * (60 / def.bpm), 1.9);
    const fb = ctx.createGain();
    fb.gain.value = def.feedback;
    const wet = ctx.createGain();
    wet.gain.value = def.delayBeats > 0 ? 0.42 : 0;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2400;
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(gain);

    return {
      mood,
      def,
      gain,
      dry,
      drums,
      delay,
      wet,
      fb,
      step: 0,
      nextTime: now + 0.06,
      expires: Infinity,
    };
  }

  private retire(deck: Deck, now: number, fade: number): void {
    const g = deck.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.exponentialRampToValueAtTime(0.0001, now + fade);
    // It keeps sequencing while it fades — that is what makes it a crossfade.
    deck.expires = now + fade + 0.2;
  }

  private dispose(deck: Deck): void {
    try {
      deck.fb.disconnect();
      deck.delay.disconnect();
      deck.wet.disconnect();
      deck.dry.disconnect();
      deck.drums.disconnect();
      deck.gain.disconnect();
    } catch {
      /* already detached */
    }
  }

  // ── Sequencing ─────────────────────────────────────────────────────────────

  private scheduleStep(deck: Deck, step: number, t: number): void {
    const def = deck.def;
    const stepDur = 60 / def.bpm / 4;
    const drift = -def.sag * (step / def.steps);
    const jitter = def.jitter > 0 ? (Math.random() * 2 - 1) * def.jitter : 0;

    if (def.kick[step] === 'x') this.kick(deck, t);
    if (def.snare[step] === 'x') this.snare(deck, t);
    if (def.open[step] === 'x') this.hat(deck, t, true);
    else if (def.hat[step] === 'x') this.hat(deck, t, false);

    const b = def.bass[step];
    if (typeof b === 'number') {
      this.bass(deck, t, degreeHz(def, b, def.bassOct), stepDur * def.bassLen, drift + jitter);
    }

    const l = def.lead[step];
    if (typeof l === 'number') {
      this.lead(deck, t, degreeHz(def, l, def.leadOct), stepDur * def.leadLen, drift + jitter);
    }
  }

  private noiseSource(t: number, dur: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * Math.max(NOISE_SECONDS - dur - 0.02, 0.01));
    s.stop(t + dur + 0.02);
    return s;
  }

  private kick(deck: Deck, t: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.95, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g);
    g.connect(deck.drums);
    o.start(t);
    o.stop(t + 0.28);

    const n = this.noiseSource(t, 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(deck.drums);
  }

  private snare(deck: Deck, t: number): void {
    const ctx = this.ctx;
    const n = this.noiseSource(t, 0.18);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1900, t);
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(bp);
    bp.connect(g);
    g.connect(deck.drums);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(195, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.3, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og);
    og.connect(deck.drums);
    o.start(t);
    o.stop(t + 0.12);
  }

  private hat(deck: Deck, t: number, open: boolean): void {
    const ctx = this.ctx;
    const dur = open ? 0.24 : 0.05;
    const n = this.noiseSource(t, dur, 1.6);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(open ? 6200 : 7600, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(open ? 0.22 : 0.16, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp);
    hp.connect(g);
    g.connect(deck.drums);
  }

  private bass(deck: Deck, t: number, hz: number, dur: number, detune: number): void {
    const ctx = this.ctx;
    const def = deck.def;
    const o = ctx.createOscillator();
    o.type = def.bassWave;
    o.frequency.setValueAtTime(hz, t);
    o.detune.setValueAtTime(detune, t);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(def.bassCut, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(def.bassCut * 0.45, 110), t + dur);
    lp.Q.value = 5;

    const g = ctx.createGain();
    const peak = def.bassGain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.linearRampToValueAtTime(peak * 0.75, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    o.connect(lp);
    lp.connect(g);
    g.connect(deck.dry);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private lead(deck: Deck, t: number, hz: number, dur: number, detune: number): void {
    const ctx = this.ctx;
    const def = deck.def;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(def.leadCut, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(def.leadCut * 0.35, 300), t + dur);
    lp.Q.value = 2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(def.leadGain, t + 0.01);
    g.gain.linearRampToValueAtTime(def.leadGain * 0.6, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    lp.connect(g);
    g.connect(deck.dry);
    if (def.delayBeats > 0) g.connect(deck.delay);

    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = def.leadWave;
      o.frequency.setValueAtTime(hz, t);
      o.detune.setValueAtTime(detune + (i === 0 ? -def.leadDetune : def.leadDetune), t);
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }
}
