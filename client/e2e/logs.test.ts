// SPDX-License-Identifier: AGPL-3.0-only

// A log's answer is one small page on a phone's data: a week of days at
// their fullest, with the collection, the record and the races counted,
// under 20 KB of JSON; and the Ribbons tab reads its races a page at a
// time, each page at its fullest under 20 KB too. The Certificates tab
// reads its own part, which is small: every certificate held with the
// tasks that counted, and the last one's tasks with how far each has come.

import { expect, test } from 'vitest';
import { RIBBONS_PAGE } from '../src/ui/logapi';
import { certificatesOf, longLog, masterLog, ribbonsPage } from './logs';

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

test('a page of days at its fullest is under 20 KB of JSON', () => {
  expect(size(longLog())).toBeLessThan(20 * 1024);
});

test('a page of ribbons at its fullest is under 20 KB of JSON', () => {
  const page = ribbonsPage(Date.now());
  expect(page.races).toHaveLength(RIBBONS_PAGE);
  expect(page.more).toBe(true);
  expect(size(page)).toBeLessThan(20 * 1024);
  expect(ribbonsPage(Date.now(), RIBBONS_PAGE).more).toBeUndefined();
});

test('a log’s certificates at their fullest are under 2 KB of JSON, and the log carries none of them', () => {
  const log = longLog();
  const part = certificatesOf(log);
  expect(part.certificates).toHaveLength(4);
  expect(part.toward?.tasks.some((t) => 'closest' in t)).toBe(true);
  expect(size(part)).toBeLessThan(2 * 1024);
  expect(size(certificatesOf(masterLog()))).toBeLessThan(2 * 1024);
  expect('certificates' in log).toBe(false);
  expect(log.toward.tasks.some((t) => 'have' in t || 'closest' in t)).toBe(false);
});
