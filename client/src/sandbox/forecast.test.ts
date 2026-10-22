// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's forecast: its gale warning from the scan, as the server's
// weather.GaleOf finds it, and its key carried from issue to issue while
// the gale blows on, so it is warned of once.

import { describe, expect, test } from 'vitest';
import { Forecasts } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { galeOf, SandboxForecast } from './forecast';

const G = RECORDS.galeStep;
const H = RECORDS.forecastHead;
const EVERY = 18000;

/** A scan of ten steps with a gale at the steps given: [step, mean, gust, force, east, north]. */
function scanOf(gales: readonly (readonly number[])[]): Float64Array {
  const scan = new Float64Array(10 * SIZES.galeStep);
  for (const [k = 0, mean = 0, gust = 0, force = 0, east = 0, north = 0] of gales) {
    const o = k * SIZES.galeStep;
    scan[o + G.points] = 3;
    scan[o + G.mean] = mean;
    scan[o + G.gust] = gust;
    scan[o + G.force] = force;
    scan[o + G.from] = 0.5 * k;
    scan[o + G.east] = east;
    scan[o + G.north] = north;
  }
  return scan;
}

describe('the sandbox’s forecast', () => {
  test('a gale warning: its steps, the first, the most force, its first wind and its strongest point', () => {
    const near = { subject: 'place' as const, number: 7 };
    const g = galeOf(
      scanOf([
        [3, 18, 20, 8, 100.4, 200],
        [4, 22, 26, 9, 300, 400.6],
        [6, 19, 21, 8, 500, 600],
      ]),
      10,
      42,
      () => near,
    );
    expect(g).toEqual({
      key: 42,
      steps: (1 << 3) | (1 << 4) | (1 << 6),
      first: 3,
      force: 9,
      from: 1.5,
      east: 300,
      north: 401,
      place: near,
    });
    expect(galeOf(scanOf([]), 10, 42, () => null)).toBeNull();
    // A gale past the issue's steps is not this issue's.
    expect(galeOf(scanOf([[8, 18, 20, 8, 0, 0]]), 8, 42, () => null)).toBeNull();
  });

  test('the gale’s key is carried while it blows on, and a new one is keyed by its issue', () => {
    let scan = scanOf([[2, 18, 20, 8, 0, 0]]);
    const head = new Float64Array(SIZES.forecastHead);
    head[H.steps] = 10;
    const physics = {
      forecastMake: (issue: number) => {
        head[H.issue] = issue;
      },
      forecast: { head, spells: new Float64Array(0), systems: new Float64Array(0) },
      galeScan: () => scan,
    } as unknown as Physics;
    let now = EVERY;
    const forecasts = new Forecasts();
    const s = new SandboxForecast(
      { physics, tick: () => now, spells: () => [] },
      forecasts,
      EVERY,
      () => null,
    );
    const keys: (number | null)[] = [];
    s.onIssue = (f) => keys.push(f.gale?.key ?? null);
    s.issueAt(EVERY);
    now = 2 * EVERY;
    s.issueAt(2 * EVERY);
    scan = scanOf([]);
    now = 3 * EVERY;
    s.issueAt(3 * EVERY);
    scan = scanOf([[5, 18, 20, 8, 0, 0]]);
    now = 4 * EVERY;
    s.issueAt(4 * EVERY);
    expect(keys).toEqual([EVERY, EVERY, null, 4 * EVERY]);
  });
});
