// SPDX-License-Identifier: AGPL-3.0-only

// The machine mark, on each back end: beside the player's boat, at noon, a
// machine sailor's boat shows the cog on its sail's starboard face, another
// behind them on its port face, and a human's boat of the fleet has a plain
// sail; a small picture of them matches its reference.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

test.use({ viewport: { width: 480, height: 300 } });

test.describe('pictures', () => {
  test('a machine sailor’s boat carries the mark on both faces, a human’s none', async ({
    page,
  }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(12);
      const b = k.boat().state;
      // The own boat heads east; the camera looks at it from abeam.
      k.setFleet([
        { east: b.x + 6, north: b.y, heading: 1.5708, boom: 0.05, sail: 15, machine: 1 },
        { east: b.x - 3, north: b.y + 10, heading: -1.5708, boom: -0.05, sail: 15, machine: 1 },
        { east: b.x - 6, north: b.y, heading: 1.5708, boom: 0.05, sail: 15 },
      ]);
      k.render();
      k.camera({ azimuth: -1.4, elevation: 0.12, distance: 12 });
      k.render();
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('machine-mark.png');
  });
});
