// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chooseBackend } from './renderer';
import { type FrameInfo, Stage } from './stage';

// The page as far as the stage asks of it, and animation frames run by hand.
let frames: ((now: number) => void)[] = [];
let clock = 0;
function animate(n: number): void {
  for (let i = 0; i < n; i++) {
    clock += 16;
    const due = frames;
    frames = [];
    for (const f of due) {
      f(clock);
    }
  }
}

beforeEach(() => {
  frames = [];
  clock = 0;
  vi.stubGlobal('window', {
    addEventListener() {},
    innerWidth: 960,
    innerHeight: 600,
    devicePixelRatio: 1,
  });
  vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => frames.push(f));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A stage on a page that draws nothing, and the frames its hook was given. */
function noDraw(): { stage: Stage; seen: { drawn: boolean; info: FrameInfo }[] } {
  const seen: { drawn: boolean; info: FrameInfo }[] = [];
  const container = { clientWidth: 480, clientHeight: 300 } as HTMLElement;
  const stage = new Stage(container, 'none', {
    frame(gfx, info) {
      seen.push({ drawn: gfx !== null, info });
      return undefined;
    },
  });
  return { stage, seen };
}

describe('a page that draws nothing', () => {
  test('is asked for on a page under test with ?draw=off, and only there', () => {
    expect(chooseBackend(new URLSearchParams('test&draw=off'), true)).toBe('none');
    expect(chooseBackend(new URLSearchParams('test&draw=off&backend=webgl2'), false)).toBe('none');
    expect(chooseBackend(new URLSearchParams('draw=off'), true)).toBe('webgpu');
    expect(chooseBackend(new URLSearchParams('test'), true)).toBe('webgpu');
  });

  test('has no renderer and no canvas, and updates the scene every animation frame', async () => {
    const { stage, seen } = noDraw();
    await stage.start();
    expect(stage.gfx).toBeNull();
    expect(stage.renderer).toBeNull();
    expect(stage.wanted).toBe('none');
    animate(5);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((s) => !s.drawn)).toBe(true);
    // The camera follows the page's size all the same.
    expect(stage.camera.aspect).toBeCloseTo(480 / 300);
    expect(stage.size()).toEqual({ width: 480, height: 300 });
  });

  test('stops updating when frozen, and renderOnce updates it once', async () => {
    const { stage, seen } = noDraw();
    await stage.start();
    animate(3);
    stage.freeze(true);
    const before = seen.length;
    animate(5);
    expect(seen.length).toBe(before);
    stage.renderOnce(1234);
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)?.info.now).toBe(1234);
    stage.freeze(false);
    animate(3);
    expect(seen.length).toBeGreaterThan(before + 1);
  });
});
