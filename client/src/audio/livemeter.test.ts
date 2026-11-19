// SPDX-License-Identifier: AGPL-3.0-only

// The sound room's meter, fed in blocks, reads as the meter of the whole
// does: a 1 kHz sine of peak 0.1 in both channels at −20 LUFS (EBU Tech
// 3341's first case, shifted), the same whatever the blocks' size; its
// true peak; and a high tone's energy all above 2 kHz, a low one's none.

import { describe, expect, test } from 'vitest';
import { LiveMeter } from './livemeter';
import { measure } from './loudness';

const RATE = 48000;

function sine(f: number, a: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) {
    x[i] = a * Math.sin((2 * Math.PI * f * i) / RATE);
  }
  return x;
}

function feed(m: LiveMeter, x: Float32Array, block: number): void {
  for (let at = 0; at < x.length; at += block) {
    const part = x.subarray(at, Math.min(x.length, at + block));
    m.push([part, part]);
  }
}

describe('the live meter', () => {
  test('reads a 1 kHz sine as the meter of the whole does, whatever the blocks', () => {
    const x = sine(1000, 0.1, 10);
    const whole = measure([x, x], RATE);
    for (const block of [128, 4096, 3000]) {
      const m = new LiveMeter(RATE);
      feed(m, x, block);
      expect(m.integrated, String(block)).toBeCloseTo(whole.integrated, 2);
      expect(m.integrated).toBeCloseTo(-20, 1);
      expect(m.shortTerm).toBeCloseTo(-20, 1);
      expect(m.momentary).toBeCloseTo(-20, 1);
      expect(m.truePeak).toBeCloseTo(-20, 0);
      expect(m.seconds).toBeCloseTo(10, 6);
    }
  });

  test('the share above 2 kHz: a 4 kHz tone all, a 500 Hz one none', () => {
    const high = new LiveMeter(RATE);
    feed(high, sine(4000, 0.1, 2), 4096);
    expect(high.above).toBeGreaterThan(0.99);
    const low = new LiveMeter(RATE);
    feed(low, sine(500, 0.1, 2), 4096);
    expect(low.above).toBeLessThan(0.01);
  });

  test('forgets on a reset', () => {
    const m = new LiveMeter(RATE);
    feed(m, sine(1000, 0.5, 2), 4096);
    m.reset();
    expect(m.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(m.truePeak).toBe(Number.NEGATIVE_INFINITY);
    feed(m, sine(1000, 0.1, 2), 4096);
    expect(m.integrated).toBeCloseTo(-20, 1);
  });
});
