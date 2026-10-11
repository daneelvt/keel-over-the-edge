// SPDX-License-Identifier: AGPL-3.0-only

// The sea: the boat band's waves, the tile pass, the tiles and the far sea,
// kept in step each frame with the sea the boat is sailed in, the floating
// origin, the tile under the boat and the camera's height.

import type { Mesh, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { STEPS_PER_SECOND } from '../game/clock';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';
import type { FloatingOrigin } from '../render/coords';
import { seaMaterial } from '../render/materials';
import { FarSea, farRadius } from './far';
import { type Field, hexCentre, makeField, type Point } from './hex';
import { SeaBand } from './phases';
import { farLook, seaTime, tileLook } from './seamaterial';
import { TilePass } from './tilepass';
import { Tiles } from './tiles';
import { type BandUniforms, bandUniforms } from './wave';

/**
 * Where the sea drawn comes from: the physics module that steps the boat,
 * and the windows of the sea it holds. The tiles show the module's own
 * waves, so a boat never sits in or out of the water it floats on.
 */
export interface SeaSource {
  readonly physics: Physics;
  readonly seas: Seas;
}

function tileMesh(tiles: Tiles): Mesh {
  const m = seaMaterial('sea-tile');
  m.positionNode = tiles.position;
  m.fragmentNode = tileLook(tiles.varyings);
  tiles.mesh.material = m;
  return tiles.mesh;
}

export class Ocean {
  readonly band = new SeaBand();
  readonly uniforms: BandUniforms;
  /** The sea to draw; with none, or with flat set, flat water. */
  source: SeaSource | null = null;
  flat = false;
  /** The module's window drawn in the last frame, or −1 for flat water. */
  slot = -1;
  readonly field: Field;
  readonly pass: TilePass;
  readonly far: FarSea;
  /** The tiles reading the pass, and the fallback computing planes per vertex. */
  readonly passTiles: Tiles;
  readonly vertexTiles: Tiles;
  /** Whether the tile pass is in use, or the per-vertex fallback. */
  usePass = true;
  /** Whether the renderer can draw into the pass's float target. */
  floatTargets = true;

  readonly #scene: Scene;
  readonly #centre: Point = { x: 0, y: 0 };
  #active: Tiles;
  /** What the band was last laid out from: a window, and the count of windows taken. */
  #laid = -2;
  #version = -1;

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
    fm.fragmentNode = farLook(this.far.plane, this.far.hs);
    this.far.mesh.material = fm;
    scene.add(this.far.mesh);
  }

  /** The tiles in use. */
  get tiles(): Tiles {
    return this.#active;
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
   * Brings the sea up to date: the window of the sea in effect at world
   * time tick (in ticks, not whole), the band's phases at the origin then,
   * the tile field on the tile under the boat, the far sea's reach for the
   * camera's height. Then runs the tile pass.
   */
  update(
    renderer: WebGPURenderer,
    origin: FloatingOrigin,
    tick: number,
    cameraHeight: number,
  ): void {
    this.#layOut(tick);
    this.band.update(origin.world.x, origin.world.y, tick);
    this.uniforms.sync();
    hexCentre(origin.centre.q, origin.centre.r, this.#centre);
    const centre = this.passTiles.centre.value;
    centre.set(this.#centre.x - origin.world.x, -(this.#centre.y - origin.world.y));
    this.passTiles.centreHex.value.set(origin.centre.q, origin.centre.r);
    this.far.outer.value = farRadius(cameraHeight);
    seaTime.value = (tick / STEPS_PER_SECOND) % 1000;
    if (this.#active === this.passTiles) {
      this.pass.render(renderer);
    }
  }

  /**
   * Lays the band out again when the sea drawn has changed. The boat drawn
   * is on its way to the state of the tick after the clock's, so the sea is
   * that tick's.
   */
  #layOut(tick: number): void {
    const src = this.source;
    const slot = src === null || this.flat ? -1 : src.seas.slotAt(Math.floor(tick) + 1);
    const version = src?.seas.version ?? -1;
    if (slot === this.#laid && version === this.#version) {
      return;
    }
    this.#laid = slot;
    this.#version = version;
    this.slot = slot;
    const held = src?.seas.held[slot];
    if (src === null || held === undefined) {
      this.band.clear();
    } else {
      this.band.set(src.physics, slot, held.col, held.row, held.size);
    }
  }
}
