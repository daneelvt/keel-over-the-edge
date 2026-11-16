// SPDX-License-Identifier: AGPL-3.0-only

// The mix's numbers: the sliders' cube, the bed's curve, the calm's
// lapping, a storm's weight, and the recipe's limiter a safety net, not a
// compressor.

import { describe, expect, test } from 'vitest';
import { BUSES, calmLevel, curved, MIX, sliderGain, stormLevel } from './mix';

const db = (g: number): number => 20 * Math.log10(g);

describe('the sliders', () => {
  test('are cubed: 70% is −9.3 dB, half −18, a quarter −36, none silent', () => {
    expect(db(sliderGain(0.7))).toBeCloseTo(-9.3, 1);
    expect(db(sliderGain(0.5))).toBeCloseTo(-18.1, 1);
    expect(db(sliderGain(0.25))).toBeCloseTo(-36.1, 1);
    expect(sliderGain(0)).toBe(0);
    expect(sliderGain(1)).toBe(1);
  });

  test('hold out of range and broken values to the slider’s ends', () => {
    expect(sliderGain(2)).toBe(1);
    expect(sliderGain(-1)).toBe(0);
    expect(sliderGain(Number.NaN)).toBe(0);
  });
});

describe('the bed’s curve', () => {
  test('keeps the loudest where it is and silence silent', () => {
    expect(curved(0.4, 0.4, MIX.bed.curve)).toBeCloseTo(0.4, 12);
    expect(curved(0, 0.4, MIX.bed.curve)).toBe(0);
  });

  test('brings a range of the recipes’ dB to curve times as many', () => {
    const most = 0.3;
    const quiet = most * 10 ** (-20 / 20);
    const range = db(curved(most, most, MIX.bed.curve) / curved(quiet, most, MIX.bed.curve));
    expect(range).toBeCloseTo(20 * MIX.bed.curve, 6);
    expect(MIX.bed.curve).toBeLessThan(1);
  });

  test('rises fast from silence and slowly at the top', () => {
    const c = (x: number): number => curved(x, 1, MIX.bed.curve);
    expect(c(0.1) - c(0)).toBeGreaterThan(c(1) - c(0.9));
  });
});

describe('the calm’s lapping', () => {
  test('laps while the boat drifts, swelling and falling, and is gone once she has way on', () => {
    const c = MIX.calm;
    const levels = Array.from({ length: 200 }, (_, i) => calmLevel(c, 0.2, i * 0.05));
    expect(Math.min(...levels)).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBeLessThanOrEqual(c.level);
    expect(Math.max(...levels) / Math.min(...levels)).toBeGreaterThan(2);
    expect(calmLevel(c, (c.speed[1] ?? 1.4) + 0.1, 3)).toBe(0);
  });
});

describe('a storm’s weight', () => {
  test('is nothing in a fresh breeze, rises with the wind and is all there in a gale', () => {
    const s = MIX.storm;
    expect(stormLevel(s, 10.6)).toBe(0);
    expect(stormLevel(s, 14)).toBeGreaterThan(0);
    expect(stormLevel(s, 14)).toBeLessThan(stormLevel(s, 16));
    expect(stormLevel(s, 18)).toBeCloseTo(s.level, 12);
    expect(stormLevel(s, 25)).toBeCloseTo(s.level, 12);
  });

  test('is deep: well under the wind’s band', () => {
    expect(MIX.storm.centre).toBeLessThan(500);
  });
});

describe('the recipe', () => {
  test('sets the whole mix under the player’s volume, quieter than full scale', () => {
    expect(MIX.master).toBeLessThan(0);
  });

  test('balances every bus', () => {
    for (const b of BUSES) {
      expect(typeof MIX.buses[b].level).toBe('number');
    }
  });

  test('makes the limiter a safety net: −6 dB, a hard knee, 20:1, fast', () => {
    expect(MIX.limiter).toEqual({
      threshold: -6,
      knee: 0,
      ratio: 20,
      attack: 0.002,
      release: 0.15,
    });
  });

  test('fades in over 1.5 s, out over 0.15 s and back over 0.5 s; glides over 150 ms', () => {
    expect(MIX.fades).toEqual({ start: 1.5, out: 0.15, in: 0.5, slider: 0.05, glide: 0.15 });
  });
});
