// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { FieldMaker, fromByte, HEIGHT_RANGE, LoopBaker, newFields, rms, Transform } from './field';
import { BAKED, DETAIL, foamAt, KNOT, newFoamLook } from './look';
import {
  detailPatch,
  finerPatch,
  GRAVITY,
  jonswap,
  modesOf,
  newSpectrumInputs,
  type Patch,
  patchWeight,
  spectrumAt,
  spectrumInputs,
  type WaveWind,
} from './spectrum';

const sea = catalog.weather.sea;
const NM = 1852;
const TWO_PI = 2 * Math.PI;

/** The detail's first patch at a size. */
function patch(size: number): Patch {
  return detailPatch(sea, size, DETAIL.patch, DETAIL.period);
}

/** A wind in knots blowing toward a bearing, in degrees, over a fetch in nautical miles. */
function wind(knots: number, toward: number, fetch: number): WaveWind {
  const a = (toward * Math.PI) / 180;
  return { speed: knots * KNOT, east: Math.sin(a), north: Math.cos(a), fetch: fetch * NM };
}

function maker(size: number, w: WaveWind): FieldMaker {
  const p = patch(size);
  const m = new FieldMaker(p);
  m.set(sea, spectrumInputs(sea, p, w, newSpectrumInputs()));
  return m;
}

/** The winds and fetches the look was chosen in. */
const STATES: [string, number, number][] = [
  ['calm', 6, 1.5],
  ['breeze', 12, 4],
  ['fresh', 20, 6.5],
  ['gale', 34, 9],
];

describe('the transform', () => {
  it('is the sum it stands for', () => {
    const n = 16;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 1.7) + 0.3;
      im[i] = Math.cos(i * 0.9);
    }
    const wr = Float64Array.from(re);
    const wi = Float64Array.from(im);
    new Transform(n).line(wr, wi, 0, 1);
    for (let j = 0; j < n; j++) {
      let sr = 0;
      let si = 0;
      for (let k = 0; k < n; k++) {
        const a = (TWO_PI * j * k) / n;
        sr += (re[k] ?? 0) * Math.cos(a) - (im[k] ?? 0) * Math.sin(a);
        si += (re[k] ?? 0) * Math.sin(a) + (im[k] ?? 0) * Math.cos(a);
      }
      expect(wr[j]).toBeCloseTo(sr, 12);
      expect(wi[j]).toBeCloseTo(si, 12);
    }
  });

  it('refuses a length that is not a power of two', () => {
    expect(() => new Transform(12)).toThrow();
  });
});

describe('the detail band’s fields', () => {
  it('are the sum of their waves, at 50 points', () => {
    const m = maker(64, wind(20, 200, 6.5));
    const time = 1234.5;
    const f = m.at(time, newFields(64));
    const cell = DETAIL.patch / 64;
    let seed = 7;
    const rand = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const col = Math.floor(rand() * 64);
      const row = Math.floor(rand() * 64);
      const want = m.sumAt(col * cell, row * cell, time);
      const at = row * 64 + col;
      const got = [f.height[at], f.east[at], f.north[at], f.convergence[at]];
      for (let k = 0; k < 4; k++) {
        worst = Math.max(worst, Math.abs((got[k] ?? 0) - (want[k] ?? 0)));
      }
    }
    expect(worst).toBeLessThan(1e-9);
    // And they are fields worth comparing.
    expect(rms(f.height)).toBeGreaterThan(0.02);
    expect(rms(f.east)).toBeGreaterThan(0.02);
  });

  for (const [name, knots, fetch] of STATES) {
    it(`have the spectrum's height in the ${name}`, () => {
      const w = wind(knots, 180, fetch);
      const m = maker(128, w);
      const f = m.at(50, newFields(128));
      // The band's variance by a rule of its own: the trapezium rule in ω,
      // from the 8 m wave up, with the patch's weight.
      const p = patch(128);
      const j = jonswap(sea, w.speed, w.fetch, { level: 0, peak: 1 });
      const from = Math.sqrt((GRAVITY * TWO_PI) / sea.shortest);
      const to = Math.sqrt(GRAVITY * 4 * p.rollOff);
      const steps = 20000;
      let m0 = 0;
      for (let i = 0; i <= steps; i++) {
        const om = from + ((to - from) * i) / steps;
        const k = (om * om) / GRAVITY;
        // Just inside the band's edge, which the weight leaves out.
        const weight = i === 0 ? Math.exp(-((k / p.rollOff) ** 2)) : patchWeight(p, k);
        m0 += spectrumAt(sea, j, om) * weight * (i === 0 || i === steps ? 0.5 : 1);
      }
      m0 *= (to - from) / steps;
      const want = 4 * Math.sqrt(m0);
      const got = 4 * rms(f.height);
      expect(Math.abs(got - want) / want).toBeLessThan(0.05);
    });
  }

  it('grow little with the wind: a tenth of a metre in a calm, a third in a gale', () => {
    const hs = STATES.map(([, knots, fetch]) => {
      const m = maker(128, wind(knots, 180, fetch));
      return 4 * rms(m.at(0, newFields(128)).height);
    });
    expect(hs[0]).toBeGreaterThan(0.07);
    expect(hs[0]).toBeLessThan(0.13);
    expect(hs[3]).toBeGreaterThan(0.28);
    expect(hs[3]).toBeLessThan(0.4);
    for (let i = 1; i < hs.length; i++) {
      expect(hs[i]).toBeGreaterThan(hs[i - 1] ?? 0);
    }
  });

  it('hold the same height whichever way the wind blows', () => {
    const hs: number[] = [];
    for (let toward = 0; toward < 360; toward += 17) {
      const m = maker(64, wind(12, toward, 4));
      hs.push(rms(m.at(3, newFields(64)).height));
    }
    const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
    for (const h of hs) {
      expect(Math.abs(h - mean) / mean).toBeLessThan(0.01);
    }
  });

  it('have no wave of 8 m or longer', () => {
    const m = maker(128, wind(34, 90, 9));
    let longest = 0;
    let waves = 0;
    for (let i = 0; i < m.amplitude.length; i++) {
      if ((m.amplitude[i] ?? 0) > 0) {
        waves++;
        longest = Math.max(longest, TWO_PI / (m.modes.k[i] ?? 1));
      }
    }
    expect(waves).toBeGreaterThan(5000);
    expect(longest).toBeLessThan(sea.shortest);
    expect(longest).toBeGreaterThan(7);
  });

  it('repeat after the loop, and not before', () => {
    const m = maker(64, wind(20, 30, 6.5));
    const a = m.at(1000.25, newFields(64));
    const b = m.at(1000.25 + DETAIL.period, newFields(64));
    const c = m.at(1000.25 + DETAIL.period / 2, newFields(64));
    let same = 0;
    let other = 0;
    for (let i = 0; i < a.height.length; i++) {
      same = Math.max(same, Math.abs((a.height[i] ?? 0) - (b.height[i] ?? 0)));
      other = Math.max(other, Math.abs((a.height[i] ?? 0) - (c.height[i] ?? 0)));
    }
    expect(same).toBeLessThan(1e-9);
    expect(other).toBeGreaterThan(0.05);
  });

  it('keep every frequency within 1% of the wave’s own', () => {
    const modes = modesOf(patch(256));
    let worst = 0;
    for (let i = 0; i < modes.k.length; i++) {
      if ((modes.weight[i] ?? 0) === 0) {
        continue;
      }
      const omega = Math.sqrt(GRAVITY * (modes.k[i] ?? 0));
      const held = ((modes.step[i] ?? 0) * TWO_PI) / DETAIL.period;
      worst = Math.max(worst, Math.abs(held - omega) / omega);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('travel downwind', () => {
    for (const toward of [0, 75, 200, 310]) {
      const m = maker(128, wind(20, toward, 6.5));
      let east = 0;
      let north = 0;
      for (let i = 0; i < m.amplitude.length; i++) {
        const e = (m.amplitude[i] ?? 0) ** 2;
        east += (e * (m.modes.east[i] ?? 0)) / (m.modes.k[i] || 1);
        north += (e * (m.modes.north[i] ?? 0)) / (m.modes.k[i] || 1);
      }
      const mean = (Math.atan2(east, north) * 180) / Math.PI;
      const off = ((mean - toward + 540) % 360) - 180;
      expect(Math.abs(off)).toBeLessThan(3);
    }
  });

  it('move downwind as time passes', () => {
    // The height a moment later is the height a little upwind now.
    const m = maker(64, wind(12, 90, 4));
    const cell = DETAIL.patch / 64;
    const a = m.at(10, newFields(64));
    const b = m.at(10.1, newFields(64));
    const shifted = (by: number): number => {
      let sum = 0;
      for (let row = 0; row < 64; row++) {
        for (let col = 0; col < 64; col++) {
          const x = col * cell - by;
          sum += ((b.height[row * 64 + col] ?? 0) - m.sumAt(x, row * cell, 10)[0]) ** 2;
        }
      }
      return sum;
    };
    // A 4 m wave travels at 2.5 m/s: a quarter of a metre in a tenth of a second.
    expect(shifted(0.25)).toBeLessThan(shifted(0));
    expect(shifted(0.25)).toBeLessThan(shifted(-0.25));
    expect(a.height.length).toBe(64 * 64);
  });

  it('give the convergence of the shift that sharpens the crests', () => {
    const m = maker(64, wind(20, 140, 6.5));
    const time = 77;
    const f = m.at(time, newFields(64));
    const cell = DETAIL.patch / 64;
    const u = (time % DETAIL.period) / DETAIL.period;
    // The shift of the water, Σ k/|k| a sin(k·x − ωt + φ), summed here wave by wave.
    const shift = (x: number, y: number): [number, number] => {
      let e = 0;
      let n = 0;
      for (let i = 0; i < m.amplitude.length; i++) {
        const a = m.amplitude[i] ?? 0;
        if (a === 0) {
          continue;
        }
        const kx = m.modes.east[i] ?? 0;
        const ky = m.modes.north[i] ?? 0;
        const k = m.modes.k[i] ?? 1;
        const s =
          a *
          Math.sin(
            kx * x + ky * y + TWO_PI * ((m.modes.phase[i] ?? 0) - (m.modes.step[i] ?? 0) * u),
          );
        e += (kx / k) * s;
        n += (ky / k) * s;
      }
      return [e, n];
    };
    const d = 1e-4;
    let worst = 0;
    for (const [col, row] of [
      [3, 5],
      [20, 41],
      [63, 0],
      [31, 31],
    ] as const) {
      const x = col * cell;
      const y = row * cell;
      const div =
        (shift(x + d, y)[0] - shift(x - d, y)[0] + shift(x, y + d)[1] - shift(x, y - d)[1]) /
        (2 * d);
      worst = Math.max(worst, Math.abs(div - (f.convergence[row * 64 + col] ?? 0)));
    }
    expect(worst).toBeLessThan(1e-6);
    // The water is drawn toward the crests: the convergence is greatest where the surface is highest.
    let sum = 0;
    for (let i = 0; i < f.height.length; i++) {
      sum += (f.height[i] ?? 0) * (f.convergence[i] ?? 0);
    }
    expect(sum).toBeGreaterThan(0);
  });
});

describe('the second patch', () => {
  it('carries what the first rolls off, and nothing long', () => {
    const first = patch(256);
    const second = finerPatch(first, DETAIL.finePatch, DETAIL.fineLongest);
    for (const k of [8, 12, 20, 40]) {
      // Together the two weigh the spectrum once, until the second rolls off itself.
      const both = patchWeight(first, k) + patchWeight(second, k);
      expect(both).toBeGreaterThan(0.8);
      expect(both).toBeLessThanOrEqual(1);
    }
    expect(patchWeight(second, TWO_PI / 2)).toBe(0);
    const w = wind(20, 0, 6.5);
    const a = spectrumInputs(sea, first, w, newSpectrumInputs());
    const b = spectrumInputs(sea, second, w, newSpectrumInputs());
    // Almost no height, and as much slope as the first again.
    expect(b.variance).toBeLessThan(0.01 * a.variance);
    expect(b.slope).toBeGreaterThan(0.3 * a.slope);
  });
});

describe('the low tier’s loop', () => {
  const bake = (knots: number, folding = true): LoopBaker => {
    const p: Patch = {
      ...detailPatch(sea, BAKED.size, DETAIL.patch, BAKED.period),
      shortest: BAKED.shortest,
    };
    const w = { speed: knots * KNOT, east: 1, north: 0, fetch: BAKED.fetch * NM };
    const look = foamAt(knots, newFoamLook());
    const inputs = spectrumInputs(sea, p, w, newSpectrumInputs());
    // As steep as the band the transform draws at 128 texels a side.
    const whole = spectrumInputs(sea, patch(128), w, newSpectrumInputs());
    return new LoopBaker(
      sea,
      p,
      inputs,
      BAKED.frames,
      BAKED.coarse,
      folding ? look : { ...look, folding: 0 },
      DETAIL.spread,
      Math.sqrt(whole.slope / inputs.slope),
    );
  };

  it('holds each frame as the fields at that time, to a texel’s step', () => {
    const b = bake(20, false);
    while (!b.work(1000)) {
      // Until it is whole.
    }
    const { loop } = b;
    const p: Patch = {
      ...detailPatch(sea, BAKED.size, DETAIL.patch, BAKED.period),
      shortest: BAKED.shortest,
    };
    const m = new FieldMaker(p);
    m.set(
      sea,
      spectrumInputs(
        sea,
        p,
        { speed: 20 * KNOT, east: 1, north: 0, fetch: BAKED.fetch * NM },
        newSpectrumInputs(),
      ),
    );
    const n = BAKED.size;
    for (const frame of [0, 7, 31]) {
      const f = m.at((frame * BAKED.period) / BAKED.frames, newFields(n));
      let slope = 0;
      let height = 0;
      let clipped = 0;
      for (let i = 0; i < n * n; i++) {
        const at = (frame * n * n + i) * 4;
        // A value beyond the range is held at its end.
        const ends = [loop.texels[at], loop.texels[at + 1], loop.texels[at + 3]];
        if (ends.some((b) => b === 1 || b === 255)) {
          clipped++;
          continue;
        }
        slope = Math.max(
          slope,
          Math.abs(fromByte(loop.texels[at] ?? 0, loop.slopeRange) - (f.east[i] ?? 0)),
          Math.abs(fromByte(loop.texels[at + 1] ?? 0, loop.slopeRange) - (f.north[i] ?? 0)),
        );
        height = Math.max(
          height,
          Math.abs(
            fromByte(loop.texels[at + 3] ?? 0, HEIGHT_RANGE * loop.sigma) - (f.height[i] ?? 0),
          ),
        );
      }
      // Half a step of the 127 a side.
      expect(clipped).toBeLessThan(8);
      expect(slope).toBeLessThan(loop.slopeRange / 127);
      expect(height).toBeLessThan((HEIGHT_RANGE * loop.sigma) / 127);
    }
    // The waves it holds are 2 m and longer, and travel east.
    expect(loop.sigma * 4).toBeGreaterThan(0.2);
    let longest = 0;
    let shortest = 99;
    for (let i = 0; i < m.amplitude.length; i++) {
      if ((m.amplitude[i] ?? 0) > 0) {
        longest = Math.max(longest, TWO_PI / (m.modes.k[i] ?? 1));
        shortest = Math.min(shortest, TWO_PI / (m.modes.k[i] ?? 1));
      }
    }
    expect(shortest).toBeGreaterThanOrEqual(BAKED.shortest);
    expect(longest).toBeLessThan(sea.shortest);
  });

  it('closes: the frame after the last is the first', () => {
    const p: Patch = {
      ...detailPatch(sea, BAKED.size, DETAIL.patch, BAKED.period),
      shortest: BAKED.shortest,
    };
    const m = new FieldMaker(p);
    m.set(
      sea,
      spectrumInputs(
        sea,
        p,
        { speed: 20 * KNOT, east: 1, north: 0, fetch: BAKED.fetch * NM },
        newSpectrumInputs(),
      ),
    );
    const a = m.at(0, newFields(BAKED.size));
    const b = m.at(BAKED.period, newFields(BAKED.size));
    const half = m.at(BAKED.period / 2, newFields(BAKED.size));
    let same = 0;
    let other = 0;
    for (let i = 0; i < a.height.length; i++) {
      same = Math.max(same, Math.abs((a.height[i] ?? 0) - (b.height[i] ?? 0)));
      other = Math.max(other, Math.abs((a.height[i] ?? 0) - (half.height[i] ?? 0)));
    }
    expect(same).toBeLessThan(1e-9);
    expect(other).toBeGreaterThan(0.02);
    // Few frequencies are left in so short a loop.
    const steps = new Set<number>();
    for (let i = 0; i < m.amplitude.length; i++) {
      if ((m.amplitude[i] ?? 0) > 0) {
        steps.add(m.modes.step[i] ?? 0);
      }
    }
    expect(steps.size).toBeGreaterThanOrEqual(4);
    expect(steps.size).toBeLessThanOrEqual(5);
  });

  it('closes with its foam too: another turn of the loop leaves the same foam', () => {
    const b = bake(20);
    while (!b.work(1000)) {
      // Until it is whole.
    }
    const n = BAKED.size;
    const first = b.loop.texels.slice(0, n * n * 4);
    let foam = 0;
    for (let i = 2; i < b.loop.texels.length; i += 4) {
      foam += (b.loop.texels[i] ?? 0) > 20 ? 1 : 0;
    }
    // In a fresh breeze some of the sea folds, and most does not.
    expect(foam / (b.loop.texels.length / 4)).toBeGreaterThan(0.002);
    expect(foam / (b.loop.texels.length / 4)).toBeLessThan(0.3);
    // The loop's frames once more, on from its last.
    for (let i = 0; i < BAKED.frames; i++) {
      b.made = BAKED.frames + i;
      b.frame();
    }
    let worst = 0;
    for (let i = 2; i < first.length; i += 4) {
      worst = Math.max(worst, Math.abs((first[i] ?? 0) - (b.loop.texels[i] ?? 0)));
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('has no foam in a calm, and is made a few frames at a time', () => {
    const b = bake(6);
    expect(b.total).toBe(BAKED.frames);
    // A clock that says each frame takes 2 ms: a slice of 4 ms is two frames.
    let clock = 0;
    const slow = (): number => {
      clock += 2;
      return clock;
    };
    let slices = 0;
    while (!b.work(4, slow)) {
      slices++;
      expect(b.made).toBe(2 * slices);
    }
    expect(slices).toBe(BAKED.frames / 2 - 1);
    expect(b.loop.texels.filter((_, i) => i % 4 === 2).every((v) => v === 0)).toBe(true);
    // And the average a tile reads is the texels' own.
    const n = BAKED.size;
    const c = BAKED.coarse;
    const block = n / c;
    let sum = 0;
    for (let y = 0; y < block; y++) {
      for (let x = 0; x < block; x++) {
        sum += (b.loop.texels[(y * n + x) * 4 + 3] ?? 0) - 128;
      }
    }
    expect(Math.abs((b.loop.coarseTexels[3] ?? 0) - 128 - sum / (block * block))).toBeLessThan(1.5);
  });
});
