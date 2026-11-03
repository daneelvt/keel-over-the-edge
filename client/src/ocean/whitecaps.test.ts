// SPDX-License-Identifier: AGPL-3.0-only

// The whitecaps foamAt reads, held to the server's twin's points in
// internal/lookout/testdata/whitecaps.json, which the machine sailors'
// report hears the sea by.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { type FoamLook, foamAt } from './look';

const points = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/whitecaps.json', import.meta.url),
    'utf8',
  ),
) as { knots: number; whitecaps: number }[];

describe('whitecaps', () => {
  test('are the server’s at every point', () => {
    const out = {} as FoamLook;
    for (const p of points) {
      expect(foamAt(p.knots, out).whitecaps).toBeCloseTo(p.whitecaps, 12);
    }
  });
});
