// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type {
  CalibrationPage,
  ForecastFront,
  ForecastPage,
  ForecastSpell,
  ForecastSystem,
  GaleWarning,
} from './api';
import {
  areaBits,
  areaPoints,
  calibrationRows,
  frontAt,
  outerTangents,
  riskWords,
  spellAt,
  stepOf,
  systemAt,
  warningSpan,
} from './forecast';

/** Ticks a second, and a step of ten minutes. */
const TPS = 30;
const STEP = 10 * 60 * TPS;

function page(issue: number, steps: number): ForecastPage {
  return {
    at: issue,
    issue,
    issued: true,
    step: STEP,
    steps,
    lip: 8334,
    systems: [],
    fronts: [],
    spells: [],
    gale: null,
    galeGrid: 463,
    galeSide: 35,
  };
}

function spell(begin: number, risk: string, marks: string[]): ForecastSpell {
  return {
    begin,
    regime: 0,
    id: 'unsettled',
    from: 240,
    knots: 14,
    front: false,
    shifts: 10,
    risk,
    fog: false,
    marks,
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

  test('a system between its steps, and where it is not alive', () => {
    const s: ForecastSystem = {
      slot: 3,
      kind: 1,
      id: 'storm',
      forming: false,
      crosses: 0,
      steps: [
        [0, 0, 0, 1],
        [100, 200, 50, 1],
        [200, 400, 100, 0.5],
        [0, 0, 0, 0],
      ],
    };
    expect(systemAt(s, 0)).toEqual([0, 0, 0]);
    expect(systemAt(s, 0.5)).toEqual([50, 100, 25]);
    expect(systemAt(s, 1.5)).toEqual([150, 300, 75]);
    // Gone after its third step: where it last was, then nowhere.
    expect(systemAt(s, 2.5)).toEqual([200, 400, 100]);
    expect(systemAt(s, 3)).toBeNull();
  });

  test('a low forming shows from the step it is born at', () => {
    const s: ForecastSystem = {
      slot: 4,
      kind: 1,
      id: 'storm',
      forming: true,
      crosses: 0,
      steps: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [500, 500, 870, 0.2],
      ],
    };
    expect(systemAt(s, 0.5)).toBeNull();
    expect(systemAt(s, 1.25)).toBeNull();
    expect(systemAt(s, 1.75)).toEqual([500, 500, 870]);
    expect(systemAt(s, 2)).toEqual([500, 500, 870]);
  });

  test("a front's line and band between its steps", () => {
    const f: ForecastFront = {
      toward: 90,
      begin: 0,
      cross: 6 * STEP,
      lines: [null, [-4000, 100], [-2000, 300], null],
    };
    expect(frontAt(f, 0.25)).toBeNull();
    expect(frontAt(f, 0.75)).toEqual([-4000, 100]);
    expect(frontAt(f, 1.5)).toEqual([-3000, 200]);
    expect(frontAt(f, 2.5)).toEqual([-2000, 300]);
    expect(frontAt(f, 3)).toBeNull();
  });
});

describe("the forecast's risk", () => {
  test('the spell in force, and its risk in words', () => {
    const spells = [spell(-500, 'showers', ['showers']), spell(2000, 'squally showers', [])];
    expect(spellAt(spells, 0)?.begin).toBe(-500);
    expect(spellAt(spells, 2000)?.begin).toBe(2000);
    expect(spellAt([spell(5000, 'fair', [])], 0)?.begin).toBe(5000);
    expect(spellAt([], 0)).toBeNull();
    expect(riskWords(spells[0] as ForecastSpell)).toBe('showers (showers)');
    expect(riskWords(spells[1] as ForecastSpell)).toBe('squally showers');
    expect(riskWords(spell(0, '', ['calms']))).toBe('');
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

describe("a cone's edges", () => {
  test('two circles of one size: lines along their sides', () => {
    const t = outerTangents([0, 0, 10], [100, 0, 10]);
    expect(t).toHaveLength(2);
    const ys = t
      .map(([p, q]) => [p[1], q[1]].map((y) => Math.round(y)))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    expect(ys).toEqual([
      [-10, -10],
      [10, 10],
    ]);
  });

  test('each edge touches both circles at a right angle to its radius', () => {
    const a: [number, number, number] = [10, 20, 5];
    const b: [number, number, number] = [80, -40, 30];
    for (const [p, q] of outerTangents(a, b)) {
      expect(Math.hypot(p[0] - a[0], p[1] - a[1])).toBeCloseTo(a[2]);
      expect(Math.hypot(q[0] - b[0], q[1] - b[1])).toBeCloseTo(b[2]);
      const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
      expect(dx * (p[0] - a[0]) + dy * (p[1] - a[1])).toBeCloseTo(0);
      expect(dx * (q[0] - b[0]) + dy * (q[1] - b[1])).toBeCloseTo(0);
    }
  });

  test('none where one circle holds the other', () => {
    expect(outerTangents([0, 0, 50], [10, 0, 5])).toEqual([]);
    expect(outerTangents([0, 0, 0], [0, 0, 0])).toEqual([]);
  });
});

describe("the forecast's calibration", () => {
  test('a row a kind, a share and its cases a lead, none for no cases', () => {
    const c: CalibrationPage = {
      now: 0,
      from: 0,
      next: 0,
      issues: 144,
      leads: [10, 20],
      alive: [
        [80, 100],
        [7, 9],
      ],
      forming: [
        [0, 0],
        [1, 1],
      ],
      fronts: [
        [3, 4],
        [0, 2],
      ],
    };
    const rows = calibrationRows(c);
    expect(rows.map((r) => r.name)).toEqual([
      'Systems alive at the issue',
      'Lows forming',
      "Fronts' lines",
    ]);
    expect(rows[0]?.cells).toEqual([
      { share: '80%', cases: 100 },
      { share: '78%', cases: 9 },
    ]);
    expect(rows[1]?.cells[0]).toEqual({ share: '—', cases: 0 });
    expect(rows[2]?.cells.map((x) => x.share)).toEqual(['75%', '0%']);
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
