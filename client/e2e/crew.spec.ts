// SPDX-License-Identifier: AGPL-3.0-only

// People aboard, on a phone's screen (360 × 640): forty aboard the tall
// ship, every one drawn in their own look at their station on her deck and
// one at the wheel, in a few more draws than her one sailor, her frames
// within the budget of a frame at 60 Hz on a real GPU and little dearer
// than with her one sailor on any; the keelboat's five each on her deck.
// Far off, as the chase camera sees the ship, the crew are the looks' far
// figures; close, the nearest twelve their deck level.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import type { Looks } from '../src/catalog/looks';
import { sandboxCrew } from '../src/sandbox/crewscene';
import { openScene, softwareGPU } from './helpers';

test.use({ viewport: { width: 360, height: 640 } });

/** A frame at 60 Hz, ms. */
const BUDGET = 1000 / 60;

/** Milliseconds a frame, end to end: frames drawn one after another, each waited for on the GPU. */
async function frameMs(page: Page, frames: number): Promise<number> {
  return page.evaluate((n) => globalThis.keel.frameCost(n), frames);
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] as number;
};

/** The box of the boat's parts on the screen, but the crew's, CSS pixels. */
async function shipBox(page: Page) {
  return page.evaluate(() => {
    const parts = globalThis.keel.boatBox().filter((b) => !b.name.startsWith('crew'));
    return {
      left: Math.min(...parts.map((b) => b.left)),
      right: Math.max(...parts.map((b) => b.right)),
      top: Math.min(...parts.map((b) => b.top)),
      bottom: Math.max(...parts.map((b) => b.bottom)),
    };
  });
}

/** The frame's draws and triangles, and the crew drawn. */
async function counts(page: Page) {
  return page.evaluate(async () => {
    const k = globalThis.keel;
    await k.show();
    const { drawCalls, triangles } = k.info();
    const { aboard, near, far, nearTriangles, farTriangles } = k.crew();
    return { drawCalls, triangles, aboard, near, far, nearTriangles, farTriangles };
  });
}

test('forty aboard the tall ship, at their stations, within a frame’s budget', {
  tag: '@long',
}, async ({ page }) => {
  test.setTimeout(240_000);
  await openScene(page, 'boat=tall-ship');
  // Her one sailor, for the frames to compare with, in the look of whoever
  // holds the controls among the forty, so that only the crew differs.
  const helm = sandboxCrew(40, data as unknown as Looks).people[1]?.look ?? 0;
  const show = (n: number) =>
    page.evaluate(
      async (a) => {
        const k = globalThis.keel;
        await k.showCrew(a.n);
        if (a.n === 0) {
          await k.lookAboard(a.helm);
        }
        await k.crewReady();
      },
      { n, helm },
    );
  await show(40);
  const crew = await page.evaluate(() => globalThis.keel.crew());
  // Thirty-nine at their stations, and one at the wheel in their own look.
  expect(crew.aboard).toBe(39);
  expect(crew.near + crew.far).toBe(39);
  expect(new Set(crew.heads.map((h) => h.station)).size).toBe(39);
  expect(crew.heads.every((h) => h.station >= 1)).toBe(true);
  // Every one aboard her: within her box on the screen.
  const ship = await shipBox(page);
  for (const h of crew.heads) {
    expect(h.x).toBeGreaterThan(ship.left);
    expect(h.x).toBeLessThan(ship.right);
    expect(h.y).toBeGreaterThan(ship.top);
    expect(h.y).toBeLessThan(ship.bottom);
  }

  // Her one sailor and forty in turn: the draws, and the frames' cost.
  const cost = (): Promise<number> => frameMs(page, softwareGPU ? 8 : 60);
  const ms = {
    one: [] as number[],
    forty: [] as number[],
    closeOne: [] as number[],
    close: [] as number[],
  };
  await show(0);
  const one = await counts(page);
  await show(40);
  const forty = await counts(page);
  // From the chase camera, all far: one draw of their far figures (at
  // most 300 triangles each), and its shadow's where the tier has shadows.
  expect(one.aboard).toBe(0);
  expect(forty.far).toBe(39);
  expect(forty.drawCalls - one.drawCalls).toBeLessThanOrEqual(2);
  expect(forty.drawCalls - one.drawCalls).toBeGreaterThan(0);
  expect(forty.triangles - one.triangles).toBeLessThanOrEqual(2 * 39 * 300);
  const rounds = 3;
  for (let round = 0; round < rounds; round++) {
    await show(0);
    ms.one.push(await cost());
    await show(40);
    ms.forty.push(await cost());
  }

  // Close: the dearest view.
  const close = async (n: number) => {
    await show(n);
    await page.evaluate(() =>
      globalThis.keel.camera({ azimuth: 0.35, elevation: 0.55, distance: 2.5 }),
    );
    await page.evaluate(() => globalThis.keel.crewReady());
  };
  await close(0);
  const closeOne = await counts(page);
  await close(40);
  const closeForty = await counts(page);
  // The nearest twelve at the deck level, the rest far: a draw each level,
  // and their shadows'.
  expect(closeForty.near).toBe(12);
  expect(closeForty.near + closeForty.far).toBe(39);
  expect(closeForty.drawCalls - closeOne.drawCalls).toBeLessThanOrEqual(4);
  for (let round = 0; round < rounds; round++) {
    await close(0);
    ms.closeOne.push(await cost());
    await close(40);
    ms.close.push(await cost());
  }
  test.info().annotations.push({
    type: 'measured',
    description: JSON.stringify({ one, forty, closeOne, close: closeForty, ms }),
  });
  // Forty cost little more than one; on a real GPU, a frame, end to end,
  // stays within a frame at 60 Hz.
  // (A software GPU's frames vary by a third from one set to the next.)
  const more = softwareGPU ? 1.5 : 1.25;
  expect(median(ms.forty)).toBeLessThan(median(ms.one) * more + 1);
  expect(median(ms.close)).toBeLessThan(median(ms.closeOne) * (more + 0.15) + 1.5);
  if (!softwareGPU) {
    expect(median(ms.forty)).toBeLessThan(BUDGET);
    expect(median(ms.close)).toBeLessThan(BUDGET);
  }
});

test('five aboard the keelboat, each on her deck', async ({ page }) => {
  await openScene(page, 'boat=keelboat&crew=5');
  const crew = await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.crewReady();
    return k.crew();
  });
  // Four at their stations, near the chase camera, and one at the helm.
  expect(crew.aboard).toBe(4);
  expect(crew.near).toBe(4);
  expect(crew.heads.map((h) => h.station).sort()).toEqual([1, 2, 3, 4]);
  const boat = await shipBox(page);
  for (const h of crew.heads) {
    expect(h.x).toBeGreaterThan(boat.left);
    expect(h.x).toBeLessThan(boat.right);
    expect(h.y).toBeGreaterThan(boat.top);
    expect(h.y).toBeLessThan(boat.bottom);
  }
});
