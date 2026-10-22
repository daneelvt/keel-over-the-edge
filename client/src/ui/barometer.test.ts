// SPDX-License-Identifier: AGPL-3.0-only

// The barometer aboard: a reading a second, its set hand at its own reading
// of a quarter of an hour before, its words over its readings, a held
// change for the sandbox, and its past filled from the truth after a load.

import { describe, expect, test } from 'vitest';
import { Barometer, dialAngle, SWEEP } from './barometer';

const SECOND = 30;
const MINUTE = 60 * SECOND;
const LOOK = { range: [950, 1040], set: 15 } as const;

describe('the barometer', () => {
  test('its dial sweeps from the range’s foot to its head, and no further', () => {
    expect(dialAngle(950, LOOK)).toBe(-SWEEP);
    expect(dialAngle(995, LOOK)).toBe(0);
    expect(dialAngle(1040, LOOK)).toBe(SWEEP);
    expect(dialAngle(900, LOOK)).toBe(-SWEEP);
  });

  test('reads at most once a second; its set hand is its own reading of a quarter of an hour before', () => {
    const b = new Barometer(LOOK);
    const none = () => null;
    let hPa = 1012;
    let reads = 0;
    const read = () => {
      reads++;
      return hPa;
    };
    b.update(0, read, none);
    b.update(SECOND - 1, read, none);
    expect(reads).toBe(1);
    expect(b.words.value).toBe('1012 hPa, steady');
    // Falling 4 hPa over the quarter, steadily.
    for (let t = SECOND; t <= 15 * MINUTE; t += SECOND) {
      hPa = 1012 - (4 * t) / (15 * MINUTE);
      b.update(t, read, none);
    }
    expect(b.set).toBe(1012);
    expect(b.now).toBeCloseTo(1008, 9);
    expect(b.words.value).toMatch(/^1008 hPa, falling /);
  });

  test('a held change is added to every reading, and its words follow', () => {
    const b = new Barometer(LOOK);
    b.hold(-7, 0);
    const none = () => null;
    for (let t = 0; t <= 15 * MINUTE; t += SECOND) {
      b.update(t, () => 1000, none);
    }
    expect(b.now).toBeCloseTo(993, 9);
    expect(b.set).toBe(1000);
    expect(b.words.value).toBe('993 hPa, falling very rapidly');
    // Another rate carries on from what was held.
    b.hold(3, 15 * MINUTE);
    b.update(15 * MINUTE + SECOND, () => 1000, none);
    expect(b.now).toBeCloseTo(993 + 3 / 900, 9);
  });

  test('after a load its past is the truth’s, and its words are whole at once', () => {
    const b = new Barometer(LOOK);
    const now = 100 * MINUTE;
    const past = (t: number) => 1000 + (now - t) / (5 * MINUTE);
    b.update(now, () => 1000, past);
    expect(b.set).toBe(1003);
    expect(b.words.value).toMatch(/^1000 hPa, falling/);
  });

  test('a clock set back forgets what was read', () => {
    const b = new Barometer(LOOK);
    b.update(
      20 * MINUTE,
      () => 990,
      () => null,
    );
    b.update(
      5 * MINUTE,
      () => 1010,
      () => null,
    );
    expect(b.readingAt(20 * MINUTE, () => null)).toBeNull();
    expect(b.words.value).toBe('1010 hPa, steady');
  });
});
