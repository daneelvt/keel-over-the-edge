// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { type Complication, clockOut, disclosure, fitted, pressed } from './complications';

describe('the case’s complications', () => {
  test('are kept in the order they were opened', () => {
    let order: Complication[] = [];
    order = pressed(order, 'clock', true);
    order = pressed(order, 'barometer', true);
    expect(order).toEqual(['clock', 'barometer']);
    // Put away and out again: the newest.
    order = pressed(pressed(order, 'clock', false), 'clock', true);
    expect(order).toEqual(['barometer', 'clock']);
    expect(pressed(order, 'barometer', false)).toEqual(['clock']);
  });

  test('fold back, oldest opened first, until the case clears the pocket chart', () => {
    // Each complication is 100 pixels wide beside a case of 250; the room is 380.
    const width = (open: readonly Complication[]) => 250 + 100 * open.length;
    const fits = (open: readonly Complication[]) => width(open) <= 380;
    expect(fitted(['clock', 'barometer'], fits)).toEqual(['barometer']);
    expect(fitted(['barometer', 'clock'], fits)).toEqual(['clock']);
    expect(fitted(['barometer'], fits)).toEqual(['barometer']);
    // A case that does not fit even shut keeps nothing out.
    expect(fitted(['barometer', 'clock'], () => false)).toEqual([]);
  });

  test('the world clock comes out by itself in the world’s last days, until put away', () => {
    expect(clockOut(false, false, false)).toBe(false);
    expect(clockOut(false, true, false)).toBe(true);
    expect(clockOut(false, true, true)).toBe(false);
    expect(clockOut(true, false, false)).toBe(true);
    expect(clockOut(true, true, true)).toBe(true);
  });

  test('each pusher says whether what it shows is out, and which it is', () => {
    expect(disclosure('case-barometer', false)).toEqual({
      'aria-expanded': false,
      'aria-controls': 'case-barometer',
    });
    expect(disclosure('case-clock', true)).toEqual({
      'aria-expanded': true,
      'aria-controls': 'case-clock',
    });
  });
});
