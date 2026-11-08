// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  lifetimeAllowed,
  lifetimeOf,
  linkLifetimeWords,
  MAX_LINK_LIFETIME,
  MIN_LINK_LIFETIME,
  onOff,
} from './settings';

describe('links to come aboard', () => {
  test('a link lifetime in words: days from two, else hours and minutes', () => {
    expect(linkLifetimeWords(86_400)).toBe('24 hours');
    expect(linkLifetimeWords(2 * 86_400)).toBe('2 days');
    expect(linkLifetimeWords(7 * 86_400)).toBe('7 days');
    expect(linkLifetimeWords(25 * 3600)).toBe('25 hours');
    expect(linkLifetimeWords(5400)).toBe('1 hour 30 minutes');
    expect(linkLifetimeWords(300)).toBe('5 minutes');
    expect(linkLifetimeWords(2 * 86_400 + 60)).toBe('48 hours 1 minute');
    expect(linkLifetimeWords(0)).toBe('0 seconds');
  });

  test('the amount typed, in its unit, within 5 minutes and 7 days', () => {
    expect(lifetimeOf('24', 'hours')).toBe(86_400);
    expect(lifetimeOf('5', 'minutes')).toBe(300);
    expect(lifetimeOf('7', 'days')).toBe(MAX_LINK_LIFETIME);
    expect(lifetimeOf('', 'hours')).toBe(0);
    expect(lifetimeOf('1.5', 'hours')).toBe(0);
    expect(lifetimeOf('-2', 'hours')).toBe(0);
    expect(lifetimeAllowed(MIN_LINK_LIFETIME)).toBe(true);
    expect(lifetimeAllowed(MIN_LINK_LIFETIME - 60)).toBe(false);
    expect(lifetimeAllowed(MAX_LINK_LIFETIME)).toBe(true);
    expect(lifetimeAllowed(8 * 86_400)).toBe(false);
    expect(onOff(true)).toBe('on');
    expect(onOff(false)).toBe('off');
  });
});
