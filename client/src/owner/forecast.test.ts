// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type {
  BusyFigures,
  ForecastFront,
  ForecastPage,
  ForecastSpell,
  ForecastSystem,
  GaleWarning,
} from './api';
import {
  areaBits,
  areaPoints,
  busyRows,
  frontLineAt,
  spellAt,
  stepOf,
  trackAt,
  warningSpan,
} from './forecast';

/** Ticks a second, a minute, and a step of ten minutes. */
const TPS = 30;
const MINUTE = 60 * TPS;
const STEP = 10 * MINUTE;

function page(issue: number, steps: number): ForecastPage {
  return {
    at: issue,
    issue,
    issued: true,
    step: STEP,
    steps,
    until: issue + 10 * STEP,
    every: MINUTE,
    lip: 8334,
    reach: 9000,
    systems: [],
    fronts: [],
    spells: [],
    gale: null,
    galeGrid: 463,
    galeSide: 35,
  };
}

function spell(begin: number): ForecastSpell {
  return {
    begin,
    regime: 0,
    id: 'unsettled',
    from: 240,
    knots: 14,
    front: false,
    warm: false,
    shifts: 10,
  };
}

describe("the forecast's steps", () => {
  test('the tick shown as a step, from the issue to the last', () => {
    const f = page(1000, 10);
    expect(stepOf(f, 1000)).toBe(0);
    expect(stepOf(f, 1000 + STEP / 2)).toBe(0.5);
    expect(stepOf(f, 1000 + 3 * STEP)).toBe(3);
    expect(stepOf(f, 0)).toBe(0);
    expect(stepOf(f, 1000 + 40 * STEP)).toBe(9);
  });
});

describe("a system's track", () => {
  const s: ForecastSystem = {
    slot: 3,
    kind: 1,
    id: 'x',
    seed: 7,
    born: 900,
    gone: 1000 + 3 * MINUTE,
    size: 900,
    length: 0,
    from: 1000,
    track: [
      [0, 0, 0.2, 350],
      [100, 200, 0.6, 10],
      [200, 400, 1, 30],
    ],
  };

  test('between its points, a minute apart, its heading the shorter way round', () => {
    expect(trackAt(s, 1000, MINUTE)).toEqual([0, 0, 0.2, 350]);
    const half = trackAt(s, 1000 + MINUTE / 2, MINUTE);
    expect(half?.[0]).toBeCloseTo(50);
    expect(half?.[1]).toBeCloseTo(100);
    expect(half?.[2]).toBeCloseTo(0.4);
    expect(half?.[3]).toBeCloseTo(0);
    expect(trackAt(s, 1000 + 1.5 * MINUTE, MINUTE)?.[3]).toBeCloseTo(20);
    expect(trackAt(s, 1000 + 2 * MINUTE, MINUTE)).toEqual([200, 400, 1, 30]);
  });

  test('nowhere before its first point or after its last', () => {
    expect(trackAt(s, 999, MINUTE)).toBeNull();
    expect(trackAt(s, 1000 + 2 * MINUTE + 1, MINUTE)).toBeNull();
    expect(trackAt({ ...s, track: [] }, 1000, MINUTE)).toBeNull();
  });
});

describe("a front's line", () => {
  const f: ForecastFront = { toward: 90, begin: 0, cross: 6 * STEP, warm: true };

  test('crosses the reach at an even speed, from one side to the other', () => {
    expect(frontLineAt(f, 0, 9000)).toBe(-9000);
    expect(frontLineAt(f, 3 * STEP, 9000)).toBe(0);
    expect(frontLineAt(f, 6 * STEP, 9000)).toBe(9000);
  });

  test('nowhere before it enters or after it leaves', () => {
    expect(frontLineAt(f, -1, 9000)).toBeNull();
    expect(frontLineAt(f, 6 * STEP + 1, 9000)).toBeNull();
    expect(frontLineAt({ ...f, cross: 0 }, 0, 9000)).toBeNull();
  });
});

describe("the forecast's spells", () => {
  test('the spell in force', () => {
    const spells = [spell(-500), spell(2000)];
    expect(spellAt(spells, 0)?.begin).toBe(-500);
    expect(spellAt(spells, 2000)?.begin).toBe(2000);
    expect(spellAt([spell(5000)], 0)?.begin).toBe(5000);
    expect(spellAt([], 0)).toBeNull();
  });
});

describe("a gale's area", () => {
  test('its bits, point n the bit n mod 8 of byte n / 8', () => {
    // Points 0, 3 and 9 of a grid 4 a side: bytes 0b00001001, 0b00000010.
    const area = btoa(String.fromCharCode(0b00001001, 0b00000010));
    expect([...areaBits(area)]).toEqual([9, 2]);
    expect(areaBits('').length).toBe(0);
    // The grid's centre is between its middle points: (i − 1.5) 100, (j − 1.5) 100.
    expect(areaPoints(area, 4, 100)).toEqual([
      [-150, -150],
      [150, -150],
      [-50, 50],
    ]);
    expect(areaPoints('', 4, 100)).toEqual([]);
  });
});

describe('the busy weather', () => {
  const figures = (minutes: number, systems: number): BusyFigures => ({
    minutes,
    empty: 0,
    rain: 98.75,
    lows: 89,
    storms: 44.4,
    lines: 52.5,
    systems,
    regimes: [
      { id: 'settled', minutes: minutes / 2, empty: 0, systems: 3.17 },
      { id: 'stormy', minutes: 0, empty: 0, systems: 0 },
    ],
  });

  test('a row a share and the systems on average, so far and over the week, and by regime', () => {
    const rows = busyRows(figures(120, 5.69), figures(9960, 6));
    expect(rows.map((r) => r.name)).toEqual([
      'Nothing on the disk',
      'Rain somewhere',
      'A storm or a low',
      'A storm',
      'A front or a trough',
      'Systems on the disk, on average',
      'Systems on average, settled',
      'Systems on average, stormy',
    ]);
    expect(rows[1]).toEqual({ name: 'Rain somewhere', soFar: '98.8%', week: '98.8%' });
    expect(rows[5]).toEqual({ name: 'Systems on the disk, on average', soFar: '5.7', week: '6.0' });
    // A regime with no minutes yet has no figures.
    expect(rows[7]).toEqual({ name: 'Systems on average, stormy', soFar: '—', week: '—' });
  });

  test('none so far before the opening', () => {
    const rows = busyRows(figures(0, 0), figures(9960, 6));
    expect(rows[0]?.soFar).toBe('—');
    expect(rows[0]?.week).toBe('0.0%');
  });
});

describe('a gale warning in time', () => {
  test('from its first issue to the next without it, or since while it is in force', () => {
    const epoch = Date.UTC(2026, 9, 18, 22, 0);
    const w: GaleWarning = {
      key: 3600 * TPS,
      last: 3600 * TPS + 2 * STEP,
      inForce: false,
      force: 8,
      words: 'Westerly gale 8 imminent, north-west of Gannet Holm',
      from: 270,
      east: 0,
      north: 0,
    };
    const span = warningSpan(w, STEP, epoch, TPS);
    expect(span).toMatch(/ to /);
    expect(span.split(' to ')).toHaveLength(2);
    expect(warningSpan({ ...w, inForce: true }, STEP, epoch, TPS)).toMatch(/^since /);
  });
});
