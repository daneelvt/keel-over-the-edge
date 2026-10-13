// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { QUALITY_VERSION } from '../ocean/look';
import {
  Adaptive,
  type FrameWindow,
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
  });
});

describe('the ladder', () => {
  const names = (rungs: Rung[]) => rungs.map(rungName);

  it('goes down by the render scale, then the shadows, then the detail, then the tier below', () => {
    expect(names(ladder('high'))).toEqual([
      'high × 1, shadows, 256² × 2',
      'high × 0.9, shadows, 256² × 2',
      'high × 0.8, shadows, 256² × 2',
      'high × 0.7, shadows, 256² × 2',
      'high × 0.7, 256² × 2',
      'high × 0.7, 256²',
      'medium × 1, 128²',
      'medium × 0.9, 128²',
      'medium × 0.8, 128²',
      'medium × 0.7, 128²',
      'low × 1, loop',
      'low × 0.9, loop',
      'low × 0.8, loop',
      'low × 0.7, loop',
    ]);
    expect(names(ladder('medium'))).toEqual([
      'medium × 1, shadows, 128²',
      'medium × 0.9, shadows, 128²',
      'medium × 0.8, shadows, 128²',
      'medium × 0.7, shadows, 128²',
      'medium × 0.7, 128²',
      'low × 1, loop',
      'low × 0.9, loop',
      'low × 0.8, loop',
      'low × 0.7, loop',
    ]);
    expect(names(ladder('low'))).toEqual([
      'low × 1, loop',
      'low × 0.9, loop',
      'low × 0.8, loop',
      'low × 0.7, loop',
    ]);
  });

  it('draws at the display’s pixel ratio, no more than the tier’s', () => {
    const [top] = ladder('high');
    expect(pixelRatioOf(top as Rung, 3)).toBe(2);
    expect(pixelRatioOf(top as Rung, 1.25)).toBe(1.25);
    expect(pixelRatioOf(top as Rung, 0.5)).toBe(1);
    expect(pixelRatioOf({ ...(top as Rung), tier: 'medium', scale: 0.8 }, 3)).toBeCloseTo(1.2);
    expect(pixelRatioOf({ ...(top as Rung), tier: 'low', scale: 0.7 }, 3)).toBeCloseTo(0.7);
  });

  it('keeps the tiers’ values as the table has them', () => {
    expect(TIERS.high).toMatchObject({ scale: 2, foamMap: 512, shadowMap: 1024, spray: 512 });
    expect(TIERS.medium).toMatchObject({ scale: 1.5, foamMap: 512, shadowMap: 1024, spray: 256 });
    expect(TIERS.low).toMatchObject({ scale: 1, foamMap: 256, shadowMap: 0, spray: 96 });
    expect([TIERS.low.number, TIERS.medium.number, TIERS.high.number]).toEqual([1, 2, 3]);
  });
});

describe('adaptive quality, in fake time', () => {
  const at60 = 1000 / 60;
  const good = (over: Partial<FrameWindow> = {}): FrameWindow => ({
    frames: 120,
    p90: at60 + 0.3,
    interval: at60,
    gpu: 5,
    work: 2,
    ...over,
  });
  const slow = (over: Partial<FrameWindow> = {}): FrameWindow =>
    good({ p90: 2 * at60, gpu: 20, ...over });

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

  it('goes down the ladder in order while it stays slow, and stops at the bottom', () => {
    const rungs = ladder('high');
    const a = new Adaptive(rungs, 0);
    const [steps] = feed(a, 0, 200, slow());
    expect(steps).toEqual(rungs.slice(1).map((_, i) => i + 1));
    expect(a.index).toBe(rungs.length - 1);
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

  it('does not step up without time to spare, on the GPU or the main thread', () => {
    const a = new Adaptive(ladder('high'), 3);
    // Within the cap, but the GPU is busy for most of the interval.
    expect(feed(a, 0, 20, good({ gpu: 0.8 * at60 }))[0]).toEqual([]);
    // No timestamps: the main thread's work says.
    const b = new Adaptive(ladder('high'), 3);
    expect(feed(b, 0, 20, good({ gpu: null, work: 7 }))[0]).toEqual([]);
    expect(feed(b, 40_000, 7, good({ gpu: null, work: 3 }))[0]).toEqual([2]);
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
    [, t] = feed(a, t, 4, good({ gpu: 0.8 * at60 }));
    [, t] = feed(a, t, 8, good({ gpu: 0.8 * at60 }));
    expect(a.wait).toBe(WAIT);
    expect(a.index).toBe(2);
  });

  it('does not call a 30 Hz display slow, nor the battery saver', () => {
    // Low Power Mode: the display refreshes every 33 ms, and so does the cap.
    const a = new Adaptive(ladder('high'), 0);
    expect(feed(a, 0, 20, good({ p90: 33.6, interval: 1000 / 30 }))[0]).toEqual([]);
    // And a frame that takes two refreshes of a 60 Hz display is.
    expect(feed(a, 40_000, 2, good({ p90: 33.6 }))[0]).toEqual([1]);
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
    expect(a.index).toBe(a.ladder.length - 1);
  });

  it('forgets a slow window when a quiet spell comes between two', () => {
    const a = new Adaptive(ladder('high'), 0);
    expect(a.window(2000, slow())).toBeNull();
    a.quiet(2500);
    expect(a.window(4000, slow())).toBeNull();
    expect(a.window(6000, slow())).toBe(1);
  });
});
