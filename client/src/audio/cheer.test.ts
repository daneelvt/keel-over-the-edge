// SPDX-License-Identifier: AGPL-3.0-only

// The crowd's cheer: a few voices for one cheer, more, a roar and claps
// for many; the player's own near and bright, the crowd cheering the
// player's boat distant and louder for more.

import { describe, expect, test } from 'vitest';
import { CHEER, cheerOf, voicesOf } from './cheer';

const steady = () => 0.5;

describe('the crowd’s cheer', () => {
  test('grows with the cheers', () => {
    expect(voicesOf(CHEER, 1)).toBe(CHEER.voices.least);
    expect(voicesOf(CHEER, 8)).toBeGreaterThan(voicesOf(CHEER, 2));
    expect(voicesOf(CHEER, 1e6)).toBe(CHEER.voices.most);
    const one = cheerOf(CHEER, 1, false, true, steady);
    const many = cheerOf(CHEER, 30, false, true, steady);
    expect(one.roar).toBe(0);
    expect(one.claps).toEqual([]);
    expect(many.roar).toBeGreaterThan(0);
    expect(many.claps.length).toBeGreaterThan(0);
    expect(many.level).toBeGreaterThan(one.level);
  });

  test('one’s own near and bright, the crowd’s on the quay distant', () => {
    const own = cheerOf(CHEER, 1, true, false, steady);
    const crowd = cheerOf(CHEER, 1, false, true, steady);
    expect(own.cutoff).toBeGreaterThan(crowd.cutoff);
    expect(own.level).toBeCloseTo(CHEER.own.level * CHEER.level, 9);
    expect(crowd.cutoff).toBe(CHEER.distant.cutoff);
  });
});
