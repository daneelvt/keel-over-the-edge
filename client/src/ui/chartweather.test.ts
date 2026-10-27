// SPDX-License-Identifier: AGPL-3.0-only

// The slider's lettering: the moment shown, its minutes from now and its
// time of day.

import { describe, expect, test } from 'vitest';
import { clockText, momentClock, momentText } from './chartweather';

describe('the slider’s lettering', () => {
  test('now, a minute ahead or a minute behind, with the time of day', () => {
    expect(momentText({ kind: 'now', tick: 0, minutes: 0, issue: null }, '4:20 PM')).toBe('Now');
    expect(momentText({ kind: 'ahead', tick: 0, minutes: 40, issue: null }, '4:20 PM')).toBe(
      'In 40 min · 4:20 PM',
    );
    expect(momentText({ kind: 'past', tick: 0, minutes: -40, issue: null }, '3:40 PM')).toBe(
      '40 min ago · 3:40 PM',
    );
  });

  test('the time of day of a moment, by the world’s clock now', () => {
    const now = Date.UTC(2026, 9, 27, 15, 40);
    const at = momentClock(
      { kind: 'ahead', tick: 1000 + 40 * 1800, minutes: 40, issue: null },
      1000,
      now,
    );
    expect(at).toBe(Date.UTC(2026, 9, 27, 16, 20));
    expect(clockText(at, 'en-US', 'UTC')).toBe('4:20 PM');
    expect(clockText(at, 'en-GB', 'UTC')).toBe('16:20');
  });
});
