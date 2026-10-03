# Mountain Fighters — Design System

This is the style guide for everything the player sees: the title, the menus,
the HUD, the banners, the touch pad. It explains what the rules are and why
they exist. If you add a screen, read the checklist at the bottom first.

The code that implements it lives in two places that must agree:

- `src/ui/theme.ts`: palette, player colours, type helpers, and the identity
  shapes, for everything drawn on the canvas.
- `src/ui/styles.css`: the same tokens as CSS custom properties, plus every
  DOM component.

If you change a value in one, change it in the other.

---

## 1. Direction: "Coal and Lamp"

Seven miners who swapped the tunic for leather, fighting through somebody
else's idea of the future. The look is the mine office after hours: warm
near-black plate, stencilled bone-coloured type, the light of a miner's lamp,
and blood. It is a punk brawler, so it leans forward and it is loud, but it is
loud in **one** colour at a time.

### What it replaced, and why

| Before | Problem | Now |
| --- | --- | --- |
| Cool blue-black "dark mode" surfaces, Material ripples and elevation | Read as a SaaS dashboard, not a game about dwarfs in a mine | Warm coal surfaces, stamped-plate panels, arcade menu lists |
| Hot magenta accent | Had nothing to do with the world, and fought the red of blood and health | Lamp gold for "yours / press this"; blood red only for danger and damage |
| System font stacks (`Impact`, `Arial Black`), declared separately in 12 files, in different orders | A different game on every OS. Android has neither font. A thick 26% outline closed the counters of every letter under 10px | One family, bundled: Barlow Condensed and Barlow, one module, outlines capped at 3.4px |
| Bright, saturated backdrops behind fighters in black leather | The scenery out-contrasted the people fighting in front of it | The scenery is graded down before the actors are drawn (§5) |
| Pink P1 on the select screen, gold P1 in the HUD | The same player was two colours | One player palette, by seat, everywhere (§3) |

---

## 2. Principles

1. **Value before hue.** In a fight, the fighters are the brightest and most
   contrasted thing on screen. The scenery sits underneath them. Colour cannot
   rescue a figure that has the same value as its background.
2. **One accent, one meaning.** Lamp gold marks the thing you are on and the
   thing to press. If two gold things are on screen, one of them is wrong.
3. **Blood is information.** Red means damage, danger, low health, K.O., or a
   boss. It is never decoration.
4. **Everything leans.** Slabs, bars, cards and the HUD plates lean forward by
   the same angle as the italic display face. Type and shape move together.
5. **Name the real control.** Every prompt shows the key or button that is
   actually under the player's finger, read from their bindings and their
   keyboard layout: `Z` on AZERTY, `LT` or `ZL` on a pad, `USE` on glass.
   Never print a hard-coded letter.
6. **The focused item is the interface.** On a pad or a keyboard, the focus is
   all the player has. It must always be visible, and only one thing is lit.

---

## 3. Tokens

### Palette

| Token (TS `PALETTE.*`) | CSS | Hex | Role |
| --- | --- | --- | --- |
| `coal` | `--bg` | `#0c0a09` | Page, letterbox, deepest shadow |
| `coal1` … `coal5` | `--surface-0` … `--surface-4` | `#141110` → `#3c332c` | Surfaces, lowest to highest |
| `line` / `lineStrong` | `--outline` / `--outline-strong` | `#3d342d` / `#5a4d42` | Hairlines, panel edges |
| `ink` | — | `#120d0b` | Outline of every canvas glyph and HUD shape |
| `bone` | `--on-surface` | `#f4ecdf` | Text. White is reserved for flashes |
| `boneDim` | `--on-surface-dim` | `#c2b4a1` | Secondary text |
| `boneFaint` | `--on-surface-faint` | `#8a7c6b` | Tertiary text, captions |
| `lamp` | `--accent` | `#ffb524` | Focus, call to action, health, P1 |
| `lampHot` / `lampDeep` | `--accent-hot` / `--accent-deep` | `#ffcb57` / `#b97800` | Highlight and shade of lamp |
| `onLamp` | `--on-accent` | `#1c1203` | Text on lamp |
| `blood` / `bloodHot` / `bloodDeep` | `--danger` / `--danger-hot` | `#e5322d` / `#ff5b4a` / `#8a1212` | Damage, danger, K.O., boss |
| `steel` | `--accent-2` | `#58c4ef` | Super meter, information, P2 |
| `moss` | `--ok` | `#74d68e` | Success, P4 |
| `warn` | `--warn` | `#ff9a1f` | Warnings, network stalls |

### Player colours

One colour per **seat** (player number), used by the select cursor, the HUD
plate and portrait ring, the marker over the head, the ring on the floor, and
the interact keycap: `lamp`, `steel`, `rose #ff6f9c`, `moss`. Every one of
those places also prints the number, so colour never carries identity alone.

A seat is not an input slot. A pad can sit on slot 2 and still be player one.
`FightPlayerPick.seat` carries the select screen's answer into the fight, and
the HUD reads it through `HudOptions.seats`.

### Shape and motion

- Radii are small: 2–6px. A stamped plate, not a phone app.
- The lean: `--lean: -8deg` in CSS; `slab(..., lean)` on canvas. HUD bars lean
  about 5px over their height.
- Panels carry a small lamp-gold triangle in the top-right corner, like a
  registration mark.
- Motion is quick and decisive: 80 / 140 / 220ms with a strong ease-out. Things
  slide in by a few pixels and settle. Nothing floats.
- Reduced motion (OS setting or the in-game toggle) removes every decorative
  animation. State changes stay visible.

---

## 4. Typography

Two faces, both SIL OFL, bundled from `@fontsource` and registered in
`src/ui/fonts.ts`. The first frame waits for them, up to 1.5s, because canvas
text does not reflow when a font arrives late.

| Face | Weight | Use |
| --- | --- | --- |
| Barlow Condensed | 900 italic | Logo, banners (`FIGHT!`, `MAP CLEAR`), big numbers, the score, combo counts, dwarf names |
| Barlow Condensed | 800 | Buttons, menu items, panel titles, HUD labels, keycaps |
| Barlow Condensed | 600 | Small caps captions, map strip, tracked taglines |
| Barlow | 500 / 700 | Anything that is a sentence: bios, help text, settings descriptions |

The rules:

- Canvas code never writes a font string by hand. Use `displayFont(size,
  weight, italic)` or `textFont(...)`. They are cached and carry the fallbacks.
- Outlined display text goes through `inkText()`: a short drop shadow, then an
  ink outline of `strokeFor(size)` (16% of the size, clamped to 1.2–3.4px), then
  the fill. Do not use thicker outlines. Past about 3px the outline competes
  with the letter.
- Capitals get tracking (`tracking` option, or `trackedText`); sentences do not.
- Text is bone on coal. Grey text on grey plate is not allowed. Use `boneDim`
  or `boneFaint`, which are warm and were checked for contrast.

---

## 5. In-fight readability

The fight is where the design either works or does not.

- **Stage grade** (`FightScene.gradeStage`). After the backdrop is drawn and
  before any actor, the whole painted set gets 28% of its saturation removed,
  is multiplied to about 82% of its value, and is vignetted toward coal at the
  corners. Actors, props and effects are drawn afterwards at full range. Tune
  with `STAGE_DESAT`, `STAGE_DIM` and `STAGE_VIGNETTE`. The test maps are the
  mine (darkest), the server farm (flattest) and the assembly line
  (brightest).
- **Rim light.** The character rig draws a cool back-light (`RIM` in
  `CharacterRig.ts`). Its offset grows sub-linearly above fight scale, so the
  big previews on the title and select screens show a line, not a slab.
- **Player ring.** A ring in the seat colour on the floor under each player,
  with a notch on the side they face. It answers "where exactly am I on the
  belt", which the marker over the head does not.
- **Marker.** A chevron and the player number over the head. It fades after a
  few seconds of idling and comes back on the first action.
- **Floating text** never overprints. A label born within a few frames of
  another one in the same spot starts a line above it.
- **Chromatic aberration** is capped at 2.25 virtual pixels. It is a hit
  accent, not a filter.

### HUD anatomy

```text
 ╭─╮ MALICE ············ ●●● P1      ← name (800), lives, seat tag in seat colour
 │☺│ ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱               ← health: lamp; chip behind it: blood; quarter ticks
 ╰─╯ ▰▰ ▱▱ ▱▱   [R2] SUPER          ← meter: steel, lamp when a bar is full, names the button
     PIT KNIFE           ▬▬▬▬       ← weapon and wear
```

- Health turns blood red and throbs below 25%.
- The score uses fixed digits, but the leading zeros sink into the plate so the
  number that matters is the thing you read.
- The boss bar sits at the bottom with its name on a blood slab, phase notches
  on the bar, and phase pips.

---

## 6. Components

**Menu (DOM, `.menu`).** An arcade list. Inside a `.menu` every button renders
as a menu item whatever variant it was built with: no box, a big stencilled
label. The focused item becomes a leaning lamp slab with a chevron. When the
page has no focus (opened from a link, behind another window), the
`[data-current]` item is lit instead, so a menu never shows nothing lit. `Ui`
keeps that attribute in sync.

**Panel (DOM, `.panel`).** For pages that need room: Settings, Controls,
results, the lobby. Use `panel(title, ...children)`.

**Buttons outside menus.** `filled` is the one call to action in a view.
`outlined` and `tonal` are everything else. `danger` is outlined blood that
fills on focus.

**Keycaps.** `<kbd>` in the DOM; `keycap()` and `hintRow()` on canvas. Every
"how to drive this screen" line is a row of keycaps followed by verbs.

**Slab and band (canvas).** `slab()` is the leaning parallelogram behind HUD
plates, cards and tags. `band()` is the full-width shutter every fight
announcement sits in.

**Settings.** There is one Settings page, `src/ui/SettingsPanel.ts`, mounted by
both the title and the pause menu. It is grouped as Sound, Feel, Content and
Game. Do not build a second one.

---

## 7. Layout

The game draws a 640×360 stage, letterboxed. DOM pieces that need to sit on a
particular part of the picture are positioned against the stage, not the
window, using `--stage-x`, `--stage-y`, `--stage-w` and `--stage-h` in
`styles.css`. These are computed exactly the way `Renderer.resize` fits the
canvas.

- **Wide (aspect > 5:4).** Title and pause put their menu in a column on the
  left of the stage, with the art on the right.
- **Tall (portrait phone).** The stage is pinned to the top of the screen. The
  menu, or the touch pad, gets the rest of the height. `HomeScene.isSplit()`
  and the CSS breakpoint use the same threshold. Keep them in sync.

---

## 8. Input and ergonomics

The same intent uses the same control on every screen:

| Intent | Keyboard | Pad | Touch |
| --- | --- | --- | --- |
| Move focus / choose | Arrows (and the bound movement keys on canvas screens) | D-pad / stick | Tap |
| Confirm | Enter or Space; on character select also the Light key | A | Tap (tap again to lock in a dwarf) |
| Back | Esc, Backspace | B | `‹` button, top left |
| Pause | Esc | Start | `II` button, top right |

On character select, Back first unlocks a locked pick, and only then leaves the
screen.

**Touch controls** (`src/engine/input/TouchControls.ts`):

- A floating stick on the left half that appears where the thumb lands. It
  rests faintly in place so the zone is discoverable. Past 40px it sends Run.
- On the right, a diamond in pad order: A light (bottom), B heavy (right),
  X jump (left), Y special (top). Block and Super sit above it, Grab and Use
  below.
- The pad appears when touch is the live input: a coarse pointer at boot, or
  the first touch. The first key press or connected pad hides it again, so a
  touchscreen laptop played on its keyboard never sees it.
- It feeds keyboard half zero, so lockstep, the HUD and every scene see an
  ordinary player-one input.

---

## 9. Checklist for a new screen

- [ ] Colours come from `PALETTE` or the CSS tokens, never a new hex. If a
      colour is missing, add it to both lists and to the table in §3.
- [ ] Fonts come from `displayFont` / `textFont` / `inkText`, or the CSS
      families.
- [ ] Exactly one lamp-gold "current" thing.
- [ ] Every control is reachable by keyboard, pad and touch. Confirm and Back
      behave as in §8.
- [ ] Every key name shown is read from the live bindings or the pad profile.
- [ ] It works at 1920×1080, at 844×390 (landscape phone) and at 390×844
      (portrait phone).
- [ ] Reduced motion removes the decoration and keeps the information.
