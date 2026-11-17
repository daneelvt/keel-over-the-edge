// SPDX-License-Identifier: AGPL-3.0-only

// What a frame asks of the GPU, counted on each tier of the sandbox as it
// sails: the buffers written and their bytes, the render passes and the
// draws. Counts are the same on a fast GPU and a slow one, so the limits
// are tight and the test does not depend on the runner's speed. WebGL 2
// counts what its own calls write (bufferSubData and bufferData) and its
// passes as three.js's renders, so it has limits of its own.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

// Counts don't depend on the picture's size: a small page draws them soonest.
test.use({ viewport: { width: 320, height: 200 } });

interface Counted {
  tier: string;
  rung: string;
  backend: string;
  writes: number;
  most: number;
  bytes: number;
  passes: number;
  draws: number;
}

/**
 * The most a frame may ask, by back end and tier: buffers written and KB a
 * frame (medians over the frames), render passes and draws. The sandbox
 * sent about 800 buffers and 800 KB a frame before uniforms were grouped
 * and sent only when they change; now about 355 and 225 KB on the high
 * tier, 280 and 215 KB on the low, and 180 and 215 KB on WebGL 2.
 */
const LIMITS: Record<
  string,
  Record<string, { writes: number; kb: number; passes: number; draws: number }>
> = {
  webgpu: {
    high: { writes: 400, kb: 250, passes: 32, draws: 80 },
    low: { writes: 320, kb: 250, passes: 6, draws: 55 },
  },
  webgl2: {
    low: { writes: 220, kb: 250, passes: 6, draws: 55 },
  },
};

test('a frame sends the GPU few buffers and few bytes, in few passes, on every tier', async ({
  page,
}) => {
  await openScene(page, '', false, true);
  const counted = await page.evaluate(async () => {
    const k = globalThis.keel;
    k.thaw();
    const out: Counted[] = [];
    // The medium tier is the high's sea with one patch: its counts lie between.
    for (const tier of ['high', 'low']) {
      const info = k.info();
      const i = info.rungs.findIndex((r) => r.startsWith(`${tier} `));
      if (i < 0) {
        continue;
      }
      await k.setRung(i);
      await k.show();
      // A few frames for what a new rung makes once, then sixty counted.
      await k.countFrames(5);
      const c = await k.countFrames(60);
      out.push({
        tier,
        rung: info.rungs[i] as string,
        backend: c.backend,
        writes: c.writes.median,
        most: c.writes.max,
        bytes: c.bytes.median,
        passes: c.passes.median,
        draws: c.draws.median,
      });
    }
    return out;
  });
  test.info().annotations.push({ type: 'counted', description: JSON.stringify(counted) });
  expect(counted.length).toBeGreaterThan(0);
  for (const c of counted) {
    const limit = LIMITS[c.backend]?.[c.tier];
    expect(limit, `${c.backend} ${c.rung}`).toBeDefined();
    if (limit === undefined) {
      continue;
    }
    expect(c.writes, `${c.backend} ${c.rung}: buffers written a frame`).toBeLessThan(limit.writes);
    expect(c.bytes / 1024, `${c.backend} ${c.rung}: KB written a frame`).toBeLessThan(limit.kb);
    expect(c.passes, `${c.backend} ${c.rung}: render passes`).toBeLessThanOrEqual(limit.passes);
    expect(c.draws, `${c.backend} ${c.rung}: draws`).toBeLessThan(limit.draws);
  }
});
