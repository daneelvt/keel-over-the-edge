// SPDX-License-Identifier: AGPL-3.0-only

// The right-of-way overlay is the server's: for every meeting of
// internal/lookout/testdata/rightofway.json the overlay itself, judging
// with the physics module's Articles, picks the same boats, puts the same
// marks over them, and shows the same tack.

import { existsSync, readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { type Approach, approaching, RightOfWay, type Seen } from './rightofway';

interface Pose {
  heading: number;
  boom: number;
}

interface Boat extends Pose {
  east: number;
  north: number;
  heel: number;
  mode: number;
  speed: number;
  windFrom: number;
  before: Pose[];
}

interface RightOfWayFile {
  range: number;
  ahead: number;
  close: number;
  marks: number;
  cases: {
    name: string;
    own: Boat;
    others: Boat[];
    approaches: { index: number; distance: number; time: number }[] | null;
    marks: { index: number; keepClear: boolean; article: string; label: string }[] | null;
    tack: string;
  }[];
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/rightofway.json', import.meta.url),
    'utf8',
  ),
) as RightOfWayFile;

/**
 * The physics module with the wind of a case: windPoint answers the true
 * wind's direction the case gives at each boat's place, and windDrawAt
 * leaves the time alone; the rest is the module's own.
 */
function withWind(physics: Physics, boats: readonly Boat[]): Physics {
  const wind = new Float64Array(SIZES.wind);
  const at = new Map(boats.map((b) => [`${b.east},${b.north}`, b.windFrom]));
  return new Proxy(physics, {
    get(target, key) {
      if (key === 'windDrawAt') {
        return () => {};
      }
      if (key === 'windPoint') {
        return (east: number, north: number): Float64Array => {
          wind[RECORDS.wind.from] = at.get(`${east},${north}`) ?? Number.NaN;
          return wind;
        };
      }
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** A boat as the overlay sees it, as the overlay makes it of a drawn boat. */
const seen = (b: Boat): Seen => ({
  east: b.east,
  north: b.north,
  heading: b.heading,
  heel: b.heel,
  boom: b.boom,
  mode: b.mode,
  vEast: b.speed * Math.sin(b.heading),
  vNorth: b.speed * Math.cos(b.heading),
});

describe('the right-of-way overlay', () => {
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

  test('is the catalog’s', () => {
    const o = catalog.encounters.overlay;
    expect([file.range, file.ahead, file.close, file.marks]).toEqual([
      o.range,
      o.ahead,
      o.close * catalog.boats[0].lengthOverall,
      o.marks,
    ]);
  });

  test('picks the boats that will come close as the server does', () => {
    for (const c of file.cases) {
      const out: Approach[] = [];
      approaching(
        seen(c.own),
        c.others.map(seen),
        c.others.length,
        file.range,
        file.ahead,
        file.close,
        file.marks,
        out,
      );
      const want = c.approaches ?? [];
      expect(
        out.map((a) => a.index),
        c.name,
      ).toEqual(want.map((a) => a.index));
      out.forEach((a, k) => {
        expect(Math.abs(a.distance - (want[k]?.distance ?? Number.NaN)), c.name).toBeLessThan(1e-9);
      });
    }
  });

  test('marks them as the server does, following each boat’s course from its first sight', () => {
    expect(file.cases.length).toBeGreaterThan(10);
    for (const c of file.cases) {
      const p = withWind(physics, [c.own, ...c.others]);
      const row = new RightOfWay(catalog.boats[0], catalog.encounters.overlay, null);
      row.set(true);
      const camera = new PerspectiveCamera();
      // As many judgements as the longest followed, each boat drawn from
      // its first, the sailor's own from the first of all.
      const n = 1 + Math.max(...[c.own, ...c.others].map((b) => b.before.length));
      const poseAt = (b: Boat, k: number): Pose | null => {
        const first = n - 1 - b.before.length;
        return k < first ? null : k === n - 1 ? b : (b.before[k - first] as Pose);
      };
      for (let k = 0; k < n; k++) {
        const ownPose = poseAt(c.own, k) ?? c.own.before[0] ?? c.own;
        const drawn: DrawnBoat[] = [];
        c.others.forEach((b, i) => {
          const pose = poseAt(b, k);
          if (pose !== null) {
            drawn.push({ ...newDrawnBoat(), ...b, ...pose, slot: i, opacity: 1 });
          }
        });
        row.update(
          p,
          k * 1000,
          0,
          { ...seen(c.own), ...ownPose },
          drawn,
          drawn.length,
          0,
          0,
          camera,
        );
      }
      expect(
        row.shown.map((m) => [m.slot, m.kind === 'keep-clear', m.article, m.label]),
        c.name,
      ).toEqual((c.marks ?? []).map((m) => [m.index, m.keepClear, m.article, m.label]));
      expect(row.tack, c.name).toBe(c.tack);
    }
  });
});
