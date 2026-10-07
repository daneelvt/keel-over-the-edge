// SPDX-License-Identifier: AGPL-3.0-only

// The renderer: three.js's WebGPURenderer on WebGPU when the browser has it,
// on its WebGL 2 back end otherwise. Everything drawn is kept to WebGPU's
// compatibility-mode limits (no storage buffers in the vertex stage, no
// MSAA), so it runs on the phones that only offer that. A lost GPU device
// or WebGL context is recovered by building a new renderer on a new canvas;
// the scene's meshes and textures keep their data on the CPU side and are
// uploaded again.

import { HalfFloatType, type TextureDataType, UnsignedByteType } from 'three';
import { WebGPURenderer } from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

/** The back end asked for: WebGL 2 when forced with ?backend=webgl2 or without WebGPU. */
export function chooseBackend(query: URLSearchParams, hasWebGPU: boolean): Backend {
  if (query.get('backend') === 'webgl2' || !hasWebGPU) {
    return 'webgl2';
  }
  return 'webgpu';
}

/**
 * The render scale (the pixel ratio drawn at) by back end: up to 2 on
 * WebGPU with core features, 1.5 in compatibility mode, 1 on WebGL 2.
 */
export function defaultRenderScale(backend: Backend, compat: boolean, dpr: number): number {
  const most = backend === 'webgl2' ? 1 : compat ? 1.5 : 2;
  return Math.min(Math.max(dpr, 1), most);
}

/** The output buffer: half float on WebGPU, 8-bit on WebGL 2. */
export function outputBufferType(backend: Backend): TextureDataType {
  return backend === 'webgpu' ? HalfFloatType : UnsignedByteType;
}

export interface Gfx {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  backend: Backend;
  /** WebGPU without the adapter's core-features-and-limits. */
  compat: boolean;
  /** Whether rgba32float can be rendered to (always on WebGPU; EXT_color_buffer_float on WebGL 2). */
  floatTargets: boolean;
  /** Whether GPU timestamps can be measured. */
  timestamps: boolean;
  /** Stops listening for loss, then disposes of the renderer. */
  dispose(): void;
}

interface WebGPUBackendLike {
  isWebGPUBackend?: boolean;
  compatibilityMode?: boolean | null;
  trackTimestamp?: boolean;
  device?: GPUDevice;
  extensions?: { has(name: string): boolean };
  disjoint?: unknown;
}

/**
 * Makes a renderer on a new canvas inside container. onLost is called once
 * if the device or context is lost; the caller then makes a new one. GPU
 * timestamps are measured only when asked for, since unread ones fill
 * three.js's query pool.
 */
export async function createGfx(
  container: HTMLElement,
  wanted: Backend,
  onLost: (reason: string) => void,
  timestamps = false,
): Promise<Gfx> {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene';
  container.prepend(canvas);
  const renderer = new WebGPURenderer({
    canvas,
    forceWebGL: wanted === 'webgl2',
    antialias: false,
    outputBufferType: outputBufferType(wanted),
    trackTimestamp: timestamps,
    powerPreference: 'high-performance',
  });
  let disposed = false;
  let lost = false;
  const lose = (reason: string): void => {
    if (disposed || lost) {
      return;
    }
    lost = true;
    onLost(reason);
  };
  renderer.onDeviceLost = (info: { message?: string }) => lose(info.message ?? 'device lost');
  await renderer.init();

  const backend = renderer.backend as unknown as WebGPUBackendLike;
  const isWebGPU = backend.isWebGPUBackend === true;
  // three.js ignores a device destroyed on purpose; this one did not destroy
  // it, so any loss is one to recover from.
  backend.device?.lost.then((info) => lose(info.message || info.reason || 'device lost'));

  return {
    renderer,
    canvas,
    backend: isWebGPU ? 'webgpu' : 'webgl2',
    compat: isWebGPU && backend.compatibilityMode === true,
    floatTargets: isWebGPU || backend.extensions?.has('EXT_color_buffer_float') === true,
    timestamps: isWebGPU ? backend.trackTimestamp === true : Boolean(backend.disjoint),
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      void renderer.dispose();
      canvas.remove();
    },
  };
}
