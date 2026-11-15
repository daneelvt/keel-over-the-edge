// SPDX-License-Identifier: AGPL-3.0-only

// The barometer aboard: a reading a second, its set hand at its own reading
// of a quarter of an hour before, its words over its readings, a held
// change for the sandbox, and its past filled from the truth after a load.
// Its words held still: each cut of its tendency, its turn and its figure
// crossed only once the pressure has really moved, both ways, and the
// words changed at most once in ten seconds.

import { describe, expect, test } from 'vitest';
import {
  type BarometerSaid,
  saidWords,
  steadyBarometer,
  TENDENCY_WORDS,
  tendencyOf,
} from '../chart/words';
import { Barometer, dialAngle, SWEEP, setWords, WORDS_HOLD } from './barometer';

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
  test('enlarged, it says in words what its set hand reads', () => {
    expect(setWords(1012.4, 15)).toBe('1012 hPa a quarter of an hour ago');
    expect(setWords(1008, 60)).toBe('1008 hPa an hour ago');
    expect(setWords(1008, 5)).toBe('1008 hPa 5 minutes ago');
    expect(setWords(Number.NaN, 15)).toBe('');
    const b = new Barometer(LOOK);
    expect(b.setWords.value).toBe('');
    // Falling a tenth of an hPa a minute, read for twenty minutes.
    for (let t = 0; t <= 20 * MINUTE; t += SECOND) {
      b.update(
        t,
        () => 1013 - (0.1 * t) / MINUTE,
        () => null,
      );
    }
    expect(b.set).toBeCloseTo(1013 - 0.1 * 5, 6);
    expect(b.setWords.value).toBe('1013 hPa a quarter of an hour ago');
  });

  test('holds its words while readings near a change go to and fro, and moves at most once in ten seconds', () => {
    const b = new Barometer(LOOK);
    const none = () => null;
    // Rising a whole hPa a second for a minute: the figure would change each second.
    const changed: number[] = [];
    let was = '';
    for (let t = 0; t <= 60 * SECOND; t += SECOND) {
      b.update(t, () => 1000 + t / SECOND, none);
      if (b.words.value !== was) {
        changed.push(t);
        was = b.words.value;
      }
    }
    expect(changed.length).toBe(7);
    for (let i = 1; i < changed.length; i++) {
      expect((changed[i] ?? 0) - (changed[i - 1] ?? 0)).toBeGreaterThanOrEqual(WORDS_HOLD);
    }
    // And says the pressure as it is once the hold is up.
    expect(b.words.value).toBe('1060 hPa, steady');
    // A pressure on the half, to and fro each second: the words never change.
    const c = new Barometer(LOOK);
    for (let t = 0; t <= 60 * SECOND; t += SECOND) {
      c.update(t, () => 1012.5 + ((t / SECOND) % 2 === 0 ? 0.1 : -0.1), none);
    }
    expect(c.words.value).toBe('1013 hPa, steady');
  });

  test('its held words stay until let go, and the next reading says the pressure at once', () => {
    const b = new Barometer(LOOK);
    const none = () => null;
    b.update(0, () => 1012, none);
    b.holdWords('1040 hPa, falling very rapidly');
    b.update(SECOND, () => 1012, none);
    expect(b.words.value).toBe('1040 hPa, falling very rapidly');
    b.holdWords(null);
    b.update(2 * SECOND, () => 1012, none);
    expect(b.words.value).toBe('1012 hPa, steady');
  });
});

describe('the barometer’s words, held steady', () => {
  /** What is said after a reading (now, before, quarter) following what was said. */
  const following = (was: BarometerSaid, now: number, before: number, quarter: number) =>
    steadyBarometer(now, before, quarter, was);

  test('each cut of the tendency is crossed only 0.1 hPa past it, both ways', () => {
    for (const sign of [1, -1]) {
      for (const [cut, below, above] of [
        [0.1, 0, 1],
        [1.5, 1, 2],
        [3.5, 2, 3],
        [6, 3, 4],
      ] as const) {
        const quarter = 1010;
        const at = (d: number) => quarter + sign * d;
        // A tendency of words, signed as the change is: no −0 for steady.
        const want = (w: number) => (w === 0 ? 0 : sign * w);
        const bare = (d: number) => tendencyOf(at(d), at(d), quarter).words || 0;
        const said = (d: number, was: BarometerSaid) => following(was, at(d), at(d), quarter);
        const low = steadyBarometer(at(cut - 0.15), at(cut - 0.15), quarter, null);
        expect(low.words || 0).toBe(want(below));
        // Just past the cut, where the bare tendency says the band above: held.
        expect(bare(cut + 0.05)).toBe(want(above));
        expect(said(cut + 0.05, low).words || 0, `${sign} ${cut} up`).toBe(want(below));
        const high = said(cut + 0.11, low);
        expect(high.words, `${sign} ${cut} up`).toBe(want(above));
        // And back: just short of the cut, held; 0.1 short of it, below again.
        expect(bare(cut - 0.05)).toBe(want(below));
        expect(said(cut - 0.05, high).words, `${sign} ${cut} down`).toBe(want(above));
        expect(said(cut - 0.11, high).words || 0, `${sign} ${cut} down`).toBe(want(below));
      }
    }
  });

  test('“now rising” comes on at 0.1 hPa against a fall and clears under 0.03', () => {
    const quarter = 1012;
    const now = 1010;
    const falling = steadyBarometer(now, now, quarter, null);
    expect(saidWords(falling)).toBe('1010 hPa, falling');
    // Risen 0.07 in the last minutes: the bare tendency turns, the held one does not.
    expect(tendencyOf(now, now - 0.07, quarter).turned).toBe(true);
    expect(following(falling, now, now - 0.07, quarter).turned).toBe(false);
    const turned = following(falling, now, now - 0.11, quarter);
    expect(saidWords(turned)).toBe('1010 hPa, now rising');
    // Back to 0.04: the bare tendency clears, the held one stays turned.
    expect(tendencyOf(now, now - 0.04, quarter).turned).toBe(false);
    expect(following(turned, now, now - 0.04, quarter).turned).toBe(true);
    expect(following(turned, now, now - 0.02, quarter).turned).toBe(false);
    // And “now falling” after a rise, the same.
    const rising = steadyBarometer(1014, 1014, quarter, null);
    expect(following(rising, 1014, 1014.07, quarter).turned).toBe(false);
    const fell = following(rising, 1014, 1014.11, quarter);
    expect(saidWords(fell)).toBe('1014 hPa, now falling');
    expect(following(fell, 1014, 1014.04, quarter).turned).toBe(true);
    expect(following(fell, 1014, 1014.02, quarter).turned).toBe(false);
  });

  test('the figure moves only once the pressure is 0.2 hPa past the half, both ways', () => {
    const at = (hPa: number, was: BarometerSaid) => following(was, hPa, hPa, hPa).figure;
    const said = steadyBarometer(1013, 1013, 1013, null);
    expect(said.figure).toBe(1013);
    expect(at(1013.6, said)).toBe(1013);
    const up = { ...said, figure: at(1013.71, said) };
    expect(up.figure).toBe(1014);
    expect(at(1013.4, up)).toBe(1014);
    expect(at(1013.29, up)).toBe(1013);
    // Far off, at once.
    expect(at(1020.2, said)).toBe(1020);
  });

  test('every tendency is said, and the longest fits the words’ slot', () => {
    expect(TENDENCY_WORDS).toContain('steady');
    expect(TENDENCY_WORDS).toContain('now rising');
    expect(TENDENCY_WORDS).toContain('falling very rapidly');
    expect(TENDENCY_WORDS.length).toBe(11);
  });
});
