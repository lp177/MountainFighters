/**
 * "Who is still reading this."
 *
 * A row of little dwarf busts in the corner of a cinematic, one per player.
 * Grey means they are still watching; their own colour means they are done and
 * waiting on everybody else. When the last one lights up, the film ends and the
 * fight starts.
 *
 * It exists because a cinematic in co-op is the one place where two people are
 * deliberately out of step, and without this the player who skipped first is
 * looking at a still frame with no idea whether the game has hung, their friend
 * has wandered off, or they are simply a slower reader. One glance answers it.
 *
 * Drawn, like everything else here, rather than shipped: a hat, a face, a beard
 * and a pair of sunglasses at eleven pixels tall.
 */

import { clamp } from '@/core/math';

type C2D = CanvasRenderingContext2D;

export interface ReadyMark {
  /** The player's colour, used once they are done. */
  color: string;
  /** True when this player has finished or skipped. */
  ready: boolean;
  /** Shown under the mark. Kept to a couple of characters. */
  label?: string;
}

const GREY = '#3a4152';
const GREY_DARK = '#242a37';
const INK = '#06070a';

/**
 * Bottom-right of the stage, right-aligned, growing leftwards so the newest
 * player never shifts the others.
 */
export function drawReadyMarks(
  ctx: C2D,
  marks: readonly ReadyMark[],
  viewW: number,
  viewH: number,
  frame: number,
): void {
  if (marks.length === 0) return;

  const u = 11;
  const gap = u * 1.55;
  const right = viewW - 14;
  // Clear of the skip hint, which is centred along the very bottom and long
  // enough to reach the right-hand corner.
  const y = viewH - 36;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const x = right - (marks.length - 1 - i) * gap;
    // The ones still reading breathe, so the row does not look like a static
    // widget that has stopped working.
    const pulse = m.ready ? 0 : Math.sin(frame * 0.08 + i * 1.3) * 0.5 + 0.5;
    ctx.globalAlpha = m.ready ? 1 : 0.45 + pulse * 0.25;
    bust(ctx, x, y, u, m.ready ? m.color : GREY, m.ready);

    if (m.label) {
      ctx.globalAlpha = m.ready ? 0.9 : 0.5;
      ctx.font = `700 6px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = m.ready ? m.color : GREY;
      ctx.fillText(m.label, x, y + 8);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/** One dwarf, from the shoulders up. */
function bust(ctx: C2D, cx: number, baseY: number, u: number, color: string, lit: boolean): void {
  const w = u * 0.82;
  const top = baseY - u;

  // Hat: the cone and its bobble.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + w * 0.62, top + u * 0.46);
  ctx.lineTo(cx - w * 0.62, top + u * 0.46);
  ctx.closePath();
  ctx.fill();

  // Face.
  ctx.fillStyle = lit ? '#f0c9a4' : GREY_DARK;
  ctx.beginPath();
  ctx.ellipse(cx, top + u * 0.62, w * 0.46, u * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();

  // Sunglasses — the whole character, in one bar.
  ctx.fillStyle = INK;
  ctx.fillRect(cx - w * 0.46, top + u * 0.5, w * 0.92, u * 0.16);

  // Beard.
  ctx.fillStyle = lit ? '#eceff6' : GREY;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.42, top + u * 0.72);
  ctx.quadraticCurveTo(cx, top + u * 1.28, cx + w * 0.42, top + u * 0.72);
  ctx.closePath();
  ctx.fill();
}

/** A soft line telling the fast reader what they are waiting for. */
export function readyCaption(done: number, total: number): string {
  const left = clamp(total - done, 0, 99);
  if (left <= 0) return '';
  return left === 1 ? 'WAITING FOR ONE MORE' : `WAITING FOR ${left} OTHERS`;
}
