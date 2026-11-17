// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  alone,
  bySize,
  COUNT_NAMES,
  type CountsRow,
  compare,
  ladderTables,
  measured,
  measures,
  median,
  type Results,
  range,
  report,
  shares,
  table,
} from './framestats';

const meta = (commit: string): Results['meta'] => ({
  date: '2026-11-18',
  commit,
  chrome: '157',
  backend: 'webgpu',
  dpr: { gpu: 2 },
  runs: 3,
  args: [],
});

function counts(writes: number): CountsRow['counts'] {
  const c = {} as CountsRow['counts'];
  for (const n of COUNT_NAMES) {
    c[n] = { median: n === 'writes' ? writes : n === 'bytes' ? writes * 1024 : 1, max: 2 };
  }
  return c;
}

const before: Results = {
  meta: meta('aaaa'),
  gpu: {
    width: 5120,
    height: 2880,
    rows: [
      { index: 0, name: 'high × 1', ...measured([8.8, 8.6, 9.1]), mean: measured([8.7, 8.7, 8.7]) },
    ],
  },
  parts: {
    width: 5120,
    height: 2880,
    tiers: [
      {
        tier: 'high',
        rung: 'high × 1',
        steps: [
          { name: 'Everything', ...measured([9.5]) },
          { name: 'Antialiasing off', ...measured([8.4]) },
          { name: 'Land hidden', ...measured([8.5]) },
        ],
      },
    ],
  },
  counts: {
    width: 1366,
    height: 768,
    rows: [
      {
        tier: 'high',
        rung: 'high × 1',
        frames: 60,
        counts: counts(800),
        largest: [
          { label: 'a', owner: 'sailor', size: 5440, perFrame: 1, bytesPerFrame: 5440 },
          { label: 'b', owner: 'hull', size: 5440, perFrame: 2, bytesPerFrame: 10880 },
          { label: 'c', owner: 'clouds', size: 65536, perFrame: 1, bytesPerFrame: 65536 },
        ],
        passList: [{ label: 'canvas ← Scene', perFrame: 1 }],
      },
    ],
  },
};

describe('the numbers', () => {
  it('takes the median of the finite values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([1, Number.NaN, 3])).toBe(2);
    expect(median([])).toBeNaN();
  });

  it('gives the range over runs', () => {
    expect(range(measured([8.8, 8.6, 9.1]))).toBe('8.6–9.1');
    expect(range(measured([2, 2]))).toBe('2.0');
  });

  it("gives each step's share as what hiding its part saved", () => {
    const s = shares(before.parts?.tiers[0]?.steps ?? []);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBeCloseTo(1.1);
    expect(s[2]).toBeCloseTo(-0.1);
  });

  it("gives each step's share alone as what leaving its part out saved from the whole", () => {
    const s = alone([
      { name: 'Everything', ...measured([9.5]) },
      { name: 'Sea: foam left out', ...measured([8.5]) },
      { name: 'Sea: glints left out', ...measured([9.3]) },
    ]);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBeCloseTo(1);
    expect(s[2]).toBeCloseTo(0.2);
  });

  it('sums the writes by their size, with the owner that wrote it most', () => {
    const rows = bySize(before.counts?.rows[0]?.largest ?? []);
    expect(rows.map((r) => r.size)).toEqual([65536, 5440]);
    expect(rows[1]).toMatchObject({
      perFrame: 3,
      bytesPerFrame: 3 * 5440,
      owner: 'hull, and 1 more',
    });
  });
});

describe('the tables', () => {
  it('writes a Markdown table, escaping pipes', () => {
    expect(table(['A', 'B'], [[1, 'x|y']])).toBe('| A | B |\n|---|---|\n| 1 | x\\|y |\n');
  });

  it('marks a rung that draws more pixels than the one above it', () => {
    const md = ladderTables({
      dprs: [1, 2],
      ladders: [
        {
          top: 'high',
          rows: [
            { index: 0, name: 'a', ratios: [0.7, 1.4] },
            { index: 1, name: 'b', ratios: [1, 1.4] },
          ],
        },
      ],
    });
    expect(md).toContain('| 1 | b | 1.000 ↑ | 1.400 |');
    expect(md).toContain('| 0 | a | 0.700 | 1.400 |');
  });

  it('prints every section measured', () => {
    const md = report(before);
    expect(md).toContain('fixed 5120 × 2880');
    expect(md).toContain('| 0 | high × 1 | 8.8 | 8.6–9.1 | 8.70 |');
    expect(md).toContain('| Antialiasing off | 8.4 | 8.4 | 1.1 |');
    expect(md).toContain('| Land hidden | 8.5 | 8.5 | none |');
    expect(md).toContain('| high × 1 | 800 (2) |');
    expect(md).toContain('| 5,440 | 3.0 | 15.9 | hull, and 1 more |');
  });

  it('sets two sets of results side by side', () => {
    const after: Results = {
      ...before,
      meta: meta('bbbb'),
      counts: {
        width: 1366,
        height: 768,
        rows: [{ ...(before.counts?.rows[0] as CountsRow), counts: counts(200) }],
      },
    };
    expect(measures(after).get('counts/high: writes')?.value).toBe(200);
    const md = compare(before, after);
    expect(md).toContain('Before: aaaa');
    expect(md).toContain('| high: writes | 800 | 200 | −75% |');
    expect(md).toContain('| high × 1 (rung 0) | 8.8 | 8.8 | +0% |');
  });
});
