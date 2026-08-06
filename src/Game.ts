/**
 * The whole machine, in one object.
 *
 * Game owns every long-lived system — renderer, loop, camera, particles, juice,
 * audio, input, save data, the net session — and a *stack* of scenes rather
 * than a single one. The stack is what lets the pause menu sit on top of a
 * running fight instead of destroying it: PauseScene is pushed, FightScene
 * keeps its world, and popping the pause hands the fight straight back.
 *
 * The loop is wired so that only the TOP scene simulates, while the ENTIRE
 * stack renders, bottom-up. A paused fight therefore still draws, still shows
 * its combatants mid-swing, and simply stops advancing.
 *
 * Scenes never construct systems of their own. They read them off the Game they
 * were handed, and they change scene by asking Game to do it — which is queued
 * and applied at a frame boundary, so a scene can safely retire itself from
 * inside its own update().
 */

import { AudioSystem } from '@/audio/AudioSystem';
import {
  DEFAULT_INPUT_DELAY,
  FIXED_DT,
  MAX_LOCAL_PLAYERS,
  STARTING_LIVES,
  TOTAL_MAPS,
} from '@/core/constants';
import { clamp } from '@/core/math';
import type { NetConfig, Rng, SaveData, Scene, SceneName, Settings } from '@/core/types';
import { GameLoop } from '@/engine/Loop';
import { makeRng, randomSeed } from '@/engine/Rng';
import { loadSave, saveSave } from '@/engine/Save';
import { defaultBindingsFor } from '@/engine/input/Bindings';
import { GamepadSource, connectedGamepads } from '@/engine/input/GamepadSource';
import { InputManager } from '@/engine/input/InputManager';
import { KeyboardSource, refreshOwnedKeys } from '@/engine/input/KeyboardSource';
import { Fx } from '@/juice/Fx';
import { ParticleSystem } from '@/juice/Particles';
import { Lockstep } from '@/net/Lockstep';
import { NetSession } from '@/net/NetSession';
import { clearRoomFromUrl } from '@/net/Room';
import { Camera } from '@/render/Camera';
import { Renderer } from '@/render/Renderer';
import { Ui, setReducedMotion } from '@/ui/Ui';

import { FightScene } from '@/scenes/FightScene';
import { GameOverScene } from '@/scenes/GameOverScene';
import { HomeScene } from '@/scenes/HomeScene';
import { GalleryScene } from '@/scenes/GalleryScene';
import { LobbyScene } from '@/scenes/LobbyScene';
import { PauseScene } from '@/scenes/PauseScene';
import { SelectScene } from '@/scenes/SelectScene';
import { VictoryScene } from '@/scenes/VictoryScene';

type C2D = CanvasRenderingContext2D;

/** Anything Game can be asked to make current: a name, or a ready-made scene. */
export type SceneRef = SceneName | Scene;

interface SceneCtor {
  new (game: Game): Scene;
}

/** FightScene exposes this so lockstep can compare worlds across the wire. */
interface Checksummed {
  checksum(): number;
}

/**
 * Optional hook for a scene that has just had an overlay popped off it. It was
 * never exited, so `enter` must not be called again — that would rebuild a
 * world the player is standing in. This is the polite way back.
 */
interface Resumable {
  resume(): void;
}

/** State that belongs to a playthrough rather than to any one scene. */
export interface RunState {
  /** Dwarf id chosen for each player slot. null = nobody in that slot. */
  dwarfs: (string | null)[];
  /** Slots actually fighting, ascending. */
  slots: number[];
  /** 1-based map index, 1..TOTAL_MAPS. */
  mapIndex: number;
  score: number;
  lives: number;
  /** Seed the whole run's deterministic RNG was built from. */
  seed: number;
  /** Continues burned. The arcade always did want another coin. */
  continues: number;
  /** True when this run is a netplay match. */
  online: boolean;
}

const SCENE_CLASSES: Partial<Record<SceneName, SceneCtor>> = {
  home: HomeScene,
  select: SelectScene,
  fight: FightScene,
  pause: PauseScene,
  victory: VictoryScene,
  gameover: GameOverScene,
  lobby: LobbyScene,
  gallery: GalleryScene,
};

type Op =
  | { kind: 'replace'; ref: SceneRef; params: unknown }
  | { kind: 'push'; ref: SceneRef; params: unknown }
  | { kind: 'pop' }
  | { kind: 'clear' };

/** Matches --bg in the stylesheet, so the letterbox and the canvas agree. */
const CLEAR_COLOR = '#06070a';
/** A scene chain longer than this is a bug, not a design. */
const MAX_TRANSITIONS = 32;

function hasChecksum(s: Scene): s is Scene & Checksummed {
  return typeof (s as Partial<Checksummed>).checksum === 'function';
}

function isEditable(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly particles: ParticleSystem;
  readonly loop: GameLoop;
  readonly fx: Fx;
  readonly audio: AudioSystem;
  readonly input: InputManager;
  readonly ui: Ui;

  /** Persisted progress and settings. Mutate in place; call saveNow() after. */
  save: SaveData;

  /** Deterministic RNG for the current run. Replaced by newRun(). */
  rng: Rng;

  readonly run: RunState;

  /** Netplay broker + latency configuration. Edited by the lobby. */
  netConfig: NetConfig = { inputDelay: DEFAULT_INPUT_DELAY };

  /** Room id lifted out of a `#join=` link at boot, waiting for the lobby. */
  pendingJoin: string | null = null;

  /** Installed by main.ts so a crash paints an apology instead of a void. */
  onFatal: ((err: unknown) => void) | null = null;

  private readonly stack: Scene[] = [];
  private readonly queue: Op[] = [];
  private applying = false;
  private inFrame = false;
  private dead = false;
  private resizePending = false;
  private worldFxDrawn = false;
  private audioUnlocked = false;

  private _net: NetSession | null = null;
  private _lockstep: Lockstep | null = null;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.save = loadSave();

    this.renderer = new Renderer(canvas);
    this.camera = new Camera();
    this.particles = new ParticleSystem();
    this.loop = new GameLoop({
      update: () => this.step(),
      render: (alpha) => this.draw(alpha),
    });
    this.fx = new Fx(this.camera, this.particles, this.loop, this.save.settings);
    this.audio = new AudioSystem(this.save.settings);
    this.input = new InputManager();
    this.ui = new Ui(uiRoot);

    this.run = {
      dwarfs: new Array<string | null>(MAX_LOCAL_PLAYERS).fill(null),
      slots: [0],
      mapIndex: 1,
      score: 0,
      lives: STARTING_LIVES,
      seed: randomSeed(),
      continues: 0,
      online: false,
    };
    this.rng = makeRng(this.run.seed);

    setReducedMotion(this.save.settings.reducedMotion);
    // The keys whose default action gets suppressed must follow the SAVED
    // bindings, not the shipped ones — somebody who moved Jump onto PageDown
    // last week should not scroll the page the first time they jump today.
    refreshOwnedKeys(this.save.settings.bindings);
    this.attachKeyboards(2);
    this.installListeners();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.dead) return;
    this.renderer.resize();
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Tear the whole thing down. Only the page unloading should need this. */
  dispose(): void {
    this.loop.stop();
    // Straight to unwind: enqueue() is a no-op once `dead` is set, so going
    // through the queue here would leave every scene un-exited.
    this.queue.length = 0;
    this.unwind(0);
    this.dead = true;
    this.leaveNet();
    this.releaseInputs();
    this.removeListeners();
    this.ui.clear();
  }

  get frame(): number {
    return this.loop.frame;
  }

  get settings(): Settings {
    return this.save.settings;
  }

  // ── Scene stack ────────────────────────────────────────────────────────────

  /** The scene currently simulating: the top of the stack. */
  get scene(): Scene | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  get sceneName(): string {
    return this.scene?.name ?? '';
  }

  /** Bottom-up view of the stack, for anything that needs to inspect it. */
  get scenes(): readonly Scene[] {
    return this.stack;
  }

  /** True when a scene with this name is anywhere in the stack. */
  hasScene(name: string): boolean {
    for (const s of this.stack) {
      if (s.name === name) return true;
    }
    return false;
  }

  /** Find a live scene by name — how PauseScene reaches the fight beneath it. */
  findScene(name: string): Scene | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].name === name) return this.stack[i];
    }
    return null;
  }

  /** Replace the entire stack with one scene. The usual transition. */
  changeScene(ref: SceneRef, params?: unknown): void {
    this.enqueue({ kind: 'replace', ref, params });
  }

  /** Alias for changeScene, for callers who think in terms of setting. */
  setScene(ref: SceneRef, params?: unknown): void {
    this.enqueue({ kind: 'replace', ref, params });
  }

  /** Overlay a scene without disturbing what is underneath (pause, cutscene). */
  pushScene(ref: SceneRef, params?: unknown): void {
    this.enqueue({ kind: 'push', ref, params });
  }

  /** Drop the top overlay and hand control back to the scene below it. */
  popScene(): void {
    this.enqueue({ kind: 'pop' });
  }

  /** Empty the stack. Nothing simulates until something is pushed back on. */
  clearScenes(): void {
    this.enqueue({ kind: 'clear' });
  }

  goHome(): void {
    this.changeScene('home');
  }

  private enqueue(op: Op): void {
    if (this.dead) return;
    this.queue.push(op);
    if (!this.inFrame) this.flushScenes();
  }

  private flushScenes(): void {
    if (this.applying) return;
    this.applying = true;
    try {
      let guard = 0;
      while (this.queue.length > 0) {
        if (++guard > MAX_TRANSITIONS) {
          this.queue.length = 0;
          console.error('[game] scene transitions are looping; the queue was dropped.');
          break;
        }
        const op = this.queue.shift();
        if (op) this.execute(op);
      }
    } finally {
      this.applying = false;
    }
  }

  private execute(op: Op): void {
    switch (op.kind) {
      case 'clear':
        this.unwind(0);
        this.ui.clear();
        break;

      case 'pop': {
        if (this.stack.length === 0) break;
        this.unwind(this.stack.length - 1);
        // The overlay's menu goes with it; the scene below re-mounts its own.
        this.ui.clear();
        const below = this.scene;
        // Popping the last scene would leave nothing driving the game at all.
        if (!below) {
          this.queue.unshift({ kind: 'replace', ref: 'home', params: undefined });
          break;
        }
        const resume = (below as Partial<Resumable>).resume;
        if (typeof resume === 'function') {
          try {
            resume.call(below);
          } catch (e) {
            this.fail(e);
          }
        }
        break;
      }

      case 'replace': {
        const next = this.build(op.ref);
        if (!next) break;
        this.unwind(0);
        this.ui.clear();
        this.particles.clear();
        this.stack.push(next);
        this.enterScene(next, op.params);
        break;
      }

      case 'push': {
        const next = this.build(op.ref);
        if (!next) break;
        // No ui.clear() here: Ui.show() replaces the view anyway, and an
        // overlay that draws on the canvas has no business evicting a menu
        // the scene beneath it still owns.
        this.stack.push(next);
        this.enterScene(next, op.params);
        break;
      }
    }
  }

  /** Exits and removes every scene above `depth`, top-down. */
  private unwind(depth: number): void {
    while (this.stack.length > depth) {
      const s = this.stack.pop();
      if (!s) break;
      try {
        s.exit();
      } catch (e) {
        console.error(`[game] scene "${s.name}" threw while exiting:`, e);
      }
    }
  }

  private enterScene(scene: Scene, params: unknown): void {
    try {
      scene.enter(params);
    } catch (e) {
      this.fail(e);
    }
  }

  private build(ref: SceneRef): Scene | null {
    if (typeof ref !== 'string') return ref;
    const Ctor = SCENE_CLASSES[ref];
    if (!Ctor) {
      // 'boot' and 'cutscene' have no class of their own; anything else is a
      // typo. Either way, dumping the player on the home screen beats a freeze.
      console.error(`[game] no scene registered for "${ref}"; falling back to home.`);
      const Home = SCENE_CLASSES.home;
      return Home ? new Home(this) : null;
    }
    try {
      return new Ctor(this);
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  private step(): void {
    if (this.dead) return;
    this.inFrame = true;
    try {
      const top = this.scene;
      if (!top) return;

      const frame = this.loop.frame;
      const ls = this._lockstep;
      // Lockstep only gates an actual fight. Gating a menu would freeze the
      // lobby the instant a second peer appeared, which is exactly when the
      // lobby has the most to do.
      const gated = ls !== null && ls.active && top.name === 'fight';

      if (gated && ls !== null && !ls.canAdvance(frame)) return;

      this.input.sampleAll(frame);
      if (gated && ls !== null) ls.prepare(frame);

      top.update(FIXED_DT);

      if (gated && ls !== null && ls.shouldChecksum(frame) && hasChecksum(top)) {
        ls.confirm(frame, top.checksum() | 0);
      }

      // Presentation runs on the same clock as the sim, so hitstop freezes the
      // sparks mid-air and slow motion drags them with it.
      this.camera.update();
      this.particles.update();
      this.fx.update();
    } catch (e) {
      this.fail(e);
    } finally {
      this.inFrame = false;
      this.flushScenes();
    }
  }

  private draw(alpha: number): void {
    if (this.dead) return;
    this.inFrame = true;
    try {
      const r = this.renderer;
      r.begin();
      r.clear(CLEAR_COLOR);

      this.worldFxDrawn = false;
      for (let i = 0; i < this.stack.length; i++) {
        this.stack[i].render(alpha);
      }
      // A scene that never asked for the world layer still gets its particles;
      // nothing should be able to silently swallow the juice.
      if (!this.worldFxDrawn) {
        r.withCamera(this.camera, () => this.renderWorldFx(r.ctx));
      }

      this.fx.renderOverlay(r);
      r.end();

      this.audio.update();
    } catch (e) {
      this.fail(e);
    } finally {
      this.inFrame = false;
      this.flushScenes();
    }
  }

  /**
   * Particles and the world-space juice layer. Scenes call this from inside
   * their own `withCamera` block, at whatever depth they want the sparks to
   * land in the draw order.
   */
  renderWorldFx(ctx: C2D): void {
    this.worldFxDrawn = true;
    this.particles.render(ctx, this.camera);
    this.fx.render(ctx, this.camera);
  }

  private fail(err: unknown): void {
    if (this.dead) return;
    this.dead = true;
    console.error('[game] fatal:', err);
    this.loop.stop();
    try {
      this.onFatal?.(err);
    } catch {
      /* the error handler failing too is not worth a second explosion */
    }
  }

  // ── Run state ──────────────────────────────────────────────────────────────

  get score(): number {
    return this.run.score;
  }

  set score(v: number) {
    this.run.score = Math.max(0, Math.floor(v));
  }

  get lives(): number {
    return this.run.lives;
  }

  set lives(v: number) {
    this.run.lives = Math.max(0, Math.floor(v));
  }

  get mapIndex(): number {
    return this.run.mapIndex;
  }

  set mapIndex(v: number) {
    this.run.mapIndex = clamp(Math.floor(v), 1, TOTAL_MAPS);
  }

  /** Wipes the run and reseeds it. Called when a new game actually begins. */
  newRun(opts?: { seed?: number; mapIndex?: number; online?: boolean; slots?: number[] }): void {
    const run = this.run;
    run.seed = opts?.seed !== undefined && Number.isFinite(opts.seed) ? opts.seed >>> 0 : randomSeed();
    run.mapIndex = clamp(Math.floor(opts?.mapIndex ?? 1), 1, TOTAL_MAPS);
    run.online = opts?.online ?? false;
    run.score = 0;
    run.lives = STARTING_LIVES;
    run.continues = 0;
    if (opts?.slots && opts.slots.length > 0) {
      run.slots = [...new Set(opts.slots)].sort((a, b) => a - b);
    }
    this.rng = makeRng(run.seed);
    this.particles.clear();
  }

  /** Reseeds mid-run — used when the host announces the seed for a match. */
  reseed(seed: number): void {
    this.run.seed = Number.isFinite(seed) ? seed >>> 0 : this.run.seed;
    this.rng = makeRng(this.run.seed);
  }

  dwarfFor(slot: number): string | null {
    return this.run.dwarfs[slot] ?? null;
  }

  setDwarf(slot: number, dwarfId: string | null): void {
    if (slot < 0 || slot >= MAX_LOCAL_PLAYERS) return;
    this.run.dwarfs[slot] = dwarfId;
    if (dwarfId === null) {
      this.run.slots = this.run.slots.filter((s) => s !== slot);
    } else if (!this.run.slots.includes(slot)) {
      this.run.slots.push(slot);
      this.run.slots.sort((a, b) => a - b);
    }
  }

  /** The slot whose score and clear record go in the save file. */
  get primaryDwarf(): string | null {
    for (const slot of this.run.slots) {
      const id = this.run.dwarfs[slot];
      if (id) return id;
    }
    return null;
  }

  addScore(points: number): void {
    if (!Number.isFinite(points)) return;
    this.run.score = Math.max(0, this.run.score + Math.floor(points));
  }

  /** Spends a life. Returns true if there is still someone left to send in. */
  loseLife(): boolean {
    if (this.run.lives > 0) this.run.lives--;
    return this.run.lives > 0;
  }

  /** Pays the arcade tax and puts the lives back. */
  useContinue(): void {
    this.run.continues++;
    this.run.lives = STARTING_LIVES;
    this.run.score = 0;
  }

  /** Steps to the next map. False means map 70 is behind you and it is over. */
  advanceMap(): boolean {
    if (this.run.mapIndex >= TOTAL_MAPS) return false;
    this.run.mapIndex++;
    this.recordProgress();
    return true;
  }

  /** Folds the run into the save file: unlocks, high score, cleared list. */
  recordProgress(cleared = false): void {
    const save = this.save;
    save.progress = clamp(Math.max(save.progress, this.run.mapIndex), 1, TOTAL_MAPS);
    const id = this.primaryDwarf;
    if (id) {
      const best = save.scores[id] ?? 0;
      if (this.run.score > best) save.scores[id] = this.run.score;
      if (cleared && !save.cleared.includes(id)) save.cleared.push(id);
    }
    this.saveNow();
  }

  // ── Settings & save ────────────────────────────────────────────────────────

  saveNow(): void {
    saveSave(this.save);
  }

  /**
   * Call after anything mutates settings. Systems hold a live reference to the
   * same object, so the only things to push out are the DOM-side ones.
   */
  applySettings(): void {
    setReducedMotion(this.save.settings.reducedMotion);
    this.saveNow();
  }

  /**
   * Adopt a new set of keyboard bindings — saved, suppressed and live, in that
   * order and without a reload.
   *
   * A rebind has to land on the fight that is running RIGHT NOW, not on the next
   * launch: the pause menu sits on top of a frozen fight, and a player who
   * remaps Heavy there expects to walk back into the fight and use it. So the
   * new map is pushed into every KeyboardSource that is already attached rather
   * than being left for the next one to read.
   *
   * `refreshOwnedKeys` is what keeps preventDefault honest: it claims whatever
   * is bound now and releases whatever no longer is, so a freshly-bound PageDown
   * stops scrolling the document and a freed one starts again.
   */
  applyBindings(next: Record<number, Record<string, number>>): void {
    if (!next || typeof next !== 'object') return;

    // Merge rather than replace: an editor showing two slots must not silently
    // wipe a third that only a gamepad-less fourth player ever uses.
    const merged: Record<number, Record<string, number>> = { ...this.save.settings.bindings };
    for (const key of Object.keys(next)) {
      const slot = Number(key);
      const map = next[slot];
      if (!Number.isInteger(slot) || slot < 0 || !map || typeof map !== 'object') continue;
      merged[slot] = { ...map };
    }
    this.save.settings.bindings = merged;

    refreshOwnedKeys(merged);

    for (const slot of this.input.slots) {
      const src = this.input.source(slot);
      // Through keyboardMapFor, so a solo player rebinding mid-fight keeps both
      // halves of the board rather than being quietly cut back to one.
      if (src instanceof KeyboardSource) {
        src.setBindings(this.keyboardMapFor(slot, this.localKeyboardCount));
      }
    }

    this.saveNow();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Binds the saved keyboard layouts to the first `count` local slots. */
  attachKeyboards(count = 1): void {
    const n = clamp(Math.floor(count), 0, MAX_LOCAL_PLAYERS);
    this.localKeyboardCount = n;
    for (let slot = 0; slot < n; slot++) {
      this.detachSlot(slot);
      this.input.attach(slot, new KeyboardSource(slot, this.keyboardMapFor(slot, n)));
    }
    // Dropping from two local players back to one must also drop player two's
    // keyboard, or their half of the board keeps driving a fighter nobody is
    // playing. Gamepads on those slots are left alone.
    for (let slot = n; slot < MAX_LOCAL_PLAYERS; slot++) {
      if (this.input.source(slot) instanceof KeyboardSource) this.detachSlot(slot);
    }
  }

  /**
   * The key map a local slot should listen to.
   *
   * Playing alone, there is nobody to share the board with, so the lone player
   * gets BOTH halves of it: the WASD diamond and the arrows, F/G/H and the
   * numpad, whichever hand happens to be nearest. Slot 0 wins any key the two
   * sets disagree on. As soon as a second local player exists the sets split
   * back apart, because player two needs their half back.
   */
  /** How many local slots are currently driven by a keyboard. */
  private localKeyboardCount = 0;

  private keyboardMapFor(slot: number, localCount: number): Record<string, number> {
    const own = this.save.settings.bindings[slot] ?? defaultBindingsFor(slot);
    if (localCount > 1 || slot !== 0) return own;

    const merged: Record<string, number> = {};
    for (let s = MAX_LOCAL_PLAYERS - 1; s >= 1; s--) {
      const other = this.save.settings.bindings[s] ?? defaultBindingsFor(s);
      for (const code of Object.keys(other)) merged[code] = other[code];
    }
    for (const code of Object.keys(own)) merged[code] = own[code];
    return merged;
  }

  /**
   * Hands every connected pad a slot, starting at `fromSlot`. Returns how many
   * were bound. A pad always wins the slot it is given: whoever picks up a
   * controller wants to use the controller.
   */
  attachGamepads(fromSlot = 0): number {
    const pads = connectedGamepads();
    let slot = clamp(Math.floor(fromSlot), 0, MAX_LOCAL_PLAYERS - 1);
    let bound = 0;
    for (const pad of pads) {
      if (slot >= MAX_LOCAL_PLAYERS) break;
      this.detachSlot(slot);
      this.input.attach(slot, new GamepadSource(pad));
      slot++;
      bound++;
    }
    return bound;
  }

  detachSlot(slot: number): void {
    const src = this.input.source(slot);
    src?.dispose?.();
    this.input.detach(slot);
  }

  releaseInputs(): void {
    for (const slot of [...this.input.slots]) this.detachSlot(slot);
  }

  // ── Netplay ────────────────────────────────────────────────────────────────

  get net(): NetSession | null {
    return this._net;
  }

  get lockstep(): Lockstep | null {
    return this._lockstep;
  }

  get online(): boolean {
    return this._net !== null && this._net.role !== 'offline' && this._net.connected;
  }

  /**
   * The session and its lockstep are created together and left running; both
   * are inert until a peer actually shows up, so there is no state to juggle.
   */
  ensureNet(): NetSession {
    if (!this._net) {
      this._net = new NetSession(this.netConfig);
      this._lockstep = new Lockstep(this._net, this.input, this.netConfig);
    }
    return this._net;
  }

  /** Opens a room. Resolves with the id that goes in the invite link. */
  async hostRoom(name = 'Host'): Promise<string> {
    const session = this.ensureNet();
    const id = await session.host(name);
    this._lockstep?.reset(this.loop.frame);
    return id;
  }

  /** Joins a room by id or pasted invite link. */
  async joinRoom(roomId: string, name = 'Guest'): Promise<void> {
    const session = this.ensureNet();
    await session.join(roomId, name);
    this.pendingJoin = null;
    this._lockstep?.reset(this.loop.frame);
  }

  /** Hangs up, forgets the room, and drops the `#join=` fragment. */
  leaveNet(): void {
    this._lockstep?.dispose();
    this._lockstep = null;
    this._net?.close();
    this._net = null;
    this.pendingJoin = null;
    this.run.online = false;
    clearRoomFromUrl();
  }

  // ── Browser plumbing ───────────────────────────────────────────────────────

  private installListeners(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('gamepadconnected', this.onGamepad);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pointerdown', this.onGesture, { passive: true });
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('touchend', this.onGesture, { passive: true });
  }

  private removeListeners(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('gamepadconnected', this.onGamepad);
    window.removeEventListener('pagehide', this.onPageHide);
    this.removeGestureListeners();
  }

  private removeGestureListeners(): void {
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('touchend', this.onGesture);
  }

  /** Resizes are coalesced into the next frame; a drag fires dozens of them. */
  private readonly onResize = (): void => {
    if (this.resizePending || this.dead) return;
    this.resizePending = true;
    requestAnimationFrame(() => {
      this.resizePending = false;
      if (this.dead) return;
      this.renderer.resize();
    });
  };

  private readonly onVisibility = (): void => {
    if (this.dead) return;
    if (document.visibilityState === 'visible') {
      this.renderer.resize();
      return;
    }
    // Alt-tabbing out of a solo fight should not cost you a life. Online it
    // must not: a unilateral pause is just a stall to everyone else.
    if (!this.online && this.sceneName === 'fight') this.pushScene('pause', { reason: 'blur' });
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.dead || isEditable(e.target)) return;
    const top = this.scene;
    if (!top?.onKey) return;
    try {
      top.onKey(e);
    } catch (err) {
      this.fail(err);
    }
  };

  private readonly onGamepad = (e: Event): void => {
    const pad = (e as GamepadEvent).gamepad;
    if (!pad || this.dead) return;
    // Give a freshly plugged-in pad the first slot nobody is driving, so the
    // second player can join by plugging in rather than by finding a menu.
    for (let slot = 0; slot < MAX_LOCAL_PLAYERS; slot++) {
      if (this.input.source(slot) === null) {
        this.input.attach(slot, new GamepadSource(pad.index));
        return;
      }
    }
  };

  private readonly onPageHide = (): void => {
    this.saveNow();
  };

  private readonly onGesture = (): void => {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    this.removeGestureListeners();
    this.audio.unlock();
  };
}
