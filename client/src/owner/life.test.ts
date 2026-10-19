// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { brief, countdown, inZone, serverNow, serverOffset, threeZones, zoneName } from './life';

/** Sunday 1 November 2026, 23:00 UTC: 6 pm in New York, noon on Monday in Auckland. */
const END = Date.UTC(2026, 10, 1, 23, 0);

describe("the world's life", () => {
  test('counts down in days, hours, minutes and seconds, never below nought', () => {
    expect(countdown(((4 * 24 + 6) * 3600 + 12 * 60 + 9) * 1000 + 400)).toBe('4d 06:12:09');
    expect(countdown(59_999)).toBe('0d 00:00:59');
    expect(countdown(0)).toBe('0d 00:00:00');
    expect(countdown(-5000)).toBe('0d 00:00:00');
  });

  test("counts by keel's clock, not the page's", () => {
    // Keel's clock 90 s ahead of the page's, the answer taking 200 ms.
    const local = 1_000_000;
    const offset = serverOffset(local + 100 + 90_000, local, local + 200);
    expect(offset).toBe(90_000);
    const ends = local + 90_000 + 3_600_000;
    expect(countdown(ends - serverNow(offset, local + 1000))).toBe('0d 00:59:59');
  });

  test("names a zone's time as its people do, or by its offset", () => {
    expect(zoneName(END, 'America/New_York')).toBe('EST');
    expect(zoneName(Date.UTC(2026, 6, 1), 'America/New_York')).toBe('EDT');
    expect(zoneName(END, 'Pacific/Auckland')).toBe('NZDT');
    expect(zoneName(END, 'UTC')).toBe('UTC');
    expect(zoneName(END, 'Asia/Tokyo')).toBe('GMT+9');
  });

  test("tells a moment in the schedule's zone, UTC and the owner's", () => {
    expect(inZone(END, 'America/New_York')).toBe('Sunday 1 November, 6:00 pm EST');
    expect(threeZones(END, 'America/New_York', 'Pacific/Auckland')).toBe(
      'Sunday 1 November, 6:00 pm EST · 23:00 UTC · Monday 12:00 NZDT',
    );
    // The owner in the schedule's zone, or a schedule of periods: each zone once.
    expect(threeZones(END, 'America/New_York', 'America/New_York')).toBe(
      'Sunday 1 November, 6:00 pm EST · 23:00 UTC',
    );
    expect(threeZones(END, '', 'Europe/London')).toBe('Sunday 1 November, 23:00 UTC · 23:00 GMT');
  });

  test('a moment in a few words', () => {
    expect(brief(END, 'UTC')).toBe('Sun 1 Nov, 23:00');
    expect(brief(0)).toBe('—');
  });
});
