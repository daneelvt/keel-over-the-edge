// SPDX-License-Identifier: AGPL-3.0-only

// The phone keeps the chunks it has fetched, in CacheStorage, one cache
// for each world, named chunks-<world id>: a chunk's address never changes,
// so a chunk fetched once is never fetched again, across visits. When the
// sea is another world's, every other world's cache is deleted. Where there
// is no CacheStorage (a private window, an insecure origin), chunks are
// fetched each time.

/** The part of CacheStorage the worker uses. */
export interface Caches {
  open(name: string): Promise<{
    match(request: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>;
    put(request: string, response: Response): Promise<void>;
  }>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** The prefix of every world's cache's name. */
export const CACHE_PREFIX = 'chunks-';

export class ChunkCache {
  readonly #caches: Caches | null;
  #name = '';

  constructor(caches: Caches | null) {
    this.#caches = caches;
  }

  /** Whether chunks are kept at all. */
  get keeps(): boolean {
    return this.#caches !== null;
  }

  /** The sea is world's: its cache is used, and every other world's deleted. */
  async world(world: string): Promise<void> {
    this.#name = CACHE_PREFIX + world;
    const c = this.#caches;
    if (c === null) {
      return;
    }
    try {
      for (const name of await c.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== this.#name) {
          await c.delete(name);
        }
      }
    } catch {
      // Storage refused: nothing is kept, nothing deleted.
    }
  }

  /** A chunk's payload kept at its address, or null. */
  async get(path: string): Promise<Uint8Array | null> {
    const c = this.#caches;
    if (c === null || this.#name === '') {
      return null;
    }
    try {
      const hit = await (await c.open(this.#name)).match(path);
      return hit === undefined ? null : new Uint8Array(await hit.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Keeps a chunk's payload at its address. */
  async put(path: string, payload: Uint8Array): Promise<void> {
    const c = this.#caches;
    if (c === null || this.#name === '') {
      return;
    }
    try {
      await (await c.open(this.#name)).put(
        path,
        new Response(payload as Uint8Array<ArrayBuffer>, {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      );
    } catch {
      // Storage full or refused: fetched again next time.
    }
  }
}
