// SPDX-License-Identifier: AGPL-3.0-only

// The boat's motion's sounds, from scripted physics: a slap each time the
// bow, having fallen fast enough, turns and rises, louder the harder it
// fell and the faster the hull dropped, and none in a gentle swell, none in
// a light breeze's short sea (as the boats pitch in the sandbox's), and
// none more often than the least gap; the sheet in a tack and the boom in a gybe as
// the boom crosses the centreline, and nothing while it hangs there.

import { describe, expect, test } from 'vitest';
import { MIX } from './mix';
import { SailWatch, type Slap, SlapWatch } from './motion';

/** The slaps of a boat pitching as a sine of amplitude a (rad) and period T (s), heaving h (m) with it, over seconds, sampled every 50 ms. */
function slapsOf(a: number, T: number, h: number, seconds: number): { at: number; slap: Slap }[] {
  const w = new SlapWatch(MIX.slaps);
  const out: { at: number; slap: Slap }[] = [];
  const omega = (2 * Math.PI) / T;
  for (let t = 0; t <= seconds; t += 0.05) {
    // Pitch a·sin(ωt): its rate a·ω·cos(ωt); the hull drops as the bow
    // does, a quarter turn behind.
    const pitchRate = a * omega * Math.cos(omega * t);
    const heaveRate = h * omega * Math.cos(omega * t - 0.4);
    const slap = w.step(pitchRate, heaveRate, t);
    if (slap !== null) {
      out.push({ at: t, slap });
    }
  }
  return out;
}

describe('the slaps', () => {
  test('one each time the bow turns from falling to rising, in a sea that makes it fall fast', () => {
    // 12° of pitch every 3 s: a peak rate of 0.44 rad/s.
    const s = slapsOf((12 * Math.PI) / 180, 3, 0.4, 30);
    expect(s.length).toBeGreaterThanOrEqual(9);
    expect(s.length).toBeLessThanOrEqual(10);
    // Each where the bow turns up: at the troughs, ¾ of a period in.
    for (const { at } of s) {
      const phase = (at / 3) % 1;
      expect(Math.abs(phase - 0.75), String(at)).toBeLessThan(0.03);
    }
  });

  test('none in a gentle swell', () => {
    // 1° every 6 s: 0.018 rad/s at most.
    expect(slapsOf(Math.PI / 180, 6, 0.3, 60)).toHaveLength(0);
  });

  test('none in a light breeze’s short sea, where a small boat pitches fast but little', () => {
    // 2° every 1.5 s: 0.15 rad/s at most, as a skiff pitches at 12 knots.
    expect(slapsOf((2 * Math.PI) / 180, 1.5, 0.1, 60)).toHaveLength(0);
  });

  test('louder the harder the bow fell, and the faster the hull dropped', () => {
    const level = (a: number, h: number): number => slapsOf(a, 3, h, 10)[0]?.slap.level ?? 0;
    const small = level((8 * Math.PI) / 180, 0.4);
    const big = level((14 * Math.PI) / 180, 0.4);
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    const still = level((14 * Math.PI) / 180, 0);
    const dropping = level((14 * Math.PI) / 180, 1);
    expect(dropping).toBeGreaterThan(still);
    expect(still).toBeCloseTo(dropping * (1 - MIX.slaps.heave), 6);
    expect(dropping).toBeLessThanOrEqual(MIX.slaps.level);
  });

  test('never closer than the least gap, however short the sea', () => {
    const s = slapsOf((10 * Math.PI) / 180, 0.5, 0.4, 10);
    for (let i = 1; i < s.length; i++) {
      expect((s[i]?.at ?? 0) - (s[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(MIX.slaps.least - 1e-9);
    }
  });

  test('each slap its own seed', () => {
    const s = slapsOf((12 * Math.PI) / 180, 3, 0.4, 12);
    expect(new Set(s.map((x) => x.slap.seed)).size).toBe(s.length);
  });
});

describe('the sail crossing', () => {
  const deg = Math.PI / 180;

  test('the sheet runs in a tack: the boom crosses with the wind forward of the beam', () => {
    const w = new SailWatch(MIX.sail);
    expect(w.step(20 * deg, -0.3, 40 * deg, 8)).toBeNull();
    // Through the eye of the wind: the boom on the centreline, nothing.
    expect(w.step(1 * deg, -0.3, 2 * deg, 8)).toBeNull();
    const s = w.step(-20 * deg, -0.3, -40 * deg, 8);
    expect(s?.kind).toBe('sheet');
    expect(s?.level ?? 0).toBeGreaterThan(0);
    // Settled on the new side: nothing more.
    expect(w.step(-25 * deg, 0, -45 * deg, 8)).toBeNull();
  });

  test('the boom thumps in a gybe, the harder the faster it swings', () => {
    const gybe = (rate: number): number => {
      const w = new SailWatch(MIX.sail);
      w.step(-70 * deg, 0, -160 * deg, 8);
      return w.step(60 * deg, rate, 170 * deg, 8)?.level ?? 0;
    };
    expect(gybe(0.1)).toBe(0);
    expect(gybe(1)).toBeGreaterThan(0);
    expect(gybe(2.5)).toBeGreaterThan(gybe(1));
    const w = new SailWatch(MIX.sail);
    w.step(-70 * deg, 0, -160 * deg, 8);
    expect(w.step(60 * deg, 2, 170 * deg, 8)?.kind).toBe('boom');
  });

  test('nothing for a boom never seen on a side, nor hanging on the centreline', () => {
    const w = new SailWatch(MIX.sail);
    for (let i = 0; i < 20; i++) {
      expect(w.step((i % 2 ? 1 : -1) * 0.5 * deg, 0.2, 0, 1)).toBeNull();
    }
    expect(w.step(Number.NaN, 0, 0, 1)).toBeNull();
  });
});
