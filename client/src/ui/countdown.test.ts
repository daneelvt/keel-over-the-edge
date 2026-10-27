// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  Countdown,
  EndNotices,
  endText,
  leftText,
  RESERVE_STEPS,
  reserveOf,
  type ShownStore,
} from './countdown';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the countdown', () => {
  test('reads in days and hours, then hours and minutes, then minutes and seconds', () => {
    expect(leftText(4 * DAY + 6 * HOUR + 20 * MINUTE, 'en')).toBe('4d 6h');
    expect(leftText(5 * HOUR + 3 * MINUTE + 10 * SECOND, 'en')).toBe('5h 3m');
    expect(leftText(9 * MINUTE + 12 * SECOND, 'en')).toBe('9m 12s');
    expect(leftText(12 * SECOND, 'en')).toBe('12s');
    expect(leftText(-5 * SECOND, 'en')).toBe('0s');
    // The last day's last hour: minutes alone.
    expect(leftText(42 * MINUTE, 'en')).toBe('42m');
  });

  test('counts by the world clock, not the device’s', () => {
    // The device's clock is a day wrong: the world clock is all it reads.
    const ends = Date.UTC(2026, 10, 1, 23, 0, 0);
    let world = ends - (2 * DAY + 3 * HOUR);
    const c = new Countdown(() => world, 'en');
    c.setEnd({ world: 'w1', ends, closing: ends - 3 * DAY, zone: 'America/New_York', epoch: 0 });
    expect(c.text.value).toBe('2d 3h');
    expect(c.closing.value).toBe(true);
    world = ends - 9 * MINUTE - 12 * SECOND;
    c.tick();
    expect(c.text.value).toBe('9m 12s');
    expect(c.last.value).toBe('');
    world = ends - 30 * SECOND;
    c.tick();
    expect(c.last.value).not.toBe('');
  });

  test('is not closing before its last days, and shows nothing with no end known', () => {
    const ends = Date.UTC(2026, 10, 1, 23, 0, 0);
    const c = new Countdown(() => ends - 5 * DAY, 'en');
    c.setEnd({ world: 'w1', ends, closing: ends - 3 * DAY, zone: '', epoch: 0 });
    expect(c.closing.value).toBe(false);
    const none = new Countdown(() => Number.NaN, 'en');
    none.setEnd({ world: 'w1', ends, closing: ends - 3 * DAY, zone: '', epoch: 0 });
    expect(none.text.value).toBe('');
  });
});

describe('the reserve of a world’s life', () => {
  const epoch = Date.UTC(2026, 9, 25, 22, 0, 0);
  const ends = epoch + 7 * DAY;
  const e = { world: 'w1', ends, closing: ends - 3 * DAY, zone: '', epoch };

  test('is whole as the world begins, half in the middle of its week, none at its end', () => {
    expect(reserveOf(e, epoch)).toBe(1);
    expect(reserveOf(e, epoch + 3.5 * DAY)).toBeCloseTo(0.5, 9);
    expect(reserveOf(e, ends)).toBe(0);
    expect(reserveOf(e, ends + HOUR)).toBe(0);
    expect(reserveOf(e, epoch - HOUR)).toBe(1);
  });

  test('is none, with no words, for a world with no end known', () => {
    const c = new Countdown(() => epoch + DAY, 'en');
    c.setEnd({ ...e, ends: 0 });
    expect(c.reserve.value).toBe(0);
    expect(c.text.value).toBe('');
  });

  test('moves in steps, so the gauge is drawn again seldom', () => {
    let now = epoch + 3.5 * DAY;
    const c = new Countdown(() => now, 'en');
    c.setEnd(e);
    const half = c.reserve.value;
    expect(half).toBe(0.5);
    // Ten minutes is less than a step of a week.
    now += 10 * MINUTE;
    c.tick();
    expect(c.reserve.value).toBe(half);
    now += (7 * DAY) / RESERVE_STEPS;
    c.tick();
    expect(c.reserve.value).toBeCloseTo(0.5 - 1 / RESERVE_STEPS, 9);
  });
});

describe('the end in the player’s own time', () => {
  // Sunday 1 November 2026, 6 pm in New York: 23:00 UTC, EST.
  const ends = Date.UTC(2026, 10, 1, 23, 0, 0);
  test('in Auckland, with New York’s beside it', () => {
    const t = endText(ends, 'America/New_York', 'en-US', 'Pacific/Auckland');
    expect(t).toMatch(/^Monday.*12:00.*GMT\+13 \(Sunday.*6:00.*PM.*ET\)$/);
  });
  test('in Los Angeles, with New York’s beside it', () => {
    const t = endText(ends, 'America/New_York', 'en-US', 'America/Los_Angeles');
    expect(t).toMatch(/^Sunday.*3:00.*PM PST \(Sunday.*6:00.*PM.*ET\)$/);
  });
  test('in New York, alone', () => {
    expect(endText(ends, 'America/New_York', 'en-US', 'America/New_York')).toMatch(
      /^Sunday.*6:00.*PM EST$/,
    );
  });
  test('a schedule of periods is published in UTC', () => {
    expect(endText(ends, '', 'en-US', 'America/New_York')).toMatch(/\(Sunday.*11:00.*PM UTC\)$/);
  });
});

describe('the notices of the world’s end', () => {
  const memory = (): ShownStore => {
    const m = new Map<string, string[]>();
    return {
      get: (w) => m.get(w) ?? [],
      add: (w, k) => m.set(w, [...(m.get(w) ?? []), k]),
    };
  };
  const kinds = [
    { on: 'falls-coming' },
    { on: 'falls-soon', before: [60, 10] },
    { on: 'new-world' },
  ];

  test('each once a world: the closing, the end near at each time, a new world', () => {
    const ends = Date.UTC(2026, 10, 1, 23, 0, 0);
    let world = ends - 4 * DAY;
    const c = new Countdown(() => world, 'en');
    const raised: string[] = [];
    const shown = memory();
    const n = new EndNotices(c, kinds, shown, (on, fill) =>
      raised.push(`${on} ${Object.values(fill).join(',')}`),
    );
    c.setEnd({
      world: 'w1',
      ends,
      closing: ends - 3 * DAY,
      zone: 'America/New_York',
      epoch: world - 3_600_000,
    });
    n.welcome(0);
    n.welcome(1);
    n.tick(0);
    expect(raised).toEqual(['new-world ']);
    // A player who comes on Friday is still told of the closing, once.
    world = ends - 2 * DAY;
    c.tick();
    n.tick(0);
    n.tick(1);
    expect(raised.length).toBe(2);
    expect(raised[1]).toMatch(/^falls-coming \w+day/);
    // An hour before, and ten minutes before; not late, and not twice.
    world = ends - 59 * MINUTE - 30 * SECOND;
    c.tick();
    n.tick(0);
    n.tick(0);
    world = ends - 30 * MINUTE;
    c.tick();
    n.tick(0);
    world = ends - 9 * MINUTE - 50 * SECOND;
    c.tick();
    n.tick(0);
    expect(raised.slice(2)).toEqual(['falls-soon 1h', 'falls-soon 10m']);
    // A world begun more than a day ago is not new, however new to this
    // phone.
    const old: string[] = [];
    const c2 = new Countdown(() => ends - 4 * DAY, 'en');
    c2.setEnd({ world: 'w0', ends, closing: ends - 3 * DAY, zone: '', epoch: ends - 7 * DAY });
    new EndNotices(c2, kinds, memory(), (on) => old.push(on)).welcome(0);
    expect(old).toEqual([]);
    // Another page of the same phone, the same world: nothing again.
    const again: string[] = [];
    const n2 = new EndNotices(c, kinds, shown, (on) => again.push(on));
    n2.welcome(0);
    n2.tick(0);
    expect(again).toEqual([]);
  });
});
