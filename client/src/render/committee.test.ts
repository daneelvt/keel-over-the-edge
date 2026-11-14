// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { PlaceSeen } from '../net/messages';
import { courseNear } from '../sandbox/coursescene';
import { type RaceFrame, RaceMarks, signalFlag } from './committee';
import { DESIGN_TEXELS, flagAtlas } from './flags';

const C = catalog.world.committee;
const beaconKind = catalog.world.places.kinds.findIndex((k) => k.site === 'beacon');

function marks(): RaceMarks {
  return new RaceMarks(C, catalog.world.towns.flags, catalog.world.towns.smoke, beaconKind, false);
}

/** A frame at world time t, the camera at the world's centre, a breeze from the north. */
function frame(t: number): RaceFrame {
  return {
    origin: { x: 0, y: 0 },
    cameraEast: 0,
    cameraNorth: 0,
    time: t,
    lit: 0,
    light: 1,
    windAt: () => ({ speed: 5, from: 0 }),
    surface: null,
  };
}

describe('the signal flags', () => {
  test('every boat has its class pennant, and every other signal one flag', () => {
    for (const b of catalog.boats) {
      expect(signalFlag(C.flags, 'class', b.id), b.id).toBeGreaterThanOrEqual(0);
    }
    for (const s of ['preparatory', 'recall', 'postponement', 'mark', 'pin'] as const) {
      expect(signalFlag(C.flags, s)).toBeGreaterThanOrEqual(0);
    }
  });

  test('each design is drawn texel by texel from its dyes, the head of the hoist first', () => {
    const { data, width, designs } = flagAtlas(C.flags, C.dyes);
    const p = signalFlag(C.flags, 'preparatory');
    const texel = (k: number, x: number, y: number): string => {
      const o = ((k * DESIGN_TEXELS.down + y) * width + x) * 4;
      return `#${[data[o], data[o + 1], data[o + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
    };
    const dye = (letter: string) => C.dyes.find((d) => d.letter === letter)?.colour;
    // The Blue Peter: blue, a white square in its middle.
    expect(texel(p, 0, 0)).toBe(dye('b'));
    expect(texel(p, DESIGN_TEXELS.along / 2, DESIGN_TEXELS.down / 2)).toBe(dye('w'));
    expect(designs[p]?.taper).toBe(0);
    expect(designs[signalFlag(C.flags, 'postponement')]?.taper ?? 0).toBeGreaterThan(0);
  });
});

describe('the committee’s things laid', () => {
  test('a course is laid, its signals changed, and taken up', () => {
    const r = marks();
    const course = courseNear(0, 0, 0, 0, [0]);
    r.lay(1, course);
    r.frame(frame(10));
    expect(r.stats.courses).toBe(1);
    r.signals(1, [0, signalFlag(C.flags, 'preparatory')]);
    expect(r.courses.get(1)?.flags).toHaveLength(2);
    r.drop(1);
    r.frame(frame(11));
    expect(r.stats.courses).toBe(0);
  });

  test('its gun throws smoke from the committee boat that rises and drifts down the wind', () => {
    const r = marks();
    const course = courseNear(0, 0, 0, 0, [0]);
    r.lay(1, course);
    const muzzle = r.fire(1, 1, 10);
    expect(muzzle).not.toBeNull();
    const k = course.committee as { east: number; north: number };
    expect(Math.hypot((muzzle?.east ?? 0) - k.east, (muzzle?.north ?? 0) - k.north)).toBeLessThan(
      6,
    );
    r.frame(frame(10.5));
    const first = r.stats.puffs;
    expect(first).toBeGreaterThan(0);
    const place = r.smoke.place.array as Float32Array;
    const height = (): number => {
      let h = 0;
      for (let i = 0; i < r.smoke.count; i++) {
        h += (place[i * 4 + 1] ?? 0) / r.smoke.count;
      }
      return h;
    };
    const low = height();
    r.frame(frame(20));
    expect(height()).toBeGreaterThan(low + 10);
    // Gone once faded.
    r.frame(frame(10 + C.gun.life + 1));
    expect(r.stats.puffs).toBe(0);
    expect(r.stats.bursts).toBe(0);
    // No committee boat, no gun.
    r.lay(2, { committee: null, pin: null, marks: [], flags: [] });
    expect(r.fire(2, 1, 50)).toBeNull();
  });

  test('beacons are kept from the places handed, and forgotten with the world', () => {
    const r = marks();
    const place = (number: number, kind: number): PlaceSeen => ({
      number,
      kind,
      east: 10 * number,
      north: 0,
      heading: 0,
      ground: 0,
      tower: 0,
      daymark: 0,
      rig: 0,
      age: 0,
      sunk: false,
      heel: 0,
    });
    r.setPlaces([place(1, beaconKind), place(2, beaconKind === 0 ? 1 : 0), place(1, beaconKind)]);
    expect([...r.beacons.keys()]).toEqual([1]);
    r.clear();
    expect(r.beacons.size).toBe(0);
  });
});

describe('the sandbox’s course', () => {
  test('lays its line square to the wind ahead of the boat, the committee boat at the starboard end, mark 1 up the wind', () => {
    // The boat heading east, the wind from the north.
    const c = courseNear(0, 0, Math.PI / 2, 0, []);
    const k = c.committee as { east: number; north: number };
    const p = c.pin as { east: number; north: number };
    // Across the wind: the ends at one northing.
    expect(k.north).toBeCloseTo(p.north, 6);
    // Looking up a north wind, starboard is east.
    expect(k.east).toBeGreaterThan(p.east);
    const one = c.marks.find((m) => m.number === 1);
    expect(one?.north ?? 0).toBeGreaterThan(k.north + 200);
  });
});
