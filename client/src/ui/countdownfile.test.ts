// SPDX-License-Identifier: AGPL-3.0-only

// The countdown is the server's: for every time left of
// internal/lookout/testdata/countdown.json the same words, in English, and
// every end written alike in its schedule's zone.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { endText, leftText } from './countdown';

interface CountdownFile {
  left: { ms: number; text: string }[];
  ends: { ends: number; zone: string; text: string }[];
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/countdown.json', import.meta.url),
    'utf8',
  ),
) as CountdownFile;

describe('the countdown', () => {
  test('reads as the server reads it', () => {
    expect(file.left.length).toBeGreaterThan(20);
    for (const c of file.left) {
      expect(leftText(c.ms, 'en'), `${c.ms} ms`).toBe(c.text);
    }
  });

  test('tells the end as the server tells it, in the schedule’s zone', () => {
    for (const c of file.ends) {
      const zone = c.zone === '' ? 'UTC' : c.zone;
      expect(endText(c.ends, c.zone, 'en-US', zone), `${c.ends} in ${zone}`).toBe(c.text);
    }
  });
});
