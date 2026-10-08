// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { quantise, quantiseHelm, quantiseSheet, RESOLUTION } from './quantise';

describe('quantise', () => {
  test('is exact at both ends of each range, and clamps beyond them', () => {
    expect(quantiseHelm(-1)).toBe(-1);
    expect(quantiseHelm(1)).toBe(1);
    expect(quantiseHelm(-7)).toBe(-1);
    expect(quantiseHelm(2)).toBe(1);
    expect(quantiseSheet(0)).toBe(0);
    expect(quantiseSheet(1)).toBe(1);
    expect(quantiseSheet(-0.1)).toBe(0);
    expect(quantiseSheet(1.5)).toBe(1);
  });

  test('is idempotent', () => {
    for (let i = 0; i < 5000; i++) {
      const v = Math.sin(i * 12.9898) * 1.2;
      const h = quantiseHelm(v);
      expect(quantiseHelm(h)).toBe(h);
      const s = quantiseSheet(v);
      expect(quantiseSheet(s)).toBe(s);
    }
  });

  test('rounds to 1/1024 of the range', () => {
    expect(RESOLUTION).toBe(1024);
    expect(quantiseSheet(0.5 + 0.4 / 1024)).toBe(0.5);
    expect(quantiseSheet(0.5 + 0.6 / 1024)).toBe(0.5 + 1 / 1024);
    expect(quantiseHelm(0.0009)).toBe(0);
    expect(quantiseHelm(0.0011)).toBe(2 / 1024);
    expect(quantise(5, 0, 10)).toBe(5);
  });

  // The server decodes each step of a control from the word the phone sends
  // and must get the same bits; its tests read this table of the client's
  // values (internal/bus/testdata/quantise.json).
  test("gives the values the server's table has, bit for bit", () => {
    const table = JSON.parse(
      readFileSync(
        new URL('../../../internal/bus/testdata/quantise.json', import.meta.url),
        'utf8',
      ),
    ) as { helm: string[]; sheet: string[] };
    const bits = (x: number): string => {
      const v = new DataView(new ArrayBuffer(8));
      v.setFloat64(0, x);
      return `0x${v.getBigUint64(0).toString(16).padStart(16, '0')}`;
    };
    expect(table.helm).toHaveLength(RESOLUTION + 1);
    for (let k = 0; k <= RESOLUTION; k++) {
      expect(bits(quantise(-1 + (2 * k) / RESOLUTION, -1, 1))).toBe(table.helm[k]);
      expect(bits(quantise(k / RESOLUTION, 0, 1))).toBe(table.sheet[k]);
    }
  });
});
