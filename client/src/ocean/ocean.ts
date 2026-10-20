// SPDX-License-Identifier: AGPL-3.0-only

// The sea: the boat band's waves, the tile pass, the tiles and the far sea,
// kept in step each frame with the sea the boat is sailed in, the floating
// origin, the tile under the boat and the camera's height; and, drawn on
// them, the detail band, the foam and the wakes.

import type { Mesh, Object3D, Scene } from 'three';
import type { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { catalog } from '../catalog';
import { STEPS_PER_SECOND } from '../game/clock';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';
import type { FloatingOrigin } from '../render/coords';
import { seaMaterial } from '../render/materials';
import type { DetailKind } from '../render/quality';
import { Detail, type DetailFrame } from './detail';
import { FarSea, farRadius } from './far';
import {
  patternOrigin,
  STREAK_ACROSS,
  STREAK_ALONG,
  streakOrigin,
  streaksOn,
  streakToward,
} from './foam';
import { FoamMap } from './foammap';
import { GustField } from './gusts';
import { type Field, hexCentre, makeField, type Point } from './hex';
import { FOAM } from './look';
import { patternTexture } from './pattern';
import { SeaBand } from './phases';
import { farLook, type SeaParts, seaTime, tileLook } from './seamaterial';
import { TilePass } from './tilepass';
import { Tiles } from './tiles';
import { fract1, Turned } from './turn';
import { SeaUnder } from './under';
import { type BandUniforms, bandUniforms } from './wave';

/**
 * Where the sea drawn comes from: the physics module that steps the boat,
 * and the windows of the sea it holds. The tiles show the module's own
 * waves, so a boat never sits in or out of the water it floats on.
 */
export interface SeaSource {
  readonly physics: Physics;
  readonly seas: Seas;
  /** Whether the module holds spells of weather, whose gusts are drawn on the tiles. */
  readonly weather: boolean;
}

/** What a frame gives the sea. */
export interface SeaFrame {
  /** World time, in ticks, which need not be whole, and how far it moved since the last frame, in seconds. */
  tick: number;
  dt: number;
  /** The boat, in the world: metres east and north. */
  boatEast: number;
  boatNorth: number;
  /** The camera's height above the sea, in metres. */
  cameraHeight: number;
}

/** What the sea's look is drawn with: which detail band, and how it is filtered. */
export interface SeaQuality {
  detail: DetailKind;
  anisotropy: number;
  /** The foam map's side, in texels. */
  foamMap: number;
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
  /** The gust field, as the tiles draw it. */
  readonly gusts = new GustField(catalog.weather.gusts, catalog.weather.water);
  readonly pass: TilePass;
  readonly far: FarSea;
  /** The tiles reading the pass, and the fallback computing planes per vertex. */
  readonly passTiles: Tiles;
  readonly vertexTiles: Tiles;
  /** Whether the tile pass is in use, or the per-vertex fallback. */
  usePass = true;
  /** Whether the renderer can draw into the pass's float target. */
  floatTargets = true;
  /** The sea under the boat: the wind that raises its waves, and what its foam does. */
  readonly under = new SeaUnder();
  readonly detail = new Detail(catalog.weather.sea);
  readonly wakes: FoamMap;
  readonly pattern = patternTexture();
  /** Whether the wakes are drawn (the developer panel). */
  drawWakes = true;
  /** The last frame's detail and wakes, for whoever reads them back. */
  readonly frame: DetailFrame = {
    originEast: 0,
    originNorth: 0,
    boatEast: 0,
    boatNorth: 0,
    time: 0,
    dt: 0,
    under: this.under,
  };

  readonly #scene: Scene;
  readonly #centre: Point = { x: 0, y: 0 };
  #active: Tiles;
  /** What the band was last laid out from: a window, and the count of windows taken. */
  #laid = -2;
  #version = -1;
  /** The streaks of foam as they are turned to the wind. */
  readonly #streaks = new Turned(STREAK_ALONG, STREAK_ACROSS);
  /** A change of the look under way: the materials being compiled, to be swapped in together. */
  #pending = 0;
  /** What earlier looks read, to be let go once no material draws with it. */
  readonly #retired: (() => void)[] = [];

  constructor(scene: Scene, foamMap = 512) {
    this.#scene = scene;
    this.uniforms = bandUniforms(this.band, this.under.areas);
    this.field = makeField();
    this.pass = new TilePass(this.field, this.uniforms, this.gusts);
    this.passTiles = new Tiles(this.field, this.uniforms, this.pass.target.texture, this.gusts);
    this.vertexTiles = new Tiles(this.field, this.uniforms, null, this.gusts);
    // Both sets of tiles follow the same centre tile.
    this.vertexTiles.centre.value = this.passTiles.centre.value;
    this.vertexTiles.centreHex.value = this.passTiles.centreHex.value;
    this.pass.centre.value = this.passTiles.centre.value;
    this.pass.centreHex.value = this.passTiles.centreHex.value;
    this.wakes = new FoamMap(foamMap);
    this.far = new FarSea(this.uniforms, this.passTiles.centre, this.passTiles.centreHex);
    const [pass, vertex, far] = this.#materials();
    this.passTiles.mesh.material = pass;
    this.vertexTiles.mesh.material = vertex;
    this.far.mesh.material = far;
    this.#active = this.passTiles;
    scene.add(this.passTiles.mesh);
    scene.add(this.far.mesh);
  }

  /** What the look is made from, as the detail band and the wakes are now. */
  get parts(): SeaParts {
    const kind = this.detail.kind;
    return {
      detail: this.detail.nodes,
      // The second patch of the transform holds the finest ripples itself.
      shimmer: !(kind.kind === 'fft' && kind.patches === 2),
      pattern: this.pattern,
      wakes: (p) => this.wakes.sample(p),
    };
  }

  /** The sea's three materials for the look as it is now: the tiles by the pass, the tiles per vertex, the far sea. */
  #materials(): [MeshBasicNodeMaterial, MeshBasicNodeMaterial, MeshBasicNodeMaterial] {
    const parts = this.parts;
    const tile = (tiles: Tiles): MeshBasicNodeMaterial => {
      const m = seaMaterial('sea-tile');
      m.positionNode = tiles.position;
      m.fragmentNode = tileLook(tiles.varyings, parts);
      return m;
    };
    const far = seaMaterial('sea-far');
    far.positionNode = this.far.position;
    far.fragmentNode = farLook(this.far, parts);
    return [tile(this.passTiles), tile(this.vertexTiles), far];
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
   * Sets what the sea's look is drawn with. When that changes what its
   * shaders read, new materials are made; compile, given, compiles them
   * off the frame first, and they are swapped in together once ready, so no
   * frame waits for a shader. Resolves when the look is in use.
   */
  async setQuality(
    q: SeaQuality,
    compile: ((object: Object3D) => Promise<void>) | null = null,
    renderer: WebGPURenderer | null = null,
  ): Promise<void> {
    this.wakes.setSize(q.foamMap);
    const retire = this.detail.set(q.detail, q.anisotropy);
    if (retire === null) {
      return;
    }
    const change = ++this.#pending;
    const before = this.wakes.readers;
    const made = this.#materials();
    if (compile !== null) {
      // The meshes as they will be, off the scene, for the compiler to see.
      const meshes = [this.#active, this.far].map((m, i) => {
        const copy = m.mesh.clone() as Mesh;
        copy.material = (
          i === 0 ? made[this.#active === this.passTiles ? 0 : 1] : made[2]
        ) as MeshBasicNodeMaterial;
        return copy;
      });
      await Promise.all([
        ...meshes.map((m) => compile(m)),
        renderer === null ? Promise.resolve() : this.detail.compile(renderer),
      ]);
      if (change !== this.#pending) {
        // Another change overtook this one, and lets go of what this one would have.
        for (const m of made) {
          m.dispose();
        }
        this.#retired.push(retire);
        return;
      }
    }
    this.detail.commit();
    const old = [
      this.passTiles.mesh.material,
      this.vertexTiles.mesh.material,
      this.far.mesh.material,
    ];
    this.passTiles.mesh.material = made[0];
    this.vertexTiles.mesh.material = made[1];
    this.far.mesh.material = made[2];
    for (const m of old) {
      (m as MeshBasicNodeMaterial).dispose();
    }
    // What the old materials read is let go only now that nothing draws with them.
    this.wakes.forget(before);
    this.#retired.push(retire);
    for (const r of this.#retired.splice(0)) {
      r();
    }
  }

  /**
   * Brings the sea up to date: the window of the sea in effect at the
   * frame's world time, the band's phases at the origin then, the tile
   * field on the tile under the boat, the far sea's reach for the camera's
   * height; then the sea under the boat, the detail band and the wakes.
   * Then runs the tile pass.
   */
  update(renderer: WebGPURenderer, origin: FloatingOrigin, f: SeaFrame): void {
    this.#layOut(f.tick);
    this.band.update(origin.world.x, origin.world.y, f.tick);
    this.uniforms.sync();
    hexCentre(origin.centre.q, origin.centre.r, this.#centre);
    const centre = this.passTiles.centre.value;
    centre.set(this.#centre.x - origin.world.x, -(this.#centre.y - origin.world.y));
    this.passTiles.centreHex.value.set(origin.centre.q, origin.centre.r);
    this.far.outer.value = farRadius(f.cameraHeight);
    seaTime.value = (f.tick / STEPS_PER_SECOND) % 1000;
    const src = this.source;
    this.gusts.update(
      src?.weather === true ? src.physics : null,
      f.tick,
      origin.world.x,
      origin.world.y,
    );
    this.gusts.water.update(
      this.gusts.uniforms.spells.value > 0,
      src?.weather === true ? src.physics : null,
      src?.seas ?? null,
      f.tick,
      f.tick / STEPS_PER_SECOND,
      origin.world.x,
      origin.world.y,
    );

    const u = this.under;
    u.update(f.boatEast, f.boatNorth, f.dt);
    // The pattern is laid over the world: the scene's x runs east and its z south.
    patternOrigin.value.set(
      fract1(origin.world.x / FOAM.patternSpan),
      fract1(-origin.world.y / FOAM.patternSpan),
    );
    const turned = this.#streaks;
    turned.update(u.east, u.north, origin.world.x, origin.world.y, f.boatEast, f.boatNorth);
    streakToward.value.set(turned.east, turned.north);
    streakOrigin.value.set(turned.u, turned.v);
    let streaks = 0;
    for (const a of u.areas) {
      streaks = Math.max(streaks, a.y);
    }
    streaksOn.value = streaks > 0 ? 1 : 0;
    const frame = this.frame;
    frame.originEast = origin.world.x;
    frame.originNorth = origin.world.y;
    frame.boatEast = f.boatEast;
    frame.boatNorth = f.boatNorth;
    frame.time = f.tick / STEPS_PER_SECOND;
    frame.dt = f.dt;
    this.detail.update(renderer, frame);
    this.wakes.update(renderer, {
      originEast: origin.world.x,
      originNorth: origin.world.y,
      boatEast: f.boatEast,
      boatNorth: f.boatNorth,
      dt: this.drawWakes ? f.dt : 0,
    });
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
      this.under.lay(null);
    } else {
      this.band.set(src.physics, slot, held.col, held.row, held.size);
      this.under.lay(held);
    }
  }
}
