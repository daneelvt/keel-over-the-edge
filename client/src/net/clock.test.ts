// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { Clock } from './clock';

// Two minutes of an old world's Pongs, then a new world's at the same round
// trips: the clock, reset as a Welcome to another world resets it, tells
// the new world's time from its first Pong; kept, the old world's samples
// would hold it at the old world's age.
describe('the clock through a new world', () => {
  const rtts = [40_000, 90_000, 35_000, 120_000, 60_000, 38_000, 200_000, 45_000];
  function oldWorld(c: Clock, oldAge: number): number {
    let now = 1_000_000_000;
    for (let i = 0; i < 1200; i++) {
      const rtt = rtts[i % rtts.length] ?? 50_000;
      const sent = now - rtt;
      c.sample(sent, oldAge + sent + rtt / 2 - 5_000_000_000 + 1_000_000_000, now);
      now += 100_000;
    }
    return now;
  }
  test('reset: right from the first Pong', () => {
    const c = new Clock();
    const oldAge = 3_600_000_000;
    let now = oldWorld(c, oldAge);
    c.reset();
    // The new world began a second ago, by the server's clock.
    const begun = now - 1_000_000;
    c.welcome(now - begun, now);
    for (let i = 0; i < 8; i++) {
      const rtt = rtts[i] ?? 50_000;
      const sent = now - rtt;
      c.sample(sent, sent + rtt / 2 - begun, now);
      expect(Math.abs(c.worldUs(now) - (now - begun))).toBeLessThan(100_000);
      now += 100_000;
    }
  });
  test('kept: wrong by the old world’s age', () => {
    const c = new Clock();
    const oldAge = 3_600_000_000;
    let now = oldWorld(c, oldAge);
    const begun = now - 1_000_000;
    const rtt = rtts[0] ?? 50_000;
    const sent = now - rtt;
    c.sample(sent, sent + rtt / 2 - begun, now);
    now += 100_000;
    expect(Math.abs(c.worldUs(now) - (now - begun))).toBeGreaterThan(60_000_000);
  });
});
