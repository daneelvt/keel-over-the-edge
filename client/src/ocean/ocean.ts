// SPDX-License-Identifier: AGPL-3.0-only

// The sea: the boat band's components, the tile pass, the tiles and the far
// sea, kept in step each frame with the floating origin, the tile under the
// boat and the camera's height.

import type { Mesh, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { FloatingOrigin } from '../render/coords';
import { seaMaterial } from '../render/materials';
import { FarSea, farRadius } from './far';
import { type Field, hexCentre, makeField, type Point } from './hex';
import { BoatBand, type TestSea } from './phases';
import { farLook, seaTime, tileLook } from './seamaterial';
import breeze from './testsea/breeze.json';
import calm from './testsea/calm.json';
import fresh from './testsea/fresh.json';
import gale from './testsea/gale.json';
import { TilePass } from './tilepass';
import { Tiles } from './tiles';
import { type BandUniforms, bandUniforms } from './wave';

/** The developer test sea's states, by name. Any other name is flat water. */
export const TEST_SEAS: Record<string, TestSea> = {
  calm: calm as TestSea,
  breeze: breeze as TestSea,
  fresh: fresh as TestSea,
  gale: gale as TestSea,
};

function tileMesh(tiles: Tiles): Mesh {
  const m = seaMaterial('sea-tile');
  m.positionNode = tiles.position;
  m.fragmentNode = tileLook(tiles.varyings);
  tiles.mesh.material = m;
  return tiles.mesh;
}

export class Ocean {
  readonly band = new BoatBand();
  readonly uniforms: BandUniforms;
  readonly field: Field;
  readonly pass: TilePass;
  readonly far: FarSea;
  /** The tiles reading the pass, and the fallback computing planes per vertex. */
  readonly passTiles: Tiles;
  readonly vertexTiles: Tiles;
  /** Whether the tile pass is in use (D3), or the per-vertex fallback. */
  usePass = true;
  /** Whether the renderer can draw into the pass's float target. */
  floatTargets = true;

  readonly #scene: Scene;
  readonly #centre: Point = { x: 0, y: 0 };
  #active: Tiles;

  constructor(scene: Scene) {
    this.#scene = scene;
    this.uniforms = bandUniforms(this.band);
    this.field = makeField();
    this.pass = new TilePass(this.field, this.uniforms);
    this.passTiles = new Tiles(this.field, this.uniforms, this.pass.target.texture);
    this.vertexTiles = new Tiles(this.field, this.uniforms, null);
    // Both sets of tiles follow the same centre tile.
    this.vertexTiles.centre.value = this.passTiles.centre.value;
    this.vertexTiles.centreHex.value = this.passTiles.centreHex.value;
    this.pass.centre.value = this.passTiles.centre.value;
    tileMesh(this.passTiles);
    tileMesh(this.vertexTiles);
    this.#active = this.passTiles;
    scene.add(this.passTiles.mesh);

    this.far = new FarSea(this.uniforms, this.passTiles.centre);
    const fm = seaMaterial('sea-far');
    fm.positionNode = this.far.position;
    fm.fragmentNode = farLook(this.far.plane);
    this.far.mesh.material = fm;
    scene.add(this.far.mesh);
  }

  /** The tiles in use. */
  get tiles(): Tiles {
    return this.#active;
  }

  setTestSea(sea: TestSea | null): void {
    this.band.set(sea);
  }

  /** Chooses the tile pass or the per-vertex fallback. */
  choose(usePass: boolean, floatTargets: boolean): void {
    this.usePass = usePass;
    this.floatTargets = floatTargets;
    const next = usePass && floatTargets ? this.passTiles : this.vertexTiles;
    if (next !== this.#active) {
      this.#scene.remove(this.#active.mesh);
      this.#scene.add(next.mesh);
      this.#active = next;
    }
  }

  /**
   * Brings the sea up to date: the band's phases at the origin for world
   * time t (seconds), the tile field on the tile under the boat, the far
   * sea's reach for the camera's height. Then runs the tile pass.
   */
  update(renderer: WebGPURenderer, origin: FloatingOrigin, t: number, cameraHeight: number): void {
    this.band.update(origin.world.x, origin.world.y, t);
    hexCentre(origin.centre.q, origin.centre.r, this.#centre);
    const centre = this.passTiles.centre.value;
    centre.set(this.#centre.x - origin.world.x, -(this.#centre.y - origin.world.y));
    this.passTiles.centreHex.value.set(origin.centre.q, origin.centre.r);
    this.far.outer.value = farRadius(cameraHeight);
    seaTime.value = t % 1000;
    if (this.#active === this.passTiles) {
      this.pass.render(renderer);
    }
  }
}
