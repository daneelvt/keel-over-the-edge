// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { spoutHeight } from '../render/features';
import {
  type FeaturesInput,
  featureEvents,
  FEATURE_RECIPES as R,
  roarNow,
  spoutOffset,
} from './features';

const base = (over: Partial<FeaturesInput> = {}): FeaturesInput => ({
  seconds: 1000,
  day: true,
  listener: { east: 0, north: 0 },
  look: 0,
  seaHeight: 2,
  period: 8,
  falls: [],
  blowholes: [],
  colonies: [],
  ...over,
});

describe('the features’ voices', () => {
  test('a fall roars within its reach, fainter 6 dB a doubling, panned by its bearing', () => {
    const near = roarNow(R.waterfall, base({ falls: [{ east: 30, north: 0, drop: 20 }] }));
    const twice = roarNow(R.waterfall, base({ falls: [{ east: 60, north: 0, drop: 20 }] }));
    expect(near.level).toBeGreaterThan(0);
    expect(twice.level / near.level).toBeCloseTo(0.5, 6);
    // East of a listener looking north: to the right.
    expect(near.pan).toBeCloseTo(1, 6);
    expect(
      roarNow(R.waterfall, base({ falls: [{ east: R.waterfall.reach + 1, north: 0, drop: 20 }] }))
        .level,
    ).toBe(0);
    // A lower fall is quieter.
    expect(
      roarNow(R.waterfall, base({ falls: [{ east: 30, north: 0, drop: 5 }] })).level,
    ).toBeLessThan(near.level);
  });

  test('a blowhole booms as its spout begins, once a wave', () => {
    const b = { east: -50, north: 0, seed: 7 };
    const events = featureEvents(R, base({ blowholes: [b] }), 1000, 1040).filter(
      (e) => e.kind === 'boom',
    );
    expect(events.length).toBe(5);
    for (const e of events) {
      const phase = (e.at / 8 + spoutOffset(b.seed, b.east)) % 1;
      expect(Math.min(phase, 1 - phase)).toBeLessThan(1e-6);
      // The spout the page draws rises from that moment.
      expect(spoutHeight((phase + 0.05) % 1, 8)).toBeGreaterThan(0);
      expect(e.pan).toBeCloseTo(-1, 6);
    }
    expect(featureEvents(R, base({ blowholes: [{ ...b, east: -1000 }] }), 1000, 1040).length).toBe(
      0,
    );
  });

  test('a colony calls by day, in its own voice, and not at night', () => {
    const c = { east: 0, north: 40, call: 'whistle' as const, seed: 3 };
    const day = featureEvents(R, base({ colonies: [c] }), 1000, 1120);
    expect(day.length).toBeGreaterThan(10);
    expect(day.every((e) => e.kind === 'whistle')).toBe(true);
    expect(featureEvents(R, base({ day: false, colonies: [c] }), 1000, 1120).length).toBe(0);
    // The same events on every phone.
    expect(featureEvents(R, base({ colonies: [c] }), 1000, 1120)).toEqual(day);
  });
});
