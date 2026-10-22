// SPDX-License-Identifier: AGPL-3.0-only

// The slider's lettering: the moment shown and the issue's age.

import { describe, expect, test } from 'vitest';
import { ageText, momentText } from './chartweather';

describe('the slider’s lettering', () => {
  test('now, a forecast step ahead, or what happened before', () => {
    expect(momentText({ kind: 'now', tick: 0, issue: null, step: 0 }, 10)).toBe('Now');
    expect(momentText({ kind: 'forecast', tick: 0, issue: null, step: 3 }, 10)).toBe(
      'Forecast · +30 min',
    );
    expect(momentText({ kind: 'past', tick: 0, issue: null, step: -4 }, 10)).toBe(
      'What happened · −40 min',
    );
  });

  test('the issue’s age in whole minutes', () => {
    expect(ageText(1800 * 10, 1800 * 10 + 1799)).toBe('issued just now');
    expect(ageText(1800 * 10, 1800 * 16)).toBe('issued 6 min ago');
    expect(ageText(1800 * 10, 0)).toBe('issued just now');
  });
});
