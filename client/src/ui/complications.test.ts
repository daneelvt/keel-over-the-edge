// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { caseLine, disclosure, fitted, LAID, pressed, slideOf, within } from './complications';

describe('the case’s complications', () => {
  test('are the barometer and the ship’s clock, laid out in that order', () => {
    expect(LAID).toEqual(['barometer', 'clock']);
  });

  test('slide as they open and as they fold, and at no other time', () => {
    expect(slideOf(false, true, false)).toBe('opening');
    expect(slideOf(true, false, false)).toBe('folding');
    // Drawn again, out or in: still.
    expect(slideOf(true, true, false)).toBeNull();
    expect(slideOf(false, false, false)).toBeNull();
    // Less motion asked for: never.
    expect(slideOf(false, true, true)).toBeNull();
    expect(slideOf(true, false, true)).toBeNull();
  });

  test('held upright, fold back, oldest opened first, until their column clears the foot', () => {
    // A case 122 pixels tall, each complication 114 beneath it in a column,
    // 300 pixels wide on a screen whose controls at the foot stand at 448.
    const box = (open: readonly string[]) => ({ right: 300, bottom: 122 + 114 * open.length });
    const fits = (foot: number) => (open: readonly string[]) =>
      within(box(open), { right: 340, bottom: foot });
    expect(fitted(['barometer', 'clock'], fits(448))).toEqual(['barometer', 'clock']);
    expect(fitted(['barometer', 'clock'], fits(300))).toEqual(['clock']);
    expect(fitted(['clock', 'barometer'], fits(300))).toEqual(['barometer']);
    expect(fitted(['barometer', 'clock'], fits(200))).toEqual([]);
    // As wide as the room allows and no wider, as tall likewise.
    expect(within({ right: 340, bottom: 448 }, { right: 340, bottom: 448 })).toBe(true);
    expect(within({ right: 340.5, bottom: 100 }, { right: 340, bottom: 448 })).toBe(false);
  });

  test('are kept in the order they were opened', () => {
    // A second complication, as later instruments add theirs.
    let order: string[] = [];
    order = pressed(order, 'tide', true);
    order = pressed(order, 'barometer', true);
    expect(order).toEqual(['tide', 'barometer']);
    // Put away and out again: the newest.
    order = pressed(pressed(order, 'tide', false), 'tide', true);
    expect(order).toEqual(['barometer', 'tide']);
    expect(pressed(order, 'barometer', false)).toEqual(['tide']);
  });

  test('fold back, oldest opened first, until the case clears the pocket chart', () => {
    // Each complication is 100 pixels wide beside a case of 250; the room is 380.
    const width = (open: readonly string[]) => 250 + 100 * open.length;
    const fits = (open: readonly string[]) => width(open) <= 380;
    expect(fitted(['tide', 'barometer'], fits)).toEqual(['barometer']);
    expect(fitted(['barometer', 'tide'], fits)).toEqual(['tide']);
    expect(fitted(['barometer'], fits)).toEqual(['barometer']);
    // A case that does not fit even shut keeps nothing out.
    expect(fitted(['barometer', 'tide'], () => false)).toEqual([]);
  });

  test('each pusher says whether what it shows is out, and which it is', () => {
    expect(disclosure('case-barometer', false)).toEqual({
      'aria-expanded': false,
      'aria-controls': 'case-barometer',
    });
    expect(disclosure('harbour-board', true)).toEqual({
      'aria-expanded': true,
      'aria-controls': 'harbour-board',
    });
  });

  test('the last line says what no control says: the autopilot of a boat watched, else the tack', () => {
    // The control head or its folded button says what the autopilot holds.
    expect(caseLine('Wind 45° S', '', true)).toBe('');
    expect(caseLine('Wind 45° S', 'Starboard tack', true)).toBe('Starboard tack');
    // A boat watched has no controls.
    expect(caseLine('Wind 45° S', 'Starboard tack', false)).toBe('Autopilot Wind 45° S');
    expect(caseLine('', 'Port tack', false)).toBe('Port tack');
    expect(caseLine('', '', false)).toBe('');
  });
});
