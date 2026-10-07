// SPDX-License-Identifier: AGPL-3.0-only

// The tile pass: each tile's plane, computed once a frame in a pass of its
// own. A full-screen draw into an rgba32float target writes, at the texel
// of each tile's instance index, vec4(H, ∂H/∂x, ∂H/∂z, h) at the tile's
// centre (wave.ts). The tile mesh reads its texel unfiltered, so every
// vertex of a tile takes its height from the same plane, bit for bit.
//
// A render pass rather than compute works the same on WebGPU and WebGL 2
// and keeps to compatibility mode (no storage buffers in the vertex stage).
// It costs one band sum per tile instead of one per vertex. On WebGL 2
// without EXT_color_buffer_float, the tile mesh computes the same plane at
// the tile's centre in its vertex stage instead (tiles.ts).

import {
  DataTexture,
  FloatType,
  NearestFilter,
  NoBlending,
  RenderTarget,
  RGBAFormat,
  Vector2,
} from 'three';
import { floor, ivec2, screenCoordinate, textureLoad, uniform } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { Field } from './hex';
import { type BandUniforms, seaPlaneAt } from './wave';

/** Texels per row of the tile pass's target. */
export const PASS_WIDTH = 128;
/** Rows: room for 8,192 tiles. */
export const PASS_HEIGHT = 64;

/**
 * The tile field's offsets as a float texture laid out like the pass's
 * target: at each tile's texel, (dx, dz, dq, dr), its centre's scene offset
 * from the centre tile's in metres and its offset in tiles.
 */
export function fieldTexture(field: Field): DataTexture {
  const data = new Float32Array(PASS_WIDTH * PASS_HEIGHT * 4);
  for (let i = 0; i < field.count; i++) {
    data[i * 4] = field.offset[i * 2] ?? 0;
    data[i * 4 + 1] = -(field.offset[i * 2 + 1] ?? 0);
    data[i * 4 + 2] = field.hex[i * 2] ?? 0;
    data[i * 4 + 3] = field.hex[i * 2 + 1] ?? 0;
  }
  const t = new DataTexture(data, PASS_WIDTH, PASS_HEIGHT, RGBAFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class TilePass {
  readonly target = new RenderTarget(PASS_WIDTH, PASS_HEIGHT, {
    type: FloatType,
    format: RGBAFormat,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
  /** The centre tile's scene position relative to the floating origin. */
  readonly centre = uniform(new Vector2());
  readonly #quad: QuadMesh;

  constructor(field: Field, band: BandUniforms) {
    const offsets = fieldTexture(field);
    const plane = seaPlaneAt(band);
    const material = new MeshBasicNodeMaterial();
    material.blending = NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    const texel = ivec2(floor(screenCoordinate));
    const offset = textureLoad(offsets, texel);
    material.fragmentNode = plane(this.centre.add(offset.xy));
    this.#quad = new QuadMesh(material);
  }

  /** Draws every tile's plane into the target. */
  render(renderer: WebGPURenderer): void {
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.#quad.render(renderer);
    renderer.setRenderTarget(before);
  }
}
