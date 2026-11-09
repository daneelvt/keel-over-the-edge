// SPDX-License-Identifier: AGPL-3.0-only

// The picture a link to watch is shared with, made on the phone of the
// view at that moment: the next frame drawn, copied from the scene's
// canvas before the browser clears it, cut to 16:9 with the strip across
// its foot, a JPEG under 1 MB. On WebGPU and WebGL 2, upright and
// sideways, it holds the sea, not a cleared canvas.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

test('the view shared as a picture: 1200 × 675, a JPEG under 1 MB, the sea in it, upright and sideways', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 640, height: 360 });
  await openScene(page);
  const pictures: number[] = [];
  for (const size of [
    { width: 640, height: 360 },
    { width: 360, height: 640 },
  ]) {
    await page.setViewportSize(size);
    // The canvas follows the window on its resize, a frame later.
    await page.waitForFunction(
      ({ width, height }) => {
        const c = globalThis.keel.world.stage.gfx?.canvas;
        return c !== undefined && Math.abs(c.width / c.height - width / height) < 0.02;
      },
      size,
    );
    await page.evaluate(() => globalThis.keel.render());
    const p = await page.evaluate(() => globalThis.keel.picture('Iron Mary'));
    pictures.push(p?.bytes ?? 0);
    expect(p, `${size.width} × ${size.height}`).not.toBeNull();
    expect(p).toMatchObject({ width: 1200, height: 675, type: 'image/jpeg' });
    expect(p?.bytes ?? 0).toBeLessThan(1_000_000);
    // The sea and the sky, lit and varied: a cleared canvas is black and even.
    expect(p?.lit ?? 0, `${size.width} × ${size.height}`).toBeGreaterThan(0.9);
    expect(p?.spread ?? 0, `${size.width} × ${size.height}`).toBeGreaterThan(20);
  }
  // Upright and sideways are cut from views of their own.
  expect(pictures[0]).not.toBe(pictures[1]);
});
