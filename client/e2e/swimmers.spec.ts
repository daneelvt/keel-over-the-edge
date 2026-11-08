// SPDX-License-Identifier: AGPL-3.0-only

// The life in the water in a real browser, on the offline sandbox: a group
// of every kind in the water raised about the boat (whales, rays and a
// shark's fin among them), a booby perched aboard and a flying fish on the
// deck, with sixty birds, the most life in view, draw within the budget of
// draw calls and triangles,
// every body in one draw, in the factory's materials; on the low tier half
// of each group is drawn, solid, only what breaks the surface seen.

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
 * Raises a group of every kind in the water close about the boat, the
 * bait among them with its birds, and groups of birds about until sixty
 * are in reach; and waits for the bodies. How many animals in the water
 * and birds are drawn.
 */
async function raise(page: Page): Promise<{ swimmers: number; birds: number }> {
  const water = data.life.kinds.filter((k) => k.form !== 'bird').map((k) => k.id);
  const birds = data.life.kinds.filter((k) => k.form === 'bird').map((k) => k.id);
  return page.evaluate(
    async ([water, birds]) => {
      const k = globalThis.keel;
      water.forEach((id, n) => {
        const a = n * 2.39996;
        k.raiseLife(id, 30 * Math.sin(a), 30 * Math.cos(a), true);
      });
      k.raiseAboard();
      for (let n = 0; n < 40 && k.lifeBirds().length < 60; n++) {
        const a = n * 2.39996;
        const r = 60 + 15 * n;
        k.raiseLife(birds[n % birds.length] ?? '', r * Math.sin(a), r * Math.cos(a));
      }
      for (let i = 0; i < 100 && !k.life().swimLoaded; i++) {
        k.render();
        await new Promise((r) => setTimeout(r, 100));
      }
      k.render();
      return { swimmers: k.life().swimmers, birds: k.lifeBirds().length };
    },
    [water, birds] as const,
  );
}

test('every kind in the water draws in one draw, with sixty birds, within the budget', async ({
  page,
}) => {
  await openScene(page);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.render();
  });
  const before = await drawn(page);
  const n = await raise(page);
  expect(n.swimmers).toBeGreaterThanOrEqual(20);
  expect(n.birds).toBeGreaterThanOrEqual(60);
  const after = await drawn(page);
  const life = await page.evaluate(() => globalThis.keel.life());
  expect(life.swimDraws).toBe(1);
  expect(life.draws).toBe(1);
  test.info().annotations.push({
    type: 'the most life in view',
    description: `${n.swimmers} animals in the water and ${n.birds} birds: draw calls ${before.draws} → ${after.draws}, triangles ${before.triangles} → ${after.triangles}`,
  });
  expect(after.draws - before.draws).toBeLessThanOrEqual(DRAWS);
  expect(after.draws).toBeLessThan(FRAME_DRAWS);
  expect(after.triangles - before.triangles).toBeLessThanOrEqual(TRIANGLES);
  expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
});

test('the low tier draws half of each group, solid', async ({ page }) => {
  await openScene(page, 'tier=low');
  const before = await drawn(page);
  const n = await raise(page);
  const life = await page.evaluate(() => globalThis.keel.life());
  expect(life.tinted).toBe(false);
  expect(n.swimmers).toBeGreaterThan(0);
  const half = life.records
    .filter((r) => data.life.kinds[r.kind]?.swim !== undefined)
    .reduce((m, r) => m + Math.ceil(Math.min(r.count, 24) / 2), 0);
  expect(n.swimmers).toBeLessThanOrEqual(half);
  const after = await drawn(page);
  test.info().annotations.push({
    type: 'the most life in view, low tier',
    description: `draw calls ${before.draws} → ${after.draws}, triangles ${before.triangles} → ${after.triangles}`,
  });
  expect(after.draws - before.draws).toBeLessThanOrEqual(DRAWS);
  expect(after.draws).toBeLessThan(FRAME_DRAWS);
  expect(after.triangles - before.triangles).toBeLessThanOrEqual(TRIANGLES);
});
