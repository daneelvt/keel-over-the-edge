// SPDX-License-Identifier: AGPL-3.0-only

// The meter against EBU Tech 3341's and Tech 3342's cases, their signals
// built here: stereo sines of 1 kHz at the levels each case gives (dBFS as
// a sine's peak), and the true peak's sines at a quarter of the sample
// rate, sampled between their crests.

import { describe, expect, test } from 'vitest';
import {
  integrated,
  loudnessRange,
  measure,
  momentary,
  segmentPowers,
  shareAbove,
  shortTerm,
  truePeak,
  windowPowers,
} from './loudness';

const RATE = 48000;

/** A stereo sine of hz, its parts each [dBFS, seconds], one after another, phase continuous. */
function sine(parts: [number, number][], hz = 1000, phase = 0): Float32Array[] {
  const n = parts.reduce((s, [, t]) => s + Math.round(t * RATE), 0);
  const x = new Float32Array(n);
  let i = 0;
  for (const [db, t] of parts) {
    const a = 10 ** (db / 20);
    const end = i + Math.round(t * RATE);
    for (; i < end; i++) {
      x[i] = a * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
    }
  }
  return [x, x.slice()];
}

const integratedOf = (c: Float32Array[]): number =>
  integrated(windowPowers(segmentPowers(c, RATE), 4));

describe('the meter, by EBU Tech 3341', () => {
  test('reads a sine at −23 and at −33 dBFS as −23 and −33 LUFS (cases 1 and 2)', () => {
    for (const level of [-23, -33]) {
      const s = segmentPowers(sine([[level, 20]]), RATE);
      expect(integrated(windowPowers(s, 4))).toBeCloseTo(level, 1);
      for (const m of [...momentary(s), ...shortTerm(s)]) {
        expect(Math.abs(m - level)).toBeLessThanOrEqual(0.1);
      }
    }
  });

  test('gates out the quiet parts, relatively and absolutely (cases 3 and 4)', () => {
    expect(
      integratedOf(
        sine([
          [-36, 10],
          [-23, 60],
          [-36, 10],
        ]),
      ),
    ).toBeCloseTo(-23, 1);
    expect(
      integratedOf(
        sine([
          [-72, 10],
          [-36, 10],
          [-23, 60],
          [-36, 10],
          [-72, 10],
        ]),
      ),
    ).toBeCloseTo(-23, 1);
  });

  test('averages power over what passes the gate (case 5)', () => {
    const v = integratedOf(
      sine([
        [-26, 20],
        [-20, 20.1],
        [-26, 20],
      ]),
    );
    expect(Math.abs(v + 23)).toBeLessThanOrEqual(0.1);
  });

  test('holds the short-term at −23 over 1.34 s at −20 and 1.66 s at −30 (case 9)', () => {
    const parts: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      parts.push([-20, 1.34], [-30, 1.66]);
    }
    const s = shortTerm(segmentPowers(sine(parts), RATE));
    for (const v of s) {
      expect(Math.abs(v + 23)).toBeLessThanOrEqual(0.1);
    }
  });

  test('holds the momentary at −23 over 0.18 s at −20 and 0.22 s at −30 (case 12)', () => {
    const parts: [number, number][] = [];
    for (let i = 0; i < 25; i++) {
      parts.push([-20, 0.18], [-30, 0.22]);
    }
    const m = momentary(segmentPowers(sine(parts), RATE));
    for (const v of m) {
      expect(Math.abs(v + 23)).toBeLessThanOrEqual(0.1);
    }
  });

  test('finds the true peak between the samples (cases 15 to 19’s kind)', () => {
    // At a quarter of the rate, sampled 45° off its crests, a sine's
    // samples are 3 dB under its peak.
    for (const level of [-6, 0]) {
      const c = sine([[level, 1]], RATE / 4, Math.PI / 4);
      const m = measure(c, RATE);
      expect(m.samplePeak).toBeCloseTo(level - 3.01, 1);
      expect(m.truePeak).toBeGreaterThanOrEqual(level - 0.4);
      expect(m.truePeak).toBeLessThanOrEqual(level + 0.2);
    }
    // A sine of 1 kHz peaks at its level, between samples or not.
    expect(truePeak(sine([[-23, 1]]))).toBeCloseTo(-23, 1);
  });
});

describe('the loudness range, by EBU Tech 3342', () => {
  const range = (parts: [number, number][]): number =>
    loudnessRange(windowPowers(segmentPowers(sine(parts), RATE), 30));

  test('is the spread between steps of a sine (cases 1 to 4)', () => {
    expect(
      Math.abs(
        range([
          [-20, 20],
          [-30, 20],
        ]) - 10,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        range([
          [-20, 20],
          [-15, 20],
        ]) - 5,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        range([
          [-40, 20],
          [-20, 20],
        ]) - 20,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        range([
          [-50, 20],
          [-35, 20],
          [-20, 20],
          [-35, 20],
          [-50, 20],
        ]) - 15,
      ),
    ).toBeLessThanOrEqual(1);
  });
});

describe('the share above a frequency', () => {
  test('is the high sine’s part of two of equal power, and none of a low one', () => {
    const low = sine([[-20, 2]], 500)[0] as Float32Array;
    const high = sine([[-20, 2]], 5000)[0] as Float32Array;
    const both = low.map((v, i) => v + (high[i] ?? 0));
    expect(shareAbove([both], RATE, 2000)).toBeCloseTo(0.5, 2);
    expect(shareAbove([low], RATE, 2000)).toBeLessThan(0.001);
  });
});
