// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { blastsBetween } from '../lights/fogsignal';
import { airCutoff } from './air';
import {
  FOG_SIGNAL_RECIPES,
  FOG_SIGNAL_RULES,
  type FogLight,
  type FogSignalsInput,
  fogSignalEvents,
  poorBy,
} from './fogsignals';

const R = FOG_SIGNAL_RECIPES;
const C = FOG_SIGNAL_RULES;

/** The catalog's first diaphone's pattern. */
const diaphone = C.signals.findIndex((s) => s.device === 'diaphone');
const twotone = C.signals.findIndex((s) => s.device === 'twotone');

const light = (change: Partial<FogLight> = {}): FogLight => ({
  number: 3,
  east: 1000,
  north: 0,
  phase: 1_234_567,
  fogSignal: diaphone,
  ...change,
});

const input = (change: Partial<FogSignalsInput> = {}): FogSignalsInput => ({
  seconds: 0,
  listener: { east: 0, north: 0 },
  look: 0,
  lights: [light()],
  poorAt: () => true,
  ...change,
});

describe('a fog signal heard', () => {
  test('a blast at 1,000 m is heard 2.9 s after it sounds, from its bearing, as long as it sounds', () => {
    const steps = C.signals[diaphone]?.steps ?? [];
    const got = fogSignalEvents(R, C, input(), 0, 120);
    expect(got.length).toBeGreaterThan(0);
    for (const e of got) {
      expect(e.device).toBe('diaphone');
      expect(e.light).toBe(3);
      expect(e.at - e.start).toBeCloseTo(1000 / 343, 6);
      expect(e.at - e.start).toBeCloseTo(2.9, 1);
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThan(120);
      expect(e.length).toBeCloseTo((steps[0] ?? 0) / 1000, 6);
      // East of a listener looking north: to the right.
      expect(e.pan).toBeGreaterThan(0.99);
      expect(e.level).toBeCloseTo(R.diaphone.level * (R.diaphone.near / 1000), 6);
    }
    // The blasts are the light's schedule's, shifted by the sound's travel.
    const delay = 1000 / 343;
    const want = blastsBetween(
      steps,
      light().phase,
      Math.floor(-delay * 1e6),
      Math.floor((120 - delay) * 1e6),
    ).map((b) => b.start / 1e6);
    expect(got.map((e) => e.start)).toEqual(want);
    // Looking east, the light is ahead; looking south, to the left.
    expect(fogSignalEvents(R, C, input({ look: Math.PI / 2 }), 0, 120)[0]?.pan).toBeCloseTo(0, 6);
    expect(fogSignalEvents(R, C, input({ look: Math.PI }), 0, 120)[0]?.pan).toBeLessThan(-0.99);
  });

  test('nothing beyond a nautical mile', () => {
    const near = fogSignalEvents(R, C, input({ lights: [light({ east: 1850 })] }), 0, 120);
    expect(near.length).toBeGreaterThan(0);
    const far = fogSignalEvents(R, C, input({ lights: [light({ east: 1853 })] }), 0, 120);
    expect(far).toEqual([]);
  });

  test('nothing while the visibility at the light, as a blast begins, is a nautical mile or more', () => {
    expect(fogSignalEvents(R, C, input({ poorAt: () => false }), 0, 120)).toEqual([]);
    const poor = poorBy(C.rule, (e, n) => (e === 1000 && n === 0 ? 1851 : 5000));
    expect(fogSignalEvents(R, C, input({ poorAt: poor }), 0, 120).length).toBeGreaterThan(0);
    const clear = poorBy(C.rule, () => 1853);
    expect(fogSignalEvents(R, C, input({ poorAt: clear }), 0, 120)).toEqual([]);
  });

  test('asks the visibility at the light at the tick its blast begins', () => {
    const asked: number[] = [];
    const got = fogSignalEvents(
      R,
      C,
      input({
        poorAt: (e, n, tick) => {
          expect([e, n]).toEqual([1000, 0]);
          asked.push(tick);
          return true;
        },
      }),
      0,
      120,
    );
    expect(asked).toEqual(got.map((e) => Math.floor(e.start * 30)));
  });

  test('two pages hear the same blasts at the same moments, however their frames fall', () => {
    const one = fogSignalEvents(R, C, input(), 100, 400);
    const again = fogSignalEvents(R, C, input(), 100, 400);
    expect(again).toEqual(one);
    // Another page's frames, 50 ms apart.
    const frames = [];
    for (let k = 0; k < 6000; k++) {
      frames.push(...fogSignalEvents(R, C, input(), 100 + k * 0.05, 100 + (k + 1) * 0.05));
    }
    expect(frames.map((e) => [e.start, e.at])).toEqual(one.map((e) => [e.start, e.at]));
  });

  test('a two-tone sounds its high tone, then the lower', () => {
    const got = fogSignalEvents(R, C, input({ lights: [light({ fogSignal: twotone })] }), 0, 120);
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]?.device).toBe('twotone');
    expect(got[0]?.tones).toEqual([R.twotone.pitch, R.twotone.low]);
    expect(R.twotone.low).toBeLessThan(R.twotone.pitch);
  });

  test('the air’s low-pass falls with distance', () => {
    const at = (d: number): number =>
      fogSignalEvents(R, C, input({ lights: [light({ east: d })] }), 0, 120)[0]?.cutoff ?? 0;
    expect(at(100)).toBeGreaterThan(at(500));
    expect(at(500)).toBeGreaterThan(at(1000));
    expect(at(1000)).toBeGreaterThan(at(1850));
    // Where the absorption over 1 km reaches 3 dB: between 500 Hz and 1 kHz.
    const a = R.air.absorption;
    expect(airCutoff(a, 0, 1e5, 1000)).toBeGreaterThan(500);
    expect(airCutoff(a, 0, 1e5, 1000)).toBeLessThan(1000);
  });
});
