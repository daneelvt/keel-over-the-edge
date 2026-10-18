// SPDX-License-Identifier: AGPL-3.0-only

// The mesh worker's work, apart from the worker's own scope so that the
// tests can run it under Node with a fetch and caches of their own: a
// chunk's address in, its payload from the phone's cache or else the
// network (and kept), unpacked, its header checked, its mesh built; then
// the mesh and the grids out, their buffers transferred. Each chunk is
// worked on by itself, so one that fails, and is tried again after a wait
// that doubles each time, holds up no other.

import {
  buildChunk,
  type ChunkEdges,
  type ChunkMesh,
  edgesOf,
  type LandLook,
  outsideOf,
} from './build';
import { type Caches, ChunkCache } from './cache';
import { type ChunkGrids, unpackChunk, worldBytes } from './chunk';
import { placePlants } from './plants';

export type ToMesh =
  /** The sea is this world's: its chunks are checked against its id, and its cache used. */
  | { type: 'world'; world: string }
  /** How the land is drawn. */
  | { type: 'look'; look: LandLook }
  /** Fetch chunk number from path, or take it from the cache. */
  | { type: 'fetch'; number: number; path: string }
  /** A chunk's payload, given with no address (the sandbox's world file). */
  | { type: 'payload'; number: number; payload: ArrayBuffer };

/** Where a chunk's payload came from. */
export type ChunkSource = 'cache' | 'network' | 'given';

export type FromMesh =
  | {
      type: 'chunk';
      number: number;
      path: string;
      world: string;
      source: ChunkSource;
      /** The payload's bytes, and the times its fetch, unpacking and building took, ms. */
      bytes: number;
      fetchMs: number;
      unpackMs: number;
      buildMs: number;
      /** Its mesh, null if it holds no land; and its grids. */
      mesh: ChunkMesh | null;
      grids: ChunkGrids;
      /** Its plants, PLANT_STRIDE floats each (plants.ts), placed on its land; null with none. */
      plants: Float32Array | null;
    }
  /** A chunk that could not be had: final, for one refused; or not, while it is tried again. */
  | { type: 'failed'; number: number; path: string; world: string; reason: string; final: boolean };

/** What the worker is given: the network, the cache, the clock and its own port. */
export interface MeshDeps {
  fetch(
    path: string,
  ): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  caches: Caches | null;
  post(m: FromMesh, transfer: Transferable[]): void;
  now(): number;
  wait(ms: number): Promise<void>;
}

/** The waits before each try after the first, ms: then it gives up. */
export const RETRIES = [1000, 2000, 4000, 8000, 16000];

/** A fetch refused for good: tried again it would be refused again. */
class Refused extends Error {}

export class MeshWorker {
  readonly #d: MeshDeps;
  readonly #cache: ChunkCache;
  #world = '';
  #worldBytes: Uint8Array = new Uint8Array(16);
  #look: LandLook | null = null;
  /** Each chunk's edges as it was read, for its neighbours' sides: this world's. */
  readonly #edges = new Map<number, ChunkEdges | null>();

  constructor(d: MeshDeps) {
    this.#d = d;
    this.#cache = new ChunkCache(d.caches);
  }

  /** Takes the page's message; the work it starts runs on by itself. */
  handle(m: ToMesh): Promise<void> {
    switch (m.type) {
      case 'world':
        if (m.world !== this.#world) {
          this.#edges.clear();
        }
        this.#world = m.world;
        this.#worldBytes = worldBytes(m.world);
        return this.#cache.world(m.world);
      case 'look':
        this.#look = m.look;
        return Promise.resolve();
      case 'fetch':
        return this.#fetch(m.number, m.path);
      case 'payload':
        return this.#take(m.number, '', this.#world, 'given', new Uint8Array(m.payload), 0);
    }
  }

  async #fetch(n: number, path: string): Promise<void> {
    const world = this.#world;
    const start = this.#d.now();
    const kept = await this.#cache.get(path);
    if (kept !== null) {
      await this.#take(n, path, world, 'cache', kept, this.#d.now() - start);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await this.#download(path);
        const fetched = this.#d.now() - start;
        await this.#take(n, path, world, 'network', payload, fetched, () =>
          this.#cache.put(path, payload),
        );
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const wait = RETRIES[attempt];
        const final = err instanceof Refused || wait === undefined || world !== this.#world;
        this.#d.post({ type: 'failed', number: n, path, world, reason, final }, []);
        if (final) {
          return;
        }
        await this.#d.wait(wait);
        if (world !== this.#world) {
          return;
        }
      }
    }
  }

  async #download(path: string): Promise<Uint8Array> {
    const res = await this.#d.fetch(path);
    if (!res.ok) {
      const why = `${path} answered ${res.status}`;
      // A chunk that is not there is not there next time either.
      throw res.status === 404 || res.status === 410 ? new Refused(why) : new Error(why);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Unpacks, checks and builds a payload, posts it, and if it is good, keeps it. */
  async #take(
    n: number,
    path: string,
    world: string,
    source: ChunkSource,
    payload: Uint8Array,
    fetchMs: number,
    keep?: () => Promise<void>,
  ): Promise<void> {
    const t0 = this.#d.now();
    const grids = await unpackChunk(payload, n, this.#worldBytes);
    const t1 = this.#d.now();
    if (typeof grids === 'string') {
      if (source !== 'cache') {
        this.#d.post({ type: 'failed', number: n, path, world, reason: grids, final: true }, []);
        return;
      }
      // A kept chunk that does not read is fetched again, and replaces it.
      this.#d.post({ type: 'failed', number: n, path, world, reason: grids, final: false }, []);
      await this.#refetch(n, path, world);
      return;
    }
    await keep?.();
    if (world === this.#world) {
      this.#edges.set(n, edgesOf(grids.elevation));
    }
    const look = this.#look;
    const mesh =
      look !== null && grids.elevation !== null && grids.surface !== null
        ? buildChunk(
            n,
            grids.elevation,
            grids.surface,
            look,
            outsideOf(this.#edges),
            grids.features?.roofs,
          )
        : null;
    const placed =
      look !== null && grids.elevation !== null && grids.surface !== null
        ? placePlants(n, grids.elevation, grids.surface, grids.town, look.flora, look.terrace)
        : null;
    const plants = placed !== null && placed.length > 0 ? placed : null;
    const buildMs = this.#d.now() - t1;
    const transfer: Transferable[] = [];
    for (const b of [grids.elevation, grids.surface, grids.shelter]) {
      if (b !== null) {
        transfer.push(b.buffer);
      }
    }
    if (mesh !== null) {
      transfer.push(mesh.positions.buffer, mesh.colours.buffer, mesh.indices.buffer);
    }
    if (plants !== null) {
      transfer.push(plants.buffer);
    }
    const m: FromMesh = {
      type: 'chunk',
      number: n,
      path,
      world,
      source,
      bytes: payload.length,
      fetchMs,
      unpackMs: t1 - t0,
      buildMs,
      mesh: mesh !== null && mesh.triangles > 0 ? mesh : null,
      grids,
      plants,
    };
    this.#d.post(m, transfer);
  }

  async #refetch(n: number, path: string, world: string): Promise<void> {
    try {
      const payload = await this.#download(path);
      await this.#take(n, path, world, 'network', payload, 0, () => this.#cache.put(path, payload));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#d.post({ type: 'failed', number: n, path, world, reason, final: true }, []);
    }
  }
}
