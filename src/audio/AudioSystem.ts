/**
 * The game's AudioBus: owns the synth and the procedural soundtrack, applies
 * the player's volume settings and can be muted wholesale (rollback
 * re-simulation, or a player who wants to fight in silence).
 */

import { Music } from '@/audio/Music';
import { Synth } from '@/audio/Synth';
import { clamp } from '@/core/math';
import type { AudioBus, MusicMood, SfxCue, Settings, VoiceProfile } from '@/core/types';

function vol(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 1;
}

export class AudioSystem implements AudioBus {
  muted = false;

  private settings: Settings;
  private synth = new Synth();
  private deck: Music | null = null;
  /** Mood the game has asked for. */
  private wanted: MusicMood | null = null;
  /** Mood the sequencer is actually running. */
  private live: MusicMood | null = null;
  private appliedMaster = -1;
  private appliedSfx = -1;
  private appliedMusic = -1;
  private gesture: (() => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.installGesture();
  }

  /** Call from a user gesture. Also wired to the first click/key automatically. */
  unlock(): void {
    this.synth.unlock();
    // resume() is async: keep the fallback listeners until it really took.
    if (this.synth.ready) this.removeGesture();
    this.ensureDeck();
    this.applyVolumes(true);
    this.syncMusic();
  }

  play(cue: SfxCue, opts?: { pitch?: number; gain?: number; pan?: number }): void {
    if (this.muted) return;
    this.synth.play(cue, opts);
  }

  voice(profile: VoiceProfile, kind: 'hit' | 'attack' | 'ko' | 'taunt' | 'jump'): void {
    if (this.muted) return;
    this.synth.voice(profile, kind);
  }

  music(mood: MusicMood): void {
    if (this.wanted === mood) return;
    this.wanted = mood;
    this.syncMusic();
  }

  /** Once per render frame: keep volumes honest and feed the sequencer. */
  update(): void {
    if (this.synth.ready) this.removeGesture();
    else if (!this.gesture) this.installGesture();
    this.ensureDeck();
    this.applyVolumes(false);
    this.syncMusic();
    this.deck?.update();
  }

  private syncMusic(): void {
    const deck = this.deck;
    if (!deck || this.wanted === null || this.live === this.wanted) return;
    deck.play(this.wanted);
    this.live = this.wanted;
  }

  private ensureDeck(): Music | null {
    if (this.deck) return this.deck;
    const ctx = this.synth.context;
    const master = this.synth.master;
    if (!ctx || !master) return null;
    this.deck = new Music(ctx, master);
    this.appliedMusic = -1;
    return this.deck;
  }

  private applyVolumes(force: boolean): void {
    const s = this.settings;
    const master = this.muted ? 0 : vol(s.masterVolume);
    const sfx = vol(s.sfxVolume);
    const music = this.muted ? 0 : vol(s.musicVolume);

    if (force || master !== this.appliedMaster || sfx !== this.appliedSfx) {
      this.appliedMaster = master;
      this.appliedSfx = sfx;
      this.synth.setVolume(master, sfx);
    }
    if (this.deck && (force || music !== this.appliedMusic)) {
      this.appliedMusic = music;
      this.deck.setVolume(music);
    }
  }

  private installGesture(): void {
    if (typeof window === 'undefined') return;
    const h = (): void => this.unlock();
    this.gesture = h;
    window.addEventListener('pointerdown', h, { passive: true });
    window.addEventListener('keydown', h);
    window.addEventListener('touchend', h, { passive: true });
  }

  private removeGesture(): void {
    const h = this.gesture;
    if (!h) return;
    this.gesture = null;
    window.removeEventListener('pointerdown', h);
    window.removeEventListener('keydown', h);
    window.removeEventListener('touchend', h);
  }
}
