// SPDX-License-Identifier: AGPL-3.0-only

// The renderer: three.js's WebGPURenderer on WebGPU when the browser has it,
// on its WebGL 2 back end otherwise. Everything drawn is kept to WebGPU's
// compatibility-mode limits (no storage buffers in the vertex stage, no
// MSAA), so it runs on the phones that only offer that. A lost GPU device
// or WebGL context is recovered by building a new renderer on a new canvas;
// the scene's meshes and textures keep their data on the CPU side and are
// uploaded again.
//
// three.js asks an adapter for every feature it offers, so on a desktop it
// always gets a device with WebGPU's core features and limits, and nothing
// drawn there is held to compatibility mode's. With ?compat the device is
// made here instead, without "core-features-and-limits": the browser then
// enforces compatibility mode's limits (128 invocations a workgroup, no
// storage textures in the vertex stage: WebGPU, "Limits"), on any machine.

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

/** Whether to hold a WebGPU device to compatibility mode's limits: ?compat, for development. */
export function wantsCompat(query: URLSearchParams): boolean {
  return query.has('compat');
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
  /** Whether the back end runs compute passes that write textures: WebGPU. */
  compute: boolean;
  /** The device's limits that the scene is built to; 0 on WebGL 2. */
  workgroup: number;
  vertexStorageTextures: number;
  /** Stops listening for loss, then disposes of the renderer. */
  dispose(): void;
}

/** What a GPU offers of itself, as far as this file asks. */
interface GPULike {
  requestAdapter(options: { powerPreference: string; featureLevel: string }): Promise<{
    features: Iterable<string>;
    requestDevice(d: { requiredFeatures: string[] }): Promise<GPUDevice>;
  } | null>;
}

/**
 * A device held to compatibility mode: every feature its adapter offers but
 * the core features and limits. Null without WebGPU or an adapter.
 */
async function compatDevice(): Promise<GPUDevice | null> {
  const gpu = (navigator as Navigator & { gpu?: GPULike }).gpu;
  const adapter = await gpu?.requestAdapter({
    powerPreference: 'high-performance',
    featureLevel: 'compatibility',
  });
  if (adapter === null || adapter === undefined) {
    return null;
  }
  const features = [...adapter.features].filter((f) => f !== 'core-features-and-limits');
  return adapter.requestDevice({ requiredFeatures: features });
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
  compat = false,
): Promise<Gfx> {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene';
  container.prepend(canvas);
  const device = compat && wanted === 'webgpu' ? await compatDevice() : null;
  const renderer = new WebGPURenderer({
    canvas,
    forceWebGL: wanted === 'webgl2',
    antialias: false,
    outputBufferType: outputBufferType(wanted),
    trackTimestamp: timestamps,
    powerPreference: 'high-performance',
    ...(device !== null ? { device } : {}),
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
    compute: isWebGPU,
    workgroup: backend.device?.limits.maxComputeInvocationsPerWorkgroup ?? 0,
    vertexStorageTextures:
      (backend.device?.limits as { maxStorageTexturesInVertexStage?: number } | undefined)
        ?.maxStorageTexturesInVertexStage ?? 0,
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      void renderer.dispose();
      canvas.remove();
    },
  };
}
