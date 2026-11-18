// SPDX-License-Identifier: AGPL-3.0-only

// What a frame asks of the GPU, counted on each tier of the sandbox as it
// sails: the buffers written and their bytes, the render passes and the
// draws. Counts are the same on a fast GPU and a slow one, so the limits
// are tight and the test does not depend on the runner's speed. WebGL 2
// counts what its own calls write (bufferSubData and bufferData) and its
// passes as three.js's renders, so it has limits of its own.

import { expect, test } from '@playwright/test';
import { openScene, softwareGPU } from './helpers';

// Counts don't depend on the picture's size: a small page draws them soonest.
test.use({ viewport: { width: 320, height: 200 } });

/**
 * The most a frame may ask, by back end and tier: buffers written and KB a
 * frame (medians over the frames), render passes and draws. The sandbox
 * sent about 800 buffers and 800 KB a frame on the high tier, and 670 and
 * 670 KB on the low, before what objects share was grouped and sent only
 * when it changes; now about 235 and 145 KB on the high tier, 185 and
 * 135 KB on the low, and 185 and 135 KB on WebGL 2.
 */
const LIMITS: Record<
  string,
  Record<string, { writes: number; kb: number; passes: number; draws: number }>
> = {
  webgpu: {
    high: { writes: 300, kb: 200, passes: 32, draws: 80 },
    low: { writes: 230, kb: 180, passes: 6, draws: 55 },
  },
  webgl2: {
    low: { writes: 230, kb: 180, passes: 6, draws: 55 },
  },
};

// A software GPU (CI's) takes about a quarter of a second a frame: fewer
// frames there, as a median of twenty counts the same as one of sixty.
const WARM = softwareGPU ? 3 : 5;
const FRAMES = softwareGPU ? 20 : 60;

for (const tier of ['high', 'low']) {
  test(`a frame sends the GPU few buffers and few bytes, in few passes, on the ${tier} tier`, async ({
    page,
  }) => {
    // The tier held from the start: one set of shaders to build, not two.
    await openScene(page, `tier=${tier}`, false, true);
    // WebGL 2's ladder starts at the low tier: a page asked for the high
    // tier is held to that.
    const top = await page.evaluate(() => globalThis.keel.info().rungs[0] as string);
    test.skip(!top.startsWith(`${tier} `), `this back end has no ${tier} tier`);
    const c = await page.evaluate(
      async ({ warm, frames }) => {
        const k = globalThis.keel;
        k.thaw();
        await k.show();
        // A few frames for what the rung makes once, then those counted.
        await k.countFrames(warm);
        const n = await k.countFrames(frames);
        return {
          rung: k.info().rungs[0] as string,
          backend: n.backend,
          writes: n.writes.median,
          most: n.writes.max,
          bytes: n.bytes.median,
          passes: n.passes.median,
          draws: n.draws.median,
        };
      },
      { warm: WARM, frames: FRAMES },
    );
    test.info().annotations.push({ type: 'counted', description: JSON.stringify(c) });
    const limit = LIMITS[c.backend]?.[tier];
    expect(limit, `${c.backend} ${c.rung}`).toBeDefined();
    if (limit === undefined) {
      return;
    }
    expect(c.writes, `${c.backend} ${c.rung}: buffers written a frame`).toBeLessThan(limit.writes);
    expect(c.bytes / 1024, `${c.backend} ${c.rung}: KB written a frame`).toBeLessThan(limit.kb);
    expect(c.passes, `${c.backend} ${c.rung}: render passes`).toBeLessThanOrEqual(limit.passes);
    expect(c.draws, `${c.backend} ${c.rung}: draws`).toBeLessThan(limit.draws);
  });
}
