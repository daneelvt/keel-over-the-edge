// SPDX-License-Identifier: AGPL-3.0-only

// The mesh worker under Node: the chunks Go writes unpack to Go's grids;
// one of another world, number or format, or cut short, is refused; a kept
// chunk is not fetched again, and another world's are deleted; without
// CacheStorage every chunk is fetched; a fetch that fails is tried again
// after a wait that doubles, and holds up no other; and the land's mesh is
// columns of the right height, sides only toward lower neighbours, as many
// triangles as the land asks for.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { GROUND } from '../../predict/layout.gen';
import { buildChunk, chunkCorner, drawnHeight, type LandLook } from './build';
import type { Caches } from './cache';
import { CHUNK_FORMAT, readChunk, unpackChunk, worldBytes } from './chunk';
import { landLook } from './look';
import { type FromMesh, MeshWorker, RETRIES } from './mesh';

interface FileChunk {
  name: string;
  number: number;
  payload: string;
  elevation: string;
  surface: string;
  shelter: string;
  format: number;
  buildings: number;
  discs: number;
  roofs: number;
  parts: number;
  firstRoof?: Record<string, number>;
  firstPart?: Record<string, number>;
  first?: {
    kind: number;
    kit: number;
    east: number;
    north: number;
    heading: number;
    level: number;
    top: number;
    storeys: number;
    seed: number;
    frontage: number;
    depth: number;
    town: number;
  };
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../../internal/worldgen/testdata/chunks.json', import.meta.url),
    'utf8',
  ),
) as { format: number; world: string; chunks: FileChunk[] };
const world = worldBytes(file.world);
const payloadOf = (c: FileChunk): Uint8Array => new Uint8Array(Buffer.from(c.payload, 'base64'));
const digest = (b: ArrayBufferView | null): string =>
  b === null
    ? ''
    : createHash('sha256')
        .update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
        .digest('hex');
const chunkNamed = (name: string): FileChunk => {
  const c = file.chunks.find((k) => k.name.includes(name));
  if (c === undefined) {
    throw new Error(`chunks.json has no ${name}`);
  }
  return c;
};

describe('a chunk', () => {
  test('unpacks to the grids Go wrote', async () => {
    expect(CHUNK_FORMAT).toBe(file.format);
    expect(file.chunks.length).toBe(6);
    for (const c of file.chunks) {
      const g = await unpackChunk(payloadOf(c), c.number, world);
      if (typeof g === 'string') {
        throw new Error(`${c.name}: ${g}`);
      }
      expect(digest(g.elevation), c.name).toBe(c.elevation);
      expect(digest(g.surface), c.name).toBe(c.surface);
      expect(digest(g.shelter), c.name).toBe(c.shelter);
      expect(g.town?.buildings.length ?? 0, c.name).toBe(c.buildings);
      expect(g.town?.harbour.length ?? 0, c.name).toBe(c.discs);
      if (c.first !== undefined) {
        const b = g.town?.buildings[0];
        expect(b, c.name).toBeDefined();
        for (const [k, v] of Object.entries(c.first)) {
          expect(b?.[k as keyof typeof b], `${c.name}: ${k}`).toBeCloseTo(v, 9);
        }
      }
      expect(g.features?.roofs.length ?? 0, c.name).toBe(c.roofs);
      expect(g.features?.parts.length ?? 0, c.name).toBe(c.parts);
      for (const [want, got] of [
        [c.firstRoof, g.features?.roofs[0]],
        [c.firstPart, g.features?.parts[0]],
      ] as const) {
        if (want === undefined) {
          continue;
        }
        expect(got, c.name).toBeDefined();
        for (const [k, v] of Object.entries(want)) {
          expect(got?.[k as keyof typeof got], `${c.name}: ${k}`).toBeCloseTo(v, 9);
        }
      }
    }
  });

  test('of format 1 is a chunk with no town; Port Royal’s holds its town', async () => {
    const old = chunkNamed('format 1');
    expect(old.format).toBe(1);
    const g = await unpackChunk(payloadOf(old), old.number, world);
    expect(typeof g === 'string' ? g : g.town).toBeNull();
    const port = chunkNamed('Port Royal');
    expect(port.buildings).toBeGreaterThan(20);
    expect(port.discs).toBeGreaterThan(0);
  });

  test('of another world, number or format, or cut short, is refused', async () => {
    const c = chunkNamed('made');
    const other = worldBytes(file.world);
    other[15] = (other[15] ?? 0) ^ 1;
    expect(await unpackChunk(payloadOf(c), c.number, other)).toMatch(/another world/);
    expect(await unpackChunk(payloadOf(c), c.number + 1, world)).toMatch(/^chunk \d+, not/);
    const raw = new Uint8Array(gunzipSync(payloadOf(c)));
    const format = raw.slice();
    format[4] = CHUNK_FORMAT + 1;
    expect(readChunk(format, c.number, world)).toMatch(/format/);
    const magic = raw.slice();
    magic[0] = 0;
    expect(readChunk(magic, c.number, world)).toBe('not a chunk');
    expect(readChunk(raw.subarray(0, raw.length - 1), c.number, world)).toMatch(/cut short/);
    expect(readChunk(new Uint8Array([...raw, 0]), c.number, world)).toMatch(/too many/);
    const payload = payloadOf(c);
    expect(await unpackChunk(payload.subarray(0, payload.length >> 1), c.number, world)).toMatch(
      /^not a chunk/,
    );
    // gzip of too much is cut off before it is all unpacked.
    expect(
      await unpackChunk(new Uint8Array(gzipSync(new Uint8Array(1 << 22))), c.number, world),
    ).toMatch(/too much/);
  });
});

/** CacheStorage in memory, counting what is asked of it. */
function memoryCaches(): Caches & {
  stores: Map<string, Map<string, Uint8Array>>;
  matches: number;
} {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const c = {
    stores,
    matches: 0,
    async open(name: string) {
      let s = stores.get(name);
      if (s === undefined) {
        s = new Map();
        stores.set(name, s);
      }
      const store = s;
      return {
        match: async (path: string) => {
          c.matches++;
          const b = store.get(path);
          return b === undefined
            ? undefined
            : { arrayBuffer: async () => b.slice().buffer as ArrayBuffer };
        },
        put: async (path: string, response: Response) => {
          store.set(path, new Uint8Array(await response.arrayBuffer()));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  return c;
}

/**
 * A mesh worker on a network of the given answers, counting its fetches.
 * Its waits end when the test lets them go (release), or at once.
 */
function worker(
  caches: Caches | null,
  answer: (path: string, attempt: number) => Uint8Array | number,
  held = false,
): {
  w: MeshWorker;
  posted: FromMesh[];
  fetches: string[];
  waits: number[];
  release: () => boolean;
} {
  const posted: FromMesh[] = [];
  const fetches: string[] = [];
  const waits: number[] = [];
  const waiting: (() => void)[] = [];
  const tries = new Map<string, number>();
  const w = new MeshWorker({
    fetch: async (path) => {
      fetches.push(path);
      const n = tries.get(path) ?? 0;
      tries.set(path, n + 1);
      const a = answer(path, n);
      if (typeof a === 'number') {
        return { ok: false, status: a, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => a.slice().buffer as ArrayBuffer };
    },
    caches,
    post: (m) => posted.push(m),
    now: () => performance.now(),
    wait: (ms) => {
      waits.push(ms);
      return held ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
  });
  const release = (): boolean => {
    const next = waiting.shift();
    next?.();
    return next !== undefined;
  };
  return { w, posted, fetches, waits, release };
}

describe('the mesh worker', () => {
  const made = chunkNamed('made');
  const port = chunkNamed('Port Royal');
  const network = (path: string): Uint8Array | number =>
    path === '/w/x/c/made' ? payloadOf(made) : path === '/w/x/c/port' ? payloadOf(port) : 404;

  test('builds a chunk, keeps it, and takes it from the cache the next time', async () => {
    const caches = memoryCaches();
    const { w, posted, fetches } = worker(caches, network);
    await w.handle({ type: 'world', world: file.world });
    await w.handle({ type: 'look', look: landLook(catalog.world) });
    await w.handle({ type: 'fetch', number: port.number, path: '/w/x/c/port' });
    await w.handle({ type: 'fetch', number: port.number, path: '/w/x/c/port' });
    expect(fetches).toEqual(['/w/x/c/port']);
    expect(posted.map((m) => (m.type === 'chunk' ? m.source : m.reason))).toEqual([
      'network',
      'cache',
    ]);
    const first = posted[0];
    if (first?.type !== 'chunk' || first.mesh === null) {
      throw new Error('no mesh');
    }
    expect(first.bytes).toBe(payloadOf(port).length);
    expect(first.mesh.triangles).toBeGreaterThan(10_000);
    // Another world's sea: the first world's chunks are let go.
    await w.handle({ type: 'world', world: '0199c2a4-5f7e-7c3a-9d0e-000000000002' });
    expect([...caches.stores.keys()]).not.toContain(`chunks-${file.world}`);
  });

  test('without CacheStorage, fetches every time', async () => {
    const { w, posted, fetches } = worker(null, network);
    await w.handle({ type: 'world', world: file.world });
    await w.handle({ type: 'fetch', number: made.number, path: '/w/x/c/made' });
    await w.handle({ type: 'fetch', number: made.number, path: '/w/x/c/made' });
    expect(fetches.length).toBe(2);
    expect(posted.every((m) => m.type === 'chunk' && m.source === 'network')).toBe(true);
  });

  test('a fetch that fails is tried again, waiting longer each time, and holds up no other', async () => {
    const { w, posted, waits, release } = worker(
      memoryCaches(),
      (path, attempt) => (path === '/w/x/c/port' && attempt < 3 ? 503 : network(path)),
      true,
    );
    await w.handle({ type: 'world', world: file.world });
    let done = false;
    const slow = w.handle({ type: 'fetch', number: port.number, path: '/w/x/c/port' }).then(() => {
      done = true;
    });
    // The other chunk is had while the first waits to be tried again.
    await w.handle({ type: 'fetch', number: made.number, path: '/w/x/c/made' });
    expect(posted.map((m) => m.type)).toEqual(['failed', 'chunk']);
    while (!done) {
      release();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await slow;
    expect(waits).toEqual(RETRIES.slice(0, 3));
    expect(posted.map((m) => m.type)).toEqual(['failed', 'chunk', 'failed', 'failed', 'chunk']);
    expect(
      posted.filter((m) => m.type === 'failed').every((m) => m.type === 'failed' && !m.final),
    ).toBe(true);
  });

  test('a chunk not served, or not the one asked for, fails for good', async () => {
    const { w, posted, waits } = worker(memoryCaches(), network);
    await w.handle({ type: 'world', world: file.world });
    await w.handle({ type: 'fetch', number: 3, path: '/w/x/c/none' });
    await w.handle({ type: 'fetch', number: port.number + 1, path: '/w/x/c/port' });
    expect(waits).toEqual([]);
    expect(posted.map((m) => m.type === 'failed' && m.final)).toEqual([true, true]);
  });
});

describe('the land’s mesh', () => {
  const look: LandLook = {
    terrace: 0.8,
    shore: 2,
    top: new Uint8Array(GROUND.surfaces * 3).fill(200),
    side: new Uint8Array(GROUND.surfaces * 3).fill(100),
    deck: -1,
    flora: { plants: [], cover: [], garden: [] },
  };

  test('hangs a roof from its top to its underside, the sea under it', () => {
    const e = new Int16Array(GROUND.chunkHexes).fill(-30);
    const s = new Uint8Array(GROUND.chunkHexes);
    const n = 7 * GROUND.chunkSide + 8;
    const [c0, j0] = chunkCorner(n);
    const bare = buildChunk(n, e, s, look);
    expect(bare.triangles).toBe(0);
    const roof = { column: c0 + 40, row: j0 + 40, top: 12, under: 5 };
    const m = buildChunk(n, e, s, look, () => undefined, [roof]);
    // Its top, its underside, and its six sides over the water.
    expect(m.triangles).toBe(4 + 4 + 6 * 2);
    const ys = new Set<number>();
    for (let v = 1; v < m.positions.length; v += 3) {
      ys.add(Math.round((m.positions[v] ?? 0) * 10) / 10);
    }
    expect([...ys].sort((a, b) => a - b)).toEqual([5, 12]);
    expect(m.highest).toBeCloseTo(12, 6);
  });

  test('is a column for each hexagon of land, its sides only toward lower neighbours', () => {
    const e = new Int16Array(GROUND.chunkHexes).fill(-30);
    const s = new Uint8Array(GROUND.chunkHexes);
    // Two neighbours in one column, 3.1 m and 1.1 m high: drawn at the
    // terraces of 3.2 m and 0.8 m.
    const rows = GROUND.chunkRows;
    const a = 100 * rows + 100;
    e[a] = 31;
    e[a + 1] = 11;
    const m = buildChunk(0, e, s, look);
    const tops = new Set<number>();
    for (let i = 0; i < m.positions.length / 3; i++) {
      if (m.colours[i * 4 + 3] === 255) {
        tops.add(Math.round((m.positions[i * 3 + 1] ?? 0) * 100) / 100);
      }
    }
    expect([...tops].sort()).toEqual([0.8, 3.2]);
    // Two tops of four triangles; the higher has six sides, one of them
    // down to the lower; the lower five, the sixth against the higher.
    expect(m.triangles).toBe(2 * 4 + (6 + 5) * 2);
    expect(drawnHeight(5, 0.8)).toBeCloseTo(0.5);
    expect(drawnHeight(8, 0.8)).toBeCloseTo(0.8);
    expect(drawnHeight(13, 0.8)).toBeCloseTo(1.6);
    expect(drawnHeight(799, 0.8)).toBeCloseTo(80);
  });

  test('of Port Royal’s chunk is its 38,200 triangles, within its chunk', async () => {
    const port = chunkNamed('Port Royal');
    const g = await unpackChunk(payloadOf(port), port.number, world);
    if (typeof g === 'string' || g.elevation === null || g.surface === null) {
      throw new Error('no ground');
    }
    const start = performance.now();
    const m = buildChunk(port.number, g.elevation, g.surface, landLook(catalog.world));
    const took = performance.now() - start;
    process.stdout.write(
      `mesh: chunk ${port.number}: ${m.triangles} triangles, ${m.positions.length / 3} vertices, ${(
        (m.positions.byteLength + m.colours.byteLength + m.indices.byteLength) / 1e6
      ).toFixed(2)} MB, built in ${took.toFixed(1)} ms under Node\n`,
    );
    // Its neighbours not known, it walls its borders where its land meets
    // them; with them known, it would not.
    process.stdout.write(
      `mesh: chunk ${port.number}: ${m.blind * 2} of its triangles wall its borders\n`,
    );
    expect(Math.abs(m.triangles - 2 * m.blind - 38_200) / 38_200).toBeLessThan(0.01);
    const [c0] = chunkCorner(port.number);
    expect(c0).toBe((port.number % 16) * GROUND.chunkColumns);
    // Every vertex within the chunk's bounds, from its south-western
    // hexagon: 304 columns of 3.46 m, 264 rows of 4 m, and a hexagon more.
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < m.positions.length; i += 3) {
      minX = Math.min(minX, m.positions[i] ?? 0);
      maxX = Math.max(maxX, m.positions[i] ?? 0);
      minZ = Math.min(minZ, m.positions[i + 2] ?? 0);
      maxZ = Math.max(maxZ, m.positions[i + 2] ?? 0);
    }
    expect(minX).toBeGreaterThanOrEqual(-2.31);
    expect(maxX).toBeLessThanOrEqual(303 * 3.4641 + 2.31);
    expect(maxZ).toBeLessThanOrEqual(4);
    expect(minZ).toBeGreaterThanOrEqual(-(264 * 4 + 4));
    expect(m.highest).toBeGreaterThan(10);
  });
});
