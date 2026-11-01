// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { caseLine, disclosure, fitted, LAID, pressed } from './complications';

describe('the case’s complications', () => {
  test('are the barometer alone: the world’s time left is the pocket chart’s', () => {
    expect(LAID).toEqual(['barometer']);
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
