// SPDX-License-Identifier: AGPL-3.0-only

// A tapped system's box: what a tap falls within, a line by its length, a
// low by its ring, a front by its line; the course to meet a system
// crossing the boat's path, which brings the boat to it; a storm running
// away faster than the boat, and the heading to its path ahead; and the
// box's words.

import { describe, expect, test } from 'vitest';
import {
  boxWords,
  courseToMeet,
  forceText,
  frontTarget,
  hitTest,
  minutesText,
  nearestOnLine,
  PATH_AHEAD,
  type Point,
} from './systembox';
import type { SceneFront, SceneSystem } from './weather';

const SECOND = 30;
const MINUTE = 60 * SECOND;
const NM = 1852;
const KNOT = NM / 3600;

/** A system at a place, its kind and wind aside. */
function system(o: Partial<SceneSystem>): SceneSystem {
  return {
    slot: 0,
    kind: 0,
    seed: 1,
    draw: 'cell',
    name: 'Squall',
    east: 0,
    north: 0,
    heading: 0,
    speed: 0,
    size: 500,
    strength: 1,
    length: 0,
    ring: 0,
    wind: 0,
    gust: 0,
    ahead: null,
    gone: null,
    ...o,
  };
}

/** A target moving at a steady velocity from a point, m/s. */
function moving(from: Point, ve: number, vn: number): (t: number) => Point {
  return (t) => ({ east: from.east + (ve * t) / SECOND, north: from.north + (vn * t) / SECOND });
}

describe('a tap on the chart’s weather', () => {
  test('falls within a line by its length, a low by its ring, a cell by its size', () => {
    // A line moving north, its length running east and west.
    const line = system({ slot: 1, heading: 0, size: 300, length: 4000, draw: 'dash-dot' });
    const storm = system({ slot: 2, east: 5000, size: 1000, ring: 2500, draw: 'spiral' });
    const cell = system({ slot: 3, east: -5000, size: 400 });
    const scene = { systems: [line, storm, cell], fronts: [] };
    expect(hitTest(scene, { east: 1800, north: 250 }, 8334)).toEqual({
      kind: 'system',
      system: line,
    });
    expect(hitTest(scene, { east: 2400, north: 0 }, 8334)).toBeNull();
    expect(hitTest(scene, { east: 7300, north: 0 }, 8334)?.kind).toBe('system');
    expect(hitTest(scene, { east: -5000, north: 390 }, 8334)).toEqual({
      kind: 'system',
      system: cell,
    });
    expect(hitTest(scene, { east: -5000, north: 450 }, 8334)).toBeNull();
    expect(nearestOnLine(line, { east: 3000, north: 900 })).toEqual({ east: 2000, north: 0 });
  });

  test('falls on a front within 0.3 NM of its line, inside the disk', () => {
    const front: SceneFront = { sin: 1, cos: 0, line: 1000, warm: false, speed: 10 };
    const scene = { systems: [], fronts: [front] };
    expect(hitTest(scene, { east: 1500, north: 3000 }, 8334)).toEqual({ kind: 'front', front });
    expect(hitTest(scene, { east: 1600, north: 3000 }, 8334)).toBeNull();
    expect(hitTest(scene, { east: 1000, north: 8400 }, 8334)).toBeNull();
  });
});

describe('the course to meet it', () => {
  test('meets a system crossing the boat’s path at the boat’s speed, within 0.1 NM', () => {
    const boat = { east: 0, north: 0 };
    const speed = 3;
    const from = { east: -3000, north: 3000 };
    const target = moving(from, 3, 0);
    const c = courseToMeet(boat, speed, target, 90 * MINUTE);
    expect(c?.faster).toBe(false);
    if (c === null) {
      return;
    }
    // Sail it: where the boat is when it gets there, and the system then.
    const run = (speed * c.at) / SECOND;
    const there = { east: run * Math.sin(c.heading), north: run * Math.cos(c.heading) };
    const sys = target(c.at);
    expect(Math.hypot(there.east - sys.east, there.north - sys.north)).toBeLessThan(0.1 * NM);
    // Equal speeds from (−3000, 3000): it meets at (0, 3000), due north.
    expect(c.heading).toBeCloseTo(0, 3);
    expect(c.at / MINUTE).toBeCloseTo(3000 / 3 / 60, 1);
  });

  test('a storm running away faster than the boat: the heading to its path ahead', () => {
    const boat = { east: 0, north: 0 };
    const target = moving({ east: 500, north: 2000 }, 0, 8);
    const c = courseToMeet(boat, 3, target, 90 * MINUTE);
    expect(c?.faster).toBe(true);
    const ahead = target(PATH_AHEAD);
    expect(c?.east).toBeCloseTo(ahead.east, 6);
    expect(c?.north).toBeCloseTo(ahead.north, 6);
    expect(c?.heading).toBeCloseTo(Math.atan2(ahead.east, ahead.north), 9);
    // A boat at a standstill catches nothing.
    expect(courseToMeet(boat, 0, moving({ east: 0, north: 500 }, 0, 0), 90 * MINUTE)?.faster).toBe(
      true,
    );
  });

  test('one yet to be born is met no sooner than its birth', () => {
    const boat = { east: 0, north: 0 };
    const sitting = moving({ east: 0, north: 600 }, 0, 0);
    const c = courseToMeet(boat, 3, (t) => (t < 20 * MINUTE ? null : sitting(t)), 90 * MINUTE);
    expect(c?.faster).toBe(false);
    expect(c?.at).toBeGreaterThanOrEqual(20 * MINUTE - MINUTE);
    expect(c?.heading).toBeCloseTo(0, 9);
    expect(courseToMeet(boat, 3, () => null, 90 * MINUTE)).toBeNull();
  });

  test('a front coming down on the boat: straight at its line', () => {
    // A line 2 km west, moving east at 4 m/s; the boat at 2 m/s.
    const f: SceneFront = { sin: 1, cos: 0, line: -2000, warm: true, speed: 4 };
    const boat = { east: 0, north: 500 };
    const c = courseToMeet(boat, 2, frontTarget(f, boat, 8000), 90 * MINUTE);
    expect(c?.faster).toBe(false);
    expect(c?.heading).toBeCloseTo(-Math.PI / 2, 6);
    // They close at 6 m/s over 2 km.
    expect(c?.at ?? 0).toBeCloseTo((2000 / 6) * SECOND, -1);
  });
});

describe('the box’s words', () => {
  test('its wind and force, where it is, how it moves, how long it lives and the course', () => {
    const box = boxWords({
      name: 'Storm',
      wind: 45 * KNOT,
      gust: 58 * KNOT,
      boat: { east: 0, north: 0 },
      at: { east: -1852 * 2, north: -1852 * 2 },
      heading: Math.PI / 4,
      speed: 5 * KNOT,
      lives: 40 * MINUTE,
      course: {
        heading: (245 * Math.PI) / 180,
        at: 25 * MINUTE,
        east: -100,
        north: -50,
        faster: false,
      },
      now: 1000,
    });
    expect(box).toEqual({
      name: 'Storm',
      wind: '45 kn, gusts 58 kn · Severe gale 9',
      where: '225° 2.8 NM from you',
      motion: 'NE 5 kn',
      life: '40 min more',
      course: 'Course to meet it 245°, in 25 min',
      steer: (245 * Math.PI) / 180,
      to: { east: -100, north: -50, at: 1000 + 25 * MINUTE },
    });
    const away = boxWords({
      name: 'Squall line',
      wind: 30 * KNOT,
      gust: 38 * KNOT,
      boat: { east: 0, north: 0 },
      at: { east: 0, north: 1000 },
      heading: 0,
      speed: 0,
      lives: null,
      course: { heading: 0, at: PATH_AHEAD, east: 0, north: 4000, faster: true },
      now: 0,
    });
    expect([away.wind, away.motion, away.life, away.course]).toEqual([
      '30 kn, gusts 38 kn · F7',
      'Still',
      '',
      'It is faster than you. Its path ahead: 000°',
    ]);
    expect(forceText(20 * KNOT)).toBe('F5');
    expect(minutesText(80 * MINUTE)).toBe('1 h 20 min');
    expect(minutesText(120 * MINUTE)).toBe('2 h');
  });
});
