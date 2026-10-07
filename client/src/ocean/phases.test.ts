// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { TEST_SEAS } from './ocean';
import { BoatBand, COMPONENTS, GRAVITY, reducePhase } from './phases';

// Double-double arithmetic (Dekker 1971; Knuth's two-sum): a value as an
// unevaluated sum hi + lo, good to about 32 significant digits.
type DD = [number, number];

function twoSum(a: number, b: number): DD {
  const s = a + b;
  const v = s - a;
  return [s, a - (s - v) + (b - v)];
}

function split(a: number): DD {
  const c = 134217729 * a; // 2^27 + 1
  const hi = c - (c - a);
  return [hi, a - hi];
}

function twoProd(a: number, b: number): DD {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

function add(a: DD, b: DD): DD {
  const [s, e] = twoSum(a[0], b[0]);
  return twoSum(s, e + a[1] + b[1]);
}

function mulD(a: DD, b: number): DD {
  const [p, e] = twoProd(a[0], b);
  return twoSum(p, e + a[1] * b);
}

// 2π to about 48 digits, in three parts.
const TWO_PI: [number, number, number] = [
  6.283185307179586, 2.4492935982947064e-16, -5.9895396194366793e-33,
];

/** φ + k(d·O) − ωt reduced to [0, 2π), in double-double, as a double. */
function referencePhase(
  phase: number,
  k: number,
  east: number,
  north: number,
  e: number,
  n: number,
  omega: number,
  t: number,
): number {
  let x: DD = [phase, 0];
  x = add(x, mulD(mulD([k, 0], east), e));
  x = add(x, mulD(mulD([k, 0], north), n));
  x = add(x, mulD([-omega, 0], t));
  const m = Math.floor((x[0] + x[1]) / TWO_PI[0]);
  let r = add(x, mulD([TWO_PI[0], 0], -m));
  r = add(r, mulD([TWO_PI[1], 0], -m));
  r = add(r, mulD([TWO_PI[2], 0], -m));
  let v = r[0] + r[1];
  if (v < 0) {
    v += 2 * Math.PI;
  }
  return v;
}

/** The difference of two angles, the short way round. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

describe('phases at the floating origin', () => {
  test('reduce into [0, 2π)', () => {
    for (const x of [0, 1e-300, 6.283185307179586, -1e-9, 1.7e6, -1.7e6, 123.456]) {
      const r = reducePhase(x);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(2 * Math.PI);
    }
  });

  test('match a double-double reference 8,000 m out after 7 days, to 10⁻⁹ rad', () => {
    const t = 7 * 86400 + 0.123;
    const origin: [number, number] = [-5657.2, 5657.9]; // 8,000 m out
    for (const name of ['breeze', 'gale']) {
      const sea = TEST_SEAS[name];
      if (sea === undefined) {
        throw new Error(name);
      }
      const band = new BoatBand();
      band.set(sea);
      band.update(origin[0], origin[1], t);
      sea.components.forEach((c, i) => {
        const want = referencePhase(
          c.phase,
          c.k,
          c.east,
          c.north,
          origin[0],
          origin[1],
          Math.sqrt(GRAVITY * c.k),
          t,
        );
        expect(angleDiff(band.phase64[i] ?? 0, want)).toBeLessThan(1e-9);
      });
    }
  });

  test('calm water: every amplitude is zero', () => {
    const band = new BoatBand();
    band.set(null);
    band.update(100, 200, 50);
    for (const w of band.waves) {
      expect(w.w).toBe(0);
    }
    expect(band.sample(3, 4, new Float64Array(3))).toEqual(Float64Array.from([0, 0, 0]));
  });

  test('the band’s slope is the gradient of its height', () => {
    const band = new BoatBand();
    band.set(TEST_SEAS.gale ?? null);
    band.update(1200, -300, 3600);
    const s = new Float64Array(3);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    const h = 1e-5;
    band.sample(17, -42, s);
    band.sample(17 + h, -42, a);
    band.sample(17 - h, -42, b);
    expect(((a[0] ?? 0) - (b[0] ?? 0)) / (2 * h)).toBeCloseTo(s[1] ?? 0, 6);
    band.sample(17, -42 + h, a);
    band.sample(17, -42 - h, b);
    expect(((a[0] ?? 0) - (b[0] ?? 0)) / (2 * h)).toBeCloseTo(s[2] ?? 0, 6);
  });
});

// The JONSWAP spectrum (Hasselmann and others, 1973) for a wind and fetch,
// computed here independently of tools/testsea.
function jonswap(windKnots: number, fetchNM: number): { s: (w: number) => number; peak: number } {
  const u = (windKnots * 1852) / 3600;
  const f = fetchNM * 1852;
  const alpha = 0.076 * ((GRAVITY * f) / (u * u)) ** -0.22;
  const peak = 22 * Math.cbrt((GRAVITY * GRAVITY) / (u * f));
  const s = (w: number): number => {
    const sigma = w <= peak ? 0.07 : 0.09;
    const r = Math.exp(-(((w - peak) / (sigma * peak)) ** 2) / 2);
    return alpha * GRAVITY * GRAVITY * w ** -5 * Math.exp(-1.25 * (peak / w) ** 4) * 3.3 ** r;
  };
  return { s, peak };
}

describe('the test sea fixtures', () => {
  test.each(Object.keys(TEST_SEAS))('%s carries its band’s JONSWAP height, within 10%%', (name) => {
    const sea = TEST_SEAS[name];
    if (sea === undefined) {
      throw new Error(name);
    }
    expect(sea.components).toHaveLength(COMPONENTS);
    const { s, peak } = jonswap(sea.windKnots, sea.fetchNM);
    // The band: waves longer than 8 m, from half the peak's frequency.
    const w1 = Math.sqrt((GRAVITY * 2 * Math.PI) / 8);
    let w0 = Math.max(0.5 * peak, 0.45);
    if (w0 > 0.8 * w1) {
      w0 = 0.5 * w1;
    }
    let m0 = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      m0 += s(w0 + ((i + 0.5) * (w1 - w0)) / n) * ((w1 - w0) / n);
    }
    const want = 4 * Math.sqrt(m0);
    const got = 4 * Math.sqrt(sea.components.reduce((sum, c) => sum + (c.a * c.a) / 2, 0));
    expect(Math.abs(got - want)).toBeLessThan(0.1 * want);
  });

  test('the gale is the rendering’s: about 1.3 m, peaking near 4 s', () => {
    const sea = TEST_SEAS.gale as unknown as { hsFull: number; peakPeriod: number };
    expect(sea.hsFull).toBeCloseTo(1.3, 1);
    expect(sea.peakPeriod).toBeCloseTo(4.1, 1);
  });
});
