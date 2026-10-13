// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { patternTexels } from './pattern';

describe('the foam’s pattern', () => {
  const size = 128;
  const data = patternTexels(size);
  const at = (col: number, row: number, channel: number): number =>
    data[((((row % size) + size) % size) * size + (((col % size) + size) % size)) * 4 + channel] ??
    0;

  it('uses each channel’s whole range, about its middle', () => {
    for (let c = 0; c < 4; c++) {
      let least = 255;
      let most = 0;
      let sum = 0;
      for (let i = c; i < data.length; i += 4) {
        const v = data[i] ?? 0;
        least = Math.min(least, v);
        most = Math.max(most, v);
        sum += v;
      }
      expect(least).toBeLessThan(40);
      expect(most).toBeGreaterThan(c === 2 ? 190 : 215);
      const mean = sum / (size * size);
      expect(mean).toBeGreaterThan(c === 0 ? 30 : 100);
      expect(mean).toBeLessThan(c === 0 ? 120 : 155);
    }
  });

  it('wraps without a seam: the step across an edge is no more than a step inside', () => {
    for (let c = 0; c < 4; c++) {
      let inside = 0;
      let across = 0;
      for (let i = 0; i < size; i++) {
        for (let j = 1; j < size; j++) {
          inside = Math.max(inside, Math.abs(at(j, i, c) - at(j - 1, i, c)));
        }
        across = Math.max(
          across,
          Math.abs(at(0, i, c) - at(-1, i, c)),
          Math.abs(at(i, 0, c) - at(i, -1, c)),
        );
      }
      expect(across).toBeLessThanOrEqual(inside);
    }
  });

  it('is the same every time', () => {
    expect(patternTexels(32)).toEqual(patternTexels(32));
  });

  it('has lace in thin lines: most of it is dark', () => {
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      bright += (data[i] ?? 0) > 128 ? 1 : 0;
    }
    expect(bright / (size * size)).toBeGreaterThan(0.1);
    expect(bright / (size * size)).toBeLessThan(0.45);
  });
});
