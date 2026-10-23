// SPDX-License-Identifier: AGPL-3.0-only

// The page's positions are the server's: the same words for every point of
// internal/chart/testdata/positions.json, and the same points from the
// same words.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { formatPosition, meridianText, parallelText, parsePosition } from './position';

interface PositionsFile {
  written: { east: number; north: number; text: string }[];
  parsed: { text: string; east: number; north: number }[];
  refused: { text: string }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/chart/testdata/positions.json', import.meta.url), 'utf8'),
) as PositionsFile;

describe('positions', () => {
  test('are written as the server writes them', () => {
    expect(file.written.length).toBeGreaterThan(80);
    for (const c of file.written) {
      expect(formatPosition(c.east, c.north), `(${c.east}, ${c.north})`).toBe(c.text);
    }
  });

  test('are read as the server reads them', () => {
    for (const c of file.parsed) {
      const p = parsePosition(c.text);
      expect('error' in p, c.text).toBe(false);
      if (!('error' in p)) {
        expect(Math.abs(p.east - c.east), c.text).toBeLessThan(1e-9);
        expect(Math.abs(p.north - c.north), c.text).toBeLessThan(1e-9);
      }
    }
    for (const c of file.refused) {
      expect('error' in parsePosition(c.text), c.text).toBe(true);
    }
  });

  test('the graticule is lettered in the same words', () => {
    expect(parallelText(80)).toBe('80°N');
    expect(meridianText(30)).toBe('030°');
    expect(meridianText(360)).toBe('000°');
  });
});
