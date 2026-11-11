// SPDX-License-Identifier: AGPL-3.0-only

// Each bird of the sea's life, every kind and path of the catalog's,
// over its group's whole life: over the water but in a plunge, plunging as
// often as its kind does, coming in from and going out beyond 600 m, never
// on its fellows' point, and the same at the same tick however it is asked.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeKind } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { type BoatAt, birdAt, drawnCount, floorOver, newBirdPlace } from './birds';
import { arrive, lingers } from './flock';

const STEPS = 30;

/** The catalog's birds, each with its index. */
const birds = catalog.life.kinds
  .map((k, i) => ({ k, i }))
  .filter(({ k }) => k.form === 'bird' && k.look !== undefined);

/** A group of a kind, free or with a boat, as the server would begin one. */
function group(k: LifeKind, kind: number, boat: boolean, seed = 12345): LifeSeen {
  const v = ((k.speed[0] ?? 10) + (k.speed[1] ?? 10)) / 2;
  const a = arrive(k, v);
  const stay = k.stay[1] ?? 0;
  const life = boat ? 2 * a + stay : lingers(k) ? 2 * a + stay : 2 * a;
  return {
    id: 'g',
    over: '',
    rev: 0,
    kind,
    start: 3000,
    end: 3000 + Math.ceil(life * STEPS),
    east: 1200,
    north: -800,
    heading: 0.7,
    speed: v,
    count: k.group[1] ?? 1,
    seed,
    with: boat ? 1 : 0,
  };
}

/** A boat sailing north-east at 3 m/s from the group's centre, at tick t. */
function boatAt(e: LifeSeen, t: number): BoatAt {
  const s = (t - e.start) / STEPS;
  return {
    east: e.east + Math.sin(0.4) * 3 * s,
    north: e.north + Math.cos(0.4) * 3 * s,
    heading: 0.4,
    speed: 3,
  };
}

const cases = birds.flatMap(({ k, i }) => [
  { name: `${k.id} free`, k, i, boat: false },
  ...(k.binds === 'follow' ? [{ name: `${k.id} with a boat`, k, i, boat: true }] : []),
]);

describe('the birds of the sea’s life', () => {
  test('the catalog has a bird of each path', () => {
    const paths = new Set(birds.map(({ k }) => k.path));
    expect([...paths].sort()).toEqual(['pass', 'skim', 'soar', 'work']);
  });

  test.each(cases)('$name: over the water but in a plunge, in every sea', ({ k, i, boat }) => {
    const e = group(k, i, boat);
    const p = newBirdPlace();
    for (const sea of [0, 2, 6]) {
      const floor = floorOver(sea);
      for (let b = 0; b < e.count; b++) {
        for (let t = e.start; t < e.end; t += 15) {
          const pose = boat ? boatAt(e, t) : null;
          expect(birdAt(e, k, b, t, pose, sea, p)).toBe(true);
          if (!p.plunge) {
            // A petrel pattering over a wake flies lower, still over it (the
            // least is at least 0.3 m).
            const least = boat && k.patters === true ? floor * 0.6 : floor;
            expect(p.up).toBeGreaterThanOrEqual(least - 1e-9);
          }
          expect(p.under).toBe(p.up < 0);
          if (p.under) {
            expect(p.plunge).toBe(true);
          }
        }
      }
    }
  });

  test.each(cases)('$name: plunges as often as its kind does', ({ k, i, boat }) => {
    const p = newBirdPlace();
    let plunges = 0;
    let minutes = 0;
    // Enough groups for a few hundred plunges at its rate.
    for (let seed = 1; seed <= 400 && minutes * (k.dives ?? 1) < 400; seed++) {
      const e = group(k, i, boat, seed * 7919);
      // Plunges begin a half minute or more from either end, and end
      // before the last half minute.
      minutes += (e.count * Math.max((e.end - e.start) / STEPS - 60 - 25, 0)) / 60;
      for (let b = 0; b < e.count; b++) {
        let was = false;
        for (let t = e.start; t < e.end; t += 30) {
          birdAt(e, k, b, t, boat ? boatAt(e, t) : null, 0, p);
          if (p.plunge && !was) {
            plunges++;
          }
          was = p.plunge;
        }
      }
    }
    const dives = k.dives ?? 0;
    if (dives === 0) {
      expect(plunges).toBe(0);
      return;
    }
    const rate = plunges / minutes;
    expect(rate).toBeGreaterThan(dives * 0.6);
    expect(rate).toBeLessThan(dives * 1.4);
  });

  test.each(cases)('$name: comes in from and goes out beyond 600 m', ({ k, i, boat }) => {
    const e = group(k, i, boat);
    const p = newBirdPlace();
    for (const t of [e.start, e.end - 1]) {
      const pose = boat ? boatAt(e, t) : null;
      const from = pose ?? { east: e.east, north: e.north };
      for (let b = 0; b < e.count; b++) {
        expect(birdAt(e, k, b, t, pose, 1, p)).toBe(true);
        expect(Math.hypot(p.east - from.east, p.north - from.north)).toBeGreaterThan(600);
      }
    }
  });

  test.each(cases)(
    '$name: no two on one point, and flying no faster than a bird',
    ({ k, i, boat }) => {
      const e = group(k, i, boat);
      const p = newBirdPlace();
      const q = newBirdPlace();
      const middle = Math.floor((e.start + e.end) / 2);
      const pose = boat ? boatAt(e, middle) : null;
      const at: [number, number][] = [];
      for (let b = 0; b < e.count; b++) {
        birdAt(e, k, b, middle, pose, 1, p);
        at.push([p.east, p.north]);
      }
      for (let a = 0; a < at.length; a++) {
        for (let b = a + 1; b < at.length; b++) {
          const [ea, na] = at[a] as [number, number];
          const [eb, nb] = at[b] as [number, number];
          expect(Math.hypot(ea - eb, na - nb)).toBeGreaterThan(0.1);
        }
      }
      // A frame apart, with the boat moving on, no faster than 40 m/s.
      let most = 0;
      for (let b = 0; b < e.count; b++) {
        for (let t = e.start; t + 1 < e.end; t += 7) {
          birdAt(e, k, b, t, boat ? boatAt(e, t) : null, 1, p);
          birdAt(e, k, b, t + 1, boat ? boatAt(e, t + 1) : null, 1, q);
          if (!p.under && !q.under) {
            most = Math.max(
              most,
              Math.hypot(q.east - p.east, q.north - p.north, q.up - p.up) * STEPS,
            );
          }
        }
      }
      expect(most).toBeLessThan(40);
    },
  );

  test.each(cases)(
    '$name: the same at the same tick, whatever was asked before',
    ({ k, i, boat }) => {
      const e = group(k, i, boat);
      const t = e.start + 0.37 * (e.end - e.start);
      const pose = boat ? boatAt(e, t) : null;
      const first = newBirdPlace();
      const again = newBirdPlace();
      const other = newBirdPlace();
      birdAt(e, k, 1, t, pose, 2, first);
      birdAt(e, k, 0, t + 400, pose, 0, other);
      birdAt({ ...e }, k, 1, t, pose === null ? null : { ...pose }, 2, again);
      expect(again).toEqual(first);
    },
  );

  test('a group with a boat is nowhere without its boat', () => {
    const { k, i } = birds.find(({ k }) => k.binds === 'follow') ?? (birds[0] as (typeof birds)[0]);
    const e = group(k, i, true);
    expect(birdAt(e, k, 0, (e.start + e.end) / 2, null, 1, newBirdPlace())).toBe(false);
  });

  test('banked into its turns, its heading along its path', () => {
    const { k, i } = birds.find(({ k }) => k.path === 'soar') as (typeof birds)[0];
    const e = group(k, i, false);
    const p = newBirdPlace();
    const q = newBirdPlace();
    const t = (e.start + e.end) / 2;
    birdAt(e, k, 0, t, null, 1, p);
    birdAt(e, k, 0, t + 3, null, 1, q);
    const course = Math.atan2(q.east - p.east, q.north - p.north);
    let d = course - p.heading;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    expect(Math.abs(d)).toBeLessThan(0.1);
    expect(Math.abs(p.bank)).toBeGreaterThan(0.02);
  });

  test('half a group, rounded up, on a low tier', () => {
    const e = group(birds[0]?.k as LifeKind, 0, false);
    expect(drawnCount({ ...e, count: 5 }, true)).toBe(3);
    expect(drawnCount({ ...e, count: 5 }, false)).toBe(5);
    expect(drawnCount({ ...e, count: 1 }, true)).toBe(1);
  });

  test('the dusk’s heading home is the record’s: each bird of a pass goes its way', () => {
    const { k, i } = birds.find(
      ({ k }) => k.homeward === true && k.path === 'pass',
    ) as (typeof birds)[0];
    for (const heading of [0.2, 2.9]) {
      const e = { ...group(k, i, false), heading };
      const p = newBirdPlace();
      const q = newBirdPlace();
      // Away from a plunge: in its first half minute, the birds pass on.
      const t = e.start + 10 * STEPS;
      birdAt(e, k, 0, t, null, 1, p);
      birdAt(e, k, 0, t + 5 * STEPS, null, 1, q);
      const course = Math.atan2(q.east - p.east, q.north - p.north);
      let d = course - heading;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      expect(Math.abs(d)).toBeLessThan(0.4);
    }
  });
});
