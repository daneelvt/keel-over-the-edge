// SPDX-License-Identifier: AGPL-3.0-only

// The chart's list is the server's: for every boat of
// internal/chart/testdata/list.json, the same groups, the same entries in
// the same order, and each written alike.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ChartEntry, ChartSubject } from '../net/messages';
import { chartList } from './store';

interface ListFile {
  cases: {
    name: string;
    east: number;
    north: number;
    entries: { subject: ChartSubject; east: number; north: number }[];
    groups: { title: string; lines: { entry: number; distance: number; where: string }[] }[];
  }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/chart/testdata/list.json', import.meta.url), 'utf8'),
) as ListFile;

function entry(
  number: number,
  e: { subject: ChartSubject; east: number; north: number },
): ChartEntry {
  return {
    subject: e.subject,
    number,
    sort: 0,
    name: '',
    east: e.east,
    north: e.north,
    by: '',
    ai: false,
    at: 0,
    worth: 1,
    island: -1,
    group: '',
    bounds: null,
    highest: 0,
    zone: 0,
    className: '',
    model: '',
    light: -1,
    character: 0,
    focal: 0,
    range: 0,
    ship: '',
    sunk: false,
    withSubject: null,
    withNumber: 0,
  };
}

describe('the chart’s list', () => {
  test('is the server’s, entry for entry and word for word', () => {
    expect(file.cases.length).toBeGreaterThan(2);
    for (const c of file.cases) {
      const got = chartList(
        c.entries.map((e, i) => entry(i, e)),
        c.east,
        c.north,
      );
      expect(
        got.map((g) => g.title),
        c.name,
      ).toEqual(c.groups.map((g) => g.title));
      got.forEach((g, i) => {
        const want = c.groups[i]?.lines ?? [];
        expect(
          g.lines.map((l) => [l.entry.number, l.where]),
          `${c.name}: ${g.title}`,
        ).toEqual(want.map((l) => [l.entry, l.where]));
        g.lines.forEach((l, k) => {
          expect(Math.abs(l.distance - (want[k]?.distance ?? Number.NaN))).toBeLessThan(1e-9);
        });
      });
    }
  });
});
