// SPDX-License-Identifier: AGPL-3.0-only

// The sea in WebAssembly: the module must give, bit for bit, the waves and
// the surface Go gave when it wrote internal/physics/testdata/sea.json; and
// the windows of the sea a client holds are those the server's messages say.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { fromHex } from './golden';
import { RECORDS, SEA } from './layout.gen';
import { loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';
import { checkSea, type SeaFile } from './seacheck';
import { Seas } from './seas';

const wasm = new URL('./physics.wasm', import.meta.url);
const file = new URL('../../../internal/physics/testdata/sea.json', import.meta.url);

let physics: Physics;
let sea: SeaFile;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather);
  sea = JSON.parse(readFileSync(file, 'utf8')) as SeaFile;
});

describe('the sea in the module', () => {
  test('has the server’s waves, surface and sea under a hull, bit for bit', () => {
    const report = checkSea(physics, sea);
    expect(report.problems).toEqual([]);
    // Six fields of 256 waves, and six seas of 240 points and four hulls.
    expect(Object.keys(sea.components).sort()).toEqual(Object.keys(RECORDS.components).sort());
    expect(report.values).toBe(6 * SEA.components + sea.cases.length * (240 * 4 + 4 * 3));
    expect(sea.cases.length).toBeGreaterThanOrEqual(6);
  });

  test('a module that differs is told so', () => {
    const wrong = { ...sea, cases: sea.cases.map((c) => ({ ...c, origin: [1, 1] })) };
    const report = checkSea(physics, wrong);
    expect(report.problems.length).toBe(20);
    expect(report.problems[0]).toMatch(
      /^breeze, point 0, value 0: 0x[0-9a-f]{16}, the server has 0x/,
    );
  });

  test('takes swell and a current, and draws the lee, with no allocation', () => {
    const bytes = physics.memoryBytes;
    const allocations = physics.allocations;
    const current = [0, 0];
    for (let k = 0; k < 400; k++) {
      physics.seaWindow(1, 30, 18, SEA.window);
      for (let i = 0; i < SEA.window * SEA.window; i++) {
        const c = physics.seaCurrent(30 + (i % SEA.window), 18 + Math.floor(i / SEA.window), current);
        physics.seaArea(1, i, 900 + ((k + i) % 300), (k * 97) % SEA.fromSteps, 11112, 60, 580, 9000, c[0] ?? 0, c[1] ?? 0);
      }
      physics.seaSeal(1);
      physics.leeGrid(1, 300, 260);
      physics.leeAt(1, 5000, 100);
      physics.swellAt(1000, 500, 70 * 60 * 30);
    }
    expect(physics.allocations).toBe(allocations);
    expect(physics.memoryBytes).toBe(bytes);
  });

  test('the border’s sea is calm to the west and a gale to the east', () => {
    const border = sea.cases.find((c) => c.name === 'border');
    const hs = (border?.values ?? []).map((v) => fromHex(v[3] ?? '0x0'));
    expect(Math.min(...hs)).toBeLessThan(0.1);
    expect(Math.max(...hs)).toBeGreaterThan(0.9);
  });
});

function areas(speed: number, size: number = SEA.window) {
  const n = size * size;
  return {
    size,
    speed: new Array<number>(n).fill(speed),
    from: new Array<number>(n).fill(0),
    fetch: new Array<number>(n).fill(11112),
  };
}

describe('the seas a client holds', () => {
  test('are none until one is sent: flat water', () => {
    const seas = new Seas(physics);
    seas.reset();
    expect(seas.slotAt(100)).toBe(-1);
  });

  test('keep the two with the latest ticks, and use the later of those whose tick has come', () => {
    const seas = new Seas(physics);
    seas.reset();
    seas.receive({ tick: 270, col: 16, row: 16, ...areas(514) });
    expect(seas.slotAt(100)).toBe(0); // the only one, though its tick is to come
    expect(seas.slotAt(280)).toBe(0);
    // A change, sent a second ahead.
    seas.receive({ tick: 300, col: 16, row: 16, ...areas(1749) });
    expect(seas.slotAt(299)).toBe(0);
    expect(seas.slotAt(300)).toBe(1);
    expect(seas.slotAt(9000)).toBe(1);
    expect(physics.seaHs(1)[0]).toBeGreaterThan(3 * (physics.seaHs(0)[0] ?? 0));
    // The next replaces the earlier of the two.
    seas.receive({ tick: 330, col: 16, row: 16, ...areas(900) });
    expect(seas.held.map((h) => h.tick)).toEqual([330, 300]);
    expect(seas.slotAt(329)).toBe(1);
    expect(seas.slotAt(330)).toBe(0);
  });

  test('a window about another place replaces the one of its tick', () => {
    const seas = new Seas(physics);
    seas.reset();
    seas.receive({ tick: 270, col: 16, row: 16, ...areas(514) });
    seas.receive({ tick: 300, col: 16, row: 16, ...areas(1749) });
    const before = seas.version;
    // The boat sailed into another area while the change was still to come.
    seas.receive({ tick: 270, col: 17, row: 16, ...areas(514) });
    seas.receive({ tick: 300, col: 17, row: 16, ...areas(1749) });
    expect(seas.held.map((h) => [h.tick, h.col])).toEqual([
      [270, 17],
      [300, 17],
    ]);
    expect(seas.version).toBe(before + 2);
    // Both to come: the earlier is the nearer guess.
    expect(seas.slotAt(200)).toBe(0);
  });

  test('let a malformed message go', () => {
    const seas = new Seas(physics);
    seas.reset();
    const v = seas.version;
    seas.receive({ tick: 1, col: 0, row: 0, ...areas(514, 6) });
    seas.receive({ tick: 1, col: 0, row: 0, ...areas(514), fetch: [1] });
    seas.receive({ tick: 1, col: 0, row: 0, ...areas(514), size: 0 });
    expect(seas.version).toBe(v);
    expect(seas.slotAt(5)).toBe(-1);
    // A smaller window is taken.
    seas.receive({ tick: 1, col: 0, row: 0, ...areas(514, 3) });
    expect(seas.slotAt(5)).toBe(0);
    expect(seas.held[0]?.size).toBe(3);
  });

  test('a prediction steps in the window of each tick', () => {
    const seas = new Seas(physics);
    seas.reset();
    seas.receive({ tick: 0, col: 16, row: 16, ...areas(1749) });
    seas.receive({ tick: 5, col: 16, row: 16, ...areas(0) });
    const r = physics.records;
    r.state.fill(0);
    const heaves: number[] = [];
    for (let tick = 1; tick <= 8; tick++) {
      seas.use(tick);
      physics.step();
      heaves.push(physics.records.out[RECORDS.out.waveHeight] ?? 0);
    }
    // A gale's waves under the hull for four ticks, then none.
    expect(heaves.slice(0, 4).every((h) => h !== 0)).toBe(true);
    expect(heaves.slice(4)).toEqual([0, 0, 0, 0]);
  });
});
