// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { QUALITY_VERSION } from '../ocean/look';
import {
  Adaptive,
  type Display,
  FLOOR_LINES,
  type FrameWindow,
  floorRatio,
  forget,
  ladder,
  MAX_WAIT,
  pixelRatioOf,
  type Rung,
  remember,
  remembered,
  rungName,
  type Store,
  startQuality,
  TIERS,
  type TierName,
  topRatio,
  topTier,
  WAIT,
} from './quality';

function store(initial: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const none = new URLSearchParams();

describe('the tiers', () => {
  it('start by back end: high on WebGPU, medium in compatibility mode, low on WebGL 2', () => {
    expect(topTier('webgpu', false)).toBe('high');
    expect(topTier('webgpu', true)).toBe('medium');
    expect(topTier('webgl2', false)).toBe('low');
    expect(startQuality('webgpu', false, none, 'auto', null)).toMatchObject({
      top: 'high',
      index: 0,
      adaptive: true,
    });
    expect(startQuality('webgpu', true, none, 'auto', null).top).toBe('medium');
    expect(startQuality('webgl2', false, none, 'auto', null).top).toBe('low');
  });

  it('never build a transform a compatibility device cannot run', () => {
    // 256 texels a side need a workgroup of 256, and compatibility mode has 128.
    for (const r of ladder('medium')) {
      expect(r.detail.kind === 'fft' ? r.detail.size : 0).toBeLessThanOrEqual(128);
    }
    for (const r of ladder('low')) {
      expect(r.detail.kind).toBe('baked');
    }
  });

  it('are fixed by ?tier, no better than the back end’s, with adaptive quality off', () => {
    const q = (tier: string) => new URLSearchParams(`tier=${tier}`);
    expect(startQuality('webgpu', false, q('medium'), 'auto', null)).toMatchObject({
      top: 'medium',
      index: 0,
      adaptive: false,
    });
    expect(startQuality('webgpu', false, q('low'), 'auto', null).top).toBe('low');
    expect(startQuality('webgl2', false, q('high'), 'auto', null).top).toBe('low');
    expect(startQuality('webgpu', true, q('high'), 'auto', null).top).toBe('medium');
    expect(startQuality('webgpu', false, q('best'), 'auto', null).adaptive).toBe(true);
  });

  it('start on the low tier when the player asks for it', () => {
    const s = startQuality('webgpu', false, none, 'low', null);
    expect(s.top).toBe('low');
    expect(s.adaptive).toBe(true);
    expect(s.ladder.every((r) => r.tier === 'low')).toBe(true);
  });

  it('start where the device settled, if this build and this ladder remembered it', () => {
    const s = store();
    remember(s, 'high', 5);
    expect(remembered(s, 'high', ladder('high').length)).toBe(5);
    expect(startQuality('webgpu', false, none, 'auto', s).index).toBe(5);
    // Another ladder: the compatibility device's, or the player's low.
    expect(startQuality('webgpu', true, none, 'auto', s).index).toBe(0);
    expect(startQuality('webgpu', false, none, 'low', s).index).toBe(0);
    // Another build's.
    const old = store({
      'keel.quality': JSON.stringify({ version: QUALITY_VERSION + 1, top: 'high', index: 5 }),
    });
    expect(startQuality('webgpu', false, none, 'auto', old).index).toBe(0);
    // Nonsense, and a rung the ladder does not have.
    expect(remembered(store({ 'keel.quality': '{' }), 'high', 14)).toBe(-1);
    expect(remembered(store({ 'keel.quality': '7' }), 'high', 14)).toBe(-1);
    remember(s, 'high', 99);
    expect(remembered(s, 'high', ladder('high').length)).toBe(-1);
    // A store that refuses is no store.
    const refusing: Store = {
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('refused');
      },
    };
    remember(refusing, 'high', 2);
    expect(remembered(refusing, 'high', 14)).toBe(-1);
    forget(refusing);
  });

  it('remember the half rate below the last rung, and forget on asking', () => {
    const s = store();
    const length = ladder('high').length;
    remember(s, 'high', length);
    expect(startQuality('webgpu', false, none, 'auto', s).index).toBe(length);
    forget(s);
    expect(startQuality('webgpu', false, none, 'auto', s).index).toBe(0);
  });
});

describe('the ladder', () => {
  const names = (rungs: Rung[]) => rungs.map(rungName);
  const TOPS: TierName[] = ['high', 'medium', 'low'];
  const DPRS = [1, 1.25, 1.5, 2, 3];
  /** Shorter sides of displays, CSS pixels: phones, laptops, desktops, a 4K screen at 1. */
  const SHORTS = [320, 360, 412, 480, 600, 720, 768, 800, 900, 1080, 1440, 2160];

  it('goes down by the render scale, then the shadows, then the detail, then the tier below', () => {
    expect(names(ladder('high'))).toEqual([
      'high at 0/6, shadows, 256² × 2',
      'high at 1/6, shadows, 256² × 2',
      'high at 2/6, shadows, 256² × 2',
      'high at 3/6, shadows, 256² × 2',
      'high at 3/6, 256² × 2',
      'high at 3/6, 256²',
      'medium at 3/6, 128²',
      'medium at 4/6, 128²',
      'medium at 5/6, 128²',
      'low at 5/6, loop',
      'low at 6/6, loop',
    ]);
    expect(names(ladder('medium'))).toEqual([
      'medium at 0/6, shadows, 128²',
      'medium at 1/6, shadows, 128²',
      'medium at 2/6, shadows, 128²',
      'medium at 3/6, shadows, 128²',
      'medium at 4/6, shadows, 128²',
      'medium at 5/6, shadows, 128²',
      'medium at 5/6, 128²',
      'low at 5/6, loop',
      'low at 6/6, loop',
    ]);
    expect(names(ladder('low'))).toEqual([
      'low at 0/6, loop',
      'low at 1/6, loop',
      'low at 2/6, loop',
      'low at 3/6, loop',
      'low at 4/6, loop',
      'low at 5/6, loop',
      'low at 6/6, loop',
    ]);
  });

  it('never draws more pixels on a rung than on the one above it, on any display', () => {
    for (const top of TOPS) {
      const rungs = ladder(top);
      for (const dpr of DPRS) {
        for (const short of SHORTS) {
          const d: Display = { dpr, short };
          const ratios = rungs.map((r) => pixelRatioOf(top, r, d));
          for (let i = 1; i < ratios.length; i++) {
            expect(ratios[i], `${top} at ${dpr}, ${short} px, rung ${i}`).toBeLessThanOrEqual(
              (ratios[i - 1] as number) + 1e-12,
            );
          }
          // From the display's own ratio, no more than the tier's, to the floor.
          expect(ratios[0]).toBeCloseTo(topRatio(top, dpr), 12);
          expect(ratios.at(-1)).toBeCloseTo(floorRatio(top, d), 12);
          // A tier below starts where the one above ended.
          for (let i = 1; i < rungs.length; i++) {
            if (rungs[i]?.tier !== rungs[i - 1]?.tier) {
              expect(ratios[i]).toBeCloseTo(ratios[i - 1] as number, 12);
            }
          }
        }
      }
    }
  });

  it('goes down to half the display’s pixels a side, never under 540 lines', () => {
    const lines = (top: TierName, dpr: number, short: number) =>
      floorRatio(top, { dpr, short }) * short;
    // A 1,920 × 1,080 laptop: half its pixels a side is 540 lines.
    expect(floorRatio('high', { dpr: 1, short: 1080 })).toBe(0.5);
    expect(lines('high', 1, 1080)).toBeCloseTo(FLOOR_LINES, 9);
    // A 1,366 × 768 one: half would be 384 lines, so 540.
    expect(lines('high', 1, 768)).toBeCloseTo(FLOOR_LINES, 9);
    expect(floorRatio('low', { dpr: 1, short: 768 })).toBeCloseTo(0.703, 3);
    // A 2,560 × 1,440 screen: half its pixels, 720 lines.
    expect(lines('high', 1, 1440)).toBe(720);
    // A 4K screen at 2: 1,080 CSS pixels at a ratio of a half, 540 lines.
    expect(floorRatio('high', { dpr: 2, short: 1080 })).toBe(0.5);
    // A phone, upright or turned: its shorter side is 360, so 540 lines are
    // a ratio of 1.5 of its 3, below the high tier's 2.
    expect(floorRatio('high', { dpr: 3, short: 360 })).toBe(1.5);
    expect(lines('high', 3, 360)).toBe(FLOOR_LINES);
    // A short phone at 2: 540 of its 640 lines.
    expect(lines('high', 2, 320)).toBeCloseTo(FLOOR_LINES, 9);
    // A display of fewer lines than 540 draws at its own, with no steps.
    expect(floorRatio('low', { dpr: 1, short: 480 })).toBe(1);
    const flat = ladder('low').map((r) => pixelRatioOf('low', r, { dpr: 1, short: 480 }));
    expect(new Set(flat)).toEqual(new Set([1]));
    // Not known: half a side.
    expect(floorRatio('high', { dpr: 1, short: 0 })).toBe(0.5);
  });

  it('draws at the display’s pixel ratio at the top, no more than the tier’s', () => {
    const [top] = ladder('high');
    const d = (dpr: number): Display => ({ dpr, short: 1080 });
    expect(pixelRatioOf('high', top as Rung, d(3))).toBe(2);
    expect(pixelRatioOf('high', top as Rung, d(1.25))).toBe(1.25);
    expect(pixelRatioOf('high', top as Rung, d(0.5))).toBe(1);
    expect(pixelRatioOf('medium', ladder('medium')[0] as Rung, d(3))).toBe(1.5);
    expect(pixelRatioOf('low', ladder('low')[0] as Rung, d(3))).toBe(1);
    // Each step takes the same share of the pixels away.
    const ratios = ladder('low').map((r) => pixelRatioOf('low', r, d(1)));
    for (let i = 1; i < ratios.length; i++) {
      expect((ratios[i] as number) / (ratios[i - 1] as number)).toBeCloseTo(0.5 ** (1 / 6), 12);
    }
  });

  it('keeps the tiers’ values as the table has them', () => {
    expect(TIERS.high).toMatchObject({ scale: 2, foamMap: 512, shadowMap: 1024, spray: 512 });
    expect(TIERS.medium).toMatchObject({ scale: 1.5, foamMap: 512, shadowMap: 1024, spray: 512 });
    expect(TIERS.low).toMatchObject({ scale: 1, foamMap: 256, shadowMap: 0, spray: 96 });
    expect([TIERS.low.number, TIERS.medium.number, TIERS.high.number]).toEqual([1, 2, 3]);
  });
});

describe('adaptive quality, in fake time', () => {
  const at60 = 1000 / 60;
  const at30 = 1000 / 30;
  const good = (over: Partial<FrameWindow> = {}): FrameWindow => ({
    frames: 120,
    p90: at60 + 0.3,
    interval: at60,
    work: 2,
    ...over,
  });
  /** Frames held for two refreshes, not quite twice the interval: a rung at a time. */
  const slow = (over: Partial<FrameWindow> = {}): FrameWindow => good({ p90: 1.8 * at60, ...over });

  /** Feeds windows of 2 s from t on, n of them; returns the steps taken and the time after. */
  function feed(a: Adaptive, t: number, n: number, w: FrameWindow): [number[], number] {
    const steps: number[] = [];
    for (let i = 0; i < n; i++) {
      t += 2000;
      const to = a.window(t, w);
      if (to !== null) {
        steps.push(to);
        a.quiet(t);
      }
    }
    return [steps, t];
  }

  /** Adaptive quality on a 1,920 × 1,080 laptop, which knows each rung's pixels. */
  function onLaptop(top: TierName, index: number): Adaptive {
    const a = new Adaptive(ladder(top), index);
    a.ratioOf = (r) => pixelRatioOf(top, r, { dpr: 1, short: 1080 });
    return a;
  }

  it('steps down after two slow windows, not after one', () => {
    const a = new Adaptive(ladder('high'), 0);
    expect(a.window(2000, slow())).toBeNull();
    expect(a.window(4000, good())).toBeNull();
    expect(a.window(6000, slow())).toBeNull();
    expect(a.index).toBe(0);
    expect(a.window(8000, slow())).toBe(1);
    expect(a.index).toBe(1);
    expect(a.log.at(-1)).toMatchObject({ from: 0, to: 1, why: 'slow' });
  });

  it('goes down the ladder in order while it stays slow, to the half rate, and stops there', () => {
    const rungs = ladder('high');
    const a = new Adaptive(rungs, 0);
    const [steps] = feed(a, 0, 200, slow());
    expect(steps).toEqual(rungs.map((_, i) => i + 1));
    expect(a.index).toBe(rungs.length);
    expect(a.halved).toBe(true);
    expect(a.rung).toBe(rungs.at(-1));
  });

  it('steps by the ratio of a window twice as slow as the cap, or more, in one step', () => {
    // Twice: half the pixels, the high tier's last scale.
    const a = onLaptop('high', 0);
    expect(feed(a, 0, 2, good({ p90: 2 * at60 }))[0]).toEqual([3]);
    expect(a.ratioOf?.(a.rung)).toBeCloseTo(Math.SQRT1_2, 12);
    // Three times: a third of them or fewer, the medium tier's 5/6.
    const b = onLaptop('high', 0);
    expect(feed(b, 0, 2, good({ p90: 3 * at60 }))[0]).toEqual([8]);
    expect(b.ratioOf?.(b.rung) ?? 1).toBeLessThanOrEqual(Math.sqrt(1 / 3));
    // By the lesser of the two slow windows.
    const c = onLaptop('high', 0);
    expect(c.window(2000, good({ p90: 3 * at60 }))).toBeNull();
    expect(c.window(4000, good({ p90: 2 * at60 }))).toBe(3);
    // More than the ladder holds: its last rung, and the half rate only after two windows more.
    const d = onLaptop('high', 0);
    expect(feed(d, 0, 2, good({ p90: 10 * at60 }))[0]).toEqual([10]);
    expect(d.halved).toBe(false);
    expect(feed(d, 10_000, 2, good({ p90: 10 * at60 }))[0]).toEqual([11]);
    expect(d.halved).toBe(true);
    // Under twice: a rung at a time.
    const e = onLaptop('high', 0);
    expect(feed(e, 0, 2, good({ p90: 1.5 * at60 }))[0]).toEqual([1]);
  });

  it('passes over rungs that draw alike on this display', () => {
    // A display of 480 lines has no steps of the scale.
    const a = new Adaptive(ladder('high'), 0);
    a.ratioOf = (r) => pixelRatioOf('high', r, { dpr: 1, short: 480 });
    expect(feed(a, 0, 2, slow())[0]).toEqual([4]);
    expect(feed(a, 10_000, 2, slow())[0]).toEqual([5]);
    expect(feed(a, 20_000, 2, slow())[0]).toEqual([6]);
    expect(feed(a, 30_000, 2, slow())[0]).toEqual([9]);
    expect(feed(a, 40_000, 2, slow())[0]).toEqual([10]);
    // And up again, to the top of those alike at once.
    const b = new Adaptive(ladder('high'), 4);
    b.ratioOf = a.ratioOf;
    expect(feed(b, 0, 6, good())[0]).toEqual([0]);
  });

  it('halves the rate on the last rung, holds it, and tries the full rate again', () => {
    const rungs = ladder('low');
    const last = rungs.length - 1;
    const a = new Adaptive(rungs, last);
    // Two slow windows on the last rung: half the display's rate.
    expect(feed(a, 0, 1, slow())[0]).toEqual([]);
    let [steps, t] = feed(a, 2000, 1, slow());
    expect(steps).toEqual([rungs.length]);
    expect(a.halved).toBe(true);
    // Even at 30, with the main thread busy: held.
    [steps, t] = feed(a, t, 20, good({ p90: at30 + 0.4, interval: at30, work: 9 }));
    expect(steps).toEqual([]);
    // Even at 30 with time to spare: after the wait, the full rate is tried.
    [steps, t] = feed(a, t, 6, good({ p90: at30 + 0.4, interval: at30 }));
    expect(steps).toEqual([last]);
    expect(a.halved).toBe(false);
    expect(a.log.at(-1)).toMatchObject({ from: rungs.length, to: last, why: 'comfortable' });
    // Too slow for it: back to 30 within two windows, and the next try waits twice as long.
    [steps, t] = feed(a, t, 2, slow());
    expect(steps).toEqual([rungs.length]);
    expect(a.wait).toBe(2 * WAIT);
    [steps, t] = feed(a, t, 10, good({ p90: at30 + 0.4, interval: at30 }));
    expect(steps).toEqual([last]);
    // This time it holds, the main thread busy: the full rate stays, and the wait starts over.
    [steps, t] = feed(a, t, 15, good({ work: 8 }));
    expect(steps).toEqual([]);
    expect(a.halved).toBe(false);
    expect(a.wait).toBe(WAIT);
  });

  it('leaves the rate to the menu’s 30 and to a display of 30 Hz', () => {
    const rungs = ladder('low');
    const last = rungs.length - 1;
    // The menu's 30: nothing lower than the last rung.
    const a = new Adaptive(rungs, last);
    a.halvable = false;
    expect(a.bottom).toBe(last);
    expect(feed(a, 0, 10, slow({ interval: at30, p90: 1.8 * at30 }))[0]).toEqual([]);
    expect(a.halved).toBe(false);
    // Halved, then the menu's 30 is chosen: the last rung at the menu's rate.
    const b = new Adaptive(rungs, rungs.length);
    expect(b.halved).toBe(true);
    b.halvable = false;
    expect(b.halved).toBe(false);
    feed(b, 0, 1, good({ interval: at30, p90: at30 }));
    expect(b.index).toBe(last);
  });

  it('steps up after ten comfortable seconds, by the same ladder', () => {
    const a = new Adaptive(ladder('high'), 3);
    // The first window has no length yet; five more are ten seconds.
    const [steps, t] = feed(a, 0, 6, good());
    expect(steps).toEqual([2]);
    expect(t).toBe(12_000);
    const [more] = feed(a, t, 30, good());
    expect(more).toEqual([1, 0]);
    expect(a.index).toBe(0);
  });

  it('does not step up while the main thread is busy, and needs no GPU time to', () => {
    const a = new Adaptive(ladder('high'), 3);
    // Within the cap, but the main thread's work is over its budget.
    expect(feed(a, 0, 20, good({ work: 7 }))[0]).toEqual([]);
    // Within the cap and its budget: room above is found by trying.
    expect(feed(a, 40_000, 7, good({ work: 3 }))[0]).toEqual([2]);
  });

  it('doubles the wait when a step up is undone, to a cap, and starts over when one holds', () => {
    const a = new Adaptive(ladder('high'), 3);
    let t = 0;
    const waits: number[] = [];
    for (let round = 0; round < 8; round++) {
      // Comfortable until it steps up; then the step proves too much.
      let up: number[] = [];
      while (up.length === 0) {
        [up, t] = feed(a, t, 1, good());
      }
      expect(a.index).toBe(2);
      let down: number[] = [];
      [down, t] = feed(a, t, 3, slow());
      expect(down).toEqual([3]);
      waits.push(a.wait);
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 32, 32, 32].map((k) => Math.min(k * WAIT, MAX_WAIT)));
    // A step up that holds for 20 s: the wait is ten seconds again.
    let up: number[] = [];
    while (up.length === 0) {
      [up, t] = feed(a, t, 1, good());
    }
    [, t] = feed(a, t, 4, good({ work: 8 }));
    [, t] = feed(a, t, 8, good({ work: 8 }));
    expect(a.wait).toBe(WAIT);
    expect(a.index).toBe(2);
  });

  it('does not call a 30 Hz display slow, nor the battery saver', () => {
    // Low Power Mode: the display refreshes every 33 ms, and so does the cap.
    const a = new Adaptive(ladder('high'), 0);
    expect(feed(a, 0, 20, good({ p90: 33.6, interval: at30 }))[0]).toEqual([]);
    // And a frame that takes two refreshes of a 60 Hz display is.
    expect(feed(a, 40_000, 2, good({ p90: 33.6 }))[0]).toEqual([1]);
  });

  it('says when it has judged the device where it is', () => {
    const a = onLaptop('high', 0);
    expect(a.settled).toBe(false);
    a.window(500, good());
    expect(a.settled).toBe(true);
    a.window(1000, good({ p90: 3 * at60 }));
    expect(a.settled).toBe(false);
    expect(a.window(1500, good({ p90: 3 * at60 }))).toBe(8);
    expect(a.settled).toBe(false);
    a.window(2000, good());
    expect(a.settled).toBe(true);
    // At the bottom, a slow window leaves nowhere to go.
    const b = onLaptop('low', 7);
    b.window(500, slow());
    expect(b.settled).toBe(true);
    // Off, it has nothing to judge.
    const c = onLaptop('high', 0);
    c.enabled = false;
    expect(c.settled).toBe(true);
  });

  it('counts nothing for a second after a change, nor while told to be quiet', () => {
    const a = new Adaptive(ladder('high'), 0);
    a.quiet(10_000);
    expect(a.window(10_500, slow())).toBeNull();
    expect(a.window(10_900, slow())).toBeNull();
    expect(a.index).toBe(0);
    // A shader still compiling: quiet until it is in.
    a.quiet(11_000, 15_000);
    expect(a.window(13_000, slow())).toBeNull();
    expect(a.window(14_900, slow())).toBeNull();
    expect(a.window(17_000, slow())).toBeNull();
    expect(a.window(19_000, slow())).toBe(1);
    // The render target's size alone: the next window counts.
    a.quiet(20_000, Number.POSITIVE_INFINITY);
    a.unquiet(20_000, 0);
    expect(a.window(20_500, slow())).toBeNull();
    expect(a.window(21_000, slow())).toBe(2);
  });

  it('counts no window with a handful of frames (a hidden page), and nothing when off', () => {
    const a = new Adaptive(ladder('high'), 0);
    expect(feed(a, 0, 10, slow({ frames: 2 }))[0]).toEqual([]);
    a.enabled = false;
    expect(feed(a, 20_000, 10, slow())[0]).toEqual([]);
    a.set(50_000, 4, 'panel');
    expect(a.index).toBe(4);
    expect(a.log.at(-1)).toMatchObject({ from: 0, to: 4, why: 'panel' });
    a.set(50_000, 400);
    expect(a.index).toBe(a.bottom);
    expect(a.nameOf(4)).toBe('high at 3/6, 256² × 2');
    expect(a.nameOf(a.ladder.length)).toBe('low at 6/6, loop, at half the rate');
  });

  it('forgets a slow window when a quiet spell comes between two', () => {
    const a = new Adaptive(ladder('high'), 0);
    expect(a.window(2000, slow())).toBeNull();
    a.quiet(2500);
    expect(a.window(4000, slow())).toBeNull();
    expect(a.window(6000, slow())).toBe(1);
  });
});
