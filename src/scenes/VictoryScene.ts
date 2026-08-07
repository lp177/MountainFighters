/**
 * The results screen you get for finishing the job.
 *
 * Canvas does the theatre — a gold sky, the mountain in silhouette, the dwarfs
 * posing in front of it with confetti coming down — and DOM does the numbers,
 * because a table of statistics wants to be selectable text with real focus
 * rings, not something hand-kerned into a 640x360 buffer.
 */

import type { Scene } from '@/core/types';
import { VIEW_H, VIEW_W } from '@/core/constants';
import { clamp, easeOut, easeOutBack, lerp } from '@/core/math';

import { CLIPS, sampleClip } from '@/render/rig/Anim';
import { drawCharacter } from '@/render/rig/CharacterRig';
import { DWARF_SKELETON } from '@/render/rig/Skeleton';
import { poly, star } from '@/render/Shapes';

import { DWARFS } from '@/content/dwarfs';
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

type C2D = CanvasRenderingContext2D;

/** What the fight scene hands the results screens so they can restart a run. */
export interface ResultActions {
  /** Build a fresh run at this map with the same fighters. */
  retry?(mapIndex: number): void;
  /** Back to the front page. */
  menu?(): void;
}

interface Fleck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  size: number;
  color: string;
}

const CONFETTI_COLORS = ['#ffd23f', '#ff2e6e', '#5fc9ff', '#63ff9d', '#ffffff', '#ff8a2a'];
const FLECKS = 90;
const GROUND = 306;

/**
 * Where the cast stands.
 *
 * The results board is a centred DOM panel, so the dwarfs are posted down the
 * two margins either side of it rather than behind it. Two per side, the second
 * pushed inward and slightly smaller so the pair reads as depth.
 */
export function castSpots(n: number): { x: number; face: 1 | -1; scale: number }[] {
  const left = [70, 118];
  const right = [570, 522];
  const out: { x: number; face: 1 | -1; scale: number }[] = [];
  for (let i = 0; i < n; i++) {
    const onLeft = i % 2 === 0;
    const rank = Math.min(1, Math.floor(i / 2));
    out.push({
      x: onLeft ? left[rank] : right[rank],
      face: onLeft ? 1 : -1,
      scale: rank === 0 ? 2.3 : 1.9,
    });
  }
  return out;
}

export function dwarfStyleFor(id: string): (typeof DWARFS)[number] {
  return DWARFS.find((d) => d.id === id) ?? DWARFS[0];
}

export function formatClock(frames: number): string {
  const total = Math.max(0, Math.round(frames / 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Stand-in used when the game builds this scene by name and the real numbers
 * arrive through `enter()` a moment later. It is never displayed.
 */
export function blankResult(outcome: FightResult['outcome']): FightResult {
  return {
    outcome,
    score: 0,
    mapIndex: 1,
    mapName: '',
    mapsCleared: 0,
    bestCombo: 0,
    totalHits: 0,
    enemiesFelled: 0,
    frames: 0,
    continues: 0,
    players: [],
    newRecord: false,
  };
}

export class VictoryScene implements Scene {
  readonly name = 'victory';

  private readonly host: SceneHost;
  private result: FightResult;
  private actions: ResultActions;

  private ui: Ui | null = null;
  private readonly menu: MenuInput;
  private frame = 0;
  private readonly flecks: Fleck[] = [];

  constructor(host: SceneHost, result?: FightResult, actions?: ResultActions) {
    this.host = host;
    this.result = result ?? blankResult('victory');
    this.actions = actions ?? {};
    this.menu = new MenuInput({
      ui: () => this.ui,
      audio: host.audio,
      onBack: () => this.toMenu(),
      onStart: () => this.again(),
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
    this.flecks.length = 0;
    for (let i = 0; i < FLECKS; i++) this.flecks.push(this.makeFleck(true));

    this.host.audio.music('victory');
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
    for (const f of this.flecks) {
      f.x += f.vx;
      f.y += f.vy;
      f.vy = Math.min(2.2, f.vy + 0.012);
      f.rot += f.spin;
      if (f.y > VIEW_H + 8) Object.assign(f, this.makeFleck(false));
    }
    this.menu.poll();
  }

  private makeFleck(scatter: boolean): Fleck {
    // Presentation only — no sim reads any of this, so the wall-clock RNG is fine.
    return {
      x: Math.random() * VIEW_W,
      y: scatter ? Math.random() * VIEW_H : -10 - Math.random() * 40,
      vx: (Math.random() - 0.5) * 0.9,
      vy: 0.5 + Math.random() * 1.1,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.24,
      size: 1.6 + Math.random() * 2.6,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
    };
  }

  render(_alpha: number): void {
    const r = this.host.renderer;
    const ctx = r.ctx;
    r.begin();

    // No text on the canvas: the DOM panel over it carries every word, and two
    // headlines fighting for the same 40 pixels helps nobody.
    this.sky(ctx);
    this.mountain(ctx);
    this.rays(ctx);
    this.cast(ctx);
    this.confetti(ctx);

    r.end();
  }

  private sky(ctx: C2D): void {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#2b1042');
    g.addColorStop(0.5, '#7d2a55');
    g.addColorStop(1, '#f0a33a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    for (let i = 0; i < 40; i++) {
      const x = ((i * 97) % VIEW_W) + Math.sin(this.frame * 0.004 + i) * 3;
      const y = ((i * 53) % 150) * 0.7;
      const a = 0.25 + 0.35 * Math.sin(this.frame * 0.05 + i * 1.7);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffe9c2';
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;
  }

  private mountain(ctx: C2D): void {
    poly(
      ctx,
      [-20, VIEW_H, 120, 150, 200, 214, 300, 96, 420, 208, 500, 156, 660, VIEW_H],
      '#2a1b33',
      '#150d1c',
      2,
    );
    poly(ctx, [268, 128, 300, 96, 332, 128, 300, 116], '#f4ecff', 'none', 0);

    // The cottage, lights back on.
    ctx.fillStyle = '#1c1220';
    ctx.fillRect(470, 250, 44, 30);
    poly(ctx, [464, 250, 492, 228, 520, 250], '#3a2036', '#150d1c', 1.8);
    ctx.fillStyle = ((this.frame / 24) | 0) % 8 === 0 ? '#7a5f2a' : '#ffd23f';
    ctx.fillRect(480, 258, 9, 9);
    ctx.fillRect(496, 258, 9, 9);
  }

  private rays(ctx: C2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const a = 0.05 + 0.04 * Math.sin(this.frame * 0.02 + i);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffd9a0';
      const t = (i / 7) * VIEW_W + Math.sin(this.frame * 0.006 + i) * 24;
      poly(ctx, [t, VIEW_H, t - 40, 0, t + 26, 0, t + 60, VIEW_H], '#ffd9a0', 'none', 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private cast(ctx: C2D): void {
    const picks =
      this.result.players.length > 0 ? this.result.players : [{ slot: 0, dwarfId: 'grumpy' }];
    const clip = CLIPS.victory ?? CLIPS.idle;
    if (!clip) return;

    const spots = castSpots(picks.length);
    // Back rank first so the front pair overlaps it, not the other way round.
    const order = spots.map((_, i) => i).sort((a, b) => spots[b].scale - spots[a].scale).reverse();

    for (const i of order) {
      const spot = spots[i];
      const d = dwarfStyleFor(picks[i].dwarfId);
      const style = { ...d.style, outfit: 1 };
      // Each one arrives a beat after the last, then keeps posing.
      const inT = clamp((this.frame - 8 - i * 9) / 26, 0, 1);
      if (inT <= 0) continue;
      const rise = lerp(70, 0, easeOutBack(inT));
      const pose = sampleClip(clip, this.frame * 0.55 + i * 7);

      ctx.save();
      ctx.globalAlpha = easeOut(inT);
      drawCharacter(ctx, style, pose, DWARF_SKELETON, spot.x, GROUND + rise, spot.face, {
        scale: spot.scale,
      });
      ctx.restore();

      if (inT >= 1 && ((this.frame + i * 11) % 96) < 10) {
        star(ctx, spot.x + spot.face * 22, GROUND - 96, 5, 5, '#ffffff', 'none');
      }
    }
  }

  private confetti(ctx: C2D): void {
    for (const f of this.flecks) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.fillStyle = f.color;
      ctx.fillRect(-f.size * 0.5, -f.size * 0.28, f.size, f.size * 0.56);
      ctx.restore();
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private view(): HTMLElement {
    const r = this.result;

    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = 'She is out';

    const blurb = document.createElement('p');
    blurb.className = 'hint';
    blurb.textContent =
      'Seventy maps, fourteen bodies, one billionaire. The note said "subject acquired for ' +
      'research purposes"; the note was wrong, and so was everything downstream of it.';

    const stats = statGrid([
      statRow('Score', r.score.toLocaleString('en-GB'), true),
      statRow('Best combo', `${r.bestCombo} hits`),
      statRow('Blows landed', `${r.totalHits}`),
      statRow('Put on the floor', `${r.enemiesFelled}`),
      statRow('Time', formatClock(r.frames)),
      statRow('Continues', r.continues === 0 ? 'None. Show-off.' : `${r.continues}`),
    ]);

    const roster = div('row');
    for (const p of r.players) {
      const d = dwarfStyleFor(p.dwarfId);
      const el = document.createElement('span');
      el.className = 'chip chip--live';
      el.textContent = `P${p.slot + 1} · ${d.name}`;
      roster.appendChild(el);
    }

    const body: HTMLElement[] = [roster, stats];
    if (r.newRecord) {
      const note = div('notice');
      note.textContent = 'New high score. It goes in the save file and stays there.';
      body.push(note);
    }

    const buttons = div('row');
    buttons.appendChild(
      button('Run it again', () => this.again(), { variant: 'filled', autofocus: true, icon: '↻' }),
    );
    buttons.appendChild(button('Back to menu', () => this.toMenu(), { variant: 'tonal' }));

    const stack = div('stack');
    stack.appendChild(title);
    stack.appendChild(blurb);
    stack.appendChild(panel('Results', ...body));
    stack.appendChild(buttons);
    return narrow(stack);
  }

  private again(): void {
    this.host.audio.play('ui_select');
    this.ui?.clear();
    if (this.actions.retry) {
      this.actions.retry(1);
      return;
    }
    if (nav.goto(this.host, 'select', { players: this.result.players, mapIndex: 1 })) return;
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
