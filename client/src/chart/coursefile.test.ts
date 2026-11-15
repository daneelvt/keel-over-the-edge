// SPDX-License-Identifier: AGPL-3.0-only

// The page's course is the server's: for every case of
// internal/chart/testdata/courses.json, the same point aimed at, the same
// distance and bearing, and reached alike.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { type Course, courseAim, reached } from './course';
import { entry, storeWith } from './coursesamples';
import { bearingText } from './store';

interface CoursesFile {
  cases: {
    name: string;
    east: number;
    north: number;
    pointEast: number;
    pointNorth: number;
    bounds: [number, number, number, number] | null;
    aimEast: number;
    aimNorth: number;
    distance: number;
    bearing: string;
    reached: boolean;
  }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/chart/testdata/courses.json', import.meta.url), 'utf8'),
) as CoursesFile;

describe('the course', () => {
  test('aims and is reached as the server reckons it', () => {
    expect(file.cases.length).toBeGreaterThan(8);
    for (const c of file.cases) {
      // A point is a pin; with bounds, a charted island.
      const store = storeWith(
        c.bounds === null
          ? []
          : [
              entry({
                subject: 'island',
                number: 1,
                east: c.pointEast,
                north: c.pointNorth,
                bounds: c.bounds,
              }),
            ],
      );
      const course: Course =
        c.bounds === null
          ? { kind: 'pin', east: c.pointEast, north: c.pointNorth }
          : { kind: 'entry', subject: 'island', number: 1 };
      const a = courseAim(course, store, c.east, c.north);
      expect(a, c.name).not.toBeNull();
      if (a === null) {
        continue;
      }
      expect(a.east, c.name).toBe(c.aimEast);
      expect(a.north, c.name).toBe(c.aimNorth);
      expect(Math.abs(a.distance - c.distance), c.name).toBeLessThan(1e-9);
      expect(bearingText(a.bearing), c.name).toBe(c.bearing);
      expect(reached(a), c.name).toBe(c.reached);
    }
  });
});
