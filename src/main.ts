/**
 * Entry point.
 *
 * Finds the canvas and the DOM overlay, installs the shared keyboard listener,
 * builds the Game, honours a `#join=` invite link if the player arrived through
 * one, and starts the loop.
 *
 * Everything is wrapped: a game that fails to boot should say so on the screen
 * it failed to draw, in the same voice as the rest of it. A black rectangle and
 * a console nobody opens is how you lose a player forever.
 */

import './ui/styles.css';

import { VIEW_H, VIEW_W } from '@/core/constants';
import { Game } from '@/Game';
import { initKeyboardLayout } from '@/engine/input/Layout';
import { installKeyboard } from '@/engine/input/KeyboardSource';
import { roomIdFromUrl } from '@/net/Room';
import { installServiceWorker } from '@/pwa/sw-client';
import { showUpdatePrompt } from '@/pwa/UpdatePrompt';

const CRASH_TITLE = 'THE MOUNTAIN COLLAPSED';
const CRASH_HINT = 'Reload the page. If it keeps happening, blame the billionaire.';

function boot(): void {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('No <canvas id="game"> on the page. There is nothing to fight on.');
  }

  const uiRoot = document.getElementById('ui');
  if (!(uiRoot instanceof HTMLElement)) {
    throw new Error('No <div id="ui"> on the page. The menus have nowhere to live.');
  }

  // One listener pair for every KeyboardSource the game will ever make.
  installKeyboard();

  // Ask the browser what is actually engraved on this keyboard. Deliberately
  // NOT awaited: bindings are by physical key position and already correct on
  // every layout, so this only decides whether the menus print W or Z. It lands
  // when it lands, and everything that shows a key name repaints itself then.
  void initKeyboardLayout();

  const game = new Game(canvas, uiRoot);
  game.onFatal = (err) => crash(err, canvas, uiRoot);

  // A guest who opened an invite link goes straight to the lobby with the room
  // id already in hand — clicking the link IS the join.
  const room = roomIdFromUrl();
  if (room) {
    game.pendingJoin = room;
    game.changeScene('lobby', { join: room, roomId: room, autoJoin: true });
  } else {
    game.changeScene('home');
  }

  game.start();

  // After start(), never before: registering a worker is not worth a frame of
  // the first fight, and a failure in it must not be able to stop the game
  // booting. Everything inside is guarded and PROD-only.
  installServiceWorker({
    onUpdateReady: (update) => showUpdatePrompt(() => update.apply()),
  });

  // A handle for the console. Handy when tuning, harmless when not.
  (window as unknown as { mountainFighters?: Game }).mountainFighters = game;
}

// ── Crash screen ─────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Unknown error.';
  if (typeof err === 'string' && err) return err;
  try {
    return JSON.stringify(err) ?? 'Unknown error.';
  } catch {
    return 'Unknown error.';
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
    if (lines.length > 12) break;
  }
  return lines.slice(0, 12);
}

function crash(err: unknown, canvas: HTMLCanvasElement | null, uiRoot: HTMLElement | null): void {
  console.error('[mountainfighters] boot failed:', err);
  const message = describe(err);

  // The DOM overlay would otherwise sit on top of the apology.
  if (uiRoot) {
    while (uiRoot.firstChild) uiRoot.removeChild(uiRoot.firstChild);
    uiRoot.style.display = 'none';
  }

  const ctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !ctx) {
    crashToDom(message);
    return;
  }

  if (canvas.width < 2 || canvas.height < 2) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
  }
  canvas.style.display = 'block';
  canvas.style.margin = 'auto';

  const s = canvas.width / VIEW_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // Hazard stripes across the top, because this is that kind of game.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, 10);
  ctx.clip();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(0, 0, VIEW_W, 10);
  ctx.fillStyle = '#06070a';
  for (let x = -20; x < VIEW_W + 20; x += 20) {
    ctx.beginPath();
    ctx.moveTo(x, 10);
    ctx.lineTo(x + 10, 10);
    ctx.lineTo(x + 20, 0);
    ctx.lineTo(x + 10, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  const margin = 34;
  const maxWidth = VIEW_W - margin * 2;

  ctx.font = '900 30px Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif';
  ctx.fillStyle = '#ff2e6e';
  ctx.fillText(CRASH_TITLE, margin, 74);

  ctx.font = '600 13px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#a2aabb';
  ctx.fillText('The game failed to start. What it managed to say about it:', margin, 100);

  ctx.font = '13px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.fillStyle = '#eceff6';
  let y = 128;
  for (const line of wrap(ctx, message, maxWidth)) {
    ctx.fillText(line, margin, y);
    y += 18;
    if (y > VIEW_H - 60) break;
  }

  ctx.font = '600 13px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#6d768a';
  ctx.fillText(CRASH_HINT, margin, VIEW_H - 30);
}

/** Last resort: no canvas, or no 2D context to draw on. */
function crashToDom(message: string): void {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;gap:12px;' +
    'align-items:center;justify-content:center;padding:32px;text-align:center;' +
    'background:#06070a;color:#eceff6;font:16px ui-sans-serif,system-ui,sans-serif;z-index:9999';

  const title = document.createElement('h1');
  title.textContent = CRASH_TITLE;
  title.style.cssText = 'margin:0;color:#ff2e6e;font:900 32px "Arial Black",Impact,sans-serif';

  const detail = document.createElement('p');
  detail.textContent = message;
  detail.style.cssText = 'margin:0;max-width:60ch;font-family:ui-monospace,Consolas,monospace';

  const hint = document.createElement('p');
  hint.textContent = CRASH_HINT;
  hint.style.cssText = 'margin:0;color:#6d768a';

  box.append(title, detail, hint);
  document.body.appendChild(box);
}

try {
  boot();
} catch (err) {
  const canvas = document.getElementById('game');
  const uiRoot = document.getElementById('ui');
  crash(
    err,
    canvas instanceof HTMLCanvasElement ? canvas : null,
    uiRoot instanceof HTMLElement ? uiRoot : null,
  );
}
