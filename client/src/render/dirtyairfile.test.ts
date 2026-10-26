// SPDX-License-Identifier: AGPL-3.0-only

// Dirty air is the server's: the wedge's outline of
// internal/lookout/testdata/dirtyair.json, and for every gathering of boats
// the same wedges drawn, in the same order, each along the same wake as the
// physics module lays it.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { DirtyAir, wedgeOutline } from './dirtyair';

interface Boat {
  east: number;
  north: number;
  heading: number;
  heel: number;
  boom: number;
  vEast: number;
  vNorth: number;
  windSpeed: number;
  windFrom: number;
}

interface DirtyAirFile {
  range: number;
  least: number;
  outline: { s: number[]; c: number[] };
  cases: {
    name: string;
    own: Boat;
    others: Boat[];
    wedges: {
      source: number;
      x: number;
      y: number;
      east: number;
      north: number;
      height: number;
      side: number;
    }[];
  }[];
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/dirtyair.json', import.meta.url),
    'utf8',
  ),
) as DirtyAirFile;

const near = (a: number, b: number | undefined): boolean => Math.abs(a - (b ?? Number.NaN)) < 1e-9;

/** The physics module with the true wind a case gives at each boat's place; the rest is the module's own. */
function withWind(physics: Physics, boats: readonly Boat[]): Physics {
  const wind = new Float64Array(SIZES.wind);
  const at = new Map(boats.map((b) => [`${b.east},${b.north}`, b]));
  return new Proxy(physics, {
    get(target, key) {
      if (key === 'windDrawAt') {
        return () => {};
      }
      if (key === 'windPoint') {
        return (east: number, north: number): Float64Array => {
          const b = at.get(`${east},${north}`);
          wind[RECORDS.wind.speed] = b?.windSpeed ?? Number.NaN;
          wind[RECORDS.wind.from] = b?.windFrom ?? Number.NaN;
          return wind;
        };
      }
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('dirty air', () => {
  const wasm = new URL('../predict/physics.wasm', import.meta.url);
  let physics: Physics;

  beforeAll(async () => {
    if (!existsSync(wasm)) {
      throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
    }
    physics = await loadPhysics(readFileSync(wasm));
    preparePhysics(
      physics,
      catalog.boats[0].physics,
      catalog.weather,
      catalog.world,
      catalog.encounters,
    );
  });

  test('the wedge is the server’s, from the catalog', () => {
    const o = catalog.encounters.overlay;
    expect([file.range, file.least]).toEqual([o.wedges, o.wedgeDeficit]);
    const w = wedgeOutline(catalog.encounters.shadow, o.wedgeDeficit);
    expect(w.s.length).toBe(file.outline.s.length);
    w.s.forEach((s, i) => {
      expect(near(s, file.outline.s[i]), `station ${i}`).toBe(true);
      expect(near(w.c[i] ?? 0, file.outline.c[i]), `station ${i}`).toBe(true);
    });
  });

  test('draws the server’s wedges, each along its wake', () => {
    expect(file.cases.length).toBeGreaterThan(5);
    for (const c of file.cases) {
      const d = new DirtyAir(catalog.encounters.shadow, file.least, file.range);
      d.set(true);
      const drawn: DrawnBoat[] = c.others.map((b, i) => ({
        ...newDrawnBoat(),
        slot: i,
        east: b.east,
        north: b.north,
        heading: b.heading,
        heel: b.heel,
        boom: b.boom,
        speed: Math.hypot(b.vEast, b.vNorth),
        opacity: 1,
      }));
      const own = { ...c.own, mode: 0 };
      d.update(withWind(physics, [c.own, ...c.others]), 0, own, drawn, drawn.length, 0, 0);
      expect(d.drawn, c.name).toBe(c.wedges.length);
      c.wedges.forEach((w, k) => {
        const a = d.axes[k];
        expect(a?.source, c.name).toBe(w.source);
        expect(
          near(a?.east ?? Number.NaN, w.east) && near(a?.north ?? Number.NaN, w.north),
          c.name,
        ).toBe(true);
        const b = w.source < 0 ? c.own : (c.others[w.source] as Boat);
        const wake = physics.wakeOf(
          b.east,
          b.north,
          b.heading,
          b.heel,
          b.boom,
          w.source < 0 ? b.vEast : (drawn[w.source]?.speed ?? 0) * Math.sin(b.heading),
          w.source < 0 ? b.vNorth : (drawn[w.source]?.speed ?? 0) * Math.cos(b.heading),
          b.windSpeed,
          b.windFrom,
        );
        const K = RECORDS.wake;
        expect(near(wake[K.x] ?? 0, w.x) && near(wake[K.y] ?? 0, w.y), c.name).toBe(true);
        expect(near(wake[K.height] ?? 0, w.height), c.name).toBe(true);
        expect(wake[K.side], c.name).toBe(w.side);
      });
    }
  });
});
