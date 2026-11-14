// SPDX-License-Identifier: AGPL-3.0-only

// The crowd's bunting: a strand a cheer up to a few, more for a bigger
// crowd; flung out round the masthead and drifting down the wind, three
// flags a strand hung one under another, none of a mark's or the pin's;
// gone once it has flown.

import { describe, expect, test } from 'vitest';
import { BUNTING_LIFE, BUNTING_STRANDS, buntingFlags, STRAND_FLAGS, strandsOf } from './bunting';
import type { SignalSeen } from './flags';

const burst = { east: 100, north: 200, top: 6, at: 10, strands: 3, seed: 7 };

describe('the crowd’s bunting', () => {
  test('more strands for a bigger crowd, up to a few', () => {
    expect(strandsOf(1)).toBe(1);
    expect(strandsOf(4)).toBeGreaterThan(strandsOf(2));
    expect(strandsOf(1000)).toBe(BUNTING_STRANDS);
  });

  test('flags of the designs given, flung out and drifting down the wind, then gone', () => {
    const at = (time: number) => {
      const out: SignalSeen[] = [];
      buntingFlags(burst, time, 5, 0, [2, 4], [0.6, 0.6], out);
      return out;
    };
    const early = at(10.2);
    expect(early.length).toBe(3 * STRAND_FLAGS);
    expect(early.every((f) => f.flag === 2 || f.flag === 4)).toBe(true);
    const late = at(13);
    // A wind from the north blows them south.
    const mean = (fs: SignalSeen[]) => fs.reduce((s, f) => s + f.north, 0) / fs.length;
    expect(mean(late)).toBeLessThan(mean(early));
    // Each strand's flags one under another.
    expect((late[0]?.top ?? 0) > (late[1]?.top ?? 0)).toBe(true);
    expect(at(10 + BUNTING_LIFE + 0.1)).toEqual([]);
    expect(at(9)).toEqual([]);
  });
});
