// SPDX-License-Identifier: AGPL-3.0-only

// What a drawn frame asks of the GPU, counted for the tests and the
// measuring script: the buffers written and their bytes, the textures
// written, the render passes, the compute dispatches, the draws and
// triangles, and the main thread's work and the interval between frames.
//
// Nothing here runs unless a test asks: the counter wraps the browser's own
// calls (GPUQueue.writeBuffer, GPUCommandEncoder.beginRenderPass, WebGL 2's
// bufferSubData and the like) while it counts, and puts them back when it
// stops. A player's page never loads this file, and the stage's only part
// in it is a null check a frame.
//
// With detail on it also says which buffers were written: each write's
// buffer (its label on WebGPU, its target on WebGL 2), its size, and what
// three.js was drawing or computing when it was written, and the passes by
// what they drew into. That costs a little on every write, so it is asked
// for apart.

import type { Gfx } from '../render/renderer';

/** The median, 90th percentile, largest and mean of some values. */
export interface Spread {
  median: number;
  p90: number;
  max: number;
  mean: number;
}

/** The spread of values; zeros when there are none. */
export function spread(values: readonly number[]): Spread {
  const n = values.length;
  if (n === 0) {
    return { median: 0, p90: 0, max: 0, mean: 0 };
  }
  const s = [...values].sort((a, b) => a - b);
  const median =
    n % 2 === 1
      ? (s[(n - 1) / 2] as number)
      : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
  const p90 = s[Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1))] as number;
  const mean = s.reduce((a, v) => a + v, 0) / n;
  return { median, p90, max: s[n - 1] as number, mean };
}

/** What a typed array, a DataView or an ArrayBuffer holds an element of, in bytes. */
function elementSize(data: unknown): number {
  const e = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT;
  return typeof e === 'number' ? e : 1;
}

/** Elements in data: a typed array's length, a DataView's or an ArrayBuffer's bytes. */
function elementsOf(data: unknown): number {
  const d = data as { length?: number; byteLength?: number };
  return typeof d.length === 'number' && elementSize(data) !== 1 ? d.length : (d.byteLength ?? 0);
}

/**
 * The bytes a write sends: size elements of data from offset, or all of
 * them from offset when no size is given. WebGPU's writeBuffer and WebGL 2's
 * bufferSubData both count a typed array's offset and size in its elements,
 * and an ArrayBuffer's in bytes.
 */
export function bytesOf(data: unknown, offset = 0, size?: number): number {
  const n = size ?? Math.max(0, elementsOf(data) - offset);
  return n * elementSize(data);
}

/** One frame's counts. */
export interface FrameCounts {
  /** Buffer writes, and the bytes they sent. */
  writes: number;
  bytes: number;
  /** Texture writes (WebGPU's writeTexture and copyExternalImageToTexture; WebGL 2's texImage and texSubImage). */
  textureWrites: number;
  /** Render passes begun on the GPU (WebGPU), or three.js's render calls (WebGL 2). */
  passes: number;
  /** three.js's render calls: the scene, the tile pass, each post-processing step, each shadow. */
  renders: number;
  /** Compute dispatches. */
  dispatches: number;
  /** WebGL 2's framebuffer binds; 0 on WebGPU. */
  framebufferBinds: number;
  draws: number;
  triangles: number;
  /** The main thread's work on the frame, the scene's update and its draw, ms. */
  work: number;
  /** Since the frame drawn before it, ms. */
  interval: number;
}

/** A buffer written, by what it is and what was being drawn: how often a frame, and its bytes a frame. */
export interface Written {
  /** The buffer's label on WebGPU (three.js names its uniform buffers by their group), or its target on WebGL 2. */
  label: string;
  /** What three.js was drawing or computing when it was written. */
  owner: string;
  /** The bytes of each write. */
  size: number;
  perFrame: number;
  bytesPerFrame: number;
}

/** A pass by what it drew into or computed, and how often a frame. */
export interface PassSeen {
  label: string;
  perFrame: number;
}

/** The counts over the frames counted. */
export interface FrameReport {
  backend: string;
  frames: number;
  /** The pixel ratio and the canvas's size, in device pixels, as last drawn. */
  pixelRatio: number;
  width: number;
  height: number;
  writes: Spread;
  bytes: Spread;
  textureWrites: Spread;
  passes: Spread;
  renders: Spread;
  dispatches: Spread;
  framebufferBinds: Spread;
  draws: Spread;
  triangles: Spread;
  work: Spread;
  interval: Spread;
  /** With detail: the buffers written, the most bytes a frame first. */
  largest: Written[];
  /** With detail: three.js's render and compute calls a frame, by what they drew into. */
  passList: PassSeen[];
}

export interface CountOptions {
  /** Wrap the GPU's calls to count writes, passes and dispatches; off, only the work and intervals are kept. */
  gpu?: boolean;
  /** Say which buffers are written and what the passes are. */
  detail?: boolean;
}

/** Puts a method back as it was. */
type Undo = () => void;

/** Replaces target's key by wrap(the method), until the undo is called. */
function wrapMethod<T extends object>(
  target: T,
  key: string,
  wrap: (orig: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
): Undo {
  const t = target as Record<string, unknown>;
  const own = Object.getOwnPropertyDescriptor(target, key);
  const orig = t[key];
  if (typeof orig !== 'function') {
    return () => undefined;
  }
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: wrap(orig as (...args: unknown[]) => unknown),
  });
  return () => {
    if (own !== undefined) {
      Object.defineProperty(target, key, own);
    } else {
      delete t[key];
    }
  };
}

/** A prototype on the page's global scope, if the browser has it. */
function proto(name: string): object | null {
  const c = (globalThis as Record<string, unknown>)[name] as { prototype?: object } | undefined;
  return c?.prototype ?? null;
}

const GL_TARGETS: Record<number, string> = {
  34962: 'ARRAY_BUFFER',
  34963: 'ELEMENT_ARRAY_BUFFER',
  35345: 'UNIFORM_BUFFER',
  35051: 'PIXEL_PACK_BUFFER',
  35052: 'PIXEL_UNPACK_BUFFER',
  36662: 'COPY_READ_BUFFER',
  36663: 'COPY_WRITE_BUFFER',
};

interface Named {
  name?: string;
  type?: string;
  parent?: Named | null;
  isMesh?: boolean;
  material?: Named | Named[] | null;
  texture?: Named | null;
  width?: number;
  height?: number;
  label?: string;
}

/** An object as three.js knows it, by name: up to three named ancestors, then its own name or type. */
function nameOf(o: Named | null | undefined): string {
  if (o === null || o === undefined) {
    return '?';
  }
  const parts: string[] = [o.name !== undefined && o.name !== '' ? o.name : (o.type ?? '?')];
  let p = o.parent ?? null;
  while (p !== null && parts.length < 4) {
    if (p.name !== undefined && p.name !== '') {
      parts.unshift(p.name);
    }
    p = p.parent ?? null;
  }
  return parts.join('/');
}

function materialOf(m: Named | Named[] | null | undefined): string {
  const one = Array.isArray(m) ? m[0] : m;
  if (one === undefined || one === null) {
    return '';
  }
  return one.name !== undefined && one.name !== '' ? one.name : (one.type ?? '');
}

/** What a render call drew into, and what it drew: a target by its texture's name or size, or the canvas. */
function passName(scene: Named | null, target: Named | null): string {
  const into =
    target === null
      ? 'canvas'
      : target.texture?.name !== undefined && target.texture.name !== ''
        ? target.texture.name
        : `target ${target.width ?? 0}×${target.height ?? 0}`;
  const what =
    scene === null
      ? '?'
      : scene.isMesh === true
        ? `quad ${materialOf(scene.material)}`
        : scene.name !== undefined && scene.name !== ''
          ? scene.name
          : (scene.type ?? '?');
  return `${into} ← ${what}`;
}

/** A compute call by its nodes' names. */
function computeName(nodes: unknown): string {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const names = list.map((n) => {
    const c = n as { name?: unknown; id?: number };
    return typeof c.name === 'string' && c.name !== '' ? c.name : `#${c.id ?? '?'}`;
  });
  return `compute ${names.join(', ')}`;
}

/** Counts each drawn frame while installed on the stage (Stage.counter). */
export class FrameCounter {
  readonly gpu: boolean;
  readonly detail: boolean;

  readonly #frames: FrameCounts[] = [];
  #undo: Undo[] = [];
  #attached: Gfx | null = null;
  /** The first frame after attaching holds whatever came before: it is not kept. */
  #skip = true;
  #last = Number.NaN;
  #backend = '';
  #pixelRatio = 0;
  #width = 0;
  #height = 0;

  // The frame under way.
  #writes = 0;
  #bytes = 0;
  #textureWrites = 0;
  #passes = 0;
  #dispatches = 0;
  #binds = 0;

  /** With detail: what three.js is at, the buffers written and the passes. */
  #owner = '';
  readonly #written = new Map<
    string,
    { label: string; owner: string; size: number; count: number }
  >();
  readonly #passList = new Map<string, number>();

  constructor(options: CountOptions = {}) {
    this.gpu = options.gpu ?? true;
    this.detail = options.detail ?? false;
  }

  /** The frames counted so far. */
  get frames(): number {
    return this.#frames.length;
  }

  /** After each drawn frame, with the main thread's work on it, ms. */
  frame(gfx: Gfx, work: number): void {
    const now = performance.now();
    if (gfx !== this.#attached) {
      // The first frame, or a renderer made again after a loss.
      this.#attach(gfx);
      this.#skip = true;
    }
    if (this.#skip) {
      this.#skip = false;
      this.#reset();
      this.#last = now;
      return;
    }
    const info = gfx.renderer.info;
    const webgpu = gfx.backend === 'webgpu';
    this.#frames.push({
      writes: this.#writes,
      bytes: this.#bytes,
      textureWrites: this.#textureWrites,
      passes: webgpu ? this.#passes : info.render.frameCalls,
      renders: info.render.frameCalls,
      dispatches: webgpu ? this.#dispatches : info.compute.frameCalls,
      framebufferBinds: this.#binds,
      draws: info.render.drawCalls,
      triangles: info.render.triangles,
      work,
      interval: now - this.#last,
    });
    this.#last = now;
    this.#backend = gfx.backend;
    this.#pixelRatio = gfx.renderer.getPixelRatio();
    this.#width = gfx.canvas.width;
    this.#height = gfx.canvas.height;
    this.#reset();
  }

  /** What the frames counted showed. */
  report(): FrameReport {
    const f = this.#frames;
    const of = (k: keyof FrameCounts): Spread => spread(f.map((x) => x[k]));
    const n = Math.max(1, f.length);
    const largest = [...this.#written.values()]
      .map((w) => ({
        label: w.label,
        owner: w.owner,
        size: w.size,
        perFrame: w.count / n,
        bytesPerFrame: (w.count * w.size) / n,
      }))
      .sort((a, b) => b.bytesPerFrame - a.bytesPerFrame || b.perFrame - a.perFrame);
    const passList = [...this.#passList.entries()]
      .map(([label, count]) => ({ label, perFrame: count / n }))
      .sort((a, b) => b.perFrame - a.perFrame);
    return {
      backend: this.#backend,
      frames: f.length,
      pixelRatio: this.#pixelRatio,
      width: this.#width,
      height: this.#height,
      writes: of('writes'),
      bytes: of('bytes'),
      textureWrites: of('textureWrites'),
      passes: of('passes'),
      renders: of('renders'),
      dispatches: of('dispatches'),
      framebufferBinds: of('framebufferBinds'),
      draws: of('draws'),
      triangles: of('triangles'),
      work: of('work'),
      interval: of('interval'),
      largest,
      passList,
    };
  }

  /** Puts every wrapped call back. */
  detach(): void {
    for (const u of this.#undo.reverse()) {
      u();
    }
    this.#undo = [];
    this.#attached = null;
  }

  #reset(): void {
    this.#writes = 0;
    this.#bytes = 0;
    this.#textureWrites = 0;
    this.#passes = 0;
    this.#dispatches = 0;
    this.#binds = 0;
  }

  /** A buffer written, of bytes, labelled. */
  #wrote(label: string, bytes: number): void {
    this.#writes++;
    this.#bytes += bytes;
    if (this.detail) {
      const key = `${label}\u0000${this.#owner}\u0000${bytes}`;
      const w = this.#written.get(key);
      if (w === undefined) {
        this.#written.set(key, { label, owner: this.#owner, size: bytes, count: 1 });
      } else {
        w.count++;
      }
    }
  }

  #pass(label: string): void {
    this.#passList.set(label, (this.#passList.get(label) ?? 0) + 1);
  }

  #attach(gfx: Gfx): void {
    this.detach();
    this.#attached = gfx;
    if (!this.gpu) {
      return;
    }
    const self = this;
    const undo = this.#undo;
    if (gfx.backend === 'webgpu') {
      const queue = proto('GPUQueue');
      const encoder = proto('GPUCommandEncoder');
      const compute = proto('GPUComputePassEncoder');
      if (queue !== null) {
        undo.push(
          wrapMethod(
            queue,
            'writeBuffer',
            (orig) =>
              function (this: unknown, ...args: unknown[]) {
                const buffer = args[0] as { label?: string; size?: number };
                const bytes = bytesOf(
                  args[2],
                  (args[3] as number | undefined) ?? 0,
                  args[4] as number | undefined,
                );
                self.#wrote(
                  buffer.label !== undefined && buffer.label !== ''
                    ? buffer.label
                    : `buffer ${buffer.size ?? 0}`,
                  bytes,
                );
                return orig.apply(this, args);
              },
          ),
        );
        for (const key of ['writeTexture', 'copyExternalImageToTexture']) {
          undo.push(
            wrapMethod(
              queue,
              key,
              (orig) =>
                function (this: unknown, ...args: unknown[]) {
                  self.#textureWrites++;
                  return orig.apply(this, args);
                },
            ),
          );
        }
      }
      if (encoder !== null) {
        undo.push(
          wrapMethod(
            encoder,
            'beginRenderPass',
            (orig) =>
              function (this: unknown, ...args: unknown[]) {
                self.#passes++;
                return orig.apply(this, args);
              },
          ),
        );
      }
      if (compute !== null) {
        for (const key of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
          undo.push(
            wrapMethod(
              compute,
              key,
              (orig) =>
                function (this: unknown, ...args: unknown[]) {
                  self.#dispatches++;
                  return orig.apply(this, args);
                },
            ),
          );
        }
      }
    } else {
      const gl = proto('WebGL2RenderingContext');
      if (gl !== null) {
        const target = (t: unknown): string => GL_TARGETS[t as number] ?? `target ${String(t)}`;
        undo.push(
          wrapMethod(
            gl,
            'bufferSubData',
            (orig) =>
              function (this: unknown, ...args: unknown[]) {
                self.#wrote(
                  target(args[0]),
                  bytesOf(
                    args[2],
                    (args[3] as number | undefined) ?? 0,
                    args[4] as number | undefined,
                  ),
                );
                return orig.apply(this, args);
              },
          ),
          wrapMethod(
            gl,
            'bufferData',
            (orig) =>
              function (this: unknown, ...args: unknown[]) {
                // A size alone makes room and sends nothing.
                if (typeof args[1] !== 'number') {
                  self.#wrote(
                    target(args[0]),
                    bytesOf(
                      args[1],
                      (args[3] as number | undefined) ?? 0,
                      args[4] as number | undefined,
                    ),
                  );
                }
                return orig.apply(this, args);
              },
          ),
          wrapMethod(
            gl,
            'bindFramebuffer',
            (orig) =>
              function (this: unknown, ...args: unknown[]) {
                self.#binds++;
                return orig.apply(this, args);
              },
          ),
        );
        for (const key of [
          'texImage2D',
          'texSubImage2D',
          'texImage3D',
          'texSubImage3D',
          'compressedTexSubImage2D',
        ]) {
          undo.push(
            wrapMethod(
              gl,
              key,
              (orig) =>
                function (this: unknown, ...args: unknown[]) {
                  self.#textureWrites++;
                  return orig.apply(this, args);
                },
            ),
          );
        }
      }
    }
    if (this.detail) {
      this.#attachOwners(gfx);
    }
  }

  /** Follows what three.js is drawing or computing, so that each write can say whose it is. */
  #attachOwners(gfx: Gfx): void {
    const r = gfx.renderer as unknown as {
      _geometries?: object;
      _nodes?: object;
      inspector?: object;
    };
    const self = this;
    const undo = this.#undo;
    if (r._geometries !== undefined) {
      undo.push(
        wrapMethod(
          r._geometries,
          'updateForRender',
          (orig) =>
            function (this: unknown, ...args: unknown[]) {
              const ro = args[0] as { object?: Named; material?: Named };
              const m = materialOf(ro.material);
              self.#owner = `${nameOf(ro.object)}${m === '' ? '' : ` [${m}]`}`;
              return orig.apply(this, args);
            },
        ),
      );
    }
    if (r._nodes !== undefined) {
      undo.push(
        wrapMethod(
          r._nodes,
          'updateForCompute',
          (orig) =>
            function (this: unknown, ...args: unknown[]) {
              self.#owner = computeName(args[0]);
              return orig.apply(this, args);
            },
        ),
      );
    }
    if (r.inspector !== undefined) {
      undo.push(
        wrapMethod(
          r.inspector,
          'beginRender',
          (orig) =>
            function (this: unknown, ...args: unknown[]) {
              const label = passName(
                (args[1] as Named | null) ?? null,
                (args[3] as Named | null) ?? null,
              );
              self.#pass(label);
              self.#owner = `(start of ${label})`;
              return orig.apply(this, args);
            },
        ),
        wrapMethod(
          r.inspector,
          'finishRender',
          (orig) =>
            function (this: unknown, ...args: unknown[]) {
              self.#owner = '(between passes)';
              return orig.apply(this, args);
            },
        ),
        wrapMethod(
          r.inspector,
          'beginCompute',
          (orig) =>
            function (this: unknown, ...args: unknown[]) {
              const label = computeName(args[1]);
              self.#pass(label);
              self.#owner = label;
              return orig.apply(this, args);
            },
        ),
      );
    }
  }
}
