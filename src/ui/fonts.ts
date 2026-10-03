/**
 * The game's two typefaces, registered by hand.
 *
 * Why ship fonts at all, in a project that ships no images: the old type was a
 * system stack — Arial Black here, Impact there — which is a different game on
 * every machine. Android has neither and fell back to Roboto; a Mac set the HUD
 * in Helvetica Neue. A logo, a health bar and a "FIGHT!" that change shape from
 * one player's screen to the next are the single loudest "this is a prototype"
 * a game can send. Five woff2 files, about 110 KB, end that.
 *
 * Why not the stylesheets the font packages ship: those declare a .woff fallback
 * beside every .woff2, and the service worker precaches everything in the bundle,
 * so every player would download five files no browser this game supports will
 * ever ask for. Registering FontFace objects ships exactly the faces used.
 *
 * Why it matters that this is a promise: most of the game is CANVAS text, and a
 * canvas does not reflow when a font arrives — it draws whatever is loaded at the
 * moment it draws. `loadFonts` lets boot hold the first frame until the faces are
 * in (or a short timeout passes), so nobody ever sees the title in Arial first.
 *
 * Licence: Barlow and Barlow Condensed are SIL Open Font License 1.1.
 */

import displaySemibold from '@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2?url';
import displayBold from '@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2?url';
import displayBlackItalic from '@fontsource/barlow-condensed/files/barlow-condensed-latin-900-italic.woff2?url';
import textMedium from '@fontsource/barlow/files/barlow-latin-500-normal.woff2?url';
import textBold from '@fontsource/barlow/files/barlow-latin-700-normal.woff2?url';

interface Face {
  family: string;
  url: string;
  weight: string;
  style: 'normal' | 'italic';
}

const FACES: readonly Face[] = [
  { family: 'Barlow Condensed', url: displaySemibold, weight: '600', style: 'normal' },
  { family: 'Barlow Condensed', url: displayBold, weight: '800', style: 'normal' },
  { family: 'Barlow Condensed', url: displayBlackItalic, weight: '900', style: 'italic' },
  { family: 'Barlow', url: textMedium, weight: '500', style: 'normal' },
  { family: 'Barlow', url: textBold, weight: '700', style: 'normal' },
];

let pending: Promise<void> | null = null;

/**
 * Register and fetch every face. Resolves when they are all in, or after
 * `timeoutMs`, whichever is first — a font server that never answers must not be
 * able to keep the game off the screen. Never rejects.
 */
export function loadFonts(timeoutMs = 1500): Promise<void> {
  if (!pending) pending = register();
  return Promise.race([
    pending,
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
  ]);
}

async function register(): Promise<void> {
  if (typeof FontFace !== 'function' || !document.fonts) return;
  const loads: Promise<unknown>[] = [];
  for (const f of FACES) {
    try {
      const face = new FontFace(f.family, `url(${f.url}) format('woff2')`, {
        weight: f.weight,
        style: f.style,
        display: 'swap',
      });
      document.fonts.add(face);
      loads.push(face.load().catch(() => undefined));
    } catch {
      /* A face that cannot be built falls back to the stack in theme.ts. */
    }
  }
  await Promise.all(loads);
}
