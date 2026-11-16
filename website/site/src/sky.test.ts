// SPDX-License-Identifier: AGPL-3.0-only

// The page's colours through the sky's day: the hour as the game counts
// it, every step's words readable on every ground they sit on, the ink
// changing between dark and paper only where both sides read, and the
// style sheet holding every step.

import { describe, expect, test } from 'vitest';
import catalog from '../../../client/src/catalog/catalog.gen.json' with { type: 'json' };
import {
  blendAt,
  contrast,
  GROUNDS,
  HOURS,
  hourAt,
  hourFromQuery,
  INKS,
  mix,
  openingAt,
  PALETTES,
  paletteAt,
  READABLE,
  STEP_HOURS,
  STEPS,
  skyCss,
  skyStep,
  steps,
} from './sky';

const SKY = { day: catalog.sky.day, epoch: catalog.sky.epoch, sunAtEpoch: catalog.sky.sunAtEpoch };

describe('the sky’s hour', () => {
  test('noon at the centre at the sky’s first moment, round once a sky’s day, as the game counts it', () => {
    const at = SKY.epoch * 1000;
    const day = SKY.day * 60_000;
    expect(hourAt(at, SKY)).toBeCloseTo(12, 9);
    expect(hourAt(at + day / 4, SKY)).toBeCloseTo(18, 9);
    expect(hourAt(at + day / 2, SKY)).toBeCloseTo(0, 9);
    expect(hourAt(at + (day * 3) / 4, SKY)).toBeCloseTo(6, 9);
    expect(hourAt(at + 1000 * day + day / 4, SKY)).toBeCloseTo(18, 6);
    // Before the first moment, as after.
    expect(hourAt(at - day / 4, SKY)).toBeCloseTo(6, 9);
    // internal/lookout's HourAt at a moment the status recorded: 2026-11-17T21:31:30Z.
    const t = Date.parse('2026-11-17T21:31:30Z');
    const frac = ((t / 1000 - SKY.epoch) % (SKY.day * 60)) / (SKY.day * 60);
    expect(hourAt(t, SKY)).toBeCloseTo((frac * 24 + 12) % 24, 9);
  });

  test('an hour asked for in the address, and nothing else', () => {
    expect(hourFromQuery(new URLSearchParams('hour=8.6'))).toBe(8.6);
    expect(hourFromQuery(new URLSearchParams('hour=0'))).toBe(0);
    expect(hourFromQuery(new URLSearchParams('hour=24'))).toBeNull();
    expect(hourFromQuery(new URLSearchParams('hour=-1'))).toBeNull();
    expect(hourFromQuery(new URLSearchParams('hour=noon'))).toBeNull();
    expect(hourFromQuery(new URLSearchParams(''))).toBeNull();
  });
});

describe('the four palettes and their blends', () => {
  test('each hour’s own palette where it holds, the opening picture with it', () => {
    expect(paletteAt(2)).toEqual(PALETTES.night);
    expect(paletteAt(6)).toEqual(PALETTES.dawn);
    expect(paletteAt(12)).toEqual(PALETTES.day);
    expect(paletteAt(18)).toEqual(PALETTES.dusk);
    expect([2, 6, 12, 18].map(openingAt)).toEqual(['night', 'dawn', 'day', 'dusk']);
    expect(blendAt(5.3)).toEqual({ from: 'night', to: 'dawn', t: expect.closeTo(0.5, 6) });
  });

  test('every step’s words read on every ground, 4.5:1 or better, and the keys’ words on the keys', () => {
    for (const p of steps().palettes) {
      for (const g of GROUNDS) {
        for (const k of INKS) {
          expect(contrast(p[k], p[g]), `${k} on ${g}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(p.keyInk, p.key)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.keyInk, p.keyDeep)).toBeGreaterThanOrEqual(4.5);
      // The focus ring stands out from the ground, as WCAG's 3:1 asks.
      expect(contrast(p.focus, p.ground)).toBeGreaterThanOrEqual(3);
    }
  });

  test('every minute of the sky’s day, too, not only its steps', () => {
    for (let h = 0; h < 24; h += 1 / 60) {
      const p = paletteAt(h);
      for (const g of GROUNDS) {
        for (const k of INKS) {
          expect(contrast(p[k], p[g])).toBeGreaterThanOrEqual(READABLE - 1e-6);
        }
      }
    }
  });

  test('between dark and paper the ink changes once, where both sides read; the grounds blend on either side', () => {
    const at = (h: number) => paletteAt(h);
    let changes = 0;
    for (let h = 6; h < 7.6; h += STEP_HOURS / 4) {
      const a = at(h);
      const b = at(h + STEP_HOURS / 4);
      if (a.ink !== b.ink) {
        changes++;
        // Each side's ink reads on its own side's grounds at the change.
        for (const g of GROUNDS) {
          expect(contrast(a.ink, a[g])).toBeGreaterThanOrEqual(4.5);
          expect(contrast(b.ink, b[g])).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(changes).toBe(1);
    // The ground moves toward the paper before the change, and from it after.
    expect(at(6.3).ground).not.toBe(PALETTES.dawn.ground);
    expect(at(7.3).ground).not.toBe(PALETTES.day.ground);
  });

  test('a blend is even in Oklab, and each end is itself', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#e8b450', '#e8b450', 0.37)).toBe('#e8b450');
    // Oklab's middle grey: L 0.5 is about 38.8% in sRGB.
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#636363');
  });
});

describe('the steps and their style sheet', () => {
  test('a step for every fifth of a sky’s hour, alike steps sharing a palette', () => {
    const s = steps();
    expect(s.ofStep).toHaveLength(STEPS);
    expect(STEPS).toBe(120);
    expect(new Set(s.ofStep).size).toBe(s.palettes.length);
    // The night's and the day's long holds are one palette each.
    expect(skyStep(1)).toBe(skyStep(3));
    expect(skyStep(10)).toBe(skyStep(14));
    expect(skyStep(23.99)).toBe(skyStep(0));
    expect(s.palettes.length).toBeLessThan(40);
  });

  test('the style sheet names each step’s colours, dusk’s with none named', () => {
    const css = skyCss('dusk');
    expect(css.startsWith(`:root{--ground:${PALETTES.dusk.ground};`)).toBe(true);
    const s = steps();
    s.palettes.forEach((p, i) => {
      expect(css).toContain(
        `:root[data-sky="${i}"]{--ground:${p.ground};--ground-deep:${p.groundDeep};`,
      );
    });
    for (const h of HOURS) {
      expect(css).toContain(`--title:${PALETTES[h].title}`);
    }
    // Small: a few kilobytes, before compression.
    expect(css.length).toBeLessThan(12_000);
  });
});
