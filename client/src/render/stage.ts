// SPDX-License-Identifier: AGPL-3.0-only

// The stage: the renderer, the camera and the frame. It draws the scene
// through a short post-processing chain (the output transform, then FXAA or
// SMAA, since MSAA is off in compatibility mode), follows the window's size
// and pixel ratio, and when the GPU device or WebGL context is lost builds a
// new renderer and carries on with the same scene.

import { NoToneMapping, PerspectiveCamera, Scene } from 'three';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { pass, renderOutput } from 'three/tsl';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { type Backend, createGfx, defaultRenderScale, type Gfx } from './renderer';

export type Antialias = 'fxaa' | 'smaa' | 'none';

/** The camera's near and far planes, in metres. The sky sphere lies inside the far one. */
export const NEAR = 0.2;
export const FAR = 4000;

export interface FrameInfo {
  /** Seconds since the previous frame. */
  dt: number;
  /** The time of the frame, in milliseconds (requestAnimationFrame's clock). */
  now: number;
}

export interface StageHooks {
  /** Before each frame's scene render: update uniforms, run the tile pass. */
  frame(gfx: Gfx, info: FrameInfo): void;
  /** After each frame is drawn. */
  drawn?(gfx: Gfx): void;
  /** After a new renderer is made (at start and after a loss). */
  attached?(gfx: Gfx): void;
}

export class Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, NEAR, FAR);
  gfx: Gfx | null = null;
  antialias: Antialias = 'fxaa';
  /** The pixel ratio drawn at; null for the back end's default. */
  scale: number | null = null;
  /** Whether to measure GPU time (the developer panel's statistics). */
  timestamps = false;
  /** How many times the renderer was rebuilt after a loss. */
  recoveries = 0;
  lastLoss = '';

  readonly #container: HTMLElement;
  readonly #wanted: Backend;
  readonly #hooks: StageHooks;
  #pipeline: RenderPipeline | null = null;
  #last = 0;
  #frozen = false;

  constructor(container: HTMLElement, wanted: Backend, hooks: StageHooks) {
    this.#container = container;
    this.#wanted = wanted;
    this.#hooks = hooks;
    this.camera.position.set(30, 12, 30);
    window.addEventListener('resize', () => this.resize());
  }

  async start(): Promise<void> {
    const gfx = await createGfx(
      this.#container,
      this.#wanted,
      (reason) => {
        void this.#recover(reason);
      },
      this.timestamps,
    );
    this.gfx = gfx;
    gfx.renderer.toneMapping = NoToneMapping;
    // The frame is several render calls (the tile pass, the scene, the
    // post-processing); its counts are reset once, at its start.
    gfx.renderer.info.autoReset = false;
    this.#buildPipeline();
    this.resize();
    this.#hooks.attached?.(gfx);
    this.#last = performance.now();
    await gfx.renderer.setAnimationLoop((now: number) => this.#frame(now));
  }

  /** Stops the frame loop (tests drive frames with renderOnce). */
  freeze(frozen: boolean): void {
    this.#frozen = frozen;
  }

  /** Draws one frame now, at time now. */
  renderOnce(now: number): void {
    this.#draw(now, 1 / 60);
  }

  setAntialias(a: Antialias): void {
    this.antialias = a;
    this.#buildPipeline();
  }

  setScale(scale: number | null): void {
    this.scale = scale;
    this.resize();
  }

  /** The pixel ratio in use. */
  pixelRatio(): number {
    const g = this.gfx;
    if (g === null) {
      return 1;
    }
    return this.scale ?? defaultRenderScale(g.backend, g.compat, window.devicePixelRatio || 1);
  }

  resize(): void {
    const g = this.gfx;
    const w = this.#container.clientWidth || window.innerWidth;
    const h = this.#container.clientHeight || window.innerHeight;
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

  #frame(now: number): void {
    if (this.#frozen) {
      return;
    }
    const dt = Math.min((now - this.#last) / 1000, 0.25);
    this.#last = now;
    this.#draw(now, dt);
  }

  #draw(now: number, dt: number): void {
    const g = this.gfx;
    if (g === null || this.#pipeline === null) {
      return;
    }
    g.renderer.info.reset();
    this.#hooks.frame(g, { dt, now });
    this.#pipeline.render();
    this.#hooks.drawn?.(g);
  }

  async #recover(reason: string): Promise<void> {
    this.lastLoss = reason;
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
