# Mountain Fighters — Architecture & Module Manifest

A satirical browser beat-em-up: the seven dwarfs, re-styled as bad boys, fight
through 70 maps of Musk-world security to rescue Snow White before she is
dissected for parts.

## Shape of the thing

- **TypeScript + Vite**, no framework, no runtime dependencies except `peerjs`.
- **Canvas2D** rendering at a virtual 640×360, letterboxed to the window.
- **All art is procedural vector geometry** drawn from skeletal rigs. There are
  no image files in this repository.
- **All audio is synthesised at runtime** with WebAudio. There are no audio
  files in this repository.
- Build output goes to `docs/` for GitHub Pages.

### Genre

Combat is Street Fighter in depth (frame data, hitstun/blockstun, cancels,
juggles, parries, meter) delivered in a Final Fight chassis (2.5D belt-scroller,
waves of enemies, weapon pickups, co-op). That is what lets four players share a
screen and still have combat worth learning.

### Coordinate system

```
 x — world horizontal, grows right
 z — depth into the screen, 0 = nearest camera, Z_DEPTH = far wall
 y — height above ground, grows UP, 0 = standing

 screenX = x - camera.x
 screenY = GROUND_Y + z * Z_SCALE - y
```

Entities draw back-to-front by descending `z`.

### Simulation model

A fixed 60Hz simulation with an interpolated renderer. The sim is **fully
deterministic**: no `Math.random`, no wall clock, seeded RNG only. That
determinism is what makes lockstep netcode possible, and it costs almost
nothing to maintain if respected from the start.

Presentation effects (particles, shake, audio) are routed through `FxBus` /
`AudioBus`, which are inert during rollback re-simulation. Sim code may call
them freely.

---

## Module manifest

This is the authoritative public API of every module. Modules import only what
is listed here. `src/core/types.ts` and `src/core/constants.ts` are the shared
contract and are never edited by feature work.

### `src/core/math.ts`

```ts
export const TAU: number;
export function clamp(v: number, min: number, max: number): number;
export function lerp(a: number, b: number, t: number): number;
export function approach(cur: number, target: number, step: number): number;
export function sign(v: number): -1 | 0 | 1;
export function dist2(ax: number, az: number, bx: number, bz: number): number;
export function easeIn(t: number): number;
export function easeOut(t: number): number;
export function easeInOut(t: number): number;
export function easeOutBack(t: number): number;
export function easeOutElastic(t: number): number;
export function angleLerp(a: number, b: number, t: number): number;
/** World-space overlap test for a hitbox against a hurtbox. */
export function boxOverlap(
  a: Box3, aPos: Vec3, aFace: Facing,
  b: Box3, bPos: Vec3, bFace: Facing,
): boolean;
/** Mixes a value into a rolling checksum. Used for desync detection. */
export function hashNumber(acc: number, v: number): number;
```

### `src/engine/Rng.ts`

```ts
export function makeRng(seed: number): Rng;   // mulberry32, implements core/types Rng
export function randomSeed(): number;          // NON-deterministic, boot-time only
```

### `src/engine/Loop.ts`

```ts
export interface LoopCallbacks {
  update(): void;              // one fixed sim step
  render(alpha: number): void; // alpha 0..1 interpolation
}
export class GameLoop {
  constructor(cb: LoopCallbacks);
  start(): void;
  stop(): void;
  /** Global time scale for slow-motion. 1 = normal. */
  timeScale: number;
  /** Frames of global hitstop remaining; the sim skips while > 0. */
  hitstop: number;
  readonly fps: number;
  readonly frame: number;
}
```

### `src/engine/Save.ts`

```ts
export function loadSave(): SaveData;
export function saveSave(data: SaveData): void;
export function defaultSave(): SaveData;
export function defaultSettings(): Settings;
```

### `src/engine/input/Bindings.ts`

```ts
/** Default keyboard layouts. Slot 0 = WASD + FGH/space, slot 1 = arrows + numpad. */
export const DEFAULT_BINDINGS: Record<number, Record<string, number>>;
export function bindingLabel(slot: number): string;
```

### `src/engine/input/KeyboardSource.ts`

```ts
export class KeyboardSource implements InputSource {
  constructor(slot: number, bindings: Record<string, number>);
  // Listens on window; call dispose() to detach.
}
/** Installed once at boot; all KeyboardSources read from this shared key state. */
export function installKeyboard(): void;
export function isKeyDown(code: string): boolean;
```

### `src/engine/input/GamepadSource.ts`

```ts
export class GamepadSource implements InputSource {
  constructor(padIndex: number);
}
/** Poll once per sim frame before sampling any GamepadSource. */
export function pollGamepads(): void;
export function connectedGamepads(): number[];
```

### `src/engine/input/InputManager.ts`

```ts
export class InputManager {
  /** Bind an input source to a player slot. */
  attach(slot: number, src: InputSource): void;
  detach(slot: number): void;
  source(slot: number): InputSource | null;
  /** Sample every attached source for this frame. Call once per sim step. */
  sampleAll(frame: number): void;
  /** Resolved input for a slot on the current frame, with pressed/released. */
  get(slot: number): InputFrame;
  /** Raw held mask, used by the netcode to transmit. */
  raw(slot: number): BtnMask;
  /** Override a slot's mask — used by lockstep to inject remote input. */
  override(slot: number, mask: BtnMask): void;
  readonly slots: number[];
}
```

### `src/render/Renderer.ts`

```ts
export class Renderer {
  constructor(canvas: HTMLCanvasElement);
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;   // always VIEW_W
  readonly height: number;  // always VIEW_H
  /** Resize backing store to the window, preserving aspect with letterboxing. */
  resize(): void;
  begin(): void;
  end(): void;
  clear(color: string): void;
  /** Push/pop the camera transform. */
  withCamera(cam: Camera, fn: () => void): void;
  /** Screen-space overlay drawing (HUD), unaffected by camera. */
  withScreen(fn: () => void): void;
  /** Convert world coords to screen coords under the current camera. */
  project(x: number, y: number, z: number, cam: Camera): Vec2;
  /** Full-screen colour flash used by the juice layer. */
  flash(color: string, alpha: number): void;
  /** Cheap chromatic-aberration pass; skipped when reduced motion is on. */
  aberration(strength: number): void;
}
```

### `src/render/Camera.ts`

```ts
export class Camera {
  x: number; y: number; zoom: number; rotation: number;
  /** Follow the midpoint of these world x positions, clamped to map bounds. */
  follow(targets: { x: number }[], mapWidth: number): void;
  /** Additive trauma-based shake. */
  addShake(spec: ShakeSpec): void;
  /** Momentary zoom kick. */
  punch(amount: number): void;
  update(): void;
  snapTo(x: number): void;
  readonly shakeX: number;
  readonly shakeY: number;
}
```

### `src/render/Shapes.ts`

Bold-outline vector primitives. Every shape draws a dark outline then a fill,
which is what gives the game its consistent cartoon look.

```ts
export function setOutline(ctx: C2D, width: number, color: string): void;
export function poly(ctx: C2D, pts: number[], fill: string, outline?: string, ow?: number): void;
export function roundRect(ctx: C2D, x, y, w, h, r, fill, outline?, ow?): void;
export function ellipse(ctx: C2D, x, y, rx, ry, rot, fill, outline?, ow?): void;
export function capsule(ctx: C2D, x1, y1, x2, y2, r, fill, outline?, ow?): void;
export function limb(ctx: C2D, x1, y1, x2, y2, w1, w2, fill, outline?): void;
export function star(ctx: C2D, x, y, r, points, fill, outline?): void;
export function spikeStrip(ctx: C2D, x1, y1, x2, y2, count, size, color): void;
export function shadow(ctx: C2D, x, y, rx, alpha): void;
export function zigzag(ctx: C2D, x1, y1, x2, y2, amp, segs, color, w): void;
export function burst(ctx: C2D, x, y, r, spikes, color, rot): void;
```

### `src/render/rig/Skeleton.ts`

```ts
export const DWARF_SKELETON: Bone[];
export const HUMAN_SKELETON: Bone[];   // taller, used for guards and humans
export interface ResolvedBone { name: BoneName; x: number; y: number; rot: number; scale: number; }
/** Applies a pose to a skeleton and resolves world-local transforms. */
export function resolvePose(skeleton: Bone[], pose: Pose, scale: number): Map<BoneName, ResolvedBone>;
```

### `src/render/rig/Anim.ts`

```ts
export const CLIPS: Record<string, AnimClip>;
/** Sample a clip at a frame, producing a blended pose. */
export function sampleClip(clip: AnimClip, frame: number): Pose;
export function blendPose(a: Pose, b: Pose, t: number): Pose;
export function registerClip(clip: AnimClip): void;
```

Required clip names: `idle`, `walk`, `run`, `jump`, `fall`, `land`, `punch1`,
`punch2`, `kick`, `uppercut`, `sweep`, `heavy_swing`, `block`, `hurt_light`,
`hurt_heavy`, `launched`, `knockdown`, `getup`, `grab`, `throw`, `stunned`,
`victory`, `dead`, `taunt`, `weapon_swing`, `weapon_heavy`, `pickup`,
`dress_start`, `dress_jacket`, `dress_shades`, `dress_pose`, `ride`.

### `src/render/rig/CharacterRig.ts`

The heart of the art direction — draws a whole character from a `RigStyle` plus
a resolved pose. `style.outfit` blends continuously from the classic film dwarf
(tunic, no shades) to the bad-boy look (spiked leather jacket, sunglasses),
which is exactly what the select-screen transformation animates.

```ts
export function drawCharacter(
  ctx: C2D, style: RigStyle, pose: Pose, skeleton: Bone[],
  x: number, y: number, facing: Facing, opts?: {
    weapon?: WeaponDef | null;
    flash?: number;        // 0..1 white hit flash
    tint?: string;
    alpha?: number;
    scale?: number;
  },
): void;
export function drawWeapon(ctx: C2D, w: WeaponDef, x: number, y: number, rot: number, facing: Facing): void;
```

### `src/juice/Particles.ts`

```ts
export class ParticleSystem {
  emit(spec: ParticleSpec): void;
  update(): void;
  render(ctx: C2D, cam: Camera): void;
  clear(): void;
  readonly count: number;
}
```

### `src/juice/Fx.ts`

Concrete `FxBus`, owning shake/flash/slowmo/floating text/shockwaves.

```ts
export class Fx implements FxBus {
  constructor(cam: Camera, particles: ParticleSystem, loop: GameLoop, settings: Settings);
  update(): void;
  render(ctx: C2D, cam: Camera): void;      // world-space layer (shockwaves, text)
  renderOverlay(r: Renderer): void;          // screen-space layer (flash, aberration)
  muted: boolean;
}
```

### `src/audio/Synth.ts`

```ts
export class Synth {
  constructor();
  /** Must be called from a user gesture to unlock WebAudio. */
  unlock(): void;
  play(cue: SfxCue, opts?: { pitch?: number; gain?: number; pan?: number }): void;
  voice(profile: VoiceProfile, kind: 'hit'|'attack'|'ko'|'taunt'|'jump'): void;
  setVolume(master: number, sfx: number): void;
  readonly ready: boolean;
}
```

### `src/audio/Music.ts`

```ts
export class Music {
  constructor(ctx: AudioContext, out: GainNode);
  play(mood: MusicMood): void;
  stop(): void;
  setVolume(v: number): void;
  update(): void;   // called each render frame to schedule ahead
}
```

### `src/audio/AudioSystem.ts`

```ts
export class AudioSystem implements AudioBus {
  constructor(settings: Settings);
  unlock(): void;
  play(cue, opts?): void;
  music(mood): void;
  voice(profile, kind): void;
  update(): void;
  muted: boolean;
}
```

### `src/game/combat/Moves.ts`

```ts
export const MOVES: Record<string, MoveDef>;
export function getMove(id: string): MoveDef;
export function registerMove(m: MoveDef): void;
```

### `src/game/combat/Combat.ts`

```ts
export interface PendingHit { attackerId: number; window: HitWindow; frame: number; }
export class CombatResolver {
  constructor(fx: FxBus, audio: AudioBus);
  /** Resolve all live hitboxes against all hurtboxes for this frame. */
  resolve(fighters: Fighter[], ctx: SimContext): void;
  /** Per-attack hit registry so one active window hits each target once. */
  reset(): void;
}
```

### `src/game/Fighter.ts`

The shared body for players, enemies and bosses — physics, the state machine,
move execution, hitstun, meter, weapons.

```ts
export interface FighterInit {
  id: number; team: Team; x: number; z: number;
  style: RigStyle; skeleton: Bone[];
  health: number; speed: number; power: number; jump?: number;
  moves: Record<string, string>;   // logical slot -> move id
  voice: VoiceProfile;
  archetype: string;
  isBoss?: boolean;
}
export class Fighter implements FighterView {
  constructor(init: FighterInit);
  update(input: InputFrame, ctx: SimContext): void;
  render(ctx: C2D, cam: Camera, alpha: number): void;
  takeHit(props: HitProperties, fromX: number, ctx: SimContext, attacker: Fighter): boolean;
  startMove(id: string, ctx: SimContext): boolean;
  giveWeapon(kind: WeaponKind): void;
  dropWeapon(ctx: SimContext): void;
  addMeter(v: number): void;
  get alive(): boolean;
  checksum(): number;   // for desync detection
  // plus every FighterView member
}
```

### `src/game/ai/EnemyAI.ts`

```ts
export class EnemyAI implements InputSource {
  constructor(self: Fighter, profile: AiProfile, world: () => Fighter[]);
  // Produces a BtnMask each frame as though it were a controller.
}
```

### `src/game/Level.ts`

Owns one map: scrolling, wave spawning, props, pickups, the boss encounter.

```ts
export class Level {
  constructor(def: MapDef, players: Fighter[], deps: {
    fx: FxBus; audio: AudioBus; cam: Camera; rng: Rng;
  });
  update(ctx: SimContext): void;
  render(ctx: C2D, cam: Camera, alpha: number): void;
  renderBackground(ctx: C2D, cam: Camera): void;
  readonly fighters: Fighter[];
  readonly complete: boolean;
  readonly failed: boolean;
  readonly bossActive: boolean;
}
```

### `src/game/Backdrop.ts`

```ts
/** Procedural parallax scenery, entirely driven by MapPalette + MapTheme. */
export function drawBackdrop(ctx: C2D, def: MapDef, cam: Camera, frame: number): void;
export function drawForeground(ctx: C2D, def: MapDef, cam: Camera, frame: number): void;
```

### `src/content/*`

```ts
// dwarfs.ts
export const DWARFS: DwarfDef[];
export function getDwarf(id: string): DwarfDef;
// enemies.ts
export const ENEMIES: Record<EnemyKind, EnemyDef>;
// bosses.ts
export const BOSSES: BossDef[];
export function bossForMap(index: number): BossDef | null;
// weapons.ts
export const WEAPONS: Record<WeaponKind, WeaponDef>;
// maps.ts
export const MAPS: MapDef[];              // all 70, generated from themed seeds
export function getMap(index: number): MapDef;
// story.ts
export const INTRO_TEXT: string[];
export const BOSS_INTROS: Record<string, string[]>;
```

### `src/net/*`

```ts
// Room.ts
export function createRoomId(): string;
export function roomIdFromUrl(): string | null;
export function inviteLink(roomId: string): string;
// NetSession.ts
export class NetSession {
  constructor(cfg: NetConfig);
  host(): Promise<string>;            // resolves to room id
  join(roomId: string): Promise<void>;
  send(msg: NetMessage): void;
  onMessage(fn: (m: NetMessage, from: string) => void): void;
  onPlayersChanged(fn: (p: NetPlayer[]) => void): void;
  close(): void;
  readonly role: NetRole;
  readonly players: NetPlayer[];
  readonly connected: boolean;
}
// Lockstep.ts
export class Lockstep {
  constructor(session: NetSession, input: InputManager, cfg: NetConfig);
  /** Returns true when the sim may advance this frame. */
  canAdvance(frame: number): boolean;
  /** Push local input and pull remote input into the InputManager. */
  prepare(frame: number): void;
  confirm(frame: number, checksum: number): void;
  readonly desynced: boolean;
  readonly stalledFrames: number;
}
```

### `src/ui/*`

Material-inspired dark UI, keyboard and pointer accessible, with a ripple on
every control and a `prefers-reduced-motion` path.

```ts
// Ui.ts
export class Ui {
  constructor(root: HTMLElement);
  show(view: HTMLElement): void;
  clear(): void;
}
// Widgets.ts
export function button(label: string, onClick: () => void, opts?): HTMLButtonElement;
export function panel(title: string, ...children: HTMLElement[]): HTMLElement;
export function slider(label, min, max, value, onChange): HTMLElement;
export function toggle(label, value, onChange): HTMLElement;
export function attachRipple(el: HTMLElement): void;
// Hud.ts
export function drawHud(ctx: C2D, players: Fighter[], level: Level, frame: number): void;
```

### `src/scenes/*`

`HomeScene`, `SelectScene`, `FightScene`, `PauseScene`, `VictoryScene`,
`GameOverScene`, `LobbyScene` — each implements `Scene` from `core/types.ts`.

### `src/Game.ts`

Top-level wiring: owns the renderer, loop, audio, input, save data, scene stack
and the active net session.

---

## Controls

| Action | Player 1 | Player 2 | Gamepad |
| --- | --- | --- | --- |
| Move | `WASD` | Arrows | Left stick / d-pad |
| Light | `F` | `Numpad 1` | A / ✕ |
| Heavy | `G` | `Numpad 2` | B / ○ |
| Jump | `Space` | `Numpad 0` | X / □ |
| Special | `H` | `Numpad 3` | Y / △ |
| Block | `Shift` | `Numpad .` | RB / R1 |
| Grab | `R` | `Numpad 5` | LB / L1 |
| Super | `T` | `Numpad +` | RT / R2 |
| Pause | `Esc` | `Esc` | Start |

## Netplay

WebRTC data channels brokered by PeerJS. The host creates a room, the URL
carries `#join=<roomId>`, and a guest who opens that link goes straight to
character select and then into the running game.

Netcode is **input-delay lockstep** with a rolling checksum: simple, exact, and
honest about its tradeoff (a few frames of input latency instead of the
mispredictions of rollback). Determinism is enforced by the sim rules above.

The default broker is the public PeerJS cloud server, so there is no
infrastructure to run. `NetConfig.host` can point at a self-hosted PeerServer
instead.
