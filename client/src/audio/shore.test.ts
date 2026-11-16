// SPDX-License-Identifier: AGPL-3.0-only

// Near the land: the halyards tap in port only, oftener in a stronger
// wind, alike however world time is split between calls; the surf breaks
// only where the water shoals and the sea is up.

import { describe, expect, test } from 'vitest';
import { MIX } from './mix';
import { halyardsLevel, halyardTaps, surfLevel } from './shore';

const r = MIX.halyards;

describe('the halyards', () => {
  test('heard in port in a breeze, not at sea or in a calm', () => {
    expect(halyardsLevel(r, false, 8)).toBe(0);
    expect(halyardsLevel(r, true, 0.5)).toBe(0);
    expect(halyardsLevel(r, true, 8)).toBeGreaterThan(0);
    expect(halyardsLevel(r, true, 20)).toBeCloseTo(r.level, 12);
  });

  test('tap oftener in a stronger wind', () => {
    const light = halyardTaps(r, 1000, 1600, 1, 2.5).length;
    const strong = halyardTaps(r, 1000, 1600, 1, 9).length;
    expect(light).toBeGreaterThan(100);
    expect(strong).toBeGreaterThan(1.8 * light);
  });

  test('the same taps however the time is split, so every phone hears them alike', () => {
    const whole = halyardTaps(r, 1000, 1060, 1, 6);
    const split: typeof whole = [];
    for (let t = 1000; t < 1060; t += 0.05) {
      split.push(...halyardTaps(r, t, Math.min(1060, t + 0.05), 1, 6));
    }
    expect(split.map((x) => x.at.toFixed(6))).toEqual(whole.map((x) => x.at.toFixed(6)));
  });

  test('some in pairs, the answer softer', () => {
    const taps = halyardTaps(r, 0, 300, 1, 6);
    const answers = taps.filter((t) => t.seed % 1 !== 0);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.length).toBeLessThan(taps.length / 2 + 1);
    for (const a of answers) {
      const first = taps.find((t) => t.seed === a.seed - 0.5);
      expect(first).toBeDefined();
      expect(a.level).toBeCloseTo(0.6 * (first?.level ?? 0), 12);
    }
  });
});

describe('the surf', () => {
  const s = MIX.surf;
  test('heard as the water shoals with a sea running, not in deep water, over land or in a calm', () => {
    const most = (depth: number, sea: number): number => {
      let m = 0;
      for (let t = 0; t < 20; t += 0.1) {
        m = Math.max(m, surfLevel(s, depth, sea, t));
      }
      return m;
    };
    expect(most(40, 1.5)).toBe(0);
    expect(most(Number.NaN, 1.5)).toBe(0);
    expect(most(-1, 1.5)).toBe(0);
    expect(most(3, 0.05)).toBe(0);
    expect(most(6, 1.5)).toBeGreaterThan(0);
    expect(most(3, 1.5)).toBeGreaterThan(most(6, 1.5));
    expect(most(3, 1.5)).toBeCloseTo(s.level, 3);
  });
});
