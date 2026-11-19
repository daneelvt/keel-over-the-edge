// SPDX-License-Identifier: AGPL-3.0-only

// A course drawn small: a buoy course laid square to a wind from the top
// of its box, the windward mark above the start line and the wind's arrow
// pointing down the course; an island course's way fitted to the box with
// its proportions kept and north up.

import { describe, expect, test } from 'vitest';
import type { CourseTold } from './raceapi';
import { courseShape, fitBox, pathData, shapeText } from './racecourse';

const triangle: CourseTold = {
  id: 'buoy:triangle:short',
  kind: 'buoy',
  shape: 'triangle',
  long: false,
  name: 'Short triangle',
};

describe('a buoy course', () => {
  test('a triangle: the windward mark at the top, above the middle of the line; a wing mark to one side', () => {
    const s = courseShape(triangle, 100, 100, 10);
    const [windward, wing, leeward] = s.marks;
    expect(windward?.y).toBeLessThan(30);
    expect(windward?.x).toBeCloseTo(50, 5);
    expect(s.line).not.toBeNull();
    const line = s.line ?? [];
    expect(line[0]?.y).toBeGreaterThan(80);
    expect(((line[0]?.x ?? 0) + (line[1]?.x ?? 0)) / 2).toBeCloseTo(50, 5);
    expect(wing?.x).toBeLessThan(30);
    expect(leeward?.y).toBeGreaterThan(windward?.y ?? 0);
    // From the line, up, and back to it.
    expect(s.legs[0]).toEqual(s.legs.at(-1));
  });

  test('the wind blows from the top: its arrow points down', () => {
    const s = courseShape(triangle, 100, 100);
    expect(s.wind).not.toBeNull();
    const [from, to] = s.wind ?? [];
    expect(to?.y).toBeGreaterThan(from?.y ?? 0);
    expect(to?.x).toBeCloseTo(from?.x ?? 0, 5);
  });

  test('a long course sails more legs than its short', () => {
    const short = courseShape(triangle, 100, 100);
    const long = courseShape({ ...triangle, long: true }, 100, 100);
    expect(long.legs.length).toBeGreaterThan(short.legs.length);
    const wl = courseShape({ ...triangle, shape: 'windward-leeward' }, 100, 100);
    expect(wl.marks).toHaveLength(3);
    expect(shapeText({ ...triangle, shape: 'windward-leeward', long: true })).toBe(
      'Windward–leeward, long',
    );
  });

  test('a wide box keeps the course square, centred', () => {
    const s = courseShape(triangle, 200, 100, 0);
    const xs = s.legs.map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...xs)).toBeLessThanOrEqual(150);
  });
});

describe('an island course', () => {
  const island: CourseTold = {
    id: 'island:3',
    kind: 'island',
    name: 'Round Gannet Holm',
    // A way 4 km east and 1 km north: wide, from the south-west.
    way: [0, 0, 4000, 0, 4000, 1000, 0, 0],
  };

  test('its way fits the box, its proportions kept, north up', () => {
    const s = courseShape(island, 100, 100, 10);
    for (const p of s.legs) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(90 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(90 + 1e-9);
    }
    const [a, b, c] = s.legs;
    // 4 km wide fills the 80 px; 1 km north is 20 px up the box.
    expect((b?.x ?? 0) - (a?.x ?? 0)).toBeCloseTo(80, 5);
    expect((b?.y ?? 0) - (c?.y ?? 0)).toBeCloseTo(20, 5);
    expect(s.marks).toEqual([a]);
    expect(s.wind).toBeNull();
    expect(s.line).toBeNull();
  });

  test('no way draws nothing; one point sits in the middle', () => {
    expect(courseShape({ ...island, way: [] }, 100, 100).legs).toEqual([]);
    expect(fitBox([{ x: 5, y: 5 }], 100, 60, 4)).toEqual([{ x: 50, y: 30 }]);
  });

  test('its path, as an SVG draws it', () => {
    expect(
      pathData([
        { x: 1, y: 2 },
        { x: 3.25, y: 4 },
      ]),
    ).toBe('M1.0 2.0 L3.3 4.0');
  });
});
