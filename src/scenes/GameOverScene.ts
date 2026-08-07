/**
 * The results screen you get for not finishing the job.
 *
 * Same split as the victory screen: canvas for the mood (rain, a spotlight, the
 * dwarfs face down on the concrete), DOM for the numbers and the way out. The
 * retry path deliberately offers the map you actually died on, because sending
 * somebody back to map one after fifty-three of them is not difficulty, it is
 * contempt.
 */

import type { Scene } from '@/core/types';
import { TOTAL_MAPS, VIEW_H, VIEW_W } from '@/core/constants';
import { clamp, easeOut } from '@/core/math';

import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { poly } from '@/render/Shapes';

import { button, panel } from '@/ui/Widgets';
import type { Ui } from '@/ui/Ui';
import { MenuInput } from '@/ui/MenuInput';

import type { FightResult, SceneHost } from '@/scenes/FightScene';
import {
  div,
  narrow,
  nav,
  overlayFor,
  quitToMenu,
  statGrid,
  statRow,
} from '@/scenes/PauseScene';
import type { ResultActions } from '@/scenes/VictoryScene';
import { blankResult, castSpots, dwarfStyleFor, formatClock } from '@/scenes/VictoryScene';

type C2D = CanvasRenderingContext2D;

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
}

const DROPS = 120;
const GROUND = 300;

/** One of these is picked per run. All of them are true. */
const EPITAPHS: readonly string[] = [
  'THE MOUNTAIN IS QUIET AGAIN. THAT IS THE WORST PART.',
  'SOMEWHERE, A PRESS RELEASE IS BEING DRAFTED ABOUT THIS.',
  'HE DID NOT EVEN COME DOWN TO WATCH.',
  'THE SECURITY CONTRACTORS GOT A BONUS FOR THIS.',
  'SHE IS STILL IN THERE. GET UP.',
];

export class GameOverScene implements Scene {
  readonly name = 'gameover';

  private readonly host: SceneHost;
  private result: FightResult;
  private actions: ResultActions;

  private ui: Ui | null = null;
  private readonly menu: MenuInput;
  private frame = 0;
  private readonly drops: Drop[] = [];
  private epitaph = EPITAPHS[0];

  constructor(host: SceneHost, result?: FightResult, actions?: ResultActions) {
    this.host = host;
    this.result = result ?? blankResult('gameover');
    this.actions = actions ?? {};
    this.menu = new MenuInput({
      ui: () => this.ui,
      audio: host.audio,
      onBack: () => this.toMenu(),
      onStart: () => this.retry(this.result.mapIndex),
    });
  }

  enter(params?: unknown): void {
    if (params && typeof params === 'object') {
      const p = params as { result?: FightResult; actions?: ResultActions } & Partial<FightResult>;
      if (p.actions) this.actions = p.actions;
      if (p.result) this.result = p.result;
      else if (typeof p.outcome === 'string') this.result = params as FightResult;
    }

    this.frame = 0;
    this.epitaph = EPITAPHS[Math.min(EPITAPHS.length - 1, Math.floor(this.result.mapIndex / 15))];
    this.drops.length = 0;
    for (let i = 0; i < DROPS; i++) {
      this.drops.push({
        x: Math.random() * (VIEW_W + 80) - 40,
        y: Math.random() * VIEW_H,
        len: 6 + Math.random() * 12,
        speed: 6 + Math.random() * 7,
      });
    }

    this.host.audio.music('defeat');
    this.host.loop.timeScale = 1;
    this.host.loop.hitstop = 0;

    this.ui = overlayFor(this.host);
    this.menu.attach();
    this.ui.show(this.view());
  }

  exit(): void {
    this.menu.detach();
    this.ui?.clear();
  }

  onKey(e: KeyboardEvent): void {
    this.menu.onKey(e);
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(_dt: number): void {
    this.frame++;
    for (const d of this.drops) {
      d.y += d.speed;
      d.x += 1.4;
      if (d.y > VIEW_H) {
        d.y = -d.len - Math.random() * 40;
        d.x = Math.random() * (VIEW_W + 80) - 40;
      }
    }
    this.menu.poll();
  }

  render(_alpha: number): void {
    const r = this.host.renderer;
    const ctx = r.ctx;
    r.begin();

    // No text on the canvas: the DOM panel over it carries every word.
    this.sky(ctx);
    this.skyline(ctx);
    this.cast(ctx);
    this.rain(ctx);
    this.vignette(ctx);

    r.end();
  }

  private sky(ctx: C2D): void {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#0a0509');
    g.addColorStop(0.55, '#25060f');
    g.addColorStop(1, '#3a0a14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // A single searchlight sweeping the wreckage.
    const sweep = Math.sin(this.frame * 0.008) * 130;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.1;
    poly(
      ctx,
      [VIEW_W * 0.5 + sweep, 0, VIEW_W * 0.5 + sweep + 120, VIEW_H, VIEW_W * 0.5 + sweep - 120, VIEW_H],
      '#ff6a4a',
      'none',
      0,
    );
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private skyline(ctx: C2D): void {
    // Gigafactory silhouette: rectangles, chimneys, one very smug logo.
    ctx.fillStyle = '#140409';
    for (let i = 0; i < 12; i++) {
      const x = i * 58 - 20;
      const h = 60 + ((i * 37) % 90);
      ctx.fillRect(x, VIEW_H - h - 40, 46, h + 40);
      if (i % 3 === 0) ctx.fillRect(x + 16, VIEW_H - h - 70, 8, 32);
    }
    ctx.fillStyle = ((this.frame / 30) | 0) % 6 === 0 ? '#5a1020' : '#ff2d55';
    ctx.fillRect(292, 118, 46, 4);
    ctx.fillRect(310, 104, 10, 18);

    ctx.fillStyle = '#0b0206';
    ctx.fillRect(0, GROUND + 6, VIEW_W, VIEW_H - GROUND);
  }

  private cast(ctx: C2D): void {
    const picks =
      this.result.players.length > 0 ? this.result.players : [{ slot: 0, dwarfId: 'grumpy' }];
    const clip = CLIPS.knockdown ?? CLIPS.dead ?? CLIPS.idle;
    if (!clip) return;

    const spots = castSpots(picks.length);
    for (let i = 0; i < picks.length; i++) {
      const spot = spots[i];
      const d = dwarfStyleFor(picks[i].dwarfId);
      const style = { ...d.style, outfit: 1 };
      const inT = clamp((this.frame - 6 - i * 7) / 30, 0, 1);
      if (inT <= 0) continue;
      // Sampled past the end of the clip: they are down, not going down.
      const pose = sampleClip(clip, clip.duration + 30);

      ctx.save();
      ctx.globalAlpha = easeOut(inT) * 0.95;
      drawCharacter(ctx, style, pose, DWARF_SKELETON, spot.x, GROUND + 6, spot.face, {
        scale: spot.scale * 0.92,
        // Cold and bloodless, but still readable — black leather in a vignette
        // on a red night is one dimming too many.
        tint: '#c096a4',
      });
      ctx.restore();
    }
  }

  private rain(ctx: C2D): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(190,200,225,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.drops) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2.2, d.y + d.len);
    }
    ctx.stroke();
    ctx.restore();
  }

  private vignette(ctx: C2D): void {
    const g = ctx.createRadialGradient(
      VIEW_W * 0.5,
      VIEW_H * 0.5,
      110,
      VIEW_W * 0.5,
      VIEW_H * 0.5,
      VIEW_W * 0.72,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private view(): HTMLElement {
    const r = this.result;

    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = 'Game over';

    const blurb = document.createElement('p');
    blurb.className = 'hint';
    blurb.textContent = r.desynced
      ? 'The two games drifted apart before the end, so none of the numbers below are trustworthy. ' +
        'Open a fresh room and go again.'
      : this.epitaph;

    const stats = statGrid([
      statRow('Score', r.score.toLocaleString('en-GB'), r.newRecord),
      statRow('Reached', `${r.mapIndex}/${TOTAL_MAPS} · ${r.mapName}`),
      statRow('Maps cleared', `${r.mapsCleared}`),
      statRow('Best combo', `${r.bestCombo} hits`),
      statRow('Blows landed', `${r.totalHits}`),
      statRow('Put on the floor', `${r.enemiesFelled}`),
      statRow('Time', formatClock(r.frames)),
      statRow('Continues', `${r.continues}`),
    ]);

    const roster = div('row');
    for (const p of r.players) {
      const d = dwarfStyleFor(p.dwarfId);
      const el = document.createElement('span');
      el.className = 'chip chip--bad';
      el.textContent = `P${p.slot + 1} · ${d.name}`;
      roster.appendChild(el);
    }

    const body: HTMLElement[] = [roster, stats];
    if (r.newRecord) {
      const note = div('notice notice--warn');
      note.textContent = 'Personal best, for whatever that is worth right now.';
      body.push(note);
    }

    const buttons = div('row');
    buttons.appendChild(
      button(`Back to map ${r.mapIndex}`, () => this.retry(r.mapIndex), {
        variant: 'filled',
        autofocus: true,
        icon: '↻',
      }),
    );
    if (r.mapIndex > 1) {
      buttons.appendChild(
        button('Start over', () => this.retry(1), { variant: 'tonal', icon: '⏮' }),
      );
    }
    buttons.appendChild(button('Back to menu', () => this.toMenu(), { variant: 'text' }));

    const stack = div('stack');
    stack.appendChild(title);
    stack.appendChild(blurb);
    stack.appendChild(panel('Results', ...body));
    stack.appendChild(buttons);
    return narrow(stack);
  }

  private retry(mapIndex: number): void {
    this.host.audio.play('ui_select');
    this.ui?.clear();
    const target = clamp(Math.round(mapIndex), 1, TOTAL_MAPS);
    if (this.actions.retry) {
      this.actions.retry(target);
      return;
    }
    if (nav.goto(this.host, 'fight', { players: this.result.players, mapIndex: target })) return;
    quitToMenu(this.host);
  }

  private toMenu(): void {
    this.host.audio.play('ui_back');
    this.ui?.clear();
    if (this.actions.menu) {
      this.actions.menu();
      return;
    }
    quitToMenu(this.host);
  }
}
