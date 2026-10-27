// SPDX-License-Identifier: AGPL-3.0-only

// A gale warning's notice is raised for a gale forecast near the boat, at
// any minute still to come, or across the course steered for a system; a
// gale 3 NM off raises none, and a warning is told of once.

import { describe, expect, test } from 'vitest';
import type { ForecastTold, GaleTold } from '../net/messages';
import type { Fields } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Notices } from '../ui/notices';
import { GALE_NEAR, GaleNotices, type GalePoint, galeNear, galePoints } from './gales';
import type { ChartStore } from './store';

const H = RECORDS.forecastHead;
const MINUTE = 1800;
const NM = 1852;

/** An issue at a tick, knowing its systems for 100 minutes, with a gale warning of a key. */
function issue(tick: number, key: number): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = tick;
  head[H.steps] = 10;
  head[H.step] = 10 * MINUTE;
  head[H.until] = tick + 100 * MINUTE;
  const gale: GaleTold = {
    key,
    steps: 1,
    first: 0,
    force: 8,
    from: 0,
    east: 0,
    north: 0,
    place: null,
  };
  return { head, spells: [], systems: [], gale };
}

/** A gale grid of three a side, 1 NM apart, its middle in a gale from a tick on. */
function fields(from: number): Fields {
  return {
    physics: { galeSide: () => 3 },
    galeAt: (_f: ForecastTold, tick: number) => ({
      on: Uint8Array.from([0, 0, 0, 0, tick >= from ? 1 : 0, 0, 0, 0, 0]),
      gale: new Float64Array(SIZES.galeStep),
    }),
  } as unknown as Fields;
}

describe('a gale near the boat', () => {
  const points: GalePoint[] = [{ east: 3000, north: 0, tick: 60 * MINUTE }];

  test('within 1.5 NM of the boat, at a minute still to come', () => {
    expect(galeNear(points, 0, { east: 3000 - GALE_NEAR + 1, north: 0 }, null, 463)).toBe(true);
    expect(galeNear(points, 0, { east: 3000 - 3 * NM, north: 0 }, null, 463)).toBe(false);
    // Blown through: no longer near.
    expect(galeNear(points, 70 * MINUTE, { east: 3000, north: 0 }, null, 463)).toBe(false);
  });

  test('across the course steered for a system', () => {
    const boat = { east: 3000, north: -3 * NM };
    expect(galeNear(points, 0, boat, null, 463)).toBe(false);
    expect(galeNear(points, 0, boat, { east: 3200, north: 3 * NM }, 463)).toBe(true);
    expect(galeNear(points, 0, boat, { east: 6000, north: 3 * NM }, 463)).toBe(false);
  });

  test('the forecast’s gale at each minute of its reach', () => {
    const p = galePoints(fields(30 * MINUTE), issue(0, 1), NM);
    expect(p[0]).toEqual({ east: 0, north: 0, tick: 30 * MINUTE });
    expect(p.length).toBe(71);
  });
});

describe('the gale warning’s notice', () => {
  const raised: string[] = [];
  const notices = {
    raise: (on: string, fill: Record<string, string>) => raised.push(`${on}: ${fill.wind}`),
  } as unknown as Notices;
  const store = { get: () => undefined } as unknown as ChartStore;

  test('raised once for a gale forecast near the boat, not for one 3 NM off', () => {
    raised.length = 0;
    let boat = { east: 3 * NM, north: 0 };
    const g = new GaleNotices(store, notices, {
      fields: () => fields(20 * MINUTE),
      made: async () => fields(20 * MINUTE),
      tick: () => 0,
      boat: () => boat,
      course: () => null,
    });
    g.issued(issue(0, 7));
    expect(raised).toEqual([]);
    // The boat sails within reach of it: the next look raises it, once.
    boat = { east: NM, north: 0 };
    g.check();
    g.issued(issue(10 * MINUTE, 7));
    g.check();
    expect(raised).toEqual(['gale-warned: northerly gale 8']);
  });
});
