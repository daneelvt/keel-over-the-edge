// SPDX-License-Identifier: AGPL-3.0-only

// The land on the page. The server hands the chunks' addresses as the boat
// comes within sight of them; the page asks the mesh worker for them,
// nearest first and at most four at a time, and keeps what comes back: each
// chunk's mesh in the scene, and its grids (elevations, surfaces, shelter),
// which fill the ground window the sea reads, the lee's texture, and the
// physics module's nine slots about the boat. Each frame every mesh is
// placed by the floating origin and drawn only if it is in the camera's
// view and above its horizon. As the boat sails away a chunk's mesh is let
// go beyond keepMeshes and its grids beyond keepGrids; both are had again
// from the phone's cache if it comes back.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  Vector3,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { World } from '../catalog/types.gen';
import { groundWindow, setShoreLook, shelterTexture, shore } from '../ocean/shore';
import { GROUND } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { FloatingOrigin } from '../render/coords';
import { domeDrop, horizonDistance } from '../render/materials';
import { type ChunkMesh, cellHex, chunkCorner, hexCentre } from '../workers/mesh/build';
import type { ChunkGrids } from '../workers/mesh/chunk';
import { colourBytes, landLook } from '../workers/mesh/look';
import type { FromMesh, ToMesh } from '../workers/mesh/mesh';
import { cellAt, chunkAt, ModuleSlots } from './ground';
import { landMaterial } from './material';

/** The page's end of the mesh worker. */
export interface MeshPort {
  postMessage(m: ToMesh, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<FromMesh>) => void) | null;
}

/** How many chunks are asked for at once. */
export const IN_FLIGHT = 4;

const HEX_STEP = 1.5 * (4 / Math.sqrt(3));
const CHUNK_WIDTH = GROUND.chunkColumns * HEX_STEP;
const CHUNK_HEIGHT = GROUND.chunkRows * 4;

/** A chunk the page knows of. */
interface Held {
  number: number;
  path: string;
  /** Its south-western hexagon's centre, and its outline's bounds, m east and north. */
  east: number;
  north: number;
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  /** Whether it has been had at least once, and if so whether it holds land to draw. */
  had: boolean;
  land: boolean;
  mesh: Mesh | null;
  /** The highest drawn top, m: −∞ until it is built, and for a chunk of no land. */
  highest: number;
  grids: ChunkGrids | null;
  /** Asked of the worker and not yet answered; refused for good. */
  asked: boolean;
  failed: boolean;
}

/** What the developer panel shows of the land. */
export interface LandStats {
  handed: number;
  meshes: number;
  drawn: number;
  grids: number;
  inFlight: number;
  fetched: number;
  cached: number;
  failed: number;
  bytes: number;
  triangles: number;
  /** The meshes' buffers held, on the GPU, bytes. */
  gpuBytes: number;
  /** The last chunk's times, ms. */
  fetchMs: number;
  unpackMs: number;
  buildMs: number;
  /** The slowest build so far, ms. */
  slowestBuild: number;
}

export class Land {
  readonly group = new Group();
  readonly material: MeshStandardNodeMaterial;
  readonly stats: LandStats = {
    handed: 0,
    meshes: 0,
    drawn: 0,
    grids: 0,
    inFlight: 0,
    fetched: 0,
    cached: 0,
    failed: 0,
    bytes: 0,
    triangles: 0,
    gpuBytes: 0,
    fetchMs: 0,
    unpackMs: 0,
    buildMs: 0,
    slowestBuild: 0,
  };
  /** The module's nine slots about the boat, while the world's land is sailed. */
  slots: ModuleSlots | null = null;
  /** Called with each chunk had (the tests, the panel). */
  onChunk: ((n: number) => void) | null = null;

  readonly #port: MeshPort;
  readonly #world: World;
  readonly #held = new Map<number, Held>();
  /** The grids held, by chunk, and how often they have changed. */
  readonly #grids = new Map<number, ChunkGrids>();
  #version = 0;
  #worldId = '';
  /** Payloads given with no address, by chunk. */
  readonly #given = new Map<number, ArrayBuffer>();
  #inFlight = 0;
  readonly #frustum = new Frustum();
  readonly #matrix = new Matrix4();
  readonly #box = new Box3();
  readonly #v = new Vector3();
  #physics: Physics | null = null;

  /** The catalog's world draws the land; breaking is its sea's γ, which the shallows' waves are capped by. */
  constructor(port: MeshPort, world: World, breaking: number) {
    this.#port = port;
    this.#world = world;
    this.material = landMaterial();
    this.group.name = 'land';
    port.onmessage = (ev) => this.#receive(ev.data);
    port.postMessage({ type: 'look', look: landLook(world) });
    setShoreLook(
      breaking,
      world.look.attenuation,
      world.surfaces.map((s) => colourBytes(s.look.bed)),
      world.surfaces.map((s) => s.look.crest),
    );
  }

  /**
   * The sea is a world's, whose land is sailed or not. Its chunks are its
   * own: another world's are let go. With land, the shallows are drawn, and
   * physics, if given, steps on the ground held.
   */
  setWorld(id: string, land: boolean, physics: Physics | null): void {
    if (id !== this.#worldId) {
      this.clear();
      this.#worldId = id;
      this.#port.postMessage({ type: 'world', world: id });
    }
    shore.on.value = land ? 1 : 0;
    if (land && physics !== null && this.#physics !== physics) {
      this.slots?.release();
      this.slots = new ModuleSlots(physics, this.#world);
      this.#physics = physics;
    } else if (!land && this.slots !== null) {
      this.slots.release();
      this.slots = null;
      this.#physics = null;
    }
  }

  /** Lets every chunk go. */
  clear(): void {
    for (const h of this.#held.values()) {
      this.#dropMesh(h);
    }
    this.#held.clear();
    this.#given.clear();
    this.#grids.clear();
    this.#version++;
    this.#inFlight = 0;
    this.stats.handed = 0;
  }

  /** The server handed these chunks' addresses. */
  hand(numbers: readonly number[], paths: readonly string[]): void {
    numbers.forEach((n, i) => {
      const path = paths[i];
      if (path === undefined || this.#held.has(n)) {
        return;
      }
      this.#held.set(n, newHeld(n, path));
      this.stats.handed++;
    });
  }

  /**
   * A chunk's payload given with no address (the sandbox's world file): it
   * is kept, and given to the worker again whenever the chunk is wanted.
   */
  give(n: number, payload: ArrayBuffer): void {
    if (!this.#held.has(n)) {
      this.#held.set(n, newHeld(n, ''));
      this.stats.handed++;
    }
    this.#given.set(n, payload);
  }

  /** The chunks handed (the tests). */
  get handed(): number[] {
    return [...this.#held.keys()];
  }

  /** The grids held, by chunk. */
  get grids(): ReadonlyMap<number, ChunkGrids> {
    return this.#grids;
  }

  /**
   * Whether every chunk handed whose outline is within reach of (east,
   * north) has been had, or failed for good: the start screen waits for it.
   */
  ready(east: number, north: number, reach: number): boolean {
    for (const h of this.#held.values()) {
      if (outlineDistance(h, east, north) <= reach && !h.had && !h.failed) {
        return false;
      }
    }
    return true;
  }

  /** The surface's friction under (east, north), by the grids held; 0 where none is held. */
  frictionAt(east: number, north: number): number {
    const [c, j] = cellAt(east, north);
    const n = chunkAt(east, north);
    const g = this.#grids.get(n);
    if (g === undefined || g.surface === null) {
      return 0;
    }
    const [c0, j0] = chunkCorner(n);
    const s = g.surface[(c - c0) * GROUND.chunkRows + (j - j0)] ?? 0;
    return this.#world.surfaces[s]?.friction ?? 0;
  }

  /** The ground's height under (east, north), m, by the grids held: below 0 under the sea; null where none is held. */
  heightAt(east: number, north: number): number | null {
    const [c, j] = cellAt(east, north);
    const n = chunkAt(east, north);
    const g = this.#grids.get(n);
    if (g === undefined || g.elevation === null) {
      return null;
    }
    const [c0, j0] = chunkCorner(n);
    return (g.elevation[(c - c0) * GROUND.chunkRows + (j - j0)] ?? 0) / 10;
  }

  /** The highest drawn land of chunk n, or −∞ (the tests). */
  highestOf(n: number): number {
    return this.#held.get(n)?.highest ?? Number.NEGATIVE_INFINITY;
  }

  /** Whether chunk n's mesh was drawn this frame (the tests). */
  drawn(n: number): boolean {
    return this.#held.get(n)?.mesh?.visible === true;
  }

  /**
   * The frame: asks for the chunks wanted, lets go those far behind, places
   * every mesh and decides which are drawn; then brings the ground window,
   * the lee and the module's slots up to date. The scene's focus is at
   * (east, north): the boat, or the point beneath the free camera; the
   * boat at (boatEast, boatNorth), whose grids are kept and whose ground
   * the module's slots hold wherever the focus is. camera is the scene's.
   */
  frame(
    east: number,
    north: number,
    camera: Camera,
    origin: FloatingOrigin,
    windFrom: number,
    now: number,
    boatEast = east,
    boatNorth = north,
  ): void {
    const keepMeshes = this.#world.look.keepMeshes;
    const keepGrids = this.#world.look.keepGrids;
    // Ask, nearest first: a chunk never had, a mesh let go and wanted
    // again, grids let go and wanted again.
    if (this.#inFlight < IN_FLIGHT) {
      const want: [number, Held][] = [];
      for (const h of this.#held.values()) {
        if (h.asked || h.failed || (h.path === '' && !this.#given.has(h.number))) {
          continue;
        }
        const d = outlineDistance(h, east, north);
        const dBoat = Math.min(d, outlineDistance(h, boatEast, boatNorth));
        const mesh = d <= keepMeshes && (!h.had || (h.land && h.mesh === null));
        const grids = dBoat <= keepGrids && h.grids === null;
        if (mesh || grids) {
          want.push([d, h]);
        }
      }
      want.sort((a, b) => a[0] - b[0]);
      for (const [, h] of want) {
        if (this.#inFlight >= IN_FLIGHT) {
          break;
        }
        h.asked = true;
        this.#inFlight++;
        const given = this.#given.get(h.number);
        if (given !== undefined) {
          const copy = given.slice(0);
          this.#port.postMessage({ type: 'payload', number: h.number, payload: copy }, [copy]);
        } else {
          this.#port.postMessage({ type: 'fetch', number: h.number, path: h.path });
        }
      }
    }
    // Let go, place and choose.
    camera.updateMatrixWorld();
    this.#matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#matrix);
    const cam = camera.getWorldPosition(this.#v);
    const camEast = cam.x + origin.world.x;
    const camNorth = -cam.z + origin.world.y;
    const sight = horizonDistance(cam.y);
    let meshes = 0;
    let drawn = 0;
    let triangles = 0;
    let gpuBytes = 0;
    for (const h of this.#held.values()) {
      const d = outlineDistance(h, east, north);
      if (h.mesh !== null && d > keepMeshes) {
        this.#dropMesh(h);
      }
      if (h.grids !== null && Math.min(d, outlineDistance(h, boatEast, boatNorth)) > keepGrids) {
        h.grids = null;
        this.#grids.delete(h.number);
        this.#version++;
      }
      const m = h.mesh;
      if (m === null) {
        continue;
      }
      meshes++;
      for (const at of [
        m.geometry.attributes.position,
        m.geometry.attributes.colour,
        m.geometry.index,
      ]) {
        gpuBytes +=
          (at?.array as (ArrayLike<number> & { byteLength: number }) | undefined)?.byteLength ?? 0;
      }
      m.position.set(h.east - origin.world.x, 0, -(h.north - origin.world.y));
      // Above the horizon: its highest land seen from the camera over the
      // dome; and in view, its box widened down by the dome's drop.
      const fromCamera = outlineDistance(h, camEast, camNorth);
      const above = fromCamera <= sight + horizonDistance(Math.max(h.highest, 0));
      const far = Math.hypot(
        Math.max(Math.abs(h.minE - east), Math.abs(h.maxE - east)),
        Math.max(Math.abs(h.minN - north), Math.abs(h.maxN - north)),
      );
      this.#box.min.set(
        h.minE - origin.world.x,
        -this.#world.look.shore - domeDrop(far),
        -(h.maxN - origin.world.y),
      );
      this.#box.max.set(h.maxE - origin.world.x, h.highest, -(h.minN - origin.world.y));
      m.visible = above && this.#frustum.intersectsBox(this.#box);
      if (m.visible) {
        drawn++;
        triangles += (m.geometry.index?.count ?? 0) / 3;
      }
    }
    this.stats.meshes = meshes;
    this.stats.drawn = drawn;
    this.stats.triangles = triangles;
    this.stats.gpuBytes = gpuBytes;
    this.stats.grids = this.#grids.size;
    this.stats.inFlight = this.#inFlight;
    // What reads the grids.
    groundWindow.update(camEast, camNorth, this.#grids, this.#version);
    shore.window.value.set(groundWindow.col, groundWindow.row);
    if (this.#physics !== null) {
      this.slots?.follow(boatEast, boatNorth, this.#grids, this.#version);
      shelterTexture.update(this.#physics, camEast, camNorth, windFrom, now);
      shore.lee.value.set(shelterTexture.a0, shelterTexture.b0);
    }
  }

  #receive(m: FromMesh): void {
    if (m.world !== this.#worldId && m.path !== '') {
      return;
    }
    const h = this.#held.get(m.number);
    if (h === undefined) {
      return;
    }
    if (m.type === 'failed') {
      this.stats.failed++;
      if (m.final) {
        h.asked = false;
        h.failed = true;
        this.#inFlight = Math.max(0, this.#inFlight - 1);
      }
      return;
    }
    h.asked = false;
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    h.had = true;
    h.land = m.mesh !== null;
    const s = this.stats;
    s.bytes += m.source === 'network' ? m.bytes : 0;
    if (m.source === 'network') {
      s.fetched++;
    } else if (m.source === 'cache') {
      s.cached++;
    }
    s.fetchMs = m.fetchMs;
    s.unpackMs = m.unpackMs;
    s.buildMs = m.buildMs;
    s.slowestBuild = Math.max(s.slowestBuild, m.buildMs);
    if (h.grids === null) {
      h.grids = m.grids;
      this.#grids.set(m.number, m.grids);
      this.#version++;
    }
    if (m.mesh !== null && h.mesh === null) {
      h.mesh = this.#meshOf(m.mesh);
      h.highest = m.mesh.highest;
      this.group.add(h.mesh);
    }
    this.onChunk?.(m.number);
  }

  #meshOf(c: ChunkMesh): Mesh {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(c.positions, 3));
    g.setAttribute('colour', new BufferAttribute(c.colours, 4, true));
    g.setIndex(new BufferAttribute(c.indices, 1));
    const m = new Mesh(g, this.material);
    m.name = `land ${c.number}`;
    // Placed and culled by the land itself, with the dome's drop.
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.matrixAutoUpdate = true;
    return m;
  }

  #dropMesh(h: Held): void {
    if (h.mesh === null) {
      return;
    }
    this.group.remove(h.mesh);
    h.mesh.geometry.dispose();
    h.mesh = null;
  }
}

function newHeld(n: number, path: string): Held {
  const [c0, j0] = chunkCorner(n);
  const [q0, r0] = cellHex(c0, j0);
  const [east, north] = hexCentre(q0, r0);
  const radius = 4 / Math.sqrt(3);
  return {
    number: n,
    path,
    east,
    north,
    minE: east - radius,
    maxE: east + CHUNK_WIDTH - HEX_STEP + radius,
    minN: north - 4,
    maxN: north + CHUNK_HEIGHT + 2,
    had: false,
    land: false,
    mesh: null,
    highest: Number.NEGATIVE_INFINITY,
    grids: null,
    asked: false,
    failed: false,
  };
}

/** How far (east, north) is from a chunk's outline, 0 inside. */
function outlineDistance(h: Held, east: number, north: number): number {
  const dx = Math.max(h.minE - east, 0, east - h.maxE);
  const dy = Math.max(h.minN - north, 0, north - h.maxN);
  return Math.hypot(dx, dy);
}
