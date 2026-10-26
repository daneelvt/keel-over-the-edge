// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { lifetimeWords, machinesWords, plural } from './machines';

describe('sign-in for AI apps', () => {
  test('tells a lifetime in its largest units first', () => {
    expect(lifetimeWords(90 * 86_400)).toBe('90 days');
    expect(lifetimeWords(86_400 + 6 * 3600)).toBe('1 day 6 hours');
    expect(lifetimeWords(3600 + 60)).toBe('1 hour 1 minute');
    expect(lifetimeWords(60)).toBe('1 minute');
    expect(lifetimeWords(90)).toBe('1 minute 30 seconds');
    expect(lifetimeWords(0)).toBe('0 seconds');
  });

  test('counts with the noun agreeing', () => {
    expect(plural(1, 'grant')).toBe('1 grant');
    expect(plural(0, 'grant')).toBe('0 grants');
    expect(plural(3, 'machine sailor')).toBe('3 machine sailors');
  });

  test('tells the machine sailors and the grants live, a kind with none as nought', () => {
    expect(machinesWords({ total: 4, week: 1, grants: { app: 2 }, lifetime: 90 * 86_400 })).toBe(
      '4 machine sailors, 1 made this week; grants live: 2 apps, 0 connection tokens',
    );
    expect(
      machinesWords({ total: 1, week: 0, grants: { app: 1, connection: 1 }, lifetime: 60 }),
    ).toBe('1 machine sailor, 0 made this week; grants live: 1 app, 1 connection token');
  });
});
