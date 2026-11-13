// SPDX-License-Identifier: AGPL-3.0-only

// A log's answer is one small page on a phone's data: a week of days at
// their fullest, with the collection and the record, under 20 KB of JSON.

import { expect, test } from 'vitest';
import { longLog } from './logs';

test('a page of days at its fullest is under 20 KB of JSON', () => {
  const bytes = new TextEncoder().encode(JSON.stringify(longLog())).length;
  expect(bytes).toBeLessThan(20 * 1024);
});
