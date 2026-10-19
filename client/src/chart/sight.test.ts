// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's looks against the server's, on seed 1: the chart file go
// run ./tools/dev -world 1 writes holds the server's sight table and what
// it sees along eight runs out from the main port.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { look, type SightExport, visualRange } from './sight';

const file = new URL('../../../.dev/worlds/1.chart', import.meta.url);

describe('the sandbox’s lookout', () => {
  it.skipIf(!existsSync(file))('sees what the server’s does along seed 1’s runs', () => {
    const c = JSON.parse(readFileSync(file, 'utf8')) as {
      sight: SightExport;
      checks: { X: number; Y: number; Seen: number[] }[];
    };
    expect(c.checks.length).toBeGreaterThan(1000);
    let seen = 0;
    for (const k of c.checks) {
      const got = look(c.sight, k.X, k.Y, 2, new Set()).sort((a, b) => a - b);
      expect(got, `at ${k.X.toFixed(0)}, ${k.Y.toFixed(0)}`).toEqual(
        [...k.Seen].sort((a, b) => a - b),
      );
      seen += got.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('sees as far as the mist lets it', () => {
    const v = { Band: 7778.4, Lip: 8334, Clear: 8334, Range: 300 };
    expect(visualRange(v, 0)).toBeCloseTo(8334, 6);
    expect(visualRange(v, 9000)).toBeCloseTo(300, 6);
  });
});
