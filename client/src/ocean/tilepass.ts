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
//
// A second draw into the same target, GUST_ROW rows further down, writes
// the gust field at each tile's centre (gusts.ts): once a tile too, so a
// gust darkens whole tiles and crosses the sea tile by tile. A third,
// GROUND_ROW rows down, writes each tile's ground (shore.ts): the water's
// depth, the waves' cap there, whether it is land, and the bed's surface.
// The plane itself is capped by the depth, as the physics caps the sea
// under a hull.

import {
  DataTexture,
  FloatType,
  NearestFilter,
  NoBlending,
  RenderTarget,
  RGBAFormat,
  Vector2,
} from 'three';
import { floor, ivec2, screenCoordinate, textureLoad, uniform, vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { type GustField, gustAt } from './gusts';
import type { Field } from './hex';
import { depthCap, groundAtHex, tileGround } from './shore';
import { type BandUniforms, boatBandAt, cappedBand, seaAreaAt, seaPlaneOf } from './wave';

/** Texels per row of the tile pass's target. */
export const PASS_WIDTH = 128;
/** Rows of planes: room for 8,192 tiles. */
export const PASS_HEIGHT = 64;
/** The row the tiles' gusts begin at: below the planes, in rows as many again. */
export const GUST_ROW = PASS_HEIGHT;
/** The row the tiles' ground begins at: below the gusts. */
export const GROUND_ROW = 2 * PASS_HEIGHT;

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
  readonly target = new RenderTarget(PASS_WIDTH, GROUND_ROW + PASS_HEIGHT, {
    type: FloatType,
    format: RGBAFormat,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
  /** The centre tile's scene position relative to the floating origin, and its (q, r). */
  readonly centre = uniform(new Vector2());
  readonly centreHex = uniform(new Vector2());
  readonly #quad: QuadMesh;
  readonly #gusts: QuadMesh;
  readonly #ground: QuadMesh;
  readonly #field: GustField;
  /** Whether the gusts' rows hold a field: they are zero until one is drawn. */
  #gusty = false;
  /** The rows that hold tiles: the field fills the first 40 of each 64. */
  readonly #rows: number;

  constructor(field: Field, band: BandUniforms, gusts: GustField) {
    this.#rows = Math.ceil(field.count / PASS_WIDTH);
    const offsets = fieldTexture(field);
    const summed = boatBandAt(band);
    const area = seaAreaAt(band);
    const material = new MeshBasicNodeMaterial();
    material.blending = NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    const texel = ivec2(floor(screenCoordinate));
    const offset = textureLoad(offsets, texel);
    const c = this.centre.add(offset.xy);
    const b = summed(c);
    const f = depthCap(groundAtHex(this.centreHex.add(offset.zw)), b.w);
    material.fragmentNode = seaPlaneOf(cappedBand(b, f), c);
    this.#quad = new QuadMesh(material);

    const gust = new MeshBasicNodeMaterial();
    gust.blending = NoBlending;
    gust.depthTest = false;
    gust.depthWrite = false;
    // The same tile's texel, GUST_ROW rows up the target.
    const tile = textureLoad(offsets, ivec2(texel.x, texel.y.sub(GUST_ROW)));
    gust.fragmentNode = vec4(gustAt(gusts)(this.centre.add(tile.xy)), 0, 0, 1);
    this.#gusts = new QuadMesh(gust);
    this.#field = gusts;

    const ground = new MeshBasicNodeMaterial();
    ground.blending = NoBlending;
    ground.depthTest = false;
    ground.depthWrite = false;
    // The same tile's texel, GROUND_ROW rows up the target.
    const at = textureLoad(offsets, ivec2(texel.x, texel.y.sub(GROUND_ROW)));
    const g = groundAtHex(this.centreHex.add(at.zw));
    ground.fragmentNode = tileGround(g, depthCap(g, area(this.centre.add(at.xy)).w));
    this.#ground = new QuadMesh(ground);
  }

  /** Draws every tile's plane into the target, and, where there are gusts, every tile's gust below them. */
  render(renderer: WebGPURenderer): void {
    // The renderer's own switch turns on a target's scissor. Only the rows
    // that hold tiles are drawn.
    const before = renderer.getRenderTarget();
    const scissored = renderer.getScissorTest();
    renderer.setRenderTarget(this.target);
    renderer.setScissorTest(true);
    this.target.scissor.set(0, 0, PASS_WIDTH, this.#rows);
    this.#quad.render(renderer);
    const cleared = renderer.autoClear;
    renderer.autoClear = false;
    this.target.scissor.set(0, GROUND_ROW, PASS_WIDTH, this.#rows);
    this.#ground.render(renderer);
    renderer.autoClear = cleared;
    // The gusts are drawn only while there is a field, and once more after
    // it has gone, which writes zeros: in a steady wind their shader is
    // never compiled. The second draw keeps what the first wrote: on WebGPU
    // a pass that clears its target clears all of it, whatever the scissor.
    const gusty = this.#field.uniforms.spells.value > 0;
    if (gusty || this.#gusty) {
      renderer.autoClear = false;
      this.target.scissor.set(0, GUST_ROW, PASS_WIDTH, this.#rows);
      this.#gusts.render(renderer);
      renderer.autoClear = cleared;
      this.#gusty = gusty;
    }
    renderer.setScissorTest(scissored);
    renderer.setRenderTarget(before);
  }
}
