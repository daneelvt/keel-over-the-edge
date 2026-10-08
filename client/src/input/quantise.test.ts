// SPDX-License-Identifier: AGPL-3.0-only

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
});
