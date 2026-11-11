// SPDX-License-Identifier: AGPL-3.0-only

// The sea's birds in a real browser, on the offline sandbox: groups of
// every kind raised about the boat, 60 birds and more within reach, draw
// in the colonies' one draw of birds, within the budget of draw calls and
// triangles, in the factory's materials; and on the low tier half of each
// group is drawn.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { openScene } from './helpers';

/** The most the sea's life may add at its most in view: draw calls and triangles. */
const DRAWS = 4;
const TRIANGLES = 40_000;
/** The most draw calls a frame may make on any tier. */
const FRAME_DRAWS = 150;

/** The frame's draw calls and triangles, as the GPU was given them. */
async function drawn(page: Page): Promise<{ draws: number; triangles: number }> {
  return page.evaluate(async () => {
    const k = globalThis.keel;
    k.render();
    await k.show();
    const i = k.info();
    return { draws: i.drawCalls, triangles: i.triangles };
  });
}

/**
 * Raises groups of every bird kind about the boat, round it within a few
 * hundred metres, until at least most birds are within reach; how many are.
 */
async function raise(page: Page, most: number): Promise<number> {
  const ids = data.life.kinds.filter((k) => k.form === 'bird').map((k) => k.id);
  return page.evaluate(
    ([ids, most]) => {
      const k = globalThis.keel;
      for (let n = 0; n < 40 && k.lifeBirds().length < most; n++) {
        const a = n * 2.39996;
        const r = 60 + 15 * n;
        k.raiseLife(ids[n % ids.length] ?? '', r * Math.sin(a), r * Math.cos(a));
      }
      k.render();
      return k.lifeBirds().length;
    },
    [ids, most] as const,
  );
}

test('sixty birds at sea draw in one draw, within the budget, in the factory’s materials', async ({
  page,
}) => {
  await openScene(page);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.render();
  });
  const before = await drawn(page);
  const birds = await raise(page, 60);
  expect(birds).toBeGreaterThanOrEqual(60);
  const after = await drawn(page);
  const life = await page.evaluate(() => globalThis.keel.life());
  expect(life.birds).toBeGreaterThanOrEqual(60);
  expect(life.draws).toBe(1);
  expect(after.draws - before.draws).toBeLessThanOrEqual(DRAWS);
  expect(after.draws).toBeLessThan(FRAME_DRAWS);
  expect(after.triangles - before.triangles).toBeLessThanOrEqual(TRIANGLES);
  expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
});

test('the low tier draws half of each group', async ({ page }) => {
  await openScene(page, 'tier=low');
  await raise(page, 40);
  const life = await page.evaluate(() => globalThis.keel.life());
  const half = life.records.reduce((n, r) => n + Math.ceil(r.count / 2), 0);
  expect(life.birds).toBeGreaterThan(0);
  expect(life.birds).toBeLessThanOrEqual(half);
  const after = await drawn(page);
  expect(after.draws).toBeLessThan(FRAME_DRAWS);
});
