// SPDX-License-Identifier: AGPL-3.0-only

// The sea: the boat band's waves, the tile pass, the tiles and the far sea,
// kept in step each frame with the sea the boat is sailed in, the floating
// origin, the tile under the boat and the camera's height; and, drawn on
// them, the detail band, the foam, the wake's waves and the foam map.

import type { Mesh, Object3D, Scene } from 'three';
import type { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { catalog } from '../catalog';
import { STEPS_PER_SECOND } from '../game/clock';
import { RECORDS, SEA } from '../predict/layout.gen';
import { type Physics, SEA_PARTS } from '../predict/physics';
import type { Seas } from '../predict/seas';
import type { FloatingOrigin } from '../render/coords';
import { seaMaterial } from '../render/materials';
import type { DetailKind, WakeWavesKind } from '../render/quality';
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
import {
  detailSteep,
  farLook,
  NO_LAYERS,
  type SeaLayer,
  type SeaParts,
  seaTime,
  setSeaGlow,
  tileLook,
} from './seamaterial';
import { leeTexture, shore } from './shore';
import { TilePass } from './tilepass';
import { Tiles } from './tiles';
import { fract1, Turned } from './turn';
import { SeaUnder } from './under';
import { WakeWaves } from './wakewaves';
import { waterRainAt } from './water';
import { type BandUniforms, bandUniforms } from './wave';

/** The mean wind about the boat is sampled for the drawn sea this often, in seconds of world time. */
const LOCAL_EVERY = 0.5;

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
  /** The wake's waves. */
  wakeWaves: WakeWavesKind;
  /** The layers of the look left out. */
  omit: ReadonlySet<SeaLayer>;
  /**
   * Whether the tiles a hull may reach are drawn apart from the rest, so
   * that only their shader holds the hulls' cut: the walk over the hulls
   * and the fragments it throws away cost the whole sea where every tile
   * draws with it.
   */
  apart: boolean;
}

/** The sea's materials: each set of tiles' own and its tiles by the hulls' (the same where not drawn apart), and the far sea's. */
interface SeaMaterials {
  pass: [MeshBasicNodeMaterial, MeshBasicNodeMaterial];
  vertex: [MeshBasicNodeMaterial, MeshBasicNodeMaterial];
  far: MeshBasicNodeMaterial;
}

/** Every material of a set, each once. */
function eachMaterial(m: SeaMaterials): MeshBasicNodeMaterial[] {
  return [...new Set([...m.pass, ...m.vertex, m.far])];
}

/** Whether two sets of layers hold the same. */
function sameLayers(a: ReadonlySet<SeaLayer>, b: ReadonlySet<SeaLayer>): boolean {
  return a.size === b.size && [...a].every((l) => b.has(l));
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
  /** The wake's waves: the hulls push on them (scene.ts). */
  readonly wakeWaves = new WakeWaves();
  readonly pattern = patternTexture();
  /** Whether the wakes are drawn: the wake's waves, the track and the white water (the developer panel). */
  drawWakes = true;
  /** Whether the renderer runs compute passes. */
  compute = false;
  /** The current at the boat, m/s east and north: the wakes drift with it. */
  readonly current = { east: 0, north: 0 };
  /** The boat's heading, which places the wake's waves' square. */
  heading = 0;
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
  /** How much the current raises each area's waves, as laid. */
  readonly #raised = new Float64Array(SEA.window * SEA.window);
  #version = -1;
  /** The layers of the look left out, as the materials were last made. */
  #omit: ReadonlySet<SeaLayer> = NO_LAYERS;
  /** Whether the tiles a hull may reach are drawn apart, as the materials were last made. */
  #apart = false;
  /** The streaks of foam as they are turned to the wind. */
  readonly #streaks = new Turned(STREAK_ALONG, STREAK_ACROSS);
  /** A change of the look under way: the materials being compiled, to be swapped in together. */
  #pending = 0;
  /** What earlier looks read, to be let go once no material draws with it. */
  readonly #retired: (() => void)[] = [];
  /** The mean wind at each area's centre, as last sampled, and when and in which window and sea it was. */
  readonly #local = new Float64Array(SEA.window * SEA.window);
  #localTick = Number.NEGATIVE_INFINITY;
  #localSlot = -1;
  #localVersion = -1;

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
    const ww = this.wakeWaves;
    this.wakes = new FoamMap(foamMap, (east, north) => ww.foldAt(east, north));
    this.far = new FarSea(this.uniforms, this.passTiles.centre, this.passTiles.centreHex);
    const made = this.#materials();
    Ocean.#dress(this.passTiles, made.pass);
    Ocean.#dress(this.vertexTiles, made.vertex);
    this.far.mesh.material = made.far;
    this.#active = this.passTiles;
    scene.add(this.passTiles.mesh);
    scene.add(this.far.mesh);
  }

  /**
   * Glowing water: the boats' white water and their track drawn as light
   * of a colour (display values, 0 to 1), by a strength from 0 (none: the
   * sea as without it) to 1. Only a uniform changes, so it may be called
   * every frame: nothing is allocated and no shader is remade.
   */
  setGlow(r: number, g: number, b: number, strength: number): void {
    setSeaGlow(r, g, b, strength);
  }

  /** What the look is made from, as the detail band and the wakes are now. */
  get parts(): SeaParts {
    const kind = this.detail.kind;
    const ww = this.wakeWaves;
    return {
      omit: this.#omit,
      byVertex: this.#apart,
      detail: this.detail.nodes,
      // The second patch of the transform holds the finest ripples itself.
      shimmer: !(kind.kind === 'fft' && kind.patches === 2),
      pattern: this.pattern,
      wakes: (p) => this.wakes.sample(p),
      wakeWaves: {
        fine: (p, dist) => ww.fine(p, dist),
        coarse: (p) => ww.coarse(p),
        covers: (p, margin) => ww.covers(p, margin),
      },
      rain: (p) => waterRainAt(this.gusts.water)(p),
    };
  }

  /**
   * The sea's materials for the look as it is now: the tiles by the pass,
   * the tiles per vertex, each with its tiles by the hulls, and the far sea.
   */
  #materials(): SeaMaterials {
    const parts = this.parts;
    const tile = (tiles: Tiles): [MeshBasicNodeMaterial, MeshBasicNodeMaterial] => {
      const m = seaMaterial('sea-tile');
      if (!this.#apart) {
        m.positionNode = tiles.position;
        m.fragmentNode = tileLook(tiles.varyings, parts);
        return [m, m];
      }
      // The tiles no hull reaches, without the cut; and those it may, with it.
      m.positionNode = tiles.away;
      m.fragmentNode = tileLook(tiles.varyings, {
        ...parts,
        omit: new Set([...parts.omit, 'cut']),
      });
      const h = seaMaterial('sea-tile');
      h.positionNode = tiles.byHulls;
      h.fragmentNode = tileLook(tiles.varyings, parts);
      return [m, h];
    };
    const far = seaMaterial('sea-far');
    far.positionNode = this.far.position;
    far.fragmentNode = farLook(this.far, parts);
    return { pass: tile(this.passTiles), vertex: tile(this.vertexTiles), far };
  }

  /** Puts a set of tiles' materials on its meshes; the mesh of the tiles by the hulls is drawn only where it has its own. */
  static #dress(
    tiles: { mesh: Mesh; hullMesh: Mesh },
    [main, hull]: [MeshBasicNodeMaterial, MeshBasicNodeMaterial],
  ): void {
    tiles.mesh.material = main;
    tiles.hullMesh.material = hull;
    tiles.hullMesh.visible = hull !== main;
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
    const waves = this.wakeWaves.setKind(q.wakeWaves, this.compute);
    const omit = q.omit;
    const layers = !sameLayers(omit, this.#omit) || q.apart !== this.#apart;
    this.#omit = omit;
    this.#apart = q.apart;
    const retire =
      this.detail.set(q.detail, q.anisotropy) ?? (waves || layers ? () => undefined : null);
    if (retire === null) {
      return;
    }
    const change = ++this.#pending;
    const before = this.wakes.readers;
    const made = this.#materials();
    if (compile !== null) {
      // The meshes as they will be, off the scene, for the compiler to see.
      const tiles = this.#active.mesh.clone() as Mesh;
      const hull = tiles.children[0] as Mesh;
      Ocean.#dress(
        { mesh: tiles, hullMesh: hull },
        this.#active === this.passTiles ? made.pass : made.vertex,
      );
      const far = this.far.mesh.clone() as Mesh;
      far.material = made.far;
      const meshes = [tiles, far];
      await Promise.all([
        ...meshes.map((m) => compile(m)),
        renderer === null ? Promise.resolve() : this.detail.compile(renderer),
        renderer === null || this.wakeWaves.kernels.length === 0
          ? Promise.resolve()
          : renderer.compileComputeAsync(this.wakeWaves.kernels).then(() => undefined),
      ]);
      if (change !== this.#pending) {
        // Another change overtook this one, and lets go of what this one would have.
        for (const m of eachMaterial(made)) {
          m.dispose();
        }
        this.#retired.push(retire);
        return;
      }
    }
    this.detail.commit();
    const retireWaves = this.wakeWaves.commit();
    const old = new Set([
      this.passTiles.mesh.material,
      this.passTiles.hullMesh.material,
      this.vertexTiles.mesh.material,
      this.vertexTiles.hullMesh.material,
      this.far.mesh.material,
    ]);
    Ocean.#dress(this.passTiles, made.pass);
    Ocean.#dress(this.vertexTiles, made.vertex);
    this.far.mesh.material = made.far;
    for (const m of old) {
      (m as MeshBasicNodeMaterial).dispose();
    }
    // What the old materials read is let go only now that nothing draws with them.
    this.wakes.forget(before);
    this.#retired.push(retire, retireWaves);
    for (const r of this.#retired.splice(0)) {
      r();
    }
  }

  /**
   * Brings the sea up to date: the window of the sea in effect at the
   * frame's world time, the band's phases at the origin then, the tile
   * field on the tile under the boat, the far sea's reach for the camera's
   * height; then the sea under the boat, the detail band and the wakes.
   * Then runs the tile pass. Without a renderer (a frame not drawn) the
   * GPU's passes are left: the detail band, the wakes, the tile pass.
   */
  update(renderer: WebGPURenderer | null, origin: FloatingOrigin, f: SeaFrame): void {
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
    // The waves' lee about the focus, for the sea drawn, once there is land.
    if (src !== null && shore.on.value > 0) {
      leeTexture.update(
        src.physics,
        this.slot,
        src.seas.version,
        origin.world.x,
        origin.world.y,
        performance.now(),
      );
      shore.waves.value.set(leeTexture.a0, leeTexture.b0);
    }

    this.#sampleLocal(f);
    const u = this.under;
    u.update(f.boatEast, f.boatNorth, f.dt);
    detailSteep.value = u.foam.steep;
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
    if (renderer === null) {
      return;
    }
    this.detail.update(renderer, frame);
    const wakeDt = this.drawWakes ? f.dt : 0;
    this.wakeWaves.on.value = this.drawWakes ? 1 : 0;
    this.wakeWaves.update(renderer, {
      originEast: origin.world.x,
      originNorth: origin.world.y,
      boatEast: f.boatEast,
      boatNorth: f.boatNorth,
      heading: this.heading,
      dt: wakeDt,
      currentEast: this.current.east,
      currentNorth: this.current.north,
    });
    this.wakes.update(renderer, {
      originEast: origin.world.x,
      originNorth: origin.world.y,
      boatEast: f.boatEast,
      boatNorth: f.boatNorth,
      dt: wakeDt,
      currentEast: this.current.east,
      currentNorth: this.current.north,
    });
    if (this.#active === this.passTiles) {
      this.pass.render(renderer);
    }
  }

  /**
   * Samples the mean wind at the centre of each area of the window drawn,
   * and at the boat, every LOCAL_EVERY seconds of world time and whenever
   * the sea changes, for what is drawn of the sea to follow where it blows
   * harder than the sea has caught up with.
   */
  #sampleLocal(f: SeaFrame): void {
    const src = this.source;
    const held = src === null || this.slot < 0 ? undefined : src.seas.held[this.slot];
    if (src === null || !src.weather || held === undefined) {
      if (this.#localTick !== Number.NEGATIVE_INFINITY) {
        this.under.clearLocal();
        this.#localTick = Number.NEGATIVE_INFINITY;
      }
      return;
    }
    const since = (f.tick - this.#localTick) / STEPS_PER_SECOND;
    const changed = this.#localSlot !== this.slot || this.#localVersion !== src.seas.version;
    if (!changed && since >= 0 && since < LOCAL_EVERY) {
      return;
    }
    const p = src.physics;
    p.windDrawAt(f.tick);
    const half = SEA.areas >> 1;
    const local = this.#local;
    for (let i = 0; i < local.length; i++) {
      if (i >= held.size * held.size) {
        local[i] = 0;
        continue;
      }
      const col = held.col + (i % held.size);
      const row = held.row + Math.floor(i / held.size);
      const r = p.windPoint((col - half) * SEA.areaSize, (row - half) * SEA.areaSize);
      local[i] = r[RECORDS.wind.meanSpeed] ?? 0;
    }
    const boat = p.windPoint(f.boatEast, f.boatNorth)[RECORDS.wind.meanSpeed] ?? 0;
    // A change of sea, or of time either way, and it is there at once.
    this.under.setLocal(local, boat, changed || !(since > 0) ? 0 : since);
    this.#localTick = f.tick;
    this.#localSlot = this.slot;
    this.#localVersion = src.seas.version;
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
      // How much the current raises each area's waves: its Hs over its Hs
      // in still water.
      const hs = src.physics.seaHs(slot);
      const parts = src.physics.seaParts(slot);
      for (let i = 0; i < this.#raised.length; i++) {
        const still = parts[i * SEA_PARTS + 4] ?? 0;
        this.#raised[i] = still > 0 ? (hs[i] ?? 0) / still : 1;
      }
      this.under.lay(held, this.#raised);
    }
  }
}
