// SPDX-License-Identifier: AGPL-3.0-only

// The ground as the page puts it where it is read: the module's nine slots
// follow the boat's chunk and step it on the ground, as Go does; the ground
// window holds each hexagon's depth, land and surface, and moves with the
// camera; the lee's texture holds the module's shelter, cell by cell.

import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { GROUND, RECORDS } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { cellHex, chunkCorner, hexCentre } from '../workers/mesh/build';
import type { ChunkGrids } from '../workers/mesh/chunk';
import { cellAt, chunkAt, GroundWindow, ModuleSlots, WINDOW_COLUMNS, WINDOW_ROWS } from './ground';
import { ShelterTexture, storedFactor } from './shelter';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather);
});

/** A chunk of ground: each hexagon's elevation, decimetres, from its centre. */
function chunk(n: number, f: (x: number, y: number) => number, surface = 0): ChunkGrids {
  const [c0, j0] = chunkCorner(n);
  const e = new Int16Array(GROUND.chunkHexes);
  for (let i = 0; i < e.length; i++) {
    const [q, r] = cellHex(c0 + Math.floor(i / GROUND.chunkRows), j0 + (i % GROUND.chunkRows));
    const [x, y] = hexCentre(q, r);
    e[i] = f(x, y);
  }
  return {
    number: n,
    elevation: e,
    surface: new Uint8Array(GROUND.chunkHexes).fill(surface),
    shelter: null,
  };
}

/** A sandy beach rising east from x = 50 m, dry from 150 m, about the world's centre. */
const beach = (x: number): number => Math.round(10 * Math.max(-4, -4 + (x - 50) / 25));

describe('the module’s slots', () => {
  test('follow the boat’s chunk and its neighbours, and step it on their ground', () => {
    const held = new Map<number, ChunkGrids>();
    for (const n of [119, 120, 135, 136]) {
      held.set(n, chunk(n, beach));
    }
    const slots = new ModuleSlots(physics, catalog.world);
    try {
      expect(chunkAt(40, 10)).toBe(136);
      slots.follow(40, 10, held, 1);
      expect(slots.chunks.slice().sort((a, b) => a - b)).toEqual([
        119, 120, 121, 135, 136, 137, 151, 152, 153,
      ]);
      // A boat sailing east runs onto the beach in the module, as on the server.
      const s = physics.records.state;
      s.fill(0);
      s[RECORDS.state.x] = 140;
      s[RECORDS.state.heading] = Math.PI / 2;
      s[RECORDS.state.surge] = 2;
      s[RECORDS.state.sheetLimit] = 0.6;
      physics.records.env[RECORDS.env.windSpeed] = 6;
      physics.records.control[RECORDS.control.sheet] = 0.45;
      physics.seaUse(-1);
      let aground = 0;
      for (let i = 0; i < 300; i++) {
        physics.step();
        aground = Math.max(aground, physics.records.out[RECORDS.out.aground] ?? 0);
      }
      expect(aground).toBeGreaterThan(0);
      // Into the next chunk east: its neighbours follow; those held were
      // written already, and none not held is written.
      expect(slots.follow(1100, 10, held, 1)).toBe(false);
      expect(slots.chunks).toContain(138);
      expect(slots.chunks).not.toContain(119);
    } finally {
      slots.release();
    }
  });
});

describe('the ground window', () => {
  test('holds each hexagon’s depth, land and surface, and moves with the camera', () => {
    const w = new GroundWindow();
    const held = new Map<number, ChunkGrids>([[136, chunk(136, beach, 3)]]);
    expect(w.update(0, 0, held, 1)).toBe(true);
    expect(w.update(10, 0, held, 1)).toBe(false);
    const at = (east: number, north: number) => {
      const [c, j] = cellAt(east, north);
      return w.at(c, j);
    };
    expect(at(10, 10)).toEqual([40, 0, 3, 0]); // 4 m deep, sand's index 3 given
    expect(at(100, 10)).toEqual([20, 0, 3, 0]); // 2 m deep
    const land = at(300, 10);
    expect(land?.[0]).toBe(0);
    expect(land?.[3]).toBe(255);
    // A chunk not held is open water.
    expect(at(10, -20)).toEqual([255, 0, 0, 0]);
    // Moved 250 m: it follows, and still holds what it held.
    expect(w.update(250, 0, held, 1)).toBe(true);
    expect(at(100, 10)).toEqual([20, 0, 3, 0]);
    expect(WINDOW_COLUMNS * 3.4641 * 0.5).toBeGreaterThan(775);
    expect(WINDOW_ROWS * 4 * 0.5).toBeGreaterThan(765);
  });
});

describe('the lee’s texture', () => {
  test('is the module’s shelter for the wind’s direction, cell by cell', () => {
    const lee = JSON.parse(
      readFileSync(new URL('../../../internal/physics/testdata/lee.json', import.meta.url), 'utf8'),
    ) as { terrain: string; cases: { a0: number; b0: number; from: string; grid: string[] }[] };
    const raw = new Uint8Array(
      gunzipSync(
        readFileSync(
          new URL(
            `../../../internal/physics/testdata/ground/${lee.terrain}.terrain`,
            import.meta.url,
          ),
        ),
      ),
    );
    // The terrain's shelter records, into the module's slots.
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let at = 0;
    let slot = 0;
    while (at < raw.length) {
      const n = v.getUint16(at, true);
      const kind = raw[at + 2];
      at += 3;
      if (kind === 1) {
        at += 3 * GROUND.chunkHexes;
      } else {
        const into = physics.shelterChunk(slot++, n);
        into.set(raw.subarray(at, at + into.length));
        at += into.length;
      }
    }
    const t = new ShelterTexture();
    const c = lee.cases[0];
    if (c === undefined) {
      throw new Error('no case');
    }
    const bits = new DataView(new ArrayBuffer(8));
    bits.setBigUint64(0, BigInt(c.from));
    const from = bits.getFloat64(0);
    // The camera over the hill's cell: the texture's corner is the case's grid's.
    const [hx, hy] = [200, 0];
    t.update(physics, hx, hy, from, 0, true);
    expect([t.a0, t.b0]).toEqual([c.a0, c.b0]);
    let lower = 0;
    c.grid.forEach((hex, i) => {
      bits.setBigUint64(0, BigInt(hex));
      const f = bits.getFloat64(0);
      const got = t.at(c.a0 + (i % 64), c.b0 + Math.floor(i / 64));
      expect(got, `cell ${i}`).toBeCloseTo(storedFactor(f), 9);
      if (f < 0.9) {
        lower++;
      }
    });
    expect(lower).toBeGreaterThan(10);
    for (let s = 0; s < GROUND.slots; s++) {
      physics.shelterChunk(s, GROUND.chunkSide * GROUND.chunkSide);
    }
  });
});
