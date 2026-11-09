// SPDX-License-Identifier: AGPL-3.0-only

// The stage: the renderer, the camera and the frame. It draws the scene
// through a short post-processing chain (the output transform, then FXAA or
// SMAA, since MSAA is off in compatibility mode), follows the window's size
// and pixel ratio, and when the GPU device or WebGL context is lost builds a
// new renderer and carries on with the same scene.
//
// Each frame is the scene's update (the game's tick, the camera, the boats,
// the words on the screen) and then its draw. A page under test that checks
// no picture runs with no renderer at all (?test&draw=off): the update runs
// every animation frame, and nothing is drawn. A page under test that draws
// updates every frame but draws only when a test asks, until it is thawed.

import { NoToneMapping, type Object3D, PerspectiveCamera, Scene } from 'three';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { pass, renderOutput } from 'three/tsl';
import { type PassNode, RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { FrameCap } from '../game/cap';
import { type Backend, createGfx, type Gfx, type Wanted } from './renderer';

export type Antialias = 'fxaa' | 'smaa' | 'none';

/**
 * The camera's near and far planes, in metres. The sky sphere lies inside
 * the far one. The far plane reaches beyond where a storm's cloud can be
 * seen (its deck, 7.2 km off); a perspective depth's precision is set by
 * the near plane, so reaching further costs nothing near.
 */
export const NEAR = 0.2;
export const FAR = 8000;

export interface FrameInfo {
  /** Seconds since the previous drawn frame. */
  dt: number;
  /** The time of the frame, in milliseconds (requestAnimationFrame's clock). */
  now: number;
}

export interface StageHooks {
  /**
   * Each frame's update, and with gfx what it draws before the scene's
   * render (uniforms, the tile pass); gfx is null for a frame not drawn,
   * which updates the scene alone. False says the hook drew the frame
   * itself, and the scene is not drawn.
   */
  frame(gfx: Gfx | null, info: FrameInfo): boolean | undefined;
  /** After each frame is drawn, with the main thread's work on it in milliseconds. */
  drawn?(gfx: Gfx, work: number): void;
  /** After a new renderer is made (at start and after a loss). */
  attached?(gfx: Gfx): void;
  /** After the page was hidden and is shown again. */
  resumed?(): void;
}

export class Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, NEAR, FAR);
  gfx: Gfx | null = null;
  antialias: Antialias = 'fxaa';
  /** The pixel ratio drawn at, set by hand; null for the one the quality in use gives. */
  scale: number | null = null;
  /** The pixel ratio the quality in use draws at, for a display of a device pixel ratio. */
  ratio: (dpr: number) => number = (dpr) => Math.max(dpr, 1);
  /** Whether to measure GPU time, where the device can. */
  timestamps = true;
  /** Whether to hold a WebGPU device to compatibility mode's limits. */
  compat = false;
  /** Which animation frames are drawn: at most 60 a second, or 30 to save battery. */
  readonly cap = new FrameCap();
  /** How many times the renderer was rebuilt after a loss. */
  recoveries = 0;
  lastLoss = '';
  /**
   * Whether the frame loop draws, or only updates the scene: a page under
   * test draws only what a test asks for (renderOnce) until it is thawed.
   */
  loopDraws = true;

  readonly #container: HTMLElement;
  readonly #wanted: Wanted;
  readonly #hooks: StageHooks;
  #pipeline: RenderPipeline | null = null;
  #scenePass: PassNode | null = null;
  #last = 0;
  #frozen = false;
  /** Those waiting for a copy of the next frame drawn. */
  #captures: ((c: HTMLCanvasElement | null) => void)[] = [];

  constructor(container: HTMLElement, wanted: Wanted, hooks: StageHooks) {
    this.#container = container;
    this.#wanted = wanted;
    this.#hooks = hooks;
    this.camera.position.set(30, 12, 30);
    window.addEventListener('resize', () => this.resize());
  }

  /** The back end asked for, or none: a page that draws nothing. */
  get wanted(): Wanted {
    return this.#wanted;
  }

  async start(): Promise<void> {
    if (this.#wanted === 'none') {
      // No renderer: animation frames update the scene, and draw nothing.
      this.resize();
      this.#last = performance.now();
      const loop = (now: number): void => {
        this.#frame(now);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return;
    }
    await this.#startGfx(this.#wanted);
  }

  async #startGfx(wanted: Backend): Promise<void> {
    const gfx = await createGfx(
      this.#container,
      wanted,
      (reason) => {
        void this.#recover(reason);
      },
      this.timestamps,
      this.compat,
    );
    this.gfx = gfx;
    gfx.renderer.toneMapping = NoToneMapping;
    // The frame is several render calls (the tile pass, the scene, the
    // post-processing); its counts are reset once, at its start.
    gfx.renderer.info.autoReset = false;
    this.#buildPipeline();
    this.#hooks.attached?.(gfx);
    this.resize();
    this.#last = performance.now();
    // The display's own rate, before anything is drawn.
    this.cap.probe();
    await gfx.renderer.setAnimationLoop((now: number) => this.#frame(now));
  }

  /** Stops the frame loop (tests drive frames with renderOnce). */
  freeze(frozen: boolean): void {
    this.#frozen = frozen;
    if (!frozen) {
      this.#last = performance.now();
    }
  }

  /** After the page was hidden: animation frames stopped, so their timing starts again. */
  resumed(): void {
    this.cap.restart();
    this.#hooks.resumed?.();
  }

  /** Updates and draws one frame now, at time now; updates it alone without a renderer. */
  renderOnce(now: number): void {
    this.#draw(now, 1 / 60, true);
  }

  /**
   * A copy of the next frame drawn, on a canvas of its own: taken in the
   * same task as the draw, before the browser shows the frame and may
   * clear the canvas (as WebGPU's and WebGL's both are). A loop that draws
   * nothing on its own (a page under test, or frozen) draws one now. Null
   * with no renderer, or once the renderer is lost.
   */
  capture(): Promise<HTMLCanvasElement | null> {
    if (this.gfx === null) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.#captures.push(resolve);
      if (!this.loopDraws || this.#frozen) {
        this.renderOnce(performance.now());
      }
    });
  }

  /** Hands the frame just drawn to those waiting for it. */
  #copy(canvas: HTMLCanvasElement): void {
    const waiting = this.#captures;
    this.#captures = [];
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d');
    if (ctx === null) {
      for (const w of waiting) {
        w(null);
      }
      return;
    }
    ctx.drawImage(canvas, 0, 0);
    for (const w of waiting) {
      w(copy);
    }
  }

  setAntialias(a: Antialias): void {
    this.antialias = a;
    this.#buildPipeline();
  }

  setScale(scale: number | null): void {
    this.scale = scale;
    this.resize();
  }

  /**
   * Compiles what an object needs to be drawn in the scene, before its first
   * frame there: its shaders and pipelines are made off the frame, and the
   * frame that first draws it does not wait for them.
   */
  compile(object: Object3D): Promise<void> {
    const g = this.gfx;
    const p = this.#scenePass;
    if (g === null || p === null) {
      return Promise.resolve();
    }
    // The scene is drawn into the pass's own target, and a pipeline is made
    // for the target it draws to. compileAsync reads the target at once, so
    // it is set for the call alone.
    const r = g.renderer;
    const before = r.getRenderTarget();
    r.setRenderTarget(p.renderTarget);
    const done = r.compileAsync(object, this.camera, this.scene);
    r.setRenderTarget(before);
    return done.then(() => undefined);
  }

  /** The stage's size on the page, in CSS pixels. */
  size(): { width: number; height: number } {
    return {
      width: this.#container.clientWidth || window.innerWidth,
      height: this.#container.clientHeight || window.innerHeight,
    };
  }

  /** The pixel ratio in use. */
  pixelRatio(): number {
    const g = this.gfx;
    if (g === null) {
      return 1;
    }
    return this.scale ?? this.ratio(window.devicePixelRatio || 1);
  }

  resize(): void {
    const g = this.gfx;
    const { width: w, height: h } = this.size();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (g !== null) {
      g.renderer.setPixelRatio(this.pixelRatio());
      g.renderer.setSize(w, h);
    }
  }

  #buildPipeline(): void {
    const g = this.gfx;
    if (g === null) {
      return;
    }
    this.#pipeline?.dispose();
    const p = new RenderPipeline(g.renderer);
    const scenePass = pass(this.scene, this.camera);
    this.#scenePass = scenePass;
    if (this.antialias === 'none') {
      p.outputNode = scenePass;
    } else {
      // FXAA and SMAA work on the encoded picture, after the output transform.
      p.outputColorTransform = false;
      const out = renderOutput(scenePass);
      p.outputNode = this.antialias === 'fxaa' ? fxaa(out) : smaa(out);
    }
    this.#pipeline = p;
  }

  /**
   * Every animation frame. three.js calls this on each one and draws only
   * what it renders, so a frame the cap skips returns at once and the last
   * picture stays on screen.
   */
  #frame(now: number): void {
    if (!this.cap.tick(now) || this.#frozen) {
      return;
    }
    const dt = Math.min((now - this.#last) / 1000, 0.25);
    this.#last = now;
    this.#draw(now, dt, this.loopDraws);
  }

  /** The frame's update, then, if draw is set and there is a renderer, its draw. */
  #draw(now: number, dt: number, draw: boolean): void {
    if (this.#wanted === 'none' || !draw) {
      this.#hooks.frame(null, { dt, now });
      return;
    }
    const g = this.gfx;
    if (g === null || this.#pipeline === null) {
      return;
    }
    const start = performance.now();
    g.renderer.info.reset();
    if (this.#hooks.frame(g, { dt, now }) === false) {
      return;
    }
    this.#pipeline.render();
    if (this.#captures.length > 0) {
      this.#copy(g.canvas);
    }
    this.#hooks.drawn?.(g, performance.now() - start);
  }

  async #recover(reason: string): Promise<void> {
    this.lastLoss = reason;
    for (const w of this.#captures.splice(0)) {
      w(null);
    }
    const old = this.gfx;
    this.gfx = null;
    old?.dispose();
    this.#pipeline = null;
    await this.start();
    this.recoveries++;
  }

  /** The renderer in use. */
  get renderer(): WebGPURenderer | null {
    return this.gfx?.renderer ?? null;
  }
}
