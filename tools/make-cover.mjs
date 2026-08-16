#!/usr/bin/env node
/**
 * make-cover.mjs — draws the 1200x630 key-art cover (Open Graph / Twitter card)
 * for Mountain Fighters.
 *
 * Run it with:
 *
 *     node tools/make-cover.mjs
 *
 * (works from any cwd — every path is resolved relative to this file).
 *
 * WHAT THIS IS. It is NOT a screenshot of the game. It is a poster: the hero
 * dwarf drawn deliberately for this purpose, the other six ranged behind him,
 * the billionaire alone on a far peak, and the wordmark big enough to survive a
 * Discord thumbnail. The tagline promises SEVEN DWARFS, so the art has to show
 * seven — an earlier cut showed one and argued with its own copy.
 *
 * HOW IT WORKS, end to end:
 *   1. esbuild bundles the game's own art modules — CharacterRig, Skeleton,
 *      Shapes, the dwarf roster — into one ESM file in a scratch dir. The body
 *      of every dwarf here is therefore literally the game's character rig,
 *      posed by hand, so the cover cannot drift away from the in-game look.
 *   2. A throwaway static server serves that scratch dir. ES modules are
 *      blocked on file://, so the page MUST come over HTTP.
 *   3. Headless Chrome opens a page holding a 2400x1260 canvas — a 2x
 *      supersample of the finished card — and `paint()` composes the poster on
 *      it: sky, moon, ridges, the billionaire, the six, the lit hero, the
 *      wordmark. `paint()` pins performance.now() first, because the rig's
 *      breathing oscillator would otherwise make two runs differ.
 *   4. The heads are the point of the exercise. The rig draws a 30px-tall face
 *      because that is all the game ever needs; drawDwarfHead() throws that
 *      away for the hero and drawCrewHead() does the same for the other six —
 *      each with a skull of a different shape, a different nose, a different
 *      pair of eyes, a different beard and a different cap silhouette, because
 *      seven dwarfs that differ only by hat colour are one dwarf seven times.
 *   5. The lighting is done as compositing passes on an offscreen character
 *      layer: a hot-pink key wash and a cold fill via `source-atop`, then two
 *      offset silhouettes underneath for the pink key rim and the cold moon
 *      rim. That is what stops the figures reading as flat vector clip-art.
 *      The six behind get the same treatment plus atmosphere, a depth-of-field
 *      blur and a fade into the drift at the boots, and they are painted
 *      furthest-first so each is occluded by the ones in front and all six by
 *      the hero — overlap is what sells depth, not being drawn smaller.
 *   6. canvas.toDataURL gives the exact 2400x1260 pixels (no page screenshot,
 *      so no scrollbar or devicePixelRatio surprises), and ImageMagick
 *      downsamples to exactly 1200x630 into docs/ and public/.
 *
 * Requirements on this machine:
 *   - Google Chrome at /usr/bin/google-chrome (CHROME_PATH to override).
 *     Playwright's own browsers are NOT installed, so executablePath is always
 *     passed explicitly.
 *   - Playwright is not a dependency of this repo; it lives in
 *     ../Tribble/node_modules and is imported by absolute path, because an ESM
 *     bare specifier would resolve from this script's directory and fail
 *     whatever the cwd is. Override with PLAYWRIGHT_ENTRY=/path/to/index.mjs.
 *   - esbuild from this repo's own node_modules.
 *   - ImageMagick `convert` for the downsample (override with MAGICK=...).
 *   - Fonts: Lato Black, installed system-wide. No network, no CDN.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFile,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'src');
const DOCS = join(ROOT, 'docs');
const PUBLIC = join(ROOT, 'public');

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const MAGICK = process.env.MAGICK ?? '/usr/bin/convert';
const ESBUILD = process.env.ESBUILD ?? join(ROOT, 'node_modules', '.bin', 'esbuild');
const PLAYWRIGHT_ENTRY =
  process.env.PLAYWRIGHT_ENTRY ??
  resolve(ROOT, '..', 'Tribble', 'node_modules', 'playwright', 'index.mjs');

/**
 * HEAD_ONLY=/path/out.png renders a head alone, ~1700px tall, instead of the
 * card — the only way to actually see what a face is doing, since on the
 * finished 1200x630 even the hero's is barely 200px and every feature-collision
 * bug so far has been invisible at that size. Add GUIDES=1 to overlay the
 * anatomical bands: every feature owns one, and any shape crossing out of its
 * own band is a bug.
 *
 *     HEAD_ONLY=/tmp/head.png GUIDES=1 node tools/make-cover.mjs
 *
 * CREW=<id> inspects one of the six behind him instead of the hero, and
 * CREW=all lays all seven out side by side — which is the only way to run the
 * test this cover is actually judged on: swap any two of these heads, and if
 * you would not notice, they are not seven dwarfs.
 *
 *     HEAD_ONLY=/tmp/sneezy.png CREW=sneezy GUIDES=1 node tools/make-cover.mjs
 *     HEAD_ONLY=/tmp/seven.png CREW=all node tools/make-cover.mjs
 */
const HEAD_ONLY = process.env.HEAD_ONLY;

/** Supersample, then the card. 1.905:1 is what every social embed crops to. */
const BIG = { w: 2400, h: 1260 };
const CARD = { w: 1200, h: 630 };

// ─────────────────────────────────────────────────────────────────────────────
// Composition constants. Everything the poster's layout depends on lives here
// so the drawing code below reads as geometry rather than magic numbers.
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  W: BIG.w,
  H: BIG.h,

  /** Hero: which dwarf, how big, where his feet land. */
  hero: 'grumpy',
  heroX: 1522,
  /** His feet are off the bottom of the frame: this is a waist-up hero shot,
   *  and the snow drift painted over him hides where the legs stop. */
  heroY: 1466,
  /** Pixels per rig unit before style.scale. The dwarf is ~46 rig units tall. */
  heroU: 21,
  /** Two head sizes, on purpose. `rigHeadSize` is what the RIG draws — kept
   *  small so its 30px face, ear, hair tufts and hat all sit comfortably inside
   *  the modelled head; `headSize` is what drawDwarfHead() draws over the top.
   *  Decoupling them is what lets the cap have a narrow brim instead of the
   *  1.33-half-width pancake the rig needs to cover its own. */
  rigHeadSize: 0.78,
  headSize: 1.06,

  /**
   * The other six, staged behind the hero.
   *
   * The tagline promises SEVEN DWARFS and the first cut of this cover showed
   * exactly one, so the art argued with its own copy. This array is DRAW ORDER:
   * each one is painted over everybody already down, and all six are painted
   * before the hero, so he cuts into every one of them. Smaller and fainter is
   * not depth on its own — overlap is what sells it.
   *
   * `k` scales the hero's pixels-per-rig-unit, and it is also what drives the
   * haze, the rim and the depth-of-field blur (see drawCrew): size IS distance,
   * so the two can never disagree even where draw order and depth do.
   *
   * `y` is where the BOOTS land, deliberately below the visible snow line: the
   * layer is faded out above it, so the rig's own contact ellipse — a flat
   * fill, and a flat fill has a traceable edge — never reaches the card.
   */
  crew: [
    { id: 'bashful', x: 1046, y: 1030, k: 0.345 },
    { id: 'sneezy', x: 2318, y: 1100, k: 0.33 },
    { id: 'doc', x: 1176, y: 1086, k: 0.375 },
    { id: 'sleepy', x: 2230, y: 1166, k: 0.45 },
    { id: 'dopey', x: 1300, y: 1180, k: 0.46 },
    // Clear of the pickaxe: the haft runs a long diagonal across the whole
    // right of frame and at x < 1950 it crosses this face at eye level.
    { id: 'happy', x: 1994, y: 1252, k: 0.52 },
  ],

  moon: { x: 2128, y: 208, r: 88 },

  /** The billionaire: a small suited figure alone on the far ridge, backlit.
   *  He was a giant floating bust and read as a ghost; a silhouette on a peak
   *  is both more menacing and unmistakably subordinate to the dwarf. */
  boss: { x: 524, h: 408 },

  /** Wordmark block, bottom left. */
  title: { x: 132, top: 902, big: 168, small: 60 },

  tagline: 'SEVEN DWARFS  ·  ONE BILLIONAIRE  ·  ONE VERY BAD IDEA',
};

// ─────────────────────────────────────────────────────────────────────────────
// The poster. Runs inside the page; must be self-contained (Playwright ships
// the function source across, so it closes over nothing but its argument).
// ─────────────────────────────────────────────────────────────────────────────

function paint(cfg) {
  // Pin the clock. The rig reads performance.now() for its breathing
  // oscillator, and the amplitude does not fall to zero when breath does — so
  // two runs of this generator produced cards differing by a couple of hundred
  // pixels around the crew's waists and hands. A poster is a still; freezing
  // the clock is what makes the output byte-reproducible.
  performance.now = () => 0;

  const MF = window.MF;
  const W = cfg.W;
  const H = cfg.H;
  const TAU = Math.PI * 2;

  const P = {
    ink: '#141019',
    pink: '#ff2e6e',
    pinkHot: '#ff5c8d',
    pinkDeep: '#b8004a',
    pinkPale: '#ffe6ee',
    gold: '#ffd23f',
    cold: '#8aa0c8',
    coldPale: '#cfe0ff',
    teal: '#37e6c8',
    dim: '#aab2c4',
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function hash01(n) {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(t, seed) {
    const i = Math.floor(t);
    const f = t - i;
    const s = f * f * (3 - 2 * f);
    return lerp(hash01(i + seed * 7919), hash01(i + 1 + seed * 7919), s);
  }
  /** Ridged fractal noise: sharp peaks, soft valleys. What a skyline is. */
  function ridgeAt(x, seed, scale) {
    let sum = 0;
    let amp = 1;
    let f = scale;
    let norm = 0;
    for (let o = 0; o < 4; o++) {
      const v = vnoise(x * f, seed + o);
      sum += (1 - Math.abs(v * 2 - 1)) * amp;
      norm += amp;
      amp *= 0.48;
      f *= 2.3;
    }
    return sum / norm;
  }

  function rgb(c) {
    return [
      parseInt(c.slice(1, 3), 16),
      parseInt(c.slice(3, 5), 16),
      parseInt(c.slice(5, 7), 16),
    ];
  }
  function hex(r, g, b) {
    const v =
      (clamp(Math.round(r), 0, 255) << 16) |
      (clamp(Math.round(g), 0, 255) << 8) |
      clamp(Math.round(b), 0, 255);
    return `#${v.toString(16).padStart(6, '0')}`;
  }
  /** f<1 darkens, f>1 pushes toward white. */
  function shade(c, f) {
    const [r, g, b] = rgb(c);
    return f <= 1 ? hex(r * f, g * f, b * f) : hex(lerp(r, 255, f - 1), lerp(g, 255, f - 1), lerp(b, 255, f - 1));
  }
  function rgba(c, a) {
    const [r, g, b] = rgb(c);
    return `rgba(${r},${g},${b},${a})`;
  }
  function mix(a, b, t) {
    const [r1, g1, b1] = rgb(a);
    const [r2, g2, b2] = rgb(b);
    return hex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
  }
  /** `r,g,b` for the softBlob primitive, which takes its colour as a triple. */
  const triple = (c) => rgb(c).join(',');

  /**
   * A shadow with no edge, in some head's local X()/Y() units.
   *
   * Every soft form on the hero's face used to be a flat-filled c.ellipse(),
   * and a filled ellipse has a hard boundary — so on a cheek it does not read
   * as shading, it reads as a rounded object sitting on the skin. That is what
   * put a second nose beside the first. Radial falloff to fully transparent
   * fixes it at the source, because there is no contour left to read.
   *
   * It lives out here rather than inside one head so that all seven faces
   * shade the same way and there is exactly one definition to get right.
   */
  function softBlobIn(c, X, Y, cxu, cyu, rxu, ryu, rgbv, a) {
    const bx = X(rxu);
    const by = Y(ryu);
    c.save();
    c.translate(X(cxu), Y(cyu));
    c.scale(1, by / bx);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, bx);
    g.addColorStop(0, `rgba(${rgbv},${a})`);
    g.addColorStop(0.5, `rgba(${rgbv},${a * 0.66})`);
    g.addColorStop(1, `rgba(${rgbv},0)`);
    c.fillStyle = g;
    c.fillRect(-bx, -bx, bx * 2, bx * 2);
    c.restore();
  }

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  function layer() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    return { c, x };
  }

  /**
   * jp / tp / mid for a posed skeleton, in the flipped character-local frame
   * the rig draws in: jp is a joint, tp a point a fraction along a bone.
   *
   * ONE definition. The card, the six behind him and the HEAD_ONLY diagnostic
   * all resolve joints through this — a diagnostic that re-derived its own
   * would prove nothing about the art it is supposed to be inspecting.
   */
  function boneFrame(pose, u) {
    const bones = MF.resolvePose(MF.DWARF_SKELETON, pose, u);
    const LEN = new Map(MF.DWARF_SKELETON.map((b) => [b.name, b.length]));
    return {
      jp: (n) => {
        const b = bones.get(n);
        return { x: b.x, y: -b.y };
      },
      tp: (n, f = 1) => {
        const b = bones.get(n);
        const l = (LEN.get(n) ?? 0) * b.scale * f;
        return { x: b.x - l * Math.sin(b.rot), y: -(b.y + l * Math.cos(b.rot)) };
      },
      mid: (a, b, f = 0.5) => ({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) }),
    };
  }

  /** Solid-colour copy of a layer's alpha. The rim-light workhorse. */
  function silhouette(src, colour) {
    const s = layer();
    s.x.drawImage(src, 0, 0);
    s.x.globalCompositeOperation = 'source-in';
    s.x.fillStyle = colour;
    s.x.fillRect(0, 0, W, H);
    return s.c;
  }

  // ── The hero's pose. Rig convention: hanging bones (arms, legs) sit at rot PI,
  // and swinging them by `s` gives direction (sin s, -cos s) in rig space, so
  // s < 0 is BACKWARD. Upright bones (torso, neck, head) tip backward on +rot.
  // Shared, because the HEAD_ONLY diagnostic must inspect the exact same head
  // the card draws — a separately posed one would prove nothing.
  const hangR = (s, bone) => s - bone; // armR_upper rests at PI+0.2 → bone = +0.2
  // Rig units the cap is slid up the head axis, so its brim clears the brow
  // instead of sitting on it. drawHatCone applies exactly the same lift.
  const HAT_LIFT = 2.6;
  const HERO_POSE = {
    root: { y: -1.1 },
    pelvis: { rot: -0.06 },
    torso: { rot: 0.15 },
    chest: { rot: 0.05 },
    neck: { rot: -0.06 },
    // Head tilt is CUMULATIVE down the chain: torso 0.15 + chest 0.05 + neck
    // -0.06 lands the skull at 0.14 before the head bone adds anything. At the
    // old +0.10 the face sat ~14 deg off vertical, which is what made every
    // feature look individually misplaced — the eyes staggered, the beard
    // sliding off the chin. -0.05 keeps a live, slightly cocked head at ~5 deg.
    head: { rot: -0.05 },
    hat: { rot: 0, y: HAT_LIFT },

    // Near arm: straight up and back, hand high on the haft. It is the one
    // drawn in front of the body, so it is the one that has to read.
    armR_upper: { rot: hangR(-1.42, 0.2) },
    armR_lower: { rot: -1.39 + 1.42 + 0.22 },
    handR: { rot: -1.16 },

    // Far arm: a clenched fist held back and low. It cannot go on the haft —
    // the beard is wider than his chest and swallows anything in front of it.
    armL_upper: { rot: -0.42 + 0.2 },
    armL_lower: { rot: -0.16 + 0.42 - 0.22 },
    handL: { rot: -0.28 + 0.16 },

    // Braced stance: near leg forward and bent, far leg driving back.
    legR_upper: { rot: 0.36 - 0.2 },
    legR_lower: { rot: -0.3 + 0.05 },
    footR: { rot: -0.08 },
    legL_upper: { rot: -0.34 + 0.2 },
    legL_lower: { rot: 0.4 - 0.05 },
    footL: { rot: 0.34 },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // The other six.
  //
  // The failure mode named up front was "seven nearly identical dwarfs with
  // different hats", so nothing here is left to the hat. The roster's own
  // numbers drive the rig — scale 0.9..1.08, girth 0.94..1.24, head 0.98..1.14,
  // five beard styles plus one beardless, spikes 3..9, three tattoos — and on
  // top of that each one gets a skull of a different SHAPE, a different nose, a
  // different pair of eyes, a different cap silhouette and a different posture.
  //
  // The test is REDRAW-RULES §8: swap any two of these heads and the cover has
  // to break. `HEAD_ONLY=/tmp/all.png CREW=all node tools/make-cover.mjs` puts
  // all seven side by side at ~480px so that test can actually be run by eye.
  // ═══════════════════════════════════════════════════════════════════════════

  // Absolute-swing pose helpers. A limb's `s` is its swing from hanging
  // straight down, so a pose row reads as "where does this point" instead of as
  // a chain of cancelling rest offsets. Rest rotations come from DWARF_SKELETON:
  // armR_upper PI+0.2, armL_upper PI-0.2, the forearms ∓0.22, the thighs ±0.05.
  const AR = (s) => s - 0.2;
  const AL = (s) => s + 0.2;
  const ARf = (sU, sL) => sL - sU + 0.22;
  const ALf = (sU, sL) => sL - sU - 0.22;
  const LR = (s) => s - 0.05;
  const LL = (s) => s + 0.05;
  const LRf = (sU, sL) => sL - sU + 0.05;
  const LLf = (sU, sL) => sL - sU - 0.05;

  /** What the RIG draws under the painted head — small, because the painted
   *  head has to strictly contain it. Same trick the hero uses. */
  const CREW_RIG_HEAD = 0.76;
  /** Multiplier on the roster's own headSize for the painted head. A cover
   *  dwarf reads at about four heads tall; the game's rig is nearer five. */
  const CREW_HEAD = 1.24;

  const CREW_ART = {
    // ── Doc → SAWBONES. The oldest. Small round spectacles low on the nose and
    // an upright, in-charge bearing; high open forehead, thick arched white
    // brows, a large rounded slightly drooping nose. Authoritative, not cruel.
    doc: {
      seed: 11,
      skull: { cw: 0.97, jw: 0.82, fh: 1.18, cd: 0.98 },
      eyeN: [0.34, -0.13, 0.2, 0.115],
      eyeF: [-0.46, -0.12, 0.16, 0.1],
      eyes: 'specs',
      brow: [-0.42, 0.2, 0.24, -0.07],
      nose: { x: 0.58, y: 0.2, w: 0.3, h: 0.23, rot: 0.24, tint: 0 },
      mouth: { kind: 'lecture', x: 0.28, y: 0.7, w: 0.19 },
      beard: { kind: 'bushy', len: 1.42, w: 0.98, lobes: 6 },
      tache: [0.0, 1.06],
      cap: 'fold',
      pose: {
        pelvis: { rot: 0.0 },
        torso: { rot: -0.05 },
        chest: { rot: 0.02 },
        neck: { rot: 0.01 },
        head: { rot: 0.05 },
        armR_upper: { rot: AR(2.52) },
        armR_lower: { rot: ARf(2.52, 2.98) },
        handR: { rot: 0.24 },
        armL_upper: { rot: AL(0.3) },
        armL_lower: { rot: ALf(0.3, 0.92) },
        handL: { rot: 0.1 },
        legR_upper: { rot: LR(0.15) },
        legR_lower: { rot: LRf(0.15, -0.04) },
        footR: { rot: -0.06 },
        legL_upper: { rot: LL(-0.17) },
        legL_lower: { rot: LLf(-0.17, 0.1) },
        footL: { rot: 0.12 },
      },
    },

    // ── Happy → RIOT. The huge open laugh and the biggest belly. Very round
    // broad face, balloon cheeks, round upturned nose, eyes squeezed to happy
    // slits by the cheeks, teeth showing, arms flung open.
    happy: {
      seed: 23,
      skull: { cw: 1.11, jw: 1.03, fh: 0.95, cd: 0.93 },
      eyeN: [0.36, -0.2, 0.23, 0.13],
      eyeF: [-0.46, -0.19, 0.19, 0.11],
      eyes: 'slits',
      brow: [-0.46, 0.13, 0.26, 0.16],
      nose: { x: 0.58, y: 0.2, w: 0.28, h: 0.22, rot: -0.16, tint: 0.26 },
      mouth: { kind: 'laugh', x: 0.28, y: 0.62, w: 0.3 },
      beard: { kind: 'bushy', len: 1.02, w: 1.2, lobes: 5 },
      tache: [-0.1, 0.8],
      cap: 'flop',
      pose: {
        pelvis: { rot: -0.04 },
        torso: { rot: 0.09 },
        chest: { rot: 0.04 },
        neck: { rot: 0.02 },
        head: { rot: 0.07 },
        armR_upper: { rot: AR(2.02) },
        armR_lower: { rot: ARf(2.02, 2.52) },
        handR: { rot: 0.3 },
        // Far arm brought DOWN across the belly instead of flung back. At
        // -1.24 the fist landed in clear air between him and COMA, and a rig
        // glove out there is a lighter core inside its own ink outline — it
        // read as a dark ring with a pale cuff stopping short of it, which is
        // a lens, or an amputation, but never a hand. Down here it is on his
        // own belly, mostly under the beard, and inside the drift fade.
        armL_upper: { rot: AL(-0.34) },
        armL_lower: { rot: ALf(-0.34, 0.36) },
        handL: { rot: 0.22 },
        legR_upper: { rot: LR(0.3) },
        legR_lower: { rot: LRf(0.3, 0.02) },
        footR: { rot: -0.1 },
        legL_upper: { rot: LL(-0.3) },
        legL_lower: { rot: LLf(-0.3, 0.16) },
        footL: { rot: 0.2 },
      },
    },

    // ── Sleepy → COMA. The biggest of the seven and the least awake. Long face,
    // relaxed hanging cheeks, permanently half-closed heavy lids with bags
    // under them, thin brows rising toward the centre, longest untidiest beard,
    // curved back, low shoulders, arms hanging loose.
    sleepy: {
      seed: 37,
      skull: { cw: 0.95, jw: 0.87, fh: 0.99, cd: 1.24 },
      eyeN: [0.33, -0.15, 0.22, 0.145],
      eyeF: [-0.46, -0.14, 0.18, 0.12],
      eyes: 'hooded',
      brow: [-0.44, 0.075, 0.06, 0.2],
      nose: { x: 0.56, y: 0.22, w: 0.26, h: 0.26, rot: 0.26, tint: 0.08 },
      mouth: { kind: 'slack', x: 0.26, y: 0.8, w: 0.19 },
      beard: { kind: 'long', len: 2.1, w: 0.84, lobes: 3 },
      tache: [0.2, 1.24],
      cap: 'droop',
      pose: {
        pelvis: { rot: 0.06 },
        torso: { rot: -0.11 },
        chest: { rot: -0.05 },
        neck: { rot: -0.09 },
        head: { rot: -0.1 },
        armR_upper: { rot: AR(0.2) },
        armR_lower: { rot: ARf(0.2, 0.42) },
        handR: { rot: 0.12 },
        armL_upper: { rot: AL(-0.14) },
        armL_lower: { rot: ALf(-0.14, 0.08) },
        handL: { rot: 0.06 },
        legR_upper: { rot: LR(0.2) },
        legR_lower: { rot: LRf(0.2, -0.02) },
        footR: { rot: -0.06 },
        legL_upper: { rot: LL(-0.22) },
        legL_lower: { rot: LLf(-0.22, 0.14) },
        footL: { rot: 0.14 },
      },
    },

    // ── Bashful → BASH. Strongly blushing cheeks, eyes looking down and
    // sideways from under the brows, thin rounded brows rising toward the
    // centre, a small restrained smile, head tilted, shoulders drawn inward.
    bashful: {
      seed: 53,
      skull: { cw: 1.0, jw: 0.9, fh: 1.01, cd: 1.05 },
      eyeN: [0.33, -0.14, 0.2, 0.135],
      eyeF: [-0.46, -0.13, 0.16, 0.11],
      eyes: 'shy',
      brow: [-0.44, 0.08, 0.09, 0.24],
      nose: { x: 0.56, y: 0.24, w: 0.27, h: 0.22, rot: -0.06, tint: 0.18 },
      mouth: { kind: 'shy', x: 0.26, y: 0.7, w: 0.21 },
      beard: { kind: 'braided', len: 0.96, w: 0.9, lobes: 2 },
      tache: [0.04, 0.72],
      cap: 'beanie',
      blush: 1,
      pose: {
        pelvis: { rot: 0.02 },
        torso: { rot: -0.05 },
        chest: { rot: -0.03 },
        neck: { rot: -0.07 },
        head: { rot: -0.06 },
        armR_upper: { rot: AR(0.56) },
        armR_lower: { rot: ARf(0.56, -0.36) },
        handR: { rot: -0.24 },
        armL_upper: { rot: AL(0.44) },
        armL_lower: { rot: ALf(0.44, -0.52) },
        handL: { rot: -0.2 },
        legR_upper: { rot: LR(0.08) },
        legR_lower: { rot: LRf(0.08, -0.06) },
        footR: { rot: -0.04 },
        legL_upper: { rot: LL(-0.1) },
        legL_lower: { rot: LLf(-0.1, 0.06) },
        footL: { rot: 0.06 },
      },
    },

    // ── Sneezy → PATIENT ZERO. The leanest, and it is all in the nose:
    // enormous, wide, bulbous and red-pink, with irritated nostrils. Eyes
    // squeezed nearly shut mid-build-up, head tilted back, moustache lifting.
    // Comedy, never genuinely ill.
    sneezy: {
      seed: 71,
      skull: { cw: 0.93, jw: 0.66, fh: 1.05, cd: 1.12 },
      eyeN: [0.28, -0.22, 0.19, 0.1],
      eyeF: [-0.48, -0.21, 0.16, 0.09],
      eyes: 'squeezed',
      brow: [-0.48, 0.1, 0.16, -0.16],
      nose: { x: 0.68, y: 0.22, w: 0.44, h: 0.38, rot: 0.04, tint: 0.66 },
      mouth: { kind: 'aaa', x: 0.32, y: 0.72, w: 0.18 },
      beard: { kind: 'stubble', len: 0.8, w: 0.9, lobes: 0 },
      tache: [0.0, 1.0],
      cap: 'pushback',
      pose: {
        pelvis: { rot: -0.04 },
        torso: { rot: 0.1 },
        chest: { rot: 0.05 },
        neck: { rot: 0.06 },
        head: { rot: 0.1 },
        armR_upper: { rot: AR(2.24) },
        armR_lower: { rot: ARf(2.24, 3.02) },
        handR: { rot: 0.4 },
        armL_upper: { rot: AL(-0.52) },
        armL_lower: { rot: ALf(-0.52, -0.94) },
        handL: { rot: -0.1 },
        legR_upper: { rot: LR(0.24) },
        legR_lower: { rot: LRf(0.24, 0.02) },
        footR: { rot: -0.08 },
        legL_upper: { rot: LL(-0.2) },
        legL_lower: { rot: LLf(-0.2, 0.1) },
        footL: { rot: 0.14 },
      },
    },

    // ── Dopey → SILENT D. The only clean-shaven one, plus huge outward-sticking
    // ears and a purple cap three sizes too big. Big round dark eyes, very thin
    // high brows, small round nose, youngest by far, loose awkward posture, and
    // the roster's own bat over one shoulder.
    dopey: {
      seed: 97,
      skull: { cw: 1.13, jw: 0.67, fh: 1.13, cd: 0.93 },
      eyeN: [0.34, -0.12, 0.23, 0.2],
      eyeF: [-0.48, -0.11, 0.19, 0.16],
      eyes: 'wide',
      brow: [-0.46, 0.045, 0.13, 0.1],
      nose: { x: 0.54, y: 0.33, w: 0.22, h: 0.19, rot: -0.1, tint: 0.1 },
      mouth: { kind: 'grin', x: 0.24, y: 0.58, w: 0.3 },
      beard: { kind: 'none', len: 0, w: 0, lobes: 0 },
      tache: [0.0, 1.0],
      cap: 'huge',
      ears: 1,
      club: true,
      pose: {
        pelvis: { rot: 0.02 },
        torso: { rot: 0.04 },
        chest: { rot: -0.03 },
        neck: { rot: 0.03 },
        head: { rot: 0.06 },
        armR_upper: { rot: AR(1.86) },
        armR_lower: { rot: ARf(1.86, 2.62) },
        handR: { rot: 0.34 },
        armL_upper: { rot: AL(-0.34) },
        armL_lower: { rot: ALf(-0.34, 0.42) },
        handL: { rot: 0.24 },
        legR_upper: { rot: LR(0.26) },
        legR_lower: { rot: LRf(0.26, -0.08) },
        footR: { rot: -0.14 },
        legL_upper: { rot: LL(-0.3) },
        legL_lower: { rot: LLf(-0.3, 0.2) },
        footL: { rot: 0.24 },
      },
    },
  };

  // HEAD_ONLY short-circuit. Placed here, after the helpers and constants the
  // head drawing closes over, and before any of the poster itself is painted.
  if (cfg.headOnly) {
    paintHeadOnly(cfg);
    return;
  }

  // ── 1. Sky ────────────────────────────────────────────────────────────────

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0.0, '#03040a');
  sky.addColorStop(0.22, '#0a0a22');
  sky.addColorStop(0.46, '#191038');
  sky.addColorStop(0.68, '#33113f');
  sky.addColorStop(0.86, '#2a0c30');
  sky.addColorStop(1.0, '#0a0710');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Cold pool of moonlight, warm pool where the hero stands.
  const mg = ctx.createRadialGradient(cfg.moon.x, cfg.moon.y, 20, cfg.moon.x, cfg.moon.y, 900);
  mg.addColorStop(0, 'rgba(190,214,255,0.20)');
  mg.addColorStop(0.45, 'rgba(120,150,220,0.06)');
  mg.addColorStop(1, 'rgba(120,150,220,0)');
  ctx.fillStyle = mg;
  ctx.fillRect(0, 0, W, H);

  const pg = ctx.createRadialGradient(1500, 1180, 40, 1500, 1180, 1050);
  pg.addColorStop(0, 'rgba(255,46,110,0.26)');
  pg.addColorStop(0.5, 'rgba(255,46,110,0.07)');
  pg.addColorStop(1, 'rgba(255,46,110,0)');
  ctx.fillStyle = pg;
  ctx.fillRect(0, 0, W, H);

  // Stars: fixed, no twinkle — this is a still.
  for (let i = 0; i < 420; i++) {
    const x = hash01(i * 3 + 1) * W;
    const y = hash01(i * 3 + 2) * (H * 0.62);
    const s = hash01(i * 3 + 3);
    const fade = 1 - y / (H * 0.72);
    ctx.globalAlpha = (0.16 + s * 0.62) * clamp(fade, 0, 1);
    ctx.fillStyle = s > 0.9 ? P.gold : s > 0.72 ? '#ffd7e6' : '#dfe6ff';
    const r = s > 0.9 ? 2.6 : s > 0.6 ? 1.9 : 1.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ── 2. Moon ───────────────────────────────────────────────────────────────

  (function moon() {
    const { x, y, r } = cfg.moon;
    const halo = ctx.createRadialGradient(x, y, r * 0.7, x, y, r * 4.6);
    halo.addColorStop(0, 'rgba(226,236,255,0.34)');
    halo.addColorStop(0.28, 'rgba(190,206,255,0.10)');
    halo.addColorStop(1, 'rgba(190,206,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 4.6, 0, TAU);
    ctx.fill();

    const disc = ctx.createRadialGradient(x - r * 0.3, y - r * 0.34, r * 0.1, x, y, r);
    disc.addColorStop(0, '#ffffff');
    disc.addColorStop(0.6, '#e9eefb');
    disc.addColorStop(1, '#c2cbe4');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    ctx.fillStyle = 'rgba(150,162,196,0.42)';
    for (let i = 0; i < 9; i++) {
      const a = i * 2.11;
      const rr = (0.18 + hash01(i + 41) * 0.62) * r;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, (0.05 + hash01(i + 77) * 0.13) * r, 0, TAU);
      ctx.fill();
    }
    // Terminator: a whisper of shade on the lower-right so it is a sphere.
    const sh = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(0.62, 'rgba(24,26,50,0)');
    sh.addColorStop(1, 'rgba(24,26,50,0.4)');
    ctx.fillStyle = sh;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  })();

  // ── 3. Cold light shafts raking down from behind the peaks ────────────────

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(60px)';
  for (const b of [
    { x: 1980, w: 190, a: 0.085, tint: '190,214,255' },
    { x: 1620, w: 130, a: 0.05, tint: '190,214,255' },
    { x: 1180, w: 210, a: 0.035, tint: '150,190,255' },
  ]) {
    const g = ctx.createLinearGradient(0, 140, 0, 880);
    g.addColorStop(0, `rgba(${b.tint},${b.a})`);
    g.addColorStop(1, `rgba(${b.tint},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(b.x - b.w * 0.2, 120);
    ctx.lineTo(b.x + b.w * 0.2, 120);
    ctx.lineTo(b.x + b.w * 1.5, 900);
    ctx.lineTo(b.x - b.w * 1.5, 900);
    ctx.closePath();
    ctx.fill();
  }
  ctx.filter = 'none';
  ctx.restore();

  // ── 4. Ridges — three layers of mountain, far to near ─────────────────────
  //
  // Built from explicit peaks and straight faces, not from smooth noise. Two
  // earlier passes proved why: ridged-fractal noise gives soft rolling humps
  // that read as fog banks, and hanging little wedges off them turned the
  // skyline into a row of fir trees. A mountain is an ANGULAR thing — two
  // planes meeting at an arete — and once the geometry is angular the shading
  // has something honest to sit on: the right-hand face of every peak takes
  // the moon, the left-hand face falls into its own shadow, and the snow is a
  // cap on the summit rather than a milky wash along the whole crest.

  /** A range as an alternating peak/valley polyline across the frame. */
  function makeRange(base, amp, count, seed, vLo, vHi) {
    const pk = [];
    for (let i = -1; i <= count + 1; i++) {
      const jitter = (hash01(i * 3 + seed * 97) - 0.5) * (W / count) * 0.42;
      pk.push({
        x: (i / count) * W + jitter,
        y: base - amp * (0.72 + 0.28 * hash01(i * 7 + seed * 131)),
      });
    }
    const crest = [];
    for (let i = 0; i < pk.length - 1; i++) {
      const a = pk[i];
      const b = pk[i + 1];
      crest.push({ ...a, peak: true });
      const vx = lerp(a.x, b.x, 0.34 + hash01(i * 11 + seed * 53) * 0.32);
      // Valleys stay HIGH. Dropped to the base they cut the skyline into a row
      // of separate spikes; kept up here the peaks stay joined into a range.
      const vy = base - amp * lerp(vLo, vHi, hash01(i * 13 + seed * 29));
      // one shoulder on each face, kinked outward, so the slopes are broken
      // rock rather than two clean hypotenuses
      crest.push({ x: lerp(a.x, vx, 0.5), y: lerp(a.y, vy, 0.44) - amp * 0.05 });
      crest.push({ x: vx, y: vy, valley: true });
      crest.push({ x: lerp(vx, b.x, 0.52), y: lerp(vy, b.y, 0.58) + amp * 0.04 });
    }
    crest.push({ ...pk[pk.length - 1], peak: true });
    return crest;
  }

  function ridgeLayer(base, amp, count, seed, fill, rimAlpha, snowFrac, vLo, vHi) {
    const crest = makeRange(base, amp, count, seed, vLo, vHi);

    function body() {
      ctx.beginPath();
      ctx.moveTo(crest[0].x - 40, H + 8);
      ctx.lineTo(crest[0].x - 40, crest[0].y);
      for (const p of crest) ctx.lineTo(p.x, p.y);
      ctx.lineTo(crest[crest.length - 1].x + 40, crest[crest.length - 1].y);
      ctx.lineTo(crest[crest.length - 1].x + 40, H + 8);
      ctx.closePath();
    }

    body();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    body();
    ctx.clip();

    // The two faces of every summit. `drop` is how far down the mountain the
    // face is still a face before it merges into the mass below.
    const drop = amp * 1.15;
    for (let i = 0; i < crest.length; i++) {
      if (!crest[i].peak) continue;
      const p = crest[i];
      const l = crest[i - 2] ?? crest[0];
      const r = crest[i + 2] ?? crest[crest.length - 1];
      // moonward face, to the right
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 1);
      ctx.lineTo(crest[i + 1] ? crest[i + 1].x : r.x, crest[i + 1] ? crest[i + 1].y : r.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineTo(r.x, r.y + drop);
      ctx.lineTo(p.x, p.y + drop);
      ctx.closePath();
      ctx.fillStyle = `rgba(168,196,255,${0.02 + rimAlpha * 0.16})`;
      ctx.fill();
      // and the face in shadow, to the left
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 1);
      ctx.lineTo(crest[i - 1] ? crest[i - 1].x : l.x, crest[i - 1] ? crest[i - 1].y : l.y);
      ctx.lineTo(l.x, l.y);
      ctx.lineTo(l.x, l.y + drop);
      ctx.lineTo(p.x, p.y + drop);
      ctx.closePath();
      ctx.fillStyle = 'rgba(2,3,12,0.28)';
      ctx.fill();
    }

    // Everything below the peaks sinks; the very top of the range is closest to
    // the sky and so nearest to its colour.
    const fade = ctx.createLinearGradient(0, base - amp * 0.2, 0, H);
    fade.addColorStop(0, 'rgba(2,3,12,0)');
    fade.addColorStop(1, 'rgba(2,3,12,0.55)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, base - amp * 0.2, W, H);

    // Snow caps: a wedge over each summit with a ragged lower edge, sitting on
    // the rock rather than smeared along the whole skyline.
    if (snowFrac > 0) {
      for (let i = 0; i < crest.length; i++) {
        if (!crest[i].peak) continue;
        const p = crest[i];
        const l = crest[i - 1] ?? p;
        const r = crest[i + 1] ?? p;
        const lx = lerp(p.x, l.x, snowFrac);
        const ly = lerp(p.y, l.y, snowFrac);
        const rx2 = lerp(p.x, r.x, snowFrac);
        const ry2 = lerp(p.y, r.y, snowFrac);
        const capH = (ly + ry2) * 0.5 - p.y;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 1);
        ctx.lineTo(rx2, ry2);
        // the melt line, running back under the summit with tongues in it
        for (let k = 5; k >= 0; k--) {
          const t = k / 5;
          ctx.lineTo(
            lerp(rx2, lx, 1 - t),
            lerp(ry2, ly, 1 - t) + (hash01(i * 17 + k * 5 + seed) - 0.4) * capH * 0.55,
          );
        }
        ctx.lineTo(lx, ly);
        ctx.closePath();
        const sgd = ctx.createLinearGradient(p.x, p.y, p.x, Math.max(ly, ry2));
        sgd.addColorStop(0, 'rgba(222,236,255,0.62)');
        sgd.addColorStop(1, 'rgba(198,218,255,0.06)');
        ctx.fillStyle = sgd;
        ctx.fill();
      }
    }
    ctx.restore();

    // Cold moonward rim along the crest itself.
    ctx.beginPath();
    ctx.moveTo(crest[0].x, crest[0].y);
    for (const p of crest) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = `rgba(206,224,255,${rimAlpha})`;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.stroke();

    return crest;
  }

  const CREST1 = ridgeLayer(742, 246, 5, 3, '#1a2246', 0.24, 0.42, 0.3, 0.52);

  // ── 5. The billionaire, alone on the far ridge ────────────────────────────

  (function billionaire() {
    const x = cfg.boss.x;
    // He stands ON the far crest: the y is read straight off the polyline that
    // drew it, so he can never float above the skyline or sink into it.
    let feet = 700;
    for (let i = 0; i < CREST1.length - 1; i++) {
      const a = CREST1[i];
      const b = CREST1[i + 1];
      if (x >= a.x && x <= b.x) {
        feet = lerp(a.y, b.y, (x - a.x) / (b.x - a.x || 1)) + 6;
        break;
      }
    }

    // A pool of moon haze behind him. A black silhouette on a dark mountain is
    // no silhouette at all; it needs something paler to be cut out of.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gl = ctx.createRadialGradient(x + 30, feet - cfg.boss.h * 0.62, 20, x + 30, feet - cfg.boss.h * 0.62, cfg.boss.h * 1.5);
    gl.addColorStop(0, 'rgba(150,180,240,0.20)');
    gl.addColorStop(0.42, 'rgba(120,150,220,0.07)');
    gl.addColorStop(1, 'rgba(120,150,220,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(x - 700, feet - cfg.boss.h * 2, 1400, cfg.boss.h * 2.4);
    ctx.restore();

    drawBillionaire(ctx, x, feet, cfg.boss.h);
  })();

  // Haze between him and the nearer peaks — atmosphere is what makes it depth.
  const haze = ctx.createLinearGradient(0, 600, 0, 900);
  haze.addColorStop(0, 'rgba(96,116,190,0)');
  haze.addColorStop(0.6, 'rgba(96,116,190,0.2)');
  haze.addColorStop(1, 'rgba(70,60,120,0.03)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 600, W, 320);

  ridgeLayer(900, 214, 7, 11, '#0e1330', 0.15, 0.2, 0.26, 0.48);

  const haze2 = ctx.createLinearGradient(0, 700, 0, 1010);
  haze2.addColorStop(0, 'rgba(120,90,170,0)');
  haze2.addColorStop(1, 'rgba(126,64,132,0.26)');
  ctx.fillStyle = haze2;
  ctx.fillRect(0, 700, W, 320);

  ridgeLayer(1022, 158, 10, 23, '#050813', 0.1, 0, 0.22, 0.44);

  // ── 6. Foreground snow bank the hero stands on ────────────────────────────

  (function ground() {
    const gy = (x) => 1104 - ridgeAt(x, 41, 0.0088) * 58;
    ctx.beginPath();
    ctx.moveTo(-8, H + 8);
    for (let x = -8; x <= W + 8; x += 5) ctx.lineTo(x, gy(x));
    ctx.lineTo(W + 8, H + 8);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 1050, 0, H);
    g.addColorStop(0, '#0a0b18');
    g.addColorStop(1, '#050508');
    ctx.fillStyle = g;
    ctx.fill();

    // The crest of the bank catches the pink key light.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 3.4;
    const rl = ctx.createLinearGradient(700, 0, 2400, 0);
    rl.addColorStop(0, 'rgba(255,46,110,0.05)');
    rl.addColorStop(0.45, 'rgba(255,92,141,0.34)');
    rl.addColorStop(1, 'rgba(255,46,110,0.14)');
    ctx.strokeStyle = rl;
    ctx.beginPath();
    for (let x = -8; x <= W + 8; x += 5) {
      if (x === -8) ctx.moveTo(x, gy(x));
      else ctx.lineTo(x, gy(x));
    }
    ctx.stroke();
    ctx.restore();

    // Bottom scrim so the wordmark sits on clean ground.
    const s = ctx.createLinearGradient(0, 800, 0, H);
    s.addColorStop(0, 'rgba(3,4,9,0)');
    s.addColorStop(0.4, 'rgba(3,4,9,0.55)');
    s.addColorStop(1, 'rgba(3,4,9,0.9)');
    // Two-axis falloff: full strength under the wordmark, a third of it under
    // the hero, whose chest it was otherwise swallowing whole. Built on its own
    // layer, because doing it in place with destination-out punches a hole
    // straight through the finished canvas.
    const sc = layer();
    sc.x.fillStyle = s;
    sc.x.fillRect(0, 800, W, H - 800);
    sc.x.globalCompositeOperation = 'destination-in';
    const across = sc.x.createLinearGradient(1020, 0, 1760, 0);
    across.addColorStop(0, 'rgba(0,0,0,1)');
    across.addColorStop(1, 'rgba(0,0,0,0.34)');
    sc.x.fillStyle = across;
    sc.x.fillRect(0, 800, W, H - 800);
    ctx.drawImage(sc.c, 0, 0);
  })();

  // ── 6b. The other six, furthest first ─────────────────────────────────────

  drawCrew();

  // ── 7. The hero ───────────────────────────────────────────────────────────

  drawHero();

  // ── 7b. The drift he is standing in, painted over his boots ───────────────

  (function drift() {
    const dy = (x) => 1226 - ridgeAt(x * 1.0 + 700, 61, 0.0042) * 74;
    ctx.beginPath();
    ctx.moveTo(-8, H + 8);
    for (let x = -8; x <= W + 8; x += 5) ctx.lineTo(x, dy(x));
    ctx.lineTo(W + 8, H + 8);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 1150, 0, H);
    g.addColorStop(0, '#0d0e1c');
    g.addColorStop(1, '#030308');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 4.2;
    const rl = ctx.createLinearGradient(600, 0, 2400, 0);
    rl.addColorStop(0, 'rgba(255,46,110,0.06)');
    rl.addColorStop(0.42, 'rgba(255,110,155,0.42)');
    rl.addColorStop(1, 'rgba(255,46,110,0.16)');
    ctx.strokeStyle = rl;
    ctx.beginPath();
    for (let x = -8; x <= W + 8; x += 5) {
      if (x === -8) ctx.moveTo(x, dy(x));
      else ctx.lineTo(x, dy(x));
    }
    ctx.stroke();
    ctx.restore();
  })();

  // ── 8. Weather in front of everything ─────────────────────────────────────

  (function snow() {
    // Snow, not rain: mostly round flakes, only the nearest few smeared, and
    // thinned right out over the wordmark so the type stays clean.
    for (let i = 0; i < 300; i++) {
      const d = hash01(i * 7 + 5); // 0 far, 1 near
      const x = hash01(i * 7 + 1) * (W + 200) - 100;
      const y = hash01(i * 7 + 2) * H;
      if (x < 1180 && y > 850) continue;
      const r = 1.4 + d * d * 7.4;
      const warm = x > 1180 && y > 560;
      ctx.globalAlpha = (0.1 + hash01(i * 7 + 4) * 0.38) * (0.3 + d * 0.7);
      ctx.fillStyle = warm ? '#ffd9e6' : '#dae6ff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      if (d > 0.93) {
        ctx.globalAlpha *= 0.5;
        ctx.strokeStyle = warm ? '#ffd9e6' : '#dae6ff';
        ctx.lineWidth = r * 0.85;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 5, y - 16);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  })();

  (function embers() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 110; i++) {
      const x = 1120 + hash01(i * 11 + 1) * 1180;
      const y = 560 + hash01(i * 11 + 2) * 690;
      const s = hash01(i * 11 + 3);
      ctx.globalAlpha = 0.16 + s * 0.5;
      ctx.fillStyle = s > 0.42 ? P.pinkHot : P.gold;
      ctx.beginPath();
      ctx.arc(x, y, 1.4 + s * 3.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  })();

  // ── 9. Vignette ───────────────────────────────────────────────────────────

  (function vignette() {
    const g = ctx.createRadialGradient(W * 0.52, H * 0.5, H * 0.28, W * 0.52, H * 0.5, H * 1.02);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.24)');
    g.addColorStop(1, 'rgba(0,0,0,0.74)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  })();

  // ── 10. The wordmark ──────────────────────────────────────────────────────

  drawTitle();

  // ═══════════════════════════════════════════════════════════════════════════
  // Type
  // ═══════════════════════════════════════════════════════════════════════════

  /** Canvas has no letter-spacing and a logo lives or dies on tracking. */
  function tracked(s, x, y, tr, fill, stroke, sw) {
    const chars = [...s];
    let cx = x;
    for (const ch of chars) {
      if (stroke && sw > 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = sw;
        ctx.strokeStyle = stroke;
        ctx.strokeText(ch, cx, y);
      }
      ctx.fillStyle = fill;
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + tr;
    }
    return cx - tr - x;
  }

  function drawTitle() {
    const T = cfg.title;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // MOUNTAIN — the quiet half, wide tracking, sitting on a rule.
    ctx.font = `${T.small}px "Lato Black", Lato, sans-serif`;
    const smallW = (() => {
      const chars = [...'MOUNTAIN'];
      let w = -26;
      for (const ch of chars) w += ctx.measureText(ch).width + 26;
      return w;
    })();
    tracked('MOUNTAIN', T.x, T.top, 26, '#eef1f8', 'rgba(20,16,25,0.9)', 9);

    // A thin pink rule running off to the right of MOUNTAIN.
    const ruleY = T.top - T.small * 0.34;
    const rg = ctx.createLinearGradient(T.x + smallW + 34, 0, T.x + smallW + 430, 0);
    rg.addColorStop(0, 'rgba(255,46,110,0.85)');
    rg.addColorStop(1, 'rgba(255,46,110,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(T.x + smallW + 34, ruleY - 3, 396, 6);

    // FIGHTERS — the loud half.
    ctx.font = `${T.big}px "Lato Black", Lato, sans-serif`;
    const baseY = T.top + T.big * 0.92;
    const tr = 4;

    ctx.save();
    ctx.shadowColor = 'rgba(255,46,110,0.55)';
    ctx.shadowBlur = 62;
    tracked('FIGHTERS', T.x, baseY, tr, 'rgba(255,46,110,0.9)', null, 0);
    ctx.restore();

    // Drop plate: a deep magenta copy offset down-right gives the type mass.
    tracked('FIGHTERS', T.x + 9, baseY + 11, tr, P.pinkDeep, null, 0);

    const grad = ctx.createLinearGradient(0, baseY - T.big * 0.78, 0, baseY + 6);
    grad.addColorStop(0, '#fff2f6');
    grad.addColorStop(0.36, P.pinkHot);
    grad.addColorStop(1, '#e01055');
    const bigW = tracked('FIGHTERS', T.x, baseY, tr, grad, P.ink, 11);

    // The studded bar off the game's own logo — same studs as the jackets.
    // Bar first, studs on top of it. Drawn the other way round the strip hides
    // all but the tips of the studs and they read as fringing on the rule.
    const barY = baseY + 42;
    MF.Shapes.roundRect(ctx, T.x, barY - 4, bigW, 8, 4, P.pinkDeep, 'none', 0);
    MF.Shapes.spikeStrip(ctx, T.x + 16, barY + 3, T.x + bigW - 16, barY + 3, 11, 16, P.gold);

    // Tagline.
    ctx.font = `600 30px Lato, "Noto Sans", sans-serif`;
    tracked(cfg.tagline, T.x + 4, barY + 74, 4.4, '#c4ccdd', 'rgba(3,4,9,0.85)', 5);

    ctx.restore();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The billionaire. One suited figure standing on a peak a long way off,
  // pointing at the dwarf. He is drawn as a near-black cut-out with one silver
  // moon rim, because at this size a SILHOUETTE is the only thing that reads —
  // and a silhouette can carry a caricature (enormous cranium, high domed
  // forehead, receding jaw) that a rendered face at the same scale cannot.
  //
  // Local frame: origin at his feet on the ridge, +x is the way he faces
  // (screen-right, at the dwarf), and every measurement is a fraction of h,
  // his full standing height. He is ~6.5 heads tall — short of the realistic
  // 7.5, which is what makes the head read as too big for the body.
  // ═══════════════════════════════════════════════════════════════════════════

  function drawBillionaire(c, x, feet, h) {
    const V = '#03050c'; // the void he is cut out of the mountain as
    const RIM = 'rgba(196,218,255,';

    c.save();
    c.translate(x, feet);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const p = (a) => a * h;

    // Slight lean forward, on the front foot. Nobody points while standing up
    // straight.
    c.rotate(-0.03);

    const body = c.createLinearGradient(0, p(-1.02), 0, 0);
    body.addColorStop(0, '#0a1020');
    body.addColorStop(0.62, V);
    body.addColorStop(1, '#070c18');

    // ── the teal pool he is standing in. Painted as a squashed circle so the
    // falloff is soft all the way round; an ellipse PATH filled with a circular
    // gradient clips the top and bottom into a hard-edged stage decal.
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.scale(1, 0.3);
    const ug = c.createRadialGradient(0, p(0.04), p(0.01), 0, p(0.04), p(0.44));
    ug.addColorStop(0, 'rgba(55,230,200,0.34)');
    ug.addColorStop(0.4, 'rgba(55,230,200,0.1)');
    ug.addColorStop(1, 'rgba(55,230,200,0)');
    c.fillStyle = ug;
    c.fillRect(p(-0.5), p(-0.42), p(1.0), p(0.92));
    c.restore();

    // ── trousers. Suit trousers, not jeans: they have to be wide enough that
    // the legs are a mass rather than two wires.
    c.fillStyle = body;
    c.beginPath();
    c.moveTo(p(-0.088), p(-0.50));
    c.lineTo(p(-0.004), p(-0.50));
    c.lineTo(p(-0.010), p(-0.24));
    c.lineTo(p(-0.052), p(-0.026));
    c.lineTo(p(-0.098), p(-0.026));
    c.lineTo(p(-0.076), p(-0.25));
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(p(0.004), p(-0.50));
    c.lineTo(p(0.086), p(-0.50));
    c.lineTo(p(0.078), p(-0.25));
    c.lineTo(p(0.070), p(-0.028));
    c.lineTo(p(0.018), p(-0.028));
    c.lineTo(p(0.024), p(-0.25));
    c.closePath();
    c.fill();

    // ── shoes, long and blunt
    c.fillStyle = V;
    for (const [sx, sy, sw] of [[-0.098, -0.020, 0.082], [0.018, -0.022, 0.094]]) {
      c.beginPath();
      c.moveTo(p(sx), p(sy - 0.006));
      c.lineTo(p(sx + sw), p(sy + 0.002));
      c.quadraticCurveTo(p(sx + sw + 0.010), p(sy + 0.020), p(sx + sw - 0.024), p(sy + 0.021));
      c.lineTo(p(sx - 0.004), p(sy + 0.021));
      c.closePath();
      c.fill();
    }

    // The jacket's front edge, written ONCE: the fill runs up it and the moon
    // rim strokes the same run. Hand-copied for the rim it came out reversed
    // with each cubic's two control points left in the original order — which
    // is a different curve, not the same one backwards — so the silver edge
    // bowed away from the silhouette it was supposed to be cutting out.
    function jacketFront() {
      c.bezierCurveTo(p(0.100), p(-0.540), p(0.094), p(-0.560), p(0.096), p(-0.600));
      c.bezierCurveTo(p(0.104), p(-0.680), p(0.098), p(-0.740), p(0.088), p(-0.806));
    }

    // ── the suit jacket. Wide at the shoulder, nipped at the waist, flaring
    // again over the hip, and one tail lifted by the wind coming off the ridge.
    // That taper is the whole recognition: a rectangle reads as a mannequin.
    c.beginPath();
    c.moveTo(p(-0.100), p(-0.800));
    c.bezierCurveTo(p(-0.112), p(-0.70), p(-0.096), p(-0.62), p(-0.094), p(-0.560));
    c.bezierCurveTo(p(-0.104), p(-0.520), p(-0.112), p(-0.480), p(-0.116), p(-0.446));
    // wind-lifted back tail
    c.bezierCurveTo(p(-0.146), p(-0.464), p(-0.176), p(-0.462), p(-0.196), p(-0.436));
    c.bezierCurveTo(p(-0.168), p(-0.416), p(-0.136), p(-0.408), p(-0.104), p(-0.410));
    c.lineTo(p(0.064), p(-0.416));
    c.bezierCurveTo(p(0.100), p(-0.420), p(0.112), p(-0.440), p(0.106), p(-0.480));
    jacketFront();
    c.closePath();
    c.fillStyle = body;
    c.fill();

    // ── arms. Far one on the hip, which opens a triangle of night between the
    // elbow and the ribs — the cheapest way to make a small silhouette read.
    c.strokeStyle = body;
    c.lineWidth = p(0.040);
    c.beginPath();
    c.moveTo(p(-0.082), p(-0.786));
    c.lineTo(p(-0.168), p(-0.640));
    c.lineTo(p(-0.086), p(-0.528));
    c.stroke();

    // Near arm: out and level, pointing at the dwarf across the valley. The
    // elbow, the wrist and the finger all sit on ONE axis, taken from the
    // forearm vector — the hand used to be a thinner second stroke carrying
    // straight on past the cuff, which is a flipper, not a hand.
    const ELB = { x: 0.136, y: -0.694 };
    const WRI = { x: 0.212, y: -0.681 };
    const fl = Math.hypot(WRI.x - ELB.x, WRI.y - ELB.y);
    const FX = (WRI.x - ELB.x) / fl;
    const FY = (WRI.y - ELB.y) / fl;
    c.lineWidth = p(0.042);
    c.beginPath();
    c.moveTo(p(0.070), p(-0.790));
    c.lineTo(p(ELB.x), p(ELB.y));
    c.lineTo(p(WRI.x), p(WRI.y));
    c.stroke();
    // cuff: a shade wider than the sleeve and overlapping it, so sleeve and
    // hand share pixels instead of butting up against each other
    c.lineWidth = p(0.046);
    c.beginPath();
    c.moveTo(p(WRI.x - FX * 0.014), p(WRI.y - FY * 0.014));
    c.lineTo(p(WRI.x - FX * 0.002), p(WRI.y - FY * 0.002));
    c.stroke();
    // the fist, and the one finger out of it
    c.lineWidth = p(0.034);
    c.beginPath();
    c.moveTo(p(WRI.x + FX * 0.008), p(WRI.y + FY * 0.008));
    c.lineTo(p(WRI.x + FX * 0.030), p(WRI.y + FY * 0.030));
    c.stroke();
    c.lineWidth = p(0.015);
    c.beginPath();
    c.moveTo(p(WRI.x + FX * 0.026), p(WRI.y + FY * 0.026));
    c.lineTo(p(WRI.x + FX * 0.082), p(WRI.y + FY * 0.082 - 0.004));
    c.stroke();

    // ── neck and the head. The head is the caricature: a cranium far too big
    // for the jaw, a forehead that goes most of the way over the crown, and a
    // chin that gives up early.
    c.strokeStyle = V;
    c.lineWidth = p(0.030);
    c.beginPath();
    c.moveTo(p(-0.004), p(-0.796));
    c.lineTo(p(0.004), p(-0.846));
    c.stroke();

    // Brow, nose, lip and chin, written ONCE: the silhouette fills along it and
    // the moon rim strokes the lit part of the same run. It was two copies of
    // the same eight beziers thirteen lines apart, which is the whole reason
    // this file has a rule about writing geometry twice.
    function bossProfile() {
      c.bezierCurveTo(p(0.062), p(-1.004), p(0.082), p(-0.962), p(0.076), p(-0.918));
      c.bezierCurveTo(p(0.073), p(-0.902), p(0.067), p(-0.895), p(0.065), p(-0.890));
      c.bezierCurveTo(p(0.083), p(-0.880), p(0.084), p(-0.867), p(0.067), p(-0.863));
      c.bezierCurveTo(p(0.060), p(-0.861), p(0.056), p(-0.861), p(0.054), p(-0.856));
      c.bezierCurveTo(p(0.058), p(-0.841), p(0.047), p(-0.828), p(0.025), p(-0.826));
    }
    c.beginPath();
    c.moveTo(p(-0.040), p(-0.884));
    c.bezierCurveTo(p(-0.068), p(-0.950), p(-0.040), p(-1.008), p(0.014), p(-1.006));
    bossProfile();
    c.bezierCurveTo(p(-0.004), p(-0.824), p(-0.031), p(-0.844), p(-0.040), p(-0.870));
    c.closePath();
    c.fillStyle = V;
    c.fill();

    // ── the moon rim. One hard silver edge down everything that faces up and
    // right, and nothing anywhere else.
    const rimAt = (a) => `${RIM}${a})`;
    c.lineWidth = p(0.0078);
    const prg = c.createLinearGradient(0, p(-1.006), 0, p(-0.822));
    prg.addColorStop(0, rimAt(0.92));
    prg.addColorStop(0.62, rimAt(0.78));
    prg.addColorStop(1, rimAt(0.2));
    c.strokeStyle = prg;
    c.beginPath();
    c.moveTo(p(0.014), p(-1.006));
    bossProfile();
    c.stroke();

    // shoulder, lapel notch and the front edge of the jacket
    c.lineWidth = p(0.0072);
    const jr = c.createLinearGradient(0, p(-0.82), 0, p(-0.40));
    jr.addColorStop(0, rimAt(0.82));
    jr.addColorStop(1, rimAt(0.08));
    c.strokeStyle = jr;
    c.beginPath();
    c.moveTo(p(0.106), p(-0.480));
    jacketFront();
    c.lineTo(p(0.012), p(-0.812));
    c.stroke();
    // Lapel notch. Short: run down to -0.716 it was a silver wire ending in
    // the middle of a black chest, which is a mark on the coat, not an edge.
    c.lineWidth = p(0.005);
    const lap = c.createLinearGradient(0, p(-0.812), 0, p(-0.740));
    lap.addColorStop(0, rimAt(0.42));
    lap.addColorStop(1, rimAt(0));
    c.strokeStyle = lap;
    c.beginPath();
    c.moveTo(p(0.020), p(-0.806));
    c.lineTo(p(0.041), p(-0.738));
    c.stroke();

    // the pointing arm, lit along its top — off the arm's OWN points, offset
    // along its normal, rather than a second set of numbers that drifts
    c.lineWidth = p(0.0064);
    c.strokeStyle = rimAt(0.75);
    c.beginPath();
    c.moveTo(p(0.076), p(-0.806));
    c.lineTo(p(ELB.x + 0.004), p(ELB.y - 0.018));
    c.lineTo(p(WRI.x + FX * 0.024), p(WRI.y + FY * 0.024 - 0.016));
    c.stroke();

    // and one cold edge down the front of the near trouser leg
    c.lineWidth = p(0.0048);
    c.strokeStyle = rimAt(0.3);
    c.beginPath();
    c.moveTo(p(0.086), p(-0.480));
    c.lineTo(p(0.078), p(-0.25));
    c.lineTo(p(0.070), p(-0.030));
    c.stroke();

    c.restore();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The hero. Body = the game's own rig, posed by hand. Head = drawn here, at
  // eight times the detail the game ever needs.
  // ═══════════════════════════════════════════════════════════════════════════

  function drawHero() {
    const dwarf = MF.getDwarf(cfg.hero);
    const style = {
      ...dwarf.style,
      outfit: 1,
      headSize: cfg.rigHeadSize,
      // The game's leather is #191419 because in-game he is 30px tall against a
      // lit mine wall. On a night sky at poster scale that is a hole, so the
      // cover lifts it a stop. Everything else is the roster's own palette.
      jacketColor: '#2c2633',
      tunicColor: '#a06a38',
      // The roster's jacketAccent is #a83a2c — dark red studs on near-black
      // leather, which is legible in a lit mine and invisible on a night sky,
      // so the "dwarfs in spiked leather" hook never landed. Brass is one step
      // toward the cover's gold accent: enough to make the shoulder studs and
      // the chest strap read, not so much that the strap becomes a gold sash.
      jacketAccent: '#a8762f',
      // The rig's beard and shades would only be painted over; skipping them
      // keeps the layers underneath clean.
      beardStyle: 'none',
      shades: false,
      cigar: false,
    };

    const U = cfg.heroU;
    const u = U * (style.scale || 1);
    const X = cfg.heroX;
    const Y = cfg.heroY;
    const FACING = -1; // he faces screen-left, at the billionaire

    const pose = HERO_POSE;

    const { jp, tp, mid } = boneFrame(pose, u);

    const L = layer();
    const c = L.x;

    MF.drawCharacter(c, style, pose, MF.DWARF_SKELETON, X, Y, FACING, { scale: U });

    c.save();
    c.translate(X, Y);
    c.scale(FACING, 1);

    // Hands, in the same frame, so the haft can be threaded through them.
    // One hand on the haft. The two ends of the grip are taken from the hand
    // bone's own direction, so the pickaxe leaves the fist along the knuckles.
    const wrist = jp('handR');
    const knuck = tp('handR');
    const fistN = mid(wrist, knuck, 0.42);
    const hl = Math.hypot(knuck.x - wrist.x, knuck.y - wrist.y) || 1;
    const hd = { x: (knuck.x - wrist.x) / hl, y: (knuck.y - wrist.y) / hl };
    drawPickaxe(
      c,
      { x: fistN.x - hd.x * u * 3.4, y: fistN.y - hd.y * u * 3.4 },
      { x: fistN.x + hd.x * u * 1.8, y: fistN.y + hd.y * u * 1.8 },
      u,
      [fistN],
    );
    drawDwarfHead(c, style, u, jp, tp, mid);

    c.restore();

    // ── Lighting. A hot key from the front-left and a cold fill from behind,
    // laid over the finished figure so every part takes the same light.
    c.save();
    c.globalCompositeOperation = 'source-atop';
    const key = c.createLinearGradient(X - 430, Y - 980, X + 470, Y - 260);
    key.addColorStop(0, 'rgba(255,74,128,0.32)');
    key.addColorStop(0.34, 'rgba(255,96,144,0.09)');
    key.addColorStop(0.62, 'rgba(58,80,146,0.14)');
    key.addColorStop(1, 'rgba(126,164,232,0.34)');
    c.fillStyle = key;
    c.fillRect(0, 0, W, H);
    // and a floor-up warm bounce
    const bounce = c.createLinearGradient(0, Y - 120, 0, Y - 700);
    bounce.addColorStop(0, 'rgba(255,86,134,0.46)');
    bounce.addColorStop(0.5, 'rgba(255,86,134,0.2)');
    bounce.addColorStop(1, 'rgba(255,86,134,0)');
    c.fillStyle = bounce;
    c.fillRect(0, Y - 640, W, 650);
    c.restore();

    // ── The body, dropped into shadow. The rig's torso art is designed to read
    // at 30px against a lit mine wall; blown up to 400 and lit flat it is a
    // muddy slab with a stripe on it. Sinking it toward black turns it into
    // mass — a broad dark brawler under a lit face — and the offset silhouettes
    // below then do all the describing, in one pink and one silver line.
    c.save();
    c.globalCompositeOperation = 'source-atop';
    const sink = c.createLinearGradient(0, Y - 540, 0, Y - 240);
    sink.addColorStop(0, 'rgba(10,7,16,0)');
    sink.addColorStop(0.45, 'rgba(10,7,16,0.36)');
    sink.addColorStop(1, 'rgba(8,6,13,0.7)');
    c.fillStyle = sink;
    c.fillRect(0, Y - 540, W, 560);
    // one long specular down the front of the jacket, which is what says
    // leather rather than cloth
    const spec = c.createLinearGradient(X - 180, 0, X - 20, 0);
    spec.addColorStop(0, 'rgba(255,96,140,0)');
    spec.addColorStop(0.5, 'rgba(255,110,152,0.2)');
    spec.addColorStop(1, 'rgba(255,96,140,0)');
    c.fillStyle = spec;
    c.fillRect(X - 190, Y - 470, 180, 430);
    c.restore();

    // ── Separation. Offset silhouettes under the figure: pink on the key side,
    // silver on the moon side. This is the whole trick.
    const pinkSil = silhouette(L.c, '#ff5c8d');
    const coldSil = silhouette(L.c, '#cfe0ff');

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, Y - 26); // keep the rim off the rig's contact shadow
    ctx.clip();

    // soft pink bloom behind him
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.42;
    ctx.filter = 'blur(54px)';
    ctx.drawImage(pinkSil, -20, 10);
    ctx.filter = 'none';
    ctx.restore();

    // Offsets kept small and the cold one kept quiet: pushed any harder they
    // stop reading as a rim and start reading as a die-cut sticker outline.
    ctx.globalAlpha = 0.8;
    ctx.drawImage(pinkSil, -7, 4);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(coldSil, 6, -5);
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.drawImage(L.c, 0, 0);
  }

  // ── The pickaxe ───────────────────────────────────────────────────────────

  function drawPickaxe(c, gripLow, gripHigh, u, grips) {
    const dx = gripHigh.x - gripLow.x;
    const dy = gripHigh.y - gripLow.y;
    const len = Math.hypot(dx, dy) || 1;
    const ax = dx / len;
    const ay = dy / len;
    const nx = -ay;
    const ny = ax;

    const top = { x: gripHigh.x + ax * u * 24, y: gripHigh.y + ay * u * 24 };
    const butt = { x: gripLow.x - ax * u * 7.4, y: gripLow.y - ay * u * 7.4 };
    const hw = u * 0.72;

    // haft, with the grain lit down one side
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(butt.x, butt.y);
    c.lineTo(top.x, top.y);
    c.lineWidth = hw * 2 + u * 0.5;
    c.strokeStyle = '#141019';
    c.stroke();
    const wg = c.createLinearGradient(
      butt.x + nx * hw, butt.y + ny * hw,
      butt.x - nx * hw, butt.y - ny * hw,
    );
    wg.addColorStop(0, '#7a4a24');
    wg.addColorStop(0.45, '#4c2d16');
    wg.addColorStop(1, '#2a180c');
    c.strokeStyle = wg;
    c.lineWidth = hw * 2;
    c.stroke();
    // grain
    c.strokeStyle = 'rgba(20,16,25,0.5)';
    c.lineWidth = u * 0.1;
    for (let i = -1; i <= 1; i++) {
      c.beginPath();
      c.moveTo(butt.x + nx * i * hw * 0.5, butt.y + ny * i * hw * 0.5);
      c.lineTo(top.x + nx * i * hw * 0.45, top.y + ny * i * hw * 0.45);
      c.stroke();
    }

    // leather grip wraps between the hands
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const gx = lerp(butt.x, gripHigh.x, 0.12 + t * 0.82);
      const gy = lerp(butt.y, gripHigh.y, 0.12 + t * 0.82);
      c.beginPath();
      c.moveTo(gx + nx * hw * 1.06, gy + ny * hw * 1.06);
      c.lineTo(gx - nx * hw * 1.06 - ax * u * 0.7, gy - ny * hw * 1.06 - ay * u * 0.7);
      c.lineWidth = u * 0.42;
      c.strokeStyle = '#1a151d';
      c.stroke();
    }

    // ── head. Drawn in a frame where +x runs up the haft and +y is the side
    // the spike sweeps out to, because a pickaxe is a curved bar and curved
    // bars are unreadable written out in world coordinates.
    c.save();
    c.translate(top.x - ax * u * 1.9, top.y - ay * u * 1.9);
    c.rotate(Math.atan2(ay, ax));
    const q = (a) => a * u;

    c.beginPath();
    c.moveTo(q(1.5), q(0.9));
    // spike: sweeps out and curls back toward the ground
    c.bezierCurveTo(q(1.7), q(3.2), q(0.9), q(5.4), q(-1.6), q(7.0));
    c.bezierCurveTo(q(-1.2), q(4.6), q(-1.8), q(2.6), q(-2.1), q(1.0));
    c.lineTo(q(-2.1), q(-1.0));
    // chisel: shorter, squarer, flat cutting edge
    c.bezierCurveTo(q(-2.5), q(-2.4), q(-2.6), q(-3.6), q(-2.6), q(-4.6));
    c.lineTo(q(-0.1), q(-5.3));
    c.bezierCurveTo(q(0.7), q(-3.2), q(1.4), q(-1.8), q(1.5), q(-0.9));
    c.closePath();
    c.lineWidth = u * 0.6;
    c.strokeStyle = '#141019';
    c.stroke();
    const stg = c.createLinearGradient(q(2.0), q(6.0), q(-2.6), q(-4.0));
    stg.addColorStop(0, '#e6eefc');
    stg.addColorStop(0.22, '#8794b0');
    stg.addColorStop(0.5, '#333b52');
    stg.addColorStop(0.78, '#4a3a48');
    stg.addColorStop(1, '#a8566e');
    c.fillStyle = stg;
    c.fill();

    // bevel down the middle of the bar so the steel has a form
    c.beginPath();
    c.moveTo(q(-1.5), q(6.1));
    c.bezierCurveTo(q(-0.9), q(4.0), q(-0.6), q(2.0), q(-0.4), q(0.0));
    c.bezierCurveTo(q(-0.6), q(-2.0), q(-1.0), q(-3.6), q(-1.2), q(-4.9));
    c.lineWidth = u * 0.24;
    c.strokeStyle = 'rgba(20,16,25,0.45)';
    c.stroke();

    // cold edge on the moon side, hot edge on the key side
    c.lineWidth = u * 0.22;
    c.strokeStyle = 'rgba(232,244,255,0.95)';
    c.beginPath();
    c.moveTo(q(1.5), q(0.9));
    c.bezierCurveTo(q(1.7), q(3.2), q(0.9), q(5.4), q(-1.6), q(7.0));
    c.stroke();
    c.beginPath();
    c.moveTo(q(-0.1), q(-5.3));
    c.bezierCurveTo(q(0.7), q(-3.2), q(1.4), q(-1.8), q(1.5), q(-0.9));
    c.strokeStyle = 'rgba(255,126,166,0.95)';
    c.stroke();

    // the eye: a band of steel wrapped around the haft
    c.beginPath();
    c.roundRect(q(-2.4), q(-1.5), q(4.0), q(3.0), q(0.5));
    c.lineWidth = u * 0.5;
    c.strokeStyle = '#141019';
    c.stroke();
    const eg = c.createLinearGradient(0, q(1.5), 0, q(-1.5));
    eg.addColorStop(0, '#b6c4dc');
    eg.addColorStop(0.6, '#4b5468');
    eg.addColorStop(1, '#7d5060');
    c.fillStyle = eg;
    c.fill();
    c.restore();

    // ── the grip. A bare fist drawn OVER the haft with the fingers wrapped
    // round it; the rig's own glove is behind the wood and invisible there.
    for (const g of grips) {
      c.beginPath();
      c.ellipse(
        g.x - nx * u * 0.5, g.y - ny * u * 0.5,
        u * 2.05, u * 1.75, Math.atan2(ay, ax), 0, TAU,
      );
      c.lineWidth = u * 0.5;
      c.strokeStyle = '#141019';
      c.stroke();
      const pg2 = c.createLinearGradient(
        g.x + nx * u * 2 + ax * u * 2, g.y + ny * u * 2 + ay * u * 2,
        g.x - nx * u * 2 - ax * u * 2, g.y - ny * u * 2 - ay * u * 2,
      );
      pg2.addColorStop(0, '#e0a074');
      pg2.addColorStop(0.55, '#a4663f');
      pg2.addColorStop(1, '#4e2716');
      c.fillStyle = pg2;
      c.fill();
      for (let i = -1; i <= 1; i++) {
        const fx = g.x + ax * i * u * 1.15;
        const fy = g.y + ay * i * u * 1.15;
        c.beginPath();
        c.moveTo(fx + nx * hw * 1.5, fy + ny * hw * 1.5);
        c.lineTo(fx - nx * hw * 1.1, fy - ny * hw * 1.1);
        c.lineWidth = u * 1.0;
        c.strokeStyle = '#141019';
        c.stroke();
        c.lineWidth = u * 0.7;
        c.strokeStyle = i === -1 ? '#b3714b' : i === 0 ? '#dc9c6e' : '#c8875c';
        c.stroke();
      }
      // thumb, hooked over the top of the haft
      c.beginPath();
      c.moveTo(g.x + nx * hw * 1.3 + ax * u * 1.8, g.y + ny * hw * 1.3 + ay * u * 1.8);
      c.quadraticCurveTo(
        g.x + nx * hw * 2.0 + ax * u * 0.2, g.y + ny * hw * 2.0 + ay * u * 0.2,
        g.x + nx * hw * 0.9 - ax * u * 1.7, g.y + ny * hw * 0.9 - ay * u * 1.7,
      );
      c.lineWidth = u * 1.1;
      c.strokeStyle = '#141019';
      c.stroke();
      c.lineWidth = u * 0.76;
      c.strokeStyle = '#f0b184';
      c.stroke();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The other six — staging
  //
  // Each one is: the game's own rig for the body (so the girth, the leather,
  // the spikes and the tattoo are the roster's), a painted head over the top
  // (so the six are told apart by more than a hat colour), a lighting pass
  // built from where the light in this scene actually is, and a fade into the
  // drift at the boots. Drawn furthest first onto the main context, so each is
  // occluded by the ones in front and all six by the hero.
  // ═══════════════════════════════════════════════════════════════════════════

  function drawCrew() {
    // Nearness comes from SIZE, not from array position: the array is draw
    // order and the two do not always agree — the one tucked at the hero's
    // elbow has to be painted after the one he overlaps, whatever their depths.
    const ks = cfg.crew.map((s) => s.k);
    const lo = Math.min(...ks);
    const hi = Math.max(...ks);
    for (const spec of cfg.crew) {
      drawCrewDwarf(spec, CREW_ART[spec.id], hi > lo ? (spec.k - lo) / (hi - lo) : 1);
    }
  }

  /** @param t 0 = furthest back, 1 = nearest. Drives size, haze, rim and blur. */
  function drawCrewDwarf(spec, art, t) {
    const dwarf = MF.getDwarf(spec.id);
    const style = {
      ...dwarf.style,
      outfit: 1,
      headSize: CREW_RIG_HEAD,
      // The painted head, cap and beard below replace the rig's, so the rig is
      // asked for none of them. `hatless` swaps its cone for flat hair, which
      // is small enough to disappear entirely under the painted skull — that is
      // simpler and safer than trying to strictly contain a second cone.
      beardStyle: 'none',
      shades: false,
      cigar: false,
      // Their leather runs #191b26..#241f2a: legible on a lit mine wall, a hole
      // on a night sky. Lifted a stop each, exactly as the hero's is. The
      // roster's own jacketAccent stays — those studs are per-dwarf identity.
      jacketColor: shade(dwarf.style.jacketColor, 1.36),
      // The roster's accents are a neon set — hot pink, mint, cornflower — and
      // at this size they are loose coloured dots on a dark figure rather than
      // studs. Pulled half-way to the hero's brass they still differ per dwarf
      // and they stop competing with the one hot accent the poster is allowed.
      // ...and then a stop darker again. At full brass the rig's shoulder spike
      // band — seven studs on a hatched strip, drawn to read at 30px — was the
      // brightest object in SILENT D's corner of the card and it read as a
      // gold comb clipped to his shoulder. Dimmed it is texture on leather,
      // which is all it was ever meant to be at this size.
      jacketAccent: shade(mix(dwarf.style.jacketAccent, '#a8762f', 0.76), 0.68),
    };

    const U = cfg.heroU * spec.k;
    const u = U * (style.scale || 1);
    const FACING = -1;
    const drawnHead = (dwarf.style.headSize || 1) * CREW_HEAD;

    const { jp, tp, mid } = boneFrame(art.pose, u);

    // Where the light in this scene is, for real: the pink pool the hero stands
    // in, and the moon. Both rims and the lighting wash are aimed from these,
    // so a dwarf on the left of frame is lit from the opposite side to one on
    // the right. Six figures all rimmed on the same side are six stickers.
    const cx = spec.x;
    const cy = spec.y - 26 * u;
    const dir = (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const l = Math.hypot(dx, dy) || 1;
      return { x: dx / l, y: dy / l };
    };
    const warm = dir(1500, 1180);
    const cold = dir(cfg.moon.x, cfg.moon.y);

    // Contact pool in the snow. Radial, outer stop fully transparent: a shadow
    // whose edge you can trace is a puddle.
    (function contact() {
      const r = 15 * u * (style.girth || 1);
      ctx.save();
      ctx.translate(spec.x, spec.y - 7 * u);
      ctx.scale(1, 0.28);
      const g = ctx.createRadialGradient(0, 0, r * 0.04, 0, 0, r);
      g.addColorStop(0, `rgba(4,3,10,${lerp(0.34, 0.52, t)})`);
      g.addColorStop(0.5, `rgba(4,3,10,${lerp(0.17, 0.28, t)})`);
      g.addColorStop(1, 'rgba(4,3,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    })();

    const L = layer();
    const c = L.x;
    MF.drawCharacter(c, style, art.pose, MF.DWARF_SKELETON, spec.x, spec.y, FACING, {
      scale: U,
      damage: {
        wear: 0,
        breath: 0,
        face: 'calm',
        seed: art.seed,
        blood: 0,
        oil: false,
        hatless: true,
      },
      reducedMotion: true,
    });

    c.save();
    c.translate(spec.x, spec.y);
    c.scale(FACING, 1);
    // The bat goes on before the head: in front of the shoulder it rests on,
    // behind the skull it passes behind.
    if (art.club) drawCrewClub(c, u, jp, tp, mid);
    drawCrewHead(c, art, style, drawnHead, u, jp, tp, mid);
    c.restore();

    // ── Light. Laid over the finished figure so the rig's art and the painted
    // head take exactly the same key and fill.
    c.save();
    c.globalCompositeOperation = 'source-atop';
    const R = 42 * u;
    const kg = c.createLinearGradient(
      cx + warm.x * R, cy + warm.y * R,
      cx + cold.x * R, cy + cold.y * R,
    );
    kg.addColorStop(0, `rgba(255,92,138,${lerp(0.13, 0.3, t).toFixed(3)})`);
    kg.addColorStop(0.48, 'rgba(96,74,150,0.1)');
    kg.addColorStop(1, `rgba(126,164,232,${lerp(0.16, 0.3, t).toFixed(3)})`);
    c.fillStyle = kg;
    c.fillRect(0, 0, W, H);
    // The body, dropped into shadow from the chin down — the same move the hero
    // gets, and for the same reason. The rig's torso art is drawn to read at
    // 30px against a lit mine wall; blown up and lit flat it is a jumble of
    // straps and stud discs that fights the face for attention. Sunk toward
    // black it becomes mass, and the cap and the beard do all the telling.
    const chin = spec.y - 35.5 * u;
    const sink = c.createLinearGradient(0, chin, 0, spec.y - 4 * u);
    sink.addColorStop(0, 'rgba(7,6,14,0)');
    // Shallow at the top so the beards keep their value — they hang well below
    // the chin line and a steep ramp turned six white beards into six dark
    // scarves — and very deep at the bottom, which is where the rig's gloves
    // are and where a lighter core inside an ink outline reads as a hole.
    sink.addColorStop(0.3, 'rgba(7,6,14,0.4)');
    sink.addColorStop(0.62, 'rgba(7,6,14,0.82)');
    sink.addColorStop(1, 'rgba(7,6,14,0.94)');
    c.fillStyle = sink;
    c.fillRect(0, 0, W, H);
    // Atmosphere: everything between him and the camera, thickest at the boots.
    const a0 = lerp(0.24, 0.08, t);
    const hz = c.createLinearGradient(0, spec.y - 54 * u, 0, spec.y);
    hz.addColorStop(0, `rgba(64,56,112,${(a0 * 0.72).toFixed(3)})`);
    hz.addColorStop(1, `rgba(64,56,112,${(a0 * 1.3).toFixed(3)})`);
    c.fillStyle = hz;
    c.fillRect(0, 0, W, H);
    c.restore();

    // ── Boots into the drift. The rig plants a flat-filled contact ellipse at
    // its ground point; the layer is faded to nothing above it so that hard
    // edge never reaches the card, and the fade reads as snow anyway.
    c.save();
    c.globalCompositeOperation = 'destination-in';
    const cutY = spec.y - 9 * u;
    const fd = c.createLinearGradient(0, cutY - 7 * u - 24, 0, cutY);
    fd.addColorStop(0, 'rgba(0,0,0,1)');
    fd.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = fd;
    c.fillRect(0, 0, W, H);
    c.restore();

    // ── Separation. A silver edge toward the moon, a pink one toward the
    // hero's pool, and depth-of-field blur on the ones furthest back.
    const push = 3 + 5 * t;
    const coldSil = silhouette(L.c, '#cfe0ff');
    const pinkSil = silhouette(L.c, '#ff7ba5');
    ctx.save();
    ctx.filter = `blur(${lerp(1.8, 0.4, t).toFixed(2)}px)`;
    ctx.globalAlpha = lerp(0.28, 0.5, t);
    ctx.drawImage(coldSil, cold.x * push, cold.y * push);
    ctx.globalAlpha = lerp(0.18, 0.4, t);
    ctx.drawImage(pinkSil, warm.x * push, warm.y * push);
    ctx.globalAlpha = 1;
    ctx.drawImage(L.c, 0, 0);
    ctx.restore();
  }

  /**
   * SILENT D's bat, raised. Three passes, because a fist ADJACENT to a haft is
   * never a fist holding one: the far fingers, then the bat drawn THROUGH them,
   * then the near fingers curled over the front with a contact shadow.
   */
  function drawCrewClub(c, u, jp, tp, mid) {
    const wrist = jp('handR');
    const knuck = tp('handR');
    const l = Math.hypot(knuck.x - wrist.x, knuck.y - wrist.y) || 1;
    const ax = (knuck.x - wrist.x) / l;
    const ay = (knuck.y - wrist.y) / l;
    const nx = -ay;
    const ny = ax;
    const g = mid(wrist, knuck, 0.45);
    const butt = { x: g.x - ax * u * 3.0, y: g.y - ay * u * 3.0 };
    const tip = { x: g.x + ax * u * 13.0, y: g.y + ay * u * 13.0 };
    const ow = Math.max(1, u * 0.16);

    // (a) the far fingers, behind the wood
    c.lineCap = 'round';
    c.strokeStyle = '#7a4a2c';
    c.lineWidth = u * 0.9;
    for (let i = -1; i <= 1; i++) {
      c.beginPath();
      c.moveTo(g.x + ax * i * u * 0.95 + nx * u * 0.9, g.y + ay * i * u * 0.95 + ny * u * 0.9);
      c.lineTo(g.x + ax * i * u * 0.95 - nx * u * 1.0, g.y + ay * i * u * 0.95 - ny * u * 1.0);
      c.stroke();
    }

    // (b) the bat itself, passing through the grip — a tapered club, thin at
    // the butt and heavy at the business end.
    c.beginPath();
    c.moveTo(butt.x + nx * u * 0.5, butt.y + ny * u * 0.5);
    c.lineTo(tip.x + nx * u * 1.35, tip.y + ny * u * 1.35);
    c.quadraticCurveTo(
      tip.x + ax * u * 1.5, tip.y + ay * u * 1.5,
      tip.x - nx * u * 1.35, tip.y - ny * u * 1.35,
    );
    c.lineTo(butt.x - nx * u * 0.5, butt.y - ny * u * 0.5);
    c.quadraticCurveTo(
      butt.x - ax * u * 0.7, butt.y - ay * u * 0.7,
      butt.x + nx * u * 0.5, butt.y + ny * u * 0.5,
    );
    c.closePath();
    const wg = c.createLinearGradient(
      butt.x + nx * u * 1.4, butt.y + ny * u * 1.4,
      butt.x - nx * u * 1.4, butt.y - ny * u * 1.4,
    );
    wg.addColorStop(0, '#8a5a2c');
    wg.addColorStop(0.5, '#4e2f18');
    wg.addColorStop(1, '#25160c');
    c.fillStyle = wg;
    c.fill();
    c.strokeStyle = '#120d13';
    c.lineWidth = ow * 1.5;
    c.stroke();
    // three nails through the head of it, because these dwarfs armed up
    c.fillStyle = '#c8cfdd';
    for (let i = 0; i < 3; i++) {
      const p = { x: tip.x - ax * u * (1.2 + i * 2.0), y: tip.y - ay * u * (1.2 + i * 2.0) };
      c.beginPath();
      c.ellipse(
        p.x + nx * u * 1.1, p.y + ny * u * 1.1,
        u * 0.34, u * 0.2, Math.atan2(ay, ax), 0, TAU,
      );
      c.fill();
    }

    // (c) the near fingers, curled over the front, and the shadow where they
    // press into the wood
    softBlobIn(c, (v) => v * u, (v) => v * u, g.x / u, g.y / u, 2.4, 1.8, '20,12,8', 0.4);
    for (let i = -1; i <= 1; i++) {
      const fx = g.x + ax * i * u * 1.05;
      const fy = g.y + ay * i * u * 1.05;
      c.beginPath();
      c.moveTo(fx + nx * u * 1.5, fy + ny * u * 1.5);
      c.lineTo(fx - nx * u * 0.55, fy - ny * u * 0.55);
      c.lineWidth = u * 1.05;
      c.strokeStyle = '#120d13';
      c.stroke();
      c.lineWidth = u * 0.74;
      c.strokeStyle = i === -1 ? '#b3714b' : i === 0 ? '#dc9c6e' : '#c8875c';
      c.stroke();
    }
    // thumb, hooked across the front of the grip
    c.beginPath();
    c.moveTo(g.x + nx * u * 1.5 + ax * u * 1.5, g.y + ny * u * 1.5 + ay * u * 1.5);
    c.quadraticCurveTo(
      g.x + nx * u * 2.1, g.y + ny * u * 2.1,
      g.x + nx * u * 1.0 - ax * u * 1.5, g.y + ny * u * 1.0 - ay * u * 1.5,
    );
    c.lineWidth = u * 1.1;
    c.strokeStyle = '#120d13';
    c.stroke();
    c.lineWidth = u * 0.76;
    c.strokeStyle = '#f0b184';
    c.stroke();
  }

  // ── The face ──────────────────────────────────────────────────────────────
  //
  // Head-local space, exactly the rig's: origin at the middle of the skull,
  // +x is the direction he faces, +y is down. rx/ry are the half-axes.
  // The key light comes from +x (in front of him); the moon from -x, behind.
  //
  // The rig underneath is drawn at cfg.rigHeadSize (0.78) while this is drawn
  // at cfg.headSize (1.06), so everything here is ~36% larger than the 30px
  // face it replaces and containment is comfortable rather than hand-checked.

  /**
   * Diagnostic: the head alone, filling a portrait frame, on a flat ground.
   *
   * The whole point is scale. On the finished card the face is roughly 200px
   * tall, and at that size a nose overlapping an eye socket or a beard swallowing
   * the teeth just reads as "muddy" — which is how both bugs survived several
   * redraws. Here the head is ~1400px and the errors are unmissable.
   *
   * With cfg.guides on, the anatomical bands are overlaid. Every feature owns a
   * band, bands do not overlap, and any shape crossing out of its own band is a
   * bug — that is the whole invariant, and it is checkable by eye in one glance.
   */
  function paintHeadOnly(cfg) {
    const ids =
      cfg.crewHead === 'all'
        ? [cfg.hero, ...cfg.crew.map((s) => s.id)]
        : [cfg.crewHead || cfg.hero];
    const sheet = ids.length > 1;
    const HW = sheet ? 620 : 1400;
    const HH = sheet ? 1160 : 1700;
    const cv = document.getElementById('cv');
    cv.width = HW * ids.length;
    cv.height = HH;
    const c = cv.getContext('2d');
    c.fillStyle = '#2b2f3a';
    c.fillRect(0, 0, cv.width, HH);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    const target = HH * (sheet ? 0.2 : 0.3);
    let last = null;
    ids.forEach((id, i) => {
      // Caps flop BACKWARD, so each head sits right of its cell centre.
      const px = HW * i + HW * (sheet ? 0.6 : 0.5);
      last = drawHeadAt(c, id, px, HH * 0.42, target);
      if (!sheet) return;
      const d = MF.getDwarf(id);
      c.save();
      c.textAlign = 'center';
      c.fillStyle = i === 0 ? '#ffd23f' : '#e6ecf7';
      c.font = '600 34px Lato, sans-serif';
      c.fillText(d.name, HW * i + HW * 0.5, HH - 58);
      c.fillStyle = '#8f9ab0';
      c.font = '500 26px Lato, sans-serif';
      c.fillText(i === 0 ? `${d.bornAs} — the hero` : d.bornAs, HW * i + HW * 0.5, HH - 22);
      c.strokeStyle = 'rgba(255,255,255,0.09)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(HW * (i + 1), 0);
      c.lineTo(HW * (i + 1), HH);
      c.stroke();
      c.restore();
    });

    if (!cfg.guides || sheet) return;

    // Same local frame the head drawing uses, so the bands line up with X()/Y().
    const rx = last.headLen * 0.5 * last.hs * last.K;
    const ry = last.headLen * 0.54 * last.hs * last.K;
    c.save();
    c.translate(HW * 0.5, HH * 0.42);
    // Rotated WITH the head. Drawn upright they measure a tilted face against
    // vertical bands and report collisions that are not there — and miss the
    // ones that are, which on COMA and PATIENT ZERO is most of them.
    c.rotate(last.ang);
    const X = (v) => v * rx;
    const Y = (v) => v * ry;

    // Each feature's band: nothing it draws may leave these bounds. The hero
    // roars, so his mouth band sits lower and his beard lower still; the six
    // behind him are drawn on the tighter, closed-mouth layout.
    const bands = last.crew
      ? [
          ['brow / cap brim', -0.7, -0.34, '#ffd23f'],
          ['eyes', -0.34, 0.04, '#4dd2ff'],
          ['nose', 0.04, 0.52, '#7cff9e'],
          ['mouth', 0.5, 0.98, '#ff5c8d'],
          ['beard', 0.52, 2.6, '#c08cff'],
        ]
      : [
          ['brow / hat brim', -0.95, -0.42, '#ffd23f'],
          ['eyes', -0.4, 0.2, '#4dd2ff'],
          ['nose', 0.06, 0.52, '#7cff9e'],
          ['mouth + teeth', 0.54, 1.02, '#ff5c8d'],
          ['beard', 1.04, 2.2, '#c08cff'],
        ];
    c.font = '600 26px Lato, sans-serif';
    c.textBaseline = 'middle';
    for (const [label, y0, y1, col] of bands) {
      c.fillStyle = col + '1f';
      c.fillRect(X(-1.35), Y(y0), X(2.7), Y(y1 - y0));
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.setLineDash([10, 8]);
      c.beginPath();
      c.moveTo(X(-1.35), Y(y0));
      c.lineTo(X(1.35), Y(y0));
      c.moveTo(X(-1.35), Y(y1));
      c.lineTo(X(1.35), Y(y1));
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = col;
      c.fillText(label, X(1.38), Y((y0 + y1) / 2));
    }
    // Vertical centre line: the face must not be accidentally symmetric, but
    // the eyes do have to sit level either side of it.
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, Y(-1.6));
    c.lineTo(0, Y(2.3));
    c.stroke();
    c.restore();
  }

  /**
   * Everything one head needs, resolved off the card's REAL rig geometry.
   *
   * Synthesising a head bone for the diagnostic would be wrong: almost every
   * detail (outline weight, the cap, the stud strip) scales off `u` while the
   * face scales off headLen, so a made-up headLen:u ratio silently distorts the
   * very thing being inspected. The card and the diagnostic share this.
   */
  function headRig(id) {
    const crew = id !== cfg.hero;
    const dwarf = MF.getDwarf(id);
    const art = crew ? CREW_ART[id] : null;
    const style = {
      ...dwarf.style,
      outfit: 1,
      headSize: crew ? CREW_RIG_HEAD : cfg.rigHeadSize,
      beardStyle: 'none',
      shades: false,
      cigar: false,
    };
    const k = crew ? (cfg.crew.find((s) => s.id === id) ?? { k: 0.44 }).k : 1;
    const u = cfg.heroU * k * (style.scale || 1);
    const frame = boneFrame(crew ? art.pose : HERO_POSE, u);
    const hb = frame.jp('head');
    const ht = frame.tp('head');
    return {
      ...frame,
      crew,
      art,
      style,
      u,
      hs: crew ? (dwarf.style.headSize || 1) * CREW_HEAD : cfg.headSize,
      headLen: Math.hypot(ht.x - hb.x, ht.y - hb.y) || u,
      ctr: frame.mid(hb, ht, 0.46),
      ang: Math.atan2(ht.y - hb.y, ht.x - hb.x) + Math.PI / 2,
    };
  }

  /** Magnifies one head to `target` head-bone pixels, centred at (px, py). */
  function drawHeadAt(c, id, px, py, target) {
    const R = headRig(id);
    const K = target / R.headLen;
    c.save();
    c.translate(px, py);
    c.scale(K, K);
    c.translate(-R.ctr.x, -R.ctr.y);
    if (R.crew) drawCrewHead(c, R.art, R.style, R.hs, R.u, R.jp, R.tp, R.mid);
    else drawDwarfHead(c, R.style, R.u, R.jp, R.tp, R.mid);
    c.restore();
    return { ...R, K };
  }

  // NOTE: this is the hand-repaired hero face the user signed off on
  // ("ok now it's good"). A later pass restyled it and reintroduced a flat
  // wedge nose, a pink tube tip and a hard-edged specular — REDRAW-RULES 2.
  // It was restored verbatim. Do not restyle it without being asked.
  function drawDwarfHead(c, st, u, jp, tp, mid) {
    const base = jp('head');
    const top = tp('head');
    const headLen = Math.hypot(top.x - base.x, top.y - base.y) || u;
    const hs = cfg.headSize;
    const ctr = mid(base, top, 0.46);
    const rx = headLen * 0.5 * hs;
    const ry = headLen * 0.54 * hs;
    const ang = Math.atan2(top.y - base.y, top.x - base.x) + Math.PI / 2;

    const SKIN = '#d9925f';
    const SKIN_LIT = '#ffd6a4';
    const SKIN_DK = '#8a441f';
    const SKIN_DEEP = '#3e1a0e';
    const HAIR = '#cfc4b4';
    const HAIR_DK = '#57504a';
    const HAIR_LIT = '#fff6e8';
    const INK = '#120d13';
    const ow = Math.max(1.2, u * 0.14);

    c.save();
    c.translate(ctr.x, ctr.y);
    c.rotate(ang);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    const X = (v) => v * rx;
    const Y = (v) => v * ry;

    /**
     * A shadow with no edge.
     *
     * Every soft form on this face used to be a flat-filled c.ellipse(), and a
     * filled ellipse has a hard boundary — so on a cheek it does not read as
     * shading, it reads as a rounded object sitting on the skin. That is what
     * put a second nose beside the first: the nose-mass shadow at X(0.56) was a
     * crisp dark ellipse right next to the actual nose, and the eye picks the
     * two contours as two lumps. Radial falloff to fully transparent fixes it
     * at the source, so there is no contour to read.
     */
    function softBlob(cxu, cyu, rxu, ryu, rgb, a) {
      const bx = X(rxu);
      const by = Y(ryu);
      c.save();
      c.translate(X(cxu), Y(cyu));
      c.scale(1, by / bx);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, bx);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(0.5, `rgba(${rgb},${a * 0.66})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = g;
      c.fillRect(-bx, -bx, bx * 2, bx * 2);
      c.restore();
    }

    // ── Hair escaping at the back of the cap. Drawn first so the skull sits on
    // top of it; the rig's own tufts are all inside X(-0.72) at this ratio.
    for (const [hx, hy, hrx, hry, hr] of [
      [-0.78, -0.30, 0.34, 0.26, 0.55],
      [-0.86, 0.10, 0.30, 0.24, -0.05],
      [-0.66, 0.44, 0.30, 0.24, -0.55],
    ]) {
      c.beginPath();
      c.ellipse(X(hx), Y(hy), X(hrx), Y(hry), hr, 0, TAU);
      c.fillStyle = HAIR_DK;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = ow * 0.8;
      c.stroke();
    }
    c.beginPath();
    c.ellipse(X(-0.72), Y(0.04), X(0.32), Y(0.4), -0.28, 0, TAU);
    c.fillStyle = SKIN_DK;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow;
    c.stroke();

    // ── The skull. An ellipse first, purely to guarantee coverage of the rig's,
    // then the shaped one on top: cranium, brow, cheekbone, jaw, chin.
    c.beginPath();
    c.ellipse(0, 0, rx * 1.02, ry * 1.02, 0, 0, TAU);
    c.fillStyle = SKIN;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.6;
    c.stroke();

    function skullPath() {
      c.beginPath();
      c.moveTo(X(-1.02), Y(-0.06));
      c.bezierCurveTo(X(-1.06), Y(-0.76), X(-0.58), Y(-1.06), X(0.18), Y(-1.04));
      c.bezierCurveTo(X(0.74), Y(-1.02), X(1.02), Y(-0.7), X(1.06), Y(-0.34));
      c.bezierCurveTo(X(1.1), Y(-0.14), X(1.06), Y(0.0), X(0.99), Y(0.14));
      c.bezierCurveTo(X(0.98), Y(0.48), X(0.8), Y(0.86), X(0.4), Y(1.02));
      c.bezierCurveTo(X(0.0), Y(1.18), X(-0.56), Y(1.0), X(-0.84), Y(0.66));
      c.bezierCurveTo(X(-0.99), Y(0.44), X(-1.02), Y(0.18), X(-1.02), Y(-0.06));
      c.closePath();
    }
    skullPath();
    const sg = c.createRadialGradient(X(0.62), Y(-0.3), X(0.05), X(0.2), Y(0.2), X(1.7));
    sg.addColorStop(0, SKIN_LIT);
    sg.addColorStop(0.3, SKIN);
    sg.addColorStop(0.7, SKIN_DK);
    sg.addColorStop(1, SKIN_DEEP);
    c.fillStyle = sg;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.6;
    c.stroke();

    c.save();
    skullPath();
    c.clip();

    // cool moonlight bounce down the back of the head
    const cool = c.createLinearGradient(X(-1.05), 0, X(-0.05), 0);
    cool.addColorStop(0, 'rgba(126,158,222,0.5)');
    cool.addColorStop(1, 'rgba(126,158,222,0)');
    c.fillStyle = cool;
    c.fillRect(X(-1.1), Y(-1.3), X(1.05), Y(2.6));

    // the shadow the cap's brim throws across the forehead
    const bs = c.createLinearGradient(0, Y(-1.06), 0, Y(-0.4));
    bs.addColorStop(0, 'rgba(38,14,20,0.95)');
    bs.addColorStop(0.6, 'rgba(38,14,20,0.4)');
    bs.addColorStop(1, 'rgba(38,14,20,0)');
    c.fillStyle = bs;
    c.fillRect(X(-1.1), Y(-1.1), X(2.2), Y(0.72));

    // brow ridge: a lit shelf, and the hard shadow underneath it is the thing
    // that turns a painted oval into a head with bone in it.
    c.beginPath();
    c.moveTo(X(-0.66), Y(-0.5));
    c.bezierCurveTo(X(-0.2), Y(-0.74), X(0.6), Y(-0.72), X(1.0), Y(-0.36));
    c.bezierCurveTo(X(0.88), Y(-0.22), X(0.54), Y(-0.4), X(0.16), Y(-0.38));
    c.bezierCurveTo(X(-0.18), Y(-0.36), X(-0.46), Y(-0.32), X(-0.66), Y(-0.5));
    c.closePath();
    c.fillStyle = 'rgba(255,214,176,0.42)';
    c.fill();
    c.beginPath();
    c.ellipse(X(-0.02), Y(-0.26), X(0.64), Y(0.17), -0.08, 0, TAU);
    c.fillStyle = 'rgba(62,26,14,0.32)';
    c.fill();

    // the core shadow: the band where the head turns away from the key, before
    // the moon picks it up again at the very back
    c.beginPath();
    c.ellipse(X(-0.46), Y(0.14), X(0.5), Y(0.9), 0.06, 0, TAU);
    c.fillStyle = 'rgba(62,26,14,0.34)';
    c.fill();
    // the plane of the near cheek, catching the key
    c.beginPath();
    c.ellipse(X(0.62), Y(0.42), X(0.3), Y(0.24), -0.35, 0, TAU);
    c.fillStyle = 'rgba(255,196,150,0.2)';
    c.fill();
    // and the temple falling into shade behind it
    c.beginPath();
    c.ellipse(X(-0.72), Y(-0.34), X(0.3), Y(0.42), 0.1, 0, TAU);
    c.fillStyle = 'rgba(62,26,14,0.34)';
    c.fill();
    c.restore();

    // frown creases: two short gouges driven up between the brows. On a face
    // this stylised they do more for the scowl than the eyes do.
    c.strokeStyle = 'rgba(62,26,14,0.9)';
    c.lineWidth = ow * 1.05;
    c.beginPath();
    c.moveTo(X(-0.12), Y(-0.54));
    c.lineTo(X(-0.04), Y(-0.24));
    c.moveTo(X(0.04), Y(-0.54));
    c.lineTo(X(0.1), Y(-0.26));
    c.stroke();

    // ═════════════════════════════════════════════════════════════════════════
    // Eyes. Narrow, because a circle with an iris in it is a friendly dwarf and
    // this one is not. The inner corner (toward the nose, higher x on the near
    // eye) sits LOWER than the outer one: that downward slope is the scowl.
    // ═════════════════════════════════════════════════════════════════════════

    function eye(ex, ey, w, h, inward) {
      c.save();
      c.translate(X(ex), Y(ey));
      // socket
      c.beginPath();
      c.ellipse(0, h * 0.15, w * 1.45, h * 2.0, 0, 0, TAU);
      c.fillStyle = 'rgba(62,26,14,0.5)';
      c.fill();

      const s = inward;
      function lens() {
        c.beginPath();
        c.moveTo(-w * s, -h * 0.06);
        c.quadraticCurveTo(0, -h * 1.5, w * s, h * 0.2);
        c.quadraticCurveTo(0, h * 1.45, -w * s, -h * 0.06);
        c.closePath();
      }
      lens();
      c.fillStyle = '#f6ead6';
      c.fill();
      c.save();
      c.clip();
      // iris, small and hard: he is staring at one specific person
      const icx = w * s * 0.34;
      const icy = h * 0.14;
      c.beginPath();
      c.arc(icx, icy, h * 0.95, 0, TAU);
      const ig = c.createRadialGradient(icx - h * 0.3, icy - h * 0.4, h * 0.08, icx, icy, h * 0.95);
      ig.addColorStop(0, '#b57a2f');
      ig.addColorStop(0.55, '#5c3312');
      ig.addColorStop(1, '#1a0d04');
      c.fillStyle = ig;
      c.fill();
      c.beginPath();
      c.arc(icx, icy, h * 0.42, 0, TAU);
      c.fillStyle = '#0d0705';
      c.fill();
      // the moon in one corner, the neon in the other
      c.beginPath();
      c.arc(icx - h * 0.42, icy - h * 0.5, h * 0.3, 0, TAU);
      c.fillStyle = '#ffffff';
      c.fill();
      c.beginPath();
      c.arc(icx + h * 0.6, icy + h * 0.42, h * 0.19, 0, TAU);
      c.fillStyle = 'rgba(255,124,168,0.95)';
      c.fill();
      // the lid's own shadow, dropped onto the eyeball
      const ls = c.createLinearGradient(0, -h * 1.5, 0, h * 0.2);
      ls.addColorStop(0, 'rgba(48,18,10,0.9)');
      ls.addColorStop(1, 'rgba(48,18,10,0)');
      c.fillStyle = ls;
      c.fillRect(-w * 2, -h * 1.8, w * 4, h * 2.2);
      c.restore();
      // the lid line: heavy on top, light underneath. Weight is expression.
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.9;
      c.beginPath();
      c.moveTo(-w * s, -h * 0.06);
      c.quadraticCurveTo(0, -h * 1.5, w * s, h * 0.2);
      c.stroke();
      c.lineWidth = ow * 1.0;
      c.beginPath();
      c.moveTo(w * s, h * 0.2);
      c.quadraticCurveTo(0, h * 1.45, -w * s, -h * 0.06);
      c.stroke();
      c.restore();
    }
    // Pulled well back off the nose. Every earlier layout had the near eye's
    // inner corner underneath the nose ball, and two pale shapes overlapping is
    // what turned the front of the face into a lump.
    eye(0.34, -0.13, X(0.25), Y(0.155), 1);
    eye(-0.42, -0.12, X(0.21), Y(0.13), 1);

    // ── eyebrows. Drawn as closed curves, not quads: a first pass built them
    // out of straight-sided wedges and they read as two sticking plasters.
    // A brow tapers at the outer tail, thickens over the eye and is driven
    // down to a blunt end at the nose — that downward end IS the scowl.
    function brow(curve, lit) {
      function path() {
        c.beginPath();
        c.moveTo(X(curve[0][0]), Y(curve[0][1]));
        for (let i = 1; i < curve.length; i += 3) {
          c.bezierCurveTo(
            X(curve[i][0]), Y(curve[i][1]),
            X(curve[i + 1][0]), Y(curve[i + 1][1]),
            X(curve[i + 2][0]), Y(curve[i + 2][1]),
          );
        }
        c.closePath();
      }
      path();
      const g = c.createLinearGradient(X(curve[0][0]), Y(curve[0][1] - 0.16), X(curve[0][0]), Y(curve[0][1] + 0.2));
      g.addColorStop(0, lit ? HAIR_LIT : '#b0a698');
      g.addColorStop(1, lit ? '#9a9081' : '#67604f');
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.5;
      c.stroke();
      c.save();
      path();
      c.clip();
      c.strokeStyle = 'rgba(66,58,48,0.45)';
      c.lineWidth = ow * 0.5;
      for (let i = 0; i < 11; i++) {
        const t = i / 10;
        const bx = lerp(curve[0][0], curve[3][0], t);
        const by = lerp(curve[0][1], curve[3][1], t) - 0.1;
        c.beginPath();
        c.moveTo(X(bx - 0.03), Y(by));
        c.lineTo(X(bx + 0.07), Y(by + 0.26));
        c.stroke();
      }
      c.restore();
    }
    // near brow: a thin tail at the temple, driven down over the nose
    brow([
      [-0.14, -0.62],
      [0.1, -0.75], [0.42, -0.69], [0.62, -0.46],
      [0.68, -0.39], [0.64, -0.26], [0.54, -0.31],
      [0.36, -0.44], [0.1, -0.5], [-0.08, -0.47],
      [-0.16, -0.48], [-0.18, -0.58], [-0.14, -0.62],
    ], true);
    // far brow, same slope, smaller, further back
    brow([
      [-0.92, -0.44],
      [-0.8, -0.57], [-0.56, -0.55], [-0.36, -0.38],
      [-0.31, -0.33], [-0.32, -0.24], [-0.4, -0.28],
      [-0.54, -0.38], [-0.72, -0.39], [-0.88, -0.35],
      [-0.94, -0.36], [-0.95, -0.41], [-0.92, -0.44],
    ], false);

    // ── The nose. It is a potato, it protrudes past the skull, and it is the
    // one feature that fixes which way this face is pointing.
    softBlob(0.56, 0.52, 0.30, 0.15, '70,28,16', 0.5);
    // The mass is FILLED but only its outer contour is stroked. Closing the
    // outline round the back of it — which is what the first three passes did —
    // draws a lens on the cheek, and a lens on a cheek is not a nose, it is a
    // pale disc glued to the side of a head.
    // It has to break the profile by a mile. Kept flush with the cheek — which
    // is where three earlier passes left it — it reads as a lit jowl, not a
    // nose: the tip lands at 1.42 of the skull half-width, well outside the
    // skull's own 1.06, so the silhouette itself says NOSE before any shading
    // gets a chance to.
    // ONE definition of the nose. The fill and the outline used to be two
    // separate literal paths, and when the nose was resized only the outline
    // was updated — leaving a large filled lump reaching X(1.28) with a smaller
    // outlined nose stroked across the middle of it. That is a second nose, and
    // no amount of shadow tuning could remove it. nosePath() now closes over
    // noseFront(), so the two cannot drift apart again.
    function noseFront() {
      c.beginPath();
      c.moveTo(X(0.04), Y(0.06));
      c.bezierCurveTo(X(0.38), Y(0.06), X(0.80), Y(0.10), X(0.97), Y(0.28));
      c.bezierCurveTo(X(1.08), Y(0.43), X(0.90), Y(0.59), X(0.65), Y(0.55));
    }
    function nosePath() {
      noseFront();
      c.bezierCurveTo(X(0.42), Y(0.52), X(0.16), Y(0.38), X(0.04), Y(0.24));
      c.closePath();
    }
    nosePath();
    const ng = c.createRadialGradient(X(0.88), Y(0.22), X(0.04), X(0.86), Y(0.30), X(0.62));
    ng.addColorStop(0, '#ffdcb0');
    ng.addColorStop(0.4, '#d9884f');
    ng.addColorStop(1, '#84401c');
    c.fillStyle = ng;
    c.fill();
    noseFront();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.6;
    c.stroke();
    // the bridge: one soft line from between the brows onto the top of the ball
    c.beginPath();
    c.moveTo(X(-0.1), Y(-0.24));
    c.quadraticCurveTo(X(-0.02), Y(-0.1), X(0.06), Y(0.04));
    c.strokeStyle = 'rgba(96,42,24,0.45)';
    c.lineWidth = ow * 0.9;
    c.stroke();
    // the lit plane along the bridge
    c.beginPath();
    c.ellipse(X(0.86), Y(0.20), X(0.11), Y(0.10), -0.4, 0, TAU);
    c.fillStyle = 'rgba(255,244,228,0.7)';
    c.fill();
    // and the neon kissing the very tip
    c.beginPath();
    c.ellipse(X(1.01), Y(0.40), X(0.045), Y(0.085), -0.1, 0, TAU);
    c.fillStyle = 'rgba(255,112,158,0.85)';
    c.fill();
    // one flared nostril
    c.beginPath();
    c.ellipse(X(0.89), Y(0.50), X(0.075), Y(0.045), 0.3, 0, TAU);
    c.fillStyle = '#3e1a0e';
    c.fill();
    // the shadow it throws back across the cheek, and the one it drops onto the
    // upper lip — that second one is what stops the nose and the moustache
    // running together into one pale lump, which is what they did before.
    softBlob(0.2, 0.44, 0.24, 0.2, '102,44,26', 0.36);
    // Softer, and narrower than the nose above it, so it stays a cast shadow
    // rather than becoming an edge of its own.
    softBlob(0.66, 0.64, 0.22, 0.07, '52,20,12', 0.34);

    // NO jaw-plane shape here. There used to be a closed rounded form spanning
    // X(0.22..0.90), Y(0.36..1.06) — added to stop a then-flat nose merging into
    // the cheek. Now that the nose is smaller and carries its own outline and
    // rim light, that shape is a second rounded mass sitting right beside the
    // first, and the face reads as having two noses. The value break it provided
    // is done instead by a soft directional wash with no closed contour.
    const jaw = c.createLinearGradient(X(0.1), Y(0.3), X(0.7), Y(1.05));
    jaw.addColorStop(0, 'rgba(96,40,22,0)');
    jaw.addColorStop(1, 'rgba(96,40,22,0.26)');
    c.save();
    skullPath();
    c.clip();
    c.fillStyle = jaw;
    c.fillRect(X(-1.2), Y(0.2), X(2.4), Y(1.1));
    c.restore();

    // ── cheek, flushed with effort
    softBlob(-0.14, 0.42, 0.3, 0.13, '206,88,96', 0.17);

    // ═════════════════════════════════════════════════════════════════════════
    // The beard, then the roar punched straight through it, then the moustache
    // over the top lip. That order is the gag on this cast: a dwarf yelling
    // into his own whiskers, and a mouth drawn UNDER them is no expression.
    //
    // It is narrower and a stop darker than a white beard wants to be, for two
    // reasons: a pale mass wider than his chest hides the studded jacket the
    // whole game is about, and at thumbnail size it out-shouted his own face.
    // ═════════════════════════════════════════════════════════════════════════

    // Scalloped along the bottom, not notched. A first pass cut two V-notches
    // to make the fork and they read as tears in a paper bib; a row of soft
    // lock-tips reads as hair and still gives the silhouette some teeth.
    function beardPath() {
      c.beginPath();
      c.moveTo(X(-0.74), Y(0.26));
      c.bezierCurveTo(X(-0.96), Y(0.74), X(-1.02), Y(1.18), X(-0.9), Y(1.5));
      c.quadraticCurveTo(X(-0.78), Y(1.86), X(-0.54), Y(1.62));
      c.quadraticCurveTo(X(-0.44), Y(2.0), X(-0.16), Y(1.78));
      c.quadraticCurveTo(X(-0.02), Y(2.14), X(0.22), Y(1.8));
      c.quadraticCurveTo(X(0.38), Y(2.0), X(0.5), Y(1.5));
      // The near-side top edge stops at Y(0.78), tucked under the moustache and
      // inboard of the nose. It used to climb to X(0.94), Y(0.44) — level with
      // the nose tip at X(1.08), Y(0.43) — so the whiskers came up ALONGSIDE the
      // end of the nose and the two masses read as one lump with a notch in it.
      // Cheeks are bare above this line; a beard does not grow up the nose.
      c.bezierCurveTo(X(0.70), Y(1.14), X(0.86), Y(0.94), X(0.88), Y(0.78));
      c.bezierCurveTo(X(0.89), Y(0.71), X(0.84), Y(0.67), X(0.78), Y(0.70));
      c.bezierCurveTo(X(0.50), Y(0.96), X(-0.28), Y(0.84), X(-0.74), Y(0.26));
      c.closePath();
    }

    beardPath();
    const bg = c.createLinearGradient(X(0.94), Y(0.42), X(-0.86), Y(1.9));
    bg.addColorStop(0, '#eee4d2');
    bg.addColorStop(0.13, '#c2b7a6');
    bg.addColorStop(0.42, '#7b7266');
    bg.addColorStop(0.72, '#413b34');
    bg.addColorStop(1, '#1c1a18');
    c.fillStyle = bg;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.7;
    c.stroke();

    c.save();
    beardPath();
    c.clip();
    // the shadow the jaw throws into the top of it
    const js = c.createLinearGradient(0, Y(0.28), 0, Y(1.2));
    js.addColorStop(0, 'rgba(40,28,20,0.95)');
    js.addColorStop(1, 'rgba(40,28,20,0)');
    c.fillStyle = js;
    c.fillRect(X(-1.2), Y(0.22), X(2.4), Y(1.0));
    // cool moonlight down the far side, warm key down the near edge
    const bcool = c.createLinearGradient(X(-0.96), 0, X(-0.1), 0);
    bcool.addColorStop(0, 'rgba(126,160,225,0.6)');
    bcool.addColorStop(1, 'rgba(126,160,225,0)');
    c.fillStyle = bcool;
    c.fillRect(X(-1.1), Y(0.2), X(1.0), Y(2.2));
    const bwarm = c.createLinearGradient(X(0.94), 0, X(0.3), 0);
    bwarm.addColorStop(0, 'rgba(255,166,190,0.45)');
    bwarm.addColorStop(1, 'rgba(255,166,190,0)');
    c.fillStyle = bwarm;
    c.fillRect(X(0.3), Y(0.2), X(0.68), Y(2.2));

    // locks: clump edges, each one a dark valley with a lit ridge beside it,
    // which is what stops the mass reading as corduroy.
    const LOCKS = [
      [-0.46, 0.7, -0.66, 1.2, -0.72, 1.56],
      [-0.14, 0.78, -0.28, 1.16, -0.36, 1.62],
      [0.16, 0.76, 0.06, 1.2, 0.02, 1.76],
      [0.5, 0.66, 0.46, 1.12, 0.3, 1.72],
      [0.78, 0.56, 0.76, 0.92, 0.62, 1.34],
    ];
    for (const [ax, ay, bx, by, cx2, cy2] of LOCKS) {
      c.beginPath();
      c.moveTo(X(ax), Y(ay));
      c.bezierCurveTo(X(bx), Y(by), X(bx), Y(by), X(cx2), Y(cy2));
      c.lineWidth = ow * 3.2;
      c.strokeStyle = 'rgba(28,23,18,0.5)';
      c.stroke();
      c.lineWidth = ow * 1.1;
      c.strokeStyle = 'rgba(255,246,232,0.4)';
      c.stroke();
    }
    // a few finer strands between them
    for (let i = 0; i < 16; i++) {
      const t = (i + 0.5) / 16;
      const sx = lerp(X(-0.66), X(0.86), t);
      const sy = lerp(Y(0.76), Y(0.5), Math.abs(t - 0.5) * 2);
      const drop = Y(0.5 + 1.0 * Math.sin(t * Math.PI)) * (0.7 + 0.5 * hash01(i * 31));
      const bend = X(-0.3 + 0.42 * t);
      c.beginPath();
      c.moveTo(sx, sy);
      c.bezierCurveTo(
        sx + bend * 0.2, sy + drop * 0.45,
        sx + bend * 0.7, sy + drop * 0.78,
        sx + bend, sy + drop,
      );
      c.lineWidth = ow * (0.36 + 0.34 * hash01(i * 17));
      c.strokeStyle = i % 3 === 0 ? 'rgba(255,246,232,0.34)' : 'rgba(52,44,36,0.36)';
      c.stroke();
    }
    c.restore();

    // ── The roar, punched through the whiskers. Wide, not round: an O is
    // surprise and this has to be a shout.
    function maw() {
      c.beginPath();
      c.moveTo(X(0.7), Y(1.06));
      c.bezierCurveTo(X(0.46), Y(0.96), X(0.08), Y(1.0), X(-0.12), Y(1.16));
      c.bezierCurveTo(X(-0.16), Y(1.52), X(0.12), Y(1.8), X(0.44), Y(1.7));
      c.bezierCurveTo(X(0.64), Y(1.62), X(0.74), Y(1.36), X(0.7), Y(1.06));
      c.closePath();
    }
    maw();
    c.fillStyle = '#2a0a11';
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.7;
    c.stroke();
    c.save();
    maw();
    c.clip();
    // Upper teeth as one band with notches cut in it — five separate white
    // rectangles read as a picket fence at any size.
    c.beginPath();
    c.moveTo(X(0.72), Y(0.96));
    c.bezierCurveTo(X(0.44), Y(0.86), X(0.04), Y(0.9), X(-0.16), Y(1.08));
    c.lineTo(X(-0.16), Y(1.26));
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      c.quadraticCurveTo(
        X(lerp(-0.08, 0.66, t)), Y(lerp(1.36, 1.24, t)),
        X(lerp(0.0, 0.74, t)), Y(lerp(1.24, 1.12, t)),
      );
    }
    c.closePath();
    c.fillStyle = '#f6ecd9';
    c.fill();
    c.strokeStyle = 'rgba(120,86,70,0.5)';
    c.lineWidth = ow * 0.5;
    c.stroke();
    // the lower jaw, dropped, catching a little light
    c.beginPath();
    c.moveTo(X(-0.12), Y(1.66));
    c.bezierCurveTo(X(0.14), Y(1.54), X(0.44), Y(1.5), X(0.66), Y(1.54));
    c.lineTo(X(0.7), Y(1.82));
    c.lineTo(X(-0.16), Y(1.82));
    c.closePath();
    c.fillStyle = '#d9cdb8';
    c.fill();
    c.beginPath();
    c.ellipse(X(0.24), Y(1.5), X(0.24), Y(0.14), -0.1, 0, TAU);
    c.fillStyle = '#a8353f';
    c.fill();
    const ms = c.createLinearGradient(0, Y(1.06), 0, Y(1.52));
    ms.addColorStop(0, 'rgba(0,0,0,0.6)');
    ms.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = ms;
    c.fillRect(X(-0.26), Y(1.16), X(1.1), Y(0.5));
    c.restore();

    // ── The moustache, sitting on the top lip and draping past the near corner
    // of the mouth. Shorter than it was: the old one ran the whole width of the
    // beard and buried the teeth.
    c.beginPath();
    // Top edge starts at Y(0.74), clear of the nose base at Y(0.59). That 0.15
    // gap is the fix for the tache appearing to float on top of the nose: the
    // two shapes used to share Y(0.54)–Y(0.74) and read as one pale lump.
    c.moveTo(X(0.94), Y(0.76));
    c.bezierCurveTo(X(0.98), Y(0.96), X(0.82), Y(1.02), X(0.5), Y(1.06));
    c.bezierCurveTo(X(0.28), Y(1.08), X(0.06), Y(1.12), X(-0.14), Y(1.2));
    c.bezierCurveTo(X(-0.18), Y(0.98), X(0.1), Y(0.86), X(0.46), Y(0.8));
    c.bezierCurveTo(X(0.72), Y(0.77), X(0.88), Y(0.72), X(0.94), Y(0.76));
    c.closePath();
    const mg2 = c.createLinearGradient(X(0.92), Y(0.78), X(-0.16), Y(1.18));
    mg2.addColorStop(0, '#f4ead8');
    mg2.addColorStop(0.35, '#b6ab9b');
    mg2.addColorStop(1, '#3f3a34');
    c.fillStyle = mg2;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.7;
    c.stroke();
    c.strokeStyle = 'rgba(74,66,56,0.55)';
    c.lineWidth = ow * 0.55;
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      c.beginPath();
      c.moveTo(X(lerp(0.90, 0.34, t)), Y(lerp(0.82, 0.90, t)));
      c.quadraticCurveTo(
        X(lerp(0.88, 0.16, t)), Y(lerp(0.98, 1.08, t)),
        X(lerp(0.74, -0.04, t)), Y(lerp(1.06, 1.17, t)),
      );
      c.stroke();
    }

    // ── The two rims that separate the head from the night. Cold moon down the
    // back of the skull and the beard, hot key down the brow, nose and lip.
    c.strokeStyle = 'rgba(200,222,255,0.85)';
    c.lineWidth = ow * 1.15;
    c.beginPath();
    c.moveTo(X(-0.42), Y(-1.0));
    c.bezierCurveTo(X(-0.76), Y(-0.9), X(-1.06), Y(-0.6), X(-1.02), Y(-0.06));
    c.bezierCurveTo(X(-1.0), Y(0.1), X(-0.88), Y(0.2), X(-0.74), Y(0.26));
    c.moveTo(X(-0.74), Y(0.3));
    c.bezierCurveTo(X(-0.92), Y(0.74), X(-0.98), Y(1.14), X(-0.9), Y(1.5));
    c.stroke();

    c.strokeStyle = 'rgba(255,138,178,0.8)';
    c.lineWidth = ow * 1.0;
    c.beginPath();
    // These MUST track noseFront() exactly. They were left on the old, larger
    // nose when it shrank, and a rim light floating half a head-width off its
    // own edge reads as a stray pink wire laid across the face.
    c.moveTo(X(0.45), Y(0.06));
    c.bezierCurveTo(X(0.72), Y(0.07), X(0.88), Y(0.13), X(0.97), Y(0.28));
    c.bezierCurveTo(X(1.08), Y(0.43), X(0.90), Y(0.59), X(0.68), Y(0.56));
    c.stroke();
    // No lip rim. With the mouth open in a roar, any stroke down the near lip
    // line runs straight across the teeth and reads as a pink wire over the
    // face. The nose rim above already does the job of catching the key light.

    // ── the cap
    drawHatCone(c, u, rx, headLen, st, ow, INK);

    c.restore();
  }

  /**
   * One of the six, painted over the rig's own head.
   *
   * Same head-local frame as the hero's: origin at the middle of the skull, +x
   * is the way he faces, X()/Y() are fractions of the half-axes. Every number
   * below comes from one row of CREW_ART, so the six can be diffed against each
   * other by reading six rows rather than six functions — which is the only way
   * "would you notice if two of these heads were swapped" stays answerable.
   *
   * Feature bands, and nothing crosses out of its own:
   *   brow -0.70..-0.34 · eyes -0.34..0.04 · nose 0.04..0.52 ·
   *   moustache 0.40..0.66 · mouth 0.50..0.98 · beard 0.52 and down.
   * Draw order is skull → brow → eyes → nose → beard → moustache → MOUTH, so
   * the mouth is the last thing painted and can never be swallowed by whiskers.
   */
  /**
   * Where a crew nose's underside ACTUALLY lands in head-local Y, once
   * `art.nose.rot` has been applied.
   *
   * The beard's top edge and the moustache's top edge are both pinned to this
   * number. Authored the obvious way — `nose.y + nose.h * k` — they ignore the
   * rotation entirely, and the rotation is not small: it pivots about a point
   * 1.4 nose-widths out on the far side, so SAWBONES' 0.24 rad and COMA's 0.26
   * swing the near end of the nose a long way down. Measured on the shipped
   * card at rot 0.40/0.46, the whiskers started 0.18 of a head ABOVE the
   * nostril on both of them — a beard growing up a nose, which is the one
   * thing the brief names by hand.
   *
   * The lower contour is SAMPLED, not read off its control points: a cubic
   * never reaches its own controls and the gap here is most of a moustache.
   * The 0.5/0.54 is rx/ry — the rotation happens in pixel space and the head
   * frame is not square, so the horizontal arm of the rotation comes back
   * scaled by exactly that ratio.
   */
  function noseFoot(N) {
    const ox = N.x - N.w * 1.4;
    const oy = N.y;
    const sa = Math.sin(N.rot) * (0.5 / 0.54);
    const ca = Math.cos(N.rot);
    const p = [
      [N.x + N.w * 1.06, N.y + N.h * 0.28],
      [N.x + N.w * 1.14, N.y + N.h * 1.02],
      [N.x + N.w * 0.2, N.y + N.h * 1.24],
      [N.x - N.w * 0.55, N.y + N.h * 0.96],
    ];
    let lo = -9;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const m = 1 - t;
      const b = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t];
      let px = 0;
      let py = 0;
      for (let j = 0; j < 4; j++) {
        px += b[j] * p[j][0];
        py += b[j] * p[j][1];
      }
      const y = oy + (px - ox) * sa + (py - oy) * ca;
      if (y > lo) lo = y;
    }
    return lo;
  }

  function drawCrewHead(c, art, st, hs, u, jp, tp, mid) {
    const base = jp('head');
    const top = tp('head');
    const headLen = Math.hypot(top.x - base.x, top.y - base.y) || u;
    const ctr = mid(base, top, 0.46);
    const rx = headLen * 0.5 * hs;
    const ry = headLen * 0.54 * hs;
    const ang = Math.atan2(top.y - base.y, top.x - base.x) + Math.PI / 2;
    const ow = Math.max(1.0, u * 0.17);

    const S = art.skull;
    const M = art.mouth;
    const SKIN = st.skin;
    const SKIN_LIT = shade(st.skin, 1.36);
    const SKIN_DK = st.skinShade;
    const SKIN_DEEP = shade(st.skinShade, 0.42);
    const HAIR = st.hair;
    const HAIR_DK = shade(st.hair, 0.42);
    const INK = '#120d13';
    const DEEP3 = triple(SKIN_DEEP);

    c.save();
    c.translate(ctr.x, ctr.y);
    c.rotate(ang);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const X = (v) => v * rx;
    const Y = (v) => v * ry;
    const soft = (a, b, d, e, col3, al) => softBlobIn(c, X, Y, a, b, d, e, col3, al);

    /** ONE definition of the skull: filled, stroked and clipped from it. */
    function skullPath() {
      const { cw, jw, fh, cd } = S;
      c.beginPath();
      c.moveTo(X(-cw), Y(-0.04));
      c.bezierCurveTo(X(-cw * 1.05), Y(-fh * 0.7), X(-cw * 0.52), Y(-fh), X(0.12), Y(-fh));
      c.bezierCurveTo(X(cw * 0.7), Y(-fh), X(cw * 0.99), Y(-fh * 0.6), X(cw), Y(-0.26));
      c.bezierCurveTo(X(cw * 1.02), Y(-0.06), X(cw * 0.95), Y(0.12), X(jw * 0.99), Y(0.3));
      c.bezierCurveTo(X(jw), Y(cd * 0.55), X(jw * 0.84), Y(cd * 0.88), X(jw * 0.38), Y(cd));
      c.bezierCurveTo(X(-jw * 0.08), Y(cd * 1.1), X(-jw * 0.66), Y(cd * 0.9), X(-jw * 0.94), Y(cd * 0.54));
      c.bezierCurveTo(X(-cw * 0.99), Y(0.4), X(-cw), Y(0.16), X(-cw), Y(-0.04));
      c.closePath();
    }

    // ── One tuft escaping at the nape, behind the skull. It used to be two
    // pale ellipses and at card size they read as bubbles floating off the back
    // of the head, so: one, small, and a value darker than the skin.
    c.beginPath();
    c.ellipse(X(-S.cw * 0.82), Y(0.2), X(0.26), Y(0.3), -0.2, 0, TAU);
    c.fillStyle = HAIR_DK;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 0.9;
    c.stroke();

    // ── SILENT D's ear, huge and stuck out sideways. Drawn UNDER the skull:
    // closed over the top of it, the closing edge runs down the side of the
    // head as a straight stroke and the whole thing reads as a sticking
    // plaster. Behind the skull, only the part that clears the silhouette
    // shows — which is all an ear does in three-quarter view anyway.
    if (art.ears) {
      const ex = -S.cw * 0.9;
      c.beginPath();
      c.ellipse(X(ex), Y(0.06), X(0.34), Y(0.46), -0.16, 0, TAU);
      c.fillStyle = mix(SKIN, SKIN_DK, 0.32);
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.3;
      c.stroke();
      c.beginPath();
      c.ellipse(X(ex - 0.06), Y(0.06), X(0.17), Y(0.26), -0.16, 0, TAU);
      c.strokeStyle = rgba(SKIN_DEEP, 0.8);
      c.lineWidth = ow * 0.9;
      c.stroke();
    }

    // ── The skull.
    skullPath();
    const sg = c.createRadialGradient(X(0.56), Y(-0.3), X(0.04), X(0.16), Y(0.24), X(1.8));
    sg.addColorStop(0, SKIN_LIT);
    sg.addColorStop(0.32, SKIN);
    sg.addColorStop(0.72, SKIN_DK);
    sg.addColorStop(1, SKIN_DEEP);
    c.fillStyle = sg;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.5;
    c.stroke();

    c.save();
    skullPath();
    c.clip();
    // moonlight down the back of the head
    const cool = c.createLinearGradient(X(-S.cw), 0, X(-0.05), 0);
    cool.addColorStop(0, 'rgba(126,158,222,0.46)');
    cool.addColorStop(1, 'rgba(126,158,222,0)');
    c.fillStyle = cool;
    c.fillRect(X(-1.4), Y(-1.4), X(1.4), Y(2.8));
    // the shadow the cap's brim throws across the forehead
    const bs = c.createLinearGradient(0, Y(-S.fh), 0, Y(-0.3));
    bs.addColorStop(0, 'rgba(34,12,18,0.9)');
    bs.addColorStop(1, 'rgba(34,12,18,0)');
    c.fillStyle = bs;
    c.fillRect(X(-1.4), Y(-1.4), X(2.8), Y(1.2));
    // core shadow down the far side, key on the near cheek
    soft(-S.cw * 0.52, 0.2, 0.5, 0.9, DEEP3, 0.34);
    soft(0.5, 0.34, 0.32, 0.26, triple(SKIN_LIT), 0.22);
    if (art.blush) {
      // BASH goes scarlet when spoken to. Radial, so it is a flush and not a
      // pair of red discs stuck on the cheeks.
      soft(0.46, 0.14, 0.38, 0.26, '214,66,88', 0.55);
      soft(-0.44, 0.16, 0.32, 0.22, '214,66,88', 0.42);
    }
    c.restore();

    // ── Brows. art.brow is [y, thickness, arch, tilt]:
    //   arch  > 0 bows the brow upward over the eye
    //   tilt  > 0 lifts the INNER end (worried, gentle — COMA, BASH, SILENT D)
    //   tilt  < 0 drives it down toward the nose (hard — SAWBONES, PATIENT ZERO)
    // x0 is the temple end and x1 the nose end, so the near brow always runs
    // outward-to-inward and the far one is its smaller mirror further back.
    function brow(x0, x1, y0, th, arch, tilt, lit) {
      const yi = y0 - tilt;
      const mx = lerp(x0, x1, 0.48);
      const myTop = lerp(y0, yi, 0.48) - arch;
      c.beginPath();
      c.moveTo(X(x0), Y(y0));
      c.quadraticCurveTo(X(mx), Y(myTop), X(x1), Y(yi));
      c.quadraticCurveTo(X(mx), Y(myTop + th * 1.5), X(x0), Y(y0 + th * 0.55));
      c.closePath();
      const g = c.createLinearGradient(0, Y(myTop - 0.06), 0, Y(myTop + th * 1.7));
      g.addColorStop(0, lit ? shade(HAIR, 1.14) : mix(HAIR, HAIR_DK, 0.42));
      g.addColorStop(1, lit ? mix(HAIR, HAIR_DK, 0.5) : HAIR_DK);
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.2;
      c.stroke();
    }
    {
      const [by, bt, barch, btilt] = art.brow;
      // Far one first: near features are painted over far ones, always.
      brow(-S.cw * 0.96, -0.36, by + 0.03, bt * 0.82, barch * 0.8, btilt * 0.8, false);
      brow(-0.14, S.cw * 0.72, by, bt, barch, btilt, true);
    }

    // ── Eyes. The lens is ONE definition: the upper and lower lid curves are
    // each written once and the closed lens is built from them, so the fill,
    // the clip and the two lid strokes cannot drift apart under a resize.
    const lidTop = (px, py, w, h, move) => {
      if (move) c.moveTo(px - w, py + h * 0.1);
      c.quadraticCurveTo(px, py - h * 1.55, px + w, py + h * 0.16);
    };
    const lidBot = (px, py, w, h, move) => {
      if (move) c.moveTo(px + w, py + h * 0.16);
      c.quadraticCurveTo(px, py + h * 1.5, px - w, py + h * 0.1);
    };
    function lens(px, py, w, h) {
      c.beginPath();
      lidTop(px, py, w, h, true);
      lidBot(px, py, w, h, false);
      c.closePath();
    }
    function eye(e, near) {
      const px = X(e[0]);
      const py = Y(e[1]);
      const w = X(e[2]) * (near ? 1 : 0.9);
      const h = Y(e[3]);
      const mode = art.eyes;
      soft(e[0], e[1] + e[3] * 0.3, e[2] * 1.6, e[3] * 2.2, DEEP3, 0.4);

      if (mode === 'slits' || mode === 'squeezed') {
        // Closed. RIOT's squeeze arcs UP under balloon cheeks; PATIENT ZERO's
        // pinches into a ^ with the whole face screwed up behind it.
        c.strokeStyle = INK;
        c.lineWidth = ow * 1.7;
        c.beginPath();
        if (mode === 'slits') {
          c.moveTo(px - w, py + h * 0.6);
          c.quadraticCurveTo(px, py - h * 1.6, px + w, py + h * 0.6);
        } else {
          c.moveTo(px - w, py + h * 1.0);
          c.lineTo(px + w * 0.05, py - h * 0.9);
          c.lineTo(px + w, py + h * 0.7);
        }
        c.stroke();
        c.strokeStyle = rgba(SKIN_DEEP, 0.65);
        c.lineWidth = ow * 0.6;
        for (let i = -1; i <= 1; i++) {
          c.beginPath();
          c.moveTo(px - w * 0.92, py + h * (0.2 + i * 0.55));
          c.lineTo(px - w * 1.55, py + h * (0.05 + i * 0.95));
          c.stroke();
        }
        return;
      }

      lens(px, py, w, h);
      c.fillStyle = '#f6ead6';
      c.fill();
      c.save();
      c.clip();
      let icx = px + w * 0.3;
      let icy = py + h * 0.14;
      let ir = h * 0.98;
      let cover = -2;
      if (mode === 'hooded') {
        icy = py + h * 0.5;
        cover = 0.25;
      } else if (mode === 'shy') {
        // He cannot look you in the eye: iris driven hard into the lower OUTER
        // corner, lid down over the top of it. A centred iris under a lowered
        // lid is a sleepy dwarf, not an embarrassed one.
        icx = px - w * 0.52;
        icy = py + h * 0.85;
        cover = 0.05;
      } else if (mode === 'wide') {
        icx = px + w * 0.12;
        ir = h * 1.1;
      } else if (mode === 'specs') {
        cover = -0.5;
      }
      // The iris has to stay INSIDE the lens. SILENT D's eye is the roster's
      // biggest — h 0.20 against a half-width of 0.23 — and at ir = h * 1.1 the
      // disc came out wider than the opening it sits in: no sclera survived at
      // either corner, so the eye read as a flat black bean, and the catchlight
      // above it was sliced by the upper lid into a hard-edged white rectangle.
      // Both are the same bug, and the clamp is the fix for both.
      ir = Math.min(ir, w * 0.86);
      c.beginPath();
      c.arc(icx, icy, ir, 0, TAU);
      const ig = c.createRadialGradient(icx - ir * 0.32, icy - ir * 0.4, ir * 0.08, icx, icy, ir);
      ig.addColorStop(0, mode === 'wide' ? '#8a6a4a' : '#a97430');
      ig.addColorStop(0.55, mode === 'wide' ? '#3c2a1e' : '#5c3312');
      ig.addColorStop(1, '#160b04');
      c.fillStyle = ig;
      c.fill();
      c.beginPath();
      c.arc(icx, icy, ir * (mode === 'wide' ? 0.46 : 0.42), 0, TAU);
      c.fillStyle = '#0d0705';
      c.fill();
      c.beginPath();
      c.arc(icx - ir * 0.42, icy - ir * 0.5, ir * (mode === 'wide' ? 0.36 : 0.28), 0, TAU);
      c.fillStyle = '#ffffff';
      c.fill();
      if (cover > -1) {
        // the lid, dropped. COMA's covers half the iris; the others graze it.
        c.beginPath();
        c.moveTo(px - w * 1.6, py - h * 2.4);
        c.lineTo(px + w * 1.6, py - h * 2.4);
        c.lineTo(px + w * 1.6, py + h * (cover - 0.25));
        c.quadraticCurveTo(px, py + h * (cover + 0.55), px - w * 1.6, py + h * (cover - 0.4));
        c.closePath();
        c.fillStyle = SKIN_DK;
        c.fill();
        c.strokeStyle = rgba(SKIN_DEEP, 0.85);
        c.lineWidth = ow * 0.8;
        c.stroke();
      }
      const ls = c.createLinearGradient(0, py - h * 1.5, 0, py + h * 0.2);
      ls.addColorStop(0, 'rgba(48,18,10,0.85)');
      ls.addColorStop(1, 'rgba(48,18,10,0)');
      c.fillStyle = ls;
      c.fillRect(px - w * 2, py - h * 1.8, w * 4, h * 2.2);
      c.restore();
      // Lid line: heavy on top, light underneath. Weight is expression.
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.5;
      c.beginPath();
      lidTop(px, py, w, h, true);
      c.stroke();
      c.lineWidth = ow * 0.85;
      c.beginPath();
      lidBot(px, py, w, h, true);
      c.stroke();
      if (mode === 'hooded') {
        // the bag under it. COMA has not been properly awake since 1937.
        c.strokeStyle = rgba(SKIN_DEEP, 0.75);
        c.lineWidth = ow * 0.9;
        c.beginPath();
        c.moveTo(px - w * 0.9, py + h * 1.3);
        c.quadraticCurveTo(px, py + h * 2.5, px + w * 0.95, py + h * 1.2);
        c.stroke();
      }
    }
    eye(art.eyeF, false);
    eye(art.eyeN, true);

    // ── SAWBONES' spectacles, low on the nose. Drawn after both eyes so the
    // wire crosses in front of them, which is where a wire is.
    if (art.eyes === 'specs') {
      const r1 = X(art.eyeN[2] * 1.5);
      const r2 = X(art.eyeF[2] * 1.4);
      const n1 = { x: X(art.eyeN[0]), y: Y(art.eyeN[1] + 0.1) };
      const n2 = { x: X(art.eyeF[0]), y: Y(art.eyeF[1] + 0.1) };
      c.lineWidth = ow * 0.85;
      c.strokeStyle = '#0f0b10';
      for (const [p, r] of [[n2, r2], [n1, r1]]) {
        c.beginPath();
        c.ellipse(p.x, p.y, r, r * 0.94, 0, 0, TAU);
        c.fillStyle = 'rgba(178,208,255,0.13)';
        c.fill();
        c.stroke();
        c.strokeStyle = '#c8a63f';
        c.lineWidth = ow * 0.45;
        c.stroke();
        c.strokeStyle = '#0f0b10';
        c.lineWidth = ow * 0.85;
      }
      c.strokeStyle = '#c8a63f';
      c.lineWidth = ow * 0.5;
      c.beginPath();
      c.moveTo(n2.x + r2, n2.y - r2 * 0.2);
      c.quadraticCurveTo((n1.x + n2.x) / 2, n2.y - r2 * 0.55, n1.x - r1, n1.y - r1 * 0.2);
      c.moveTo(n2.x - r2, n2.y - r2 * 0.3);
      c.lineTo(X(-S.cw * 0.9), Y(art.eyeF[1] - 0.16));
      c.stroke();
      // one lit crescent on each lens so they read as glass
      c.strokeStyle = 'rgba(226,240,255,0.7)';
      c.lineWidth = ow * 0.5;
      c.beginPath();
      c.arc(n1.x, n1.y, r1 * 0.78, Math.PI * 0.95, Math.PI * 1.45);
      c.stroke();
    }

    // ── The nose. ONE definition: the closed path calls the front contour, so
    // the fill and the outline can never drift apart the way the hero's did.
    {
      const N = art.nose;
      soft(N.x - N.w * 0.9, N.y + N.h * 0.7, N.w * 1.0, N.h * 0.66, DEEP3, 0.32);
      const nc = mix(SKIN, '#e0616b', N.tint);
      function front() {
        c.moveTo(X(N.x - N.w * 1.5), Y(N.y - N.h * 0.55));
        c.bezierCurveTo(
          X(N.x - N.w * 0.2), Y(N.y - N.h * 1.05),
          X(N.x + N.w * 0.95), Y(N.y - N.h * 0.62),
          X(N.x + N.w * 1.06), Y(N.y + N.h * 0.28),
        );
        c.bezierCurveTo(
          X(N.x + N.w * 1.14), Y(N.y + N.h * 1.02),
          X(N.x + N.w * 0.2), Y(N.y + N.h * 1.24),
          X(N.x - N.w * 0.55), Y(N.y + N.h * 0.96),
        );
      }
      function nosePath() {
        c.beginPath();
        front();
        c.bezierCurveTo(
          X(N.x - N.w * 1.2), Y(N.y + N.h * 0.72),
          X(N.x - N.w * 1.62), Y(N.y + N.h * 0.1),
          X(N.x - N.w * 1.5), Y(N.y - N.h * 0.55),
        );
        c.closePath();
      }
      c.save();
      c.translate(X(N.x - N.w * 1.4), Y(N.y));
      c.rotate(N.rot);
      c.translate(-X(N.x - N.w * 1.4), -Y(N.y));
      nosePath();
      const ng = c.createRadialGradient(
        X(N.x + N.w * 0.6), Y(N.y - N.h * 0.2), X(N.w * 0.1),
        X(N.x + N.w * 0.5), Y(N.y + N.h * 0.1), X(N.w * 2.1),
      );
      ng.addColorStop(0, shade(nc, 1.34));
      ng.addColorStop(0.42, nc);
      ng.addColorStop(1, shade(mix(SKIN_DK, nc, 0.5), 0.86));
      c.fillStyle = ng;
      c.fill();
      c.beginPath();
      front();
      c.strokeStyle = INK;
      c.lineWidth = ow * 1.45;
      c.stroke();
      // The lit plane on the ball — soft, because a flat-filled highlight has a
      // traceable edge and a traceable edge on a nose is a second small object
      // stuck to the first. The nostril below it keeps its edge: a nostril is
      // an aperture, not shading.
      soft(N.x + N.w * 0.46, N.y - N.h * 0.18, N.w * 0.4, N.h * 0.34, '255,244,228', 0.5);
      c.beginPath();
      c.ellipse(
        X(N.x + N.w * 0.42), Y(N.y + N.h * 0.74),
        X(N.w * 0.24), Y(N.h * 0.14), 0.3, 0, TAU,
      );
      c.fillStyle = shade(SKIN_DEEP, 0.7);
      c.fill();
      if (N.tint > 0.4) {
        // PATIENT ZERO's is scoured raw. Soft, because a red disc on the end of
        // a nose is a clown, and a flush is a cold — and CLIPPED to the nose,
        // because unclipped it bloomed past the silhouette and hung in the sky
        // beside his face like a warning light.
        c.save();
        nosePath();
        c.clip();
        soft(N.x + N.w * 0.4, N.y + N.h * 0.1, N.w * 0.9, N.h * 0.8, '226,92,110', 0.42);
        c.restore();
      }
      c.restore();
      // the shadow it drops on the lip, narrower than the nose so it stays a
      // cast shadow instead of becoming an edge of its own
      soft(N.x - N.w * 0.3, N.y + N.h * 1.5, N.w * 0.7, N.h * 0.3, triple(shade(SKIN_DEEP, 0.8)), 0.34);
    }

    // ── Beard, then moustache, then the MOUTH last so nothing can swallow it.
    {
      const B = art.beard;
      // The top edge of the mass runs along the CHEEK, not along the mouth:
      // the beard has to be under the mouth before the mouth is painted or
      // there is a bare gap of skin between the two and the moustache reads as
      // a pale banana glued to the face, which is exactly what it did.
      // The near-side top edge is derived from the NOSE, never authored — but
      // it has to be derived from where the nose ACTUALLY ends, which is not
      // `nose.y + nose.h * k`. That expression ignores art.nose.rot, and at
      // SAWBONES' 0.40 and COMA's 0.46 the rotation swings the near end of the
      // nose a fifth of a head further down than the unrotated maths believes:
      // measured, the beard's top edge was 0.18 ABOVE the nostril on both of
      // them, which is a beard growing up a nose. noseFoot() rotates the four
      // underside control points and takes the lowest, so the two cannot
      // disagree again whatever anyone does to nose.rot.
      const nearTop = Math.max(0.3, noseFoot(art.nose) + 0.06);
      // The far cheek. At the old flat 0.12 the mass climbed to within 0.15 of
      // the far eye and ate the whole receding half of COMA's face; it is now
      // pinned below the near edge, so a cheek is bare on both sides.
      const farTop = Math.min(0.3, nearTop - 0.12);
      const jawY = S.cd * 0.52;
      // The moustache band. Its top is pinned BELOW the nose base and its
      // height is capped, so it can neither float on the nose nor spread into
      // the pale slab across the whole lower face that it became once.
      const mtop = Math.max(noseFoot(art.nose) + 0.05, M.y - 0.2);
      const mbot = mtop + 0.17;
      const tache = B.kind !== 'none' && B.kind !== 'stubble';
      if (B.kind === 'stubble') {
        // No mass and no contour: a stubble with an outline is a chin strap.
        c.save();
        skullPath();
        c.clip();
        const st3 = shade(mix(SKIN_DK, HAIR, 0.24), 0.8);
        const g = c.createLinearGradient(0, Y(0.1), 0, Y(S.cd * 1.05));
        g.addColorStop(0, rgba(st3, 0));
        g.addColorStop(0.38, rgba(st3, 0.66));
        g.addColorStop(1, rgba(st3, 0.95));
        c.fillStyle = g;
        c.fillRect(X(-1.4), Y(0.1), X(2.8), Y(1.8));
        c.restore();
      } else if (B.kind !== 'none') {
        const bot = jawY + B.len;
        const w = B.w;
        function beardPath() {
          c.beginPath();
          c.moveTo(X(1.04 * w), Y(nearTop));
          if (B.kind === 'long') {
            // COMA's: narrow, straggly, twice anyone else's, ending in a slack
            // point that has never met a comb.
            c.bezierCurveTo(X(1.06 * w), Y(bot * 0.44), X(0.86 * w), Y(bot * 0.78), X(0.4 * w), Y(bot));
            c.quadraticCurveTo(X(0.12 * w), Y(bot * 1.08), X(-0.14 * w), Y(bot * 0.9));
            c.bezierCurveTo(X(-0.6 * w), Y(bot * 0.66), X(-0.94 * w), Y(bot * 0.36), X(-1.0 * w), Y(0.5));
          } else if (B.kind === 'braided') {
            c.bezierCurveTo(X(1.12 * w), Y(bot * 0.46), X(1.0 * w), Y(bot * 0.84), X(0.5 * w), Y(bot * 0.98));
            c.quadraticCurveTo(X(0.0), Y(bot * 1.08), X(-0.5 * w), Y(bot * 0.92));
            c.bezierCurveTo(X(-0.96 * w), Y(bot * 0.74), X(-1.14 * w), Y(bot * 0.4), X(-1.06 * w), Y(0.44));
          } else {
            // bushy — SAWBONES' is long, white and kept; RIOT's is short, wide
            // and blown outward by the laugh. Same code, two different rows.
            c.bezierCurveTo(X(1.1 * w), Y(bot * 0.44), X(1.08 * w), Y(bot * 0.76), X(0.88 * w), Y(bot * 0.9));
            const n = B.lobes;
            for (let i = 0; i < n; i++) {
              const a = lerp(0.88 * w, -0.88 * w, i / n);
              const b2 = lerp(0.88 * w, -0.88 * w, (i + 1) / n);
              c.quadraticCurveTo(
                X((a + b2) * 0.5), Y(bot * (1.04 + 0.09 * (i % 2))),
                X(b2), Y(bot * (0.9 + 0.02 * i)),
              );
            }
            c.bezierCurveTo(X(-1.1 * w), Y(bot * 0.66), X(-1.1 * w), Y(bot * 0.3), X(-1.0 * w), Y(0.4));
          }
          // Back up the far cheek and across under the cheekbones. Cheeks stay
          // bare ABOVE this line — a beard does not grow up the nose.
          c.quadraticCurveTo(X(-1.0 * w), Y(farTop + 0.06), X(-S.jw * 0.9), Y(farTop));
          c.bezierCurveTo(
            X(-0.3), Y(farTop + 0.34),
            X(0.5), Y(nearTop - 0.14),
            X(1.04 * w), Y(nearTop),
          );
          c.closePath();
        }
        beardPath();
        // A stop darker than a white beard wants to be. At full value the mass
        // is lighter than the face above it, which inverts the read: at
        // thumbnail size you see a beard with a dwarf attached.
        const bg = c.createLinearGradient(X(0.9 * w), Y(nearTop), X(-0.9 * w), Y(bot));
        bg.addColorStop(0, mix(HAIR, HAIR_DK, 0.18));
        bg.addColorStop(0.24, mix(HAIR, HAIR_DK, 0.46));
        bg.addColorStop(0.66, mix(HAIR, HAIR_DK, 0.86));
        bg.addColorStop(1, shade(HAIR_DK, 0.5));
        c.fillStyle = bg;
        c.fill();
        c.strokeStyle = INK;
        c.lineWidth = ow * 1.5;
        c.stroke();

        c.save();
        beardPath();
        c.clip();
        // the shadow the jaw throws into the top of the mass
        const js = c.createLinearGradient(0, Y(farTop - 0.05), 0, Y(jawY + B.len * 0.5));
        js.addColorStop(0, 'rgba(38,26,18,0.92)');
        js.addColorStop(1, 'rgba(38,26,18,0)');
        c.fillStyle = js;
        c.fillRect(X(-1.6), Y(farTop - 0.1), X(3.2), Y(bot));
        // moonlight down the far side, key down the near edge
        const bc = c.createLinearGradient(X(-1.2 * w), 0, X(-0.1), 0);
        bc.addColorStop(0, 'rgba(126,160,225,0.52)');
        bc.addColorStop(1, 'rgba(126,160,225,0)');
        c.fillStyle = bc;
        c.fillRect(X(-1.6), Y(0), X(1.5), Y(bot + 0.6));
        const bwm = c.createLinearGradient(X(1.15 * w), 0, X(0.2), 0);
        bwm.addColorStop(0, 'rgba(255,166,190,0.34)');
        bwm.addColorStop(1, 'rgba(255,166,190,0)');
        c.fillStyle = bwm;
        c.fillRect(X(0.2), Y(0), X(1.4), Y(bot + 0.6));
        // clump edges: a dark valley with a lit ridge beside it, which is what
        // stops a beard mass reading as corduroy
        for (let i = 0; i < 5; i++) {
          const t2 = (i + 0.5) / 5;
          const sx = lerp(0.8 * w, -0.8 * w, t2);
          const y0 = lerp(jawY + 0.1, bot, 0.32);
          c.beginPath();
          c.moveTo(X(sx), Y(y0));
          c.quadraticCurveTo(
            X(sx + 0.08), Y(lerp(y0, bot, 0.55)),
            X(sx + 0.14), Y(bot * 0.94),
          );
          c.lineWidth = ow * 2.2;
          c.strokeStyle = 'rgba(28,23,18,0.34)';
          c.stroke();
          c.lineWidth = ow * 0.8;
          c.strokeStyle = 'rgba(255,246,232,0.26)';
          c.stroke();
        }
        c.restore();

        if (B.kind === 'braided') {
          // BASH's two braids, banded in the same brass as his studs. They hang
          // from INSIDE the mass, not below it — a braid that starts where the
          // beard ends is a pair of ropes on a string.
          for (const s of [1, -1]) {
            const x0 = 0.4 * w * s;
            const x1 = 0.68 * w * s;
            const y0 = jawY + B.len * 0.35;
            const y1 = bot * 0.99;
            c.beginPath();
            c.moveTo(X(x0), Y(y0));
            c.quadraticCurveTo(X(x1), Y(lerp(y0, y1, 0.55)), X(x1 * 0.92), Y(y1));
            c.lineWidth = X(0.2);
            c.strokeStyle = INK;
            c.stroke();
            c.lineWidth = X(0.145);
            c.strokeStyle = s > 0 ? HAIR : mix(HAIR, HAIR_DK, 0.55);
            c.stroke();
            for (let i = 1; i <= 3; i++) {
              const f = i / 3.6;
              const bxp = X(lerp(x0, x1 * 0.94, f));
              const byp = Y(lerp(y0, y1, f));
              c.beginPath();
              c.ellipse(bxp, byp, X(0.12), Y(0.042), 0.4 * s, 0, TAU);
              c.fillStyle = '#c8a24a';
              c.fill();
              c.lineWidth = ow * 0.5;
              c.strokeStyle = INK;
              c.stroke();
            }
          }
        }

        // ── The moustache. Its top edge is pinned BELOW the nose base and its
        // bottom overlaps the beard mass, so it can neither float on the nose
        // nor hang in a gap above the whiskers. Two lobes, not one bar.
        const [td, tl] = art.tache;
        const tx = -0.44 * tl;
        c.beginPath();
        c.moveTo(X(0.9), Y(mtop));
        c.bezierCurveTo(X(0.94), Y(mbot - 0.02), X(0.6), Y(mbot + 0.04 + td * 0.4), X(0.26), Y(mbot + td * 0.7));
        c.bezierCurveTo(
          X(0.0), Y(mbot + 0.06 + td),
          X(tx + 0.1), Y(mbot + td * 0.86),
          X(tx), Y(mtop + 0.08 + td * 0.8),
        );
        c.bezierCurveTo(X(tx + 0.2), Y(mtop - 0.03 + td * 0.4), X(0.34), Y(mtop - 0.05), X(0.9), Y(mtop));
        c.closePath();
        const mg2 = c.createLinearGradient(X(0.86), Y(mtop), X(tx), Y(mbot + 0.06 + td));
        mg2.addColorStop(0, shade(HAIR, 1.2));
        mg2.addColorStop(0.4, HAIR);
        mg2.addColorStop(1, shade(HAIR_DK, 0.8));
        c.fillStyle = mg2;
        c.fill();
        c.strokeStyle = rgba(mix(HAIR_DK, INK, 0.55), 0.9);
        c.lineWidth = ow * 0.72;
        c.stroke();
        // and the shadow it throws onto the beard, which is the difference
        // between a moustache and a pale lozenge pasted on the whiskers
        soft(0.28, mbot + 0.1 + td * 0.5, 0.62, 0.12, '24,18,12', 0.42);
        c.strokeStyle = rgba(HAIR_DK, 0.5);
        c.lineWidth = ow * 0.5;
        for (let i = 0; i < 4; i++) {
          const f = i / 3;
          c.beginPath();
          c.moveTo(X(lerp(0.8, 0.0, f)), Y(lerp(mtop + 0.02, mtop + 0.05 + td * 0.4, f)));
          c.quadraticCurveTo(
            X(lerp(0.72, tx * 0.5, f)), Y(lerp(mbot - 0.03, mbot - 0.01 + td * 0.7, f)),
            X(lerp(0.42, tx * 0.85, f)), Y(lerp(mbot - 0.01, mbot + 0.01 + td * 0.8, f)),
          );
          c.stroke();
        }
      }


      // ── The mouth. Last, always.
      const mw = X(M.w);
      const mx = X(M.x ?? 0.24);
      const open = M.kind === 'laugh' || M.kind === 'aaa';
      // A closed mouth sits directly under the moustache. Authored separately
      // the two drift apart and leave a bare stripe of beard between them.
      const my = tache && !open ? Y(mbot + 0.12) : Y(M.y + 0.14);
      if (open) {
        const tall = M.kind === 'laugh' ? 1.05 : 1.3;
        c.beginPath();
        c.ellipse(mx, my, mw, mw * tall * 0.78, M.kind === 'aaa' ? 0.1 : -0.06, 0, TAU);
        c.fillStyle = '#2a0a11';
        c.fill();
        c.strokeStyle = INK;
        c.lineWidth = ow * 1.6;
        c.stroke();
        c.save();
        c.beginPath();
        c.ellipse(mx, my, mw, mw * tall * 0.78, M.kind === 'aaa' ? 0.1 : -0.06, 0, TAU);
        c.clip();
        // upper teeth as ONE band with notches, never a row of white bricks
        c.beginPath();
        c.moveTo(mx - mw * 1.2, my - mw * 1.1);
        c.lineTo(mx + mw * 1.2, my - mw * 1.1);
        c.lineTo(mx + mw * 1.2, my - mw * 0.16);
        for (let i = 0; i < 4; i++) {
          const a = mx + mw * lerp(1.2, -1.2, i / 4);
          const b2 = mx + mw * lerp(1.2, -1.2, (i + 1) / 4);
          c.quadraticCurveTo((a + b2) / 2, my + mw * 0.1, b2, my - mw * 0.16);
        }
        c.closePath();
        c.fillStyle = '#f2e6d2';
        c.fill();
        if (M.kind === 'laugh') {
          c.beginPath();
          c.ellipse(mx - mw * 0.1, my + mw * 0.5, mw * 0.55, mw * 0.34, -0.1, 0, TAU);
          c.fillStyle = '#a8353f';
          c.fill();
        }
        const ms = c.createLinearGradient(0, my - mw * 0.2, 0, my + mw * 0.7);
        ms.addColorStop(0, 'rgba(0,0,0,0.55)');
        ms.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = ms;
        c.fillRect(mx - mw * 1.3, my - mw * 0.2, mw * 2.6, mw * 1.2);
        c.restore();
      } else if (M.kind === 'grin') {
        // SILENT D says nothing, so the whole line is in the mouth: a wide
        // closed lipless grin that reaches most of the way across a small jaw.
        c.beginPath();
        c.moveTo(mx - mw, my - mw * 0.24);
        c.quadraticCurveTo(mx, my + mw * 0.72, mx + mw, my - mw * 0.3);
        c.strokeStyle = INK;
        c.lineWidth = ow * 1.7;
        c.stroke();
        c.beginPath();
        c.moveTo(mx - mw * 0.72, my + mw * 0.16);
        c.quadraticCurveTo(mx - mw * 0.1, my + mw * 0.5, mx + mw * 0.7, my + mw * 0.08);
        c.strokeStyle = rgba(SKIN_DEEP, 0.6);
        c.lineWidth = ow * 0.7;
        c.stroke();
      } else {
        // closed: SAWBONES' flat and firm, COMA's slack and open a crack,
        // BASH's a small restrained curve.
        c.strokeStyle = INK;
        c.lineWidth = ow * 1.5;
        c.beginPath();
        if (M.kind === 'shy') {
          c.moveTo(mx - mw, my + mw * 0.16);
          c.quadraticCurveTo(mx, my + mw * 0.56, mx + mw, my);
        } else if (M.kind === 'slack') {
          c.moveTo(mx - mw, my);
          c.quadraticCurveTo(mx, my + mw * 0.9, mx + mw, my - mw * 0.1);
          c.quadraticCurveTo(mx, my + mw * 0.35, mx - mw, my);
          c.fillStyle = '#2a0a11';
          c.fill();
        } else {
          c.moveTo(mx - mw, my - mw * 0.18);
          c.quadraticCurveTo(mx, my + mw * 0.2, mx + mw, my - mw * 0.24);
        }
        c.stroke();
        // a lit lower lip under it. A single dark scratch on a grey beard is
        // invisible at card size; the value break beneath it is what reads.
        c.strokeStyle = rgba(mix(SKIN, '#e0616b', 0.4), 0.85);
        c.lineWidth = ow * 1.1;
        c.beginPath();
        c.moveTo(mx - mw * 0.78, my + mw * 0.22);
        c.quadraticCurveTo(mx, my + mw * 0.5, mx + mw * 0.8, my + mw * 0.1);
        c.stroke();
      }
    }

    // ── The two rims that cut him out of the night: silver down the back of
    // the skull, hot key down the brow and the nose.
    c.strokeStyle = 'rgba(200,222,255,0.75)';
    c.lineWidth = ow * 1.05;
    c.beginPath();
    c.moveTo(X(-S.cw * 0.5), Y(-S.fh * 0.96));
    c.bezierCurveTo(X(-S.cw * 0.92), Y(-S.fh * 0.68), X(-S.cw * 1.04), Y(-0.4), X(-S.cw), Y(-0.04));
    c.bezierCurveTo(X(-S.cw), Y(0.2), X(-S.cw * 0.98), Y(0.34), X(-S.jw * 0.94), Y(S.cd * 0.5));
    c.stroke();

    // ── The cap, over everything.
    drawCrewCap(c, art, st, X, Y, S, ow, INK, u, rx);

    c.restore();
  }

  /**
   * Their caps. Seven cone hats in seven colours IS the failure mode the user
   * named, so each of these is a different SHAPE first and a different colour
   * second: SAWBONES' folds forward, RIOT's flops back over a wide brim, COMA's
   * droops to his shoulder, BASH's is a short beanie pulled down, PATIENT
   * ZERO's is shoved back off his forehead with the tip flicked up, and SILENT
   * D's is the three-sizes-too-big purple one he will not discuss.
   *
   * Each is one spine of [x, y, halfWidth] nodes in head-local units, inflated
   * along its own normals into ONE closed outline that is filled and stroked —
   * so the fill and the outline cannot drift apart under a resize.
   */
  function drawCrewCap(c, art, st, X, Y, S, ow, INK, u, rx) {
    const SPINES = {
      // A tall stiff cone that folds forward at the tip. Oldest, tidiest.
      fold: [
        [0.06, -0.78, 0.9], [0.0, -1.12, 0.72], [-0.04, -1.46, 0.52],
        [0.08, -1.78, 0.34], [0.34, -1.94, 0.2], [0.58, -1.9, 0.09],
      ],
      // Flopped hard over the back of the head, because he never stops moving.
      flop: [
        [0.04, -0.78, 0.94], [-0.16, -1.14, 0.76], [-0.46, -1.44, 0.54],
        [-0.86, -1.6, 0.36], [-1.22, -1.64, 0.19], [-1.5, -1.5, 0.08],
      ],
      // Drooping all the way past the ear, on its way to the shoulder.
      droop: [
        [0.02, -0.78, 0.86], [-0.22, -1.14, 0.7], [-0.62, -1.34, 0.5],
        [-1.06, -1.36, 0.33], [-1.48, -1.12, 0.19], [-1.78, -0.62, 0.08],
      ],
      // Pulled down like a beanie and barely tipped: he wants less of him out.
      beanie: [
        [0.06, -0.8, 0.94], [0.0, -1.04, 0.84], [-0.14, -1.26, 0.62],
        [-0.4, -1.4, 0.38], [-0.7, -1.4, 0.19], [-0.94, -1.24, 0.07],
      ],
      // Shoved back off the forehead, tip flicked up by the sneeze coming.
      pushback: [
        [-0.08, -0.84, 0.9], [-0.3, -1.16, 0.72], [-0.54, -1.48, 0.5],
        [-0.64, -1.82, 0.33], [-0.52, -2.1, 0.18], [-0.28, -2.2, 0.07],
      ],
      // Three sizes too big, swallowing the cranium, and he will not discuss it.
      huge: [
        [0.1, -0.72, 1.22], [0.0, -1.1, 1.18], [-0.24, -1.48, 0.98],
        [-0.68, -1.66, 0.7], [-1.16, -1.58, 0.45], [-1.56, -1.2, 0.26],
        [-1.78, -0.68, 0.12],
      ],
    };
    const spine = SPINES[art.cap] ?? SPINES.fold;
    const HAT = st.hatColor;

    const n = spine.length;
    const P = spine.map((s) => ({ x: X(s[0]), y: Y(s[1]) }));
    const Wd = spine.map((s) => X(s[2]));
    const NRM = [];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      NRM.push({ x: -dy / l, y: dx / l });
    }
    const edge = (s) =>
      P.map((p, i) => ({ x: p.x + NRM[i].x * Wd[i] * s, y: p.y + NRM[i].y * Wd[i] * s }));
    const A = edge(1);
    const B = edge(-1);
    function capPath() {
      c.beginPath();
      c.moveTo(A[0].x, A[0].y);
      for (let i = 1; i < n - 1; i++) {
        const m = { x: (A[i].x + A[i + 1].x) / 2, y: (A[i].y + A[i + 1].y) / 2 };
        c.quadraticCurveTo(A[i].x, A[i].y, m.x, m.y);
      }
      c.lineTo(A[n - 1].x, A[n - 1].y);
      c.lineTo(B[n - 1].x, B[n - 1].y);
      for (let i = n - 2; i >= 1; i--) {
        const m = { x: (B[i].x + B[i - 1].x) / 2, y: (B[i].y + B[i - 1].y) / 2 };
        c.quadraticCurveTo(B[i].x, B[i].y, m.x, m.y);
      }
      c.lineTo(B[0].x, B[0].y);
      c.closePath();
    }

    // pom-pom, behind the cone. Small and dulled: a bright ball on a night
    // skyline reads as a second moon, which is what the hero's used to do.
    const tip = P[n - 1];
    c.beginPath();
    c.arc(tip.x, tip.y, X(0.13), 0, TAU);
    const pom = mix(st.hair, HAT, 0.5);
    const pg2 = c.createRadialGradient(tip.x + X(0.04), tip.y - X(0.04), X(0.012), tip.x, tip.y, X(0.14));
    pg2.addColorStop(0, shade(pom, 1.12));
    pg2.addColorStop(0.6, shade(pom, 0.66));
    pg2.addColorStop(1, shade(pom, 0.36));
    c.fillStyle = pg2;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.0;
    c.stroke();

    capPath();
    const hg = c.createLinearGradient(X(0.9), 0, X(-1.2), 0);
    hg.addColorStop(0, shade(HAT, 1.32));
    hg.addColorStop(0.3, HAT);
    hg.addColorStop(0.72, shade(HAT, 0.52));
    hg.addColorStop(1, shade(HAT, 0.26));
    c.fillStyle = hg;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.7;
    c.stroke();

    // creases, so the wool has a fold in it
    c.save();
    capPath();
    c.clip();
    c.strokeStyle = 'rgba(20,8,12,0.42)';
    c.lineWidth = ow * 1.2;
    for (let i = 1; i < n - 1; i++) {
      // Bowed toward the tip. Straight spokes radiating off a spine are
      // umbrella ribs, and on SILENT D's three-sizes-too-big dome that is
      // exactly what seven of them looked like.
      c.beginPath();
      c.moveTo(P[i].x + NRM[i].x * Wd[i] * 0.45, P[i].y + NRM[i].y * Wd[i] * 0.45);
      c.quadraticCurveTo(
        P[i].x - NRM[i].x * Wd[i] * 0.18 + (P[n - 1].x - P[i].x) * 0.14,
        P[i].y - NRM[i].y * Wd[i] * 0.18 + (P[n - 1].y - P[i].y) * 0.14,
        P[i].x - NRM[i].x * Wd[i] * 0.82, P[i].y - NRM[i].y * Wd[i] * 0.82,
      );
      c.stroke();
    }
    const rimg = c.createLinearGradient(X(-1.5), 0, X(-0.4), 0);
    rimg.addColorStop(0, 'rgba(200,222,255,0.6)');
    rimg.addColorStop(1, 'rgba(200,222,255,0)');
    c.fillStyle = rimg;
    c.fillRect(X(-2.2), Y(-2.6), X(1.9), Y(2.6));
    c.restore();

    // Rolled brim. It has to sit ON the skull and ABOVE the brow: at the old
    // thickness and height it ran straight through the eyebrows and every one
    // of the six lost the brow shape that half his expression lives in.
    const bw = Math.max(Wd[0] * 1.12, X(S.cw * 1.04));
    const by = P[0].y + X(0.05);
    c.beginPath();
    c.moveTo(bw, by + X(0.035));
    c.lineTo(-bw, by - X(0.02));
    c.lineWidth = X(0.2);
    c.strokeStyle = INK;
    c.stroke();
    const bd = c.createLinearGradient(bw, 0, -bw, 0);
    bd.addColorStop(0, shade(HAT, 1.2));
    bd.addColorStop(0.45, shade(HAT, 0.8));
    bd.addColorStop(1, shade(HAT, 0.44));
    c.strokeStyle = bd;
    c.lineWidth = X(0.145);
    c.stroke();

    // the studs, in the roster's own count — 3 for COMA up to 9 for the hero.
    MF.Shapes.spikeStrip(
      c,
      -bw * 0.68, by + X(0.02),
      bw * 0.76, by + X(0.05),
      Math.max(2, Math.round((st.spikes || 4) * 0.62)),
      Math.max(1.0, u * 0.42),
      '#ffd23f',
    );
  }

  /**
   * The cap. The rig draws its own underneath, so this one has to strictly
   * contain it — and the rig's cone flops sideways by a fraction of ITS head
   * half-width, which is a different number now that the rig head and the
   * drawn head are different sizes. So: the lateral flop and the pom are taken
   * from the RIG's half-width (absolute pixels), and only the cone's own
   * thickness scales with the drawn head. That is what lets the brim be a
   * narrow rolled band instead of the 1.33-half-width pancake it used to need.
   */
  function drawHatCone(c, u, rx, headLen, st, ow, INK) {
    const baseY = 0.46 * headLen - (9.5 + 2.6) * u; // 2.6 = the pose's HAT_LIFT
    const L = 13 * u;
    const w = rx * 1.0;
    const wRig = headLen * 0.5 * cfg.rigHeadSize * 1.02;
    const T = [0, 0.34, 0.66, 1];
    const WD = [1, 0.72, 0.44, 0.16];
    const LAT = [0, -0.16, -0.5, -1.05];
    const pad = ow * 0.9;
    const HAT = '#8f3227';

    const pt = (i, sgn, p) => ({
      x: wRig * LAT[i] + sgn * (w * WD[i] + p),
      y: baseY - L * T[i],
    });

    function conePath() {
      c.beginPath();
      for (let i = 0; i < 4; i++) {
        const p = pt(i, 1, pad);
        if (i === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      }
      for (let i = 3; i >= 0; i--) {
        const p = pt(i, -1, pad);
        c.lineTo(p.x, p.y);
      }
      c.closePath();
    }

    // pom-pom, behind the cone. Small and dulled: the rig's is a signature, but
    // a bright ball on the skyline was reading as the second moon.
    const tip = { x: wRig * LAT[3], y: baseY - L };
    c.beginPath();
    c.arc(tip.x, tip.y, w * 0.3, 0, TAU);
    const pgd = c.createRadialGradient(tip.x + w * 0.1, tip.y - w * 0.1, w * 0.03, tip.x, tip.y, w * 0.31);
    pgd.addColorStop(0, '#8e8377');
    pgd.addColorStop(0.55, '#5b544c');
    pgd.addColorStop(1, '#2b2724');
    c.fillStyle = pgd;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.1;
    c.stroke();

    conePath();
    const hg = c.createLinearGradient(w * 1.05, 0, -w * 1.3, 0);
    hg.addColorStop(0, shade(HAT, 1.34));
    hg.addColorStop(0.28, shade(HAT, 1.02));
    hg.addColorStop(0.7, shade(HAT, 0.54));
    hg.addColorStop(1, shade(HAT, 0.28));
    c.fillStyle = hg;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = ow * 1.8;
    c.stroke();

    c.save();
    conePath();
    c.clip();
    c.strokeStyle = 'rgba(24,8,12,0.5)';
    c.lineWidth = ow * 1.3;
    for (let i = 0; i < 3; i++) {
      const a = pt(1, -0.55 + i * 0.5, 0);
      const b = pt(2, -0.25 + i * 0.55, 0);
      c.beginPath();
      c.moveTo(a.x, a.y + L * 0.04);
      c.quadraticCurveTo(a.x - w * 0.22, b.y + L * 0.07, b.x, b.y);
      c.stroke();
    }
    const rimg = c.createLinearGradient(-w * 1.3, 0, -w * 0.4, 0);
    rimg.addColorStop(0, 'rgba(200,222,255,0.75)');
    rimg.addColorStop(1, 'rgba(200,222,255,0)');
    c.fillStyle = rimg;
    c.fillRect(-w * 1.6, baseY - L * 1.25, w * 1.2, L * 1.35);
    c.restore();

    // Rolled brim. It only has to reach the rig's own brim now — wRig*1.30 plus
    // its ink — so it can be a band rather than a pancake.
    const bw = Math.max(w * 0.98, wRig * 1.34 + ow);
    c.beginPath();
    c.moveTo(bw, baseY + w * 0.04);
    c.lineTo(-bw, baseY - w * 0.02);
    c.lineWidth = w * 0.44;
    c.strokeStyle = INK;
    c.stroke();
    const brimDark = c.createLinearGradient(bw, 0, -bw, 0);
    brimDark.addColorStop(0, shade(HAT, 1.1));
    brimDark.addColorStop(0.45, shade(HAT, 0.66));
    brimDark.addColorStop(1, shade(HAT, 0.3));
    c.strokeStyle = brimDark;
    c.lineWidth = w * 0.32;
    c.stroke();
    c.beginPath();
    c.moveTo(bw * 0.96, baseY + w * 0.11);
    c.lineTo(-bw * 0.96, baseY + w * 0.05);
    const brimg = c.createLinearGradient(bw, 0, -bw, 0);
    brimg.addColorStop(0, shade(HAT, 1.5));
    brimg.addColorStop(0.34, shade(HAT, 1.14));
    brimg.addColorStop(1, shade(HAT, 0.44));
    c.strokeStyle = brimg;
    c.lineWidth = w * 0.13;
    c.stroke();

    // studded band — the same studs that end up on the jacket, in gold rather
    // than the roster's own red, which vanished against the leather.
    MF.Shapes.spikeStrip(
      c,
      -bw * 0.62, baseY + w * 0.05,
      bw * 0.72, baseY + w * 0.09,
      5, u * 0.6, '#ffd23f',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
};

function startServer(root) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

if (!existsSync(ESBUILD)) throw new Error(`no esbuild at ${ESBUILD} — run npm install`);
if (!existsSync(PLAYWRIGHT_ENTRY)) {
  throw new Error(`playwright not found at ${PLAYWRIGHT_ENTRY} — set PLAYWRIGHT_ENTRY`);
}
const { chromium } = await import(PLAYWRIGHT_ENTRY);

const tmp = mkdtempSync(join(tmpdir(), 'mf-cover-'));

try {
  // 1. Bundle the game's art modules. `@` is the same alias vite.config.ts uses.
  writeFileSync(
    join(tmp, 'entry.ts'),
    [
      `export { drawCharacter } from '@/render/rig/CharacterRig';`,
      `export { DWARF_SKELETON, resolvePose } from '@/render/rig/Skeleton';`,
      `export { DWARFS, getDwarf } from '@/content/dwarfs';`,
      `export * as Shapes from '@/render/Shapes';`,
      '',
    ].join('\n'),
  );
  execFileSync(ESBUILD, [
    join(tmp, 'entry.ts'),
    '--bundle',
    '--format=esm',
    `--alias:@=${SRC}`,
    `--outfile=${join(tmp, 'mf.mjs')}`,
  ], { stdio: 'pipe' });

  // 2. The page. ES modules need HTTP, hence the server below.
  writeFileSync(
    join(tmp, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>cover</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
<canvas id="cv" width="${BIG.w}" height="${BIG.h}"></canvas>
<script type="module">
import * as MF from './mf.mjs';
window.MF = MF;
const probe = document.createElement('canvas').getContext('2d');
probe.font = '200px "Lato Black"';
await document.fonts.load('200px "Lato Black"');
await document.fonts.load('600 40px Lato');
await document.fonts.ready;
window.__ready = true;
</script>`,
  );

  const { server, port } = await startServer(tmp);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    await page.evaluate(paint, {
      ...CFG,
      headOnly: HEAD_ONLY !== undefined,
      guides: !!process.env.GUIDES,
      crewHead: process.env.CREW ?? null,
    });

    const dataUrl = await page.evaluate(() => document.getElementById('cv').toDataURL('image/png'));
    const big = join(tmp, 'big.png');
    writeFileSync(big, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));

    if (HEAD_ONLY !== undefined) {
      // A diagnostic, not a card: write the raw frame and skip the 1200x630
      // downsample, which would only shrink the head back to the size at which
      // these bugs were invisible in the first place.
      copyFileSync(big, HEAD_ONLY);
      console.log(`head-only diagnostic → ${HEAD_ONLY}${process.env.GUIDES ? ' (with guides)' : ''}`);
    } else {
      const card = join(DOCS, 'social-card.png');
      mkdirSync(DOCS, { recursive: true });
      execFileSync(MAGICK, [
        big,
        '-filter', 'Lanczos',
        '-resize', `${CARD.w}x${CARD.h}!`,
        '-strip',
        '-quality', '95',
        card,
      ]);

      mkdirSync(PUBLIC, { recursive: true });
      copyFileSync(card, join(PUBLIC, 'social-card.png'));

      const info = execFileSync('/usr/bin/identify', ['-format', '%wx%h %[colorspace] %B', card])
        .toString()
        .trim();
      if (!info.startsWith(`${CARD.w}x${CARD.h} `)) {
        throw new Error(`expected ${CARD.w}x${CARD.h}, got ${info}`);
      }
      console.log(`social-card.png  ${info}`);
      for (const d of [DOCS, PUBLIC]) console.log(`  wrote ${join(d, 'social-card.png')}`);

      if (process.env.KEEP_BIG) {
        copyFileSync(big, process.env.KEEP_BIG);
        console.log(`  wrote ${process.env.KEEP_BIG} (${BIG.w}x${BIG.h} supersample)`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
