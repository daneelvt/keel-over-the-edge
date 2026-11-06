// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { clockAngles, hourText, ShipsClock, sunText, worldTimeText } from './clock';

/** The world's day, real minutes. */
const DAY = 118;

describe('the ship’s clock', () => {
  test('turns its hands and its disc with the hour of the world’s day', () => {
    // Midnight: both hands at 12, the moon at the top of the disc.
    expect(clockAngles(0)).toEqual({ hour: 0, minute: 0, disc: -180 });
    // Dawn: the hour hand at 6, the sun at the left of the window, rising into it.
    expect(clockAngles(6)).toEqual({ hour: 180, minute: 0, disc: -90 });
    // Noon: the sun at the top.
    expect(clockAngles(12)).toEqual({ hour: 0, minute: 0, disc: 0 });
    // Dusk: the sun at the right, setting.
    expect(clockAngles(18)).toEqual({ hour: 180, minute: 0, disc: 90 });
    const late = clockAngles(23 + 59 / 60);
    expect(late.hour).toBeCloseTo(359.5, 6);
    expect(late.minute).toBeCloseTo(354, 6);
    expect(late.disc).toBeCloseTo(179.75, 6);
    // A day on, the same.
    expect(clockAngles(24 + 6)).toEqual(clockAngles(6));
    // Half past four: the minute hand at the 6, the hour hand half way to 5.
    const half = clockAngles(16.5);
    expect(half.minute).toBeCloseTo(180, 6);
    expect(half.hour).toBeCloseTo(135, 6);
  });

  test('says the time in the reader’s own form, 12-hour or 24-hour', () => {
    expect(worldTimeText(16 + 20 / 60, 'en-US')).toBe('World time 4:20 PM');
    expect(worldTimeText(16 + 20 / 60, 'en-GB')).toBe('World time 16:20');
    expect(worldTimeText(0.5, 'en-US')).toBe('World time 12:30 AM');
    // To the minute, as the hands read it: 59 minutes and a half is 59.
    expect(worldTimeText(9 + 59.5 / 60, 'en-GB')).toBe('World time 9:59');
    expect(hourText(16.9, 'en-US')).toBe('World time 4 PM');
  });

  test('says how long until the sun sets or rises at the centre of the disk, in real minutes', () => {
    // A world hour is 118 / 24 real minutes.
    expect(sunText(12, DAY)).toBe('Sunset in 30 min');
    expect(sunText(17, DAY)).toBe('Sunset in 5 min');
    expect(sunText(6, DAY)).toBe('Sunset in 59 min');
    expect(sunText(18, DAY)).toBe('Sunrise in 59 min');
    expect(sunText(0, DAY)).toBe('Sunrise in 30 min');
    expect(sunText(5.99, DAY)).toBe('Sunrise in 1 min');
  });

  test('names the hour for a screen reader at most once a world hour', () => {
    const c = new ShipsClock(DAY, 'en-US');
    c.update(16.2);
    expect(c.named.value).toBe('World time 4 PM');
    expect(c.words.value).toBe('World time 4:12 PM');
    c.named.value = '';
    c.update(16.7);
    expect(c.named.value).toBe('');
    expect(c.words.value).toBe('World time 4:42 PM');
    c.update(17.01);
    expect(c.named.value).toBe('World time 5 PM');
  });
});
